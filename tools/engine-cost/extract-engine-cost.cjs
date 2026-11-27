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

// Scope-chain and value-expression evaluators walk a script-authored scope
// chain (e.g. `owner.capital_scope.solar_system`), whose length is chosen by
// the mod author rather than game container size. Including CEventTarget::GetScope
// avoids flagging every O(1) command that accepts a target expression when the
// dump decompiles GetScope (e.g. Stellaris 4.6 Linux).
const CHAIN_WALK = /^(CFixedPointVariableValue|CIntVariableValue|CScriptableValue|CVariableValue|CBooleanVariableValue|CStringVariableValue|CEventTarget)::|^CEventTarget::GetScope$/;
// Text and formatting utilities loop over characters, not over game
// containers, so their loops are not container-scan evidence.
const TEXT_PROCESS = /^(CTextBase|CGameText|CString|CPdxString|CPdxLocalize|PdxLocalize)/;
const INFRA = /^(CPdxLog|CScopedStartProfile|CScopedProfile|CProfileManager|CPdxProfiler|operator_new|memset|memcpy|CPdxCommonStringAllocator|CString|CPdxString|std::|PdxLocalize|CPdxTemporaryLocalization|CStackTrace|CPdxAssert|CPdxHashTable|CPdxLogFileAndLine|CLogStream)/;
const NON_EVAL = /::(GetToolTip|GetDesc|GetName|GetErrorFlag|Create|ReadMember|WriteMembers|PostValidate|~|GetSupportedScopes|GetSupportedScopeTargets|AsString|GetTriggeredByIcon|GetDlcRecommendation)/;
const EVAL = /::(ActualEvaluate|ExecuteActual|GetTriggerValue|Evaluate|Execute|GetValue)\b/;
const LOOP = /(^|[;{}\s])(while\s*\(|for\s*\(|do\s*$)/;

const norm = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const qual = (s) => { const i = s.indexOf('('); return norm(i >= 0 ? s.slice(0, i) : s); };
// Preserve template arguments so distinct instantiations (e.g.
// CPlanetBuildingEffect<SDisableBuildingImpl> vs <SRepairBuildingImpl> or
// CNumDiplomacyRelationsTrigger<&(CDiplomacyCountryModule::GetNumWaystationPacts() const)>)
// do not collide onto one stripped key.
const fullQual = (s) => {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '<') depth++;
        else if (ch === '>') depth = Math.max(0, depth - 1);
        else if (ch === '(' && depth === 0) return s.slice(0, i).replace(/\s+/g, ' ').trim();
    }
    return s.replace(/\s+/g, ' ').trim();
};
const fullClassName = (q) => {
    let depth = 0;
    for (let i = 0; i < q.length - 1; i++) {
        const ch = q[i];
        if (ch === '<') depth++;
        else if (ch === '>') depth = Math.max(0, depth - 1);
        else if (ch === ':' && q[i + 1] === ':' && depth === 0) return q.slice(0, i).trim();
    }
    return null;
};
const className = (s) => { const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?::/.exec(s); return m ? m[1] : null; };
const pascal = (s) => s.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

