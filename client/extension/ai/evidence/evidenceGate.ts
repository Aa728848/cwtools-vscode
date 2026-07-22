/**
 * Semantic evidence collection and verdict aggregation (plan §4.2.2–4.2.6, §4.3).
 *
 * For each extracted claim the gate consults the appropriate source:
 *  - CWT rules (name existence, supported scopes) — file-backed, fingerprinted
 *  - LSP parseFragment (syntax shape)
 *  - LSP queryDefinitionByName + workspace IndexService (ID existence)
 *
 * Status rules (plan §3 boundary 4):
 *  - no evidence / source unavailable or timed out -> `unknown`
 *  - sources disagree, or an authoritative source contradicts the claim -> `conflict`
 *  - evidence revision older than the currently observable revision -> `stale`
 *
 * Aggregation is two-phase: pre-write only a confirmed conflict blocks, while
 * unknown/stale evidence remains visible for post-write and final validation.
 * The gate never lets model text promote a claim; a retry re-runs collection.
 * call_chain is only checked when the fragment determines it deterministically
 * — otherwise it stays a non-blocking `unknown` with an explicit limitation.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    createEvidenceDecisionId,
    type EvidenceClaim,
    type EvidenceGateDecision,
    type EvidenceGateMode,
    type EvidenceGatePhase,
    type EvidenceMissingItem,
    type EvidenceSource,
} from './evidenceTypes';
import {
    extractClaimsFromText,
    extractLocalDefinitions,
    MAX_CLAIM_CANDIDATES,
    MAX_EXTRACT_CHARS,
    scopePushedBy,
    type ExtractedClaimCandidate,
    type LocalDefinitionCandidate,
    type ReferenceKind,
} from './claimExtractor';

export interface GateRuleInfo {
    name: string;
    scopes: string[];
    pushScope?: string;
}

export interface IndexLookupResult {
    found: boolean;
    fileVersion?: number;
    indexUpdatedAt?: number;
}

export interface GateReferenceResult {
    file: string;
    line?: number;
    context?: string;
}

export interface EvidenceGateDeps {
    workspaceRoot: string;
    /** Game/profile id (e.g. 'stellaris'); evidence never crosses profiles. */
    gameProfile: string;
    /** Send an LSP workspace/executeCommand command. Rejects when the LSP is unavailable. */
    sendLspCommand?: (command: string, args: unknown[], timeoutMs?: number) => Promise<unknown>;
    /** CWT rule candidates for a name (may include fuzzy/non-exact rows; the gate exact-matches). */
    queryRules?: (category: 'trigger' | 'effect' | 'scope_change' | 'modifier', name: string) => Promise<GateRuleInfo[]>;
    /** Workspace/vanilla symbol index lookup; undefined result means the index is unavailable. */
    indexLookup?: (name: string) => Promise<IndexLookupResult | undefined>;
    /** Bounded project/vanilla reference lookup used for explicit entry-point reachability. */
    queryReferences?: (name: string) => Promise<GateReferenceResult[] | undefined>;
    /** Synchronous freshness token for the workspace/vanilla indexes used by cached decisions. */
    getIndexRevision?: () => string;
    /** Candidate CWT rules roots used to fingerprint the rules revision. */
    rulesRoots?: string[];
    now?: () => number;
    /** Total verification budget per evaluation. Defaults to GATE_TOTAL_TIMEOUT_MS. */
    totalTimeoutMs?: number;
}

export interface EvidenceGateEvaluateInput {
    toolName: string;
    targetFile: string;
    text: string;
    /** Exact content before the pending edit; unchanged legacy claims do not block repairs. */
    previousText?: string;
    truncated?: boolean;
    mode: Exclude<EvidenceGateMode, 'off'>;
    phase?: EvidenceGatePhase;
}

/** Total per-write evidence collection budget (plan §4.2 performance bound). */
export const GATE_TOTAL_TIMEOUT_MS = 6_000;
const PER_SOURCE_TIMEOUT_MS = 3_000;
const DECISION_CACHE_TTL_MS = 30_000;
const DECISION_CACHE_MAX = 200;
const MAX_MISSING_ITEMS = 20;

/** Rule files that define the CWT evidence revision. */
const RULE_FILES = [
    'triggers.cwt',
    'trigger.cwt',
    'effects.cwt',
    'effect.cwt',
    'scope_changes.cwt',
    'scopes.cwt',
    path.join('generated', 'triggers.generated.cwt'),
    path.join('generated', 'effects.generated.cwt'),
    path.join('generated', 'scope_changes.generated.cwt'),
    path.join('logs', 'modifiers.log'),
    path.join('logs', 'trigger_docs.log'),
];

