#!/usr/bin/env node
/**
 * Build the VSIX overview README.
 *
 * VS Code renders a single README.md in the extension details page, while
 * package.nls*.json only localizes manifest contribution strings. Keep the
 * packaged overview bilingual by composing the English and Chinese root docs.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const readmeEnPath = path.join(root, 'README_EN.md');
const readmeZhPath = path.join(root, 'README.md');
const releaseReadmePath = path.join(releaseDir, 'README.md');

function readRequired(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Required README source not found: ${path.relative(root, filePath)}`);
    }
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function demoteHeadings(markdown) {
    let inFence = false;
    return markdown
        .split('\n')
        .map(line => {
            if (/^\s*```/.test(line)) {
                inFence = !inFence;
                return line;
            }
            if (!inFence && /^(#{1,5})(\s+)/.test(line)) {
                return line.replace(/^(#{1,5})(\s+)/, '#$1$2');
            }
            return line;
        })
        .join('\n')
        .trim();
}

const english = demoteHeadings(readRequired(readmeEnPath));
const chinese = demoteHeadings(readRequired(readmeZhPath));

const output = `# Stellaris Language Serves

[English](#english) | [中文](#zh-cn)

> This VSIX overview intentionally includes both English and Simplified Chinese because VS Code renders one packaged \`README.md\` in the extension details page.
>
> 由于 VS Code 扩展详情页只渲染打包内的一份 \`README.md\`，因此这里同时提供英文与简体中文介绍。

<a id="english"></a>

## English

${english}

---

<a id="zh-cn"></a>

## 中文

${chinese}
`;

fs.mkdirSync(releaseDir, { recursive: true });
fs.writeFileSync(releaseReadmePath, output.replace(/\n/g, '\r\n'), 'utf8');
console.log(`Built bilingual release README: ${path.relative(root, releaseReadmePath)}`);
