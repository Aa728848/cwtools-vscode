import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { initializeProjectWithHost, type HostServices } from 'cwtools-shared';
import { ErrorReporter } from './errorReporter';
import { ProjectKnowledgeRefreshScheduler } from './projectKnowledgeRefreshScheduler';

const REFRESH_EXTENSIONS = new Set(['.txt', '.gfx', '.asset', '.gui', '.yml', '.cwt', '.mod', '.shader', '.fxh']);
const MAX_PENDING_FINGERPRINTS = 32;
const MAX_TRACKED_EVENT_VERSIONS = 1000;

/** Preserve fresh project knowledge without depending on the retired Agent runtime. */
export function registerProjectKnowledgeWatcher(context: vs.ExtensionContext, host: HostServices): void {
    let disposed = false;
    let pendingFingerprints = 0;
    let fingerprintQueue = Promise.resolve();
    const eventVersions = new Map<string, number>();
    const scheduler = new ProjectKnowledgeRefreshScheduler(async (full, files) => {
        try {
            const result = await initializeProjectWithHost(host, {
                mode: full ? 'full' : 'incremental',
                changedFiles: full ? [] : files,
            });
            if (!result.ok) ErrorReporter.debug('ProjectKnowledge', 'Background knowledge refresh unavailable', result.error?.message);
            return result.ok;
        } catch (error) {
            ErrorReporter.warn('ProjectKnowledge', 'Background knowledge refresh failed', error);
            return false;
        }
    });
    const scheduleFile = (uri: vs.Uri, deleted = false): void => {
        if (disposed || uri.scheme !== 'file') return;
        const relative = path.relative(host.workspaceRoot, uri.fsPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return;
        if (relative.split(/[\\/]/).includes('.cwtools')) return;
        if (!REFRESH_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) return;
        const file = relative.replace(/\\/g, '/');
        const version = (eventVersions.get(file) ?? 0) + 1;
        eventVersions.delete(file);
        eventVersions.set(file, version);
        if (eventVersions.size > MAX_TRACKED_EVENT_VERSIONS) {
            const oldest = eventVersions.keys().next().value as string | undefined;
            if (oldest !== undefined) eventVersions.delete(oldest);
        }
        if (deleted || pendingFingerprints >= MAX_PENDING_FINGERPRINTS) {
            scheduler.scheduleFile(file, null);
            return;
        }
        pendingFingerprints++;
        fingerprintQueue = fingerprintQueue.then(async () => {
            try {
                const content = await fs.promises.readFile(uri.fsPath);
                const fingerprint = crypto.createHash('sha256').update(content).digest('hex');
                if (!disposed && eventVersions.get(file) === version) scheduler.scheduleFile(file, fingerprint);
            } catch (error) {
                if (!disposed && eventVersions.get(file) === version) {
                    scheduler.scheduleFile(file, null);
                    ErrorReporter.debug('ProjectKnowledge', 'Unable to fingerprint changed file; scheduling refresh', error);
                }
            } finally {
                pendingFingerprints--;
            }
        });
    };
    const watcher = vs.workspace.createFileSystemWatcher('**/*.{txt,gfx,asset,gui,yml,cwt,mod,shader,fxh}');
    watcher.onDidChange(uri => scheduleFile(uri));
    watcher.onDidCreate(uri => scheduleFile(uri));
    watcher.onDidDelete(uri => scheduleFile(uri, true));
    const configWatcher = vs.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('stellarisLanguageServices.cache')
            || event.affectsConfiguration('stellarisLanguageServices.rules_version')
            || event.affectsConfiguration('stellarisLanguageServices.rules_folder')
            || event.affectsConfiguration('stellarisLanguageServices.rules_remote_url')) {
            scheduler.scheduleFull();
        }
    });
    context.subscriptions.push(watcher, configWatcher, new vs.Disposable(() => {
        disposed = true;
        scheduler.dispose();
        eventVersions.clear();
    }));
}

/** Retry after the language server reports that its model is ready. */
export function resumeStaleProjectKnowledgeRefreshes(host: HostServices): void {
    void initializeProjectWithHost(host, { mode: 'incremental' }).catch(error => {
        ErrorReporter.debug('ProjectKnowledge', 'Unable to resume project knowledge refresh', error);
    });
}
