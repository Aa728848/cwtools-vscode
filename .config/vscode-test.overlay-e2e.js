/** @type {import('@vscode/test-cli').IBaseTestConfiguration} */
module.exports = {
  vscode: 'stable',
  extensionDevelopmentPath: '../release',
  files: ['../release/bin/client/test/suite/overlayE2e.test.js'],
  workspaceFolder: '../release/bin/client/test/sample',
  launchArgs: ['../client/test/sample/events/irm.txt']
};
