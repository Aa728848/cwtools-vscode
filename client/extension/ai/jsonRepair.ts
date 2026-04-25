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
    let startIdx = s.indexOf('{');
    let endIdx = s.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        try {
            return JSON.parse(s.substring(startIdx, endIdx + 1));
        } catch { /* skip */ }
    }

    // Strategy 4: Handle aggressive string truncation where a property value is cut off
    if (startIdx !== -1) {
        let lastQuote = s.lastIndexOf('"');
        if (lastQuote > startIdx) {
            try {
                return JSON.parse(s.substring(startIdx, lastQuote) + '"}');
            } catch { /* skip */ }
        }
        let lastComma = s.lastIndexOf(',');
        if (lastComma > startIdx) {
            try {
                return JSON.parse(s.substring(startIdx, lastComma) + '}');
            } catch { /* skip */ }
        }
    }

    return null;
}
