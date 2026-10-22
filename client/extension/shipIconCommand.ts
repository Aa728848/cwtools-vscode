/**
 * "Generate Ship Icon Sheet from Models" command.
 *
 * Reads vanilla ship data (plus workspace overrides), lets the user pick a
 * graphical culture and ship sizes, then writes the normal and damaged top-icon
 * sheets as uncompressed DDS. Every read is read-only; only the two output files
 * are written, and only after the user confirms the destination.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { localize } from './panelI18n';
import { ErrorReporter } from './ai/errorReporter';
import { getProfileByLanguageId } from './gameProfiles';
import {
    loadShipIconCatalog,
    resolveShipIcons,
    type ResolvedShipIcon,
    type ShipIconCatalog,
    type ShipIconDataSource,
    type ShipSectionTemplateInfo,
    type ShipSizeInfo,
} from './shipIcon/shipIconDefinitions';
import {
    categorizeShipSizes,
    normalizeMeshOverrides,
    overrideEntriesFor,
    parseMeshOverrideEntries,
    type ShipIconCategory,
    type ShipIconCategoryId,
} from './shipIcon/shipIconSelection';
import { buildShipIconSheet, type ShipIconSheetResult } from './shipIcon/shipIconSheet';
import { buildShipIconGfxSnippet, type ShipIconSnippetEntry } from './shipIcon/shipIconGfxSnippet';
import { DEFAULT_SHIP_ICON_STYLE } from './shipIcon/shipIconRender';
import { encodeDdsArgb8888 } from './shipIcon/ddsWrite';

const COMMAND_ID = 'cwtools.shipIcons.generateSheet';
const OUTPUT_CHANNEL_NAME = 'CWTools Ship Icons';
const DEFAULT_SHEET_RELATIVE_PATH = 'gfx/interface/icons/ship_parts/ship_sizes/ship_sizes_top.dds';
const DAMAGED_MARKER = 'top';
const DAMAGED_MARKER_REPLACEMENT = 'top_damaged';
const SHIP_ICON_SETTINGS_SECTION = 'stellarisLanguageServices.shipIcons';
const MESH_OVERRIDES_KEY = 'meshOverrides';
const REPORTED_WARNING_LIMIT = 3;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

// ── Output channel ───────────────────────────────────────────────────────────

let outputChannel: vs.OutputChannel | undefined;

/** Created on first use so no panel appears for a command that never runs. */
function shipIconChannel(): vs.OutputChannel {
    outputChannel ??= vs.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    return outputChannel;
}

function disposeShipIconChannel(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Forward-slashed and relative to the data root; anything escaping it is rejected. */
function normalizeRelativePath(raw: string): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const text = raw.replace(/\\/g, '/').trim();
    if (text === '' || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return undefined;
    const segments: string[] = [];
    for (const segment of text.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') return undefined;
        segments.push(segment);
    }
    return segments.length > 0 ? segments.join('/') : undefined;
}

function toFileSystemPath(root: string, relativePath: string): string {
    return path.join(root, ...relativePath.split('/'));
}

/** Locale-independent, case-insensitive first and exact second. */
function compareNames(left: string, right: string): number {
    const foldedLeft = left.toLowerCase();
    const foldedRight = right.toLowerCase();
    if (foldedLeft !== foldedRight) return foldedLeft < foldedRight ? -1 : 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

// ── File probes ──────────────────────────────────────────────────────────────

async function readTextFileIfSmall(filePath: string): Promise<string | undefined> {
    try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) return undefined;
        return await fs.promises.readFile(filePath, 'utf8');
    } catch {
        // A missing or unreadable candidate falls through to the next layer.
        return undefined;
    }
}

async function readBinaryFileIfSmall(filePath: string): Promise<ArrayBuffer | undefined> {
    try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile() || stats.size > MAX_BINARY_BYTES) return undefined;
        const buffer = await fs.promises.readFile(filePath);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    } catch {
        return undefined;
    }
}

async function listDirectory(directoryPath: string): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
        return entries.map((entry) => entry.name).sort(compareNames);
    } catch {
        return [];
    }
}

// ── Layered data source ──────────────────────────────────────────────────────

/**
 * Workspace roots shadow the vanilla game root file by file: the first layer that
 * has a path wins. Directory listings are the union of every layer, ordered by the
 * same priority so a scan sees shadowed files first.
 */
class LayeredShipIconDataSource implements ShipIconDataSource {
    private readonly layers: readonly string[];

    constructor(workspaceRoots: readonly string[], vanillaRoot: string) {
        const layers: string[] = [];
        const seen = new Set<string>();
        for (const root of [...workspaceRoots, vanillaRoot]) {
            if (typeof root !== 'string' || root.trim() === '') continue;
            const key = root.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            layers.push(root);
        }
        this.layers = layers;
    }

    async readText(relativePath: string): Promise<string | undefined> {
        const normalized = normalizeRelativePath(relativePath);
        if (normalized === undefined) return undefined;
        for (const layer of this.layers) {
            const content = await readTextFileIfSmall(toFileSystemPath(layer, normalized));
            if (content !== undefined) return content;
        }
        return undefined;
    }

    /** Raw bytes for one .mesh file, resolved through the same layer priority. */
    async readBinary(relativePath: string): Promise<ArrayBuffer | undefined> {
        const normalized = normalizeRelativePath(relativePath);
        if (normalized === undefined) return undefined;
        for (const layer of this.layers) {
            const content = await readBinaryFileIfSmall(toFileSystemPath(layer, normalized));
            if (content !== undefined) return content;
        }
        return undefined;
    }

