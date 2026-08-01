import { getProjectWorkspaceRoot } from '../workspacePaths';
import { isPathInsideOrEqual } from '../workspaceSandbox';

// Inline-eval flags: prefix matching cannot bound the code payload, so these never learn rules.
const INLINE_EVAL_FLAGS = new Set(['-c', '-e', '-p', '--eval', '-command', '-encodedcommand']);

// Base-command-specific eval/subshell flags (kept off the global set to avoid false positives like `grep -r`).
const BASE_COMMAND_EVAL_FLAGS: Record<string, Set<string>> = {
    cmd: new Set(['/c', '/k']),
    php: new Set(['-r']),
    node: new Set(['--print']),
    nodejs: new Set(['--print']),
    deno: new Set(['eval']),
};

// These executors consume code or command arguments from data rather than a
// statically inspectable script file. They must cross the approval boundary on
// every invocation and must never produce a learned prefix rule.
const OPAQUE_EXECUTORS = new Set(['eval', 'invoke-expression', 'iex', 'xargs']);

/** Normalize a flag token: strip leading/trailing quotes independently, cut at '=', lowercase. */
function normalizeFlagToken(rawToken: string): string {
    let t = rawToken.trim().replace(/^['"]+/, '').replace(/['"]+$/, '').trim().toLowerCase();
    const eq = t.indexOf('=');
    if (eq > 0) t = t.slice(0, eq);
    return t;
}

/** Reduce an executable token to its base name (drop path and .exe/.cmd). */
function normalizeBaseCommand(rawToken: string): string {
    let t = rawToken.trim().replace(/^['"]+/, '').replace(/['"]+$/, '').trim().toLowerCase();
    const slash = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
    if (slash >= 0) t = t.slice(slash + 1);
    return t.replace(/\.(exe|cmd|bat|com)$/, '');
}

function isInlineEvalToken(rawToken: string): boolean {
    const t = normalizeFlagToken(rawToken);
    if (INLINE_EVAL_FLAGS.has(t)) return true;
    // PowerShell accepts unambiguous parameter prefixes: -enc/-enco/... and -com/-comm/...
    return t.length >= 4 && t.startsWith('-')
        && ('-encodedcommand'.startsWith(t) || '-command'.startsWith(t));
}

// Node clusters single-char flags: -pe / -ep / -pte all carry -p (print) or -e (eval).
function isNodeEvalCluster(rawToken: string): boolean {
    const t = normalizeFlagToken(rawToken);
    return /^-[a-z]+$/.test(t) && (t.includes('e') || t.includes('p'));
}

export function hasInlineEvalPayload(command: string): boolean {
    const tokens = command.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
    if (tokens.length === 0) return false;
    const base = normalizeBaseCommand(tokens[0]!);
    if (OPAQUE_EXECUTORS.has(base)) return true;
    if (tokens.length <= 1) return false;
    if (tokens.some(isInlineEvalToken)) return true;
    const baseEvalFlags = BASE_COMMAND_EVAL_FLAGS[base];
    if (baseEvalFlags && tokens.slice(1).some(tok => baseEvalFlags.has(normalizeFlagToken(tok)))) return true;
    if ((base === 'node' || base === 'nodejs') && tokens.slice(1).some(isNodeEvalCluster)) return true;
    return false;
}

/**
 * Derive a learned-rule prefix from an approved command.
 * Two tokens by default ('npm test'); three when the second is a flag
 * ('python -m pytest'). Inline-eval / subshell commands return [] — they
 * may be approved once but must never become rules.
 */
export function deriveCommandPrefix(command: string): string[] {
    const tokens = command.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
    if (tokens.length <= 1) return tokens;
    if (hasInlineEvalPayload(command)) return [];
    if (tokens[1]!.startsWith('-') && tokens.length >= 3) return tokens.slice(0, 3);
    return tokens.slice(0, 2);
}

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
        const existing = this.findEquivalent(rule);
        if (existing) return existing;
        const newRule: PermissionRule = {
            ...rule,
            id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            createdAt: Date.now()
        };
        this.rules.push(newRule);
        return newRule;
    }

    /** Snapshot active rules. Durable snapshots must exclude session-only approvals. */
    public serialize(options?: { includeSessionOnly?: boolean }): PermissionRule[] {
        const includeSessionOnly = options?.includeSessionOnly !== false;
        return this.getRules().filter(rule => includeSessionOnly || !rule.sessionOnly);
    }

    /** Restore rules; durable resume paths must not re-arm session-only approvals. */
    public restore(rules: PermissionRule[] | undefined, options?: { allowSessionOnly?: boolean }): number {
        if (!Array.isArray(rules)) return 0;
        const allowSessionOnly = options?.allowSessionOnly !== false;
        const now = Date.now();
        let restored = 0;
        for (const rule of rules) {
            if (!rule || typeof rule.tool !== 'string' || typeof rule.cwdScope !== 'string') continue;
            if (rule.sessionOnly && !allowSessionOnly) continue;
            if (rule.expiresAt && rule.expiresAt <= now) continue;
            if (this.findEquivalent(rule)) continue;
            this.rules.push({ ...rule });
            restored++;
        }
        return restored;
    }

    private findEquivalent(rule: Pick<PermissionRule, 'tool' | 'cwdScope' | 'riskMax' | 'commandPrefix'>): PermissionRule | undefined {
        const samePrefix = (a?: string[], b?: string[]): boolean => {
            const x = a ?? [];
            const y = b ?? [];
            return x.length === y.length && x.every((v, i) => v === y[i]);
        };
        return this.rules.find(r => r.tool === rule.tool
            && r.cwdScope === rule.cwdScope
            && r.riskMax === rule.riskMax
            && samePrefix(r.commandPrefix, rule.commandPrefix));
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

                // 2. 严格的路径包含关系校验：复用 isPathInsideOrEqual（平台条件折叠 + 防目录前缀截断绕过，
                //    如 /workspace 与 /workspace-malicious）。Windows 折叠大小写、Linux/macOS 区分大小写。
                if (!isPathInsideOrEqual(cwd, rule.cwdScope)) {
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
