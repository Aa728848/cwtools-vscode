#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

function killProcess(child) {
  if (!child || !child.pid || child.killed) return;
  try {
    if (isWin) {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Process might already be exited
  }
}

const npxCmd = isWin ? 'npx.cmd' : 'npx';

const tsc = spawn(npxCmd, ['tsc', '-w', '-p', '.'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: isWin,
});

const vscTest = spawn(npxCmd, ['vscode-test', '--config', './.config/vscode-test.js', '-w'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: isWin,
});

let cleaningUp = false;
function cleanup(code = 0) {
  if (cleaningUp) return;
  cleaningUp = true;
  killProcess(tsc);
  killProcess(vscTest);
  process.exit(code);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('exit', () => cleanup(0));

tsc.on('exit', (code) => {
  if (!cleaningUp && code !== 0 && code !== null) {
    cleanup(code);
  }
});

vscTest.on('exit', (code) => {
  if (!cleaningUp && code !== 0 && code !== null) {
    cleanup(code);
  }
});
