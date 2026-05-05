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
    s = s.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
    s = s.replace(/[\u0000-\u001F]/g, (match) => {
        if (match === '\n') return '\\n';
        if (match === '\r') return '\\r';
        if (match === '\t') return '\\t';
        return ''; // Strip other control characters
    });

    // Strategy 0b: Truncated before array/object value even starts
    // e.g., {"filePath": "...", "entries":  → close with empty array/object
    // Match pattern: ends with a property name colon and optional whitespace
    if (/:\s*$/.test(s)) {
        // Try closing as empty array (common for entries, edits, etc.)
        try { return JSON.parse(s + '[]}'); } catch { /* skip */ }
        try { return JSON.parse(s + '""}'  ); } catch { /* skip */ }
        try { return JSON.parse(s + 'null}'); } catch { /* skip */ }
    }

    // Strategy 1: Missing closing brackets (common in truncation)
    try { return JSON.parse(s + '"}'); } catch { /* skip */ }
    try { return JSON.parse(s + ']}'); } catch { /* skip */ }
    try { return JSON.parse(s + '}'); } catch { /* skip */ }

    // Strategy 1b: Truncated nested arrays (common with multiedit edits:[...] / write_localisation entries:[...])
    for (const suffix of ['"}]}', '"}}', '"]}}', '"}]', '}]', ']}', ']}}', '"}]]}']) {
        try { return JSON.parse(s + suffix); } catch { /* skip */ }
    }

    // Strategy 1c: Truncated mid-array-item — find the last complete item and close
    // This handles: {"entries": [{"key":"a","value":"b"},{"key":"c","val
    const lastCompleteItem = s.lastIndexOf('},');
    if (lastCompleteItem > 0) {
        // Try closing at the last complete item boundary
        try { return JSON.parse(s.substring(0, lastCompleteItem + 1) + ']}'); } catch { /* skip */ }
        try { return JSON.parse(s.substring(0, lastCompleteItem + 1) + ']}}'); } catch { /* skip */ }
    }
    // Also try closing at the last complete object (without trailing comma)
    // This handles: {"entries": [{"key":"a","value":"b"}
    const lastCloseBrace = s.lastIndexOf('}');
    const lastOpenBracket = s.lastIndexOf('[');
    if (lastCloseBrace > lastOpenBracket && lastOpenBracket > 0) {
        try { return JSON.parse(s.substring(0, lastCloseBrace + 1) + ']}'); } catch { /* skip */ }
    }

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
