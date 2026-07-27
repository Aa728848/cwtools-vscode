import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near '${key ?? ''}'.`);
    values.set(key.slice(2), value);
  }
  return values;
}

const args = readArgs(process.argv.slice(2));
const root = resolve(args.get('root') ?? '');
const serverPath = resolve(args.get('server') ?? '');
const rulesFolder = resolve(args.get('rules') ?? '');
const cacheFolder = resolve(args.get('cache') ?? '.tmp/lsp-memory-profile-cache/stellaris');
const holdMs = Number.parseInt(args.get('hold-ms') ?? '300000', 10);
const iterations = Number.parseInt(args.get('iterations') ?? '0', 10);
const iterationDelayMs = Number.parseInt(args.get('iteration-delay-ms') ?? '250', 10);
const editFileArg = args.get('edit-file');
const editFile = editFileArg ? resolve(root, editFileArg) : null;

for (const [name, value] of [['root', root], ['server', serverPath], ['rules', rulesFolder]]) {
  if (!existsSync(value)) throw new Error(`${name} path does not exist: ${value}`);
}
if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error(`Invalid --hold-ms value: ${holdMs}`);
if (!Number.isFinite(iterations) || iterations < 0) throw new Error(`Invalid --iterations value: ${iterations}`);
if (!Number.isFinite(iterationDelayMs) || iterationDelayMs < 0) throw new Error(`Invalid --iteration-delay-ms value: ${iterationDelayMs}`);
if (iterations > 0 && (!editFile || !existsSync(editFile))) {
  throw new Error(`--edit-file must identify an existing workspace file when --iterations is positive: ${editFile ?? ''}`);
}

const rootUri = pathToFileURL(root).href;
const server = spawn(serverPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const startedAt = performance.now();
let input = Buffer.alloc(0);
let nextRequestId = 2;
let ready = false;
let publishedDiagnosticFiles = 0;
let publishedDiagnostics = 0;
let shutdownStarted = false;

console.log(`CWTools LSP PID=${server.pid}`);
console.log(`Workspace=${root}`);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.stdin.write(body);
}

function shutdown() {
  if (shutdownStarted || server.killed) return;
  shutdownStarted = true;
  const id = nextRequestId++;
  send({ jsonrpc: '2.0', id, method: 'shutdown', params: null });
  setTimeout(() => {
    send({ jsonrpc: '2.0', method: 'exit', params: null });
    setTimeout(() => server.kill(), 2000).unref();
  }, 500).unref();
}

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

async function runEditSequence() {
  if (iterations === 0 || !editFile) return;
  const uri = pathToFileURL(editFile).href;
  const original = readFileSync(editFile, 'utf8').replace(/\r?\n# cwtools-lsp-memory-profile-[01]\s*$/u, '');
  send({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'paradox', version: 0, text: original } },
  });
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const text = `${original}\n# cwtools-lsp-memory-profile-${iteration % 2}`;
    send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: iteration },
        contentChanges: [{ text }],
      },
    });
    send({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri } } });
    send({
      jsonrpc: '2.0',
      id: nextRequestId++,
      method: 'textDocument/completion',
      params: { textDocument: { uri }, position: { line: 0, character: 0 }, context: { triggerKind: 1 } },
    });
    if (iteration % 10 === 0 || iteration === iterations) {
      console.log(`EDIT_PROGRESS iteration=${iteration}/${iterations}`);
    }
    await delay(iterationDelayMs);
  }
  send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
  console.log(`EDIT_COMPLETE iterations=${iterations} settleMs=${holdMs}`);
}

function handleMessage(message) {
  if (message.id === 1 && Object.hasOwn(message, 'result')) {
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: {
        settings: {
          stellarisLanguageServices: {
            localisation: { languages: ['English'] },
            errors: { vanilla: false, ignore: [], ignorefiles: [] },
            diagnostics: { deferDynamicParameterDiagnostics: true },
            cache: { stellaris: '' },
            rules_version: 'manual',
            rules_folder: rulesFolder,
            ignore_patterns: [],
            experimental: false,
            debug_mode: false,
            maxFileSize: 2,
            showInlineText: false,
          },
        },
      },
    });
    return;
  }

  if (message.method === 'cwtools/serverReady') {
    ready = true;
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log(`SERVER_READY elapsedMs=${elapsedMs} diagnostics=${publishedDiagnostics} files=${publishedDiagnosticFiles}`);
    runEditSequence()
      .then(() => {
        if (holdMs === 0) shutdown();
        else setTimeout(shutdown, holdMs).unref();
      })
      .catch(error => {
        console.error(error);
        process.exitCode = 1;
        shutdown();
      });
    return;
  }

  if (message.method === 'textDocument/publishDiagnostics') {
    publishedDiagnosticFiles += 1;
    publishedDiagnostics += Array.isArray(message.params?.diagnostics) ? message.params.diagnostics.length : 0;
    if (publishedDiagnosticFiles % 500 === 0) {
      console.log(`DIAGNOSTICS files=${publishedDiagnosticFiles} count=${publishedDiagnostics}`);
    }
    return;
  }

  if (message.method === 'updateFileList') {
    console.log(`FILES count=${message.params?.fileList?.length ?? 0}`);
    return;
  }

  if (message.method === 'monitorLog') {
    const category = message.params?.category ?? 'General';
    const text = message.params?.message ?? '';
    if (category === 'Memory' || category === 'Validation' || category === 'Loading' || category === 'Performance' || category === 'Refresh') {
      console.log(`[${category}] ${text}`);
    }
    return;
  }

  if (message.id !== undefined && message.method) {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  }
}

server.stdout.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const headerEnd = input.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString('ascii');
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
    if (!match) throw new Error(`Missing Content-Length header: ${header}`);
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const body = input.subarray(bodyStart, bodyStart + length).toString('utf8');
    input = input.subarray(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
});

let stderrRemainder = '';
server.stderr.on('data', chunk => {
  const lines = `${stderrRemainder}${chunk.toString('utf8')}`.split(/\r?\n/);
  stderrRemainder = lines.pop() ?? '';
  for (const line of lines) {
    if (/memory|alloc|cache|validat|load|error|exception/i.test(line)) console.error(`[server] ${line}`);
  }
});

server.on('exit', (code, signal) => {
  if (stderrRemainder) console.error(`[server] ${stderrRemainder}`);
  console.log(`CWTools LSP exited code=${code ?? 'null'} signal=${signal ?? 'null'} ready=${ready}`);
  process.exitCode = code === 0 || shutdownStarted ? 0 : 1;
});

server.on('error', error => {
  console.error(error);
  process.exitCode = 1;
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: basename(root) }],
    capabilities: {
      workspace: { configuration: true },
      textDocument: { completion: { completionItem: { insertReplaceSupport: true } } },
    },
    initializationOptions: {
      language: 'stellaris',
      uiLanguage: 'en',
      // The profiler measures the workspace itself and does not require a prebuilt vanilla .cwb.
      isVanillaFolder: true,
      rulesCache: cacheFolder,
      bundledRulesPath: rulesFolder,
      rules_version: 'manual',
      diagnosticLogging: true,
      defaultRepoPath: null,
      repoPath: null,
    },
  },
});