function sha256Text(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function statMtime(filePath: string): number | undefined {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return undefined;
    }
}

function statRevision(filePath: string): string {
    try {
        const stat = fs.statSync(filePath);
        return `${stat.mtimeMs}:${stat.size}`;
    } catch {
        return 'missing';
    }
}

/** Fingerprint the on-disk CWT rules revision from file mtimes/sizes. */
export function computeRulesFingerprint(roots: readonly string[]): string {
    const parts: string[] = [];
    for (const root of roots) {
        for (const rel of RULE_FILES) {
            try {
                const full = path.join(root, rel);
                const st = fs.statSync(full);
                if (st.isFile()) parts.push(`${full}:${st.mtimeMs}:${st.size}`);
            } catch {
                // Missing rule files are normal for candidate roots.
            }
        }
    }
    parts.sort();
    return parts.length > 0 ? sha256Text(parts.join('|')).slice(0, 16) : 'none';
}

interface ParseFragmentResult {
    valid: boolean;
    errors: Array<{ line?: number; col?: number; message: string }>;
}

function parseFragmentResult(value: unknown): ParseFragmentResult | undefined {
    if (!isRecord(value) || typeof value.valid !== 'boolean') return undefined;
    const errors: ParseFragmentResult['errors'] = [];
    if (Array.isArray(value.errors)) {
        for (const err of value.errors.slice(0, 5)) {
            if (isRecord(err) && typeof err.message === 'string') {
                errors.push({
                    line: typeof err.line === 'number' ? err.line : undefined,
                    col: typeof err.col === 'number' ? err.col : undefined,
                    message: err.message,
                });
            }
        }
    }
    return { valid: value.valid, errors };
}

interface DefinitionLookupResult {
    found: boolean;
    type?: string;
    file?: string;
    line?: number;
}

function definitionLookupResult(value: unknown): DefinitionLookupResult | undefined {
    if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined;
    return {
        found: value.ok,
        type: typeof value.type === 'string' ? value.type : undefined,
        file: typeof value.file === 'string' ? value.file : undefined,
        line: typeof value.line === 'number' ? value.line : undefined,
    };
}

export class EvidenceGate {
    private readonly now: () => number;
    private readonly totalTimeoutMs: number;
    private readonly decisionCache = new Map<string, { decision: EvidenceGateDecision; expiresAt: number; evidenceRevision: string }>();

    constructor(private readonly deps: EvidenceGateDeps) {
        this.now = deps.now ?? Date.now;
        this.totalTimeoutMs = Math.max(1_000, deps.totalTimeoutMs ?? GATE_TOTAL_TIMEOUT_MS);
    }

    /** Drop cached decisions (e.g. after a rules sync). TTL/fingerprint normally handles this. */
    public invalidateCache(): void {
        this.decisionCache.clear();
    }

    public async evaluate(input: EvidenceGateEvaluateInput): Promise<EvidenceGateDecision> {
        const startedAt = this.now();
        const rulesFingerprint = computeRulesFingerprint(this.deps.rulesRoots ?? []);
        const indexRevision = this.deps.getIndexRevision?.() ?? 'unavailable';
        const targetRevision = statRevision(input.targetFile);
        const evidenceRevision = `${rulesFingerprint}|index:${indexRevision}|target:${targetRevision}`;
        const cacheKey = sha256Text([
            this.deps.gameProfile,
            input.mode,
            input.phase ?? 'pre_write',
            input.toolName,
            input.targetFile,
            sha256Text(input.previousText ?? ''),
            sha256Text(input.text),
        ].join('|'));
        const cached = this.decisionCache.get(cacheKey);
        if (cached && cached.expiresAt > startedAt && cached.evidenceRevision === evidenceRevision) {
            return { ...cached.decision, fromCache: true };
        }

        const decision = await this.collect(input, rulesFingerprint, startedAt);
        this.storeInCache(cacheKey, decision, evidenceRevision);
        return decision;
    }

