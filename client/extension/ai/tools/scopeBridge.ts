export const MAX_SCOPE_BRIDGE_HOPS = 4;
export const MAX_SCOPE_BRIDGE_CANDIDATES = 200;

export interface ScopeBridgeCandidate {
    name: string;
    supportedScopes: readonly string[];
    pushScope?: string;
    evidence?: string | readonly string[];
}

export interface ScopeBridgeInput {
    fromScope: string;
    toScope: string;
    candidates: readonly ScopeBridgeCandidate[];
}

export interface ScopeBridgeStep {
    name: string;
    fromScopes: string[];
    toScopes: string[];
    evidence: string[];
}

export interface ScopeBridgePath {
    rank: number;
    steps: ScopeBridgeStep[];
    confidence: number;
    evidence: string[];
}

export interface ScopeBridgeResult {
    paths: ScopeBridgePath[];
    confidence: number;
    evidence: string[];
}

interface NormalizedCandidate {
    name: string;
    supportedScopes: string[];
    pushScopes: string[];
    evidence: string[];
}

interface SearchNode {
    scopes: string[];
    steps: ScopeBridgeStep[];
    usedCandidates: Set<string>;
    usedUnion: boolean;
    usedAny: boolean;
}

const REJECTED_SCOPES = new Set(['', 'unknown', 'unresolved', 'none', 'null', 'undefined']);
const MAX_RETURNED_PATHS = 200;

/**
 * Finds evidence-backed scope transitions without consulting a registry or any
 * process state. Inputs are normalized so output is independent of candidate
 * order and spelling case.
 */
export function solveScopeBridge(input: ScopeBridgeInput): ScopeBridgeResult {
    if (!input || typeof input !== 'object' || !Array.isArray(input.candidates) || input.candidates.length > MAX_SCOPE_BRIDGE_CANDIDATES) return emptyResult();
    const fromScopes = parseScopes(input.fromScope);
    const toScopes = parseScopes(input.toScope);
    if (fromScopes.length === 0 || toScopes.length === 0 || !Array.isArray(input.candidates)) {
        return emptyResult();
    }

    if (scopesMatch(fromScopes, toScopes)) {
        const path: ScopeBridgePath = { rank: 1, steps: [], confidence: 1, evidence: [] };
        return { paths: [path], confidence: path.confidence, evidence: [] };
    }

    const candidates = input.candidates
        .map(normalizeCandidate)
        .filter((candidate): candidate is NormalizedCandidate => candidate !== undefined)
        .sort(compareCandidates)
        .slice(0, MAX_SCOPE_BRIDGE_CANDIDATES);

    let frontier: SearchNode[] = [{
        scopes: fromScopes,
        steps: [],
        usedCandidates: new Set<string>(),
        usedUnion: fromScopes.length > 1,
        usedAny: fromScopes.includes('any'),
    }];
    const found: SearchNode[] = [];

    for (let depth = 0; depth < MAX_SCOPE_BRIDGE_HOPS && frontier.length > 0; depth += 1) {
        const next: SearchNode[] = [];
        for (const node of frontier) {
            for (const candidate of candidates) {
                const candidateKey = candidateIdentity(candidate);
                if (node.usedCandidates.has(candidateKey)
                    || !scopesMatch(node.scopes, candidate.supportedScopes)) continue;

                const step: ScopeBridgeStep = {
                    name: candidate.name,
                    fromScopes: [...node.scopes],
                    toScopes: [...candidate.pushScopes],
                    evidence: [...candidate.evidence],
                };
                const usedCandidates = new Set(node.usedCandidates);
                usedCandidates.add(candidateKey);
                const child: SearchNode = {
                    scopes: candidate.pushScopes,
                    steps: [...node.steps, step],
                    usedCandidates,
                    usedUnion: node.usedUnion
                        || candidate.supportedScopes.length > 1
                        || candidate.pushScopes.length > 1,
                    usedAny: node.usedAny
                        || candidate.supportedScopes.includes('any')
                        || candidate.pushScopes.includes('any'),
                };
                if (scopesMatch(child.scopes, toScopes)) {
                    found.push(child);
                } else if (found.length < MAX_RETURNED_PATHS) {
                    next.push(child);
                }
            }
        }
        if (found.length > 0) break; // BFS: longer paths cannot outrank shortest paths.
        frontier = deduplicateNodes(next).slice(0, MAX_RETURNED_PATHS);
    }

    const paths = found
        .map(nodeToPath)
        .sort(comparePaths)
        .slice(0, MAX_RETURNED_PATHS)
        .map((path, index) => ({ ...path, rank: index + 1 }));
    const best = paths[0];
    return best
        ? { paths, confidence: best.confidence, evidence: [...best.evidence] }
        : emptyResult();
}

