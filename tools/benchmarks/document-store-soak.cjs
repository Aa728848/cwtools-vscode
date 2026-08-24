#!/usr/bin/env node
'use strict';

// Compatibility entrypoint retained for callers of the old migration-only
// loop. The production implementation is the standalone Rust LSP workload.
const { main } = require('./rust-lsp-soak.cjs');

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = require('./rust-lsp-soak.cjs');
