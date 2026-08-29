/** @type {import('@vscode/test-cli').IBaseTestConfiguration} */
module.exports = {
  version: '1.93.1',
  extensionDevelopmentPath: '../release',
  files: ['../release/bin/client/test/suite/overlayE2e.test.js'],
  workspaceFolder: '../release/bin/client/test/sample',
  launchArgs: ['../client/test/sample/events/irm.txt']
};
