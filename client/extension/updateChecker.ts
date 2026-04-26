import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function checkForUpdates(context: vscode.ExtensionContext) {
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

        // 更新最后检查时间
        await context.globalState.update(stateKeyLastCheck, now);

        const currentVersion = context.extension.packageJSON?.version;
        if (!currentVersion) {
            return;
        }

        const latestVersion = release.tag_name.replace(/^v/, '');
        
        let latestAssetUpdate = release.published_at || '';
        let vsixDownloadUrl = '';
        if (release.assets && release.assets.length > 0) {
            for (const asset of release.assets) {
                if (asset.name?.endsWith('.vsix')) {
                    if (asset.updated_at && asset.updated_at > latestAssetUpdate) {
                        latestAssetUpdate = asset.updated_at;
                    }
                    if (!vsixDownloadUrl) {
                        vsixDownloadUrl = asset.browser_download_url;
                    }
                }
            }
        }

        const stateKeyKnownAssetUpdate = `cwtools.updateCheck.knownAssetDate_${currentVersion}`;
        const knownAssetUpdate = context.globalState.get<string>(stateKeyKnownAssetUpdate);

        let needsUpdate = false;
        let promptMessage = `CWTools 发现新版本 (v${latestVersion})，是否立即安装并更新？`;

        if (isNewerVersion(currentVersion, latestVersion)) {
            const ignoredVersion = context.globalState.get<string>(stateKeyIgnoreVersion);
            if (ignoredVersion !== latestVersion) {
                needsUpdate = true;
            }
        } else if (currentVersion === latestVersion && latestAssetUpdate) {
            if (!knownAssetUpdate) {
                await context.globalState.update(stateKeyKnownAssetUpdate, latestAssetUpdate);
            } else if (latestAssetUpdate > knownAssetUpdate) {
                needsUpdate = true;
                promptMessage = `CWTools 当前版本 (v${currentVersion}) 在 GitHub 上有文件替换更新，是否重新安装修复？`;
            }
        }

        if (needsUpdate) {
            const releaseUrl = release.html_url || 'https://github.com/Aa728848/cwtools-vscode/releases/latest';
            
            vscode.window.showInformationMessage(
                promptMessage,
                '立即更新',
                '忽略此更新'
            ).then(async selection => {
                if (selection === '立即更新') {
                    if (currentVersion === latestVersion) {
                        await context.globalState.update(stateKeyKnownAssetUpdate, latestAssetUpdate);
                    }
                    if (vsixDownloadUrl) {
                        void downloadAndInstallUpdate(vsixDownloadUrl, releaseUrl);
                    } else {
                        void vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
                    }
                } else if (selection === '忽略此更新') {
                    if (currentVersion === latestVersion) {
                        await context.globalState.update(stateKeyKnownAssetUpdate, latestAssetUpdate);
                    } else {
                        await context.globalState.update(stateKeyIgnoreVersion, latestVersion);
                    }
                }
            });
        }
    } catch (e) {
        console.error('Failed to check for updates', e);
    }
}

async function downloadAndInstallUpdate(originalUrl: string, fallbackUrl: string) {
    const mirrors = [
        originalUrl, // 首选直连
        `https://ghproxy.net/${originalUrl}`,
        `https://github.moeyy.xyz/${originalUrl}`
    ];

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在下载 CWTools 更新...',
        cancellable: true
    }, async (progress, token) => {
        const tmpPath = path.join(os.tmpdir(), `cwtools-update-${Date.now()}.vsix`);

        for (const url of mirrors) {
            if (token.isCancellationRequested) {
                break;
            }
            try {
                // Only log mirror name to avoid very long strings
                const hostname = new URL(url).hostname;
                progress.report({ message: `通过 ${hostname} 创建连接...` });
                await downloadFile(url, tmpPath, progress, token);
                
                // 下载成功
                progress.report({ message: '下载完成，正在安装...' });
                await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(tmpPath));
                
                vscode.window.showInformationMessage('CWTools 已成功更新安装！', '重新加载窗口').then(sel => {
                    if (sel === '重新加载窗口') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
                return; // 安装成功即退出
            } catch (err: any) {
                console.error(`下载失败 [${url}]:`, err);
                if (fs.existsSync(tmpPath)) {
                    fs.unlinkSync(tmpPath);
                }
            }
        }
        
        if (!token.isCancellationRequested) {
            vscode.window.showErrorMessage('CWTools 更新自动下载失败（网络超时），请前往网页下载并手动导入。', '前往下载').then(sel => {
                if (sel === '前往下载') {
                    vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
                }
            });
        }
    });
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
                        download(response.headers.location);
                        return;
                    }
                }
                
                if (response.statusCode !== 200) {
                    return reject(new Error(`StatusCode: ${response.statusCode}`));
                }

                const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
                let downloadedBytes = 0;
                let lastIncrement = 0;

                const file = fs.createWriteStream(dest);

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
                    file.close();
                    resolve();
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

function isNewerVersion(current: string, latest: string): boolean {
    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
    const c = parse(current);
    const l = parse(latest);

    for (let i = 0; i < Math.max(c.length, l.length); i++) {
        const cv = c[i] || 0;
        const lv = l[i] || 0;
        if (lv > cv) return true;
        if (lv < cv) return false;
    }
    return false;
}
