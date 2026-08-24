'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { performance } = require('perf_hooks');
const { MessageReader, writeMessage } = require('../lsp-transcript/lib/jsonrpc.cjs');
const { fileUri, expand } = require('../lsp-transcript/lib/runner.cjs');

const HELP = [
  'Usage: node tools/benchmarks/run-baseline.cjs --manifest <file> --workspace <dir> --server <file>',
  '       [--runs 3+] [--out-dir dir] [--vsix file] [--timeout-ms 30000] [--dry-run]',
].join('\n');
function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error('Unexpected argument: ' + arg);
    const equal = arg.indexOf('=');
    if (equal > 2) output[arg.slice(2, equal)] = arg.slice(equal + 1);
    else if (arg === '--dry-run' || arg === '--help') output[arg.slice(2)] = true;
    else {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('Missing value for ' + arg);
      output[arg.slice(2)] = argv[++index];
    }
  }
  return output;
}
function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(name + ' must be an integer in [' + min + ',' + max + ']');
  return number;
}
function exec(command, args) {
  return new Promise(resolve => execFile(command, args, { windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null)));
}
async function rss(pid) {
  if (!pid) return null;
  if (process.platform === 'win32') {
    const output = await exec('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
    const match = output && output.match(/"([\d,]+) K"/);
    return match ? Number(match[1].replaceAll(',', '')) * 1024 : null;
  }
  const output = await exec('ps', ['-o', 'rss=', '-p', String(pid)]);
  const value = output && Number(output.trim());
  return Number.isFinite(value) ? value * 1024 : null;
}
function size(file) { try { return fs.statSync(file).size; } catch { return null; } }
function waitFor(map, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { map.delete(id); reject(new Error('Timed out waiting for response ' + id)); }, timeoutMs);
    map.set(id, response => { clearTimeout(timer); resolve(response); });
  });
}
async function runOnce(options, manifest, workspaceRoot, run) {
  const child = spawn(options.server, ['--stdio'], { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let peakRssBytes = null;
  let stderr = '';
  const sample = async () => { const current = await rss(child.pid); if (current !== null) peakRssBytes = Math.max(peakRssBytes ?? 0, current); };
  const interval = setInterval(() => void sample(), 25);
  const pending = new Map();
  new MessageReader(child.stdout, message => {
    if (message.id !== undefined && pending.has(message.id)) { const resolve = pending.get(message.id); pending.delete(message.id); resolve(message); }
    else if (message.id !== undefined && message.method) void writeMessage(child.stdin, { jsonrpc: '2.0', id: message.id, result: null });
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  let nextId = 1;
  async function request(method, params) {
    const id = nextId++;
    const started = performance.now();
    const response = waitFor(pending, id, options.timeoutMs);
    await writeMessage(child.stdin, { jsonrpc: '2.0', id, method, params });
    const value = await response;
    await sample();
    return { latencyMs: performance.now() - started, response: value };
  }
  const started = performance.now();
  let initialize;
  try {
    initialize = await request('initialize', {
      processId: null, rootUri: fileUri(workspaceRoot), capabilities: {}, workspaceFolders: [],
      initializationOptions: { language: manifest.gameId ?? 'paradox', uiLanguage: 'en', isVanillaFolder: false, rulesCache: '', bundledRulesPath: '', rules_version: 'stable', defaultRepoPath: '', repoPath: '', diagnosticLogging: false },
    });
    await writeMessage(child.stdin, { jsonrpc: '2.0', method: 'initialized', params: {} });
    const operations = {};
    for (const operation of manifest.operations) {
      const measurement = await request(operation.method, expand(operation.params, workspaceRoot));
      operations[operation.id] = measurement.latencyMs;
    }
    await request('shutdown', null);
    await writeMessage(child.stdin, { jsonrpc: '2.0', method: 'exit', params: null });
    child.stdin.end();
    const exit = await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve({ code: null, signal: null, timedOut: true }); }, options.timeoutMs);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut: false }); });
    });
    return { run, temperature: run === 1 ? 'cold' : 'warm', startupMs: initialize.latencyMs, completionMs: operations.completion ?? null, validationReadinessMs: operations['validation-readiness'] ?? null, operations, peakRssBytes, elapsedMs: performance.now() - started, exit, stderr: stderr.split(/\r?\n/).filter(Boolean) };
  } catch (error) {
    child.kill();
    return { run, temperature: run === 1 ? 'cold' : 'warm', startupMs: initialize?.latencyMs ?? null, completionMs: null, validationReadinessMs: null, operations: {}, peakRssBytes, elapsedMs: performance.now() - started, error: String(error), stderr: stderr.split(/\r?\n/).filter(Boolean) };
  } finally { clearInterval(interval); }
}
function stats(rows, key) {
  const values = rows.map(row => row[key]).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  return values.length ? { count: values.length, min: values[0], median: values[Math.floor(values.length / 2)], max: values[values.length - 1] } : null;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  const runs = integer(args.runs ?? 3, '--runs', 3, 100);
  const timeoutMs = integer(args['timeout-ms'] ?? 30000, '--timeout-ms', 100, 300000);
  if (!args.manifest) throw new Error('--manifest is required');
  const manifestPath = path.resolve(args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.operations) || manifest.operations.length === 0) throw new Error('manifest must have schemaVersion 1 and non-empty operations');
  const workspaceRoot = path.resolve(args.workspace ?? manifest.workspace ?? '.');
  const server = path.resolve(args.server ?? manifest.server ?? '');
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) throw new Error('workspace is not a directory: ' + workspaceRoot);
  if (!args['dry-run'] && (!fs.existsSync(server) || !fs.statSync(server).isFile())) throw new Error('server does not exist: ' + server);
  const vsix = args.vsix ?? manifest.vsix ?? null;
  const plan = { runs, workspace: workspaceRoot, server, operations: manifest.operations.map(operation => operation.id), timeoutMs, vsix };
  if (args['dry-run']) { console.log(JSON.stringify({ dryRun: true, plan }, null, 2)); return; }
  const rows = [];
  for (let run = 1; run <= runs; run += 1) rows.push(await runOnce({ server, timeoutMs }, manifest, workspaceRoot, run));
  if (rows.some(row => row.error || row.exit?.timedOut || row.exit?.code !== 0)) throw new Error('one or more baseline runs failed; no successful summary was written');
  const metadata = { timestamp: new Date().toISOString(), commit: await exec('git', ['rev-parse', 'HEAD']), platform: process.platform, arch: process.arch, node: process.version, workspace: workspaceRoot, server, serverBytes: size(server), vsix: vsix ? { path: path.resolve(vsix), bytes: size(vsix) } : null };
  const raw = { schemaVersion: 1, metadata, configuration: plan, runs: rows };
  const summary = { schemaVersion: 1, metadata, runCount: runs, metrics: Object.fromEntries(['startupMs', 'completionMs', 'validationReadinessMs', 'peakRssBytes', 'elapsedMs'].map(key => [key, stats(rows, key)])) };
  const output = path.resolve(args['out-dir'] ?? 'benchmarks/results');
  fs.mkdirSync(output, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
  fs.writeFileSync(path.join(output, 'phase0-baseline-' + stamp + '.raw.json'), JSON.stringify(raw, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'phase0-baseline-' + stamp + '.summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error('Error: ' + error.message); console.error(HELP); process.exitCode = 1; });
