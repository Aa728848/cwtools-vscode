#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, byRid, sha256, validateNativeBytes } = require('./release-platforms.cjs');
function arg(name) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : undefined; }
const rid = arg('rid');
const platform = byRid.get(rid);
if (!platform) throw new Error('Unknown or missing --rid: ' + String(rid));
const binaryArg = arg('binary'); const outputArg = arg('output');
if (!binaryArg || !outputArg) throw new Error('--binary and --output are required');
const binary = path.resolve(ROOT, binaryArg); const output = path.resolve(ROOT, outputArg);
const sourceSha = arg('source-sha');
if (!sourceSha || !/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('--source-sha must be a full commit SHA');
if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) throw new Error('Binary not found: ' + binary);
const bytes = fs.readFileSync(binary);
if (!validateNativeBytes(platform, bytes)) throw new Error('Binary does not match ' + platform.format + ': ' + binary);
const rustc = execFileSync('rustc', ['--version', '--verbose'], { encoding: 'utf8' }).trim();
const artifact = { schemaVersion: 1, rid: platform.rid, target: platform.target, artifact: platform.artifact, stagedBinary: platform.stagedBinary, sourceSha: sourceSha.toLowerCase(), rustc, size: bytes.length, sha256: sha256(bytes) };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n');
console.log('Wrote release artifact manifest: ' + output);