    async listFiles(relativeDirectory: string): Promise<string[]> {
        const normalized = normalizeRelativePath(relativeDirectory);
        if (normalized === undefined) return [];
        const merged: string[] = [];
        const seen = new Set<string>();
        for (const layer of this.layers) {
            for (const name of await listDirectory(toFileSystemPath(layer, normalized))) {
                if (name === '') continue;
                const relative = normalized + '/' + name;
                const key = relative.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(relative);
            }
        }
        return merged;
    }
}

// ── Game path ────────────────────────────────────────────────────────────────

/** Vanilla root: the Stellaris profile's configured cache path, as every other command reads it. */
function resolveVanillaGamePath(): string | undefined {
    const profile = getProfileByLanguageId('stellaris');
    const settingName = profile.cacheSettingKey.replace(/^stellarisLanguageServices\./, '');
    const configured = vs.workspace.getConfiguration('stellarisLanguageServices').get<string>(settingName);
    const candidate = typeof configured === 'string' ? configured.trim() : '';
    if (candidate === '') return undefined;
    try {
        return fs.statSync(candidate).isDirectory() ? candidate : undefined;
    } catch {
        // Unset, moved or unreadable: treat it exactly like "not configured".
        return undefined;
    }
}

function collectWorkspaceRoots(): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const folder of vs.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file') continue;
        const root = folder.uri.fsPath;
        const key = root.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        roots.push(root);
    }
    return roots;
}

// ── Picks ────────────────────────────────────────────────────────────────────

function allowsCulture(info: ShipSizeInfo, culture: string): boolean {
    if (info.icon === undefined || info.icon === '') return false;
    if (info.graphicalCultures.length === 0) return true;
    const wanted = culture.toLowerCase();
    return info.graphicalCultures.some((entry) => entry.toLowerCase() === wanted);
}

/** Ship sizes that render for a culture: an icon is required, a restriction must match. */
function selectableShipSizes(catalog: ShipIconCatalog, culture: string): string[] {
    const names: string[] = [];
    for (const [name, info] of catalog.shipSizes) {
        if (allowsCulture(info, culture)) names.push(name);
    }
    names.sort(compareNames);
    return names;
}

/**
 * Sizes the selection offers: what the culture allows, plus every size the user
 * pinned manually — an override replaces the model chain, so the culture no
 * longer decides whether that size can be drawn.
 */
function candidateShipSizes(
    catalog: ShipIconCatalog,
    culture: string,
    overrides: Readonly<Record<string, readonly string[]>>,
): string[] {
    const names: string[] = [];
    for (const [name, info] of catalog.shipSizes) {
        if (allowsCulture(info, culture) || overrideEntriesFor(overrides, name) !== undefined) names.push(name);
    }
    names.sort(compareNames);
    return names;
}

async function pickGraphicalCulture(catalog: ShipIconCatalog): Promise<string | undefined> {
    const sizesByCulture = new Map<string, number>();
    for (const culture of catalog.graphicalCultures) {
        sizesByCulture.set(culture, selectableShipSizes(catalog, culture).length);
    }
    const items = catalog.graphicalCultures.map((culture) => {
        const count = sizesByCulture.get(culture) ?? 0;
        return {
            label: culture,
            description: localize(`${count} ship size(s)`, `${count} 个可用尺寸`),
        };
    });
    const picked = await vs.window.showQuickPick(items, {
        title: localize('Ship Icon Sheet: Graphical Culture', '舰船顶部图标表：图形文化'),
        placeHolder: localize('Pick the graphical culture whose models are rendered', '选择要渲染模型的图形文化'),
        matchOnDescription: true,
        ignoreFocusOut: true,
    });
    return picked?.label;
}

interface SizePick extends vs.QuickPickItem { role: 'size'; shipSize: string; }
interface ManualPick extends vs.QuickPickItem { role: 'manual'; }

/**
 * The second step mixes the manual entry with the sizes. `role` is what tells
 * them apart, so the manual item can never be mistaken for a ship size name.
 */
type SizeItem = SizePick | ManualPick;

interface SizeState {
    overrides: Record<string, string[]>;
    /** shipSize -> resolution for every catalog size; undefined when the pass failed. */
    resolved: Map<string, ResolvedShipIcon> | undefined;
    /** Sizes worth offering: they resolve to at least one mesh. */
    renderable: string[];
    categories: ShipIconCategory[];
    /** Every catalog size, sorted; the manual picker lists all of them. */
    allSizes: string[];
}

/** The override setting, normalized; invalid entries and empty lists are dropped. */
function readMeshOverrides(): Record<string, string[]> {
    const configured: unknown = vs.workspace.getConfiguration(SHIP_ICON_SETTINGS_SECTION).get<unknown>(MESH_OVERRIDES_KEY);
    return normalizeMeshOverrides(configured);
}

/**
 * One resolution pass over the whole catalog: the drawable sizes come from it, and
 * so do the mesh counts the manual picker shows. A failed pass leaves every size
 * selectable instead of aborting the dialog.
 */