    private storeInCache(key: string, decision: EvidenceGateDecision, evidenceRevision: string): void {
        // Only short-cache clean 'allow' decisions. Advisory unknown/stale
        // results must observe newly indexed custom definitions promptly.
        if (decision.degraded
            || decision.verdict !== 'allow'
            || decision.claims.some(claim => claim.blocking && claim.status !== 'verified')) return;
        const expiresAt = this.now() + DECISION_CACHE_TTL_MS;
        for (const [k, v] of this.decisionCache) {
            if (v.expiresAt <= this.now()) this.decisionCache.delete(k);
        }
        if (this.decisionCache.size >= DECISION_CACHE_MAX) {
            const oldest = this.decisionCache.keys().next().value;
            if (oldest !== undefined) this.decisionCache.delete(oldest);
        }
        this.decisionCache.set(key, { decision, expiresAt, evidenceRevision });
    }

    private makeSource(tool: string, target: string, revision: string): EvidenceSource {
        return {
            tool,
            target,
            gameProfile: this.deps.gameProfile,
            revision,
            observedAt: new Date(this.now()).toISOString(),
        };
    }

    private async collect(
        input: EvidenceGateEvaluateInput,
        rulesFingerprint: string,
        startedAt: number,
    ): Promise<EvidenceGateDecision> {
        const deadline = startedAt + this.totalTimeoutMs;
        const truncated = input.truncated === true || input.text.length > MAX_EXTRACT_CHARS;
        const boundedText = input.text.length > MAX_EXTRACT_CHARS
            ? input.text.slice(0, MAX_EXTRACT_CHARS)
            : input.text;
        const allCandidates = extractClaimsFromText({
            targetFile: input.targetFile,
            text: boundedText,
            truncated,
            gameProfile: this.deps.gameProfile,
        }).map(candidate => candidate.subject.type === 'syntax'
            ? {
                ...candidate,
                // Semantic extraction stays bounded, but syntax validation must
                // cover the complete final file rather than a valid 100k prefix.
                subject: { ...candidate.subject, code: input.text },
                detail: truncated
                    ? `Semantic extraction is bounded to ${MAX_EXTRACT_CHARS} chars; syntax verification covers the complete file.`
                    : candidate.detail,
            }
            : candidate);
        const localDefinitions = extractLocalDefinitions({
            targetFile: input.targetFile,
            text: boundedText,
            truncated,
            gameProfile: this.deps.gameProfile,
        });
        const locallyReferencedEvents = new Set(allCandidates.flatMap(candidate =>
            candidate.subject.type === 'reference' && candidate.subject.refKind === 'event'
                ? [candidate.subject.id.toLowerCase()]
                : [],
        ));
        const previousText = input.previousText ?? '';
        const previousBoundedText = previousText.length > MAX_EXTRACT_CHARS
            ? previousText.slice(0, MAX_EXTRACT_CHARS)
            : previousText;
        const previousCounts = new Map<string, number>();
        if (previousBoundedText.length > 0) {
            const previousCandidates = extractClaimsFromText({
                targetFile: input.targetFile,
                text: previousBoundedText,
                truncated: previousText.length > MAX_EXTRACT_CHARS,
                gameProfile: this.deps.gameProfile,
            });
            for (const candidate of previousCandidates) {
                if (candidate.subject.type === 'syntax') continue;
                const key = this.candidateIdentity(candidate);
                previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
            }
        }
        const candidates = allCandidates.filter(candidate => {
            if (candidate.subject.type === 'syntax') return true;
            const key = this.candidateIdentity(candidate);
            const remaining = previousCounts.get(key) ?? 0;
            if (remaining <= 0) return true;
            previousCounts.set(key, remaining - 1);
            return false;
        });

        const claims: EvidenceClaim[] = [];
        let degraded = false;
        let lspDown = false;
        const mtimeBefore = statMtime(input.targetFile);

        for (const candidate of candidates) {
            if (this.now() > deadline) {
                // Budget exhausted: remaining claims stay unknown (and will
                // block in enforce) but the gate itself is not degraded —
                // the model can retry with a smaller fragment.
                claims.push(this.unresolved(candidate, 'Evidence collection exceeded its time budget.'));
                continue;
            }
            try {
                const resolved = await this.resolveCandidate(
                    candidate,
                    rulesFingerprint,
                    input,
                    localDefinitions,
                    locallyReferencedEvents,
                    () => { lspDown = true; },
                );
                if (resolved.rulesError) degraded = true;
                claims.push(...resolved.claims);
            } catch (error) {
                // Verification must degrade to unknown, never crash the write path.
                claims.push(this.unresolved(candidate, error instanceof Error ? error.message : String(error)));
            }
        }

        if (truncated || allCandidates.length >= MAX_CLAIM_CANDIDATES) {
            claims.push({
                kind: 'reference_exists',
                claim: 'semantic evidence extraction covers the complete written file',
                status: 'unknown',
                blocking: true,
                sources: [],
                detail: truncated
                    ? `Only the first ${MAX_EXTRACT_CHARS} characters were scanned for semantic references; final validation must cover the complete file.`
                    : `The ${MAX_CLAIM_CANDIDATES}-claim extraction bound was reached; final validation must confirm no later references were omitted.`,
            });
        }

        if (lspDown) degraded = true;

        // Stale: the target changed on disk while evidence was collected.
        const mtimeAfter = statMtime(input.targetFile);
        if (mtimeBefore !== mtimeAfter) {
            for (const claim of claims) {
                if (claim.kind === 'syntax_shape' || claim.kind === 'reference_exists') {
                    claim.status = 'stale';
                    claim.detail = `${claim.detail ? `${claim.detail} ` : ''}Target file changed during evidence collection; re-verify before writing.`;
                }
            }
        }

        const missingEvidence = this.buildMissingEvidence(claims, input);
        // Write stability takes precedence over incomplete evidence. Unknown
        // and stale claims remain visible and are rechecked after the write,
        // but only a positively established contradiction blocks preflight.
        const verdict: EvidenceGateDecision['verdict'] = claims.some(claim =>
            claim.blocking && claim.status === 'conflict')
            ? 'block'
            : 'allow';

        return {
            version: 1,
            decisionId: createEvidenceDecisionId(this.now),
            tool: input.toolName,
            target: input.targetFile,
            mode: input.mode,
            phase: input.phase ?? 'pre_write',
            verdict,
            claims,
            missingEvidence,
            evaluatedAt: new Date(this.now()).toISOString(),
            durationMs: Math.max(0, this.now() - startedAt),
            degraded: degraded || undefined,
            evidenceUnavailable: lspDown || undefined,
        };
    }

