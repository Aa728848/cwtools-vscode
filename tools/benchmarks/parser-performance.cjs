#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'benchmarks', 'reference', 'rust-parser-performance.json');
const FIXTURE = path.join(ROOT, 'submodules', 'cwtools', 'CWToolsTests', 'testfiles', 'parsertests', 'simple.txt');
const EXE = path.join(ROOT, 'submodules', 'cwtools', 'target', 'release', 'examples', 'parse_file.exe');
const FSHARP_DLL = path.join(ROOT, 'artifacts', 'bin', 'StructuralProjection.FSharp', 'release', 'StructuralProjection.FSharp.dll');

function usage() {
  return 'Usage: node tools/benchmarks/parser-performance.cjs [--iterations N] [--output PATH]';
}
function fail(message) {
  throw new Error(message + '\n' + usage());
}
function parseArgs(argv) {
  let iterations = 100000;
  let output = DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--iterations' || arg === '-n') {
      const value = argv[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 1000000000) fail('iterations must be an integer from 1 to 1000000000');
      iterations = Number(value);
    } else if (arg === '--output' || arg === '-o') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) fail('output requires a path');
      output = path.resolve(ROOT, value);
      const relative = path.relative(ROOT, output);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('output must be inside the repository');
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage()); process.exit(0);
    } else {
      fail('unknown argument: ' + arg);
    }
  }
  return { iterations, output };
}
function samplePeakRss(pid, state) {
  try {
    const text = execFileSync('tasklist.exe', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = text.match(/"[^"]+"\s*,\s*"\d+"\s*,\s*"[^"]+"\s*,\s*"[^"]+"\s*,\s*"([\d,]+) K"/);
    if (match) state.peakRssBytes = Math.max(state.peakRssBytes, Number(match[1].replace(/,/g, '')) * 1024);
  } catch { /* Process may have already exited. */ }
}
async function runProcess(command, args, expectedIterations) {
  const started = process.hrtime.bigint();
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { peakRssBytes: 0 };
  const timer = setInterval(() => samplePeakRss(child.pid, state), 5); samplePeakRss(child.pid, state);
  let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearInterval(timer); samplePeakRss(child.pid, state);
  if (exitCode !== 0) throw new Error(command + ' failed (' + exitCode + '): ' + stderr.trim());
  let parsed; try { parsed = JSON.parse(stdout.trim()); } catch { throw new Error(command + ' produced invalid JSON: ' + stdout.trim()); }
  if (!Number.isInteger(parsed.iterations) || parsed.iterations !== expectedIterations) throw new Error(command + ' returned an unexpected iteration count');
  return { ...parsed, wallElapsedMs: Number(process.hrtime.bigint() - started) / 1e6, peakRssBytes: state.peakRssBytes || null };
}

(async () => {
  try {
    const { iterations, output } = parseArgs(process.argv.slice(2));
    if (process.platform !== 'win32') fail('this benchmark requires Windows tasklist peak RSS sampling');
    for (const [label, file] of [['fixture', FIXTURE], ['release parse_file executable', EXE], ['F# parser oracle', FSHARP_DLL]]) if (!fs.existsSync(file)) fail(label + ' not found: ' + path.relative(ROOT, file));
    const fixtureBytes = fs.statSync(FIXTURE).size;
    const result = await runProcess(EXE, [FIXTURE, String(iterations)], iterations);
    const fsharp = await runProcess('dotnet', [FSHARP_DLL, '--benchmark', FIXTURE, String(iterations)], iterations);
    const throughputRatio = result.bytesPerSecond / fsharp.bytesPerSecond;
    const rssRatio = result.peakRssBytes / fsharp.peakRssBytes;
    const parityPassed = throughputRatio >= 1 && rssRatio <= 1;
    const document = {
      schemaVersion: 1,
      benchmark: 'rust-script-parser-performance',
      fixture: path.relative(ROOT, FIXTURE).replaceAll(path.sep, '/'),
      executable: path.relative(ROOT, EXE).replaceAll(path.sep, '/'),
      fixtureBytes,
      iterations,
      tokens: result.tokens,
      roots: result.roots,
      elapsedMs: result.wallElapsedMs,
      parserElapsedMs: result.elapsedMs,
      bytesPerSecond: result.bytesPerSecond,
      peakRssBytes: result.peakRssBytes,
      fsharpComparison: { baselineAvailable: true, metrics: fsharp, throughputRatio, rssRatio, parityPassed }
    };
    if (!parityPassed) throw new Error('Rust parser performance parity gate failed');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(document, null, 2) + '\n');
    console.log(JSON.stringify(document, null, 2));
  } catch (error) { console.error('parser-performance: ' + error.message); process.exitCode = 1; }
})();
