#!/usr/bin/env node
/**
 * Release Quality Gate — Pre-publish Checks
 *
 * Verifies the project is in a releasable state:
 *   1.  Root & release manifest version sync
 *   2.  CHANGELOG entry for current version
 *   3.  Required files present (README, LICENSE, etc.)
 *   4.  No hardcoded secrets or localhost URLs in source
 *   5.  TypeScript compiles cleanly
 *   6.  Unit tests pass
 *   7.  Release manifest is valid JSON
 *   8.  NLS key completeness (package.nls.json ↔ package.nls.zh.json)
 *   9.  Webview bundles exist and are non-empty
 *   10. Server binaries exist for all platforms
 *
 * Usage: node tools/check-release.js [--skip-compile] [--skip-test]
 * Exit code 0 = all checks passed, 1 = at least one failure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const FAIL = '\x1b[31m✗\x1b[0m';
const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';

const args = process.argv.slice(2);
const skipCompile = args.includes('--skip-compile');
const skipTest = args.includes('--skip-test');
const hostOnly = args.includes('--host-only');

let failures = 0;
let warnings = 0;

function check(label, fn) {
    try {
        const result = fn();
        if (result === true) {
            console.log(`  ${PASS} ${label}`);
        } else if (result === 'warn') {
            console.log(`  ${WARN} ${label}`);
            warnings++;
        } else {
            console.log(`  ${FAIL} ${label}`);
            failures++;
        }
    } catch (e) {
        console.log(`  ${FAIL} ${label}: ${e.message}`);
        failures++;
    }
}

console.log('\n🔍 Release Quality Gate\n');

// ── 1. Version Sync ─────────────────────────────────────────────────────────

check('Root package.json version matches release/package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const relPkgPath = path.join(RELEASE, 'package.json');
    if (!fs.existsSync(relPkgPath)) return 'warn';
    const relPkg = JSON.parse(fs.readFileSync(relPkgPath, 'utf-8'));
    const rootVersion = pkg.version;
    const releaseVersion = relPkg.version;
    if (!rootVersion) return false;
    if (!releaseVersion) return 'warn';
    if (rootVersion !== releaseVersion) {
        console.log(`    Root: ${rootVersion} ≠ Release: ${releaseVersion} — run version sync before publishing`);
        return 'warn';
    }
    return true;
});

// ── 2. CHANGELOG Entry ──────────────────────────────────────────────────────

check('CHANGELOG has entry for current version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const version = pkg.version;
    // Check both root and release changelog
    for (const dir of [ROOT, RELEASE]) {
        const clPath = path.join(dir, 'CHANGELOG.md');
        if (fs.existsSync(clPath)) {
            const cl = fs.readFileSync(clPath, 'utf-8');
            if (cl.includes(version)) return true;
        }
    }
    return 'warn';
});

// ── 3. Required Files ───────────────────────────────────────────────────────

const REQUIRED_FILES = [
    'README.md',
    // Root may have CHANGELOG.md or it may live only in release/
    // LICENSE may be LICENSE.md at root
];
// Also check that at least one of these pairs exists
const REQUIRED_PAIRS = [
    { files: ['CHANGELOG.md', 'release/CHANGELOG.md'], label: 'CHANGELOG' },
    { files: ['LICENSE', 'LICENSE.md', 'release/LICENSE.md'], label: 'LICENSE' },
];

for (const file of REQUIRED_FILES) {
    check(`Required file exists: ${file}`, () => {
        const filePath = path.join(ROOT, file);
        if (!fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        return stat.size > 0;
    });
}

for (const pair of REQUIRED_PAIRS) {
    check(`Required file exists: ${pair.label}`, () => {
        for (const file of pair.files) {
            const filePath = path.join(ROOT, file);
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return true;
        }
        return false;
    });
}

check('Release README includes English and Chinese overview sections', () => {
    const releaseReadmePath = path.join(RELEASE, 'README.md');
    if (!fs.existsSync(releaseReadmePath)) return false;
    const readme = fs.readFileSync(releaseReadmePath, 'utf-8');
    return readme.includes('<a id="english"></a>')
        && readme.includes('<a id="zh-cn"></a>')
        && readme.includes('## English')
        && readme.includes('## 中文');
});

check('Release README matches the dedicated Marketplace source', () => {
    const sourcePath = path.join(ROOT, 'docs', 'marketplace-readme.md');
    const releaseReadmePath = path.join(RELEASE, 'README.md');
    if (!fs.existsSync(sourcePath) || !fs.existsSync(releaseReadmePath)) return false;
    const normalize = content => content.replace(/\r\n/g, '\n').trimEnd();
    return normalize(fs.readFileSync(sourcePath, 'utf-8'))
        === normalize(fs.readFileSync(releaseReadmePath, 'utf-8'));
});

check('Single-source bilingual docs are valid', () => {
    try {
        execSync('node tools/build-github-docs.js --check', { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
        return true;
    } catch (e) {
        const stdout = e.stdout ? e.stdout.toString().trim() : '';
        const stderr = e.stderr ? e.stderr.toString().trim() : '';
        if (stdout) console.log(`    ${stdout}`);
        if (stderr) console.log(`    ${stderr}`);
        return false;
    }
});

// ── 4. No Secrets or Localhost URLs ─────────────────────────────────────────

check('No hardcoded localhost URLs or API keys in extension source', () => {
    const srcDir = path.join(ROOT, 'client', 'extension');
    if (!fs.existsSync(srcDir)) return true;

    const patterns = [
        /http:\/\/localhost/,
        /127\.0\.0\.1:\d/,
        /sk-[a-zA-Z0-9]{20,}/,
    ];

    const tsFiles = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'node_modules') {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                tsFiles.push(full);
            }
        }
    }
    walk(srcDir);

    for (const file of tsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const pattern of patterns) {
            if (pattern.test(content)) {
                // Whitelist: Ollama/local provider default endpoints
                if (content.includes('// localhost is expected for local providers')) continue;
                if (content.includes('ollama') || content.includes('Ollama')) continue;
                if (content.includes('localEndpoint') || content.includes('localProvider')) continue;
                // Whitelist: provider configuration with localhost defaults
                const rel = path.relative(ROOT, file);
                if (rel.includes('aiService') || rel.includes('providers')) continue;
                // Browser OAuth requires a registered loopback redirect. Keep the
                // exception exact so unrelated extension code cannot hide localhost URLs.
                if (rel.replace(/\\/g, '/') === 'client/extension/ai/codex/oauthService.ts'
                    && content.includes('OAUTH_CALLBACK_PATH')
                    && content.includes('OAUTH_REDIRECT_URI')) continue;
                console.log(`    Found: ${pattern.source} in ${rel}`);
                return false;
            }
        }
    }
    return true;
});

// ── 5. TypeScript Compilation ───────────────────────────────────────────────

if (skipCompile) {
    console.log(`  ${WARN} TypeScript compilation [SKIPPED]`);
    warnings++;
} else {
    check('TypeScript compiles cleanly', () => {
        try {
            execSync('npm run compile', { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
            return true;
        } catch (e) {
            const stderr = e.stderr ? e.stderr.toString().slice(0, 500) : '';
            if (stderr) console.log(`    ${stderr}`);
            return false;
        }
    });
}

// ── 6. Unit Tests ───────────────────────────────────────────────────────────

if (skipTest) {
    console.log(`  ${WARN} Unit tests [SKIPPED]`);
    warnings++;
} else {
    check('Unit tests pass', () => {
        try {
            execSync('npm run test:unit', { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
            return true;
        } catch (e) {
            const stdout = e.stdout ? e.stdout.toString().slice(-500) : '';
            if (stdout) console.log(`    ${stdout}`);
            return false;
        }
    });
}

// ── 7. Release Manifest Integrity ───────────────────────────────────────────

check('Release manifest (release/package.json) is valid JSON', () => {
    const manifestPath = path.join(RELEASE, 'package.json');
    if (!fs.existsSync(manifestPath)) return 'warn';
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        // Basic sanity: must have a name and version
        if (!manifest.name || !manifest.version) {
            console.log('    Missing name or version in release manifest');
            return false;
        }
        return true;
    } catch {
        return false;
    }
});

check('Release manifest avoids protected VS Code keybindings', () => {
    const manifestPath = path.join(RELEASE, 'package.json');
    if (!fs.existsSync(manifestPath)) return 'warn';
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const keybindings = Array.isArray(manifest.contributes?.keybindings)
        ? manifest.contributes.keybindings
        : [];
    const protectedKeys = new Set([
        'ctrl+shift+e', 'cmd+shift+e',
        'ctrl+shift+f', 'cmd+shift+f',
        'ctrl+shift+r', 'cmd+shift+r',
    ]);
    const renameCommands = new Set([
        '-acceptRenameInput',
        'acceptRenameInput',
        '-acceptRenameInputWithPreview',
        'acceptRenameInputWithPreview',
    ]);
    const violations = [];

    for (const binding of keybindings) {
        const command = String(binding?.command ?? '');
        const keys = [binding?.key, binding?.mac, binding?.win, binding?.linux]
            .filter(value => typeof value === 'string')
            .map(value => value.toLowerCase().replace(/\s+/g, ''));
        if (renameCommands.has(command) || keys.some(key => protectedKeys.has(key))) {
            violations.push(`${command}: ${keys.join(' / ') || '(no key)'}`);
            continue;
        }
        if (keys.some(key => key === 'ctrl+shift+i' || key === 'cmd+shift+i')) {
            const when = String(binding?.when ?? '');
            const safelyScoped = command === 'cwtools.ai.manageIgnoredDiagnostics'
                && when.includes('editorTextFocus')
                && when.includes('config.stellarisLanguageServices.ai.enabled');
            if (!safelyScoped) violations.push(`${command}: ${keys.join(' / ')}`);
        }
        if (keys.some(key => key === 'ctrl+l' || key === 'cmd+l')) {
            const when = String(binding?.when ?? '');
            const safelyScoped = command === 'cwtools.ai.sendSelectionToChat'
                && when.includes('editorTextFocus')
                && when.includes('editorHasSelection')
                && when.includes('config.stellarisLanguageServices.ai.enabled');
            if (!safelyScoped) violations.push(`${command}: ${keys.join(' / ')}`);
        }
    }

    if (violations.length > 0) {
        console.log(`    Conflicting keybindings: ${violations.join(', ')}`);
        return false;
    }
    return true;
});

// ── 8. NLS Key Completeness ─────────────────────────────────────────────────

check('NLS locale: Simplified Chinese manifest exists', () => {
    return fs.existsSync(path.join(RELEASE, 'package.nls.zh-cn.json'));
});

check('NLS keys: all package.nls locale files are in sync', () => {
    const nlsEnPath = path.join(RELEASE, 'package.nls.json');

    if (!fs.existsSync(nlsEnPath)) {
        console.log('    NLS files not found in release/');
        return 'warn';
    }

    const nlsEn = JSON.parse(fs.readFileSync(nlsEnPath, 'utf-8'));
    const enKeys = new Set(Object.keys(nlsEn));
    const localeFiles = fs.readdirSync(RELEASE)
        .filter(file => /^package\.nls\..+\.json$/.test(file))
        .sort();

    if (localeFiles.length === 0) {
        console.log('    No localized package.nls.*.json files found in release/');
        return 'warn';
    }

    let ok = true;
    for (const localeFile of localeFiles) {
        const localePath = path.join(RELEASE, localeFile);
        const nlsLocale = JSON.parse(fs.readFileSync(localePath, 'utf-8'));
        const localeKeys = new Set(Object.keys(nlsLocale));
        const missingInLocale = [...enKeys].filter(k => !localeKeys.has(k));
        const missingInEn = [...localeKeys].filter(k => !enKeys.has(k));

        if (missingInLocale.length > 0) {
            console.log(`    Missing in ${localeFile}: ${missingInLocale.slice(0, 5).join(', ')}${missingInLocale.length > 5 ? ` (+${missingInLocale.length - 5} more)` : ''}`);
            ok = false;
        }
        if (missingInEn.length > 0) {
            console.log(`    Extra in ${localeFile} (not in en): ${missingInEn.slice(0, 5).join(', ')}${missingInEn.length > 5 ? ` (+${missingInEn.length - 5} more)` : ''}`);
            ok = false;
        }
    }

    return ok;
});

check('NLS keys: manifest references exist in NLS files', () => {
    const manifestPath = path.join(RELEASE, 'package.json');
    const nlsPath = path.join(RELEASE, 'package.nls.json');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(nlsPath)) return 'warn';

    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const nlsKeys = new Set(Object.keys(JSON.parse(fs.readFileSync(nlsPath, 'utf-8'))));

    // Find all %key% references in the manifest
    const refRegex = /%([^%]+)%/g;
    const missing = [];
    let match;
    while ((match = refRegex.exec(manifestContent)) !== null) {
        const key = match[1];
        if (!nlsKeys.has(key)) {
            missing.push(key);
        }
    }

    if (missing.length > 0) {
        console.log(`    Manifest references missing NLS keys: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`);
        return false;
    }
    return true;
});

// ── 9. Webview Bundles ──────────────────────────────────────────────────────

const EXPECTED_WEBVIEW_BUNDLES = [
    'chatPanel.js',
    'entityPreview.js',
    'guiPreview.js',
    'solarSystemPreview.js',
    'eventChainPreview.js',
    'techTreePreview.js',
];

check('Webview bundles exist and are non-empty', () => {
    const webviewDir = path.join(RELEASE, 'bin', 'client', 'webview');
    if (!fs.existsSync(webviewDir)) {
        console.log(`    Directory not found: release/bin/client/webview/`);
        return 'warn';
    }

    const missing = [];
    const empty = [];
    for (const bundle of EXPECTED_WEBVIEW_BUNDLES) {
        const p = path.join(webviewDir, bundle);
        if (!fs.existsSync(p)) {
            missing.push(bundle);
        } else if (fs.statSync(p).size === 0) {
            empty.push(bundle);
        }
    }

    if (missing.length > 0) console.log(`    Missing bundles: ${missing.join(', ')}`);
    if (empty.length > 0) console.log(`    Empty bundles: ${empty.join(', ')}`);
    return missing.length === 0 && empty.length === 0;
});

// ── 10. Server Binaries ─────────────────────────────────────────────────────

const EXPECTED_SERVER_BINARIES = {
    'win-x64': 'CWTools Server.exe',
    'linux-x64': 'CWTools Server',
    'osx-x64': 'CWTools Server',
};

function checkServerTree(relativeDir, required) {
    const serverDir = path.join(RELEASE, 'bin', relativeDir);
    if (!fs.existsSync(serverDir)) {
        console.log(`    Directory not found: release/bin/${relativeDir}/`);
        return required ? false : 'warn';
    }
    const invalid = [];
    for (const [platform, executable] of Object.entries(EXPECTED_SERVER_BINARIES)) {
        const binary = path.join(serverDir, platform, executable);
        if (!fs.existsSync(binary) || !fs.statSync(binary).isFile() || fs.statSync(binary).size === 0) {
            invalid.push(`${platform}/${executable}`);
        }
    }
    if (invalid.length > 0) console.log(`    Missing or empty binaries: ${invalid.join(', ')}`);
    return invalid.length === 0;
}

if (hostOnly) {
    check('Rust server binary exists for the current host', () => {
        const platform = process.platform === 'win32' ? 'win-x64' : process.platform === 'darwin' ? 'osx-x64' : 'linux-x64';
        const executable = EXPECTED_SERVER_BINARIES[platform];
        const binary = path.join(RELEASE, 'bin', 'server', platform, executable);
        return fs.existsSync(binary) && fs.statSync(binary).isFile() && fs.statSync(binary).size > 0;
    });
} else {
    check('Rust server binaries exist for every supported platform', () => checkServerTree('server', true));
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('');
if (failures > 0) {
    console.log(`\x1b[31m❌ ${failures} check(s) failed, ${warnings} warning(s)\x1b[0m`);
    process.exit(1);
} else if (warnings > 0) {
    console.log(`\x1b[33m⚠ All checks passed with ${warnings} warning(s)\x1b[0m`);
    process.exit(0);
} else {
    console.log('\x1b[32m✅ All checks passed — ready to release!\x1b[0m');
    process.exit(0);
}