    private unresolved(candidate: ExtractedClaimCandidate, reason: string): EvidenceClaim {
        return {
            kind: candidate.kind,
            claim: candidate.claim,
            status: 'unknown',
            blocking: candidate.blocking,
            sources: [],
            detail: `${candidate.detail ? `${candidate.detail} ` : ''}Evidence unavailable: ${reason}`,
        };
    }

    private candidateIdentity(candidate: ExtractedClaimCandidate): string {
        return JSON.stringify({ kind: candidate.kind, blocking: candidate.blocking, subject: candidate.subject });
    }

    private async resolveCandidate(
        candidate: ExtractedClaimCandidate,
        rulesFingerprint: string,
        input: EvidenceGateEvaluateInput,
        localDefinitions: readonly LocalDefinitionCandidate[],
        locallyReferencedEvents: ReadonlySet<string>,
        markLspDown: () => void,
    ): Promise<{ claims: EvidenceClaim[]; rulesError?: boolean }> {
        const subject = candidate.subject;
        switch (subject.type) {
            case 'syntax':
                return { claims: [await this.resolveSyntax(candidate, subject.code, input, markLspDown)] };
            case 'rule':
                return this.resolveRuleCandidate(candidate, subject, rulesFingerprint, input, localDefinitions, markLspDown);
            case 'reference':
                return { claims: [await this.resolveReference(candidate, subject.id, subject.refKind, input, localDefinitions, markLspDown)] };
            case 'call_chain':
                return { claims: [await this.resolveCallChain(candidate, subject.entryId, subject.requiresCaller, input, locallyReferencedEvents)] };
        }
    }

