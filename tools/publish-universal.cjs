#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, sha256 } = require('./release-platforms.cjs');
const RELEASE = path.join(ROOT, 'release');
const REPOSITORY = 'Aa728848/cwtools-vscode';
function run(command, args) { console.log('> ' + command + ' ' + args.join(' ')); execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' }); }
function output(command, args) { return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
function main() {
  if (output('git', ['status', '--porcelain'])) throw new Error('Refusing to publish from a dirty working tree.');
  const pkg = JSON.parse(fs.readFileSync(path.join(RELEASE, 'package.json'), 'utf8')); const tag = 'v' + pkg.version; const head = output('git', ['rev-parse', 'HEAD']); const tagHead = output('git', ['rev-list', '-n', '1', tag]); if (tagHead !== head) throw new Error(tag + ' does not point to current HEAD ' + head);
  const expectedName = 'foreverskywalker-stellaris-cwtools-' + pkg.version + '.vsix'; const candidates = fs.readdirSync(RELEASE).filter(name => name.endsWith('.vsix')); if (candidates.length !== 1 || candidates[0] !== expectedName) throw new Error('Expected exactly one immutable VSIX named ' + expectedName);
  const vsix = path.join(RELEASE, expectedName); const checksumFile = vsix + '.sha256'; if (!fs.existsSync(checksumFile)) throw new Error('Missing immutable checksum: ' + checksumFile); const expectedDigest = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0]; const actualDigest = sha256(fs.readFileSync(vsix)); if (!/^[0-9a-f]{64}$/.test(expectedDigest) || expectedDigest !== actualDigest) throw new Error('VSIX checksum mismatch');
  run(process.execPath, [path.join('tools', 'check-vsix.js'), '--vsix', vsix, '--source-sha', head]);
  run('git', ['push', 'origin', 'HEAD:main', tag]); run('gh', ['release', 'create', tag, vsix, checksumFile, '--repo', REPOSITORY, '--verify-tag', '--title', tag, '--generate-notes']); console.log('Published verified universal VSIX: ' + vsix + ' sha256=' + actualDigest);
}
try { main(); } catch (error) { console.error('Universal publication refused: ' + (error && error.message || error)); process.exit(1); }
