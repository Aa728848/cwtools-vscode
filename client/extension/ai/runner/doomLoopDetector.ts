/**
 * CWTools AI Module — Doom Loop Detector
 * 
 * Protects the reasoning loop from redundant iteration cycles (hallucinations,
 * repeating the same tools with the same args or results) using light-weight FNV hashing
 * and semantic result normalization.
 */

export const DOOM_LOOP_SOFT_THRESHOLD = 4;
export const DOOM_LOOP_PAIR_THRESHOLD = 6;

/**
 * Lightweight 32-bit FNV-1a hash for normalized tool result comparison.
 */
export function fnv32a(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) | 0;
    }
    return hash >>> 0;
}

/**
 * Normalize a tool result to a hashable key, extracting only semantically
 * meaningful fields (stripping positional info like line/column numbers).
 */
export function normalizeToolResultHash(toolName: string, result: unknown): string {
    if (result === null || result === undefined) return String(result);
    if (typeof result !== 'object') return String(result).substring(0, 256);

    const obj = result as Record<string, unknown>;
    // read_file → hash file content
    if (toolName === 'read_file' && typeof obj.content === 'string') {
        return `read_file:${obj.file ?? ''}:${obj.content.length}`;
    }
    // multi_replace_file_content / write_file → hash written content
    if ((toolName === 'multi_replace_file_content' || toolName === 'write_file') && typeof obj.content === 'string') {
        return `write:${obj.filePath ?? obj.file ?? obj.TargetFile ?? ''}:${obj.content.length}`;
    }
    // query_scope → hash scope chain
    if (toolName === 'query_scope') {
        return `scope:${JSON.stringify(obj.currentScope ?? '')}:${JSON.stringify(obj.thisScope ?? '')}`;
    }
    // get_diagnostics → hash summary counts
    if (toolName === 'get_diagnostics' && obj.summary) {
        return `diag:${JSON.stringify(obj.summary)}`;
    }
    // lsp_operation → hash the returned structure (exclude positions)
    if (toolName === 'lsp_operation') {
        const stripped = JSON.stringify(obj, (key, val) =>
            (key === 'line' || key === 'column' || key === 'character' || key === 'offset') ? undefined : val
        );
        return `lsp:${stripped.substring(0, 256)}`;
    }
    // Generic fallback: first 256 chars of JSON
    return `${toolName}:${JSON.stringify(obj).substring(0, 256)}`;
}