function buildSizeState(
    catalog: ShipIconCatalog,
    culture: string,
    overrides: Record<string, string[]>,
): SizeState {
    const allSizes = [...catalog.shipSizes.keys()].sort(compareNames);
    let resolved: Map<string, ResolvedShipIcon> | undefined;
    try {
        const entries = resolveShipIcons(catalog, { graphicalCulture: culture, shipSizes: allSizes, overrides });
        resolved = new Map(entries.map((entry) => [entry.shipSize, entry]));
    } catch (error) {
        ErrorReporter.debug('ShipIcons', 'Ship icon size resolution failed', error);
        resolved = undefined;
    }

    const candidates = candidateShipSizes(catalog, culture, overrides);
    const renderable = resolved === undefined
        ? candidates
        : candidates.filter((name) => (resolved.get(name)?.meshFiles.length ?? 0) > 0);

    return {
        overrides,
        resolved,
        renderable,
        categories: categorizeShipSizes(renderable.map((name) => ({
            shipSize: name,
            shipClass: catalog.shipSizes.get(name)?.shipClass,
        }))),
        allSizes,
    };
}

interface CategoryPick extends vs.QuickPickItem { categoryId: ShipIconCategoryId; }

async function pickCategories(state: SizeState): Promise<ShipIconCategoryId[] | undefined> {
    const items: CategoryPick[] = state.categories.map((category) => {
        const count = category.shipSizes.length;
        return {
            label: localize(category.labelEn, category.labelZh),
            description: localize(`${count} ship size(s) with a mesh`, `${count} 个尺寸可出图`),
            categoryId: category.id,
        };
    });
    const picked = await vs.window.showQuickPick(items, {
        title: localize('Ship Icon Sheet: Categories', '舰船顶部图标表：类别'),
        placeHolder: localize('Pick one or more categories', '选择一个或多个类别'),
        canPickMany: true,
        matchOnDescription: true,
        ignoreFocusOut: true,
    });
    if (picked === undefined) return undefined;
    if (picked.length === 0) {
        void vs.window.showWarningMessage(localize('Pick at least one category.', '请至少选择一个类别。'));
        return undefined;
    }
    return picked.map((item) => item.categoryId);
}

/** The pickable first entry of the second step: it opens the manual override flow. */
function manualOverrideItem(): ManualPick {
    return {
        role: 'manual',
        label: localize(
            '$(edit) Specify the entity or mesh of a ship size manually…',
            '$(edit) 手动指定某个尺寸的实体或网格…',
        ),
        description: localize(
            `writes ${SHIP_ICON_SETTINGS_SECTION}.${MESH_OVERRIDES_KEY}`,
            `写入设置 ${SHIP_ICON_SETTINGS_SECTION}.${MESH_OVERRIDES_KEY}`,
        ),
        alwaysShow: true,
    };
}

function describeSize(state: SizeState, name: string): SizePick {
    const resolved = state.resolved?.get(name);
    const override = overrideEntriesFor(state.overrides, name);
    const parts: string[] = [];
    if (resolved !== undefined && resolved.frame > 0) {
        parts.push(localize(`frame ${resolved.frame}`, `帧 ${resolved.frame}`));
    }
    if (resolved !== undefined) {
        parts.push(localize(`${resolved.meshFiles.length} mesh(es)`, `${resolved.meshFiles.length} 个分段`));
    }
    if (override !== undefined) parts.push(localize('manually specified', '已手动指定'));

    const details: string[] = [];
    if (override !== undefined) {
        details.push(localize(`override: ${override.join(', ')}`, `手动指定：${override.join(', ')}`));
    }
    const warnings = resolved?.warnings ?? [];
    if (warnings.length > 0) details.push(warnings.slice(0, 4).join(' · '));

    return {
        role: 'size',
        label: name,
        description: parts.length > 0 ? parts.join(' · ') : undefined,
        detail: details.length > 0 ? details.join(' · ') : undefined,
        shipSize: name,
    };
}

type SizePickOutcome = { role: 'sizes'; shipSizes: string[] } | { role: 'manual' };

async function pickSizeItems(state: SizeState, names: readonly string[]): Promise<SizePickOutcome | undefined> {
    const items: SizeItem[] = [manualOverrideItem(), ...names.map((name) => describeSize(state, name))];
    const picked = await vs.window.showQuickPick(items, {
        title: localize('Ship Icon Sheet: Ship Sizes', '舰船顶部图标表：舰船尺寸'),
        placeHolder: localize('Pick one or more ship sizes', '选择一个或多个舰船尺寸'),
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
    });
    if (picked === undefined) return undefined;

    const shipSizes: string[] = [];
    let manual = false;
    for (const item of picked) {
        if (item.role === 'manual') manual = true;
        else shipSizes.push(item.shipSize);
    }
    // The manual entry wins over any size ticked in the same answer.
    if (manual) return { role: 'manual' };
    if (shipSizes.length === 0) {
        void vs.window.showWarningMessage(localize('Pick at least one ship size.', '请至少选择一个舰船尺寸。'));
        return undefined;
    }
    return { role: 'sizes', shipSizes: shipSizes.sort(compareNames) };
}

interface OverrideSizePick extends vs.QuickPickItem { shipSize: string; }

/** The manual picker spans the whole catalog, including sizes the mesh filter removed. */
async function pickOverrideShipSize(state: SizeState): Promise<string | undefined> {
    const items: OverrideSizePick[] = state.allSizes.map((name) => {
        const resolved = state.resolved?.get(name);
        const meshes = resolved?.meshFiles.length ?? 0;
        const override = overrideEntriesFor(state.overrides, name);
        const parts: string[] = [];
        if (resolved === undefined) {
            parts.push(localize('not resolved', '未能解析'));
        } else if (meshes === 0) {
            parts.push(localize('no mesh / no section', '缺模型/无分段'));
        } else {
            parts.push(localize(`${meshes} mesh(es)`, `${meshes} 个分段`));
        }
        if (override !== undefined) parts.push(localize('manually specified', '已手动指定'));
        return {
            label: name,
            description: parts.join(' · '),
            detail: override === undefined
                ? undefined
                : localize(`override: ${override.join(', ')}`, `手动指定：${override.join(', ')}`),
            shipSize: name,
        };
    });
    const picked = await vs.window.showQuickPick(items, {
        title: localize('Ship Icon Sheet: Manual Mesh Override', '舰船顶部图标表：手动指定'),
        placeHolder: localize('Pick the ship size to specify', '选择要手动指定的舰船尺寸'),
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
    });
    return picked?.shipSize;
}

