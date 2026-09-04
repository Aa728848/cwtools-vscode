const { spawn } = require('child_process');
const path = require('path');

const serverDll = path.resolve(__dirname, '../artifacts/bin/Main/debug/CWTools Server.dll');
console.log(`Testing server initialization against: ${serverDll}`);

const cp = spawn('dotnet', [serverDll, '--clientProcessId', String(process.pid)], {
  stdio: ['pipe', 'pipe', 'inherit']
});

let received = '';

cp.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    console.error(`Server process exited prematurely with code ${code}, signal ${signal}`);
    process.exit(1);
  }
});

const initReq = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    processId: process.pid,
    rootUri: null,
    capabilities: {}
  }
});

const header = `Content-Length: ${Buffer.byteLength(initReq, 'utf8')}\r\n\r\n`;
cp.stdin.write(header + initReq);

const timer = setTimeout(() => {
  console.error('TIMEOUT: Server did not respond to initialize within 10s. Received so far:\n' + received);
  try { cp.kill(); } catch (_) {}
  process.exit(1);
}, 10000);

cp.stdout.on('data', (chunk) => {
  received += chunk.toString();
  if (received.includes('"capabilities"')) {
    clearTimeout(timer);
    console.log('SUCCESS: Real server responded to initialize request with valid JSON capabilities!');
    try { cp.kill(); } catch (_) {}
    process.exit(0);
  }
});