    private async resolveSyntax(
        candidate: ExtractedClaimCandidate,
        code: string,
        input: EvidenceGateEvaluateInput,
        markLspDown: () => void,
    ): Promise<EvidenceClaim> {
        const base: EvidenceClaim = {
            kind: 'syntax_shape',
            claim: candidate.claim,
            status: 'unknown',
            blocking: candidate.blocking,
            sources: [],
            detail: candidate.detail,
        };
        if (!this.deps.sendLspCommand) {
            markLspDown();
            return { ...base, detail: this.joinDetail(base.detail, 'LSP is not connected.') };
        }
        try {
            const raw = await this.deps.sendLspCommand('cwtools.ai.parseFragment', [code], PER_SOURCE_TIMEOUT_MS);
            const parsed = parseFragmentResult(raw);
            if (!parsed) {
                markLspDown();
                return { ...base, detail: this.joinDetail(base.detail, 'LSP returned an unrecognized parse result.') };
            }
            const revision = `sha256:${sha256Text(code).slice(0, 16)}`;
            const source = this.makeSource('lsp.parseFragment', input.targetFile, revision);
            if (parsed.valid) {
                return { ...base, status: 'verified', sources: [source] };
            }
            const errorSummary = parsed.errors.map(e => `L${(e.line ?? 0) + 1}:${(e.col ?? 0) + 1} ${e.message}`).join('; ') || 'parse errors';
            return {
                ...base,
                status: 'conflict',
                sources: [source],
                detail: this.joinDetail(base.detail, `Fragment does not parse: ${errorSummary}`),
            };
        } catch (error) {
            markLspDown();
            return { ...base, detail: this.joinDetail(base.detail, `parseFragment failed: ${error instanceof Error ? error.message : String(error)}`) };
        }
    }

    private ruleCategoriesFor(position: 'effect' | 'trigger' | 'modifier' | 'any', name: string): Array<'trigger' | 'effect' | 'scope_change' | 'modifier'> {
        const scoped: Array<'trigger' | 'effect' | 'scope_change' | 'modifier'> = scopePushedBy(name) ? ['scope_change'] : [];
        switch (position) {
            case 'effect': return [...scoped, 'effect'];
            case 'trigger': return [...scoped, 'trigger'];
            case 'modifier': return ['modifier'];
            case 'any': return [...scoped, 'effect', 'trigger', 'scope_change', 'modifier'];
        }
    }

    private async findRule(
        categories: Array<'trigger' | 'effect' | 'scope_change' | 'modifier'>,
        name: string,
    ): Promise<{ category: 'trigger' | 'effect' | 'scope_change' | 'modifier'; rule: GateRuleInfo } | undefined> {
        if (!this.deps.queryRules) return undefined;
        for (const category of categories) {
            const rules = await this.deps.queryRules(category, name);
            const exact = rules.find(r => r.name.toLowerCase() === name.toLowerCase());
            if (exact) return { category, rule: exact };
        }
        return undefined;
    }

