/** @type {import('@vscode/test-cli').IBaseTestConfiguration} */
const fs = require('fs');
const path = require('path');

const gameSampleRoot = path.resolve(__dirname, '..', 'client', 'test', 'cwt-game-sample');
const userDataDir = path.resolve(__dirname, '..', '.vscode-test', 'cwt-game-user-data');
const userSettingsDir = path.join(userDataDir, 'User');

fs.mkdirSync(userSettingsDir, { recursive: true });
fs.writeFileSync(path.join(userSettingsDir, 'settings.json'), JSON.stringify({
  'files.associations': {
    '*.txt': 'stellaris',
    '*.gui': 'stellaris',
    '*.gfx': 'stellaris',
    '*.asset': 'stellaris',
    '*.cwt': 'cwt',
  },
  'stellarisLanguageServices.rules_version': 'manual',
  'stellarisLanguageServices.rules_folder': path.join(gameSampleRoot, 'config'),
}, null, 2));

module.exports = {
  vscode: 'stable',
  extensionDevelopmentPath: '../release',
  files: '../release/bin/client/test/suite/cwtGameActivation.test.js',
  workspaceFolder: gameSampleRoot,
  launchArgs: [
    // A `.txt` game-script file opens first; the workspace has a game exe, so
    // the server starts in full mode (Custom game without vanilla data).
    path.join(gameSampleRoot, 'game', 'common', 'technology', 'techs.txt'),
    '--disable-extensions',
    `--user-data-dir=${userDataDir}`,
  ],
  mocha: {
    timeout: 300000,
  },
};
