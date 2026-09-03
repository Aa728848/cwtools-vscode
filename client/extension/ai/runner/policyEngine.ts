/**
 * Policy engine: layered permission profiles, typed rule matching, and
 * actionable denials. Pure module (no vscode) — see docs/agent-boundary-permissions-plan.md.
 */
import * as path from 'path';
import { foldPathCase, isPathInsideOrEqual } from '../../pathScope';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never' | 'granular';
export type ApprovalsReviewer = 'user' | 'auto_review';
export type PermissionAction = 'allow' | 'ask' | 'deny';
export type PolicyScope = 'once' | 'session' | 'workflow' | 'global';
export type PolicySubject =
    | 'read' | 'edit' | 'bash' | 'git' | 'network'
    | 'mcp' | 'task' | 'lsp' | 'media' | 'skill';

export interface PolicyRule {
    id: string;
    subject: PolicySubject;
    label?: string;
    commandPrefix?: string[];
    cwdRoot?: string;
    pathGlob?: string;
    networkHostGlob?: string;
    mcpServerGlob?: string;
    mcpToolGlob?: string;
    taskRole?: string;
    exactId?: string;
    action: PermissionAction;
    scope?: PolicyScope;
    riskMax?: 0 | 1 | 2 | 3;
    learnedFromApproval?: boolean;
    expiresAt?: number;
}

export type PolicyLayerId = 'global-defaults' | 'user';

export interface PolicyLayer {
    id: PolicyLayerId;
    rules: PolicyRule[];
}

export interface PermissionProfile {
    id: string;
    sandboxMode: SandboxMode;
    approvalPolicy: ApprovalPolicy;
    approvalsReviewer: ApprovalsReviewer;
    networkAccess: boolean;
    writableRoots: string[];
    protectedPaths: string[];
    rules: PolicyRule[];
}

export interface PolicyCallDescriptor {
    toolName: string;
    subject: PolicySubject;
    riskLevel: 0 | 1 | 2 | 3;
    workspaceRoot: string;
    command?: string;
    commandTokens?: string[];
    cwd?: string;
    targetPaths?: string[];
    networkHosts?: string[];
    mcpServer?: string;
    mcpTool?: string;
    taskRole?: string;
    exactId?: string;
}

export interface ActionableDenial {
    code: string;
    matchedRules: string[];
    whyDenied: string;
    allowedAlternatives: Array<{ tool: string; reason: string; exampleArgs?: Record<string, unknown> }>;
    approvalPath?: { reviewer: ApprovalsReviewer; requestedScope: Exclude<PolicyScope, 'global'>; summary: string };
}

export interface PolicyDecision {
    action: PermissionAction;
    matchedRules: string[];
    denial?: ActionableDenial;
}

const SEVERITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };
const WRITE_LIKE = new Set<PolicySubject>(['edit', 'bash', 'git', 'media', 'mcp', 'task']);

export const DEFAULT_PROTECTED_PATHS = [
    '.git/**', '.agents/**', '.codex/**',
    '.cwtools/*/runs/**', '.cwtools/*/threads/**', '.cwtools/*/goals/**',
    '.cwtools/*/blackboard/**', '.cwtools/*/resume_state.json*',
    '.env', '.env.*',
    '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/.npmrc',
];

// ── Matching primitives ──────────────────────────────────────────────

