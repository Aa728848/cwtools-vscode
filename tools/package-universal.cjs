#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, platforms, sha256, validateNativeBytes, stagedPath, validateStagedServers } = require('./release-platforms.cjs');
const RELEASE = path.join(ROOT, 'release');
const SERVER_ROOT = path.join(RELEASE, 'bin', 'server');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'universal-server');
function run(command, args, options = {}) { console.log('> ' + command + ' ' + args.join(' ')); const shell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'); execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', shell, ...options }); }
function output(command, args) { return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
function requireFile(file, label) { if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(label + ' is missing or empty: ' + file); }
function collectArtifacts(sourceRoot, expectedSha) {
  if (path.resolve(sourceRoot) === path.resolve(SERVER_ROOT)) throw new Error('Artifact source must be separate from release/bin/server');
  const collected = [];
  for (const platform of platforms) {
    const dir = path.join(sourceRoot, platform.artifact); const binary = path.join(dir, platform.stagedBinary); const manifestFile = path.join(dir, 'artifact-manifest.json');
    requireFile(binary, platform.rid + ' binary'); requireFile(manifestFile, platform.rid + ' provenance manifest');
    const provenance = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); const bytes = fs.readFileSync(binary);
    const expected = { schemaVersion: 1, rid: platform.rid, target: platform.target, artifact: platform.artifact, stagedBinary: platform.stagedBinary };
    for (const [key, value] of Object.entries(expected)) if (provenance[key] !== value) throw new Error(platform.rid + ' provenance mismatch for ' + key);
    if (!/^[0-9a-f]{40}$/i.test(provenance.sourceSha) || provenance.sourceSha.toLowerCase() !== expectedSha.toLowerCase()) throw new Error(platform.rid + ' source SHA does not match package commit');
    if (provenance.sha256 !== sha256(bytes) || provenance.size !== bytes.length) throw new Error(platform.rid + ' artifact checksum/size mismatch');
    if (!validateNativeBytes(platform, bytes)) throw new Error(platform.rid + ' binary format mismatch');
    const entries = fs.readdirSync(dir).sort(); if (JSON.stringify(entries) !== JSON.stringify([platform.stagedBinary, 'artifact-manifest.json'].sort())) throw new Error(platform.rid + ' artifact contains unexpected files: ' + entries.join(', '));
    collected.push({ platform, binary });
  }
  fs.rmSync(SERVER_ROOT, { recursive: true, force: true });
  for (const item of collected) { const destination = stagedPath(item.platform); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(item.binary, destination); if (item.platform.rid !== 'win-x64') fs.chmodSync(destination, 0o755); }
  const errors = validateStagedServers(RELEASE); if (errors.length) throw new Error('Staged server gate failed:\n- ' + errors.join('\n- '));
  const releaseProvenance = { schemaVersion: 1, sourceSha: expectedSha.toLowerCase(), platforms: platforms.map(platform => { const bytes = fs.readFileSync(stagedPath(platform)); return { rid: platform.rid, target: platform.target, stagedBinary: platform.stagedBinary, size: bytes.length, sha256: sha256(bytes) }; }) };
  fs.writeFileSync(path.join(RELEASE, 'release-provenance.json'), JSON.stringify(releaseProvenance, null, 2) + '\n');
}
function main() {
  const args = process.argv.slice(2); const downloadIndex = args.indexOf('--download-run'); const sourceIndex = args.indexOf('--artifacts');
  if (downloadIndex >= 0) { const runId = args[downloadIndex + 1]; if (!runId || runId.startsWith('--')) throw new Error('--download-run requires a GitHub Actions run id'); fs.rmSync(ARTIFACT_ROOT, { recursive: true, force: true }); fs.mkdirSync(ARTIFACT_ROOT, { recursive: true }); for (const platform of platforms) run('gh', ['run', 'download', runId, '--repo', 'Aa728848/cwtools-vscode', '--name', platform.artifact, '--dir', path.join(ARTIFACT_ROOT, platform.artifact)]); }
  const sourceRoot = sourceIndex >= 0 ? path.resolve(ROOT, args[sourceIndex + 1] || '') : ARTIFACT_ROOT; const sourceSha = process.env.GITHUB_SHA || output('git', ['rev-parse', 'HEAD']); collectArtifacts(sourceRoot, sourceSha);
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'compile']); run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:docs']); run(process.execPath, [path.join('tools', 'check-rust-only.cjs')]); run(process.execPath, [path.join('tools', 'check-release.js'), '--skip-compile', '--skip-test']);
  for (const name of fs.readdirSync(RELEASE)) if (name.endsWith('.vsix') || name.endsWith('.sha256')) fs.rmSync(path.join(RELEASE, name));
  const pkg = JSON.parse(fs.readFileSync(path.join(RELEASE, 'package.json'), 'utf8')); const expectedName = 'foreverskywalker-stellaris-cwtools-' + pkg.version + '.vsix';
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    run(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: RELEASE });
    run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['@vscode/vsce', 'package', '--out', expectedName], { cwd: RELEASE });
  } finally {
    fs.rmSync(path.join(RELEASE, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(path.join(RELEASE, 'package-lock.json'), { force: true });
  }
  const vsix = path.join(RELEASE, expectedName); requireFile(vsix, 'versioned VSIX'); const candidates = fs.readdirSync(RELEASE).filter(name => name.endsWith('.vsix')); if (candidates.length !== 1 || candidates[0] !== expectedName) throw new Error('Expected exactly one deterministic VSIX: ' + expectedName);
  run(process.execPath, [path.join('tools', 'check-vsix.js'), '--vsix', vsix, '--source-sha', sourceSha]); const digest = sha256(fs.readFileSync(vsix)); fs.writeFileSync(vsix + '.sha256', digest + '  ' + expectedName + '\n'); console.log('Universal VSIX ready: ' + vsix + ' sha256=' + digest);
}
try { main(); } catch (error) { console.error('Universal packaging failed: ' + (error && error.message || error)); process.exit(1); }
