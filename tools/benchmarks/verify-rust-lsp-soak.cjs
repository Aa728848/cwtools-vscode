#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPORT_SCHEMA_VERSION = 1;
const REPORT_TYPE = 'cwtools.rust-lsp-soak';
const REQUIRED_CRITERIA = [
  'finalLaneUsesExactly1440Minutes',
  'rustOnlyStagedArtifact',
  'allRequestedIterationsCompleted',
  'lifecycleAndRestartClean',
  'noDeadlockOrTimeout',
  'noOrphanedServerProcess',
  'noProtocolErrors',
  'serverRssSampled',
  'noSustainedServerRssGrowth',
];

function usage() {
  return [
    'Usage: node tools/benchmarks/verify-rust-lsp-soak.cjs --report <file> [--final]',
    '  --report <file>  versioned JSON report written by rust-lsp-soak.cjs',
    '  --final          require a completed 1440-minute final-lane report',
  ].join('\\n');
}

function parseArgs(argv) {
  const args = { final: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--final') { args.final = true; continue; }
    if (token === '--help') return { help: true };
    if (token === '--report') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--report requires a file');
      args.report = argv[++index];
      continue;
    }
    if (token.startsWith('--report=')) { args.report = token.slice('--report='.length); continue; }
    throw new Error('Unknown argument: ' + token);
  }
  if (!args.report) throw new Error('--report is required');
  return args;
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value) { return Number.isSafeInteger(value); }
function add(errors, message) { errors.push(message); }

