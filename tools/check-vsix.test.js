'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { REQUIRED, validateVsix } = require('./check-vsix.js');

async function make(entries) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(entries)) zip.file(name, Buffer.from(bytes));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-vsix-test-')), 'test.vsix');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release', 'package.json'), 'utf8'));
  const pe = Buffer.alloc(72); pe[0] = 0x4d; pe[1] = 0x5a; pe.writeUInt32LE(64, 0x3c); pe.write('PE\0\0', 64, 'binary'); pe.writeUInt16LE(0x8664, 68);
  const elf = Buffer.alloc(20); elf[0] = 0x7f; elf.write('ELF', 1, 'ascii'); elf[4] = 2; elf.writeUInt16LE(0x3e, 18);
  const macho = Buffer.alloc(8); Buffer.from('cffaedfe', 'hex').copy(macho); macho.writeUInt32LE(0x01000007, 4);
  const valid = {
    'extension/bin/server/win-x64/CWTools Server.exe': pe,
    'extension/bin/server/linux-x64/CWTools Server': elf,
    'extension/bin/server/osx-x64/CWTools Server': macho,
    'extension/package.json': Buffer.from(JSON.stringify({ version: manifest.version })),
    'extension/readme.md': Buffer.from('readme'),
    'extension/rules/stellaris-rules.zip': Buffer.from('zip'),
    'extension/rules/stellaris-rules.version.json': Buffer.from('{}'),
  };
  assert.deepStrictEqual((await validateVsix(await make(valid))).errors, []);
  const missing = { ...valid }; delete missing[Object.keys(REQUIRED)[1]];
  assert((await validateVsix(await make(missing))).errors.some(error => error.includes('missing')));
  const dotnet = { ...valid, 'extension/bin/server/win-x64/Legacy.dll': [1] };
  assert((await validateVsix(await make(dotnet))).errors.some(error => error.includes('forbidden')));
  const copied = { ...valid, 'extension/bin/server/linux-x64/CWTools Server': valid['extension/bin/server/win-x64/CWTools Server.exe'] };
  assert((await validateVsix(await make(copied))).errors.some(error => error.includes('signature')));
  console.log('Universal VSIX gate regression tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
