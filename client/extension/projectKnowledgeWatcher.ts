import * as path from 'path';
import * as vs from 'vscode';
import { initializeProjectWithHost, type HostServices } from 'cwtools-shared';
import { ErrorReporter } from './errorReporter';

const REFRESH_EXTENSIONS = new Set(['.txt', '.gfx', '.asset', '.gui', '.yml', '.cwt', '.mod', '.shader', '.fxh']);

/** Preserve fresh project knowledge without depending on the retired Agent runtime. */
export function registerProjectKnowledgeWatcher(context: vs.ExtensionContext, host: HostServices): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let rerun = false;
    const changedFiles = new Set<string>();
    const refresh = async (full = false): Promise<void> => {
        if (running) { rerun = true; return; }
        running = true;
        try {
            const files = [...changedFiles].sort();
            changedFiles.clear();
            const result = await initializeProjectWithHost(host, {
                mode: full ? 'full' : 'incremental',
                changedFiles: full ? [] : files,
            });
            if (!result.ok) ErrorReporter.debug('ProjectKnowledge', 'Background knowledge refresh unavailable', result.error?.message);
        } catch (error) {
            ErrorReporter.warn('ProjectKnowledge', 'Background knowledge refresh failed', error);
        } finally {
            running = false;
            if (rerun || changedFiles.size > 0) {
                rerun = false;
                schedule();
            }
        }
    };
    const schedule = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; void refresh(); }, 500);
    };
    const scheduleFile = (uri: vs.Uri): void => {
        if (uri.scheme !== 'file') return;
        const relative = path.relative(host.workspaceRoot, uri.fsPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return;
        if (relative.split(/[\\/]/).includes('.cwtools')) return;
        if (!REFRESH_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) return;
        if (changedFiles.size < 500) changedFiles.add(relative.replace(/\\/g, '/'));
        schedule();
    };
    const watcher = vs.workspace.createFileSystemWatcher('**/*.{txt,gfx,asset,gui,yml,cwt,mod,shader,fxh}');
    watcher.onDidChange(scheduleFile);
    watcher.onDidCreate(scheduleFile);
    watcher.onDidDelete(scheduleFile);
    const configWatcher = vs.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('stellarisLanguageServices.cache')
            || event.affectsConfiguration('stellarisLanguageServices.rules_version')
            || event.affectsConfiguration('stellarisLanguageServices.rules_folder')
            || event.affectsConfiguration('stellarisLanguageServices.rules_remote_url')) {
            changedFiles.clear();
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = undefined; void refresh(true); }, 500);
        }
    });
    context.subscriptions.push(watcher, configWatcher, new vs.Disposable(() => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        changedFiles.clear();
        rerun = false;
    }));
}

/** Retry after the language server reports that its model is ready. */
export function resumeStaleProjectKnowledgeRefreshes(host: HostServices): void {
    void initializeProjectWithHost(host, { mode: 'incremental' }).catch(error => {
        ErrorReporter.debug('ProjectKnowledge', 'Unable to resume project knowledge refresh', error);
    });
}
