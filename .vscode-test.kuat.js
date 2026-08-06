const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Opt-in real-project benchmark configuration.
 *
 * Set CWTOOLS_BENCHMARK_WORKSPACE to an authorized Stellaris mod root. The
 * regular test suite never opens or writes that workspace.
 * @type {import('@vscode/test-cli').IBaseTestConfiguration}
 */
const benchmarkRoot = process.env.CWTOOLS_BENCHMARK_WORKSPACE;
if (!benchmarkRoot || !fs.statSync(benchmarkRoot).isDirectory()) {
  throw new Error('CWTOOLS_BENCHMARK_WORKSPACE must name an existing directory.');
}
// A .code-workspace file avoids VS Code's ambiguous handling of absolute
// Windows folder arguments containing spaces. The benchmark itself still
// rejects the run unless its first folder resolves to benchmarkRoot.
const workspaceFile = path.join(os.tmpdir(), 'cwtools-kuat-benchmark.code-workspace');
fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: path.resolve(benchmarkRoot) }] }), 'utf8');

module.exports = {
  version: 'stable',
  extensionDevelopmentPath: 'release',
  files: './release/bin/client/test/suite/kuatBenchmark.test.js',
  workspaceFolder: workspaceFile,
};