/** Merges one size into the workspace setting; an empty list removes it again. */
async function saveMeshOverride(shipSize: string, entries: readonly string[]): Promise<void> {
    const next: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(readMeshOverrides())) {
        if (key.toLowerCase() === shipSize.toLowerCase()) continue;
        next[key] = values;
    }
    if (entries.length > 0) next[shipSize] = [...entries];
    try {
        await vs.workspace.getConfiguration(SHIP_ICON_SETTINGS_SECTION)
            .update(MESH_OVERRIDES_KEY, next, vs.ConfigurationTarget.Workspace);
    } catch (error) {
        ErrorReporter.debug('ShipIcons', 'Writing meshOverrides failed', error);
        const message = error instanceof Error ? error.message : String(error);
        void vs.window.showErrorMessage(localize(
            `Could not write ${SHIP_ICON_SETTINGS_SECTION}.${MESH_OVERRIDES_KEY}: ${message}`,
            `无法写入设置 ${SHIP_ICON_SETTINGS_SECTION}.${MESH_OVERRIDES_KEY}：${message}`,
        ));
    }
}

async function specifyMeshOverride(state: SizeState): Promise<void> {
    const shipSize = await pickOverrideShipSize(state);
    if (shipSize === undefined) return;
    const current = overrideEntriesFor(state.overrides, shipSize) ?? [];
    const input = await vs.window.showInputBox({
        title: localize(`Mesh override: ${shipSize}`, `手动指定：${shipSize}`),
        prompt: localize(
            'Entity name(s) or .mesh path(s) relative to the game root, separated by commas or semicolons. ' +
            'Leave empty to clear the override.',
            '实体名或相对游戏根的 .mesh 路径，多个用逗号或分号分隔；留空表示清除该尺寸的手动指定。',
        ),
        value: current.join(', '),
        placeHolder: localize(
            'humanoid_01_corvette_entity, gfx/models/ships/hull.mesh',
            '实体名 或 gfx/models/ships/hull.mesh',
        ),
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() !== '' && parseMeshOverrideEntries(value).length === 0
            ? localize('Every entry is blank or walks up a directory.', '每个条目都是空的或含 ".."，无法使用。')
            : undefined,
    });
    if (input === undefined) return;
    await saveMeshOverride(shipSize, parseMeshOverrideEntries(input));
}

function categoryShipSizes(state: SizeState, ids: readonly ShipIconCategoryId[]): string[] {
    const wanted = new Set<ShipIconCategoryId>(ids);
    const names: string[] = [];
    for (const category of state.categories) {
        if (wanted.has(category.id)) names.push(...category.shipSizes);
    }
    return names.sort(compareNames);
}

/**
 * The two-step selection. A manual override re-resolves and returns to the second
 * step with the same categories, so the size it just fixed is now listed.
 */
async function chooseShipSizes(catalog: ShipIconCatalog, culture: string): Promise<string[] | undefined> {
    let categoryIds: ShipIconCategoryId[] | undefined;
    let warnedResolutionFailure = false;
    for (;;) {
        const state = buildSizeState(catalog, culture, readMeshOverrides());
        if (state.resolved === undefined && !warnedResolutionFailure) {
            warnedResolutionFailure = true;
            void vs.window.showWarningMessage(localize(
                'Ship icon resolution failed; every ship size is listed without the mesh filter.',
                '舰船图标解析失败，已列出全部尺寸（未按 mesh 过滤）。',
            ));
        }
        if (state.renderable.length === 0) {
            void vs.window.showWarningMessage(localize(
                `No ship size of graphical culture "${culture}" resolves to a mesh. Fill the gaps with a manual specification first.`,
                `图形文化 "${culture}" 下没有可出图的尺寸，可先用手动指定补齐。`,
            ));
            return undefined;
        }
        if (categoryIds === undefined) {
            const picked = await pickCategories(state);
            if (picked === undefined) return undefined;
            categoryIds = picked;
        }
        const names = categoryShipSizes(state, categoryIds);
        if (names.length === 0) {
            // The categories picked earlier no longer hold a drawable size.
            categoryIds = undefined;
            continue;
        }
        const outcome = await pickSizeItems(state, names);
        if (outcome === undefined) return undefined;
        if (outcome.role === 'manual') {
            await specifyMeshOverride(state);
            continue;
        }
        return outcome.shipSizes;
    }
}

interface AmbiguousSlot {
    shipSize: string;
    slot: string;
    candidates: ShipSectionTemplateInfo[];
}

function sectionsForShipSize(catalog: ShipIconCatalog, shipSize: string): ShipSectionTemplateInfo[] {
    const wanted = shipSize.toLowerCase();
    for (const [key, sections] of catalog.sectionsByShipSize) {
        if (key.toLowerCase() === wanted) return sections;
    }
    return [];
}

