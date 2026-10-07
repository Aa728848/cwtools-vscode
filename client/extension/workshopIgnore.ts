/**
 * Ignore-aware content staging for Steam Workshop uploads.
 *
 * `ISteamUGC::SetItemContent` takes a directory and uploads everything inside
 * it; the API has no per-file filter. So "exclude these files" can only be
 * implemented by handing Steam a directory that no longer contains them. This
 * module builds that directory: it reads the mod's ignore files, copies the
 * surviving tree into a staging folder, and reports what was left out.
 *
 * Ignore sources, in increasing precedence:
 *   1. {@link ALWAYS_EXCLUDED} — VCS and tooling metadata that must never ship.
 *   2. `.gitignore` — the repository's own rules, with git's semantics.
 *   3. `.steamignore` — the Steam-ecosystem convention used by shipped mods.
 *   4. User patterns from `workshop.extraIgnorePatterns`.
 *
 * The staging copy is deliberately faithful rather than clever: relative paths
 * and file contents are preserved verbatim, and nothing is rewritten. Entries
 * a plain copy cannot reproduce faithfully (symlinks, junctions, sockets,
 * devices) are skipped and reported rather than silently turned into broken
 * files or silently shipped.
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
import { ErrorReporter } from './ai/errorReporter';

/**
 * Never uploaded, whatever the ignore files say.
 *
 * `.git` alone can outweigh the mod itself, and every entry here is repository
 * or editor metadata rather than mod content.
 */
export const ALWAYS_EXCLUDED: readonly string[] = [
    '.git',
    '.github',
    '.svn',
    '.hg',
    '.vscode',
    '.idea',
    '.vs',
    '.gitignore',
    '.gitattributes',
    '.gitmodules',
    '.steamignore',
];

/** Ignore files honoured in the mod root, in increasing precedence. */
const ROOT_IGNORE_FILES: readonly string[] = ['.gitignore', '.steamignore'];

/** Ignore files honoured in subdirectories of the mod. */
const NESTED_IGNORE_FILES: readonly string[] = ['.steamignore'];

/** Depth beyond which nested ignore files are not read any further. */
const MAX_IGNORE_DEPTH = 32;

/** Refuse to stage more than this; Steam rejects far less than a well-formed mod. */
const DEFAULT_MAX_STAGING_BYTES = 8 * 1024 * 1024 * 1024;

/** An entry that could not be copied verbatim and was therefore dropped. */
export interface SkippedEntry {
    /** Path relative to the mod root, with `/` separators. */
    relativePath: string;
    reason: 'symlink' | 'special';
}

/** A staging directory built for one upload. */
export interface StagedContent {
    /** The directory to hand to Steam. */
    contentPath: string;
    /** Temporary directory to delete afterwards. */
    stagingRoot: string;
    /** Files copied into the staging directory. */
    fileCount: number;
    /** Bytes copied into the staging directory. */
    totalBytes: number;
    /** Files and directories the ignore rules kept out. */
    excludedCount: number;
    /** Entries dropped because they cannot be copied verbatim. */
    skipped: readonly SkippedEntry[];
}

export interface StagingOptions {
    /** Directory the staging copy is created under. */
    stagingParent: string;
    /** Extra gitignore-style patterns from settings; highest precedence. */
    extraPatterns?: readonly string[];
    /** Abort before copying more than this many bytes. */
    maxBytes?: number;
    /** Reports copy progress as `done` of `total` planned files. */
    onProgress?: (done: number, total: number) => void;
    /** Polled per file; when true the partial staging directory is discarded. */
    shouldCancel?: () => boolean;
}

/** Raised when {@link StagingOptions.shouldCancel} asks the copy to stop. */
export class StagingCancelled extends Error {
    constructor() {
        super('Workshop content staging was cancelled.');
        this.name = 'StagingCancelled';
    }
}

/** Normalises a relative path to the `/` form the ignore matcher expects. */
function toPosix(relativePath: string): string {
    return relativePath.split(path.sep).join('/');
}

/**
 * Reads one ignore file into a matcher. A missing or unreadable file yields an
 * empty matcher rather than an error: an ignore file is a filter, and a broken
 * filter must not fail an upload that would otherwise succeed.
 */
function loadIgnoreFile(filePath: string): Ignore {
    let contents: string;
    try {
        contents = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        ErrorReporter.debug('WorkshopIgnore', `Could not read ignore file ${filePath}`, error);
        return ignore();
    }
    return ignore().add(contents);
}

