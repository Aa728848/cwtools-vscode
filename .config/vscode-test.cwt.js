/** @type {import('@vscode/test-cli').IBaseTestConfiguration} */
module.exports = {
  vscode: 'stable',
  extensionDevelopmentPath: '../release',
  files: '../release/bin/client/test/suite/cwtLanguage.test.js',
  workspaceFolder: '../client/test/cwt-sample',
  launchArgs: [
    // Open the valid CWT fixture so activation sees a `.cwt` document and
    // starts CWT-only mode without any game guessing.
    '../client/test/cwt-sample/config/sample.cwt',
    '--disable-extensions',
  ],
  mocha: {
    timeout: 180000,
  },
};