/** Slots that offer more than one section template, in declared slot order. */
function ambiguousSlots(catalog: ShipIconCatalog, shipSizes: readonly string[]): AmbiguousSlot[] {
    const ambiguous: AmbiguousSlot[] = [];
    for (const shipSize of shipSizes) {
        const info = catalog.shipSizes.get(shipSize);
        if (info === undefined) continue;
        const sections = sectionsForShipSize(catalog, shipSize);
        for (const slot of info.sectionSlots) {
            const candidates = sections.filter((section) => section.slot.toLowerCase() === slot.slot.toLowerCase());
            if (candidates.length > 1) ambiguous.push({ shipSize, slot: slot.slot, candidates });
        }
    }
    return ambiguous;
}

interface OverrideModePick extends vs.QuickPickItem { manual: boolean; }
interface OverridePick extends vs.QuickPickItem { key: string; }

/** Returns the overrides, or undefined when the user dismissed the question. */
async function chooseSectionOverrides(ambiguous: readonly AmbiguousSlot[]): Promise<Record<string, string> | undefined> {
    const modes: OverrideModePick[] = [
        {
            label: localize('Use the default (first candidate of every slot)', '按默认（每个槽位取第一个）'),
            manual: false,
        },
        {
            label: localize('Choose each slot manually', '手动指定'),
            manual: true,
        },
    ];
    const mode = await vs.window.showQuickPick(modes, {
        title: localize(
            `${ambiguous.length} slot(s) offer several section variants. Choose them manually?`,
            `有 ${ambiguous.length} 个槽位存在多个分段变体，要手动指定吗？`,
        ),
        placeHolder: localize('Defaults keep the first section of every slot', '默认方式对每个槽位取第一个分段'),
        ignoreFocusOut: true,
    });
    if (mode === undefined) return undefined;
    if (!mode.manual) return {};

    const overrides: Record<string, string> = {};
    for (const choice of ambiguous) {
        const items: OverridePick[] = choice.candidates.map((candidate, index) => ({
            label: index === 0
                ? localize(`${candidate.key} (default)`, `${candidate.key}（默认）`)
                : candidate.key,
            description: candidate.entity,
            key: candidate.key,
        }));
        const picked = await vs.window.showQuickPick(items, {
            title: localize(`${choice.shipSize}: slot ${choice.slot}`, `${choice.shipSize}：槽位 ${choice.slot}`),
            placeHolder: localize('Pick the section template to render', '选择要渲染的分段模板'),
            ignoreFocusOut: true,
        });
        if (picked === undefined) continue;
        const index = choice.candidates.findIndex((candidate) => candidate.key === picked.key);
        if (index > 0) overrides[`${choice.shipSize}:${choice.slot}`] = picked.key;
    }
    return overrides;
}

// ── Output paths ─────────────────────────────────────────────────────────────

function ensureDdsExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase() === '.dds' ? filePath : `${filePath}.dds`;
}

/** `ship_sizes_top.dds` -> `ship_sizes_top_damaged.dds`, anything else gains a suffix. */
function damagedPathFor(normalPath: string): string {
    const parsed = path.parse(normalPath);
    const replaced = parsed.name.replace(new RegExp(DAMAGED_MARKER, 'i'), DAMAGED_MARKER_REPLACEMENT);
    const base = replaced === parsed.name ? `${parsed.name}_damaged` : replaced;
    return path.join(parsed.dir, `${base}${parsed.ext}`);
}

function defaultSheetPath(roots: readonly string[]): string | undefined {
    const root = roots[0];
    if (root === undefined) return undefined;
    return path.join(root, ...DEFAULT_SHEET_RELATIVE_PATH.split('/'));
}

// ── Reporting ────────────────────────────────────────────────────────────────

interface SheetSummary { label: string; sheet: ShipIconSheetResult; }

function collectWarnings(summaries: readonly SheetSummary[], catalogWarnings: readonly string[]): string[] {
    const lines: string[] = [];
    for (const warning of catalogWarnings) lines.push(`[catalog] ${warning}`);
    for (const summary of summaries) {
        for (const warning of summary.sheet.warnings) lines.push(`[${summary.label}] ${warning}`);
        for (const placed of summary.sheet.placed) {
            for (const warning of placed.warnings) lines.push(`[${summary.label}] ${placed.shipSize}: ${warning}`);
        }
    }
    return lines;
}

function describeSheets(summaries: readonly SheetSummary[]): string[] {
    const lines: string[] = [];
    for (const summary of summaries) {
        const alignment = summary.sheet.alignment;
        lines.push(`[${summary.label}] ${summary.sheet.image.width}x${summary.sheet.image.height}, ` +
            `${summary.sheet.frameCount} frame(s), ${summary.sheet.placed.length} ship size(s) ` +
            `(aligned ${alignment.aligned}, packed ${alignment.packed}, widened ${alignment.widened})`);
        for (const placed of summary.sheet.placed) {
            lines.push(`  frame ${placed.frame} (${placed.kind}): ${placed.shipSize} <- ${placed.meshFiles.join(', ')}`);
        }
    }
    return lines;
}

// ── .gfx snippet ─────────────────────────────────────────────────────────────

const SHEET_TEXTURE_DIRECTORY = 'gfx/interface/icons/ship_parts/ship_sizes';
const SNIPPET_SECTION_HEADER = '---- .gfx snippet ----';

