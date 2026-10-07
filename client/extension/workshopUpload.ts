/**
 * Steam Workshop upload for Paradox mods.
 *
 * The heavy lifting is delegated to `steamworks.js`, but that package dlopens a
 * native module the moment it is `require`d and throws outright on platforms it
 * does not ship binaries for. It is therefore loaded lazily — only when a real
 * upload starts — behind a small {@link SteamUgcClient} adapter so the rest of
 * the extension (and a future replacement library) never depends on it.
 *
 * Everything here runs on the Extension Host. The sidebar form lives in
 * `workshopUploadView.ts`, which drives this module through
 * {@link uploadWorkshopMod}.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ErrorReporter } from './ai/errorReporter';
import { getAllProfiles, getCacheSettingKey } from './gameProfiles';
import { getDescriptorPath, readDescriptor, writeRemoteFileId, type ModDescriptor } from './modDescriptor';
import { localize } from './panelI18n';
import { removeStagingRoot, stageUploadContent, type StagedContent } from './workshopIgnore';
import { hasWorkspaceModDescriptor, inferGameIdFromWorkspace } from './workspaceGameDetection';

/** Command that reveals the upload form for a mod folder. */
export const WORKSHOP_UPLOAD_COMMAND_ID = 'cwtools.workshop.upload';
/** Contributed sidebar webview view id. */
export const WORKSHOP_UPLOAD_VIEW_ID = 'cwtools.workshopUpload';
/** Context key gating the editor/title button on a mod workspace. */
export const WORKSPACE_IS_MOD_CONTEXT_KEY = 'cwtools.workspaceIsMod';
/** Steam rejects preview images of 1 MB or larger. */
export const PREVIEW_MAX_BYTES = 1024 * 1024;
/** Image formats Steam accepts as a workshop preview. */
export const PREVIEW_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg'];

/** Preview fallbacks inside the mod folder, checked in order after `picture`. */
const PREVIEW_FALLBACK_NAMES: readonly string[] = ['thumbnail.png', 'thumbnail.jpg'];

/** Workshop visibility as offered in the UI; `unchanged` never reaches Steam. */
export type WorkshopVisibility = 'unchanged' | 'public' | 'friends' | 'private' | 'unlisted';

export const WORKSHOP_VISIBILITIES: readonly WorkshopVisibility[] = [
    'unchanged',
    'public',
    'friends',
    'private',
    'unlisted',
];

/**
 * Steam visibility codes. `unchanged` is represented by omitting the field so an
 * update never silently re-publishes a private item.
 */
const STEAM_VISIBILITY: Readonly<Record<Exclude<WorkshopVisibility, 'unchanged'>, number>> = {
    public: 0,
    friends: 1,
    private: 2,
    unlisted: 3,
};

/** Translates a UI visibility into the Steam code, or undefined when unchanged. */
export function toSteamVisibility(visibility: WorkshopVisibility): number | undefined {
    return visibility === 'unchanged' ? undefined : STEAM_VISIBILITY[visibility];
}

/** Upload phases reported to the user while Steam works. */
export type WorkshopUploadStage =
    | 'connecting'
    | 'creating'
    | 'staging'
    | 'preparingConfig'
    | 'preparingContent'
    | 'uploadingContent'
    | 'uploadingPreview'
    | 'committing'
    | 'done';

/**
 * `steamworks.js` `UpdateStatus` values 1..5. 0 (`Invalid`) has no meaningful
 * phase and is dropped rather than reported as a bogus step.
 */
const UPDATE_STATUS_STAGES: Readonly<Record<number, WorkshopUploadStage>> = {
    1: 'preparingConfig',
    2: 'preparingContent',
    3: 'uploadingContent',
    4: 'uploadingPreview',
    5: 'committing',
};

/** Maps a `steamworks.js` update status to a user-visible phase. */
export function stageForUpdateStatus(status: number): WorkshopUploadStage | undefined {
    return UPDATE_STATUS_STAGES[status];
}

// ─── Adapter boundary ─────────────────────────────────────────────────────────

