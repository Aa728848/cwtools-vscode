#!/usr/bin/env node
'use strict';

// Production Rust-only LSP soak lane. The requested binary is staged in an
// isolated directory so the test exercises exactly one self-contained server artifact.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { pathToFileURL } = require('url');
function writeMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]);
  return new Promise((resolve, reject) => stream.write(frame, error => error ? reject(error) : resolve()));
}

const REPORT_SCHEMA_VERSION = 1;
const REPORT_TYPE = 'cwtools.rust-lsp-soak';
const WORKLOAD_VERSION = 'rust-lsp-soak-v1';
const DEFAULT_MINUTES = 1440;
const DEFAULT_SAMPLE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RESTART_EVERY = 60;
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_SEED = 0x5eed2026;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const EXPECTED_STANDALONE_QUERY_ERRORS = new Set([-32601, -32602]);
const QUERY_METHODS = [
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/references',
  'textDocument/documentSymbol',
  'textDocument/foldingRange',
  'textDocument/formatting',
  'cwtools.rust.parseScript',
];

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SERVER = path.join(ROOT, 'rust', 'target', 'release', process.platform === 'win32' ? 'cwtools-lsp.exe' : 'cwtools-lsp');
const DEFAULT_OUTPUT = path.join(ROOT, 'benchmarks', 'results', 'rust-lsp-soak.json');

function usage() {
  return [
    'Usage: node tools/benchmarks/rust-lsp-soak.cjs [options]',
    '',
    'Default: final lane for exactly 1440 minutes (do not use this accidentally).',
    'Smoke: --iterations 3 --restart-every 1 --delay-ms 0 --output .tmp/rust-lsp-soak.json',
    '',
    'Options:',
    '  --server <file>          packaged standalone Rust cwtools-lsp executable',
    '  --minutes <number>       duration, 0..1440; default 1440',
    '  --iterations <integer>   run exactly this many workload iterations',
    '  --restart-every <n>      restart after n iterations; default 60',
    '  --sample-ms <n>          server RSS sampling interval; default 1000',
    '  --timeout-ms <n>         per-request/process timeout; default 10000',
    '  --delay-ms <n>           deterministic delay between iterations; default 1000',
    '  --seed <integer>         deterministic workload seed; default ' + DEFAULT_SEED,
    '  --output <file>          versioned JSON report path',
    '  --help                   show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const values = {
    server: DEFAULT_SERVER,
    minutes: DEFAULT_MINUTES,
    iterations: 0,
    restartEvery: DEFAULT_RESTART_EVERY,
    sampleMs: DEFAULT_SAMPLE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    delayMs: DEFAULT_DELAY_MS,
    seed: DEFAULT_SEED,
    output: DEFAULT_OUTPUT,
    minutesExplicit: false,
    iterationsExplicit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true, ...values };
    if (!token.startsWith('--')) throw new Error('Unexpected argument: ' + token);
    const equal = token.indexOf('=');
    const name = equal > 2 ? token.slice(2, equal) : token.slice(2);
    let value = equal > 2 ? token.slice(equal + 1) : undefined;
    if (value === undefined) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('Missing value for --' + name);
      value = argv[++index];
    }
    switch (name) {
      case 'server': values.server = value; break;
      case 'output': values.output = value; break;
      case 'minutes': values.minutes = number(value, '--minutes', 0, DEFAULT_MINUTES); values.minutesExplicit = true; break;
      case 'iterations': values.iterations = integer(value, '--iterations', 0, Number.MAX_SAFE_INTEGER); values.iterationsExplicit = true; break;
      case 'restart-every': values.restartEvery = integer(value, '--restart-every', 1, Number.MAX_SAFE_INTEGER); break;
      case 'sample-ms': values.sampleMs = integer(value, '--sample-ms', 50, 60000); break;
      case 'timeout-ms': values.timeoutMs = integer(value, '--timeout-ms', 100, 300000); break;
      case 'delay-ms': values.delayMs = integer(value, '--delay-ms', 0, 60000); break;
      case 'seed': values.seed = integer(value, '--seed', 0, 0xffffffff); break;
      default: throw new Error('Unknown option --' + name);
    }
  }
  if (values.minutes === 0 && values.iterations === 0) throw new Error('--minutes 0 requires a positive --iterations');
  if (values.iterations > 0 && !values.minutesExplicit) values.minutes = 0;
  return values;
}

