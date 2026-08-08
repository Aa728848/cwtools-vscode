/**
 * Blackboard write validation.
 *
 * The blackboard is shared, untrusted storage: any sub-agent write lands in
 * the same map the quality gate, conflict detector, and dependency handoffs
 * read from. Every structured entry type therefore validates value shape and
 * key-prefix consistency at write time, so malformed entries are rejected
 * instead of silently corrupting downstream consumers.
 *
 * Semantic shapes are intentionally NOT unified here (e.g. entity_registry is
 * written by both the conflict detector and the contract layer with different
 * key structures) — the key prefixes disambiguate meaning. This layer enforces
 * syntactic integrity, bounded size, and type/key agreement only.
 */

import type { BlackboardEntryType } from './types';

const MAX_FREE_TEXT_CHARS = 512 * 1024;
const MAX_STRUCTURED_CHARS = 64 * 1024;
const MAX_EVIDENCE_CHARS = 512 * 1024;
const MAX_PATH_CHARS = 4096;

/** Canonical key prefixes for structured blackboard entries (wire format). */
export const BLACKBOARD_KEY_PREFIXES = {
    handoff: '__handoff:',
    entity: '__entity:',
    relation: '__relation:',
    intent: '__intent:',
    clarification: 'orchestrator:clarification:',
    qualityGate: '__quality_gate:',
    orchestratorResult: 'orchestrator:lastResult',
} as const;

interface TypeRule {
    /** Value must be non-empty and within this character bound. */
    maxChars?: number;
    /** Value must parse as a JSON value (object/array/number/bool). */
    requireJson?: boolean;
    /** Key must start with one of these prefixes. */
    keyPrefixes?: readonly string[];
}

const TYPE_RULES: Record<BlackboardEntryType, TypeRule> = {
    free_text: { maxChars: MAX_FREE_TEXT_CHARS },
    write_intent: { maxChars: MAX_PATH_CHARS, keyPrefixes: [BLACKBOARD_KEY_PREFIXES.intent] },
    entity_registry: { maxChars: MAX_STRUCTURED_CHARS, keyPrefixes: [BLACKBOARD_KEY_PREFIXES.entity] },
    entity_relation: { maxChars: MAX_STRUCTURED_CHARS, keyPrefixes: [BLACKBOARD_KEY_PREFIXES.relation] },
    acceptance_evidence: { maxChars: MAX_EVIDENCE_CHARS, requireJson: true, keyPrefixes: [BLACKBOARD_KEY_PREFIXES.qualityGate] },
    file_snapshot: { maxChars: MAX_STRUCTURED_CHARS, requireJson: true },
    scope_info: { maxChars: MAX_STRUCTURED_CHARS, requireJson: true },
    diag_result: { maxChars: MAX_STRUCTURED_CHARS, requireJson: true },
};

function isJsonValue(value: string): boolean {
    try {
        JSON.parse(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Validate a pending blackboard write. Returns an error message when the
 * entry would be malformed, or undefined when it may be written.
 */
export function validateBlackboardWrite(
    type: BlackboardEntryType,
    key: string,
    value: string,
): string | undefined {
    if (typeof key !== 'string' || key.length === 0) return 'key must be a non-empty string';
    if (typeof value !== 'string') return 'value must be a string';

    const rule = TYPE_RULES[type];
    if (!rule) return `unknown blackboard entry type '${type}'`;

    if (rule.keyPrefixes && !rule.keyPrefixes.some(prefix => key.startsWith(prefix))) {
        return `key '${key.slice(0, 80)}' does not match the '${type}' prefix (${rule.keyPrefixes.join(' or ')})`;
    }

    if (value.length === 0 && type !== 'free_text') {
        return `'${type}' entries require a non-empty value`;
    }
    if (rule.maxChars !== undefined && value.length > rule.maxChars) {
        return `'${type}' value exceeds ${rule.maxChars} characters`;
    }
    if (rule.requireJson && !isJsonValue(value)) {
        return `'${type}' value must be valid JSON`;
    }
    return undefined;
}