/** Item fields sent to Steam. Absent fields are left untouched. */
export interface SteamUgcUpdate {
    title?: string;
    description?: string;
    changeNote?: string;
    previewPath?: string;
    contentPath?: string;
    tags?: string[];
    visibility?: number;
}

/** Progress sample reported by Steam during `updateItemWithCallback`. */
export interface SteamUgcProgress {
    status: number;
    progress: number;
    total: number;
}

/** Normalised result of a create or update call. */
export interface SteamUgcResult {
    itemId: string;
    needsAgreement: boolean;
}

/**
 * The only workshop surface the upload flow depends on. Isolating it here keeps
 * `steamworks.js` (and its native module) behind one replaceable seam.
 */
/** Details of an item already on the Workshop, used to pre-fill the form. */
export interface SteamUgcItemDetails {
    title?: string;
    description?: string;
    tags?: string[];
}

export interface SteamUgcClient {
    createItem(appId: number): Promise<SteamUgcResult>;
    getItemDetails(itemId: string): Promise<SteamUgcItemDetails | undefined>;
    updateItem(
        itemId: string,
        update: SteamUgcUpdate,
        appId: number,
        onSuccess: (result: SteamUgcResult) => void,
        onError: (error: unknown) => void,
        onProgress?: (progress: SteamUgcProgress) => void,
    ): void;
}

/**
 * The slice of `steamworks.js` this adapter uses, declared structurally rather
 * than imported: the package's `.d.ts` exposes const enums that have no runtime
 * representation, and owning the shape keeps the build free of a hard typing
 * dependency on a native module.
 */
interface SteamworksModuleShape {
    init(appId: number): unknown;
}

interface SteamworksApiShape {
    workshop: {
        createItem(appId: number): Promise<unknown>;
        getItem(itemId: bigint, queryConfig?: unknown): Promise<unknown>;
        updateItemWithCallback(
            itemId: bigint,
            updateDetails: SteamUgcUpdate,
            appId: number,
            successCallback: (data: unknown) => void,
            errorCallback: (error: unknown) => void,
            progressCallback?: (data: unknown) => void,
        ): void;
    };
}

/** Native targets `steamworks.js` ships binaries for. */
const SUPPORTED_NATIVE_TARGETS: readonly string[] = [
    'win32-x64',
    'linux-x64',
    'darwin-x64',
    'darwin-arm64',
];