function number(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(name + ' must be a number in [' + min + ', ' + max + ']');
  return parsed;
}

function integer(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(name + ' must be an integer in [' + min + ', ' + max + ']');
  return parsed;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function execText(command, args, options) {
  return new Promise(resolve => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: options && options.timeout || 3000 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

async function serverRssBytes(pid) {
  if (!pid) return null;
  if (process.platform === 'win32') {
    const output = await execText('tasklist.exe', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
    if (!output) return null;
    const match = output.match(/"([0-9,]+)\s+K"/);
    return match ? Number(match[1].replaceAll(',', '')) * 1024 : null;
  }
  const output = await execText('ps', ['-o', 'rss=', '-p', String(pid)]);
  if (!output) return null;
  const value = Number(output.trim());
  return Number.isFinite(value) && value >= 0 ? value * 1024 : null;
}

async function processExists(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const output = await execText('tasklist.exe', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
    return Boolean(output && !/no tasks are running/i.test(output) && new RegExp('"' + pid + '"').test(output));
  }
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}

async function waitForProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return true;
    await sleep(50);
  }
  return !(await processExists(pid));
}

async function terminateProcess(child) {
  if (!child || !child.pid) return { attempted: false, gone: true };
  const pid = child.pid;
  if (process.platform === 'win32') {
    await execText('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  return { attempted: true, gone: await waitForProcessGone(pid, 5000) };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function gitIdentity(root) {
  const run = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? String(result.stdout).trim() : null;
  };
  const status = run(['status', '--porcelain', '--untracked-files=all']);
  return {
    root,
    commit: run(['rev-parse', 'HEAD']),
    tree: run(['rev-parse', 'HEAD^{tree}']),
    workingTree: status === null ? 'unknown' : status.length === 0 ? 'clean' : 'dirty',
    changedPathCount: status === null ? null : status ? status.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

function stageStandaloneArtifact(serverPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-rust-lsp-soak-'));
  const name = process.platform === 'win32' ? 'cwtools-lsp.exe' : 'cwtools-lsp';
  const executionPath = path.join(directory, name);
  fs.copyFileSync(serverPath, executionPath);
  if (process.platform !== 'win32') fs.chmodSync(executionPath, 0o755);
  return { directory, executionPath };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FrameReader {
  constructor(stream, onMessage, onError) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onError = onError;
    this.failed = false;
    stream.on('data', chunk => this.push(chunk));
    stream.on('error', error => this.fail(error));
  }

  push(chunk) {
    if (this.failed) return;
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_FRAME_BYTES * 2) throw new Error('JSON-RPC input buffer exceeded safety bound');
      while (true) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header);
        if (!match) throw new Error('Missing Content-Length header');
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) throw new Error('Invalid Content-Length: ' + match[1]);
        const bodyStart = headerEnd + 4;
        if (this.buffer.length < bodyStart + length) return;
        const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
        this.buffer = this.buffer.subarray(bodyStart + length);
        const message = JSON.parse(body);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('JSON-RPC payload was not an object');
        this.onMessage(message);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.onError(error);
  }
}

class ServerSession {
  constructor(executable, options, sessionNumber, report) {
    this.executable = executable;
    this.options = options;
    this.sessionNumber = sessionNumber;
    this.report = report;
    this.child = null;
    this.pending = new Map();
    this.nextId = sessionNumber * 1000000 + 1;
    this.exited = false;
    this.exitInfo = null;
    this.reader = null;
    this.sampleTimer = null;
    this.sampleInFlight = false;
    this.stderr = '';
    this.protocolError = null;
    this.serverRequests = 0;
    this.startedAt = 0;
    this.initialized = false;
    this.rssSampleIndexes = [];
    this.rssStartIndex = report.rss.samples.length;
    this.exitPromise = null;
    this.resolveExit = null;
  }

  async start() {
    this.startedAt = performance.now();
    this.child = spawn(this.executable, ['--stdio'], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.reader = new FrameReader(this.child.stdout, message => this.receive(message), error => this.failProtocol(error));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-65536);
    });
    this.child.once('error', error => this.failProtocol(error));
    this.child.once('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const pending of this.pending.values()) pending.reject(new Error('server exited before response'));
      this.pending.clear();
      if (this.resolveExit) this.resolveExit(this.exitInfo);
    });
    this.sampleTimer = setInterval(() => { void this.sampleRss('interval'); }, this.options.sampleMs);
    await this.sampleRss('start');
    const initialize = await this.request('initialize', {
      processId: null,
      rootUri: pathToFileURL(ROOT).href,
      workspaceFolders: [{ uri: pathToFileURL(ROOT).href, name: path.basename(ROOT) }],
      capabilities: {},
      initializationOptions: { language: 'paradox', uiLanguage: 'en', diagnosticLogging: false },
    });
    if (initialize.error) throw new Error('initialize returned error ' + JSON.stringify(initialize.error));
    await this.notify('initialized', {});
    this.initialized = true;
    await this.sampleRss('post-initialize');
  }

  failProtocol(error) {
    if (!this.protocolError) this.protocolError = String(error && error.message || error);
    for (const pending of this.pending.values()) pending.reject(new Error(this.protocolError));
    this.pending.clear();
  }

  receive(message) {
    if (message.id !== undefined && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      pending.resolve(message);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.serverRequests += 1;
      void this.send({ jsonrpc: '2.0', id: message.id, result: null }).catch(error => this.failProtocol(error));
    }
  }

  async send(message) {
    if (!this.child || this.exited || !this.child.stdin) throw new Error('server process is not running');
    this.report.counters.messagesSent += 1;
    return withTimeout(writeMessage(this.child.stdin, message), this.options.timeoutMs, 'write ' + (message.method || 'response'));
  }

  async notify(method, params) {
    this.report.counters.notificationsSent += 1;
    return this.send({ jsonrpc: '2.0', method, params });
  }

  async request(method, params) {
    const id = this.nextId++;
    const key = String(id);
    this.report.counters.requestsSent += 1;
    const response = new Promise((resolve, reject) => this.pending.set(key, { resolve, reject }));
    try {
      await this.send({ jsonrpc: '2.0', id, method, params });
      return await withTimeout(response, this.options.timeoutMs, method + ' response');
    } finally {
      this.pending.delete(key);
    }
  }

  async cancellableRequest(method, params) {
    const id = this.nextId++;
    const key = String(id);
    this.report.counters.requestsSent += 1;
    this.report.counters.cancelRequestsSent += 1;
    const response = new Promise((resolve, reject) => this.pending.set(key, { resolve, reject }));
    try {
      await this.send({ jsonrpc: '2.0', id, method, params });
      await this.notify('$/cancelRequest', { id });
      return await withTimeout(response, this.options.timeoutMs, method + ' cancelled response');
    } finally {
      this.pending.delete(key);
    }
  }

  async sampleRss(reason, iteration) {
    if (this.sampleInFlight || !this.child || !this.child.pid) return;
    this.sampleInFlight = true;
    try {
      const rssBytes = await serverRssBytes(this.child.pid);
      this.report.rss.sampleAttempts += 1;
      if (rssBytes !== null) {
        const sample = {
          at: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - this.startedAt),
          session: this.sessionNumber,
          iteration: iteration || null,
          pid: this.child.pid,
          rssBytes,
          source: 'server-process',
          reason,
        };
        this.rssSampleIndexes.push(this.report.rss.samples.length);
        this.report.rss.samples.push(sample);
        this.report.rss.numericSampleCount += 1;
        this.report.rss.peakRssBytes = Math.max(this.report.rss.peakRssBytes || 0, rssBytes);
      } else {
        this.report.rss.unavailableSampleCount += 1;
      }
    } catch (error) {
      this.report.rss.unavailableSampleCount += 1;
      this.report.errors.push('RSS sample failed: ' + String(error && error.message || error));
    } finally {
      this.sampleInFlight = false;
    }
  }

  async runIteration(iteration, seed) {
    const documents = makeDocuments(iteration, seed, ROOT);
    for (const document of documents) {
      await this.notify('textDocument/didOpen', { textDocument: { uri: document.uri, languageId: 'paradox', version: 1, text: document.initial } });
      await this.notify('textDocument/didChange', { textDocument: { uri: document.uri, version: 2 }, contentChanges: [{ text: document.edited }] });
      await this.notify('textDocument/didChange', { textDocument: { uri: document.uri, version: 3 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: document.edited.length } }, text: document.final }] });
      await this.notify('textDocument/didSave', { textDocument: { uri: document.uri }, text: document.final });
    }
    for (let index = 0; index < QUERY_METHODS.length; index += 1) {
      const method = QUERY_METHODS[index];
      const document = documents[index % documents.length];
      const params = queryParams(method, document);
      const response = index % 2 === 1
        ? await this.cancellableRequest(method, params)
        : await this.request(method, params);
      this.report.counters.queryResponses += 1;
      if (response.error && EXPECTED_STANDALONE_QUERY_ERRORS.has(response.error.code)) this.report.counters.expectedQueryErrors += 1;
      else if (response.error) {
        this.report.counters.unexpectedResponses += 1;
        throw new Error(method + ' returned unexpected error ' + JSON.stringify(response.error));
      } else {
        this.report.counters.queryResults += 1;
      }
    }
    for (const document of documents) await this.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
    await this.sampleRss('iteration', iteration);
    await sleep(10);
    await this.sampleRss('iteration-settle', iteration);
    this.report.counters.iterations += 1;
  }

  async stop() {
    if (!this.child) return { exit: null, orphanGone: true, forced: false };
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    let forced = false;
    let shutdownError = null;
    if (!this.exited) {
      try {
        if (this.initialized) await this.request('shutdown', null);
        if (!this.exited) {
          await this.notify('exit', null);
          if (this.child.stdin) this.child.stdin.end();
        }
      } catch (error) {
        shutdownError = String(error && error.message || error);
        this.report.counters.timeouts += /timed out/i.test(shutdownError) ? 1 : 0;
      }
    }
    let exit = this.exitInfo;
    if (!this.exited) {
      exit = await Promise.race([this.exitPromise, sleep(this.options.timeoutMs).then(() => null)]);
      if (!exit) {
        forced = true;
        this.report.counters.deadlocks += 1;
        await terminateProcess(this.child);
        exit = await Promise.race([this.exitPromise, sleep(5000).then(() => ({ code: null, signal: 'KILL_TIMEOUT' }))]);
      }
    }
    const orphanGone = await waitForProcessGone(this.child.pid, 5000);
    if (!orphanGone) this.report.counters.orphanedProcesses += 1;
    if (shutdownError) this.report.errors.push('session ' + this.sessionNumber + ' shutdown: ' + shutdownError);
    if (this.protocolError) this.report.counters.protocolErrors += 1;
    if (exit && (exit.code !== 0 || exit.signal)) this.report.counters.unexpectedExits += 1;
    return { exit, orphanGone, forced, pid: this.child.pid, serverRequests: this.serverRequests, stderr: this.stderr.trim().split(/\\r?\\n/).filter(Boolean).slice(-20) };
  }
}

