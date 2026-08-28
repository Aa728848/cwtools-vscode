/**
 * CWTools AI Module — Tool Argument Repair
 *
 * Performs semantic-level repairs on parsed tool call arguments:
 * 1. Fuzzy parameter name matching (typo correction)
 * 2. Type coercion (string → number, string → boolean)
 * 3. Required parameter inference from context
 */

import { TOOL_DEFINITIONS } from './definitions';

/** Known parameter name aliases across tools */
const PARAM_ALIASES: Record<string, string> = {
    'filepath': 'filePath',
    'file_path': 'filePath',
    'target_file': 'TargetFile',
    'targetfile': 'TargetFile',
    'filename': 'file',
    'file_name': 'file',
    'start_line': 'startLine',
    'end_line': 'endLine',
    'startline': 'startLine',
    'endline': 'endLine',
    'old_string': 'oldString',
    'new_string': 'newString',
    'oldstring': 'oldString',
    'newstring': 'newString',
    'replace_all': 'replaceAll',
    'case_sensitive': 'caseSensitive',
    'is_regex': 'isRegex',
    'search_context': 'searchContext',
    'file_extension': 'fileExtension',
    'file_extensions': 'fileExtensions',
    'exact_match': 'exactMatch',
    'type_name': 'typeName',
    'typename': 'typeName',
};

export interface ArgRepairResult {
    /** The repaired arguments object */
    args: Record<string, unknown>;
    /** Whether any repairs were made */
    repaired: boolean;
    /** Human-readable list of repairs applied */
    repairs: string[];
}

/**
 * Attempt to repair tool call arguments against the tool's JSON Schema.
 * Returns the repaired args and a list of repairs made.
 */
export function repairToolArgs(
    toolName: string,
    rawArgs: Record<string, unknown>
): ArgRepairResult {
    const repairs: string[] = [];
    const args = { ...rawArgs };

    // Find the tool's parameter schema
    const toolDef = TOOL_DEFINITIONS.find(
        t => t.function.name === toolName
    );
    if (!toolDef) return { args, repaired: false, repairs };

    const schema = toolDef.function.parameters as {
        properties?: Record<string, { type?: string; enum?: string[] }>;
        required?: string[];
    };
    if (!schema?.properties) return { args, repaired: false, repairs };

    const schemaProps = schema.properties;
    const schemaKeys = new Set(Object.keys(schemaProps));

    // ── Pass 1: Fuzzy name matching ──
    for (const [key, value] of Object.entries(args)) {
        if (schemaKeys.has(key)) continue;  // Exact match, no repair needed

        // Check alias table
        const alias = PARAM_ALIASES[key.toLowerCase()];
        if (alias && schemaKeys.has(alias)) {
            args[alias] = value;
            delete args[key];
            repairs.push(`Renamed '${key}' → '${alias}'`);
            continue;
        }

        // Levenshtein distance fallback (threshold ≤ 2)
        let bestMatch: string | null = null;
        let bestDist = Infinity;
        for (const schemaKey of schemaKeys) {
            const dist = levenshtein(key.toLowerCase(), schemaKey.toLowerCase());
            if (dist < bestDist && dist <= 2) {
                bestDist = dist;
                bestMatch = schemaKey;
            }
        }
        if (bestMatch) {
            args[bestMatch] = value;
            delete args[key];
            repairs.push(`Fuzzy-matched '${key}' → '${bestMatch}' (distance=${bestDist})`);
        }
    }

    // ── Pass 2: Type coercion ──
    for (const [key, value] of Object.entries(args)) {
        const propSchema = schemaProps[key];
        if (!propSchema?.type) continue;

        if (propSchema.type === 'number' || propSchema.type === 'integer') {
            if (typeof value === 'string') {
                const num = Number(value);
                if (!isNaN(num)) {
                    args[key] = propSchema.type === 'integer' ? Math.floor(num) : num;
                    repairs.push(`Coerced '${key}': string → ${propSchema.type}`);
                }
            }
        } else if (propSchema.type === 'boolean') {
            if (typeof value === 'string') {
                if (value.toLowerCase() === 'true') { args[key] = true; repairs.push(`Coerced '${key}': "true" → true`); }
                else if (value.toLowerCase() === 'false') { args[key] = false; repairs.push(`Coerced '${key}': "false" → false`); }
            }
        }
    }

    // Some providers materialize omitted numeric fields as zero. For read_file,
    // zero is invalid for the 1-based range but centerLine=0 is meaningful.
    if (toolName === 'read_file' && args.centerLine !== undefined) {
        for (const key of ['startLine', 'endLine'] as const) {
            if (args[key] !== 0) continue;
            delete args[key];
            repairs.push(`Removed zero placeholder '${key}' because centerLine selects the read window`);
        }
    }

    return { args, repaired: repairs.length > 0, repairs };
}

/** Simple Levenshtein distance for short strings */
function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];
    for (let i = 0; i <= a.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= b.length; j++) { matrix[0]![j] = j; }
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i]![j] = Math.min(
                matrix[i - 1]![j]! + 1,
                matrix[i]![j - 1]! + 1,
                matrix[i - 1]![j - 1]! + cost
            );
        }
    }
    return matrix[a.length]![b.length]!;
}
