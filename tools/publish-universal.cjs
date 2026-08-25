#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const REPOSITORY = 'Aa728848/cwtools-vscode';

function run(command, args) {
  console.log('> ' + command + ' ' + args.join(' '));
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

function output(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function main() {
  const status = output('git', ['status', '--porcelain']);
  if (status) throw new Error('Refusing to publish from a dirty working tree. Commit and push the exact verified release first.');
  const packageJson = JSON.parse(fs.readFileSync(path.join(RELEASE, 'package.json'), 'utf8'));
  const tag = 'v' + packageJson.version;
  const head = output('git', ['rev-parse', 'HEAD']);
  const tagHead = output('git', ['rev-list', '-n', '1', tag]);
  if (tagHead !== head) throw new Error(tag + ' does not point to current HEAD ' + head);
  const expectedSuffix = '-' + packageJson.version + '.vsix';
  const candidates = fs.readdirSync(RELEASE).filter(name => name.endsWith(expectedSuffix));
  if (candidates.length !== 1) throw new Error('Expected exactly one version-matched VSIX, found: ' + candidates.join(', '));
  const vsix = path.join(RELEASE, candidates[0]);
  run(process.execPath, [path.join('tools', 'check-vsix.js'), '--vsix', vsix]);
  run('git', ['push', 'origin', 'HEAD:main', tag]);
  run('gh', ['release', 'create', tag, vsix, '--repo', REPOSITORY, '--verify-tag', '--title', tag, '--generate-notes']);
  console.log('Published verified universal VSIX: ' + vsix);
}

try { main(); }
catch (error) { console.error('Universal publication refused: ' + (error && error.message || error)); process.exit(1); }