/** True when this machine has a prebuilt `steamworks.js` binary. */
export function isSteamworksPlatformSupported(): boolean {
    return SUPPORTED_NATIVE_TARGETS.includes(`${process.platform}-${process.arch}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isCallable(value: unknown): boolean {
    return typeof value === 'function';
}

function requireSteamworks(): SteamworksModuleShape {
    // Intentionally lazy: requiring the package dlopens a native module and
    // throws on unsupported platforms, so it must never load on activation.
    const loaded: unknown = require('steamworks.js');
    if (!isRecord(loaded) || !isCallable(loaded['init'])) {
        throw new Error('steamworks.js did not expose an init() function.');
    }
    return loaded as unknown as SteamworksModuleShape;
}

/** Cached module handle: only the dlopen is reused, never the session. */
let steamworksModule: SteamworksModuleShape | undefined;

function loadSteamworksModule(): SteamworksModuleShape {
    if (!steamworksModule) {
        steamworksModule = requireSteamworks();
    }
    return steamworksModule;
}

function openSteamworksSession(appId: number): SteamworksApiShape {
    const api: unknown = loadSteamworksModule().init(appId);
    if (!isRecord(api) || !isRecord(api['workshop'])) {
        throw new Error('steamworks.js init() did not return a workshop API.');
    }
    const workshop = api['workshop'];
    if (
        !isCallable(workshop['createItem']) ||
        !isCallable(workshop['getItem']) ||
        !isCallable(workshop['updateItemWithCallback'])
    ) {
        throw new Error('steamworks.js workshop API is missing createItem/getItem/updateItemWithCallback.');
    }
    return api as unknown as SteamworksApiShape;
}

/** Steam allows one API session per app per process; re-initing would fail, so sessions are cached per app id. */
let openSession: { appId: number; api: SteamworksApiShape } | undefined;

function getSteamworksSession(appId: number): SteamworksApiShape {
    if (!openSession || openSession.appId !== appId) {
        openSession = { appId, api: openSteamworksSession(appId) };
    }
    return openSession.api;
}

function normalizeItemDetails(value: unknown): SteamUgcItemDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const details: SteamUgcItemDetails = {};
    if (typeof value['title'] === 'string' && value['title'].trim()) {
        details.title = value['title'];
    }
    if (typeof value['description'] === 'string' && value['description'].trim()) {
        details.description = value['description'];
    }
    if (Array.isArray(value['tags'])) {
        details.tags = value['tags'].filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0);
    }
    return details.title !== undefined || details.description !== undefined || (details.tags?.length ?? 0) > 0
        ? details
        : undefined;
}

/** Bigint/number from Steam, clamped so a bad payload cannot poison progress. */
function toProgressNumber(value: unknown): number {
    if (typeof value === 'bigint') {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
    }
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeProgress(value: unknown): SteamUgcProgress {
    if (!isRecord(value)) {
        throw new Error('Steam reported an unreadable upload progress sample.');
    }
    return {
        status: typeof value['status'] === 'number' ? value['status'] : 0,
        progress: toProgressNumber(value['progress']),
        total: toProgressNumber(value['total']),
    };
}

/** Steam hands item ids back as bigints; the descriptor needs decimal strings. */
function normalizeItemId(value: unknown): string | undefined {
    if (typeof value === 'bigint' || typeof value === 'number') {
        const text = String(value);
        return /^\d+$/.test(text) ? text : undefined;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        return value;
    }
    return undefined;
}

function normalizeUgcResult(value: unknown): SteamUgcResult {
    if (!isRecord(value)) {
        throw new Error(localize('Steam returned an unreadable Workshop response.', 'Steam 返回了无法解析的创意工坊响应。'));
    }
    const itemId = normalizeItemId(value['itemId']);
    if (!itemId) {
        throw new Error(localize('Steam did not return a usable Workshop item id.', 'Steam 没有返回可用的创意工坊物品 ID。'));
    }
    return { itemId, needsAgreement: value['needsToAcceptAgreement'] === true };
}

/** Opens a Steam session for `appId` and adapts it to {@link SteamUgcClient}. */
export function createSteamUgcClient(appId: number): SteamUgcClient {
    if (!Number.isInteger(appId) || appId <= 0) {
        throw new Error(localize('A positive Steam App ID is required.', '需要一个有效的 Steam App ID。'));
    }
    const api = getSteamworksSession(appId);
    return {
        async createItem(targetAppId: number): Promise<SteamUgcResult> {
            return normalizeUgcResult(await api.workshop.createItem(targetAppId));
        },
        async getItemDetails(itemId: string): Promise<SteamUgcItemDetails | undefined> {
            // includeLongDescription: without it Steam only returns the short summary.
            return normalizeItemDetails(await api.workshop.getItem(BigInt(itemId), { includeLongDescription: true }));
        },
        updateItem(
            itemId: string,
            update: SteamUgcUpdate,
            targetAppId: number,
            onSuccess: (result: SteamUgcResult) => void,
            onError: (error: unknown) => void,
            onProgress?: (progress: SteamUgcProgress) => void,
        ): void {
            api.workshop.updateItemWithCallback(
                BigInt(itemId),
                update,
                targetAppId,
                (data: unknown) => {
                    try {
                        onSuccess(normalizeUgcResult(data));
                    } catch (error) {
                        onError(error);
                    }
                },
                (error: unknown) => onError(error),
                onProgress
                    ? (data: unknown) => {
                        try {
                            onProgress(normalizeProgress(data));
                        } catch (error) {
                            // A malformed progress sample must not abort the upload.
                            ErrorReporter.debug('WorkshopUpload', 'Ignored an unreadable Steam progress sample', error);
                        }
                    }
                    : undefined,
            );
        },
    };
}

/**
 * Best-effort read of an item already on the Workshop, used to pre-fill the
 * form for updates. Never throws: Steam being offline or the item being
 * unreadable simply means the form falls back to local data.
 */
export async function fetchExistingItemDetails(appIdText: string, itemId: string): Promise<SteamUgcItemDetails | undefined> {
    const appId = parseAppId(appIdText);
    if (appId === undefined || !/^\d+$/.test(itemId) || !isSteamworksPlatformSupported()) {
        return undefined;
    }
    try {
        return await createSteamUgcClient(appId).getItemDetails(itemId);
    } catch (error) {
        ErrorReporter.debug('WorkshopUpload', `Could not read existing Workshop item ${itemId}`, error);
        return undefined;
    }
}

// ─── Mod root / descriptor helpers ────────────────────────────────────────────

const DESCRIPTOR_PICTURE_LINE = /^[ \t]*picture[ \t]*=[ \t]*"([^"]+)"/m;

/**
 * Reads the `picture` field of a Paradox descriptor.
 *
 * `modDescriptor.ts` deliberately models only the fields the language server
 * cares about, so the preview reference is read here rather than widening that
 * shared contract from an upload-only consumer.
 */
function readDescriptorPicture(modRoot: string): string | undefined {
    try {
        const match = fs.readFileSync(getDescriptorPath(modRoot), 'utf8').match(DESCRIPTOR_PICTURE_LINE);
        return match?.[1]?.trim() || undefined;
    } catch {
        return undefined;
    }
}

/** True when the file exists, has a Steam-accepted extension and is under 1 MB. */
export function isUsablePreviewPath(candidate: string): boolean {
    if (!PREVIEW_EXTENSIONS.includes(path.extname(candidate).toLowerCase())) return false;
    try {
        const stat = fs.statSync(candidate);
        return stat.isFile() && stat.size < PREVIEW_MAX_BYTES;
    } catch {
        return false;
    }
}

/**
 * Default preview for a mod: the descriptor's `picture` target when it is
 * usable, otherwise the first existing `thumbnail.png` / `thumbnail.jpg`.
 */
export function resolveDefaultPreviewPath(modRoot: string): string | undefined {
    const picture = readDescriptorPicture(modRoot);
    if (picture) {
        const candidate = path.isAbsolute(picture) ? picture : path.join(modRoot, picture);
        if (isUsablePreviewPath(candidate)) return candidate;
    }
    for (const name of PREVIEW_FALLBACK_NAMES) {
        const candidate = path.join(modRoot, name);
        if (isUsablePreviewPath(candidate)) return candidate;
    }
    return undefined;
}

function configuredGamePathLookup(gameId: string): string | undefined {
    const configured = vscode.workspace
        .getConfiguration('stellarisLanguageServices')
        .get<string>(getCacheSettingKey(gameId), '')
        ?.trim();
    return configured || undefined;
}

/**
 * Steam App ID for a detected game, falling back to the user's override.
 * Placeholder ids ('0', e.g. EU5) and the generic profile never qualify.
 */
export function resolveAppId(gameId: string | undefined): string | undefined {
    const profile = gameId ? getAllProfiles().find(candidate => candidate.id === gameId) : undefined;
    const profileAppId = profile?.install.steamAppId?.trim() ?? '';
    if (/^\d+$/.test(profileAppId) && profileAppId !== '0') return profileAppId;
    const override = vscode.workspace
        .getConfiguration('stellarisLanguageServices')
        .get<string>('workshop.appIdOverride', '')
        ?.trim() ?? '';
    return /^\d+$/.test(override) && override !== '0' ? override : undefined;
}

/**
 * Upload target: the workspace folder that owns `resource`, or the first
 * workspace folder when the command was invoked without one.
 */
export function resolveModRoot(resource?: vscode.Uri): string | undefined {
    if (resource) {
        const folder = vscode.workspace.getWorkspaceFolder(resource);
        if (folder) return folder.uri.fsPath;
        try {
            if (resource.scheme === 'file' && fs.statSync(resource.fsPath).isDirectory()) {
                return resource.fsPath;
            }
        } catch {
            // Fall through to the first workspace folder.
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Everything the form and the upload flow need about one mod folder. */
export interface WorkshopTarget {
    modRoot: string;
    gameId?: string;
    appId: string;
    descriptor: ModDescriptor;
    previewPath?: string;
    /** Existing items keep their visibility; new items start private. */
    defaultVisibility: WorkshopVisibility;
}

export type WorkshopTargetErrorCode =
    | 'noWorkspace'
    | 'noDescriptor'
    | 'noAppId'
    | 'unsupportedHost';

export interface WorkshopTargetFailure {
    code: WorkshopTargetErrorCode;
    message: string;
}

export type WorkshopTargetResult =
    | { ok: true; target: WorkshopTarget }
    | { ok: false; failure: WorkshopTargetFailure };

/** Validates a candidate mod folder and resolves the game and Steam App ID. */
export function resolveWorkshopTarget(resource?: vscode.Uri): WorkshopTargetResult {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
        return {
            ok: false,
            failure: {
                code: 'unsupportedHost',
                message: localize(
                    'Uploading to the Steam Workshop needs the desktop VS Code host.',
                    '上传 Steam 创意工坊需要桌面版 VS Code 宿主。'
                ),
            },
        };
    }
    const modRoot = resolveModRoot(resource);
    if (!modRoot) {
        return {
            ok: false,
            failure: {
                code: 'noWorkspace',
                message: localize(
                    'Open a mod folder before uploading to the Steam Workshop.',
                    '请先打开一个 Mod 文件夹再上传到 Steam 创意工坊。'
                ),
            },
        };
    }
    const descriptor = readDescriptor(modRoot);
    if (!descriptor.exists) {
        return {
            ok: false,
            failure: {
                code: 'noDescriptor',
                message: localize(
                    'No descriptor.mod was found in the selected folder.',
                    '所选文件夹中没有 descriptor.mod。'
                ),
            },
        };
    }
    const gameId = inferGameIdFromWorkspace(modRoot, configuredGamePathLookup);
    const appId = resolveAppId(gameId);
    if (!appId) {
        return {
            ok: false,
            failure: {
                code: 'noAppId',
                message: localize(
                    'Could not work out the Steam App ID for this mod. Set "stellarisLanguageServices.workshop.appIdOverride" to the game App ID (for example 281990 for Stellaris).',
                    '无法确定该 Mod 的 Steam App ID。请将 "stellarisLanguageServices.workshop.appIdOverride" 设置为游戏 App ID（例如 Stellaris 为 281990）。'
                ),
            },
        };
    }
    return {
        ok: true,
        target: {
            modRoot,
            gameId,
            appId,
            descriptor,
            previewPath: resolveDefaultPreviewPath(modRoot),
            defaultVisibility: descriptor.remoteFileId ? 'unchanged' : 'private',
        },
    };
}

// ─── Cross-module target hand-off ─────────────────────────────────────────────
// The command hands the resolved mod root to the view without either module
// importing the other, so the dependency stays one-way.

type TargetListener = (modRoot: string) => void;

const targetListeners = new Set<TargetListener>();
let pendingTargetRoot: string | undefined;

/** Records the folder the form should show and notifies any mounted view. */
export function requestWorkshopUploadTarget(modRoot: string): void {
    pendingTargetRoot = modRoot;
    for (const listener of [...targetListeners]) {
        try {
            listener(modRoot);
        } catch (error) {
            ErrorReporter.debug('WorkshopUpload', 'A Workshop target listener failed', error);
        }
    }
}

/** The folder a freshly opened view should start on, if one was requested. */
export function getPendingWorkshopUploadTarget(): string | undefined {
    return pendingTargetRoot;
}

export function onWorkshopUploadTargetRequested(listener: TargetListener): vscode.Disposable {
    targetListeners.add(listener);
    return new vscode.Disposable(() => {
        targetListeners.delete(listener);
    });
}

/** True while an upload owns the Steam session. */
export function isWorkshopUploadInFlight(): boolean {
    return inFlightUpload !== undefined;
}

// ─── Upload flow ──────────────────────────────────────────────────────────────

export interface WorkshopUploadProgress {
    stage: WorkshopUploadStage;
    done: number;
    total: number;
}

export interface WorkshopUploadRequest {
    modRoot: string;
    appId: string;
    title: string;
    description: string;
    tags: string[];
    changeNote: string;
    visibility: WorkshopVisibility;
    previewPath?: string;
    /** Present for an update; absent creates a new workshop item. */
    remoteFileId?: string;
    /** Where the filtered staging copy is created; defaults to the OS temp dir. */
    stagingParent?: string;
    /** Extra gitignore-style exclusions from settings. */
    extraIgnorePatterns?: readonly string[];
    /** Set false to upload the mod folder verbatim, ignoring every rule. */
    applyIgnoreRules?: boolean;
    onProgress?: (progress: WorkshopUploadProgress) => void;
}

export interface WorkshopUploadResult {
    ok: boolean;
    /** True when this run created the workshop item. */
    created: boolean;
    itemId: string;
    url?: string;
    needsAgreement: boolean;
    error?: string;
    /** Non-fatal problem alongside a successful upload (descriptor write-back). */
    warning?: string;
}

let inFlightUpload: Promise<WorkshopUploadResult> | undefined;

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : String(error);
}

function parseAppId(appId: string): number | undefined {
    const trimmed = appId.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeRemoteFileId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && /^\d+$/.test(trimmed) ? trimmed : undefined;
}

/** Community page of a published item, shown to the user after a successful run. */
export function workshopItemUrl(itemId: string): string {
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${itemId}`;
}

function buildUpdate(request: WorkshopUploadRequest, contentPath: string): SteamUgcUpdate {
    const update: SteamUgcUpdate = {
        title: request.title,
        description: request.description,
        changeNote: request.changeNote,
        // The content path is the staging copy when the mod was filtered, and
        // the mod folder itself when nothing had to be excluded.
        contentPath,
        tags: request.tags,
    };
    if (request.previewPath) {
        update.previewPath = request.previewPath;
    }
    const visibility = toSteamVisibility(request.visibility);
    if (visibility !== undefined) {
        update.visibility = visibility;
    }
    return update;
}

interface CommitOutcome {
    ok: boolean;
    itemId: string;
    needsAgreement: boolean;
    error?: string;
}

function commitUpload(
    client: SteamUgcClient,
    itemId: string,
    appId: number,
    request: WorkshopUploadRequest,
    contentPath: string,
    emit: (stage: WorkshopUploadStage, done: number, total: number) => void,
): Promise<CommitOutcome> {
    const update = buildUpdate(request, contentPath);
    return new Promise<CommitOutcome>(resolve => {
        const finish = (outcome: CommitOutcome): void => resolve(outcome);
        try {
            client.updateItem(
                itemId,
                update,
                appId,
                result => finish({ ok: true, itemId: result.itemId, needsAgreement: result.needsAgreement }),
                error => finish({ ok: false, itemId, needsAgreement: false, error: describeError(error) }),
                progress => {
                    const stage = stageForUpdateStatus(progress.status);
                    if (stage) emit(stage, progress.progress, progress.total);
                },
            );
        } catch (error) {
            finish({ ok: false, itemId, needsAgreement: false, error: describeError(error) });
        }
    });
}

/**
 * Stores the freshly created item id in `descriptor.mod`. A failure here is
 * reported but never turns a completed upload into a failed one.
 */
function writeBackRemoteFileId(modRoot: string, itemId: string): string | undefined {
    const descriptorPath = getDescriptorPath(modRoot);
    try {
        if (!/^\d+$/.test(itemId)) {
            throw new Error(`refusing to write a non-numeric remote_file_id: ${itemId}`);
        }
        writeRemoteFileId(descriptorPath, itemId);
        return undefined;
    } catch (error) {
        ErrorReporter.warn('WorkshopUpload', `Failed to write remote_file_id into ${descriptorPath}`, error);
        return localize(
            `Uploaded, but descriptor.mod could not be updated. Add remote_file_id="${itemId}" to it manually.`,
            `上传成功，但未能回写 descriptor.mod。请手动在其中添加 remote_file_id="${itemId}"。`
        );
    }
}

/**
 * Summarises what the ignore rules removed, so a filtered upload is visibly
 * different from an unfiltered one instead of silently shipping less.
 */
function describeStagedContent(staged: StagedContent | undefined): string | undefined {
    if (!staged) return undefined;
    const parts = [
        localize(
            `Uploaded ${staged.fileCount} file(s); ${staged.excludedCount} excluded by ignore rules.`,
            `已上传 ${staged.fileCount} 个文件；忽略规则排除了 ${staged.excludedCount} 项。`
        ),
    ];
    if (staged.skipped.length > 0) {
        const examples = staged.skipped
            .slice(0, 3)
            .map(entry => entry.relativePath)
            .join(', ');
        const more = staged.skipped.length > 3 ? `, +${staged.skipped.length - 3}` : '';
        parts.push(
            localize(
                `Skipped ${staged.skipped.length} link(s) or special file(s) that cannot be copied: ${examples}${more}.`,
                `跳过了 ${staged.skipped.length} 个无法复制的链接或特殊文件：${examples}${more}。`
            )
        );
    }
    return parts.join(' ');
}

async function performUpload(request: WorkshopUploadRequest): Promise<WorkshopUploadResult> {
    const emit = (stage: WorkshopUploadStage, done = 0, total = 0): void => {
        try {
            request.onProgress?.({ stage, done, total });
        } catch (error) {
            // A misbehaving progress sink must not abort the upload.
            ErrorReporter.debug('WorkshopUpload', 'A Workshop progress listener failed', error);
        }
    };
    let created = false;
    try {
        const appId = parseAppId(request.appId);
        if (appId === undefined) {
            return {
                ok: false,
                created,
                itemId: '',
                needsAgreement: false,
                error: localize(
                    'A valid Steam App ID is required before uploading.',
                    '上传前需要一个有效的 Steam App ID。'
                ),
            };
        }
        if (!isSteamworksPlatformSupported()) {
            return {
                ok: false,
                created,
                itemId: '',
                needsAgreement: false,
                error: localize(
                    `Steam Workshop upload is not supported on ${process.platform}-${process.arch}.`,
                    `当前平台 ${process.platform}-${process.arch} 不支持 Steam 创意工坊上传。`
                ),
            };
        }

        emit('connecting');
        const client = createSteamUgcClient(appId);

        let itemId = normalizeRemoteFileId(request.remoteFileId);
        if (itemId === undefined) {
            emit('creating');
            const createdResult = await client.createItem(appId);
            itemId = createdResult.itemId;
            created = true;
        }

        let contentPath = request.modRoot;
        let staged: StagedContent | undefined;
        try {
            emit('staging', 0, 0);
            // With filtering switched off the mod folder itself is uploaded,
            // exactly as it was before ignore support existed.
            if (request.applyIgnoreRules !== false) {
                staged = stageUploadContent(request.modRoot, {
                    stagingParent: request.stagingParent ?? os.tmpdir(),
                    extraPatterns: request.extraIgnorePatterns,
                    onProgress: (done, total) => emit('staging', done, total),
                });
            }
            contentPath = staged?.contentPath ?? request.modRoot;

            const outcome = await commitUpload(client, itemId, appId, request, contentPath, emit);
            if (!outcome.ok) {
                const result: WorkshopUploadResult = {
                    ok: false,
                    created,
                    itemId,
                    needsAgreement: false,
                    error: outcome.error ?? localize('Steam rejected the upload.', 'Steam 拒绝了此次上传。'),
                };
                if (created) {
                    result.warning = localize(
                        `A new empty Workshop item (${itemId}) was created before the failure; it stays unpublished unless you finish it on Steam.`,
                        `失败前已创建新的空白创意工坊物品（${itemId}）；除非你在 Steam 上补完内容，否则它不会发布。`
                    );
                }
                return result;
            }

            // The staging copy is disposable, but the numbers it produced are
            // the only record of what actually shipped.
            const warning = [
                created ? writeBackRemoteFileId(request.modRoot, outcome.itemId) : undefined,
                describeStagedContent(staged),
            ]
                .filter((message): message is string => message !== undefined)
                .join(' ');
            emit('done', 1, 1);
            return {
                ok: true,
                created,
                itemId: outcome.itemId,
                url: workshopItemUrl(outcome.itemId),
                needsAgreement: outcome.needsAgreement,
                warning: warning.length > 0 ? warning : undefined,
            };
        } finally {
            // Always reclaim the copy: a failed or cancelled upload must not
            // leave a full duplicate of the mod in the temp directory.
            removeStagingRoot(staged?.stagingRoot);
        }
    } catch (error) {
        ErrorReporter.warn('WorkshopUpload', `Workshop upload failed for ${request.modRoot}`, error);
        return {
            ok: false,
            created,
            itemId: '',
            needsAgreement: false,
            error: describeError(error),
        };
    }
}

/**
 * Creates or updates the mod's workshop item. Single-flight: Steam allows one
 * upload session per app, so a concurrent request is refused instead of queued.
 */
export function uploadWorkshopMod(request: WorkshopUploadRequest): Promise<WorkshopUploadResult> {
    if (inFlightUpload) {
        return Promise.resolve({
            ok: false,
            created: false,
            itemId: '',
            needsAgreement: false,
            error: localize(
                'Another Steam Workshop upload is already running.',
                '已有一个 Steam 创意工坊上传正在进行中。'
            ),
        });
    }
    const run = performUpload(request);
    inFlightUpload = run;
    return run.finally(() => {
        if (inFlightUpload === run) inFlightUpload = undefined;
    });
}

// ─── Command + context key ────────────────────────────────────────────────────

function showTargetFailure(failure: WorkshopTargetFailure): void {
    const detail = `[${failure.code}]`;
    if (failure.code === 'noAppId' || failure.code === 'unsupportedHost') {
        void vscode.window.showErrorMessage(`${failure.message} ${detail}`);
        ErrorReporter.debug('WorkshopUpload', `Upload target rejected: ${failure.code}`);
        return;
    }
    void vscode.window.showWarningMessage(`${failure.message} ${detail}`);
    ErrorReporter.debug('WorkshopUpload', `Upload target rejected: ${failure.code}`);
}

/**
 * Command entry: validates the target, then hands it to the sidebar form.
 * All editing happens in the form so there is exactly one upload UI.
 */
export async function runWorkshopUploadCommand(resource?: vscode.Uri): Promise<void> {
    const resolved = resolveWorkshopTarget(resource);
    if (!resolved.ok) {
        showTargetFailure(resolved.failure);
        return;
    }
    requestWorkshopUploadTarget(resolved.target.modRoot);
    try {
        await vscode.commands.executeCommand(`${WORKSHOP_UPLOAD_VIEW_ID}.focus`);
    } catch (error) {
        ErrorReporter.warn('WorkshopUpload', 'Could not focus the Workshop upload view', error);
        void vscode.window.showWarningMessage(
            localize(
                'The Steam Workshop upload view could not be opened. Open it from the CWTools sidebar.',
                '无法打开 Steam 创意工坊上传视图，请从 CWTools 侧边栏手动打开。'
            )
        );
    }
}

/**
 * Publishes `cwtools.workspaceIsMod` so the editor/title button only appears
 * while a mod workspace is open.
 */
async function refreshWorkspaceIsModContext(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const isMod = root ? hasWorkspaceModDescriptor(root) : false;
    try {
        await vscode.commands.executeCommand('setContext', WORKSPACE_IS_MOD_CONTEXT_KEY, isMod);
    } catch (error) {
        ErrorReporter.debug('WorkshopUpload', 'Failed to update the workspaceIsMod context key', error);
    }
}

/** Registers the upload command and keeps its editor/title context key fresh. */
export function registerWorkshopUploadCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(WORKSHOP_UPLOAD_COMMAND_ID, (resource?: vscode.Uri) =>
            runWorkshopUploadCommand(resource)
        ),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void refreshWorkspaceIsModContext();
        }),
    );
    void refreshWorkspaceIsModContext();
}
