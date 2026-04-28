/**
 * CWTools AI Module — JSON Repair
 *
 * Extracted from agentRunner.ts to reduce god-object complexity.
 * Attempts common JSON repairs for truncated or messy AI output.
 */

/**
 * Attempt common JSON repairs for truncated or messy AI output.
 * If successful, returns the parsed object. Otherwise returns null.
 */
export function tryRepairJson(badJson: string | undefined): Record<string, unknown> | null {
    if (!badJson) return null;
    let s = badJson.trim();

    // Strategy 0: Fix unescaped backslashes and literal control characters (e.g. Windows paths, raw newlines)
    s = s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    s = s.replace(/[\u0000-\u001F]/g, (match) => {
        if (match === '\n') return '\\n';
        if (match === '\r') return '\\r';
        if (match === '\t') return '\\t';
        return ''; // Strip other control characters
    });

    // Strategy 1: Missing closing brackets (common in truncation)
    try {
        const added = s + '"}';
        return JSON.parse(added);
    } catch { /* skip */ }

    try {
        const added = s + ']}';
        return JSON.parse(added);
    } catch { /* skip */ }

    try {
        const added = s + '}';
        return JSON.parse(added);
    } catch { /* skip */ }

    // Strategy 2: Remove trailing commas
    try {
        const noComma = s.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(noComma);
    } catch { /* skip */ }

    // Strategy 3: Try to find a valid JSON object within the string
    const startIdx = s.indexOf('{');
    const endIdx = s.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        try {
            return JSON.parse(s.substring(startIdx, endIdx + 1));
        } catch { /* skip */ }
    }

    // Strategy 4: Handle aggressive string truncation where a property value is cut off
    if (startIdx !== -1) {
        const lastQuote = s.lastIndexOf('"');
        if (lastQuote > startIdx) {
            try {
                return JSON.parse(s.substring(startIdx, lastQuote) + '"}');
            } catch { /* skip */ }
        }
        const lastComma = s.lastIndexOf(',');
        if (lastComma > startIdx) {
            try {
                return JSON.parse(s.substring(startIdx, lastComma) + '}');
            } catch { /* skip */ }
        }
    }

    return null;
}