/** Filesystem entries are sorted so a staged copy is repeatable run to run. */
function sortedEntries(dir: string): fs.Dirent[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        ErrorReporter.warn('WorkshopIgnore', `Could not read mod directory ${dir}`, error);
        return [];
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}


/** One file the staging copy will contain. */
interface PlannedFile {
    absolutePath: string;
    relativePath: string;
    size: number;
}

/** Everything the walk learned about the mod folder. */
interface UploadPlan {
    files: PlannedFile[];
    excludedCount: number;
    skipped: SkippedEntry[];
}

/**
 * One directory's ignore rules, plus the paths they are evaluated against.
 *
 * Each layer is evaluated against paths relative to the directory that
 * declared it, which is what git does: a `.steamignore` inside `outer/`
 * matching `draft.txt` must not be interpreted as matching `outer/draft.txt`
 * from the mod root, nor as an unrelated `draft.txt` at the root.
 */
interface IgnoreLayer {
    matcher: Ignore;
    /** Absolute directory the patterns are relative to. */
    base: string;
    /** True for the baseline layer, which every directory shares. */
    global?: boolean;
}

/**
 * Builds the ignore layers that apply inside one directory: the baseline and
 * the user's extra patterns (both global), plus this directory's own ignore
 * files (scoped to this directory), plus the layers inherited from its parents.
 *
 * Layers are ordered outermost first, so the deepest file wins, exactly like
 * git's "the last matching pattern decides" rule.
 */
function buildLayers(dir: string, inherited: readonly IgnoreLayer[], extraPatterns: readonly string[]): IgnoreLayer[] {
    // The baseline and the user's extra patterns are global rules, rooted at the
    // mod root, so they form a single layer that every directory inherits.
    const layers = [...inherited];
    if (!layers.some(layer => layer.global)) {
        const matcher = ignore().add(ALWAYS_EXCLUDED);
        if (extraPatterns.length > 0) matcher.add([...extraPatterns]);
        layers.unshift({ matcher, base: dir, global: true });
    }

    const own = [...ROOT_IGNORE_FILES, ...NESTED_IGNORE_FILES].filter(name =>
        fs.existsSync(path.join(dir, name))
    );
    if (own.length === 0) return layers;

    const matcher = ignore();
    for (const name of own) {
        matcher.add(loadIgnoreFile(path.join(dir, name)));
    }
    return [...layers, { matcher, base: dir }];
}

/**
 * True when any layer excludes a path. Layers are consulted from the deepest
 * outwards and the first one that matches decides, so a nested ignore file
 * can re-include what a parent excluded.
 */
function isExcluded(absolutePath: string, isDirectory: boolean, layers: readonly IgnoreLayer[]): boolean {
    for (let index = layers.length - 1; index >= 0; index--) {
        const layer = layers[index]!;
        const relative = toPosix(path.relative(layer.base, absolutePath));
        if (relative.length === 0) continue;
        if (layer.matcher.ignores(isDirectory ? `${relative}/` : relative)) return true;
    }
    return false;
}

/**
 * Walks the mod folder once and records every file that survives the ignore
 * rules, counting what was excluded along the way.
 *
 * An excluded directory is not descended into, so its subtree is neither copied
 * nor counted again.
 */
function planUpload(modRoot: string, extraPatterns: readonly string[]): UploadPlan {
    const plan: UploadPlan = { files: [], excludedCount: 0, skipped: [] };

    const walk = (dir: string, layers: readonly IgnoreLayer[], depth: number): void => {
        const subdirectories: string[] = [];
        for (const entry of sortedEntries(dir)) {
            const absolutePath = path.join(dir, entry.name);
            const relativePath = toPosix(path.relative(modRoot, absolutePath));
            const isDirectory = entry.isDirectory();

            if (isExcluded(absolutePath, isDirectory, layers)) {
                plan.excludedCount++;
                continue;
            }
            // Ignore rules are applied before the symlink check so that an
            // ignored symlink is reported as excluded, not as unrepresentable.
            if (entry.isSymbolicLink()) {
                plan.skipped.push({ relativePath, reason: 'symlink' });
                continue;
            }
            // Directories are recursed into; the file check below only classifies
            // what is left, which is why it cannot run before this branch.
            if (isDirectory) {
                subdirectories.push(absolutePath);
                continue;
            }
            if (!entry.isFile()) {
                // Sockets, FIFOs and devices have no meaningful mod content.
                plan.skipped.push({ relativePath, reason: 'special' });
                continue;
            }

            let size = 0;
            try {
                size = fs.statSync(absolutePath).size;
            } catch (error) {
                ErrorReporter.debug('WorkshopIgnore', `Could not stat ${absolutePath}`, error);
                plan.skipped.push({ relativePath, reason: 'special' });
                continue;
            }
            plan.files.push({ absolutePath, relativePath, size });
        }

        // The child matcher is built from this directory's own ignore file, so
        // a nested rule can exclude entries inside the directory that declares
        // it, and a nested rule cannot re-include what this directory matched.
        if (depth >= MAX_IGNORE_DEPTH) return;
        const childLayers = buildLayers(dir, layers, extraPatterns);
        for (const child of subdirectories) {
            walk(child, buildLayers(child, childLayers, extraPatterns), depth + 1);
        }
    };

    walk(modRoot, buildLayers(modRoot, [], extraPatterns), 0);
    return plan;
}