/** The catalog is plain case-sensitive maps, and game data is not consistent about case. */
function catalogShipSize(catalog: ShipIconCatalog, shipSize: string): ShipSizeInfo | undefined {
    const exact = catalog.shipSizes.get(shipSize);
    if (exact !== undefined) return exact;
    const lowered = shipSize.toLowerCase();
    for (const [key, info] of catalog.shipSizes) {
        if (key.toLowerCase() === lowered) return info;
    }
    return undefined;
}

function spriteSheetOf(catalog: ShipIconCatalog, sprite: string): string | undefined {
    const exact = catalog.spriteIconSheet.get(sprite);
    if (exact !== undefined) return exact;
    const lowered = sprite.toLowerCase();
    for (const [key, sheet] of catalog.spriteIconSheet) {
        if (key.toLowerCase() === lowered) return sheet;
    }
    return undefined;
}

/** GFX_kuat_ship_sizes_top -> GFX_kuat_ship_sizes_top_damaged, matching the damaged file naming. */
function damagedSheetSpriteName(sheet: string): string {
    return /_top$/i.test(sheet) ? `${sheet.slice(0, -4)}_top_damaged` : `${sheet}_damaged`;
}

interface SheetSpriteNames { normal: string; damaged: string; }

/** Every size of one build shares one sheet, so the first icon that names it decides both sprites. */
function resolveSheetSpriteNames(catalog: ShipIconCatalog, icons: readonly string[]): SheetSpriteNames | undefined {
    for (const icon of icons) {
        const normal = spriteSheetOf(catalog, `GFX_${icon}_top`);
        if (normal === undefined || normal === '') continue;
        const damaged = spriteSheetOf(catalog, `GFX_${icon}_top_damaged`) ?? damagedSheetSpriteName(normal);
        return { normal, damaged };
    }
    return undefined;
}

/** One snippet entry per placed size: the frame it was drawn in, plus its damaged-sheet frame. */
function snippetEntries(
    catalog: ShipIconCatalog,
    normalSheet: ShipIconSheetResult,
    damagedSheet: ShipIconSheetResult | undefined,
): ShipIconSnippetEntry[] {
    const damagedFrames = new Map<string, number>();
    for (const placed of damagedSheet?.placed ?? []) damagedFrames.set(placed.shipSize.toLowerCase(), placed.frame);
    const entries: ShipIconSnippetEntry[] = [];
    for (const placed of normalSheet.placed) {
        const icon = catalogShipSize(catalog, placed.shipSize)?.icon;
        if (icon === undefined || icon === '') continue;
        entries.push({
            shipSize: placed.shipSize,
            icon,
            frame: placed.frame,
            damagedFrame: damagedFrames.get(placed.shipSize.toLowerCase()) ?? placed.frame,
        });
    }
    return entries;
}

/** The .dds the user actually saved, relative to the game root. */
function sheetTexturePath(filePath: string): string {
    return `${SHEET_TEXTURE_DIRECTORY}/${path.basename(filePath)}`;
}

interface SnippetSection {
    lines: string[];
    /** False when only the reason is reported instead of a snippet. */
    generated: boolean;
}

/**
 * The pastable block, or the one-line reason it was not produced. A missing sheet
 * sprite name is not an error: the layout list is still useful on its own.
 */
function buildSnippetSection(
    catalog: ShipIconCatalog,
    normalSheet: ShipIconSheetResult | undefined,
    damagedSheet: ShipIconSheetResult | undefined,
    normalPath: string,
    damagedPath: string,
): SnippetSection {
    if (normalSheet === undefined) {
        return { lines: [SNIPPET_SECTION_HEADER, '(skipped: no sheet was built)', ''], generated: false };
    }
    const entries = snippetEntries(catalog, normalSheet, damagedSheet);
    if (entries.length === 0) {
        return {
            lines: [SNIPPET_SECTION_HEADER, '(skipped: none of the placed ship sizes has an icon)', ''],
            generated: false,
        };
    }
    const names = resolveSheetSpriteNames(catalog, entries.map((entry) => entry.icon));
    if (names === undefined) {
        return {
            lines: [
                SNIPPET_SECTION_HEADER,
                '(skipped: no spriteType defines a sheet for GFX_<icon>_top, so the sprite names are unknown)',
                '',
            ],
            generated: false,
        };
    }
    const snippet = buildShipIconGfxSnippet({
        sheetSpriteName: names.normal,
        damagedSheetSpriteName: names.damaged,
        frameCount: normalSheet.frameCount,
        entries,
        textureFile: sheetTexturePath(normalPath),
        damagedTextureFile: sheetTexturePath(damagedPath),
        alignment: normalSheet.alignment,
    });
    return { lines: [SNIPPET_SECTION_HEADER, ...snippet.replace(/\n$/, '').split('\n'), ''], generated: true };
}

function writeReport(lines: readonly string[]): void {
    const channel = shipIconChannel();
    channel.clear();
    for (const line of lines) channel.appendLine(line);
}

// ── Command ──────────────────────────────────────────────────────────────────

