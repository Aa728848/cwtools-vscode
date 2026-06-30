#!/usr/bin/env node
/**
 * Build the GitHub-facing default Markdown documents.
 *
 * GitHub renders README.md by default, and contributors often open
 * ARCHITECTURE.md directly from repository links. Keep those default entry
 * points bilingual while preserving full English and Chinese source documents.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');

const docs = [
    {
        title: 'Stellaris Language Serves',
        output: 'README.md',
        english: 'README_EN.md',
        chinese: 'README_ZH.md',
        noteEn: 'GitHub renders this file as the repository overview. The full introduction is provided below in both English and Simplified Chinese.',
        noteZh: 'GitHub 默认渲染此文件作为项目介绍。下方同时提供英文与简体中文全文。',
        links: ['[Architecture / 架构文档](ARCHITECTURE.md)'],
    },
    {
        title: 'Architecture / 架构文档',
        output: 'ARCHITECTURE.md',
        english: 'ARCHITECTURE_EN.md',
        chinese: 'ARCHITECTURE_ZH.md',
        noteEn: 'This default architecture entry is bilingual for GitHub readers and linked contributor workflows.',
        noteZh: '此默认架构入口面向 GitHub 阅读与贡献流程，提供英文与简体中文两套内容。',
        links: ['[Project Overview / 项目介绍](README.md)'],
    },
];

function readRequired(relativePath) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Required documentation source not found: ${relativePath}`);
    }
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function demoteHeadings(markdown, levels = 2) {
    let inFence = false;
    const prefix = '#'.repeat(levels);
    return markdown
        .split('\n')
        .map(line => {
            if (/^\s*```/.test(line)) {
                inFence = !inFence;
                return line;
            }
            if (!inFence && /^(#{1,4})(\s+)/.test(line)) {
                return line.replace(/^(#{1,4})(\s+)/, `${prefix}$1$2`);
            }
            return line;
        })
        .join('\n')
        .trim();
}

function compose(doc) {
    const english = demoteHeadings(readRequired(doc.english));
    const chinese = demoteHeadings(readRequired(doc.chinese));
    const links = ['[English](#english)', '[中文](#zh-cn)', ...(doc.links || [])].join(' | ');

    return `# ${doc.title}

${links}

> ${doc.noteEn}
>
> ${doc.noteZh}

<a id="english"></a>

## English

${english}

---

<a id="zh-cn"></a>

## 中文

${chinese}
`;
}

function normalize(markdown) {
    return markdown.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

for (const doc of docs) {
    const outputPath = path.join(root, doc.output);
    const content = normalize(compose(doc));

    if (checkOnly) {
        if (!fs.existsSync(outputPath)) {
            throw new Error(`Generated documentation is missing: ${doc.output}`);
        }
        const current = normalize(fs.readFileSync(outputPath, 'utf8'));
        if (current !== content) {
            throw new Error(`Generated documentation is stale: ${doc.output}`);
        }
        continue;
    }

    fs.writeFileSync(outputPath, content.replace(/\n/g, '\r\n'), 'utf8');
    console.log(`Built bilingual GitHub document: ${doc.output}`);
}

if (checkOnly) {
    console.log('Bilingual GitHub documentation is up to date.');
}