function makeDocuments(iteration, seed, root) {
  const docs = [];
  for (let index = 0; index < 3; index += 1) {
    const value = (seed + iteration * 17 + index * 31) % 997;
    const name = ['alpha', 'beta', 'gamma'][index];
    const uri = pathToFileURL(path.join(root, 'benchmarks', 'rust-lsp-soak', name + '.txt')).href;
    const initial = 'root = { value = ' + value + ' }\\n';
    const edited = 'root = { value = ' + ((value + 1) % 997) + ' }\\n';
    const final = edited + '# deterministic iteration ' + iteration + ' document ' + index + '\\n';
    docs.push({ uri, initial, edited, final });
  }
  return docs;
}

function queryParams(method, document) {
  if (method === 'textDocument/completion') return { textDocument: { uri: document.uri }, position: { line: 0, character: 1 }, context: { triggerKind: 1 } };
  if (method === 'textDocument/hover') return { textDocument: { uri: document.uri }, position: { line: 0, character: 1 } };
  if (method === 'textDocument/definition' || method === 'textDocument/references') return { textDocument: { uri: document.uri }, position: { line: 0, character: 1 }, context: { includeDeclaration: true } };
  if (method === 'textDocument/documentSymbol' || method === 'textDocument/foldingRange') return { textDocument: { uri: document.uri } };
  if (method === 'textDocument/formatting') return { textDocument: { uri: document.uri }, options: { tabSize: 4, insertSpaces: false } };
  return { text: document.final };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function analyzeGrowth(samples, options) {
  const values = samples.filter(sample => sample && Number.isFinite(sample.rssBytes)).map(sample => sample.rssBytes);
  const minimum = options && options.minimumSamples || 8;
  const windowSize = options && options.windowSize || 4;
  if (values.length < minimum) return { detected: false, passed: true, sufficientSamples: false, sampleCount: values.length, increasingWindows: 0, firstMedian: median(values), lastMedian: median(values), growthBytes: 0, reason: 'insufficient samples for sustained-growth conclusion' };
  const windows = [];
  for (let index = 0; index + windowSize <= values.length; index += windowSize) windows.push(median(values.slice(index, index + windowSize)));
  let increasingWindows = 0;
  for (let index = 1; index < windows.length; index += 1) if (windows[index] > windows[index - 1] + 1024 * 1024) increasingWindows += 1; else if (windows[index] <= windows[index - 1]) increasingWindows = 0;
  const firstMedian = windows[0];
  const lastMedian = windows[windows.length - 1];
  const growthBytes = lastMedian - firstMedian;
  const detected = increasingWindows >= 3 && growthBytes >= 16 * 1024 * 1024;
  return { detected, passed: !detected, sufficientSamples: true, sampleCount: values.length, increasingWindows, firstMedian, lastMedian, growthBytes, reason: detected ? 'three or more consecutive RSS windows grew by at least 16 MiB' : 'no sustained RSS growth threshold reached' };
}

function buildPassCriteria(report, growth) {
  const finalLane = report.lane === 'final';
  return {
    finalLaneUsesExactly1440Minutes: !finalLane || (report.configuration.requestedMinutes === DEFAULT_MINUTES && report.configuration.requestedIterations === 0),
    rustOnlyStagedArtifact: report.artifact.workerIsolation === 'standalone-rust-artifact',
    allRequestedIterationsCompleted: report.counters.iterations > 0 && (report.configuration.requestedIterations === 0 || report.counters.iterations === report.configuration.requestedIterations),
    lifecycleAndRestartClean: report.counters.cleanLifecycles === report.counters.sessions && report.counters.unexpectedExits === 0,
    noDeadlockOrTimeout: report.counters.deadlocks === 0 && report.counters.timeouts === 0,
    noOrphanedServerProcess: report.counters.orphanedProcesses === 0,
    noProtocolErrors: report.counters.protocolErrors === 0 && report.counters.unexpectedResponses === 0,
    serverRssSampled: report.rss.source === 'server-process' && report.rss.numericSampleCount >= 8,
    noSustainedServerRssGrowth: growth.passed,
  };
}

async function run(options) {
  const startedEpoch = Date.now();
  const startedAt = new Date(startedEpoch).toISOString();
  const serverPath = path.resolve(options.server);
  if (!fs.existsSync(serverPath) || !fs.statSync(serverPath).isFile()) throw new Error('Rust server executable does not exist: ' + serverPath);
  const artifact = {
    requestedPath: serverPath,
    bytes: fs.statSync(serverPath).size,
    sha256: await sha256File(serverPath),
    platform: process.platform,
    arch: process.arch,
    staged: true,
    workerIsolation: 'standalone-rust-artifact',
  };
  const staged = stageStandaloneArtifact(serverPath);
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportType: REPORT_TYPE,
    workloadVersion: WORKLOAD_VERSION,
    startedAt,
    finishedAt: null,
    elapsedMs: null,
    lane: options.iterationsExplicit || (options.minutesExplicit && options.minutes !== DEFAULT_MINUTES) ? 'smoke' : 'final',
    repository: gitIdentity(ROOT),
    artifact,
    configuration: {
      requestedMinutes: options.minutes,
      requestedIterations: options.iterations,
      mode: options.iterations > 0 ? 'iterations' : 'duration',
      sampleIntervalMs: options.sampleMs,
      operationTimeoutMs: options.timeoutMs,
      restartEvery: options.restartEvery,
      iterationDelayMs: options.delayMs,
      seed: options.seed,
    },
    workload: {
      version: WORKLOAD_VERSION,
      documentCount: 3,
      queryMethods: QUERY_METHODS.slice(),
      lifecycle: ['initialize', 'initialized', 'shutdown', 'exit'],
      documentOperations: ['didOpen', 'didChange(full)', 'didChange(range)', 'didSave', 'didClose'],
      cancellation: 'every second query request receives $/cancelRequest immediately',
      restart: 'fresh isolated Rust process every restartEvery iterations',
    },
    counters: {
      iterations: 0,
      sessions: 0,
      restarts: 0,
      messagesSent: 0,
      notificationsSent: 0,
      requestsSent: 0,
      cancelRequestsSent: 0,
      queryResponses: 0,
      expectedQueryErrors: 0,
      queryResults: 0,
      unexpectedResponses: 0,
      cleanLifecycles: 0,
      deadlocks: 0,
      timeouts: 0,
      orphanedProcesses: 0,
      protocolErrors: 0,
      unexpectedExits: 0,
    },
    sessions: [],
    rss: { source: 'server-process', sampleAttempts: 0, unavailableSampleCount: 0, numericSampleCount: 0, peakRssBytes: null, samples: [], growth: null },
    passCriteria: null,
    passed: false,
    errors: [],
  };
  let session = null;
  let sessionNumber = 0;
  const deadline = startedEpoch + options.minutes * 60 * 1000;
  try {
    while (options.iterations > 0 ? report.counters.iterations < options.iterations : Date.now() < deadline) {
      if (!session || report.counters.iterations % options.restartEvery === 0) {
        if (session) await closeSession(session, report);
        sessionNumber += 1;
        report.counters.sessions += 1;
        if (sessionNumber > 1) report.counters.restarts += 1;
        session = new ServerSession(staged.executionPath, options, sessionNumber, report);
        await session.start();
      }
      const iterationNumber = report.counters.iterations + 1;
      await session.runIteration(iterationNumber, options.seed);
      if (options.delayMs > 0) await sleep(options.delayMs);
    }
    if (report.counters.iterations === 0) throw new Error('soak completed zero workload iterations');
  } catch (error) {
    report.errors.push(String(error && error.stack || error));
    if (session) {
      try { await closeSession(session, report); } catch (closeError) { report.errors.push('cleanup: ' + String(closeError && closeError.stack || closeError)); }
      session = null;
    }
  } finally {
    if (session) {
      try { await closeSession(session, report); } catch (error) { report.errors.push('cleanup: ' + String(error && error.stack || error)); }
    }
    report.rss.growth = analyzeGrowth(report.rss.samples, { minimumSamples: 8, windowSize: 4 });
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedEpoch;
    report.passCriteria = buildPassCriteria(report, report.rss.growth);
    report.passed = report.errors.length === 0 && Object.values(report.passCriteria).every(Boolean);
    try { fs.rmSync(staged.directory, { recursive: true, force: true }); } catch (error) { report.errors.push('failed to remove staged artifact: ' + String(error && error.message || error)); report.passed = false; }
  }
  return report;
}

