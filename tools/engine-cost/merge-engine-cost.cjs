#!/usr/bin/env node
/**
 * Merge extracted engine-cost records into the CWT rule files.
 *
 *   node tools/engine-cost/merge-engine-cost.cjs <extracted.json> --rules <config dir> [--apply] [--report <file>]
 *
 * Why this is not a straight overwrite
 * ------------------------------------
 * tools/engine-cost/extract-engine-cost.cjs infers a class from control-flow
 * shape alone. It can prove "there is a loop" but it cannot tell a galaxy-wide
 * scan from a scan of the scoped object's own container, and it deliberately
 * does not model script re-evaluation. The maintained rules carry those
 * refinements by hand (o(n)_galaxy, o(n)_owned, script_eval, scope_copy,
 * refresh_batch, semantics, combat, load).
 *
 * Overwriting would therefore DOWNGRADE good facts. The merge keeps the
 * refinement and treats the extraction as corroboration plus a line number.
 *
 * Policy (per command)
 *   - no maintained cost            -> adopt the extracted class
 *   - extracted == maintained       -> keep, refresh the line reference
 *   - extracted refines maintained  -> adopt (o(1) -> o(n), o(n) -> o(n^2))
 *   - maintained refines extracted  -> keep maintained (o(n)_galaxy etc.)
 *   - both are specific but differ  -> keep maintained, report as conflict
 *   - maintained but not extracted  -> keep, report as unverified
 *
 * Every touched command gains "; dump L<line>" in ## engine_evidence, so a
 * reviewer can open the exact function in the dump instead of trusting a name.
 */

const fs = require('node:fs');
const path = require('node:path');

const REFINES = {
    'o(1)': ['o(n)', 'o(n)_owned', 'o(n)_galaxy', 'o(n^2)', 'o(log n)'],
    'o(n)': ['o(n)_owned', 'o(n)_galaxy', 'o(n^2)'],
    'o(log n)': [],
    'o(n^2)': [],
    'o(n)_owned': [],
    'o(n)_galaxy': [],
    'script_eval': [],
    'scope_copy': [],
    'refresh_batch': [],
    'semantics': [],
    'combat': [],
    'load': [],
};

function main() {
    const argv = process.argv.slice(2);
    const extractedPath = argv.find((a) => !a.startsWith('--'));
    const rulesDir = argv.includes('--rules') ? argv[argv.indexOf('--rules') + 1] : null;
    const apply = argv.includes('--apply');
    const reportIdx = argv.indexOf('--report');
    const reportPath = reportIdx >= 0 ? argv[reportIdx + 1] : null;
    if (!extractedPath || !rulesDir) {
        console.error('usage: merge-engine-cost.cjs <extracted.json> --rules <dir> [--apply] [--report <file>]');
        process.exit(2);
    }

    const rows = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
    const byKey = new Map();
    for (const r of rows) byKey.set(r.kind + ':' + r.command, r);

    const report = { adopted: [], refreshed: [], upgraded: [], keptRefinement: [], conflicts: [], unverified: [], untouched: [] };

    const files = [['trigger', 'triggers.cwt'], ['effect', 'effects.cwt']];
    for (const [kind, file] of files) {
        const full = path.join(rulesDir, file);
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        const out = [];
        let pending = {};       // annotation lines seen since the last alias
        let pendingIdx = {};    // index of each annotation line in `out`
        let seen = new Set();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const a = new RegExp('^alias\\[' + kind + ':([a-z0-9_]+)\\]').exec(line);
            if (a) {
                const cmd = a[1];
                const key = kind + ':' + cmd;
                const row = byKey.get(key);
                const first = !seen.has(cmd);
                seen.add(cmd);
                if (first) {
                    const curCost = pending.cost;
                    if (!row) {
                        if (curCost) report.unverified.push({ key, cost: curCost });
                    } else {
                        const exCost = row.cost;
                        const ev = row.line ? row.evidence + ' (' + row.basis + '); dump L' + row.line : row.evidence + ' (' + row.basis + ')';
                        if (!curCost) {
                            out.splice(pendingIdx.alias ?? out.length, 0, '## cost = ' + exCost);
                            out.push('## engine_evidence = ' + ev);
                            report.adopted.push({ key, cost: exCost, evidence: row.evidence });
                        } else if (curCost === exCost) {
                            if (pending.evidence !== undefined) out[pendingIdx.evidence] = '## engine_evidence = ' + ev;
                            else out.push('## engine_evidence = ' + ev);
                            report.refreshed.push({ key, cost: curCost });
                        } else if ((REFINES[curCost] || []).includes(exCost)) {
                            // extracted is more specific than what we had
                            if (pendingIdx.cost !== undefined) out[pendingIdx.cost] = '## cost = ' + exCost;
                            if (pending.evidence !== undefined) out[pendingIdx.evidence] = '## engine_evidence = ' + ev;
                            else out.push('## engine_evidence = ' + ev);
                            report.upgraded.push({ key, from: curCost, to: exCost, evidence: row.evidence });
                        } else if ((REFINES[exCost] || []).includes(curCost)) {
                            // maintained is more specific; keep it, record the corroboration
                            if (pending.evidence !== undefined) out[pendingIdx.evidence] = '## engine_evidence = ' + ev;
                            else out.push('## engine_evidence = ' + ev);
                            report.keptRefinement.push({ key, kept: curCost, extracted: exCost });
                        } else {
                            report.conflicts.push({ key, maintained: curCost, extracted: exCost, evidence: row.evidence });
                        }
                    }
                }
                out.push(line);
                pending = {}; pendingIdx = {};
                continue;
            }
            const c = /^## cost = (.+)$/.exec(line);
            if (c) { pending.cost = c[1].trim(); pendingIdx.cost = out.length; out.push(line); continue; }
            const e = /^## engine = (.+)$/.exec(line);
            if (e) { pending.engine = e[1].trim(); pendingIdx.engine = out.length; out.push(line); continue; }
            const v = /^## engine_evidence = (.+)$/.exec(line);
            if (v) { pending.evidence = v[1].trim(); pendingIdx.evidence = out.length; out.push(line); continue; }
            // A non-comment, non-blank line that is not an alias ends the block.
            if (line.trim() !== '' && !line.startsWith('#')) { pending = {}; pendingIdx = {}; }
            out.push(line);
        }
        if (apply) fs.writeFileSync(full, out.join('\n'));
    }

    const summary = {
        adopted: report.adopted.length,
        refreshed: report.refreshed.length,
        upgraded: report.upgraded.length,
        keptRefinement: report.keptRefinement.length,
        conflicts: report.conflicts.length,
        unverified: report.unverified.length,
        applied: apply,
    };
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ summary, ...report }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    if (report.upgraded.length) {
        console.log('\nupgraded (extraction found a scan the rules missed):');
        for (const u of report.upgraded.slice(0, 40)) console.log('  ' + u.key + ': ' + u.from + ' -> ' + u.to + '  [' + u.evidence + ']');
    }
    if (report.conflicts.length) {
        console.log('\nconflicts (kept the maintained value, needs a human):');
        for (const u of report.conflicts.slice(0, 40)) console.log('  ' + u.key + ': kept ' + u.maintained + ', extracted ' + u.extracted + '  [' + u.evidence + ']');
    }
    if (report.unverified.length) {
        console.log('\nunverified (maintained but no extraction evidence):');
        for (const u of report.unverified.slice(0, 40)) console.log('  ' + u.key + ' = ' + u.cost);
    }
}

main();
