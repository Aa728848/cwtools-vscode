/**
 * OpenCode Replacer Suite — 8 fuzzy-match strategies for string replacement.
 *
 * Extracted from FileToolHandler for independent testability.
 * Ported from: opencode/packages/opencode/src/tool/edit.ts
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
    if (!a.length || !b.length) return Math.max(a.length, b.length);
    if (a.length < b.length) { const t = a; a = b; b = t; }
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    let curr = new Array<number>(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const c = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + c);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[b.length]!;
}

// ─── Strategy generators ────────────────────────────────────────────────────

/** Strip BOM, normalize CRLF, and normalize common unicode variants (full-width ↔ half-width) */
function unicodeNormalize(s: string): string {
    return s
        .replace(/\uFEFF/g, '')                    // BOM
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n') // CRLF
        .replace(/\u00A0/g, ' ')                    // NBSP → space
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // smart quotes → ASCII
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // smart single quotes
        .replace(/\u2026/g, '...')                  // ellipsis
        .replace(/[\u2013\u2014]/g, '-')            // en/em dash
        .replace(/\uFF1A/g, ':')                    // full-width colon
        .replace(/\uFF08/g, '(').replace(/\uFF09/g, ')') // full-width parens
        .replace(/\uFF0C/g, ',')                    // full-width comma
        .replace(/\u3001/g, ',');                   // ideographic comma
}

function* unicodeNormalizedReplacer(content: string, find: string): Generator<string> {
    const nC = unicodeNormalize(content), nF = unicodeNormalize(find);
    if (nC === content && nF === find) return; // no unicode differences — skip
    const idx = nC.indexOf(nF);
    if (idx === -1) return;
    // Map normalized offset back to original offset
    // Since we only collapse multi-byte → single-byte, find boundary by scanning
    yield content.substring(idx, idx + nF.length);
    // Fallback: if substring doesn't match exactly, try line-based matching
    const nFL = nF.split('\n'), cL = content.split('\n'), ncL = nC.split('\n');
    for (let i = 0; i <= ncL.length - nFL.length; i++) {
        if (ncL.slice(i, i + nFL.length).join('\n') === nF) {
            yield cL.slice(i, i + nFL.length).join('\n');
        }
    }
}

function* simpleReplacer(_c: string, find: string): Generator<string> { yield find; }

function* lineTrimmedReplacer(content: string, find: string): Generator<string> {
    const oL = content.split('\n'), sL = find.split('\n');
    if (sL[sL.length - 1] === '') sL.pop();
    for (let i = 0; i <= oL.length - sL.length; i++) {
        if (sL.every((s, j) => oL[i + j]!.trim() === s.trim())) {
            let st = 0; for (let k = 0; k < i; k++) st += oL[k]!.length + 1;
            let en = st; for (let k = 0; k < sL.length; k++) { en += oL[i + k]!.length; if (k < sL.length - 1) en += 1; }
            yield content.substring(st, en);
        }
    }
}

function* blockAnchorReplacer(content: string, find: string): Generator<string> {
    const oL = content.split('\n'), sL = find.split('\n');
    if (sL.length < 3) return;
    if (sL[sL.length - 1] === '') sL.pop();
    const first = sL[0]!.trim(), last = sL[sL.length - 1]!.trim();
    const cands: { s: number; e: number }[] = [];
    for (let i = 0; i < oL.length; i++) {
        if (oL[i]!.trim() !== first) continue;
        for (let j = i + 2; j < oL.length; j++) { if (oL[j]!.trim() === last) { cands.push({ s: i, e: j }); break; } }
    }
    if (!cands.length) return;
    const score = (s: number, e: number) => {
        const check = Math.min(sL.length - 2, e - s - 1);
        if (check <= 0) return 1.0;
        let sim = 0;
        for (let j = 1; j < sL.length - 1 && j < e - s; j++) {
            const mx = Math.max(oL[s + j]!.trim().length, sL[j]!.trim().length);
            if (mx) sim += (1 - levenshtein(oL[s + j]!.trim(), sL[j]!.trim()) / mx) / check;
        }
        return sim;
    };
    const extract = (s: number, e: number) => {
        let st = 0; for (let k = 0; k < s; k++) st += oL[k]!.length + 1;
        let en = st; for (let k = s; k <= e; k++) { en += oL[k]!.length; if (k < e) en += 1; }
        return content.substring(st, en);
    };
    if (cands.length === 1) { if (score(cands[0]!.s, cands[0]!.e) >= 0) yield extract(cands[0]!.s, cands[0]!.e); return; }
    let best = cands[0]!, bestSim = -1;
    for (const { s, e } of cands) { const sim = score(s, e); if (sim > bestSim) { bestSim = sim; best = { s, e }; } }
    if (bestSim >= 0.3) yield extract(best.s, best.e);
}

