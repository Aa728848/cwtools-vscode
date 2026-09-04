// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

function findTestScripts(dir) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findTestScripts(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.Tests.fsx')) {
            results.push(fullPath);
        }
    }
    return results;
}

const filterArg = process.argv[2] ? process.argv[2].toLowerCase() : null;
const allTests = findTestScripts(srcDir).sort();
const testsToRun = filterArg
    ? allTests.filter((t) => path.basename(t).toLowerCase().includes(filterArg))
    : allTests;

if (testsToRun.length === 0) {
    console.error(`No test scripts found matching '${filterArg || ''}'.`);
    process.exit(1);
}

console.log(`Discovered ${testsToRun.length} F# test script(s)...`);
console.log('='.repeat(70));

let passed = 0;
let failed = 0;
const failures = [];
const startTime = Date.now();

for (const testPath of testsToRun) {
    const relPath = path.relative(rootDir, testPath);
    const testDir = path.dirname(testPath);
    const testFile = path.basename(testPath);
    process.stdout.write(`RUN  ${relPath}... `);

    const testStart = Date.now();
    const result = spawnSync('dotnet', ['fsi', testFile], {
        cwd: testDir,
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: 60000,
    });
    const durationMs = Date.now() - testStart;

    if (result.status === 0 && !result.error) {
        passed++;
        console.log(`PASS (${(durationMs / 1000).toFixed(2)}s)`);
    } else {
        failed++;
        const isTimeout = result.error && /** @type {any} */ (result.error).code === 'ETIMEDOUT';
        console.log(`${isTimeout ? 'TIMEOUT' : 'FAIL'} (${(durationMs / 1000).toFixed(2)}s)`);
        failures.push({
            file: relPath,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.error ? result.error.message : undefined,
        });
    }
}

const totalDurationSec = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('='.repeat(70));

if (failures.length > 0) {
    console.log('\nFailures detail:');
    for (const f of failures) {
        console.log(`\n--- [FAIL] ${f.file} ---`);
        if (f.stdout) console.log(f.stdout);
        if (f.stderr) console.error(f.stderr);
    }
}

console.log(`\nSummary: ${passed} passed, ${failed} failed (${testsToRun.length} total, ${totalDurationSec}s)`);

if (failed > 0) {
    process.exit(1);
}
