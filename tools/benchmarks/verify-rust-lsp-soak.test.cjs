'use strict';
const assert = require('assert');
const { verifyReport } = require('./verify-rust-lsp-soak.cjs');
function identity(root, commit) { return { root, commit, tree: commit + '-tree', workingTree: 'clean' }; }
function report() {
  const repositories = ['root', 'core', 'mcp', 'mcp-rules', 'rules'].map((root, index) => identity(root, 'c' + index));
  return {
    schemaVersion: 1, reportType: 'cwtools.rust-lsp-soak', workloadVersion: 'v',
    startedAt: new Date(0).toISOString(), finishedAt: new Date(86400000).toISOString(), elapsedMs: 86400000, lane: 'final',
    repository: repositories[0], repositories,
    artifact: { requestedPath: 'server', bytes: 1, sha256: 'a'.repeat(64), staged: true, workerIsolation: 'standalone-rust-artifact' },
    completionIdentity: { repository: { ...repositories[0] }, repositories: repositories.map(value => ({ ...value })), artifactSha256: 'a'.repeat(64) },
    configuration: { requestedMinutes: 1440, requestedIterations: 0, sampleIntervalMs: 1000 },
    workload: { queryMethods: ['a', 'b', 'c', 'd', 'e'], documentOperations: ['didChange'], lifecycle: ['initialize', 'initialized', 'shutdown', 'exit'], cancellation: 'cancel' },
    counters: { iterations: 100, sessions: 2, restarts: 1, messagesSent: 1, notificationsSent: 1, requestsSent: 1, cancelRequestsSent: 100, queryResponses: 1, expectedQueryErrors: 0, queryResults: 1, unexpectedResponses: 0, cleanLifecycles: 2, deadlocks: 0, timeouts: 0, orphanedProcesses: 0, protocolErrors: 0, unexpectedExits: 0 },
    sessions: [1, 2].map(session => ({ session, pid: session, clean: true, forcedTermination: false, orphanCheck: { rootPidGone: true }, exit: { code: 0, signal: null } })),
    rss: { source: 'server-process', sampleAttempts: 100, unavailableSampleCount: 0, numericSampleCount: 100, peakRssBytes: 1, samples: Array.from({ length: 100 }, () => ({ source: 'server-process', pid: 1, rssBytes: 1 })), growth: { detected: false, passed: true } },
    passCriteria: { finalLaneUsesExactly1440Minutes: true, rustOnlyStagedArtifact: true, allRequestedIterationsCompleted: true, lifecycleAndRestartClean: true, noDeadlockOrTimeout: true, noOrphanedServerProcess: true, noProtocolErrors: true, serverRssSampled: true, noSustainedServerRssGrowth: true },
    passed: true, errors: [],
  };
}
assert.deepStrictEqual(verifyReport(report(), { final: true, checkArtifact: false }), []);
const dirty = report(); dirty.completionIdentity.repository.workingTree = 'dirty'; assert(verifyReport(dirty, { final: true }).some(error => error.includes('repository identity drifted')));
const nested = report(); nested.completionIdentity.repositories[2].commit = 'changed'; assert(verifyReport(nested, { final: true }).some(error => error.includes('nested repository identity drifted')));
const changed = report(); changed.completionIdentity.artifactSha256 = 'b'.repeat(64); assert(verifyReport(changed, { final: true }).some(error => error.includes('artifact changed')));
const short = report(); short.elapsedMs = 100; assert(verifyReport(short, { final: true }).some(error => error.includes('shorter')));
const sparse = report(); sparse.rss.samples = sparse.rss.samples.slice(0, 99); sparse.rss.sampleAttempts = 99; sparse.rss.numericSampleCount = 99; assert(verifyReport(sparse, { final: true }).some(error => error.includes('at least 100')));
const shallow = report(); shallow.counters.iterations = 99; assert(verifyReport(shallow, { final: true }).some(error => error.includes('at least 100 iterations')));
const tolerated = report(); tolerated.counters.expectedQueryErrors = 1; tolerated.counters.queryResults = 0; assert(verifyReport(tolerated, { final: true }).some(error => error.includes('tolerated protocol errors')));
console.log('Final soak verifier regression tests passed.');
