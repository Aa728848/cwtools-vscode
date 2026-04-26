/**
 * Eddy CWTool Code — /init Command
 *
 * Scans the workspace and generates a CWTOOLS.md project rules file.
 * Mirrors OpenCode's /init command which generates CLAUDE.md.
 * Extracted from chatPanel.ts for maintainability.
 */

import * as vs from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { HostMessage } from './types';

type PostMessageFn = (msg: HostMessage) => void;
type RecordSnapshotFn = (filePath: string) => void;

/**
 * Generate the CWTOOLS.md project rules file by scanning the workspace.
 */
export async function generateInitFile(
    postMessage: PostMessageFn,
    recordFileSnapshot: RecordSnapshotFn
): Promise<void> {
    const folders = vs.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vs.window.showWarningMessage('Eddy CWTool Code /init: 当前没有打开的工作区');
        return;
    }
    const root = folders[0].uri.fsPath;

    // Notify WebView that init is running
    postMessage({ type: 'agentStep', step: { type: 'thinking', content: '正在扫描工作区，生成项目规则文件...', timestamp: Date.now() } });

    try {
        // ── 1. Collect directory structure (top 2 levels) ──────────────────
        const topLevel = listDirShallow(root, 2);

        // ── 2. Detect mod descriptor ──────────────────────────────────────
        let modName = path.basename(root);
        let modVersion = '';
        let modTags = '';
        const descriptorPath = path.join(root, 'descriptor.mod');
        if (fs.existsSync(descriptorPath)) {
            const desc = fs.readFileSync(descriptorPath, 'utf-8');
            const nameMatch = desc.match(/^name\s*=\s*"?([^"\r\n]+)"?/m);
            const versionMatch = desc.match(/^version\s*=\s*"?([^"\r\n]+)"?/m);
            const tagsMatch = desc.match(/^tags\s*=\s*\{([^}]+)\}/ms);
            if (nameMatch) modName = nameMatch[1].trim();
            if (versionMatch) modVersion = versionMatch[1].trim();
            if (tagsMatch) modTags = tagsMatch[1].replace(/\s+/g, ' ').trim();
        }

        // ── 3. Sample key identifiers (scripted triggers & effects) ────────
        const triggerIds = sampleIds(path.join(root, 'common', 'scripted_triggers'), 20);
        const effectIds = sampleIds(path.join(root, 'common', 'scripted_effects'), 20);
        const eventIds = sampleIds(path.join(root, 'events'), 10);
        const variableIds = sampleIds(path.join(root, 'common', 'scripted_variables'), 20);

        // ── 3.1 Extract Namespaces ────────────────────────────────────────
        const namespaces = new Set<string>();
        const eventsDir = path.join(root, 'events');
        if (fs.existsSync(eventsDir)) {
            for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.txt'))) {
                try {
                    const content = fs.readFileSync(path.join(eventsDir, file), 'utf-8');
                    const nsMatch = content.match(/^namespace\s*=\s*"?([\w.:-]+)"?/m);
                    if (nsMatch) namespaces.add(nsMatch[1]);
                } catch { /* skip */ }
            }
        }

        // ── 3.2 Extract Localization Languages ────────────────────────────
        const locLangs = new Set<string>();
        const locDir = path.join(root, 'localisation');
        if (fs.existsSync(locDir)) {
            for (const file of fs.readdirSync(locDir)) {
                if (file.endsWith('.yml')) {
                    const m = file.match(/([a-z_]+)\.yml$/i);
                    if (m && m[1].includes('chinese')) locLangs.add('simp_chinese');
                    else if (m && m[1].includes('english')) locLangs.add('english');
                    else if (['russian', 'french', 'german', 'spanish', 'polish'].some(l => m && m[1].includes(l))) {
                        const matched = ['russian', 'french', 'german', 'spanish', 'polish'].find(l => m && m[1].includes(l));
                        if (matched) locLangs.add(matched);
                    }
                } else if (fs.statSync(path.join(locDir, file)).isDirectory()) {
                    locLangs.add(file);
                }
            }
        }

        // ── 3.3 P5: Detect encoding conventions ─────────────────────────
        let scriptEncoding = '';
        let locEncoding = '';
        const scriptCheckDirs = ['events', 'common/scripted_triggers', 'common/scripted_effects'];
        let scriptBom = 0, scriptNoBom = 0;
        for (const relDir of scriptCheckDirs) {
            const dir = path.join(root, ...relDir.split('/'));
            if (!fs.existsSync(dir)) continue;
            for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.txt')).slice(0, 3)) {
                try {
                    const buf = fs.readFileSync(path.join(dir, file));
                    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) scriptBom++;
                    else scriptNoBom++;
                } catch { /* skip */ }
            }
        }
        if (scriptBom > 0 || scriptNoBom > 0) {
            scriptEncoding = scriptNoBom >= scriptBom ? 'UTF-8 without BOM' : 'UTF-8 with BOM';
        }
        const locCheckDir = path.join(root, 'localisation');
        let locBom = 0, locNoBom = 0;
        if (fs.existsSync(locCheckDir)) {
            const ymlFiles = collectYmlFiles(locCheckDir, 6);
            for (const ymlPath of ymlFiles) {
                try {
                    const buf = fs.readFileSync(ymlPath);
                    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) locBom++;
                    else locNoBom++;
                } catch { /* skip */ }
            }
        }
        if (locBom > 0 || locNoBom > 0) {
            locEncoding = locBom >= locNoBom ? 'UTF-8 with BOM' : 'UTF-8 without BOM';
        }

        // ── 3.4 P5: Detect file naming patterns ──────────────────────────
        const namingPatterns = new Set<string>();
        for (const subDir of ['common/scripted_triggers', 'common/scripted_effects', 'events']) {
            const dir = path.join(root, ...subDir.split('/'));
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
            if (files.length >= 2) {
                const prefixes = files.map(f => f.replace('.txt', '').split('_')[0]).filter(Boolean);
                const freq = new Map<string, number>();
                for (const p of prefixes) freq.set(p, (freq.get(p) || 0) + 1);
                for (const [prefix, count] of freq) {
                    if (count >= 2 && prefix.length > 2) namingPatterns.add(`${prefix}_*.txt (in ${subDir})`);
                }
            }
        }

        // ── 3.5-3.7 P5: Sample on_actions, static_modifiers, var prefixes ──
        const onActionIds = sampleIds(path.join(root, 'common', 'on_actions'), 10);
        const staticModifierIds = sampleIds(path.join(root, 'common', 'static_modifiers'), 10);

        const varPrefixes = new Set<string>();
        if (variableIds.length > 0) {
            for (const v of variableIds) {
                const prefix = v.replace(/^@/, '').split('_').slice(0, 1)[0];
                if (prefix && prefix.length > 1) varPrefixes.add(`@${prefix}_`);
            }
        }

        // ── 4. Build CWTOOLS.md content ───────────────────────────────────
        const now = new Date().toISOString().split('T')[0];
        const lines: string[] = [
            `# Eddy CWTool Code Project Rules — ${modName}`,
            ``,
            `> Auto-generated by \`/init\` on ${now}. Edit freely.`,
            ``,
            `## Mod Info`,
            `- **Name**: ${modName}`,
            modVersion ? `- **Version**: ${modVersion}` : '',
            modTags ? `- **Tags**: ${modTags}` : '',
            `- **Root**: \`${root}\``,
            scriptEncoding ? `- **Script Encoding**: ${scriptEncoding}` : '',
            locEncoding ? `- **Localisation Encoding**: ${locEncoding}` : '',
            ``,
            `## Project Structure`,
            '```',
            topLevel,
            '```',
            ``,
            `## Known Identifiers`,
            `When generating code that references these IDs, verify they exist before use.`,
            ``,
            namespaces.size > 0
                ? `### Event Namespaces\n${Array.from(namespaces).map(ns => `- \`${ns}\``).join('\n')}`
                : '',
            variableIds.length > 0
                ? `\n### Global Variables (sample)\n${variableIds.map(id => `- \`${id}\``).join('\n')}`
                : '',
            triggerIds.length > 0
                ? `\n### Scripted Triggers (sample)\n${triggerIds.map(id => `- \`${id}\``).join('\n')}`
                : '',
            effectIds.length > 0
                ? `\n### Scripted Effects (sample)\n${effectIds.map(id => `- \`${id}\``).join('\n')}`
                : '',
            eventIds.length > 0
                ? `\n### Events (sample)\n${eventIds.map(id => `- \`${id}\``).join('\n')}`
                : '',
            onActionIds.length > 0
                ? `\n### On Actions (sample)\n${onActionIds.map(id => `- \`${id}\``).join('\n')}`
                : '',
            staticModifierIds.length > 0
                ? `\n### Static Modifiers (sample)\n${staticModifierIds.map(id => `- \`${id}\``).join('\n')}`
                : '',
            ``,
            `## Agent Guidelines`,
            locLangs.size > 0 ? `- **Localization Target**: This project supports [${Array.from(locLangs).join(', ')}]. Always provide localizations for these languages when creating new keys.` : '',
            namespaces.size > 0 ? `- **Namespaces**: Always prefix new events with one of the established namespaces.` : '',
            scriptEncoding ? `- **Script Encoding**: All new .txt script files MUST use ${scriptEncoding}.` : '',
            locEncoding ? `- **Localisation Encoding**: All new .yml localisation files MUST use ${locEncoding}.` : '',
            namingPatterns.size > 0 ? `- **File Naming**: Follow existing patterns: ${Array.from(namingPatterns).join(', ')}.` : '',
            varPrefixes.size > 0 ? `- **Variable Prefixes**: Use established prefixes: ${Array.from(varPrefixes).join(', ')}.` : '',
            `- Always call \`query_types\` before using an identifier not listed above.`,
            `- Distinguish Type A (code bug) from Type B (reference not yet defined) errors.`,
            `- For multi-file tasks, check if referenced IDs are planned to be created later.`,
            `- Prefer \`edit_file\` over \`write_file\` for existing files.`,
            ``,
            `## Custom Rules`,
            `<!-- Add your project-specific rules here. This section survives /init re-runs. -->`,
        ];

        const content = lines.filter(l => l !== undefined && l !== null).join('\n');
        const outPath = path.join(root, 'CWTOOLS.md');

        // Preserve the "Custom Rules" section if file already exists
        let finalContent = content;
        if (fs.existsSync(outPath)) {
            const existing = fs.readFileSync(outPath, 'utf-8');
            const customMatch = existing.match(/## Custom Rules\n([\s\S]*)/);
            if (customMatch && customMatch[1].trim().length > 0 && !customMatch[1].includes('<!-- Add')) {
                finalContent = content.replace(
                    /## Custom Rules\n<!-- Add[^]*$/,
                    `## Custom Rules\n${customMatch[1]}`
                );
            }
        }

        // Register CWTOOLS.md in the current message snapshot so /init can be retracted.
        recordFileSnapshot(outPath);
        fs.writeFileSync(outPath, finalContent, 'utf-8');

        // Open the file in editor
        const doc = await vs.workspace.openTextDocument(vs.Uri.file(outPath));
        await vs.window.showTextDocument(doc, { preview: false });

        // Notify in chat
        postMessage({
            type: 'agentStep',
            step: { type: 'validation', content: `CWTOOLS.md 已生成 → ${outPath}`, timestamp: Date.now() }
        });

        vs.window.showInformationMessage(`Eddy CWTool Code: CWTOOLS.md 已写入 ${path.basename(root)} 根目录`);

    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        postMessage({ type: 'agentStep', step: { type: 'error', content: `/init 失败: ${msg}`, timestamp: Date.now() } });
    }
}

