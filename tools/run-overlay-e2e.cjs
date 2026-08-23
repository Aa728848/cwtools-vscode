const { spawnSync } = require('child_process');
const path = require('path');

function platformTarget(platform = process.platform, arch = process.arch) {
  const ridArch = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return { rid: `win-${ridArch}`, folder: `win-${ridArch}` };
  if (platform === 'darwin') return { rid: `osx-${ridArch}`, folder: `osx-${ridArch}` };
  if (platform === 'linux') return { rid: `linux-${ridArch}`, folder: `linux-${ridArch}` };
  throw new Error(`Unsupported overlay E2E platform: ${platform}/${arch}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}

if (require.main === module) {
  const target = platformTarget();
  run('npm', ['run', 'compile']);
  run('npx', ['tsc', '-p', './.config/tsconfig.test-build.json']);
  run('node', ['tools/copy-test-fixtures.js']);
  run('dotnet', ['publish', 'src/Main/Main.fsproj', '--configuration', 'Release', '--runtime', target.rid, '--self-contained', 'true', '-p:PublishReadyToRun=false', '-p:UseLocalCwtools=false', '--output', `release/bin/server/${target.folder}`]);
  run('npx', ['vscode-test', '--config', './.config/vscode-test.overlay-e2e.js']);
}

module.exports = { platformTarget };
