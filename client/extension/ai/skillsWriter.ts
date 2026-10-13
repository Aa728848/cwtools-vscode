import * as fs from 'fs';
import * as path from 'path';
import { getCwtoolsHomeDir } from './homeConfig';
import { SKILL_BODY_CHAR_LIMIT, type SkillCapabilityDomain } from './skills';

export type SkillSaveScope = 'project' | 'user';

export interface SkillSaveOptions {
    name: string;
    description: string;
    body: string;
    capabilityDomain?: SkillCapabilityDomain;
    runAs?: string;
    allowedTools?: string[];
    scope: SkillSaveScope;
    /** Required for scope 'project'; must be an existing directory. */
    workspaceRoot?: string;
    /** User-level CWTools home (`~/.cwtools`); injectable for tests. */
    homeDir?: string;
    overwrite?: boolean;
    onBeforeWrite?: (filePath: string, previousContent: string | null) => void;
}

export type SkillSaveResult =
    | { success: true; path: string; scope: SkillSaveScope; name: string }
    | { success: false; error: string; name?: string; path?: string; alreadyExists?: true };

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SKILL_DESCRIPTION_CHAR_LIMIT = 500;

function frontmatterValue(value: string): string {
    return value.replace(/\r?\n/g, ' ').replace(/"/g, '\\"').trim();
}

/**
 * Resolve the skills root for a save scope. Project skills go to
 * `.agents/skills` (the Kimi Code convention, also scanned by `listSkills`
 * with default domain `both`) so external agents discover the same file;
 * user skills go to `~/.cwtools/skills`. `.cwtools/skills` stays a
 * paradox-only scan root and is never a save target.
 */
export function skillSaveDirectory(scope: SkillSaveScope, workspaceRoot?: string, homeDir?: string): string | undefined {
    if (scope === 'project') {
        if (!workspaceRoot) return undefined;
        return path.join(workspaceRoot, '.agents', 'skills');
    }
    return path.join(homeDir ?? getCwtoolsHomeDir(), 'skills');
}

export function saveSkill(options: SkillSaveOptions): SkillSaveResult {
    const name = (options.name ?? '').trim().toLowerCase();
    if (!SKILL_NAME_PATTERN.test(name)) {
        return {
            success: false,
            error: `Invalid skill name '${options.name}'. Use 1-64 chars: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.`,
        };
    }

    const description = (options.description ?? '').trim();
    if (!description) {
        return { success: false, error: 'Skill description is required.', name };
    }
    if (description.length > SKILL_DESCRIPTION_CHAR_LIMIT) {
        return { success: false, error: `Skill description exceeds ${SKILL_DESCRIPTION_CHAR_LIMIT} characters.`, name };
    }

    const body = (options.body ?? '').trim();
    if (!body) {
        return { success: false, error: 'Skill body is required.', name };
    }
    if (body.length > SKILL_BODY_CHAR_LIMIT) {
        return { success: false, error: `Skill body exceeds ${SKILL_BODY_CHAR_LIMIT} characters.`, name };
    }

    if (options.capabilityDomain !== undefined
        && options.capabilityDomain !== 'general'
        && options.capabilityDomain !== 'paradox'
        && options.capabilityDomain !== 'both') {
        return { success: false, error: `Invalid capability domain '${options.capabilityDomain}'.`, name };
    }

    const skillsDir = skillSaveDirectory(options.scope, options.workspaceRoot, options.homeDir);
    if (!skillsDir) {
        return { success: false, error: 'No workspace is open; cannot save a project-level skill.', name };
    }
    if (options.scope === 'project') {
        const root = options.workspaceRoot as string;
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            return { success: false, error: `Workspace root does not exist: ${root}`, name };
        }
    }

    // Defense in depth: the name pattern already excludes path separators, but
    // the resolved skill directory must provably sit directly inside the root.
    const resolvedRoot = path.resolve(skillsDir);
    const skillDir = path.resolve(resolvedRoot, name);
    if (path.dirname(skillDir) !== resolvedRoot) {
        return { success: false, error: `Skill name '${name}' escapes the skills directory.`, name };
    }
    const filePath = path.join(skillDir, 'SKILL.md');

    if (fs.existsSync(filePath) && options.overwrite !== true) {
        return {
            success: false,
            name,
            path: filePath,
            alreadyExists: true,
            error: `Skill '${name}' already exists at ${filePath}. Set overwrite=true to replace it.`,
        };
    }

    // Single-line quoted values so the extension's own line-based frontmatter
    // parser round-trips them; external YAML readers accept the same shape.
    const frontmatter: string[] = [
        '---',
        `name: ${name}`,
        `description: "${frontmatterValue(description)}"`,
    ];
    if (options.capabilityDomain) frontmatter.push(`capability-domain: ${options.capabilityDomain}`);
    const runAs = options.runAs?.trim();
    if (runAs) frontmatter.push(`run-as: ${frontmatterValue(runAs)}`);
    const allowedTools = (options.allowedTools ?? []).map(tool => tool.trim()).filter(Boolean);
    if (allowedTools.length > 0) frontmatter.push(`allowed-tools: ${allowedTools.join(', ')}`);
    frontmatter.push('---', '', body, '');
    const content = frontmatter.join('\n');

    try {
        fs.mkdirSync(skillDir, { recursive: true });
        const previousContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
        options.onBeforeWrite?.(filePath, previousContent);
        // Atomic write: prompt builds re-scan skill roots concurrently, so a
        // reader must never observe a half-written SKILL.md.
        const tmpPath = path.join(skillDir, `.SKILL.md.${process.pid}.${Date.now()}.tmp`);
        try {
            fs.writeFileSync(tmpPath, content, 'utf8');
            fs.renameSync(tmpPath, filePath);
        } catch (error) {
            try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
            throw error;
        }
    } catch (error) {
        return {
            success: false,
            name,
            path: filePath,
            error: `Failed to save skill '${name}': ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    return { success: true, path: filePath, scope: options.scope, name };
}
