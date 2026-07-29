import * as vs from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { ErrorReporter } from './ai/errorReporter';
import {
    getAllProfiles,
    getProfileByLanguageId,
    type GameProfile,
} from './gameProfiles';
import { inferGameIdFromWorkspace } from './workspaceGameDetection';
import {
    aggregateDirectorySuggestions,
    isUriPathWithin,
    LatestDirectoryRequest,
    relativeUriPathWithin,
    validateRelativeDirectoryPath,
    VanillaDirectoryCache,
    type DirectorySuggestion,
    type ExistingDirectoryEntry,
} from './directoryCompletions';
import {
    parsePdxSemanticCatalog,
    type PdxDirectoryPath,
    type PdxSemanticCatalog,
} from '../shared/pdxSemanticCatalog';

const SOURCE = 'DirectoryCompletion';
const COMMAND_ID = 'cwtools.createGameDirectory';
const SEMANTIC_TIMEOUT_MS = 5_000;
const VANILLA_TIMEOUT_MS = 4_000;

function tr(en: string, zh: string): string {
    return vs.env.language.toLowerCase().startsWith('zh') ? zh : en;
}

function uriDirectoryName(uri: vs.Uri): string {
    const path = uri.path.replace(/\/+$/, '');
    const separator = path.lastIndexOf('/');
    return separator < 0 ? '' : path.slice(separator + 1);
}

function uriParent(uri: vs.Uri): vs.Uri {
    const path = uri.path.replace(/\/+$/, '');
    const separator = path.lastIndexOf('/');
    return uri.with({ path: separator <= 0 ? '/' : path.slice(0, separator), query: '', fragment: '' });
}

function isDirectory(fileType: vs.FileType): boolean {
    return (fileType & vs.FileType.Directory) !== 0;
}

function isFileNotFound(error: unknown): boolean {
    if (error instanceof vs.FileSystemError) {
        return error.code === 'FileNotFound';
    }
    return error instanceof Error && /(?:FileNotFound|ENOENT|not found)/i.test(error.message);
}

async function statOrUndefined(uri: vs.Uri): Promise<vs.FileStat | undefined> {
    try {
        return await vs.workspace.fs.stat(uri);
    } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
    }
}

