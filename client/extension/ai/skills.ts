import * as fs from 'fs';
import * as path from 'path';
import type { AgentRuntimeDomain } from './types';

export type SkillCapabilityDomain = AgentRuntimeDomain | 'both';

export interface SkillIndexEntry {
    name: string;
    description: string;
    source: 'built-in' | 'user' | 'project';
    runAs?: string;
    allowedTools?: string[];
    capabilityDomain: SkillCapabilityDomain;
    filePath: string;
}

export interface SkillLookupRoots {
    workspaceRoot?: string;
    globalStoragePath?: string;
    extensionPath?: string;
    /**
     * User-level CWTools home directory (`~/.cwtools`); skills are scanned from
     * `<homeDir>/skills`. Opt-in: when omitted the home root is skipped so tests
     * stay deterministic. Production callers pass `getCwtoolsHomeDir()`.
     */
    homeDir?: string;
}

export interface ParsedFrontmatter {
    frontmatter: Record<string, string>;
    body: string;
}

const SKILL_INDEX_CHAR_LIMIT = 4000;
export const SKILL_BODY_CHAR_LIMIT = 30000;

/** `key: value` line of a frontmatter block. The key is anchored at column 0, so
 *  an indented continuation line can never be read as a new key. */
const FRONTMATTER_KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

/** Block scalar header: `>`, `>-`, `>+`, `|`, `|-`, `|+` and nothing
 *  else. A quoted `">-"` is a literal string and stays a literal string. */
const BLOCK_SCALAR_HEADER = /^[>|][+-]?$/;

interface BlockScalarLine {
    /** Leading whitespace of the raw line, minus the detected block indentation. */
    indent: number;
    /** Line text with the block indentation and trailing whitespace removed. */
    text: string;
}

function leadingWhitespace(line: string): number {
    let count = 0;
    while (count < line.length && (line[count] === ' ' || line[count] === '\t')) count++;
    return count;
}

/**
 * Render the collected continuation lines of a block scalar. A folded block
 * (`>`) joins lines with a space and turns a blank line into a paragraph
 * break; a literal block (`|`) keeps every line break. Chomping indicators
 * (`-` / `+`) are accepted but deliberately not distinguished: frontmatter
 * blocks feed single-valued prompts (the skill index), so the trailing newline
 * is always dropped.
 */
function renderBlockScalar(collected: readonly BlockScalarLine[], folded: boolean): string {
    if (!folded) return collected.map(line => line.text).join('\n').trim();

    let out = '';
    let pendingBreaks = 0;
    let previousMoreIndented = false;
    for (const line of collected) {
        if (!line.text) {
            pendingBreaks++;
            previousMoreIndented = false;
            continue;
        }
        const moreIndented = line.indent > 0;
        if (!out) {
            out = line.text;
        } else if (moreIndented || previousMoreIndented) {
            out += '\n'.repeat(pendingBreaks + 1) + line.text;
        } else if (pendingBreaks > 0) {
            out += '\n'.repeat(pendingBreaks) + line.text;
        } else {
            out += ' ' + line.text;
        }
        pendingBreaks = 0;
        previousMoreIndented = moreIndented;
    }
    return out.trim();
}

/**
 * Collect the continuation lines of a block scalar starting at `start`.
 * SKILL.md is untrusted input, so the block is bounded
 * by indentation instead of by "read until the next non-empty line": the
 * `---` frontmatter terminator, any column-0 line, and a dedent below the
 * detected block indentation all end it. `lastIndex` is the index of the last
 * consumed line; the caller resumes at `lastIndex + 1`.
 */
