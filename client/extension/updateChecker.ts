import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { ErrorReporter } from './ai/errorReporter';

export interface UpdateInstallContext {
    reinstallCurrentVersion: boolean;
    vsixPath: string;
}

export interface UpdateInstallHooks {
    beforeInstall?: (installContext: UpdateInstallContext) => void | Promise<void>;
}

export async function checkForUpdates(context: vscode.ExtensionContext, installHooks: UpdateInstallHooks = {}) {
    const config = vscode.workspace.getConfiguration('cwtools');
    const isEnabled = config.get<boolean>('checkForUpdates', true);
    if (!isEnabled) {
        return;
    }

    const stateKeyLastCheck = 'cwtools.updateCheck.lastCheck';
    const stateKeyIgnoreVersion = 'cwtools.updateCheck.ignoreVersion';

    const now = Date.now();

    try {
        const release = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: '正在检查 CWTools 更新...'
        }, async () => {
            return await fetchLatestRelease();
        });

        if (!release || !release.tag_name) {
            return;
        }

        // Update last check time
        await context.globalState.update(stateKeyLastCheck, now);

        const currentVersion = context.extension.packageJSON?.version;
        if (!currentVersion) {
            return;
        }

        const tagVersion = release.tag_name.replace(/^v/i, '');
        const selectedVsix = selectReleaseVsixAsset(release);
        const latestVersion = selectedVsix?.version || tagVersion;
        const latestAssetUpdate = selectedVsix?.updatedAt || release.published_at || '';
        const vsixDownloadUrl = selectedVsix?.downloadUrl || '';

        const stateKeyKnownAssetUpdate = `cwtools.updateCheck.knownAssetDate_${currentVersion}`;
        const knownAssetUpdate = context.globalState.get<string>(stateKeyKnownAssetUpdate);

        let needsUpdate = false;
        let promptMessage = `CWTools 发现新版本 (v${latestVersion})，是否立即安装并更新？`;

        if (isNewerVersion(currentVersion, latestVersion)) {
            const ignoredVersion = context.globalState.get<string>(stateKeyIgnoreVersion);
            if (ignoredVersion !== latestVersion) {
                needsUpdate = true;
            }
        } else if (compareVersions(currentVersion, latestVersion) === 0 && latestAssetUpdate) {
            if (!knownAssetUpdate) {
                await context.globalState.update(stateKeyKnownAssetUpdate, latestAssetUpdate);
            } else if (latestAssetUpdate > knownAssetUpdate) {
                needsUpdate = true;
                promptMessage = `CWTools 当前版本 (v${currentVersion}) 在 GitHub 上有文件替换更新，是否重新安装修复？`;
            }
        }

        if (needsUpdate) {
            const releaseUrl = release.html_url || 'https://github.com/Aa728848/cwtools-vscode/releases/latest';
            const reinstallCurrentVersion = compareVersions(currentVersion, latestVersion) === 0;
            
            void Promise.resolve(vscode.window.showInformationMessage(
                promptMessage,
                '立即更新',
                '忽略此更新'
            )).then(async selection => {
                if (selection === '立即更新') {
                    if (vsixDownloadUrl) {
                        const installed = await downloadAndInstallUpdate(
                            vsixDownloadUrl,
                            releaseUrl,
                            context.extension.id,
                            reinstallCurrentVersion,
                            installHooks
                        );
                        if (installed && reinstallCurrentVersion) {
                            await context.globalState.update(stateKeyKnownAssetUpdate, latestAssetUpdate);
                        }
                    } else {
                        void vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
                    }
                } else if (selection === '忽略此更新') {
                    if (reinstallCurrentVersion) {
                        await context.globalState.update(stateKeyKnownAssetUpdate, latestAssetUpdate);
                    } else {
                        await context.globalState.update(stateKeyIgnoreVersion, latestVersion);
                    }
                }
            }).catch((e: unknown) => ErrorReporter.warn('UpdateChecker', 'Failed to handle update selection', e));
        }
    } catch (e) {
        ErrorReporter.warn('UpdateChecker', 'Failed to check for updates', e);
    }
}