function withTimeout<T>(promise: Thenable<T> | Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        Promise.resolve(promise),
        new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function profileForGame(gameId: string): GameProfile | undefined {
    if (gameId === 'paradox') return getProfileByLanguageId('paradox');
    return getAllProfiles().find(profile => profile.id === gameId);
}

function catalogDirectoryPaths(catalog: PdxSemanticCatalog | undefined): PdxDirectoryPath[] {
    if (catalog?.directoryPaths && catalog.directoryPaths.length > 0) return catalog.directoryPaths;
    if (!catalog) return [];
    const merged = new Map<string, Set<string>>();
    for (const definition of catalog.definitionTypes) {
        for (const path of definition.paths) {
            const entityTypes = merged.get(path) ?? new Set<string>();
            entityTypes.add(definition.name);
            merged.set(path, entityTypes);
        }
    }
    return Array.from(merged, ([path, entityTypes]) => ({
        path,
        entityTypes: Array.from(entityTypes).sort(),
    })).sort((left, right) => left.path.localeCompare(right.path));
}

interface SuggestionQuickPickItem extends vs.QuickPickItem {
    suggestion: DirectorySuggestion;
}

export class DirectoryCompletionCommand implements vs.Disposable {
    private readonly vanillaCache = new VanillaDirectoryCache();
    private readonly latestRequest = new LatestDirectoryRequest();
    private activeCancellation?: vs.CancellationTokenSource;
    private activeQuickPick?: vs.QuickPick<SuggestionQuickPickItem>;
    private readonly reportedVanillaFailures = new Set<string>();
    private disposed = false;

    constructor(private readonly getLanguageClient: () => LanguageClient | undefined) {}

    register(context: vs.ExtensionContext): void {
        context.subscriptions.push(
            vs.commands.registerCommand(COMMAND_ID, (resource?: vs.Uri) => this.execute(resource)),
            vs.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('stellarisLanguageServices.cache')) {
                    this.vanillaCache.clear();
                    this.reportedVanillaFailures.clear();
                }
            }),
            this,
        );
    }

    async execute(resource?: vs.Uri): Promise<void> {
        if (this.disposed) return;
        this.cancelActive();
        const requestGeneration = this.latestRequest.begin();
        const cancellation = new vs.CancellationTokenSource();
        this.activeCancellation = cancellation;
        try {
            const target = await this.resolveTarget(resource);
            if (!target || cancellation.token.isCancellationRequested) return;
            const { parent, workspaceFolder } = target;
            const caseInsensitive = parent.scheme === 'file' && process.platform === 'win32';
            const parentRelativePath = relativeUriPathWithin(workspaceFolder.uri, parent, caseInsensitive);
            if (parentRelativePath === undefined) {
                await vs.window.showErrorMessage(tr(
                    'The selected folder is outside the active workspace.',
                    '所选文件夹不在当前工作区内。',
                ));
                return;
            }
            const existingEntries = await this.readExistingEntries(parent);
            const catalogPromise = this.requestSemanticCatalog(cancellation.token);
            const earlyCatalog = await Promise.race([
                catalogPromise,
                new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 800)),
            ]);
            const workspaceGameId = this.gameFromActiveEditor(workspaceFolder) ?? this.inferGame(workspaceFolder);
            const earlyCatalogGameId = this.gameFromCatalog(earlyCatalog);
            let resolvedGameId = this.canRouteCatalogToWorkspace(earlyCatalogGameId, workspaceGameId, workspaceFolder)
                ? earlyCatalogGameId
                : workspaceGameId;
            if (!resolvedGameId) resolvedGameId = await this.pickGame();
            if (!resolvedGameId || cancellation.token.isCancellationRequested) return;
            let gameId: string = resolvedGameId;
            const resolvedProfile = profileForGame(gameId);
            if (!resolvedProfile) return;
            let profile: GameProfile = resolvedProfile;

            const quickPick = vs.window.createQuickPick<SuggestionQuickPickItem>();
            this.activeQuickPick = quickPick;
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;
            quickPick.placeholder = this.quickPickPlaceholder(profile, workspaceFolder.uri);
            quickPick.title = this.quickPickTitle(profile, parentRelativePath);
            quickPick.busy = true;
            let cwtPaths = this.canRouteCatalogToWorkspace(earlyCatalogGameId, gameId, workspaceFolder)
                ? catalogDirectoryPaths(earlyCatalog)
                : [];
            let vanillaChildNames: string[] = [];
            let vanillaLoadGeneration = 0;
            const refresh = (): void => {
                if (cancellation.token.isCancellationRequested || !this.latestRequest.isCurrent(requestGeneration)) return;
                quickPick.items = this.toQuickPickItems(aggregateDirectorySuggestions({
                    parentRelativePath,
                    gameId,
                    cwtPaths,
                    profile,
                    vanillaChildNames,
                    existingEntries,
                    caseInsensitive,
                }));
            };
            refresh();
            quickPick.show();
            const loadVanilla = (targetProfile: GameProfile): void => {
                const loadGeneration = ++vanillaLoadGeneration;
                quickPick.busy = true;
                void this.readVanillaChildren(
                    targetProfile,
                    workspaceFolder.uri,
                    parentRelativePath,
                    cancellation.token,
                ).then(children => {
                    if (loadGeneration !== vanillaLoadGeneration
                        || cancellation.token.isCancellationRequested
                        || !this.latestRequest.isCurrent(requestGeneration)) return;
                    vanillaChildNames = children;
                    quickPick.busy = false;
                    refresh();
                }).catch(error => {
                    if (loadGeneration !== vanillaLoadGeneration) return;
                    quickPick.busy = false;
                    this.reportVanillaFailureOnce(targetProfile, parentRelativePath, error);
                });
            };
            loadVanilla(profile);

            const completion = new Promise<{ path: string; custom: boolean } | undefined>(resolve => {
                const disposables: vs.Disposable[] = [];
                let resolved = false;
                const finish = (value: { path: string; custom: boolean } | undefined): void => {
                    if (resolved) return;
                    resolved = true;
                    for (const disposable of disposables) disposable.dispose();
                    resolve(value);
                };
                disposables.push(
                    quickPick.onDidAccept(() => {
                        const value = quickPick.value.trim();
                        const selected = quickPick.activeItems[0];
                        if (selected && (!value || value === selected.label)) {
                            finish({ path: selected.suggestion.segment, custom: false });
                        } else {
                            finish(value ? { path: value, custom: true } : undefined);
                        }
                        quickPick.hide();
                    }),
                    quickPick.onDidHide(() => finish(undefined)),
                );
            });

            void catalogPromise.then(catalog => {
                if (!catalog || cancellation.token.isCancellationRequested || !this.latestRequest.isCurrent(requestGeneration)) return;
                const catalogGameId = this.gameFromCatalog(catalog);
                if (!this.canRouteCatalogToWorkspace(catalogGameId, workspaceGameId, workspaceFolder)) return;
                if (catalogGameId && catalogGameId !== gameId) {
                    const catalogProfile = profileForGame(catalogGameId);
                    if (catalogProfile) {
                        gameId = catalogGameId;
                        profile = catalogProfile;
                        quickPick.title = this.quickPickTitle(profile, parentRelativePath);
                        quickPick.placeholder = this.quickPickPlaceholder(profile, workspaceFolder.uri);
                        vanillaChildNames = [];
                        loadVanilla(profile);
                    }
                }
                cwtPaths = catalogDirectoryPaths(catalog);
                refresh();
            }).catch(error => {
                ErrorReporter.warn(SOURCE, 'Failed to load the CWT directory catalog', error);
            });

            const selected = await completion;
            quickPick.dispose();
            if (this.activeQuickPick === quickPick) this.activeQuickPick = undefined;
            if (!selected || cancellation.token.isCancellationRequested) return;
            await this.createDirectory(parent, workspaceFolder, selected.path, selected.custom, caseInsensitive);
        } catch (error) {
            ErrorReporter.warn(SOURCE, 'Paradox game folder creation failed', error);
            await vs.window.showErrorMessage(tr(
                `Could not create the game folder: ${error instanceof Error ? error.message : String(error)}`,
                `无法创建游戏文件夹：${error instanceof Error ? error.message : String(error)}`,
            ));
        } finally {
            if (this.activeCancellation === cancellation) {
                this.activeCancellation = undefined;
                cancellation.dispose();
            }
        }
    }

    private async resolveTarget(resource?: vs.Uri): Promise<{ parent: vs.Uri; workspaceFolder: vs.WorkspaceFolder } | undefined> {
        let target = resource;
        if (!target) {
            const editor = vs.window.activeTextEditor;
            if (editor) target = uriParent(editor.document.uri);
        }
        if (!target) {
            const folders = vs.workspace.workspaceFolders ?? [];
            if (folders.length === 1) target = folders[0]?.uri;
            else if (folders.length > 1) {
                const selected = await vs.window.showQuickPick(
                    folders.map(folder => ({ label: folder.name, description: folder.uri.toString(), folder })),
                    { placeHolder: tr('Select a workspace folder', '选择工作区文件夹') },
                );
                target = selected?.folder.uri;
            }
        }
        if (!target) {
            await vs.window.showErrorMessage(tr('Open a workspace folder first.', '请先打开一个工作区文件夹。'));
            return undefined;
        }
        let stat = await vs.workspace.fs.stat(target);
        if (!isDirectory(stat.type)) {
            target = uriParent(target);
            stat = await vs.workspace.fs.stat(target);
        }
        if (!isDirectory(stat.type)) {
            await vs.window.showErrorMessage(tr('The selected resource is not a folder.', '所选资源不是文件夹。'));
            return undefined;
        }
        const workspaceFolder = vs.workspace.getWorkspaceFolder(target);
        if (!workspaceFolder) {
            await vs.window.showErrorMessage(tr('The selected folder is outside the workspace.', '所选文件夹不在工作区内。'));
            return undefined;
        }
        if (vs.workspace.fs.isWritableFileSystem(target.scheme) === false) {
            await vs.window.showErrorMessage(tr(
                `The ${target.scheme} file system is read-only.`,
                `${target.scheme} 文件系统为只读。`,
            ));
            return undefined;
        }
        return { parent: target, workspaceFolder };
    }

    private async readExistingEntries(parent: vs.Uri): Promise<ExistingDirectoryEntry[]> {
        const entries = await vs.workspace.fs.readDirectory(parent);
        return entries
            .map(([name, type]) => ({
                name,
                type: isDirectory(type) ? 'directory' as const : 'file' as const,
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    private async requestSemanticCatalog(token: vs.CancellationToken): Promise<PdxSemanticCatalog | undefined> {
        const client = this.getLanguageClient();
        if (!client || token.isCancellationRequested) return undefined;
        try {
            const raw = await withTimeout(client.sendRequest<unknown>('workspace/executeCommand', {
                command: 'cwtools.ai.getSemanticCatalog',
                arguments: [[], []],
            }), SEMANTIC_TIMEOUT_MS, 'CWT semantic catalog request timed out');
            if (token.isCancellationRequested) return undefined;
            return parsePdxSemanticCatalog(raw);
        } catch (error) {
            if (!token.isCancellationRequested) {
                ErrorReporter.warn(SOURCE, 'Failed to request semantic directory metadata', error);
            }
            return undefined;
        }
    }

    private gameFromCatalog(catalog: PdxSemanticCatalog | undefined): string | undefined {
        return catalog?.gameProfile && profileForGame(catalog.gameProfile) ? catalog.gameProfile : undefined;
    }

    private gameFromActiveEditor(workspaceFolder: vs.WorkspaceFolder): string | undefined {
        const editor = vs.window.activeTextEditor;
        if (!editor || vs.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() !== workspaceFolder.uri.toString()) {
            return undefined;
        }
        return profileForGame(editor.document.languageId)?.id;
    }

    private canRouteCatalogToWorkspace(
        catalogGameId: string | undefined,
        workspaceGameId: string | undefined,
        workspaceFolder: vs.WorkspaceFolder,
    ): boolean {
        if (!catalogGameId) return false;
        if (workspaceGameId && workspaceGameId !== catalogGameId) return false;
        const folders = vs.workspace.workspaceFolders ?? [];
        if (folders.length <= 1) return true;
        const primary = folders[0];
        return workspaceGameId === catalogGameId || primary?.uri.toString() === workspaceFolder.uri.toString();
    }

    private inferGame(workspaceFolder: vs.WorkspaceFolder): string | undefined {
        if (workspaceFolder.uri.scheme !== 'file') return undefined;
        return inferGameIdFromWorkspace(workspaceFolder.uri.fsPath, gameId => {
            const profile = profileForGame(gameId);
            if (!profile) return undefined;
            return vs.workspace.getConfiguration('stellarisLanguageServices', workspaceFolder.uri)
                .get<string>(profile.cacheSettingKey.replace('stellarisLanguageServices.', ''));
        });
    }

    private async pickGame(): Promise<string | undefined> {
        const profiles = [...getAllProfiles(), getProfileByLanguageId('paradox')];
        const selected = await vs.window.showQuickPick(
            profiles.map(profile => ({ label: profile.displayName, description: profile.id, gameId: profile.id })),
            { placeHolder: tr('Select the game for this folder', '选择此文件夹对应的游戏') },
        );
        return selected?.gameId;
    }

    private quickPickTitle(profile: GameProfile, parentRelativePath: string): string {
        const target = parentRelativePath ? `${parentRelativePath}/` : '/';
        return tr(
            `${profile.displayName} · ${target} · Create game folder`,
            `${profile.displayName} · ${target} · 创建游戏文件夹`,
        );
    }

    private quickPickPlaceholder(profile: GameProfile, workspaceUri: vs.Uri): string {
        return this.configuredVanillaPath(profile, workspaceUri)?.trim()
            ? tr(
                'Choose a suggested folder or type a custom relative path',
                '选择建议目录，或输入自定义相对路径',
            )
            : tr(
                'Choose a suggestion or type a custom path (vanilla folder not configured)',
                '选择建议或输入自定义路径（尚未配置原版目录）',
            );
    }

    private toQuickPickItems(suggestions: readonly DirectorySuggestion[]): SuggestionQuickPickItem[] {
        return suggestions.map(suggestion => {
            const visibleEntityTypes = suggestion.entityTypes.slice(0, 8);
            const remainingEntityTypes = suggestion.entityTypes.length - visibleEntityTypes.length;
            return {
                label: suggestion.segment,
                description: suggestion.relativePath,
                detail: `${suggestion.sources.map(source => source === 'cwt'
                ? 'CWT'
                : source === 'profile' ? tr('game convention', '游戏约定') : tr('exists in vanilla', '原版目录中存在')).join(' · ')}${
                    visibleEntityTypes.length > 0 ? ` · ${visibleEntityTypes.join(', ')}${
                        remainingEntityTypes > 0 ? ` +${remainingEntityTypes}` : ''
                    }` : ''
                }`,
                iconPath: new vs.ThemeIcon('folder'),
                suggestion,
            };
        });
    }

    private async readVanillaChildren(
        profile: GameProfile,
        workspaceUri: vs.Uri,
        parentRelativePath: string,
        token: vs.CancellationToken,
    ): Promise<string[]> {
        const configuredPath = this.configuredVanillaPath(profile, workspaceUri);
        if (!configuredPath?.trim()) return [];
        const root = vs.Uri.file(configuredPath);
        const parentSegments = parentRelativePath ? parentRelativePath.split('/') : [];
        const vanillaParent = vs.Uri.joinPath(root, ...parentSegments);
        const key = `${profile.id}|${root.toString()}|${parentRelativePath}`;
        return this.vanillaCache.get(key, token, async () => {
            const entries = await withTimeout(
                vs.workspace.fs.readDirectory(vanillaParent),
                VANILLA_TIMEOUT_MS,
                `Reading ${profile.displayName} vanilla directory timed out`,
            );
            return entries.filter(([, type]) => isDirectory(type)).map(([name]) => name);
        });
    }

    private configuredVanillaPath(profile: GameProfile, workspaceUri: vs.Uri): string | undefined {
        return vs.workspace.getConfiguration('stellarisLanguageServices', workspaceUri)
            .get<string>(profile.cacheSettingKey.replace('stellarisLanguageServices.', ''));
    }

    private reportVanillaFailureOnce(profile: GameProfile, parentRelativePath: string, error: unknown): void {
        const key = `${profile.id}|${parentRelativePath}`;
        if (this.reportedVanillaFailures.has(key)) return;
        this.reportedVanillaFailures.add(key);
        ErrorReporter.warn(
            SOURCE,
            `Could not read immediate vanilla child directories for ${profile.id}/${parentRelativePath || '.'}`,
            error,
        );
    }

    private async createDirectory(
        parent: vs.Uri,
        workspaceFolder: vs.WorkspaceFolder,
        input: string,
        custom: boolean,
        caseInsensitive: boolean,
    ): Promise<void> {
        const validation = validateRelativeDirectoryPath(input, parent.scheme === 'file' && process.platform === 'win32');
        if (!validation.ok) {
            await vs.window.showErrorMessage(tr(
                `Invalid relative folder path (${validation.reason}).`,
                `相对文件夹路径无效（${validation.reason}）。`,
            ));
            return;
        }
        const target = vs.Uri.joinPath(parent, ...validation.segments);
        if (!isUriPathWithin(workspaceFolder.uri, target, caseInsensitive)) {
            await vs.window.showErrorMessage(tr(
                'The target path would leave the current workspace.',
                '目标路径将越出当前工作区。',
            ));
            return;
        }
        if (custom) {
            const workspaceRelative = relativeUriPathWithin(workspaceFolder.uri, target, caseInsensitive) ?? validation.path;
            const createLabel = tr('Create', '创建');
            const choice = await vs.window.showInformationMessage(
                tr(`Create folder “${workspaceRelative}”?`, `创建文件夹“${workspaceRelative}”？`),
                { modal: true },
                createLabel,
            );
            if (choice !== createLabel) return;
        }
        const parentStat = await vs.workspace.fs.stat(parent);
        if (!isDirectory(parentStat.type)) {
            await vs.window.showErrorMessage(tr(
                'The parent folder changed before creation. Nothing was written.',
                '创建前父文件夹已发生变化，未写入任何内容。',
            ));
            return;
        }
        const existing = await statOrUndefined(target);
        if (existing) {
            const revealLabel = tr('Show in Explorer', '在资源管理器中显示');
            const choice = await vs.window.showInformationMessage(
                tr('The target already exists; nothing was overwritten.', '目标已存在，未覆盖任何内容。'),
                revealLabel,
            );
            if (choice === revealLabel) await vs.commands.executeCommand('revealInExplorer', target);
            return;
        }
        await vs.workspace.fs.createDirectory(target);
        const created = await vs.workspace.fs.stat(target);
        if (!isDirectory(created.type)) throw new Error('The file system did not create a directory');
        await vs.commands.executeCommand('revealInExplorer', target);
        void vs.window.setStatusBarMessage(
            tr(`$(check) Created ${uriDirectoryName(target)}`, `$(check) 已创建 ${uriDirectoryName(target)}`),
            4_000,
        );
    }

    private cancelActive(): void {
        this.latestRequest.cancel();
        this.activeCancellation?.cancel();
        this.activeCancellation?.dispose();
        this.activeCancellation = undefined;
        this.activeQuickPick?.hide();
        this.activeQuickPick?.dispose();
        this.activeQuickPick = undefined;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelActive();
        this.vanillaCache.dispose();
        this.reportedVanillaFailures.clear();
    }
}