function readBlockScalar(lines: readonly string[], start: number, folded: boolean): { value: string; lastIndex: number } {
    const collected: BlockScalarLine[] = [];
    let blockIndent = -1;
    let index = start;
    for (; index < lines.length; index++) {
        const raw = lines[index] ?? '';
        if (raw.trim() === '---') break;
        const indent = leadingWhitespace(raw);
        if (indent === raw.length) {
            collected.push({ indent: 0, text: '' });
            continue;
        }
        if (indent === 0) break;
        if (blockIndent < 0) blockIndent = indent;
        if (indent < blockIndent) break;
        collected.push({ indent: indent - blockIndent, text: raw.slice(blockIndent).trimEnd() });
    }
    return { value: renderBlockScalar(collected, folded), lastIndex: index - 1 };
}

/**
 * Parse a `---` delimited YAML frontmatter block. SKILL.md is its only reader
 * today, and it follows the folded/literal block scalars (`description: >-`)
 * that Kimi Code and Claude Code style frontmatter uses.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
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
        const match = line.match(FRONTMATTER_KEY_LINE);
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        const rawValue = match[2]!.trim();
        if (BLOCK_SCALAR_HEADER.test(rawValue)) {
            const block = readBlockScalar(lines, i + 1, rawValue.startsWith('>'));
            frontmatter[key] = block.value;
            i = block.lastIndex;
            continue;
        }
        frontmatter[key] = rawValue.replace(/^["']|["']$/g, '');
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

function readSkillEntry(
    skillMd: string,
    fallbackName: string,
    source: SkillIndexEntry['source'],
    defaultDomain: SkillCapabilityDomain,
): SkillIndexEntry | undefined {
    try {
        const raw = fs.readFileSync(skillMd, 'utf8');
        const parsed = parseFrontmatter(raw);
        const name = parsed.frontmatter.name || fallbackName;
        const description = parsed.frontmatter.description || firstUsefulLine(parsed.body) || 'No description provided.';
        const declaredDomain = parsed.frontmatter['capability-domain'];
        const capabilityDomain: SkillCapabilityDomain = declaredDomain === 'general'
            || declaredDomain === 'paradox'
            || declaredDomain === 'both'
            ? declaredDomain
            : defaultDomain;
        return {
            name,
            description,
            source,
            runAs: parsed.frontmatter['run-as'],
            allowedTools: parseAllowedTools(parsed.frontmatter['allowed-tools']),
            capabilityDomain,
            filePath: skillMd,
        };
    } catch {
        return undefined;
    }
}

function scanSkillDir(
    dir: string,
    source: SkillIndexEntry['source'],
    defaultDomain: SkillCapabilityDomain,
    out: Map<string, SkillIndexEntry>,
): void {
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
        const skill = readSkillEntry(skillMd, entry.name, source, defaultDomain);
        if (skill) out.set(skill.name.toLowerCase(), skill);
    }
}

interface SkillRootDir {
    dir: string;
    source: SkillIndexEntry['source'];
    defaultDomain: SkillCapabilityDomain;
}

/** Scan order is priority: a later root overrides an earlier same-named skill. */
function skillRootDirs(roots: SkillLookupRoots): SkillRootDir[] {
    const dirs: SkillRootDir[] = [];
    if (roots.extensionPath) {
        dirs.push({ dir: path.join(roots.extensionPath, 'resources', 'skills'), source: 'built-in', defaultDomain: 'paradox' });
    }
    if (roots.homeDir) {
        dirs.push({ dir: path.join(roots.homeDir, 'skills'), source: 'user', defaultDomain: 'both' });
    }
    if (roots.globalStoragePath) {
        // Legacy user-level location (pre-home-dir installs). Kept read-compatible;
        // on a name clash it still wins over the home root, matching its previous
        // priority, but new installs go to `<homeDir>/skills`.
        dirs.push({ dir: path.join(roots.globalStoragePath, '.agents', 'skills'), source: 'user', defaultDomain: 'both' });
    }
    if (roots.workspaceRoot) {
        dirs.push({ dir: path.join(roots.workspaceRoot, '.agents', 'skills'), source: 'project', defaultDomain: 'both' });
        dirs.push({ dir: path.join(roots.workspaceRoot, '.cwtools', 'skills'), source: 'project', defaultDomain: 'paradox' });
    }
    return dirs;
}