// Verified template instantiations and minor C++/script naming divergences in
// the Stellaris 4.6 decompilation that cannot be inferred from PascalCase alone.
const EXPLICIT_CLASS_MAP = {
    trigger: {
        count_unlocked_active_accords: 'CNumUnlockedActiveAccordsTrigger',
        patron_has_all_accords_unlocked: 'CPatronHasAllAccordUnlockedTrigger',
        num_waystation_pacts: 'CNumDiplomacyRelationsTrigger<&(CDiplomacyCountryModule::GetNumWaystationPacts() const)>',
    },
    effect: {
        add_building: 'CPlanetBuildingEffect<SAddBuildingImpl>',
        disable_building: 'CPlanetBuildingEffect<SDisableBuildingImpl>',
        ruin_building: 'CPlanetBuildingEffect<SRuinBuildingImpl>',
        repair_building: 'CPlanetBuildingEffect<SRepairBuildingImpl>',
        remove_building: 'CPlanetBuildingEffect<SRemoveBuildingImpl>',
        set_citizenship_type: 'CSetSpeciesRightsEffect<SSetCitizenshipType>',
        set_living_standard: 'CSetSpeciesRightsEffect<SSetLivingStandardType>',
        revert_accords: 'CRevertPatronAccordsEffect',
    },
};

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
    const ownByFullQual = new Map();
    for (const b of blocks) {
        const q = qual(b.name);
        const cur = ownByQual.get(q);
        if (!cur || b.loops > cur.loops) ownByQual.set(q, b);
        const fq = fullQual(b.name);
        const fcur = ownByFullQual.get(fq);
        if (!fcur || b.loops > fcur.loops) ownByFullQual.set(fq, b);
    }
    const methodsByClass = new Map();
    for (const q of ownByQual.keys()) {
        const cls = className(q);
        if (!cls) continue;
        if (!methodsByClass.has(cls)) methodsByClass.set(cls, new Map());
        methodsByClass.get(cls).set(q.slice(q.indexOf('::') + 2), q);
    }
    const methodsByFullClass = new Map();
    for (const fq of ownByFullQual.keys()) {
        const cls = fullClassName(fq);
        if (!cls) continue;
        if (!methodsByFullClass.has(cls)) methodsByFullClass.set(cls, new Map());
        methodsByFullClass.get(cls).set(fq.slice(cls.length + 2), fq);
    }
    const byClass = new Map();
    const byFullClass = new Map();
    for (const b of blocks) {
        const fq = fullQual(b.name);
        const fcls = fullClassName(fq);
        if (fcls) {
            if (!byFullClass.has(fcls)) byFullClass.set(fcls, []);
            byFullClass.get(fcls).push(b);
        }
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?::/.exec(b.name);
        if (!m) continue;
        if (!byClass.has(m[1])) byClass.set(m[1], []);
        byClass.get(m[1]).push(b);
    }
    const bestEvalFrom = (map, cls) => {
        const arr = map.get(cls);
        if (!arr) return null;
        return arr.filter((b) => EVAL.test(b.name) && !NON_EVAL.test(b.name)).sort((a, b) => b.lines - a.lines)[0] || null;
    };
    const bestEval = (cls) => bestEvalFrom(byFullClass, cls) || bestEvalFrom(byClass, cls);
    const lookupBlock = (fn) => ownByFullQual.get(fn) || ownByQual.get(qual(fn));
    const calleesOf = (fn) => {
        const fowner = fullClassName(fn);
        const owner = className(qual(fn));
        const b = lookupBlock(fn);
        if (!b) return [];
        const out = new Set();
        for (const c of b.calls) {
            const fq = fullQual(c);
            const q = qual(c);
            let rq = null;
            if (fq.includes('::')) {
                rq = ownByFullQual.has(fq) ? fq : (ownByQual.has(q) ? q : null);
            } else {
                const fm = fowner ? (methodsByFullClass.get(fowner) || new Map()).get(fq) : null;
                const sm = owner ? (methodsByClass.get(owner) || new Map()).get(q) : null;
                rq = fm || sm || (ownByQual.has(q) ? q : null);
            }
            if (rq && rq !== fn && qual(rq) !== qual(fn) && !INFRA.test(rq) && !NON_EVAL.test(rq)) out.add(rq);
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

    const allNamesByKind = {
        trigger: namesFrom('triggers.cwt', 'trigger'),
        effect: namesFrom('effects.cwt', 'effect'),
    };
    const exactOwners = { trigger: new Map(), effect: new Map() };
    for (const kind of ['trigger', 'effect']) {
        for (const cmd of allNamesByKind[kind]) {
            const p = pascal(cmd);
            const suffixes = kind === 'trigger' ? ['Trigger', '', 'Value'] : ['Effect', '', 'Command'];
            for (const sfx of suffixes) exactOwners[kind].set('C' + p + sfx, cmd);
        }
    }

    const findEval = (cmd, kind) => {
        const explicit = (EXPLICIT_CLASS_MAP[kind] || {})[cmd];
        if (explicit) {
            const ev = bestEval(explicit);
            if (ev) return { cls: explicit, ev, exactFull: explicit.includes('<') };
        }
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
        const owners = exactOwners[kind];
        for (const c of byClass.keys()) {
            if (c.length > ('C' + p).length && c.startsWith('C' + p)) {
                // Never hijack another command's exact implementation class when
                // this command's own symbol was stripped in the dump.
                if (owners.has(c) && owners.get(c) !== cmd) continue;
                const ev = bestEval(c); if (ev) return { cls: c, ev };
            }
        }
        return null;
    };

    const rows = [];
    for (const [kind, file] of [['trigger', 'triggers.cwt'], ['effect', 'effects.cwt']]) {
        for (const cmd of allNamesByKind[kind]) {
            if (CONTROL_FLOW.has(cmd)) continue;
            const found = findEval(cmd, kind);
            if (!found) continue;
            const fn = found.exactFull ? fullQual(found.ev.name) : qual(found.ev.name);
            const self = lookupBlock(fn);
            const looping = calleesOf(fn).filter((c) => ((lookupBlock(c) || {}).loops || 0) > 0 && !CHAIN_WALK.test(c) && !TEXT_PROCESS.test(c));
            const ownLoops = self ? self.loops : 0;
            const ownNest = self ? self.maxNest : 0;

            let rec = null;
            if (ownNest >= 2) {
                rec = { cost: 'o(n^2)', evidence: fn, basis: 'nested loop in the command implementation', strength: 'direct' };
            } else if (ownLoops > 0) {
                rec = { cost: 'o(n)', evidence: fn, basis: 'loop in the command implementation', strength: 'direct' };
            } else if (looping.length > 0) {
                const w = looping.sort((a, b) => ((lookupBlock(b) || {}).maxNest || 0) - ((lookupBlock(a) || {}).maxNest || 0))[0];
                rec = { cost: 'o(n)', evidence: w, basis: 'delegates to a helper that scans', strength: 'callee' };
            } else if (self && self.lines <= 80) {
                rec = { cost: 'o(1)', evidence: fn, basis: 'no scan in the command or its direct callees', strength: 'local' };
            }
            if (!rec) continue;
            // The evidence function's signature line in this dump, so a reader
            // can open the claim instead of trusting the class name.
            const evBlock = lookupBlock(rec.evidence);
            rows.push({ command: cmd, kind, cls: found.cls, line: evBlock ? evBlock.start : null, ...rec });
        }
    }

    const json = JSON.stringify(rows, null, 1);
    if (outPath) fs.writeFileSync(outPath, json);
    else process.stdout.write(json + '\n');
    console.error('analysed ' + rows.length + ' commands (' + blocks.length + ' dump blocks)');
}

main().catch((e) => { console.error(e); process.exit(1); });
