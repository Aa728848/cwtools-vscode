#!/usr/bin/env node
/**
 * Build the VSIX overview README from the dedicated Marketplace source.
 *
 * VS Code renders a single README.md in the extension details page, while
 * package.nls*.json only localizes manifest contribution strings. Keep the
 * repository README focused on contributors and the Marketplace source focused
 * on extension users.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const sourceReadmePath = path.join(root, 'docs', 'marketplace-readme.md');
const releaseReadmePath = path.join(releaseDir, 'README.md');

function normalize(markdown) {
    return markdown.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function readRequired(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Required README source not found: ${path.relative(root, filePath)}`);
    }
    return normalize(fs.readFileSync(filePath, 'utf8'));
}

function validateBilingualReadme(markdown) {
    for (const marker of ['<a id="english"></a>', '<a id="zh-cn"></a>', '## English', '## 中文']) {
        if (!markdown.includes(marker)) {
            throw new Error(`README.md is missing bilingual marker: ${marker}`);
        }
    }
}

const source = readRequired(sourceReadmePath);
validateBilingualReadme(source);

fs.mkdirSync(releaseDir, { recursive: true });
fs.writeFileSync(releaseReadmePath, normalize(source).replace(/\n/g, '\r\n'), 'utf8');
console.log(`Built release README from Marketplace source: ${path.relative(root, sourceReadmePath)}`);
