'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const iterations = positiveInt(process.env.iterations ?? process.env.ITERATIONS, 50, 'iterations');
const warmup = positiveInt(process.env.warmup ?? process.env.WARMUP, 5, 'warmup');
const fsharp = process.env.FSHARP_ORACLE ?? path.join(root, 'artifacts', 'bin', 'CwtRulesValidation.FSharp', 'release', 'CwtRulesValidation.FSharp.dll');
const rust = process.env.RUST_PROJECTION ?? path.join(root, 'submodules', 'cwtools', 'target', 'release', 'cwtools-rules-projection-cli.exe');

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function makeFixture() {
  const fields = Array.from({ length: 200 }, (_, i) => `field_${String(i + 1).padStart(3, '0')}`);
  return {
    rules: [{ path: 'medium-rules.cwt', text: `root = {\n${fields.map(field => `  ${field} = scalar`).join('\n')}\n}` }],
    root: 'root',
    source: fields.map((field, i) => `${field} = value_${i + 1}`).join('\n'),
    scopes: [], mode: 'validation'
  };
}

function run(command, args, input) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, { cwd: root, input: Buffer.from(JSON.stringify(input), 'utf8'), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr || result.stdout}`);
  let output; try { output = JSON.parse(result.stdout); } catch (error) { throw new Error(`${command} returned invalid JSON: ${error.message}`); }
  if (output.error) throw new Error(`${command}: ${JSON.stringify(output.error)}`);
  return elapsedMs;
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b); const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank), upper = Math.ceil(rank); return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}
function measure(name, command, args, input) {
  for (let i = 0; i < warmup; i++) run(command, args, input);
  const samples = Array.from({ length: iterations }, () => run(command, args, input));
  return { name, warmup, iterations, samplesMs: samples, p50Ms: percentile(samples, 0.50), p95Ms: percentile(samples, 0.95) };
}

const fixture = makeFixture();
const fsharpResult = measure('fsharp', 'dotnet', [fsharp], { ...fixture, mode: undefined });
const rustResult = measure('rust', rust, [], fixture);
const report = { fixture: { rules: 200, fields: 200, assignments: 200, inputEncoding: 'utf8' }, warmup, iterations, fsharp: fsharpResult, rust: rustResult, ratio: { p50: rustResult.p50Ms / fsharpResult.p50Ms, p95: rustResult.p95Ms / fsharpResult.p95Ms }, gate: { rule: 'rust.p95 <= fsharp.p95 * 1.10', threshold: 1.10, passed: rustResult.p95Ms <= fsharpResult.p95Ms * 1.10 } };
console.log(JSON.stringify(report, null, 2));
if (!report.gate.passed) process.exitCode = 1;