/**
 * Creates a unique staging directory under the configured parent.
 *
 * `mkdtemp` is used rather than a fixed name so two windows uploading the same
 * mod cannot collide. The real path is resolved because the OS temp directory is
 * a symlink on macOS, and the resolved form is what {@link removeStagingRoot}
 * verifies before deleting anything.
 */
function createStagingRoot(stagingParent: string, modRoot: string): string {
    const parent = path.join(stagingParent, STAGING_PARENT_NAME);
    fs.mkdirSync(parent, { recursive: true });
    const prefix = path.join(parent, `${path.basename(modRoot)}-`);
    return fs.realpathSync(fs.mkdtempSync(prefix));
}

/** Directory name the extension owns inside the staging parent. */
export const STAGING_PARENT_NAME = 'workshop-upload';

/**
 * Deletes a staging directory created by this module.
 *
 * This is the one place the extension removes a tree. A recursive delete follows
 * links, so the target is re-verified to be a directory this module created
 * inside its own staging parent before anything is removed.
 */
export function removeStagingRoot(stagingRoot: string | undefined): void {
    if (!stagingRoot) return;
    if (path.basename(path.dirname(stagingRoot)) !== STAGING_PARENT_NAME) {
        ErrorReporter.warn('WorkshopIgnore', `Refusing to remove unexpected staging path ${stagingRoot}`);
        return;
    }
    try {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
    } catch (error) {
        ErrorReporter.warn('WorkshopIgnore', `Could not remove staging directory ${stagingRoot}`, error);
    }
}

/**
 * Prepares the mod folder for upload.
 *
 * Returns `undefined` when nothing had to be left out, in which case the
 * caller uploads the mod folder directly: a mod with no ignore rules keeps the
 * exact behaviour and the zero-copy cost it had before staging existed.
 */
export function stageUploadContent(modRoot: string, options: StagingOptions): StagedContent | undefined {
    const extraPatterns = options.extraPatterns ?? [];
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_STAGING_BYTES;

    const plan = planUpload(modRoot, extraPatterns);
    if (plan.excludedCount === 0 && plan.skipped.length === 0) {
        return undefined;
    }

    const stagingRoot = createStagingRoot(options.stagingParent, modRoot);
    const staged: StagedContent = {
        contentPath: stagingRoot,
        stagingRoot,
        fileCount: 0,
        totalBytes: 0,
        excludedCount: plan.excludedCount,
        skipped: plan.skipped,
    };

    try {
        const total = plan.files.length;
        plan.files.forEach((file, index) => {
            if (options.shouldCancel?.()) throw new StagingCancelled();
            const destination = path.join(stagingRoot, file.relativePath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(file.absolutePath, destination);
            staged.fileCount++;
            staged.totalBytes += file.size;
            if (staged.totalBytes > maxBytes) {
                throw new Error(
                    `The staged mod content exceeds ${Math.round(maxBytes / (1024 * 1024))} MB. ` +
                        'Exclude more files before uploading.'
                );
            }
            options.onProgress?.(index + 1, total);
        });
    } catch (error) {
        removeStagingRoot(stagingRoot);
        throw error;
    }

    return staged;
}

/** True when the mod root holds an ignore file, so filtering is in effect. */
export function hasIgnoreFiles(modRoot: string): boolean {
    return ROOT_IGNORE_FILES.some(name => fs.existsSync(path.join(modRoot, name)));
}