    private async resolveRuleCandidate(
        candidate: ExtractedClaimCandidate,
        subject: { type: 'rule'; name: string; position: 'effect' | 'trigger' | 'modifier' | 'any'; currentScope?: string },
        rulesFingerprint: string,
        input: EvidenceGateEvaluateInput,
        localDefinitions: readonly LocalDefinitionCandidate[],
        markLspDown: () => void,
    ): Promise<{ claims: EvidenceClaim[]; rulesError?: boolean }> {
        let rulesError = false;
        let matched: { category: 'trigger' | 'effect' | 'scope_change' | 'modifier'; rule: GateRuleInfo } | undefined;
        const categories = this.ruleCategoriesFor(subject.position, subject.name);
        try {
            matched = await this.findRule(categories, subject.name);
        } catch (error) {
            rulesError = true;
            return {
                rulesError,
                claims: [{
                    kind: 'symbol_exists',
                    claim: candidate.claim,
                    status: 'unknown',
                    blocking: candidate.blocking,
                    sources: [],
                    detail: `CWT rules lookup failed: ${error instanceof Error ? error.message : String(error)}`,
                }],
            };
        }

        const ruleSource = this.makeSource('cwt_rules', `${categories.join('/')}:${subject.name}`, `rules:${rulesFingerprint}`);
        if (!matched) {
            if (subject.position === 'modifier') {
                // Names inside `modifier = { }` blocks must be engine modifiers;
                // there is no scripted fallback for them.
                return {
                    claims: [{
                        kind: 'symbol_exists',
                        claim: `modifier '${subject.name}' exists in CWT modifier rules`,
                        status: 'conflict',
                        blocking: true,
                        sources: [ruleSource],
                        detail: `'${subject.name}' is not a known modifier. Check spelling with query_rules({ category: 'modifier', name: '${subject.name}' }).`,
                    }],
                };
            }
            // Unknown effect/trigger name: fall back to scripted_effect /
            // scripted_trigger call verification (the game treats those as an
            // extension of the effect/trigger namespace).
            const refKind = subject.position === 'trigger'
                ? 'scripted_trigger'
                : subject.position === 'effect'
                    ? 'scripted_effect'
                    : 'scripted_effect_or_trigger';
            const refKindLabel = refKind === 'scripted_effect_or_trigger' ? 'effect/trigger' : refKind.replace('scripted_', '');
            const refClaim = await this.resolveReference(
                {
                    kind: 'reference_exists',
                    claim: `scripted ${refKindLabel} '${subject.name}' is defined`,
                    blocking: candidate.blocking,
                    subject: { type: 'reference', id: subject.name, refKind },
                },
                subject.name,
                refKind,
                input,
                localDefinitions,
                markLspDown,
                [ruleSource],
            );
            return { claims: [refClaim] };
        }

        const claims: EvidenceClaim[] = [{
            kind: 'symbol_exists',
            claim: `${matched.category} '${subject.name}' exists in CWT rules`,
            status: 'verified',
            blocking: candidate.blocking,
            sources: [ruleSource],
        }];

        // Scope compatibility (plan §3 boundary 2: judged separately).
        const scopes = matched.rule.scopes.filter(s => typeof s === 'string' && s.trim().length > 0);
        const scopeClaimBase: EvidenceClaim = {
            kind: 'scope_compatibility',
            claim: `${matched.category} '${subject.name}' is allowed in scope '${subject.currentScope ?? 'unknown'}'`,
            status: 'verified',
            blocking: subject.currentScope !== undefined,
            sources: [ruleSource],
        };
        if (scopes.length === 0) {
            claims.push({ ...scopeClaimBase, claim: `${matched.category} '${subject.name}' is allowed in any scope` });
        } else if (subject.currentScope === undefined) {
            claims.push({
                ...scopeClaimBase,
                status: 'unknown',
                blocking: false,
                detail: `Supported scopes: ${scopes.join(', ')}. The enclosing scope cannot be determined from the fragment (e.g. event root scope), so compatibility stays unverified.`,
            });
        } else if (scopes.some(s => {
            const normalized = s.toLowerCase();
            return normalized === 'all' || normalized === 'any' || normalized === subject.currentScope!.toLowerCase();
        })) {
            claims.push(scopeClaimBase);
        } else {
            claims.push({
                ...scopeClaimBase,
                status: 'conflict',
                detail: `'${subject.name}' supports scopes [${scopes.join(', ')}] but is used in scope '${subject.currentScope}'.`,
            });
        }
        return { claims };
    }