function verifyReport(report, options = {}) {
  const errors = [];
  if (!isObject(report)) return ['report must be a JSON object'];
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) add(errors, 'schemaVersion must be ' + REPORT_SCHEMA_VERSION);
  if (report.reportType !== REPORT_TYPE) add(errors, 'reportType must be ' + REPORT_TYPE);
  if (typeof report.workloadVersion !== 'string' || report.workloadVersion.length === 0) add(errors, 'workloadVersion is required');
  for (const key of ['startedAt', 'finishedAt']) if (typeof report[key] !== 'string' || Number.isNaN(Date.parse(report[key]))) add(errors, key + ' must be an ISO timestamp');
  if (!integer(report.elapsedMs) || report.elapsedMs < 0) add(errors, 'elapsedMs must be a non-negative integer');
  if (!['smoke', 'final'].includes(report.lane)) add(errors, 'lane must be smoke or final');
  if (options.final && report.lane !== 'final') add(errors, '--final requires lane=final');

  if (!isObject(report.repository)) add(errors, 'repository identity is required');
  else {
    for (const key of ['root', 'commit', 'tree', 'workingTree']) if (typeof report.repository[key] !== 'string' || report.repository[key].length === 0) add(errors, 'repository.' + key + ' is required');
    if (!['clean', 'dirty', 'unknown'].includes(report.repository.workingTree)) add(errors, 'repository.workingTree is invalid');
  }

  if (!isObject(report.artifact)) add(errors, 'artifact identity is required');
  else {
    if (typeof report.artifact.requestedPath !== 'string' || report.artifact.requestedPath.length === 0) add(errors, 'artifact.requestedPath is required');
    if (!integer(report.artifact.bytes) || report.artifact.bytes <= 0) add(errors, 'artifact.bytes must be positive');
    if (typeof report.artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(report.artifact.sha256)) add(errors, 'artifact.sha256 must be a SHA-256 hex digest');
    if (report.artifact.staged !== true || report.artifact.workerIsolation !== 'standalone-rust-artifact') add(errors, 'artifact must be a staged standalone Rust server');
  }

  const configuration = report.configuration;
  if (!isObject(configuration)) add(errors, 'configuration is required');
  else {
    if (typeof configuration.requestedMinutes !== 'number' || configuration.requestedMinutes < 0 || configuration.requestedMinutes > 1440) add(errors, 'configuration.requestedMinutes must be 0..1440');
    if (!integer(configuration.requestedIterations) || configuration.requestedIterations < 0) add(errors, 'configuration.requestedIterations must be a non-negative integer');
    if (report.lane === 'final' && (configuration.requestedMinutes !== 1440 || configuration.requestedIterations !== 0)) add(errors, 'final lane must request exactly 1440 minutes with no iteration override');
    if (typeof configuration.sampleIntervalMs !== 'number' || configuration.sampleIntervalMs < 50) add(errors, 'configuration.sampleIntervalMs is invalid');
  }

  const workload = report.workload;
  if (!isObject(workload)) add(errors, 'workload description is required');
  else {
    if (!Array.isArray(workload.queryMethods) || workload.queryMethods.length < 5) add(errors, 'workload must include mixed query methods');
    if (!Array.isArray(workload.documentOperations) || !workload.documentOperations.some(value => String(value).includes('didChange'))) add(errors, 'workload must include document edits');
    if (!Array.isArray(workload.lifecycle) || workload.lifecycle.join(',') !== 'initialize,initialized,shutdown,exit') add(errors, 'workload lifecycle is incomplete');
    if (typeof workload.cancellation !== 'string' || !workload.cancellation.includes('cancel')) add(errors, 'workload cancellation description is required');
  }

  const counters = report.counters;
  if (!isObject(counters)) add(errors, 'counters are required');
  else {
    const keys = ['iterations', 'sessions', 'restarts', 'messagesSent', 'notificationsSent', 'requestsSent', 'cancelRequestsSent', 'queryResponses', 'expectedQueryErrors', 'queryResults', 'unexpectedResponses', 'cleanLifecycles', 'deadlocks', 'timeouts', 'orphanedProcesses', 'protocolErrors', 'unexpectedExits'];
    for (const key of keys) if (!integer(counters[key]) || counters[key] < 0) add(errors, 'counters.' + key + ' must be a non-negative integer');
    if (counters.iterations < 1) add(errors, 'at least one iteration is required');
    if (counters.sessions < 1 || counters.cleanLifecycles > counters.sessions) add(errors, 'session counters are inconsistent');
    if (counters.restarts !== Math.max(0, counters.sessions - 1)) add(errors, 'restart counter does not match sessions');
    if (counters.cancelRequestsSent < counters.iterations) add(errors, 'cancellation workload was not exercised');
    if (counters.queryResponses !== counters.queryResults + counters.expectedQueryErrors) add(errors, 'query response accounting is inconsistent');
  }

  if (!Array.isArray(report.sessions) || !counters || report.sessions.length !== counters.sessions) add(errors, 'session records must match session counter');
  else for (const session of report.sessions) {
    if (!isObject(session) || !integer(session.session) || !integer(session.pid) || session.pid <= 0) add(errors, 'session identity is invalid');
    if (session.clean !== true || session.forcedTermination === true || session.orphanCheck?.rootPidGone !== true) add(errors, 'session contains an unclean lifecycle/orphan result');
    if (session.exit?.code !== 0 || session.exit?.signal !== null) add(errors, 'session did not exit cleanly');
  }

  const rss = report.rss;
  if (!isObject(rss)) add(errors, 'RSS report is required');
  else {
    if (rss.source !== 'server-process') add(errors, 'RSS source must be server-process, never Node memory');
    for (const key of ['sampleAttempts', 'unavailableSampleCount', 'numericSampleCount']) if (!integer(rss[key]) || rss[key] < 0) add(errors, 'rss.' + key + ' must be a non-negative integer');
    if (!Array.isArray(rss.samples) || rss.samples.length !== rss.numericSampleCount) add(errors, 'RSS sample count is inconsistent');
    if (rss.numericSampleCount < 8) add(errors, 'at least eight server RSS samples are required');
    if (!integer(rss.peakRssBytes) || rss.peakRssBytes <= 0) add(errors, 'peak server RSS is required');
    if (Array.isArray(rss.samples)) for (const sample of rss.samples) {
      if (!isObject(sample) || sample.source !== 'server-process' || !integer(sample.pid) || !integer(sample.rssBytes) || sample.rssBytes <= 0) add(errors, 'invalid server RSS sample');
    }
    if (!isObject(rss.growth) || rss.growth.detected === true || rss.growth.passed !== true) add(errors, 'sustained server RSS growth criterion failed or is missing');
  }

  if (!isObject(report.passCriteria)) add(errors, 'passCriteria is required');
  else for (const key of REQUIRED_CRITERIA) if (report.passCriteria[key] !== true) add(errors, 'pass criterion failed: ' + key);
  if (report.passed !== true) add(errors, 'report.passed is not true');
  if (Array.isArray(report.errors) && report.errors.length > 0) add(errors, 'report contains runtime errors');
  if (options.final && report.elapsedMs < 1440 * 60 * 1000) add(errors, 'final report elapsedMs is shorter than 1440 minutes');
  if (report.lane === 'final' && (!isObject(report.repository) || report.repository.workingTree !== 'clean')) add(errors, 'final report must identify a clean repository');
  return errors;
}

function main(argv) {
  const options = parseArgs(argv || process.argv.slice(2));
  if (options.help) { console.log(usage()); return 0; }
  const reportPath = path.resolve(options.report);
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (error) { console.error('Cannot read report: ' + String(error && error.message || error)); return 1; }
  const errors = verifyReport(report, options);
  console.log(JSON.stringify({ report: reportPath, schemaVersion: report.schemaVersion, lane: report.lane, passed: errors.length === 0, errors }, null, 2));
  return errors.length === 0 ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error('Verification failed: ' + String(error && error.stack || error)); process.exitCode = 1; }
}

module.exports = { REQUIRED_CRITERIA, verifyReport };
