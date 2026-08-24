#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const manifest = path.join(root, 'submodules', 'cwtools', 'Cargo.toml');
const started = process.hrtime.bigint();
const result = spawnSync('cargo', ['test', '--manifest-path', manifest, '-p', 'cwtools-script-syntax', 'deterministic_fuzz_never_panics_or_exceeds_input_bound', '--release', '--quiet'], { cwd: root, encoding: 'utf8', windowsHide: true });
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
if (result.status !== 0) throw new Error(result.stderr);
const report = { schemaVersion: 1, cases: 10000, elapsedMs, maxElapsedMs: 5000, passed: elapsedMs < 5000, timestamp: new Date().toISOString() };
console.log(JSON.stringify(report, null, 2));
const output = path.join(root, 'benchmarks', 'reference', 'parser-fuzz-smoke.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