// ─── Helper Functions ─────────────────────────────────────────────────────

/** List directory shallowly (max depth), return tree string */
function listDirShallow(dir: string, maxDepth: number, depth = 0, prefix = ''): string {
    if (!fs.existsSync(dir) || depth > maxDepth) return '';
    const IGNORE = new Set(['node_modules', '.git', '.cwtools', '__pycache__', 'bin', 'obj', 'release']);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
        .slice(0, 30); // cap at 30 per level
    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        lines.push(prefix + connector + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory() && depth < maxDepth) {
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            lines.push(listDirShallow(path.join(dir, e.name), maxDepth, depth + 1, childPrefix));
        }
    }
    return lines.filter(Boolean).join('\n');
}

/** Sample identifier keys from .txt files in a directory */
function sampleIds(dir: string, maxCount: number): string[] {
    if (!fs.existsSync(dir)) return [];
    const ids: string[] = [];
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.txt')).slice(0, 10)) {
        try {
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            const matches = content.match(/^([@\w][\w.:-]*)\s*=/gm) || [];
            for (const m of matches) {
                const id = m.replace(/\s*=$/, '').trim();
                if (id && !ids.includes(id) && id.length > 2) ids.push(id);
                if (ids.length >= maxCount) break;
            }
        } catch { /* skip unreadable file */ }
        if (ids.length >= maxCount) break;
    }
    return ids.slice(0, maxCount);
}

/** Collect .yml file paths from a directory (recurses one level into subdirs) */
function collectYmlFiles(dir: string, maxCount: number): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (results.length >= maxCount) break;
        if (entry.isFile() && entry.name.endsWith('.yml')) {
            results.push(path.join(dir, entry.name));
        } else if (entry.isDirectory()) {
            for (const sub of fs.readdirSync(path.join(dir, entry.name)).filter(f => f.endsWith('.yml')).slice(0, 2)) {
                results.push(path.join(dir, entry.name, sub));
                if (results.length >= maxCount) break;
            }
        }
    }
    return results;
}
