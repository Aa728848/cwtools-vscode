'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const violations = [];
const ignoredDirectories = new Set(['.git', '.codegraph', 'node_modules', 'target', 'artifacts', '.vscode-test']);
const forbiddenExtensions = new Set(['.fs', '.fsx', '.fsproj', '.cs', '.csproj', '.sln', '.slnx']);
const forbiddenRootFiles = new Set(['global.json', 'Directory.Build.props', 'Directory.Packages.props']);
const forbiddenFileNames = new Set(['dotnet.config', 'test.runsettings', 'capture-lsp-trace.ps1', 'rules-validation-performance.cjs', 'parser-performance.cjs']);
const forbiddenFileNamePatterns = [/(?:^|[-_])fsharp(?:$|[-_.])/i, /(?:^|[-_])oracle(?:$|[-_.])/i, /(?:structural-diff|projection-cli)/i];
const forbiddenDirectoryNames = [
  /(?:^|[-_])fsharp(?:$|[-_])/i,
  /(?:^|[-_])oracle(?:$|[-_])/i,
  /^differential$/i,
];

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function walk(directory, visit) {
  if (!fs.existsSync(directory)) return;
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      visit(full, entry, true);
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full, entry, false);
    }
  }
}

walk(root, (full, entry, isDirectory) => {
  const rel = relative(full);
  if (rel.startsWith('release/')) return;
  if (isDirectory) {
    if (forbiddenDirectoryNames.some(pattern => pattern.test(entry.name))) {
      violations.push({ kind: 'migration-directory', path: rel });
    }
    return;
  }
  if (forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) {
    violations.push({ kind: 'dotnet-source', path: rel });
  }
  if ((!rel.includes('/') && forbiddenRootFiles.has(entry.name)) || forbiddenFileNames.has(entry.name)) {
    violations.push({ kind: 'dotnet-build-metadata', path: rel });
  }
  if (forbiddenFileNamePatterns.some(pattern => pattern.test(entry.name))) {
    violations.push({ kind: 'migration-file', path: rel });
  }
  if (rel === 'rust/cwtools-lsp/src/proxy.rs' || rel === 'client/extension/serverImplementation.ts') {
    violations.push({ kind: 'migration-runtime', path: rel });
  }
  if (rel === 'docs/fsharp-to-rust-migration-plan.md') {
    violations.push({ kind: 'migration-plan', path: rel });
  }
});

const releaseForbiddenExtensions = new Set([
  '.dll', '.pdb', '.deps.json', '.runtimeconfig.json', '.so', '.dylib',
]);
walk(release, (full, entry, isDirectory) => {
  const rel = relative(full);
  if (isDirectory) {
    if (rel === 'release/bin/server-rust') violations.push({ kind: 'sidecar-layout', path: rel });
    return;
  }
  const lower = entry.name.toLowerCase();
  if (releaseForbiddenExtensions.has(path.extname(lower))
      || lower.endsWith('.deps.json') || lower.endsWith('.runtimeconfig.json')
      || lower === 'fsharp.core.dll' || lower.includes('coreclr') || lower.includes('hostfxr')) {
    violations.push({ kind: 'dotnet-release-artifact', path: rel });
  }
});

const runtimeFiles = [
  path.join(root, 'client', 'extension', 'extension.ts'),
  path.join(root, 'package.ps1'),
  path.join(root, 'tools', 'check-release.js'),
  path.join(root, 'rust', 'cwtools-lsp', 'src', 'main.rs'),
  path.join(root, 'rust', 'cwtools-lsp', 'src', 'lib.rs'),
];
const forbiddenRuntimePatterns = [
  ['implementation-selector', /CWTOOLS_SERVER_IMPLEMENTATION|ServerImplementation|server-rust/i],
  ['fsharp-worker', /CWTOOLS_FSHARP_WORKER|F# worker|resolve_worker|run_proxy/i],
  ['dotnet-build', /dotnet\s+(?:build|publish|fsi)|\.fsproj/i],
];
for (const file of runtimeFiles) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const [kind, pattern] of forbiddenRuntimePatterns) {
    if (pattern.test(text)) violations.push({ kind, path: relative(file) });
  }
}

violations.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
if (violations.length > 0) {
  console.error('Rust-only gate failed:');
  for (const item of violations) console.error('  - ' + item.kind + ': ' + item.path);
  console.error('Total violations: ' + violations.length);
  process.exit(1);
}
console.log('Rust-only gate passed: repository and release runtime contain no migration/.NET backend artifacts.');