async function runGenerateShipIconSheet(): Promise<void> {
    const vanillaRoot = resolveVanillaGamePath();
    if (vanillaRoot === undefined) {
        const selectLabel = localize('Select Game Folder', '选择游戏目录');
        const choice = await vs.window.showWarningMessage(
            localize(
                'The Stellaris game folder is not configured. Select it with "cwtools.selectGameFolder" and run this command again.',
                '尚未配置 Stellaris 游戏目录。请先用 "cwtools.selectGameFolder" 选择游戏目录，然后重新执行本命令。',
            ),
            selectLabel,
        );
        if (choice === selectLabel) await vs.commands.executeCommand('cwtools.selectGameFolder');
        return;
    }

    const roots = collectWorkspaceRoots();
    const source = new LayeredShipIconDataSource(roots, vanillaRoot);

    const catalog = await vs.window.withProgress(
        {
            location: vs.ProgressLocation.Notification,
            title: localize('Reading Stellaris ship data...', '正在读取 Stellaris 舰船数据...'),
            cancellable: false,
        },
        () => loadShipIconCatalog(source),
    );
    if (catalog.graphicalCultures.length === 0) {
        void vs.window.showErrorMessage(localize(
            'No graphical culture was found under gfx/models/ships. Check the game folder, then run the command again.',
            '在 gfx/models/ships 下没有找到任何图形文化。请检查游戏目录后重试。',
        ));
        return;
    }

    const culture = await pickGraphicalCulture(catalog);
    if (culture === undefined) return;

    const shipSizes = await chooseShipSizes(catalog, culture);
    if (shipSizes === undefined) return;
    const meshOverrides = readMeshOverrides();

    const ambiguous = ambiguousSlots(catalog, shipSizes);
    let sectionOverrides: Record<string, string> = {};
    if (ambiguous.length > 0) {
        const chosen = await chooseSectionOverrides(ambiguous);
        if (chosen === undefined) return;
        sectionOverrides = chosen;
    }

    let normalResolved: ResolvedShipIcon[];
    let damagedResolved: ResolvedShipIcon[];
    try {
        normalResolved = resolveShipIcons(catalog, {
            graphicalCulture: culture,
            shipSizes,
            sectionOverrides,
            overrides: meshOverrides,
            damaged: false,
        });
        damagedResolved = resolveShipIcons(catalog, {
            graphicalCulture: culture,
            shipSizes,
            sectionOverrides,
            overrides: meshOverrides,
            damaged: true,
        });
    } catch (error) {
        ErrorReporter.debug('ShipIcons', 'Ship icon resolution failed', error);
        const message = error instanceof Error ? error.message : String(error);
        void vs.window.showErrorMessage(localize(
            `Ship icon resolution failed: ${message}`,
            `舰船图标解析失败：${message}`,
        ));
        return;
    }

    const suggested = defaultSheetPath(roots);
    const saved = await vs.window.showSaveDialog({
        title: localize('Save Ship Icon Sheet', '保存舰船顶部图标表'),
        saveLabel: localize('Save', '保存'),
        defaultUri: suggested === undefined ? undefined : vs.Uri.file(suggested),
        filters: { [localize('DDS texture', 'DDS 贴图')]: ['dds'] },
    });
    if (saved === undefined) return;

    const normalPath = ensureDdsExtension(saved.fsPath);
    const damagedPath = damagedPathFor(normalPath);

    const existing = [normalPath, damagedPath].filter((candidate) => fs.existsSync(candidate));
    if (existing.length > 0) {
        const overwriteLabel = localize('Overwrite', '覆盖');
        const names = existing.map((candidate) => path.basename(candidate)).join(', ');
        const choice = await vs.window.showWarningMessage(
            localize(`${names} already exists. Overwrite it?`, `${names} 已存在。覆盖吗？`),
            { modal: true },
            overwriteLabel,
        );
        if (choice !== overwriteLabel) return;
    }

    const readBinary = (relativePath: string): Promise<ArrayBuffer | undefined> => source.readBinary(relativePath);
    const written: string[] = [];
    const failures: string[] = [];
    let normalSheet: ShipIconSheetResult | undefined;
    let damagedSheet: ShipIconSheetResult | undefined;
    let cancelled = false;

    await vs.window.withProgress(
        {
            location: vs.ProgressLocation.Notification,
            title: localize('Generating ship icon sheet...', '正在生成舰船顶部图标表...'),
            cancellable: true,
        },
        async (progress, token): Promise<void> => {
            progress.report({ message: localize('Rendering the normal sheet', '正在渲染正常态') });
            if (token.isCancellationRequested) {
                cancelled = true;
                return;
            }
            normalSheet = await buildShipIconSheet(normalResolved, readBinary, { style: DEFAULT_SHIP_ICON_STYLE });
            progress.report({ message: localize('Rendering the damaged sheet', '正在渲染破损态'), increment: 20 });
            if (token.isCancellationRequested) {
                cancelled = true;
                return;
            }
            damagedSheet = await buildShipIconSheet(damagedResolved, readBinary, {
                style: DEFAULT_SHIP_ICON_STYLE,
                damaged: true,
            });

            const jobs: Array<{ filePath: string; sheet: ShipIconSheetResult; label: string }> = [
                { filePath: normalPath, sheet: normalSheet, label: localize('normal', '正常态') },
                { filePath: damagedPath, sheet: damagedSheet, label: localize('damaged', '破损态') },
            ];
            for (const job of jobs) {
                if (token.isCancellationRequested) {
                    cancelled = true;
                    return;
                }
                progress.report({
                    message: localize(`Writing the ${job.label} sheet`, `正在写入${job.label}图标表`),
                    increment: 40,
                });
                if (job.sheet.image.width <= 0 || job.sheet.image.height <= 0) {
                    failures.push(localize(`${job.label}: the sheet is empty`, `${job.label}：图标表为空`));
                    continue;
                }
                try {
                    const bytes = encodeDdsArgb8888(job.sheet.image);
                    await vs.workspace.fs.writeFile(vs.Uri.file(job.filePath), bytes);
                    written.push(job.filePath);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    failures.push(`${job.label}: ${message}`);
                }
            }
        },
    );

    const summaries: SheetSummary[] = [];
    if (normalSheet !== undefined) summaries.push({ label: localize('normal', '正常态'), sheet: normalSheet });
    if (damagedSheet !== undefined) summaries.push({ label: localize('damaged', '破损态'), sheet: damagedSheet });

    const warnings = collectWarnings(summaries, catalog.warnings);
    const skipped = new Set<string>();
    for (const summary of summaries) {
        for (const file of summary.sheet.skippedFiles) skipped.add(file);
    }

    const overriddenSizes = shipSizes.filter((name) => overrideEntriesFor(meshOverrides, name) !== undefined);
    const snippet = buildSnippetSection(catalog, normalSheet, damagedSheet, normalPath, damagedPath);

    writeReport([
        localize('CWTools ship icon sheet', 'CWTools 舰船顶部图标表'),
        localize(`culture: ${culture}`, `图形文化：${culture}`),
        localize(`ship sizes: ${shipSizes.join(', ')}`, `舰船尺寸：${shipSizes.join(', ')}`),
        ...(overriddenSizes.length === 0
            ? []
            : [localize(
                `manually specified: ${overriddenSizes.join(', ')}`,
                `手动指定：${overriddenSizes.join(', ')}`,
            )]),
        localize(`written files: ${written.join(', ') || '(none)'}`, `已写入文件：${written.join(', ') || '（无）'}`),
        ...describeSheets(summaries),
        ...failures.map((failure) => `[failure] ${failure}`),
        ...warnings,
        ...snippet.lines,
    ]);

    if (written.length === 0) {
        if (cancelled) {
            void vs.window.showWarningMessage(localize(
                'Cancelled before anything was written.',
                '已在写入任何文件之前取消。',
            ));
            return;
        }
        const showOutput = localize('Show Output', '显示输出');
        const detail = failures[0] ?? localize('nothing was written', '没有写入任何文件');
        const choice = await vs.window.showErrorMessage(
            localize(`Ship icon sheet was not written: ${detail}`, `舰船顶部图标表未写入：${detail}`),
            showOutput,
        );
        if (choice === showOutput) shipIconChannel().show(true);
        return;
    }

    const frames = normalSheet?.frameCount ?? damagedSheet?.frameCount ?? 0;
    const sizes = normalSheet?.placed.length ?? damagedSheet?.placed.length ?? 0;
    const alignment = normalSheet?.alignment;
    const placement = alignment === undefined
        ? ''
        : `${alignment.aligned} aligned, ${alignment.packed} packed, ${alignment.widened} widened; `;
    const placementZh = alignment === undefined
        ? ''
        : `其中 ${alignment.aligned} 条对齐、${alignment.packed} 条塞入空闲帧、${alignment.widened} 条加宽整张；`;
    const snippetNote = snippet.generated
        ? localize(
            ` The .gfx snippet is in the "${OUTPUT_CHANNEL_NAME}" output channel.`,
            ` .gfx 片段已写在输出通道 "${OUTPUT_CHANNEL_NAME}"。`,
        )
        : '';
    const summaryText = localize(
        `Wrote ${written.length} DDS file(s): ${frames} frame(s) x ${sizes} ship size(s); ` +
        `${placement}${skipped.size} mesh file(s) skipped, ${warnings.length} warning(s).` + snippetNote,
        `已写入 ${written.length} 个 DDS 文件：${frames} 帧 × ${sizes} 个舰船尺寸；` +
        `${placementZh}跳过 ${skipped.size} 个 mesh 文件，${warnings.length} 条警告。` + snippetNote,
    );
    if (cancelled) {
        void vs.window.showWarningMessage(localize(
            `Cancelled before the last file: ${written.length} DDS file(s) were already written and were not rolled back.`,
            `在完成前被取消：已写出的 ${written.length} 个 DDS 文件不会回滚。`,
        ));
    }

    const previewLabel = localize('Open Preview', '打开预览');
    const previewTarget = written.find((file) => file === normalPath) ?? written[0];
    const choice = await vs.window.showInformationMessage(summaryText, previewLabel);
    if (choice === previewLabel && previewTarget !== undefined) {
        await vs.commands.executeCommand('vscode.open', vs.Uri.file(previewTarget));
    }

    if (warnings.length > REPORTED_WARNING_LIMIT) {
        const showOutput = localize('Show Output', '显示输出');
        const headline = localize(
            `${warnings.length} warnings. The full list is in the "${OUTPUT_CHANNEL_NAME}" output channel.`,
            `共 ${warnings.length} 条警告，完整清单见 "${OUTPUT_CHANNEL_NAME}" 输出通道。`,
        );
        const picked = await vs.window.showWarningMessage(`${headline}\n${warnings.slice(0, REPORTED_WARNING_LIMIT).join('\n')}`, showOutput);
        if (picked === showOutput) shipIconChannel().show(true);
    }
}

async function generateShipIconSheet(): Promise<void> {
    try {
        await runGenerateShipIconSheet();
    } catch (error) {
        ErrorReporter.debug('ShipIcons', 'Ship icon sheet generation failed', error);
        const message = error instanceof Error ? error.message : String(error);
        void vs.window.showErrorMessage(localize(
            `Ship icon sheet generation failed: ${message}`,
            `舰船顶部图标表生成失败：${message}`,
        ));
    }
}

export function registerShipIconCommand(context: vs.ExtensionContext): void {
    context.subscriptions.push(
        vs.commands.registerCommand(COMMAND_ID, () => generateShipIconSheet()),
        { dispose: disposeShipIconChannel },
    );
}