export function listSkills(roots: SkillLookupRoots, domain?: AgentRuntimeDomain): SkillIndexEntry[] {
    const skills = new Map<string, SkillIndexEntry>();

    for (const root of skillRootDirs(roots)) {
        scanSkillDir(root.dir, root.source, root.defaultDomain, skills);
    }

    return [...skills.values()]
        .filter(skill => !domain || skill.capabilityDomain === 'both' || skill.capabilityDomain === domain)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Cheap change-detection signature over every skill root: child directory
 * names plus each SKILL.md's mtime/size (stat only, no file reads). Unlike a
 * signature over already-known skill files, this also sees pure additions and
 * removals, so a freshly saved skill invalidates cached index hashes.
 */
export function skillsDirectorySignature(roots: SkillLookupRoots): string {
    const parts: string[] = [];
    for (const root of skillRootDirs(roots)) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root.dir, { withFileTypes: true });
        } catch {
            parts.push(`${root.dir}=<absent>`);
            continue;
        }
        const childSigs = entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort()
            .map(name => {
                try {
                    const stat = fs.statSync(path.join(root.dir, name, 'SKILL.md'));
                    return `${name}:${stat.mtimeMs}:${stat.size}`;
                } catch {
                    return `${name}:none`;
                }
            });
        parts.push(`${root.dir}=[${childSigs.join(',')}]`);
    }
    return parts.join('|');
}

export function buildSkillIndexPrompt(roots: SkillLookupRoots, domain?: AgentRuntimeDomain): string {
    const skills = listSkills(roots, domain);
    if (skills.length === 0) return '';

    const lines = skills.map(skill => {
        const suffix = [
            `source: ${skill.source}`,
            skill.runAs ? `runAs: ${skill.runAs}` : '',
            skill.allowedTools?.length ? `tools: ${skill.allowedTools.join(',')}` : '',
            `domain: ${skill.capabilityDomain}`,
        ].filter(Boolean).join('; ');
        return `- ${skill.name}: ${skill.description}${suffix ? ` (${suffix})` : ''}`;
    });

    let body = lines.join('\n');
    if (body.length > SKILL_INDEX_CHAR_LIMIT) {
        body = body.slice(0, SKILL_INDEX_CHAR_LIMIT) + '\n- ...skill index truncated...';
    }

    return [
        '## Installed Agent Skills',
        'Skill bodies are not embedded in the system prompt. When a skill is relevant, load `run_skill` through `select_tools` if needed, call it with the exact skill name, then follow the returned SKILL.md instructions. When the user asks to create or update a reusable skill, load `save_skill` through `select_tools` if needed and call `save_skill` (`scope="project"` or `scope="user"`) instead of writing `SKILL.md` or experience files with `write_file`/`edit_file`.',
        body,
    ].join('\n');
}

/**
 * Wrap a loaded SKILL.md body for a `/skill` turn. The model-facing shape matches
 * the `run_skill` tool result so the same skill reads identically whichever
 * surface loaded it: a `<skill name=...>` block plus an optional
 * `<skill-arguments>` block holding the slash arguments as JSON text.
 *
 * The name and body come from an untrusted SKILL.md; callers pass values that
 * already went through `loadSkill` (bounded by `SKILL_BODY_CHAR_LIMIT`).
 */
export function buildSkillSlashTurnBody(name: string, content: string, argumentsText = ''): string {
    const argumentBlock = argumentsText.trim()
        ? `\n\n<skill-arguments>\n${JSON.stringify(argumentsText, null, 2)}\n</skill-arguments>`
        : '';
    return `<skill name="${name}">\n${content}\n</skill>${argumentBlock}`;
}

export function loadSkill(
    name: string,
    roots: SkillLookupRoots,
    domain?: AgentRuntimeDomain,
): { success: true; skill: SkillIndexEntry; content: string; truncated: boolean } | { success: false; error: string; availableSkills: string[] } {
    const normalized = name.trim().toLowerCase();
    const skills = listSkills(roots, domain);
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