function normalizeCandidate(candidate: ScopeBridgeCandidate): NormalizedCandidate | undefined {
    if (!candidate || typeof candidate.name !== 'string' || !Array.isArray(candidate.supportedScopes)) return undefined;
    const name = candidate.name.trim();
    const parsedSupportedScopes = candidate.supportedScopes.map(parseScopes);
    if (parsedSupportedScopes.some(scopes => scopes.length === 0)) return undefined;
    const supportedScopes = uniqueSorted(parsedSupportedScopes.flat());
    const pushScopes = parseScopes(candidate.pushScope ?? '');
    const evidence = normalizeEvidence(candidate.evidence);
    if (!name || supportedScopes.length === 0 || pushScopes.length === 0 || evidence.length === 0) return undefined;
    return { name, supportedScopes, pushScopes, evidence };
}

function parseScopes(value: string): string[] {
    if (typeof value !== 'string') return [];
    const normalized = value.trim().toLowerCase().replace(/^union\s*[:(]\s*/, '').replace(/\)$/, '');
    const scopes = normalized
        .split(/\s*(?:\||,|\/)\s*/)
        .map(scope => scope.trim());
    if (scopes.some(scope => REJECTED_SCOPES.has(scope))) return [];
    return uniqueSorted(scopes);
}

function normalizeEvidence(value: ScopeBridgeCandidate['evidence']): string[] {
    const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    return uniqueSorted(entries
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean));
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function scopesMatch(left: readonly string[], right: readonly string[]): boolean {
    return left.includes('any') || right.includes('any') || left.some(scope => right.includes(scope));
}

function candidateIdentity(candidate: NormalizedCandidate): string {
    return [candidate.name.toLowerCase(), candidate.supportedScopes.join('|'), candidate.pushScopes.join('|'), candidate.evidence.join('|')].join('\u0000');
}

function compareCandidates(left: NormalizedCandidate, right: NormalizedCandidate): number {
    return candidateIdentity(left).localeCompare(candidateIdentity(right));
}

function deduplicateNodes(nodes: SearchNode[]): SearchNode[] {
    const sorted = [...nodes].sort((left, right) => nodeIdentity(left).localeCompare(nodeIdentity(right)));
    const seen = new Set<string>();
    return sorted.filter(node => {
        const key = nodeIdentity(node);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function nodeIdentity(node: SearchNode): string {
    return node.steps.map(step => [step.name.toLowerCase(), step.toScopes.join('|'), step.evidence.join('|')].join(':')).join('>');
}

function nodeToPath(node: SearchNode): ScopeBridgePath {
    const hopPenalty = Math.max(0, node.steps.length - 1) * 0.1;
    const unionPenalty = node.usedUnion ? 0.05 : 0;
    const anyPenalty = node.usedAny ? 0.15 : 0;
    const confidence = Math.max(0, Number((1 - hopPenalty - unionPenalty - anyPenalty).toFixed(2)));
    return {
        rank: 0,
        steps: node.steps.map(step => ({
            ...step,
            fromScopes: [...step.fromScopes],
            toScopes: [...step.toScopes],
            evidence: [...step.evidence],
        })),
        confidence,
        evidence: uniqueSorted(node.steps.flatMap(step => step.evidence)),
    };
}

function comparePaths(left: ScopeBridgePath, right: ScopeBridgePath): number {
    return right.confidence - left.confidence
        || left.steps.length - right.steps.length
        || pathIdentity(left).localeCompare(pathIdentity(right));
}

function pathIdentity(path: ScopeBridgePath): string {
    return path.steps.map(step => step.name.toLowerCase()).join('>');
}

function emptyResult(): ScopeBridgeResult {
    return { paths: [], confidence: 0, evidence: [] };
}
