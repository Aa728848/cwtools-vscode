#!/usr/bin/env node
/**
 * Validate single-source bilingual Markdown documents.
 *
 * Canonical bilingual docs maintain English and Chinese sections in one file
 * (no separate _EN / _ZH copies). This script enforces required markers,
 * matching section structure, and guards against stale `blob/master/` links.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');

const canonicalDocs = [
    'README.md',
    'CONTRIBUTING.md',
    'ARCHITECTURE.md',
    'docs/cwt-rule-config.md',
    'docs/marketplace-readme.md',
];

function normalize(markdown) {
    return markdown.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function readRequired(relativePath) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Required documentation file not found: ${relativePath}`);
    }
    return normalize(fs.readFileSync(filePath, 'utf8'));
}

function countSubheadings(section) {
    let inFence = false;
    let count = 0;
    for (const line of section.split('\n')) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (!inFence && /^#{3,4}\s+/.test(line)) {
            count++;
        }
    }
    return count;
}

function validateBilingualDoc(relativePath) {
    const content = readRequired(relativePath);
    const required = [
        '<a id="english"></a>',
        '<a id="zh-cn"></a>',
        '## English',
        '## 中文',
    ];
    for (const marker of required) {
        if (!content.includes(marker)) {
            throw new Error(`${relativePath} is missing bilingual marker: ${marker}`);
        }
    }

    if (content.includes('github.com/Aa728848/cwtools-vscode/blob/master/')) {
        throw new Error(`${relativePath} contains stale blob/master/ links (use blob/main/)`);
    }

    const enStart = content.indexOf('## English');
    const zhStart = content.indexOf('## 中文');
    if (zhStart <= enStart) {
        throw new Error(`${relativePath} must place ## English before ## 中文`);
    }

    const enCount = countSubheadings(content.slice(enStart, zhStart));
    const zhCount = countSubheadings(content.slice(zhStart));
    if (enCount !== zhCount) {
        throw new Error(
            `${relativePath} has mismatched bilingual heading counts (EN: ${enCount}, ZH: ${zhCount})`
        );
    }
}

for (const doc of canonicalDocs) {
    validateBilingualDoc(doc);
}

if (checkOnly) {
    console.log('Single-source bilingual documentation is valid.');
} else {
    console.log('Single-source bilingual documentation checked.');
}