function* whitespaceNormalizedReplacer(content: string, find: string): Generator<string> {
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
    const nF = norm(find), lns = content.split('\n'), fL = find.split('\n');
    if (fL.length === 1) { for (const l of lns) { if (norm(l) === nF) yield l; } return; }
    for (let i = 0; i <= lns.length - fL.length; i++)
        if (norm(lns.slice(i, i + fL.length).join('\n')) === nF) yield lns.slice(i, i + fL.length).join('\n');
}

function* indentationFlexibleReplacer(content: string, find: string): Generator<string> {
    const strip = (text: string) => {
        const lns = text.split('\n'), ne = lns.filter(l => l.trim().length > 0);
        if (!ne.length) return text;
        const min = Math.min(...ne.map(l => { const m = l.match(/^(\s*)/); return m ? m[1]!.length : 0; }));
        return lns.map(l => l.trim().length === 0 ? l : l.slice(min)).join('\n');
    };
    const nF = strip(find), lns = content.split('\n'), fL = find.split('\n');
    for (let i = 0; i <= lns.length - fL.length; i++) {
        const b = lns.slice(i, i + fL.length).join('\n');
        if (strip(b) === nF) yield b;
    }
}

function* escapeNormalizedReplacer(content: string, find: string): Generator<string> {
    const un = (s: string) => s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_m, c: string) =>
        ({ n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '\n': '\n', '$': '$' }[c] ?? _m));
    const uF = un(find);
    if (content.includes(uF)) { yield uF; return; }
    const lns = content.split('\n'), fL = uF.split('\n');
    if (fL.length > 1) for (let i = 0; i <= lns.length - fL.length; i++) {
        const b = lns.slice(i, i + fL.length).join('\n');
        if (un(b) === uF) yield b;
    }
}

function* trimmedBoundaryReplacer(content: string, find: string): Generator<string> {
    const trimmed = find.trim();
    if (trimmed === find) return;
    if (content.includes(trimmed)) { yield trimmed; return; }
    const lns = content.split('\n'), fL = find.split('\n');
    for (let i = 0; i <= lns.length - fL.length; i++) {
        const b = lns.slice(i, i + fL.length).join('\n');
        if (b.trim() === trimmed) yield b;
    }
}

function* contextAwareReplacer(content: string, find: string): Generator<string> {
    const fL = find.split('\n');
    if (fL.length < 3) return;
    if (fL[fL.length - 1] === '') fL.pop();
    const cL = content.split('\n');
    const fl = fL[0]!.trim(), ll = fL[fL.length - 1]!.trim();
    for (let i = 0; i < cL.length; i++) {
        if (cL[i]!.trim() !== fl) continue;
        for (let j = i + 2; j < cL.length; j++) {
            if (cL[j]!.trim() !== ll) continue;
            const b = cL.slice(i, j + 1);
            if (b.length !== fL.length) break;
            let hit = 0, tot = 0;
            for (let k = 1; k < b.length - 1; k++) {
                if (b[k]!.trim().length || fL[k]!.trim().length) { tot++; if (b[k]!.trim() === fL[k]!.trim()) hit++; }
            }
            if (tot === 0 || hit / tot >= 0.5) { yield b.join('\n'); break; }
            break;
        }
    }
}

// ─── Main replace function ──────────────────────────────────────────────────

const REPLACERS = [
    simpleReplacer,
    unicodeNormalizedReplacer,
    lineTrimmedReplacer,
    blockAnchorReplacer,
    whitespaceNormalizedReplacer,
    indentationFlexibleReplacer,
    escapeNormalizedReplacer,
    trimmedBoundaryReplacer,
    contextAwareReplacer,
] as const;

/**
 * Try each of the 8 Replacers in order, first match wins.
 * Throws if no strategy can find oldString in content.
 */
export function fuzzyReplace(content: string, oldString: string, newString: string, replaceAll: boolean): string {
    if (oldString === newString) throw new Error('oldString and newString are identical — no change needed');
    for (const replacer of REPLACERS) {
        for (const search of replacer(content, oldString)) {
            const idx = content.indexOf(search);
            if (idx === -1) continue;
            if (replaceAll) return search.length > 0 ? content.split(search).join(newString) : content;
            const lastIdx = content.lastIndexOf(search);
            if (idx !== lastIdx) throw new Error(
                'Multiple matches found. Provide more context in oldString to make it unique, or use replaceAll=true.'
            );
            return content.substring(0, idx) + newString + content.substring(idx + search.length);
        }
    }
    throw new Error(
        'Content not found. Do NOT omit context or use "..." in oldString! Include the full text from start to end of the replacement, ensuring whitespace matches exactly.\n' +
        'Tip: use read_file first to get the exact text, then provide an identical fragment in oldString.'
    );
}
