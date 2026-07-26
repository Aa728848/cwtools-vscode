/** @type {import('@vscode/test-cli').IBaseTestConfiguration} */
const path = require('path');

module.exports = {
  vscode: 'stable',
  extensionDevelopmentPath: 'release',
  files: './release/bin/client/test/suite/shaderLanguage.test.js',
  workspaceFolder: './client/test/shader-sample',
  launchArgs: [
    '--disable-extensions',
  ],
  env: {
    CWTOOLS_SHADER_TEST_RULES_FOLDER: path.resolve(__dirname, 'submodules', 'cwtools-stellaris-config', 'config'),
  },
  mocha: {
    timeout: 120000,
  },
};
