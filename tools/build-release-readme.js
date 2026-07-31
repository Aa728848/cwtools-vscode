#!/usr/bin/env node
/**
 * Build the VSIX overview README from the root bilingual README.md.
 *
 * VS Code renders a single README.md in the extension details page, while
 * package.nls*.json only localizes manifest contribution strings. The root
 * README.md is the single bilingual source of truth.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const sourceReadmePath = path.join(root, 'README.md');
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

function marketplaceReadme(markdown) {
    let output = markdown;

    output = output.replace(
        /^\[English\]\(#english\).*$/m,
        '[English](#english) | [中文](#zh-cn) | [CWT Rule Guide / CWT 规则指南](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/cwt-rule-config.md) | [Diagnostic Codes / 诊断码](https://github.com/Aa728848/cwtools-vscode/blob/master/docs/diagnostic-codes.md)'
    );

    output = output.replaceAll(
        '[.agents/workflows/package.md](./.agents/workflows/package.md)',
        '[.agents/workflows/package.md](https://github.com/Aa728848/cwtools-vscode/blob/master/.agents/workflows/package.md)'
    );

    output = output.replaceAll(
        '(docs/cwt-rule-config.md)',
        '(https://github.com/Aa728848/cwtools-vscode/blob/master/docs/cwt-rule-config.md)'
    );

    output = output.replaceAll(
        '(docs/diagnostic-codes.md)',
        '(https://github.com/Aa728848/cwtools-vscode/blob/master/docs/diagnostic-codes.md)'
    );

    return normalize(output);
}

const source = readRequired(sourceReadmePath);
validateBilingualReadme(source);

fs.mkdirSync(releaseDir, { recursive: true });
fs.writeFileSync(releaseReadmePath, marketplaceReadme(source).replace(/\n/g, '\r\n'), 'utf8');
console.log(`Built release README from root README.md: ${path.relative(root, releaseReadmePath)}`);
