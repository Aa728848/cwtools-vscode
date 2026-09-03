
const localCode = process.env.VSCODE_EXECUTABLE_PATH;

/** @type {import('@vscode/test-cli').IDesktopTestConfiguration} */
module.exports = {
  ...(localCode ? { useInstallation: { fromPath: localCode } } : { version: '1.93.1' }),
  extensionDevelopmentPath: "../release",
  files: [
    // The shader contract suite needs its own settings/env (see .vscode-test.shader.js),
    // so it is kept out of the default `npm test` run.
    '../release/bin/client/test/suite/completion.test.js',
    '../release/bin/client/test/suite/hover.test.js',
    '../release/bin/client/test/suite/folding.test.js',
    '../release/bin/client/test/suite/extension.test.js',
  ],
  workspaceFolder: "../release/bin/client/test/sample",
  launchArgs: [
    // Bring the file under test into the workspace
    '../client/test/sample/events/irm.txt'
  ]
}
