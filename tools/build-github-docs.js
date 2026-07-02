#!/usr/bin/env node
/**
 * Validate the single-source bilingual Markdown documents.
 *
 * README.md, CONTRIBUTING.md, ARCHITECTURE.md, and selected docs under docs/
 * are canonical bilingual sources. There are no maintained language-specific
 * copies.
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
}

for (const doc of canonicalDocs) {
    validateBilingualDoc(doc);
}

if (checkOnly) {
    console.log('Single-source bilingual documentation is valid.');
} else {
    console.log('Single-source bilingual documentation checked.');
}
