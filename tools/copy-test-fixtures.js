/**
 * Copies the Extension Host integration-test fixtures (client/test/sample) into the
 * compiled test output, so `npm test` works from a clean checkout where
 * `release/bin` does not exist yet. `tsc` only emits TS sources, so the fixture
 * workspace must be copied explicitly.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../client/test/sample');
const dest = path.resolve(__dirname, '../release/bin/client/test/sample');

fs.cpSync(src, dest, { recursive: true, force: true });

// The fixture workspace needs the vendored rules to be configured before the
// extension activates; the sample repo no longer carries a `.vscode/settings.json`
// (editor config does not belong in mod data), so create it here with the
// machine-independent rules path, mirroring what .vscode-test.shader.js does.
// Language associations point at the Stellaris language ID (not the generic
// `paradox` fallback) because this is a Stellaris fixture workspace.
const settingsPath = path.join(dest, '.vscode', 'settings.json');
const rulesRoot = path.resolve(__dirname, '../submodules/cwtools-stellaris-config/config');
let settings = {
    'files.associations': {
        '*.txt': 'stellaris',
        '*.gui': 'stellaris',
        '*.gfx': 'stellaris',
        '*.asset': 'stellaris',
        '*.cwt': 'stellaris',
        '*.mesh': 'plaintext',
    },
};
if (fs.existsSync(settingsPath)) {
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (!settings['files.associations']) settings['files.associations'] = {};
    } catch {
        // fall back to the default shape below
    }
}
settings['files.associations']['*.txt'] = 'stellaris';
settings['files.associations']['*.gui'] = 'stellaris';
settings['files.associations']['*.gfx'] = 'stellaris';
settings['files.associations']['*.asset'] = 'stellaris';
settings['files.associations']['*.cwt'] = 'stellaris';
settings['stellarisLanguageServices.rules_version'] = 'manual';
settings['stellarisLanguageServices.rules_folder'] = rulesRoot;
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');

console.log(`[copy-test-fixtures] ${src} -> ${dest}`);