    private async resolveReference(
        candidate: ExtractedClaimCandidate,
        id: string,
        refKind: ReferenceKind,
        input: EvidenceGateEvaluateInput,
        localDefinitions: readonly LocalDefinitionCandidate[],
        markLspDown: () => void,
        extraSources: EvidenceSource[] = [],
    ): Promise<EvidenceClaim> {
        const sources: EvidenceSource[] = [...extraSources];
        const base: EvidenceClaim = {
            kind: 'reference_exists',
            claim: candidate.claim,
            status: 'unknown',
            blocking: candidate.blocking,
            sources,
            detail: candidate.detail,
        };
        const finish = (status: EvidenceClaim['status'], detail?: string): EvidenceClaim => {
            return { ...base, status, detail: detail ?? base.detail };
        };

        if ((input.phase ?? 'pre_write') === 'pre_write') {
            const expected = this.definitionTypesFor(refKind);
            const local = localDefinitions.find(definition =>
                definition.id.toLowerCase() === id.toLowerCase() && expected.includes(definition.kind));
            if (local) {
                sources.push(this.makeSource(
                    'pending_write.localDefinition',
                    `${local.kind}:${local.id}`,
                    `sha256:${sha256Text(input.text).slice(0, 16)}`,
                ));
                return finish('verified', this.joinDetail(base.detail, `Definition '${id}' is present with type '${local.kind}' in the exact pending final content; post-write evidence must confirm the indexed definition.`));
            }
        }

        let lspFound: boolean | undefined;
        let lspType: string | undefined;
        let lspTypeConflict: string | undefined;
        let indexFound: boolean | undefined;
        let indexRevision: string | undefined;

        if (this.deps.sendLspCommand) {
            try {
                const expectedTypes = this.definitionTypesFor(refKind);
                const raw = await this.deps.sendLspCommand(
                    'cwtools.ai.queryDefinitionByName',
                    [id, expectedTypes],
                    PER_SOURCE_TIMEOUT_MS,
                );
                const lookup = definitionLookupResult(raw);
                lspFound = lookup?.found;
                lspType = lookup?.type?.toLowerCase();
                if (!lookup) {
                    markLspDown();
                } else if (lookup.found && (!lspType || !expectedTypes.includes(lspType))) {
                    // Old/untyped LSP results are not strong enough to prove a
                    // semantic identifier kind. A same-named technology must
                    // never validate a scripted effect/event reference.
                    lspFound = undefined;
                    lspTypeConflict = lspType
                        ? `Definition '${id}' exists as type '${lspType}', not one of [${expectedTypes.join(', ')}].`
                        : `Definition '${id}' was returned without a verifiable entity type; expected one of [${expectedTypes.join(', ')}].`;
                    sources.push(this.makeSource(
                        'lsp.queryDefinitionByName',
                        id,
                        `untyped:${lookup.file ? statRevision(lookup.file) : 'unknown'}`,
                    ));
                } else {
                    const definitionRevision = lookup.file
                        ? `type:${lspType ?? 'none'};file:${lookup.file};stat:${statRevision(lookup.file)};line:${lookup.line ?? -1}`
                        : `type:${lspType ?? 'none'};target:${input.targetFile}`;
                    sources.push(this.makeSource('lsp.queryDefinitionByName', id, definitionRevision));
                }
            } catch {
                markLspDown();
            }
        } else {
            markLspDown();
        }

        if (this.deps.indexLookup) {
            try {
                const indexResult = await this.deps.indexLookup(id);
                if (indexResult) {
                    indexFound = indexResult.found;
                    indexRevision = [
                        indexResult.indexUpdatedAt !== undefined ? `indexUpdatedAt:${indexResult.indexUpdatedAt}` : undefined,
                        indexResult.fileVersion !== undefined ? `fileVersion:${indexResult.fileVersion}` : undefined,
                    ].filter(Boolean).join(',') || 'index';
                    sources.push(this.makeSource('workspace_index', id, indexRevision));
                }
            } catch {
                // A failing index leaves indexFound undefined -> treated as unavailable.
            }
        }

        if (lspTypeConflict) {
            return finish('conflict', lspTypeConflict);
        }
        if (lspFound === true) {
            // The LSP AST index covers vanilla + workspace definitions and is authoritative.
            return finish('verified', base.detail);
        }
        if (lspFound === false && indexFound === true) {
            return finish(
                'stale',
                `The workspace index contains '${id}' (revision ${indexRevision}) but the LSP has not indexed a matching typed definition yet. The write may proceed and post-write validation will re-check it.`,
            );
        }
        if (lspFound === false && indexFound === false) {
            return finish(
                'conflict',
                `No definition of '${id}' exists in the workspace or vanilla files. Do not reference ids that have not been verified to exist.`,
            );
        }
        if (lspFound === false && indexFound === undefined) {
            return finish(
                'unknown',
                `The LSP reports no definition of '${id}', but the workspace index is unavailable for a second source. Treating this as advisory to avoid blocking a custom definition during index refresh.`,
            );
        }
        if (lspFound === undefined && indexFound === true) {
            return finish(
                'unknown',
                `Found in the workspace index, but the LSP did not return a matching typed definition, so existence cannot be confirmed.`,
            );
        }
        return finish(
            'unknown',
            this.joinDetail(base.detail, `No evidence source could confirm whether '${id}' exists.`),
        );
    }

    private definitionTypesFor(
        refKind: ReferenceKind,
    ): string[] {
        switch (refKind) {
            case 'event': return ['event'];
            case 'scripted_effect': return ['scripted_effect'];
            case 'scripted_trigger': return ['scripted_trigger'];
            case 'scripted_effect_or_trigger': return ['scripted_effect', 'scripted_trigger'];
            case 'static_modifier': return ['static_modifier'];
            case 'technology': return ['technology'];
            case 'building': return ['building'];
            case 'trait': return ['trait'];
            case 'starbase_building': return ['starbase_building'];
        }
    }

