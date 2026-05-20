import { getProjectWorkspaceRoot } from '../workspacePaths';
import * as path from 'path';

export interface PermissionRule {
    id: string;
    tool: string;
    commandPrefix?: string[];
    cwdScope: string;
    riskMax: 0 | 1 | 2 | 3;
    sessionOnly: boolean;
    createdAt: number;
    expiresAt?: number;
}

export class PermissionPolicyStore {
    private rules: PermissionRule[] = [];
    private static instance: PermissionPolicyStore | null = null;

    private constructor() {
        // Private constructor for singleton
    }

    public static getInstance(): PermissionPolicyStore {
        if (!PermissionPolicyStore.instance) {
            PermissionPolicyStore.instance = new PermissionPolicyStore();
        }
        return PermissionPolicyStore.instance;
    }

    /**
     * Clear all rules (e.g. on session reset)
     */
    public clear(): void {
        this.rules = [];
    }

    /**
     * Add a permission rule
     */
    public addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): PermissionRule {
        const newRule: PermissionRule = {
            ...rule,
            id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            createdAt: Date.now()
        };
        this.rules.push(newRule);
        return newRule;
    }

    /**
     * Get all active rules
     */
    public getRules(): PermissionRule[] {
        // Filter out expired rules
        const now = Date.now();
        this.rules = this.rules.filter(r => !r.expiresAt || r.expiresAt > now);
        return [...this.rules];
    }

    /**
     * Check if a given command execution matches any pre-approved low-risk rules
     */
    public isApproved(tool: string, args: Record<string, unknown>, riskLevel: number = 0): boolean {
        const activeRules = this.getRules();
        const wsRoot = getProjectWorkspaceRoot();

        for (const rule of activeRules) {
            if (rule.tool !== tool) continue;

            // 1. 严格校验 riskMax：如果该命令的风险级别超过了规则豁免的上限，拒绝豁免
            if (riskLevel > rule.riskMax) {
                continue;
            }

            // Check command prefix rules for run_command tool
            if (tool === 'run_command' || tool === 'execute_command') {
                const command = (args['CommandLine'] as string) || '';
                const cwd = (args['Cwd'] as string) || wsRoot;

                // 2. 严格的路径包含关系校验：防止 startsWith 产生目录前缀截断绕过（如 /workspace 与 /workspace-malicious）
                const normScope = path.resolve(rule.cwdScope).toLowerCase();
                const normCwd = path.resolve(cwd).toLowerCase();
                const relative = path.relative(normScope, normCwd);
                const isSubdir = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

                if (!isSubdir) {
                    continue;
                }

                // Check prefix sequence matching
                const prefixList = rule.commandPrefix;
                if (prefixList && prefixList.length > 0) {
                    const normalizedCmd = command.trim().replace(/\s+/g, ' ');
                    const words = normalizedCmd.split(' ');
                    
                    let matchesPrefix = true;
                    for (let i = 0; i < prefixList.length; i++) {
                        const currentWord = words[i];
                        const prefixWord = prefixList[i];
                        if (!currentWord || !prefixWord || currentWord.toLowerCase() !== prefixWord.toLowerCase()) {
                            matchesPrefix = false;
                            break;
                        }
                    }
                    if (!matchesPrefix) continue;
                }
            }

            // If we match all rules, it is approved
            return true;
        }

        return false;
    }
}