export function tokenizeCommand(command: string): string[] {
    return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(t => t.replace(/^['"]|['"]$/g, ''));
}

/** Map registry ToolEffect onto a policy subject; memory/none are not policed. */
export function subjectForEffect(effect: string): PolicySubject | undefined {
    switch (effect) {
        case 'workspace_read': return 'read';
        case 'workspace_write': return 'edit';
        case 'shell': return 'bash';
        case 'git': return 'git';
        case 'network': return 'network';
        case 'mcp': return 'mcp';
        case 'media': return 'media';
        case 'process': return 'task';
        default: return undefined;
    }
}

function commandTokenEquals(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `*` = one segment, `**` = any depth; anchored to the workspace-relative path. */
function pathGlobToRegExp(glob: string): RegExp {
    const g = foldPathCase(glob.replace(/\\/g, '/').replace(/^\//, ''));
    let out = '';
    for (let i = 0; i < g.length; i++) {
        const ch = g[i]!;
        if (ch === '*') {
            if (g[i + 1] === '*') {
                if (g[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
                else { out += '.*'; i += 1; }
            } else {
                out += '[^/]*';
            }
        } else if ('.+?^${}()|[]\\'.includes(ch)) {
            out += `\\${ch}`;
        } else {
            out += ch;
        }
    }
    return new RegExp(`^${out}$`);
}

export function matchPathGlob(glob: string, relPath: string): boolean {
    return pathGlobToRegExp(glob).test(foldPathCase(relPath.replace(/\\/g, '/')));
}

function idGlobToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '.*' : `\\${ch}`));
    return new RegExp(`^${escaped}$`);
}

function toWorkspaceRel(target: string, workspaceRoot: string): string {
    const abs = path.isAbsolute(target) ? target : path.resolve(workspaceRoot, target);
    return path.relative(workspaceRoot, abs).replace(/\\/g, '/');
}

// ── Rule matching ────────────────────────────────────────────────────

type PathMatch = 'all' | 'some' | 'none';

function matchTargetPaths(glob: string, d: PolicyCallDescriptor): PathMatch {
    const targets = d.targetPaths ?? [];
    if (targets.length === 0) return 'none';
    let hits = 0;
    for (const t of targets) {
        if (matchPathGlob(glob, toWorkspaceRel(t, d.workspaceRoot))) hits++;
    }
    return hits === targets.length ? 'all' : hits > 0 ? 'some' : 'none';
}

export function normalizeExecutableName(raw: string): string {
    const base = raw.replace(/^.*[\\/]/, '').toLowerCase();
    return base.replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

export function commandMatchesPrefix(tokensOrCommand: readonly string[] | string, prefix: readonly string[]): boolean {
    if (!prefix || prefix.length === 0) return true;
    const tokens = typeof tokensOrCommand === 'string' ? tokenizeCommand(tokensOrCommand) : tokensOrCommand;
    if (tokens.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (i === 0) {
            if (normalizeExecutableName(tokens[0]!) !== normalizeExecutableName(prefix[0]!)) return false;
        } else {
            if (!commandTokenEquals(tokens[i]!, prefix[i]!)) return false;
        }
    }
    return true;
}

function ruleMatches(rule: PolicyRule, d: PolicyCallDescriptor): boolean {
    if (rule.subject !== d.subject) return false;
    if (rule.expiresAt && rule.expiresAt <= Date.now()) return false;
    // riskMax caps what an allow rule may exempt; deny/ask apply regardless.
    if (rule.action === 'allow' && rule.riskMax !== undefined && d.riskLevel > rule.riskMax) return false;

    if (rule.cwdRoot !== undefined) {
        if (!d.cwd || !isPathInsideOrEqual(d.cwd, rule.cwdRoot)) return false;
    }
    if (rule.commandPrefix && rule.commandPrefix.length > 0) {
        const tokens = d.commandTokens ?? (d.command ? tokenizeCommand(d.command) : []);
        if (!commandMatchesPrefix(tokens, rule.commandPrefix)) return false;
    }
    if (rule.pathGlob !== undefined) {
        const m = matchTargetPaths(rule.pathGlob, d);
        // allow needs full coverage; deny/ask trigger on any hit.
        if (rule.action === 'allow' ? m !== 'all' : m === 'none') return false;
    }
    if (rule.networkHostGlob !== undefined) {
        const hosts = d.networkHosts ?? [];
        if (hosts.length === 0) return false;
        const re = idGlobToRegExp(rule.networkHostGlob.toLowerCase());
        const hits = hosts.filter(h => re.test(h.toLowerCase())).length;
        if (rule.action === 'allow' ? hits !== hosts.length : hits === 0) return false;
    }
    if (rule.mcpServerGlob !== undefined) {
        if (!d.mcpServer || !idGlobToRegExp(rule.mcpServerGlob).test(d.mcpServer)) return false;
    }
    if (rule.mcpToolGlob !== undefined) {
        if (!d.mcpTool || !idGlobToRegExp(rule.mcpToolGlob).test(d.mcpTool)) return false;
    }
    if (rule.taskRole !== undefined && rule.taskRole !== d.taskRole) return false;
    if (rule.exactId !== undefined && rule.exactId !== d.exactId) return false;
    return true;
}

// ── Specificity (within one layer and subject) ───────────────────────

function globSpecificity(glob: string): [number, number] {
    const depth = glob.replace(/\\/g, '/').split('/').filter(Boolean).length;
    const wildcards = (glob.match(/\*/g) ?? []).length;
    return [depth, -wildcards];
}

function ruleSpecificity(rule: PolicyRule): number[] {
    const parts: number[] = [];
    parts.push(rule.commandPrefix?.length ?? 0);
    if (rule.pathGlob !== undefined) {
        const [depth, negWild] = globSpecificity(rule.pathGlob);
        parts.push(depth, negWild);
    } else {
        parts.push(0, 0);
    }
    const mcpExact = (rule.mcpServerGlob && !rule.mcpServerGlob.includes('*') ? 1 : 0)
        + (rule.mcpToolGlob && !rule.mcpToolGlob.includes('*') ? 1 : 0);
    parts.push(mcpExact, (rule.mcpServerGlob?.length ?? 0) + (rule.mcpToolGlob?.length ?? 0));
    if (rule.networkHostGlob !== undefined) {
        parts.push(rule.networkHostGlob.includes('*') ? 0 : 1, rule.networkHostGlob.split('.').length);
    } else {
        parts.push(0, 0);
    }
    parts.push(rule.cwdRoot !== undefined ? 1 : 0);
    parts.push((rule.taskRole !== undefined || rule.exactId !== undefined) ? 1 : 0);
    return parts;
}

function pickWinner(rules: PolicyRule[]): PolicyRule | undefined {
    let winner: PolicyRule | undefined;
    let winnerSpec: number[] = [];
    for (const rule of rules) {
        const spec = ruleSpecificity(rule);
        if (!winner) { winner = rule; winnerSpec = spec; continue; }
        let cmp = 0;
        for (let i = 0; i < Math.max(spec.length, winnerSpec.length); i++) {
            cmp = (spec[i] ?? 0) - (winnerSpec[i] ?? 0);
            if (cmp !== 0) break;
        }
        // Equal specificity: deny > ask > allow.
        if (cmp > 0 || (cmp === 0 && SEVERITY[rule.action] > SEVERITY[winner.action])) {
            winner = rule;
            winnerSpec = spec;
        }
    }
    return winner;
}

// ── Profile defaults / presets ───────────────────────────────────────

export type PolicyPresetId = 'read-only' | 'workspace-auto' | 'workspace-auto-review' | 'trusted-automation' | 'full-access';

export const POLICY_PRESETS: Record<PolicyPresetId, Omit<PermissionProfile, 'writableRoots' | 'rules'>> = {
    'read-only': { id: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', networkAccess: false, protectedPaths: DEFAULT_PROTECTED_PATHS },
    'workspace-auto': { id: 'workspace-auto', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', networkAccess: false, protectedPaths: DEFAULT_PROTECTED_PATHS },
    'workspace-auto-review': { id: 'workspace-auto-review', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', networkAccess: false, protectedPaths: DEFAULT_PROTECTED_PATHS },
    'trusted-automation': { id: 'trusted-automation', sandboxMode: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user', networkAccess: false, protectedPaths: DEFAULT_PROTECTED_PATHS },
    'full-access': { id: 'full-access', sandboxMode: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user', networkAccess: true, protectedPaths: DEFAULT_PROTECTED_PATHS },
};

export function buildProfile(preset: PolicyPresetId, workspaceRoot: string, rules: PolicyRule[] = []): PermissionProfile {
    const base = POLICY_PRESETS[preset] ?? POLICY_PRESETS['workspace-auto'];
    return { ...base, writableRoots: [workspaceRoot], rules };
}

let ruleSeq = 0;
export function newRuleId(prefix = 'rule'): string {
    return `${prefix}_${Date.now()}_${++ruleSeq}`;
}

const READABLE_BUT_WRITE_PROTECTED_PREFIXES = ['.git/', '.agents/', '.codex/', '.cwtools/'];

/** Protected agent/Git stores remain readable; secret-like paths deny reads too. */
export function buildProtectedPathRules(protectedPaths: string[]): PolicyRule[] {
    const rules: PolicyRule[] = [];
    for (const glob of protectedPaths) {
        rules.push({ id: `protected_edit:${glob}`, subject: 'edit', pathGlob: glob, action: 'deny' });
        const normalized = glob.replace(/\\/g, '/').toLowerCase();
        if (!READABLE_BUT_WRITE_PROTECTED_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
            rules.push({ id: `protected_read:${glob}`, subject: 'read', pathGlob: glob, action: 'deny' });
        }
    }
    return rules;
}

// ── Resolution ───────────────────────────────────────────────────────

function baseAction(d: PolicyCallDescriptor, profile: PermissionProfile): PermissionAction {
    if (profile.sandboxMode === 'read-only' && WRITE_LIKE.has(d.subject)) return 'deny';
    if (profile.sandboxMode === 'danger-full-access') return 'allow';
    let base: PermissionAction = d.riskLevel >= 3 ? 'deny' : d.riskLevel === 0 ? 'allow' : 'ask';
    if (d.subject === 'network' && !profile.networkAccess && base === 'allow') base = 'ask';
    switch (profile.approvalPolicy) {
        case 'untrusted': return (WRITE_LIKE.has(d.subject) || d.subject === 'network') ? 'deny' : base;
        case 'never': return base === 'ask' ? 'deny' : base;
        case 'granular': return 'deny';
        default: return base;
    }
}

function outsideWritableRoots(d: PolicyCallDescriptor, profile: PermissionProfile): string | undefined {
    if (d.subject !== 'edit' || !d.targetPaths?.length) return undefined;
    const roots = profile.writableRoots.length > 0 ? profile.writableRoots : [d.workspaceRoot];
    for (const target of d.targetPaths) {
        const abs = path.isAbsolute(target) ? target : path.resolve(d.workspaceRoot, target);
        if (!roots.some(root => isPathInsideOrEqual(abs, root))) return target;
    }
    return undefined;
}

const SUBJECT_ALTERNATIVES: Partial<Record<PolicySubject, Array<{ tool: string; reason: string }>>> = {
    bash: [{ tool: 'edit_file', reason: 'Use structured edit tools instead of shell file manipulation.' }],
    edit: [{ tool: 'write_localisation', reason: 'Localisation .yml writes must go through write_localisation.' }],
};

export function resolvePolicy(
    d: PolicyCallDescriptor,
    profile: PermissionProfile,
    extraLayers: PolicyLayer[] = []
): PolicyDecision {
    const matchedRules: string[] = [];
    let action = baseAction(d, profile);
    let denialCode = action === 'deny' ? 'profile_default' : '';

    // Hard boundary 1: writable roots
    const escaped = outsideWritableRoots(d, profile);
    if (escaped) {
        action = 'deny';
        denialCode = 'outside_writable_roots';
        matchedRules.push('writable-roots');
    }

    // Hard boundary 2: global-defaults (protected paths)
    if (profile.sandboxMode !== 'danger-full-access') {
        const protectedRules = buildProtectedPathRules(profile.protectedPaths);
        const hit = protectedRules.find(rule => ruleMatches(rule, d));
        if (hit) {
            action = 'deny';
            denialCode = 'protected_path';
            matchedRules.push(hit.id);
        }
    }

    // User layer: user-configured and learned approval rules (cannot override sandbox hard boundaries)
    if (denialCode !== 'outside_writable_roots' && denialCode !== 'protected_path') {
        const effectiveRules = [...profile.rules, ...extraLayers.flatMap(l => l.rules)];
        const matchingRules = effectiveRules.filter(rule => ruleMatches(rule, d));
        if (matchingRules.length > 0) {
            const winner = pickWinner(matchingRules);
            if (winner) {
                action = winner.action;
                matchedRules.push(winner.id);
                if (action === 'deny') {
                    denialCode = `rule:${winner.id}`;
                }
            }
        }
    }

    // approvalPolicy 'never': anything still needing approval fails closed.
    if (action === 'ask' && profile.approvalPolicy === 'never') {
        action = 'deny';
        denialCode = denialCode || 'approval_policy_never';
    }

    const decision: PolicyDecision = { action, matchedRules };
    if (action === 'deny') {
        const canEscalate = profile.sandboxMode !== 'read-only'
            && denialCode !== 'outside_writable_roots' && denialCode !== 'protected_path'
            && profile.approvalPolicy !== 'never';
        decision.denial = {
            code: denialCode || 'denied',
            matchedRules,
            whyDenied: escaped
                ? `Target '${escaped}' is outside the writable roots.`
                : `'${d.toolName}' (${d.subject}, risk ${d.riskLevel}) is denied under profile '${profile.id}'.`,
            allowedAlternatives: SUBJECT_ALTERNATIVES[d.subject] ?? [],
            approvalPath: canEscalate
                ? { reviewer: profile.approvalsReviewer, requestedScope: 'once', summary: `Ask the user to approve '${d.toolName}' for this call.` }
                : undefined,
        };
    }
    return decision;
}

// ── Sub-agent derivation (Phase 3) ───────────────────────────────────

/** Clamp a child write scope to parent writable roots; escapes are rejected, never widened. */
export function clampWriteScopeToRoots(
    writeScope: string[] | undefined,
    parentRoots: string[],
    workspaceRoot: string
): { clamped: string[] | undefined; rejected: string[] } {
    if (!writeScope) return { clamped: undefined, rejected: [] };
    const roots = parentRoots.length > 0 ? parentRoots : [workspaceRoot];
    const clamped: string[] = [];
    const rejected: string[] = [];
    for (const scope of writeScope) {
        // Marker scopes (extensions / directory keywords) stay; absolute-ish paths must be inside a root.
        if (!scope.includes('/') && !scope.includes('\\') && !path.isAbsolute(scope)) {
            clamped.push(scope);
            continue;
        }
        const abs = path.isAbsolute(scope) ? scope : path.resolve(workspaceRoot, scope);
        if (roots.some(root => isPathInsideOrEqual(abs, root))) clamped.push(scope);
        else rejected.push(scope);
    }
    return { clamped, rejected };
}