    private async resolveCallChain(
        candidate: ExtractedClaimCandidate,
        entryId: string,
        requiresCaller: boolean,
        input: EvidenceGateEvaluateInput,
        locallyReferencedEvents: ReadonlySet<string>,
    ): Promise<EvidenceClaim> {
        const base: EvidenceClaim = {
            kind: 'call_chain',
            claim: candidate.claim,
            status: 'unknown',
            blocking: candidate.blocking,
            sources: [],
            detail: candidate.detail,
        };
        if (!requiresCaller) return { ...base, blocking: false };

        if (locallyReferencedEvents.has(entryId.toLowerCase())) {
            return {
                ...base,
                status: 'verified',
                sources: [this.makeSource(
                    'pending_write.localCallSite',
                    entryId,
                    `sha256:${sha256Text(input.text).slice(0, 16)}`,
                )],
                detail: this.joinDetail(base.detail, 'The exact pending final content contains an inbound event/on_action call site.'),
            };
        }
        if (!this.deps.queryReferences) {
            return { ...base, detail: this.joinDetail(base.detail, 'Project reference lookup is unavailable.') };
        }
        try {
            const references = await this.deps.queryReferences(entryId);
            if (!references) {
                return { ...base, detail: this.joinDetail(base.detail, 'Project reference lookup returned no usable result.') };
            }
            const target = path.isAbsolute(input.targetFile)
                ? path.resolve(input.targetFile)
                : path.resolve(this.deps.workspaceRoot, input.targetFile);
            const normalize = (value: string): string => {
                const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.deps.workspaceRoot, value);
                return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
            };
            const inbound = references.find(reference => normalize(reference.file) !== normalize(target));
            if (inbound) {
                const sourceFile = path.isAbsolute(inbound.file)
                    ? inbound.file
                    : path.resolve(this.deps.workspaceRoot, inbound.file);
                return {
                    ...base,
                    status: 'verified',
                    sources: [this.makeSource(
                        'project.queryReferences',
                        `${inbound.file}:${inbound.line ?? -1}`,
                        `file:${statRevision(sourceFile)};index:${this.deps.getIndexRevision?.() ?? 'unavailable'}`,
                    )],
                    detail: this.joinDetail(base.detail, `Inbound reference found at ${inbound.file}:${(inbound.line ?? -1) + 1}.`),
                };
            }
            return {
                ...base,
                status: 'unknown',
                sources: [this.makeSource(
                    'project.queryReferences',
                    entryId,
                    `index:${this.deps.getIndexRevision?.() ?? 'unavailable'}`,
                )],
                detail: this.joinDetail(base.detail, `No inbound call site for triggered-only event '${entryId}' is indexed yet. A dependent Agent may create it later; final task validation must confirm the planned edge.`),
            };
        } catch (error) {
            return {
                ...base,
                detail: this.joinDetail(base.detail, `Project reference lookup failed: ${error instanceof Error ? error.message : String(error)}`),
            };
        }
    }

    private buildMissingEvidence(claims: EvidenceClaim[], input: EvidenceGateEvaluateInput): EvidenceMissingItem[] {
        const missing: EvidenceMissingItem[] = [];
        for (const claim of claims) {
            if (!claim.blocking || claim.status === 'verified') continue;
            if (missing.length >= MAX_MISSING_ITEMS) break;
            missing.push({
                kind: claim.kind,
                claim: claim.claim,
                status: claim.status,
                suggestedQueries: this.suggestedQueriesFor(claim, input),
            });
        }
        return missing;
    }

    private suggestedQueriesFor(claim: EvidenceClaim, input: EvidenceGateEvaluateInput): string[] {
        const nameMatch = /'([^']+)'/.exec(claim.claim);
        const name = nameMatch?.[1];
        switch (claim.kind) {
            case 'syntax_shape':
                return ['parse_pdx_fragment({ code: <the fragment you tried to write> }) and fix the reported syntax errors'];
            case 'scope_compatibility':
                return name
                    ? [`query_rules({ name: '${name}' }) to list supported scopes`, `query_scope() to confirm the enclosing scope chain of ${input.targetFile}`]
                    : ['query_scope() to confirm the enclosing scope chain'];
            case 'symbol_exists':
                return name
                    ? [`query_rules({ name: '${name}' }) for exact effect/trigger/modifier names and scopes`]
                    : ['query_rules({}) to browse available effects/triggers/modifiers'];
            case 'reference_exists':
                return name
                    ? [`verify_pdx_identifier({ identifier: '${name}' })`, `query_workspace_index({ name: '${name}', exact: true })`]
                    : ['verify_pdx_identifier({ identifier: <id> })'];
            case 'call_chain':
                return ['explore_pdx_project({ query: <entry point> }) to inspect real call sites and reference direction'];
            case 'design_choice':
                return [];
        }
    }

    private joinDetail(existing: string | undefined, addition: string): string {
        return existing ? `${existing} ${addition}` : addition;
    }
}
