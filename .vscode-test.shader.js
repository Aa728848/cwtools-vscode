/** @type {import('@vscode/test-cli').IBaseTestConfiguration} */
const fs = require('fs');
const path = require('path');

const shaderRulesFolder = path.resolve(__dirname, 'submodules', 'cwtools-stellaris-config', 'config');
const shaderUserDataDir = path.resolve(__dirname, '.vscode-test', 'shader-user-data');
const shaderUserSettingsDir = path.join(shaderUserDataDir, 'User');

fs.mkdirSync(shaderUserSettingsDir, { recursive: true });
fs.writeFileSync(path.join(shaderUserSettingsDir, 'settings.json'), JSON.stringify({
  'stellarisLanguageServices.rules_folder': shaderRulesFolder,
  'stellarisLanguageServices.rules_version': 'manual',
}, null, 2));

module.exports = {
  vscode: 'stable',
  extensionDevelopmentPath: 'release',
  files: './release/bin/client/test/suite/shaderLanguage.test.js',
  workspaceFolder: './client/test/shader-sample',
  launchArgs: [
    '--disable-extensions',
    `--user-data-dir=${shaderUserDataDir}`,
  ],
  env: {
    CWTOOLS_SHADER_TEST_RULES_FOLDER: shaderRulesFolder,
  },
  mocha: {
    timeout: 120000,
  },
};