async function downloadAndInstallUpdate(
    originalUrl: string,
    fallbackUrl: string,
    extensionId: string,
    reinstallCurrentVersion: boolean,
    installHooks: UpdateInstallHooks = {}
): Promise<boolean> {
    const downloadUrls = [originalUrl];

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在下载 CWTools 更新...',
        cancellable: true
    }, async (progress, token) => {
        const tmpPath = path.join(os.tmpdir(), `cwtools-update-${Date.now()}.vsix`);

        for (const url of downloadUrls) {
            if (token.isCancellationRequested) {
                break;
            }
            try {
                const hostname = new URL(url).hostname;
                progress.report({ message: `通过 ${hostname} 创建连接...` });
                await downloadFile(url, tmpPath, progress, token);
                
                // Download successful
                progress.report({ message: '下载完成，正在安装...' });
                if (reinstallCurrentVersion && installHooks.beforeInstall) {
                    progress.report({ message: '正在停止语言服务以释放安装文件...' });
                }
                await installHooks.beforeInstall?.({ reinstallCurrentVersion, vsixPath: tmpPath });
                await installDownloadedUpdate(tmpPath, extensionId, reinstallCurrentVersion);
                
                void vscode.window.showInformationMessage('CWTools 已成功更新安装！', '重新加载窗口').then(sel => {
                    if (sel === '重新加载窗口') {
                        void vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
                return true; // Exit after successful installation
            } catch (err: any) {
                ErrorReporter.warn('UpdateChecker', `下载或安装失败 [${url}]`, err);
                if (fs.existsSync(tmpPath)) {
                    fs.unlinkSync(tmpPath);
                }
            }
        }
        
        if (!token.isCancellationRequested) {
            void vscode.window.showErrorMessage('CWTools 更新自动下载或安装失败，请前往网页下载并手动导入。', '前往下载').then(sel => {
                if (sel === '前往下载') {
                    void vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
                }
            });
        }
        return false;
    });
}

interface SelectedVsixAsset {
    name: string;
    version: string;
    downloadUrl: string;
    updatedAt: string;
}

export function extractVsixVersion(assetName: string | undefined): string | undefined {
    if (!assetName || !assetName.toLowerCase().endsWith('.vsix')) {
        return undefined;
    }

    const stem = assetName.replace(/\.vsix$/i, '');
    const matches = [...stem.matchAll(/(?:^|[-_])v?(\d+\.\d+\.\d+)(?=$|[-_])/gi)];
    return matches.length > 0 ? matches[matches.length - 1]?.[1] : undefined;
}

export function selectReleaseVsixAsset(release: any): SelectedVsixAsset | undefined {
    const fallbackVersion = String(release?.tag_name ?? '').replace(/^v/i, '');
    const releaseTimestamp = release?.published_at || release?.updated_at || '';
    let selected: SelectedVsixAsset | undefined;

    for (const asset of release?.assets ?? []) {
        const name = String(asset?.name ?? '');
        const downloadUrl = String(asset?.browser_download_url ?? '');
        if (!name.toLowerCase().endsWith('.vsix') || !downloadUrl) {
            continue;
        }

        const candidate: SelectedVsixAsset = {
            name,
            version: extractVsixVersion(name) || fallbackVersion,
            downloadUrl,
            updatedAt: asset?.updated_at || releaseTimestamp,
        };

        if (!selected) {
            selected = candidate;
            continue;
        }

        const versionComparison = compareVersions(selected.version, candidate.version);
        if (versionComparison < 0 || (versionComparison === 0 && candidate.updatedAt > selected.updatedAt)) {
            selected = candidate;
        }
    }

    return selected;
}

const CLI_INSTALL_TIMEOUT_MS = 180_000;
const CLI_MAX_BUFFER = 1024 * 1024;

function getVsCodeCliBaseName(): string {
    const scheme = vscode.env.uriScheme?.toLowerCase() ?? '';
    const appName = vscode.env.appName?.toLowerCase() ?? '';
    if (scheme.includes('vscodium-insiders') || (appName.includes('codium') && appName.includes('insider'))) {
        return 'codium-insiders';
    }
    if (scheme.includes('vscodium') || appName.includes('codium')) {
        return 'codium';
    }
    if (scheme.includes('insiders') || appName.includes('insiders')) {
        return 'code-insiders';
    }
    if (scheme.includes('code-oss') || appName.includes('code - oss')) {
        return 'code-oss';
    }
    return 'code';
}

function getVsCodeCliExecutableName(): string {
    const base = getVsCodeCliBaseName();
    return process.platform === 'win32' ? `${base}.cmd` : base;
}

function resolveVsCodeCliCommand(): string {
    const envCli = process.env.VSCODE_CLI?.trim();
    if (envCli) {
        return envCli;
    }

    const base = getVsCodeCliBaseName();
    const executable = getVsCodeCliExecutableName();
    const appDir = path.dirname(process.execPath);
    const candidates = process.platform === 'darwin'
        ? [path.resolve(appDir, '..', 'Resources', 'app', 'bin', base)]
        : process.platform === 'win32'
            ? [
                path.join(appDir, 'bin', executable),
                path.join(path.dirname(appDir), 'bin', executable)
            ]
            : [
                path.join(appDir, 'bin', base),
                path.resolve(appDir, '..', 'bin', base),
                path.join(appDir, 'resources', 'app', 'bin', base),
                path.resolve(appDir, '..', 'resources', 'app', 'bin', base)
            ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return executable;
}

function getCurrentExtensionsDirArgs(extensionId: string): string[] {
    const extensionPath = vscode.extensions.getExtension(extensionId)?.extensionPath;
    if (!extensionPath) {
        return [];
    }

    const folderName = path.basename(extensionPath).toLowerCase();
    const normalizedId = extensionId.toLowerCase();
    if (folderName !== normalizedId && !folderName.startsWith(`${normalizedId}-`)) {
        return [];
    }

    return ['--extensions-dir', path.dirname(extensionPath)];
}

function shouldUseWindowsCommandWrapper(command: string): boolean {
    return process.platform === 'win32' && (path.extname(command) === '' || /\.(cmd|bat)$/i.test(command));
}

function quoteCmdArg(value: string): string {
    if (value.includes('"')) {
        throw new Error(`VS Code CLI argument contains an unsupported quote: ${value}`);
    }
    return `"${value}"`;
}

function runVsCodeCli(args: string[], timeoutMs: number): Promise<void> {
    const cliCommand = resolveVsCodeCliCommand();
    const useCmdWrapper = shouldUseWindowsCommandWrapper(cliCommand);
    const command = useCmdWrapper ? (process.env.ComSpec || 'cmd.exe') : cliCommand;
    const commandArgs = useCmdWrapper
        ? ['/d', '/s', '/c', [cliCommand, ...args].map(quoteCmdArg).join(' ')]
        : args;

    return new Promise((resolve, reject) => {
        execFile(command, commandArgs, {
            encoding: 'utf8',
            maxBuffer: CLI_MAX_BUFFER,
            timeout: timeoutMs,
            windowsHide: true
        }, (error, stdout, stderr) => {
            if (error) {
                const detail = [error.message, stderr?.trim(), stdout?.trim()]
                    .filter(Boolean)
                    .join('\n');
                reject(new Error(detail));
                return;
            }
            resolve();
        });
    });
}

async function reinstallCurrentVersionWithCli(vsixPath: string, extensionId: string): Promise<void> {
    const extensionDirArgs = getCurrentExtensionsDirArgs(extensionId);
    await runVsCodeCli([...extensionDirArgs, '--install-extension', vsixPath, '--force'], CLI_INSTALL_TIMEOUT_MS);
}

/**
 * VS Code does not replace an installed extension when a VSIX has the same
 * version through the regular workbench command. Use the external VS Code CLI
 * with --force for that path; normal version upgrades continue through the
 * regular workbench install command.
 */
export async function installDownloadedUpdate(
    vsixPath: string,
    extensionId: string,
    reinstallCurrentVersion: boolean
): Promise<void> {
    if (reinstallCurrentVersion) {
        await reinstallCurrentVersionWithCli(vsixPath, extensionId);
        return;
    }
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
}

function downloadFile(url: string, dest: string, progress: vscode.Progress<{ message?: string, increment?: number }>, token: vscode.CancellationToken): Promise<void> {
    return new Promise((resolve, reject) => {
        let request: any;

        const download = (downloadUrl: string) => {
            const parsedUrl = new URL(downloadUrl);
            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                headers: {
                    'User-Agent': 'CWTools-VSCode-Update-Checker'
                }
            };
            
            request = https.get(options, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    if (response.headers.location) {
                        response.resume();
                        download(response.headers.location);
                        return;
                    }
                }
                
                if (response.statusCode !== 200) {
                    response.resume();
                    return reject(new Error(`StatusCode: ${response.statusCode}`));
                }

                const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                let lastIncrement = 0;

                const file = fs.createWriteStream(dest);
                file.on('error', (err) => {
                    file.close();
                    reject(err);
                });

                response.on('data', (chunk) => {
                    if (token.isCancellationRequested) {
                        request.destroy();
                        file.close();
                        reject(new Error('User Cancelled'));
                        return;
                    }
                    downloadedBytes += chunk.length;
                    if (totalBytes > 0) {
                        const currentPercent = (downloadedBytes / totalBytes) * 100;
                        const inc = currentPercent - lastIncrement;
                        lastIncrement = currentPercent;
                        progress.report({ 
                            message: `${(downloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(totalBytes / 1024 / 1024).toFixed(1)}MB`, 
                            increment: inc 
                        });
                    } else {
                        progress.report({ message: `已下载 ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB` });
                    }
                });

                response.pipe(file);
                file.on('finish', () => {
                    file.close((err) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            }).on('error', (err) => {
                reject(err);
            });
            
            // Timeout settings (10 seconds for connect/TTFB)
            request.setTimeout(10000, () => {
                request.destroy();
                reject(new Error('Timeout'));
            });
        };

        download(url);

        token.onCancellationRequested(() => {
            if (request) request.destroy();
            reject(new Error('User Cancelled'));
        });
    });
}

function fetchLatestRelease(): Promise<any> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/Aa728848/cwtools-vscode/releases/latest',
            headers: {
                'User-Agent': 'CWTools-VSCode-Update-Checker'
            },
            timeout: 5000 // 5 seconds timeout
        };

        const req = https.get(options, (res) => {
            // handle redirects if necessary
            if (res.statusCode === 301 || res.statusCode === 302) {
                if (res.headers.location) {
                    res.resume();
                    const redirectUrl = new URL(res.headers.location);
                    options.hostname = redirectUrl.hostname;
                    options.path = redirectUrl.pathname + redirectUrl.search;
                    
                    const redirectReq = https.get(options, (redirectRes) => {
                        let data = '';
                        redirectRes.on('data', chunk => data += chunk);
                        redirectRes.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
                    redirectReq.on('error', reject);
                    return;
                }
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Status Code: ${res.statusCode}`));
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request Timeout'));
        });
    });
}

function compareVersions(current: string, latest: string): number {
    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
    const c = parse(current);
    const l = parse(latest);

    for (let i = 0; i < Math.max(c.length, l.length); i++) {
        const cv = c[i] || 0;
        const lv = l[i] || 0;
        if (lv > cv) return -1;
        if (lv < cv) return 1;
    }
    return 0;
}

function isNewerVersion(current: string, latest: string): boolean {
    return compareVersions(current, latest) < 0;
}