async function closeSession(session, report) {
  const sampleStart = session.rssStartIndex;
  const result = await session.stop();
  const samples = report.rss.samples.slice(sampleStart);
  const rssValues = samples.map(sample => sample.rssBytes).filter(Number.isFinite);
  const clean = Boolean(result.exit && result.exit.code === 0 && !result.exit.signal && result.orphanGone && !result.forced && !session.protocolError);
  if (clean) report.counters.cleanLifecycles += 1;
  report.sessions.push({
    session: session.sessionNumber,
    pid: result.pid,
    rssSampleCount: rssValues.length,
    startRssBytes: rssValues.length ? rssValues[0] : null,
    endRssBytes: rssValues.length ? rssValues[rssValues.length - 1] : null,
    peakRssBytes: rssValues.length ? Math.max(...rssValues) : null,
    exit: result.exit,
    forcedTermination: result.forced,
    orphanCheck: { rootPidGone: result.orphanGone, method: 'server-process-pid-after-graceful-exit' },
    serverRequests: result.serverRequests,
    stderr: result.stderr,
    clean,
  });
}

function writeReport(output, report) {
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
  return target;
}

async function main(argv) {
  const options = parseArgs(argv || process.argv.slice(2));
  if (options.help) { console.log(usage()); return 0; }
  let report;
  try {
    report = await run(options);
  } catch (error) {
    console.error('Rust LSP soak setup failed: ' + String(error && error.stack || error));
    return 1;
  }
  const output = writeReport(options.output, report);
  console.log(JSON.stringify({ report: output, lane: report.lane, iterations: report.counters.iterations, sessions: report.counters.sessions, peakServerRssBytes: report.rss.peakRssBytes, passed: report.passed }, null, 2));
  if (!report.passed) {
    console.error('Rust LSP soak failed. Verify: node tools/benchmarks/verify-rust-lsp-soak.cjs --report ' + output);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

module.exports = { DEFAULT_MINUTES, QUERY_METHODS, analyzeGrowth, buildPassCriteria, makeDocuments, parseArgs, run, serverRssBytes, main };
