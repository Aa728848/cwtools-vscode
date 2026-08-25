#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const SERVER_ROOT = path.join(RELEASE, 'bin', 'server');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'universal-server');
const PLATFORMS = {
  'win-x64': 'CWTools Server.exe',
  'linux-x64': 'CWTools Server',
  'osx-x64': 'CWTools Server',
};

function run(command, args, options = {}) {
  console.log('> ' + command + ' ' + args.join(' '));
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error(label + ' is missing or empty: ' + file);
  }
}

function collectArtifacts(sourceRoot = ARTIFACT_ROOT) {
  if (path.resolve(sourceRoot) === path.resolve(SERVER_ROOT)) throw new Error('Artifact source must be separate from release/bin/server');
  const sources = Object.fromEntries(Object.entries(PLATFORMS).map(([rid, executable]) => {
    const candidates = [
      path.join(sourceRoot, rid, executable),
      path.join(sourceRoot, 'cwtools-server-' + rid, executable),
      path.join(sourceRoot, executable),
    ];
    const source = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0);
    if (!source) throw new Error('Missing native artifact for ' + rid + '. Expected one of: ' + candidates.join(', '));
    return [rid, source];
  }));
  fs.rmSync(SERVER_ROOT, { recursive: true, force: true });
  for (const [rid, executable] of Object.entries(PLATFORMS)) {
    const source = sources[rid];
    const destination = path.join(SERVER_ROOT, rid, executable);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    if (rid !== 'win-x64') fs.chmodSync(destination, 0o755);
  }
}

function latestVsix() {
  const files = fs.readdirSync(RELEASE)
    .filter(name => name.endsWith('.vsix'))
    .map(name => ({ name, file: path.join(RELEASE, name), mtime: fs.statSync(path.join(RELEASE, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error('VSCE did not create a VSIX');
  return files[0].file;
}

function main() {
  const args = process.argv.slice(2);
  const downloadIndex = args.indexOf('--download-run');
  const sourceIndex = args.indexOf('--artifacts');
  if (downloadIndex >= 0) {
    const runId = args[downloadIndex + 1];
    if (!runId || runId.startsWith('--')) throw new Error('--download-run requires a GitHub Actions run id');
    fs.rmSync(ARTIFACT_ROOT, { recursive: true, force: true });
    fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
    run('gh', ['run', 'download', runId, '--repo', 'Aa728848/cwtools-vscode', '--pattern', 'cwtools-server-*', '--dir', ARTIFACT_ROOT]);
  }
  const sourceRoot = sourceIndex >= 0 ? path.resolve(ROOT, args[sourceIndex + 1] || '') : ARTIFACT_ROOT;
  collectArtifacts(sourceRoot);
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'compile']);
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:docs']);
  run(process.execPath, [path.join('tools', 'check-rust-only.cjs')]);
  run(process.execPath, [path.join('tools', 'check-release.js'), '--skip-compile', '--skip-test']);
  for (const name of fs.readdirSync(RELEASE)) if (name.endsWith('.vsix')) fs.rmSync(path.join(RELEASE, name));
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['@vscode/vsce', 'package'], { cwd: RELEASE });
  const vsix = latestVsix();
  run(process.execPath, [path.join('tools', 'check-vsix.js'), '--vsix', vsix]);
  console.log('Universal VSIX ready: ' + vsix);
}

try { main(); }
catch (error) { console.error('Universal packaging failed: ' + (error && error.message || error)); process.exit(1); }
