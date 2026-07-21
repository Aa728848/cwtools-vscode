/**
 * Semantic evidence protocol (plan §4.1).
 *
 * A write to a PDX script file must be backed by structured evidence claims.
 * Each claim is verified against a concrete source (CWT rules, LSP, project
 * index) whose `revision` binds the observation to a checkable freshness
 * token (rules fingerprint, index fileVersion, observed epoch). A tool name
 * alone is never evidence.
 *
 * The model cannot promote `unknown` to `verified`; only re-collection of
 * evidence through this module can change a claim's status.
 */

export type EvidenceStatus = 'verified' | 'unknown' | 'conflict' | 'stale';

export type EvidenceClaimKind =
    | 'syntax_shape'
    | 'scope_compatibility'
    | 'symbol_exists'
    | 'reference_exists'
    | 'call_chain'
    | 'design_choice';

export type EvidenceGateMode = 'off' | 'shadow' | 'enforce';
export type EvidenceGatePhase = 'pre_write' | 'post_write';

export type EvidenceGateVerdict = 'allow' | 'block' | 'override';

export interface EvidenceSource {
    /** Which evidence provider produced the observation, e.g. 'cwt_rules', 'lsp.parseFragment'. */
    tool: string;
    /** The concrete target the observation is about (rule name, file, identifier). */
    target: string;
    /** Game/profile the observation applies to; evidence never crosses profiles. */
    gameProfile: string;
    /** Freshness token: rules content fingerprint, index fileVersion, content hash, etc. */
    revision: string;
    /** ISO timestamp of the observation. */
    observedAt: string;
}

export interface EvidenceClaim {
    kind: EvidenceClaimKind;
    /** Machine- and human-readable claim text, e.g. "effect 'add_opinion_modifier' exists". */
    claim: string;
    status: EvidenceStatus;
    /** Blocking claims gate the write; non-blocking claims are advisory only. */
    blocking: boolean;
    sources: EvidenceSource[];
    detail?: string;
}

/** Machine-readable description of what is missing and how to collect it. */
export interface EvidenceMissingItem {
    kind: EvidenceClaimKind;
    claim: string;
    status: EvidenceStatus;
    /** Concrete read-only tool invocations the model can run to collect the evidence. */
    suggestedQueries: string[];
}

export interface EvidenceGateDecision {
    version: 1;
    decisionId: string;
    /** Write tool that was gated. */
    tool: string;
    /** Workspace-relative (or absolute) target path. */
    target: string;
    mode: EvidenceGateMode;
    phase: EvidenceGatePhase;
    verdict: EvidenceGateVerdict;
    claims: EvidenceClaim[];
    missingEvidence: EvidenceMissingItem[];
    evaluatedAt: string;
    durationMs: number;
    /** True when one or more evidence sources were unavailable/timed out. */
    degraded?: boolean;
    /** True when the LSP evidence channel itself was down — enforce mode fails closed with no override. */
    evidenceUnavailable?: boolean;
    /** True when the verdict came from the short-term decision cache. */
    fromCache?: boolean;
}

const EVIDENCE_STATUSES: ReadonlySet<string> = new Set<EvidenceStatus>(['verified', 'unknown', 'conflict', 'stale']);
const EVIDENCE_CLAIM_KINDS: ReadonlySet<string> = new Set<EvidenceClaimKind>([
    'syntax_shape',
    'scope_compatibility',
    'symbol_exists',
    'reference_exists',
    'call_chain',
    'design_choice',
]);
const EVIDENCE_GATE_MODES: ReadonlySet<string> = new Set<EvidenceGateMode>(['off', 'shadow', 'enforce']);
const EVIDENCE_GATE_VERDICTS: ReadonlySet<string> = new Set<EvidenceGateVerdict>(['allow', 'block', 'override']);
const EVIDENCE_GATE_PHASES: ReadonlySet<string> = new Set<EvidenceGatePhase>(['pre_write', 'post_write']);

export function isEvidenceStatus(value: unknown): value is EvidenceStatus {
    return typeof value === 'string' && EVIDENCE_STATUSES.has(value);
}

export function isEvidenceClaimKind(value: unknown): value is EvidenceClaimKind {
    return typeof value === 'string' && EVIDENCE_CLAIM_KINDS.has(value);
}

export function isEvidenceGateMode(value: unknown): value is EvidenceGateMode {
    return typeof value === 'string' && EVIDENCE_GATE_MODES.has(value);
}

export function isEvidenceGateVerdict(value: unknown): value is EvidenceGateVerdict {
    return typeof value === 'string' && EVIDENCE_GATE_VERDICTS.has(value);
}

export function isEvidenceGatePhase(value: unknown): value is EvidenceGatePhase {
    return typeof value === 'string' && EVIDENCE_GATE_PHASES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function isEvidenceSource(value: unknown): value is EvidenceSource {
    if (!isRecord(value)) return false;
    return typeof value.tool === 'string'
        && typeof value.target === 'string'
        && typeof value.gameProfile === 'string'
        && typeof value.revision === 'string'
        && typeof value.observedAt === 'string';
}

export function isEvidenceClaim(value: unknown): value is EvidenceClaim {
    if (!isRecord(value)) return false;
    return isEvidenceClaimKind(value.kind)
        && typeof value.claim === 'string'
        && isEvidenceStatus(value.status)
        && typeof value.blocking === 'boolean'
        && Array.isArray(value.sources)
        && value.sources.every(isEvidenceSource)
        && (value.detail === undefined || typeof value.detail === 'string');
}

export function isEvidenceMissingItem(value: unknown): value is EvidenceMissingItem {
    if (!isRecord(value)) return false;
    return isEvidenceClaimKind(value.kind)
        && typeof value.claim === 'string'
        && isEvidenceStatus(value.status)
        && Array.isArray(value.suggestedQueries)
        && value.suggestedQueries.every(q => typeof q === 'string');
}

export function isEvidenceGateDecision(value: unknown): value is EvidenceGateDecision {
    if (!isRecord(value)) return false;
    return value.version === 1
        && typeof value.decisionId === 'string'
        && typeof value.tool === 'string'
        && typeof value.target === 'string'
        && isEvidenceGateMode(value.mode)
        && isEvidenceGatePhase(value.phase)
        && isEvidenceGateVerdict(value.verdict)
        && Array.isArray(value.claims)
        && value.claims.every(isEvidenceClaim)
        && Array.isArray(value.missingEvidence)
        && value.missingEvidence.every(isEvidenceMissingItem)
        && typeof value.evaluatedAt === 'string'
        && typeof value.durationMs === 'number'
        && (value.degraded === undefined || typeof value.degraded === 'boolean')
        && (value.evidenceUnavailable === undefined || typeof value.evidenceUnavailable === 'boolean')
        && (value.fromCache === undefined || typeof value.fromCache === 'boolean');
}

/** Normalize an untrusted mode string (settings JSON) to a valid gate mode. */
export function normalizeEvidenceGateMode(value: unknown): EvidenceGateMode {
    // An invalid or missing persisted value must not silently weaken the
    // package default. Users can still explicitly select `off` or `shadow`.
    return isEvidenceGateMode(value) ? value : 'enforce';
}

export function createEvidenceDecisionId(now: () => number = Date.now): string {
    return `eg_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
