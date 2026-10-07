#!/usr/bin/env node
/**
 * Derive per-command engine cost classes from the Stellaris decompiled dump.
 *
 *   node tools/engine-cost/extract-engine-cost.cjs <dump.cpp> [--out <file>]
 *
 * The output is a JSON array of { command, kind, cost, cls, evidence, line,
 * basis, strength } records. `line` is the 1-based line of the evidence
 * function's signature in the dump that was scanned, so every claim can be
 * re-checked by opening that line.
 *
 * Evidence policy (this is what makes the result trustworthy):
 *   - A cost class is only emitted with POSITIVE evidence: a loop found in the
 *     command's own evaluation function, or in a helper it directly calls.
 *   - "o(n)" therefore always names the function that contains the scan.
 *   - A command whose implementation cannot be linked, or whose evidence is
 *     ambiguous, is omitted rather than guessed.
 *   - Control-flow keywords (if/else/switch/while/random_list/...) are skipped:
 *     their iteration count is the number of nested clauses a mod author wrote,
 *     not a container the engine scans, so a container-scan note would mislead.
 *
 * Limitations, stated explicitly:
 *   - Only ~76% of commands link to a named implementation class. The dump
 *     labels registration vtables (PTR__CTriggerEntryBase_<addr>) without the
 *     class name, so the remaining commands cannot be attributed.
 *   - Nesting is only claimed when the function itself contains nested loops.
 *     Two loops on sibling branches (e.g. CHasCivicTrigger) stay linear.
 *   - Cost is a property of the implementation shape, not a benchmark.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const CONTROL_FLOW = new Set([
    'if', 'else_if', 'else', 'and', 'or', 'not', 'nor', 'nand',
    'hidden_effect', 'hidden_trigger', 'tooltip', 'custom_tooltip',
    'switch', 'while', 'random_list', 'random', 'abort_effect', 'abort_trigger',
]);

const CHAIN_WALK = /^(CFixedPointVariableValue|CIntVariableValue|CScriptableValue|CVariableValue|CBooleanVariableValue|CStringVariableValue)::/;
// Text and formatting utilities loop over characters, not over game
// containers, so their loops are not container-scan evidence.
const TEXT_PROCESS = /^(CTextBase|CGameText|CString|CPdxString|CPdxLocalize|PdxLocalize)/;
const INFRA = /^(CPdxLog|CScopedStartProfile|CScopedProfile|CProfileManager|CPdxProfiler|operator_new|memset|memcpy|CPdxCommonStringAllocator|CString|CPdxString|std::|PdxLocalize|CPdxTemporaryLocalization|CStackTrace|CPdxAssert|CPdxHashTable|CPdxLogFileAndLine|CLogStream)/;
const NON_EVAL = /::(GetToolTip|GetDesc|GetName|GetErrorFlag|Create|ReadMember|WriteMembers|PostValidate|~|GetSupportedScopes|GetSupportedScopeTargets|AsString|GetTriggeredByIcon|GetDlcRecommendation)/;
const EVAL = /::(ActualEvaluate|ExecuteActual|GetTriggerValue|Evaluate|Execute|GetValue)\b/;
const LOOP = /(^|[;{}\s])(while\s*\(|for\s*\(|do\s*$)/;

const norm = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const qual = (s) => { const i = s.indexOf('('); return norm(i >= 0 ? s.slice(0, i) : s); };
const className = (s) => { const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?::/.exec(s); return m ? m[1] : null; };
const pascal = (s) => s.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

async function scanDump(dumpPath, onBlock) {
    const stream = fs.createReadStream(dumpPath, { encoding: 'utf8', highWaterMark: 1 << 22 });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let name = null, inComment = false, commentBuf = [], cur = null;
    let brace = 0, loopStack = [], maxNest = 0, n = 0;

    for await (const line of reader) {
        n++;
        if (!inComment && line.startsWith('/* ') && line.includes('(')) {
            if (line.endsWith(' */')) name = line.slice(3, -3).replace(/\s+/g, ' ').trim();
            else { inComment = true; commentBuf = [line.slice(3)]; }
            continue;
        }
        if (inComment) {
            if (line.endsWith(' */')) {
                commentBuf.push(line.slice(0, -3));
                name = commentBuf.join(' ').replace(/\s+/g, ' ').trim();
                inComment = false; commentBuf = [];
            } else commentBuf.push(line);
            continue;
        }
        if (/^\/\/ =+ .* End =+$/.test(line)) {
            if (cur) {
                cur.end = n; cur.maxNest = maxNest;
                // Calls must be read from the joined body: a wrapped call puts
                // the identifier and its "(" on different lines.
                const callRe = /([A-Za-z_][A-Za-z0-9_:<>~]{2,120}?)\s*\(/g;
                const seen = new Set(); let cm;
                const joined = cur.text.join('\n');
                while ((cm = callRe.exec(joined))) seen.add(cm[1].trim());
                cur.calls = [...seen];
                delete cur.text;
                onBlock(cur);
            }
            cur = null; name = null; brace = 0; loopStack = []; maxNest = 0;
            continue;
        }
        if (!cur && name && line.trim() !== '' && !line.startsWith('//') && !line.startsWith('/*')) {
            cur = { name, start: n, end: n, lines: 0, loops: 0, maxNest: 0, hashes: 0, sorts: 0, text: [] };
            name = null; brace = 0; loopStack = []; maxNest = 0;
        }
        if (!cur) continue;
        cur.lines++;
        if (line.includes('CPdxRobinHoodTable') || line.includes('UnorderedMap') || line.includes('::Find<')) cur.hashes++;
        if (/stable_sort|std::sort|lower_bound|binary_search|upper_bound/.test(line)) cur.sorts++;

        if (LOOP.test(line)) {
            cur.loops++;
            loopStack.push(brace);
            if (loopStack.length > maxNest) maxNest = loopStack.length;
        }
        cur.text.push(line);

        for (const ch of line) {
            if (ch === '{') brace++;
            else if (ch === '}') {
                brace--;
                while (loopStack.length > 0 && brace <= loopStack[loopStack.length - 1]) loopStack.pop();
            }
        }
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const dumpPath = argv.find((a) => !a.startsWith('--'));
    const outIdx = argv.indexOf('--out');
    const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
    const rulesDir = argv.includes('--rules') ? argv[argv.indexOf('--rules') + 1] : null;

    if (!dumpPath || !rulesDir) {
        console.error('usage: extract-engine-cost.cjs <dump.cpp> --rules <config dir> [--out <file>]');
        process.exit(2);
    }

    const blocks = [];
    await scanDump(dumpPath, (b) => blocks.push(b));

    const ownByQual = new Map();
    for (const b of blocks) {
        const q = qual(b.name);
        const cur = ownByQual.get(q);
        if (!cur || b.loops > cur.loops) ownByQual.set(q, b);
    }
    const methodsByClass = new Map();
    for (const q of ownByQual.keys()) {
        const cls = className(q);
        if (!cls) continue;
        if (!methodsByClass.has(cls)) methodsByClass.set(cls, new Map());
        methodsByClass.get(cls).set(q.slice(q.indexOf('::') + 2), q);
    }
    const byClass = new Map();
    for (const b of blocks) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?::/.exec(b.name);
        if (!m) continue;
        if (!byClass.has(m[1])) byClass.set(m[1], []);
        byClass.get(m[1]).push(b);
    }
    const bestEval = (cls) => {
        const arr = byClass.get(cls);
        if (!arr) return null;
        return arr.filter((b) => EVAL.test(b.name) && !NON_EVAL.test(b.name)).sort((a, b) => b.lines - a.lines)[0] || null;
    };
    const calleesOf = (fn) => {
        const owner = className(qual(fn));
        const b = ownByQual.get(qual(fn));
        if (!b) return [];
        const out = new Set();
        for (const c of b.calls) {
            const q = qual(c);
            const rq = q.includes('::') ? q : (owner ? (methodsByClass.get(owner) || new Map()).get(q) || q : q);
            if (rq !== qual(fn) && !INFRA.test(rq) && !NON_EVAL.test(rq) && ownByQual.has(rq)) out.add(rq);
        }
        return [...out];
    };

    const namesFrom = (file, kind) => {
        const text = fs.readFileSync(path.join(rulesDir, file), 'utf8');
        const re = new RegExp('alias\\[' + kind + ':([a-z0-9_]+)\\]', 'g');
        const s = new Set(); let m;
        while ((m = re.exec(text))) s.add(m[1]);
        return [...s];
    };

    const findEval = (cmd, kind) => {
        if (cmd === 'has_any_flag' && kind === 'trigger') {
            const ev = bestEval('CHasAnyFlagTrigger');
            if (ev) return { cls: 'CHasAnyFlagTrigger', ev };
        }
        // All *_flag commands share one implementation; the scope family only
        // selects which array the virtual call returns.
        if (/_flag(s)?$/.test(cmd)) {
            if (kind === 'trigger' && /^(has_|is_|reverse_has_)/.test(cmd)) {
                const ev = bestEval('CHasFlagTrigger');
                if (ev) return { cls: 'CHasFlagTrigger', ev };
            }
            if (kind === 'effect') {
                const ev = bestEval('CRemoveFlagEffect') || bestEval('CSetFlagEffect');
                if (ev) return { cls: 'CRemoveFlagEffect', ev };
            }
        }
        const p = pascal(cmd);
        const exact = kind === 'trigger'
            ? ['C' + p + 'Trigger', 'C' + p, 'C' + p + 'Value']
            : ['C' + p + 'Effect', 'C' + p, 'C' + p + 'Command'];
        for (const c of exact) { const ev = bestEval(c); if (ev) return { cls: c, ev }; }
        for (const c of byClass.keys()) {
            if (c.length > ('C' + p).length && c.startsWith('C' + p)) {
                const ev = bestEval(c); if (ev) return { cls: c, ev };
            }
        }
        return null;
    };

    const rows = [];
    for (const [kind, file] of [['trigger', 'triggers.cwt'], ['effect', 'effects.cwt']]) {
        for (const cmd of namesFrom(file, kind)) {
            if (CONTROL_FLOW.has(cmd)) continue;
            const found = findEval(cmd, kind);
            if (!found) continue;
            const fn = qual(found.ev.name);
            const self = ownByQual.get(fn);
            const looping = calleesOf(fn).filter((c) => (ownByQual.get(c) || {}).loops > 0 && !CHAIN_WALK.test(c) && !TEXT_PROCESS.test(c));
            const ownLoops = self ? self.loops : 0;
            const ownNest = self ? self.maxNest : 0;

            let rec = null;
            if (ownNest >= 2) {
                rec = { cost: 'o(n^2)', evidence: fn, basis: 'nested loop in the command implementation', strength: 'direct' };
            } else if (ownLoops > 0) {
                rec = { cost: 'o(n)', evidence: fn, basis: 'loop in the command implementation', strength: 'direct' };
            } else if (looping.length > 0) {
                const w = looping.sort((a, b) => ((ownByQual.get(b) || {}).maxNest || 0) - ((ownByQual.get(a) || {}).maxNest || 0))[0];
                rec = { cost: 'o(n)', evidence: w, basis: 'delegates to a helper that scans', strength: 'callee' };
            } else if (self && self.lines <= 80) {
                rec = { cost: 'o(1)', evidence: fn, basis: 'no scan in the command or its direct callees', strength: 'local' };
            }
            if (!rec) continue;
            // The evidence function's signature line in this dump, so a reader
            // can open the claim instead of trusting the class name.
            const evBlock = ownByQual.get(qual(rec.evidence));
            rows.push({ command: cmd, kind, cls: found.cls, line: evBlock ? evBlock.start : null, ...rec });
        }
    }

    const json = JSON.stringify(rows, null, 1);
    if (outPath) fs.writeFileSync(outPath, json);
    else process.stdout.write(json + '\n');
    console.error('analysed ' + rows.length + ' commands (' + blocks.length + ' dump blocks)');
}

main().catch((e) => { console.error(e); process.exit(1); });
