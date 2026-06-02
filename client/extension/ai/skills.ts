import * as fs from 'fs';
import * as path from 'path';

export interface SkillIndexEntry {
    name: string;
    description: string;
    source: 'built-in' | 'user' | 'project';
    runAs?: string;
    allowedTools?: string[];
    filePath: string;
}

export interface SkillLookupRoots {
    workspaceRoot?: string;
    globalStoragePath?: string;
    extensionPath?: string;
}

interface ParsedSkillFile {
    frontmatter: Record<string, string>;
    body: string;
}

const SKILL_INDEX_CHAR_LIMIT = 4000;
const SKILL_BODY_CHAR_LIMIT = 30000;

function parseFrontmatter(content: string): ParsedSkillFile {
    const normalized = content.replace(/^\uFEFF/, '');
    if (!normalized.startsWith('---')) {
        return { frontmatter: {}, body: normalized.trim() };
    }

    const lines = normalized.split(/\r?\n/);
    const frontmatter: Record<string, string> = {};
    let endIndex = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === '---') {
            endIndex = i;
            break;
        }
        const line = lines[i] ?? '';
        const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
        if (match) {
            frontmatter[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^["']|["']$/g, '');
        }
    }

    if (endIndex < 0) {
        return { frontmatter: {}, body: normalized.trim() };
    }

    return {
        frontmatter,
        body: lines.slice(endIndex + 1).join('\n').trim(),
    };
}

function firstUsefulLine(body: string): string {
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line === '---') continue;
        if (/^#+\s+/.test(line)) continue;
        if (/^[A-Za-z0-9_.-]+\s*:\s*/.test(line)) continue;
        return line.replace(/\s+/g, ' ').slice(0, 220);
    }
    return '';
}

function parseAllowedTools(value: string | undefined): string[] | undefined {
    if (!value) return undefined;
    const tools = value
        .split(/[,\s]+/)
        .map(v => v.trim())
        .filter(Boolean);
    return tools.length > 0 ? tools : undefined;
}

function readSkillEntry(skillMd: string, fallbackName: string, source: SkillIndexEntry['source']): SkillIndexEntry | undefined {
    try {
        const raw = fs.readFileSync(skillMd, 'utf8');
        const parsed = parseFrontmatter(raw);
        const name = parsed.frontmatter.name || fallbackName;
        const description = parsed.frontmatter.description || firstUsefulLine(parsed.body) || 'No description provided.';
        return {
            name,
            description,
            source,
            runAs: parsed.frontmatter.runas || parsed.frontmatter['run-as'],
            allowedTools: parseAllowedTools(parsed.frontmatter['allowed-tools'] || parsed.frontmatter.allowedtools),
            filePath: skillMd,
        };
    } catch {
        return undefined;
    }
}

function scanSkillDir(dir: string, source: SkillIndexEntry['source'], out: Map<string, SkillIndexEntry>): void {
    if (!dir || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        const skill = readSkillEntry(skillMd, entry.name, source);
        if (skill) out.set(skill.name.toLowerCase(), skill);
    }
}

export function listSkills(roots: SkillLookupRoots): SkillIndexEntry[] {
    const skills = new Map<string, SkillIndexEntry>();

    if (roots.extensionPath) {
        scanSkillDir(path.join(roots.extensionPath, 'resources', 'skills'), 'built-in', skills);
    }
    if (roots.globalStoragePath) {
        scanSkillDir(path.join(roots.globalStoragePath, '.agents', 'skills'), 'user', skills);
    }
    if (roots.workspaceRoot) {
        scanSkillDir(path.join(roots.workspaceRoot, '.agents', 'skills'), 'project', skills);
        scanSkillDir(path.join(roots.workspaceRoot, '.cwtools-ai', 'skills'), 'project', skills);
    }

    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function buildSkillIndexPrompt(roots: SkillLookupRoots): string {
    const skills = listSkills(roots);
    if (skills.length === 0) return '';

    const lines = skills.map(skill => {
        const suffix = [
            `source: ${skill.source}`,
            skill.runAs ? `runAs: ${skill.runAs}` : '',
            skill.allowedTools?.length ? `tools: ${skill.allowedTools.join(',')}` : '',
        ].filter(Boolean).join('; ');
        return `- ${skill.name}: ${skill.description}${suffix ? ` (${suffix})` : ''}`;
    });

    let body = lines.join('\n');
    if (body.length > SKILL_INDEX_CHAR_LIMIT) {
        body = body.slice(0, SKILL_INDEX_CHAR_LIMIT) + '\n- ...skill index truncated...';
    }

    return [
        '## Installed Agent Skills',
        'Skill bodies are not embedded in the system prompt. When a skill is relevant, call `run_skill` with its exact name, then follow the returned SKILL.md instructions.',
        body,
    ].join('\n');
}

export function loadSkill(name: string, roots: SkillLookupRoots): { success: true; skill: SkillIndexEntry; content: string; truncated: boolean } | { success: false; error: string; availableSkills: string[] } {
    const normalized = name.trim().toLowerCase();
    const skills = listSkills(roots);
    const skill = skills.find(s => s.name.toLowerCase() === normalized);
    if (!skill) {
        return {
            success: false,
            error: `Skill not found: ${name}`,
            availableSkills: skills.map(s => s.name),
        };
    }

    try {
        let content = fs.readFileSync(skill.filePath, 'utf8').replace(/^\uFEFF/, '').trim();
        let truncated = false;
        if (content.length > SKILL_BODY_CHAR_LIMIT) {
            content = content.slice(0, SKILL_BODY_CHAR_LIMIT);
            truncated = true;
        }
        return { success: true, skill, content, truncated };
    } catch (e) {
        return {
            success: false,
            error: `Failed to read skill ${skill.name}: ${e instanceof Error ? e.message : String(e)}`,
            availableSkills: skills.map(s => s.name),
        };
    }
}
