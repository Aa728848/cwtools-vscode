#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const REQUIRED = {
  'extension/bin/server/win-x64/CWTools Server.exe': buffer => {
    if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return false;
    const pe = buffer.readUInt32LE(0x3c);
    return pe + 6 <= buffer.length && buffer.subarray(pe, pe + 4).equals(Buffer.from('PE\0\0')) && buffer.readUInt16LE(pe + 4) === 0x8664;
  },
  'extension/bin/server/linux-x64/CWTools Server': buffer => buffer.length >= 20 && buffer[0] === 0x7f && buffer.subarray(1, 4).toString('ascii') === 'ELF' && buffer[4] === 2 && buffer.readUInt16LE(18) === 0x3e,
  'extension/bin/server/osx-x64/CWTools Server': buffer => buffer.length >= 8 && buffer.subarray(0, 4).toString('hex') === 'cffaedfe' && buffer.readUInt32LE(4) === 0x01000007,
};
const FORBIDDEN = /(?:^|\/)(?:server-rust|src\/Main|src\/LSP|CWToolsTests|oracle|differential|sidecar)(?:\/|$)|\.(?:dll|deps\.json|runtimeconfig\.json|fs|fsx|fsproj|cs|csproj|sln|slnx)$/i;

async function validateVsix(vsixPath) {
  const archive = await JSZip.loadAsync(fs.readFileSync(vsixPath));
  const names = Object.keys(archive.files).filter(name => !archive.files[name].dir);
  const errors = [];
  const hashes = new Set();
  for (const [name, signature] of Object.entries(REQUIRED)) {
    const entry = archive.file(name);
    if (!entry) { errors.push('missing ' + name); continue; }
    const buffer = await entry.async('nodebuffer');
    if (buffer.length === 0) errors.push('empty ' + name);
    else if (!signature(buffer)) errors.push('invalid native executable signature for ' + name);
    hashes.add(crypto.createHash('sha256').update(buffer).digest('hex'));
  }
  if (hashes.size !== Object.keys(REQUIRED).length) errors.push('native server artifacts are not three distinct binaries');
  for (const name of names) if (FORBIDDEN.test(name)) errors.push('forbidden migration/.NET artifact: ' + name);
  const serverFiles = names.filter(name => name.startsWith('extension/bin/server/'));
  for (const name of serverFiles) if (!Object.hasOwn(REQUIRED, name)) errors.push('unexpected server artifact: ' + name);
  if (names.some(name => name.startsWith('extension/bin/mcp/'))) errors.push('MCP must not be bundled in the universal VSIX');
  for (const required of ['extension/package.json', 'extension/readme.md', 'extension/rules/stellaris-rules.zip', 'extension/rules/stellaris-rules.version.json']) {
    if (!archive.file(required)) errors.push('missing ' + required);
  }
  const packageEntry = archive.file('extension/package.json');
  if (packageEntry) {
    const manifest = JSON.parse(await packageEntry.async('string'));
    const rootManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release', 'package.json'), 'utf8'));
    if (manifest.version !== rootManifest.version) errors.push('VSIX version does not match release/package.json');
  }
  return { errors, names, serverFiles };
}

async function main(argv) {
  const index = argv.indexOf('--vsix');
  const vsixPath = index >= 0 ? argv[index + 1] : undefined;
  if (!vsixPath || vsixPath.startsWith('--')) throw new Error('--vsix requires a file');
  const absolute = path.resolve(vsixPath);
  if (!fs.existsSync(absolute)) throw new Error('VSIX not found: ' + absolute);
  const result = await validateVsix(absolute);
  if (result.errors.length) {
    for (const error of result.errors) console.error('FAIL: ' + error);
    return 1;
  }
  console.log('Universal VSIX gate passed: three distinct native Rust servers and no migration/.NET runtime artifacts.');
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message || error); process.exitCode = 1; });
module.exports = { REQUIRED, validateVsix };
