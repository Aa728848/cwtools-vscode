import * as crypto from 'crypto';
import * as http from 'http';
import type * as vscode from 'vscode';
import { isRecord } from '../../../shared/protocolValidation';
import type { AntigravityAccountStatus, AntigravityQuotaBucket } from '../types';
import { aiText } from '../messages';
import { ANTIGRAVITY_MODELS, antigravityDisplayModel } from './models';
import { AntigravityApiError, extractAntigravityProject, postAntigravity } from './api';

export const ANTIGRAVITY_SECRET_KEY = 'cwtools.ai.antigravity.oauth.v1';
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Public installed-application OAuth identity used by the reference adapter.
const CLIENT_ID = Buffer.from('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==', 'base64').toString('utf8');
const CLIENT_SECRET = Buffer.from('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=', 'base64').toString('utf8');
const SCOPES = ['aicode', 'cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs']
    .map(scope => `https://www.googleapis.com/auth/${scope}`);
const METADATA = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };

interface Credentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email?: string;
}

export interface AntigravityLogin {
    authUrl: string;
    completion: Promise<void>;
    cancel(): void;
}

function nonempty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** A cancelled caller stops waiting without cancelling another caller's token refresh. */
async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
        })]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

export function parseAntigravityModels(data: unknown): string[] {
    if (!isRecord(data) || !isRecord(data.models)) return [];
    const models = Object.entries(data.models)
        .filter(([, model]) => isRecord(model) && !model.isInternal)
        .map(([id]) => id.trim())
        .filter(id => id && !id.startsWith('chat_') && !id.startsWith('tab_'))
        .map(antigravityDisplayModel);
    return [...new Set(models)].sort().slice(0, 500);
}

export function parseAntigravityQuota(data: unknown): AntigravityQuotaBucket[] {
    if (!isRecord(data) || !Array.isArray(data.groups)) return [];
    const buckets: AntigravityQuotaBucket[] = [];
    for (const group of data.groups.slice(0, 50)) {
        if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
        for (const bucket of group.buckets.slice(0, 50)) {
            if (!isRecord(bucket) || typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction)) continue;
            buckets.push({
                name: [group.displayName, bucket.displayName ?? bucket.bucketId].filter(nonempty).join(' · ') || 'Antigravity',
                remainingPercent: Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 100),
                ...(typeof bucket.resetTime === 'string' && Number.isFinite(Date.parse(bucket.resetTime))
                    ? { resetsAt: bucket.resetTime } : {}),
            });
        }
    }
    return buckets;
}

export class AntigravityOAuthService implements vscode.Disposable {
    private epoch = 0;
    private session = new AbortController();
    private refreshPromise?: Promise<Credentials>;
    private projectPromise?: Promise<string>;
    private cachedStatus?: { value: AntigravityAccountStatus; at: number };
    private activeLogin?: AntigravityLogin;
    private secretWrites: Promise<void> = Promise.resolve();

    constructor(
        private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>,
        private readonly fetchFn: typeof fetch = fetch,
        private readonly callbackPort = 51121,
    ) {}

    private mutateSecret(action: () => PromiseLike<void>): Promise<void> {
        const task = this.secretWrites.then(action);
        this.secretWrites = task.catch(() => undefined); // The caller owns error reporting; keep the queue usable.
        return task;
    }

    private async readCredentials(): Promise<Credentials | undefined> {
        const raw = await this.secrets.get(ANTIGRAVITY_SECRET_KEY);
        if (!raw) return undefined;
        let value: unknown;
        try { value = JSON.parse(raw); } catch { return undefined; }
        if (!isRecord(value) || !nonempty(value.accessToken) || !nonempty(value.refreshToken)
            || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return undefined;
        return {
            accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt,
            ...(nonempty(value.email) ? { email: value.email } : {}),
        };
    }

    private async exchange(params: Record<string, string>, epoch: number, previous?: Credentials, operationSignal = this.session.signal): Promise<Credentials> {
        const signal = AbortSignal.any([this.session.signal, operationSignal, AbortSignal.timeout(30_000)]);
        const response = await this.fetchFn(ANTIGRAVITY_TOKEN_URL, {
            method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }).toString(),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(aiText(`Antigravity OAuth failed (${response.status}). Sign in again.`, `Antigravity OAuth 失败（${response.status}）。请重新登录。`));
        }
        const data: unknown = await response.json();
        const refreshToken = isRecord(data) && nonempty(data.refresh_token) ? data.refresh_token : previous?.refreshToken;
        if (!isRecord(data) || !nonempty(data.access_token) || !refreshToken
            || (data.expires_in !== undefined && (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0))) {
            throw new Error(aiText('Antigravity returned invalid OAuth credentials.', 'Antigravity 返回了无效的 OAuth 凭据。'));
        }
        const credentials: Credentials = {
            accessToken: data.access_token, refreshToken,
            expiresAt: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000,
            email: previous?.email,
        };
        await this.mutateSecret(async () => {
            signal.throwIfAborted();
            if (epoch !== this.epoch) throw new Error(aiText('Antigravity session changed.', 'Antigravity 会话已更改。'));
            await this.secrets.store(ANTIGRAVITY_SECRET_KEY, JSON.stringify(credentials));
        });
        signal.throwIfAborted();
        this.cachedStatus = undefined;
        return credentials;
    }

    private async credentials(force = false): Promise<Credentials> {
        const epoch = this.epoch;
        const stored = await this.readCredentials();
        if (epoch !== this.epoch) throw new Error(aiText('Antigravity session changed.', 'Antigravity 会话已更改。'));
        if (!stored) throw new Error(aiText('Sign in to Antigravity in AI Settings first.', '请先在 AI 设置中登录 Antigravity。'));
        if (!force && stored.expiresAt > Date.now() + 60_000) return stored;
        if (!this.refreshPromise) {
            const task = this.exchange({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }, epoch, stored)
                .finally(() => { if (this.refreshPromise === task) this.refreshPromise = undefined; });
            this.refreshPromise = task;
        }
        return this.refreshPromise;
    }

    async getRequestContext(signal: AbortSignal, forceRefresh = false): Promise<{ token: string; projectId: string }> {
        signal.throwIfAborted();
        this.session.signal.throwIfAborted();
        const epoch = this.epoch;
        const credentials = await waitWithSignal(this.credentials(forceRefresh), signal);
        signal.throwIfAborted();
        if (epoch !== this.epoch) throw new Error(aiText('Antigravity session changed.', 'Antigravity 会话已更改。'));
        if (!this.projectPromise) {
            const discoverySignal = AbortSignal.any([this.session.signal, AbortSignal.timeout(20_000)]);
            const task = (async () => {
                const response = await postAntigravity(this.fetchFn, credentials.accessToken, 'loadCodeAssist', { metadata: METADATA }, discoverySignal);
                let project = extractAntigravityProject(await response.json());
                if (!project) {
                    const listed = await postAntigravity(this.fetchFn, credentials.accessToken, 'listCloudAICompanionProjects', {}, discoverySignal);
                    project = extractAntigravityProject(await listed.json());
                }
                if (!project) throw new Error(aiText('No Antigravity project found. Complete account setup in Antigravity and refresh status.', '未找到 Antigravity 项目。请先在 Antigravity 中完成账户设置，再刷新状态。'));
                return project;
            })().catch(error => {
                if (this.projectPromise === task) this.projectPromise = undefined;
                throw error;
            });
            this.projectPromise = task;
        }
        const projectId = await waitWithSignal(this.projectPromise, signal);
        if (epoch !== this.epoch) throw new Error(aiText('Antigravity session changed.', 'Antigravity 会话已更改。'));
        return { token: credentials.accessToken, projectId };
    }

    async getAccountStatus(force = false): Promise<AntigravityAccountStatus> {
        if (!force && this.cachedStatus && Date.now() - this.cachedStatus.at < 30_000) return this.cachedStatus.value;
        if (force) this.projectPromise = undefined;
        const stored = await this.readCredentials();
        const value: AntigravityAccountStatus = {
            signedIn: false, hasCredentials: !!stored, models: [...ANTIGRAVITY_MODELS], quota: [],
        };
        if (!stored) return value;
        const epoch = this.epoch;
        try {
            const signal = AbortSignal.any([this.session.signal, AbortSignal.timeout(30_000)]);
            const context = await this.getRequestContext(signal);
            value.signedIn = true;
            value.projectId = context.projectId;
            value.email = stored.email;
            const results = await Promise.allSettled([
                postAntigravity(this.fetchFn, context.token, 'fetchAvailableModels', { project: context.projectId }, signal).then(r => r.json()),
                postAntigravity(this.fetchFn, context.token, 'retrieveUserQuotaSummary', {}, signal).then(r => r.json()),
                this.fetchFn('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
                    headers: { Authorization: `Bearer ${context.token}` }, redirect: 'error', signal,
                }).then(async r => {
                    if (!r.ok) { await r.body?.cancel(); throw new AntigravityApiError(r.status, 'userinfo'); }
                    return r.json() as Promise<unknown>;
                }),
            ]);
            const [models, quota, identity] = results;
            if (models?.status === 'fulfilled' && isRecord(models.value) && isRecord(models.value.models)) {
                value.models = parseAntigravityModels(models.value);
            }
            if (quota?.status === 'fulfilled') value.quota = parseAntigravityQuota(quota.value);
            if (identity?.status === 'fulfilled' && isRecord(identity.value) && nonempty(identity.value.email)) value.email = identity.value.email;
            if (results.some(result => result.status === 'rejected')) {
                value.error = aiText('Some Antigravity account details could not be refreshed. Try refreshing status.', '部分 Antigravity 账户信息刷新失败，请重试刷新状态。');
            }
        } catch (error) {
            value.error = error instanceof Error ? error.message : aiText('Antigravity account request failed.', 'Antigravity 账户请求失败。');
        }
        if (epoch !== this.epoch) return this.getAccountStatus();
        this.cachedStatus = { value, at: Date.now() };
        return value;
    }

    async startLogin(): Promise<AntigravityLogin> {
        this.dispose();
        this.session = new AbortController();
        const epoch = this.epoch;
        const verifier = crypto.randomBytes(32).toString('base64url');
        const loginController = new AbortController();
        const state = crypto.randomBytes(32).toString('base64url');
        let complete: (error?: Error) => void = () => {};
        let redirectUri = '';
        let handling = false;
        let settled = false;
        const server = http.createServer((request, response) => {
            const url = new URL(request.url ?? '/', redirectUri);
            if (request.method !== 'GET' || url.pathname !== '/oauth-callback') {
                response.writeHead(404).end(); return;
            }
            if (url.searchParams.get('state') !== state || handling || settled) {
                response.writeHead(400).end('Invalid OAuth state.'); return;
            }
            const code = url.searchParams.get('code');
            if (url.searchParams.has('error') || !code) {
                response.writeHead(400).end('Sign-in failed / 登录失败');
                complete(new Error(aiText('Antigravity sign-in was denied or returned no code.', 'Antigravity 登录被拒绝或未返回授权码。')));
                return;
            }
            handling = true;
            void this.exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, epoch, undefined, loginController.signal).then(() => {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                response.end('<!doctype html><meta charset="utf-8"><h1>Antigravity sign-in completed / Antigravity 登录完成</h1><p>Return to VS Code / 请返回 VS Code。</p>');
                this.projectPromise = undefined;
                complete();
            }, error => {
                response.writeHead(400).end('Sign-in failed. Return to VS Code / 登录失败，请返回 VS Code。');
                complete(error instanceof Error ? error : new Error('Antigravity OAuth failed.'));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.callbackPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
        });
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); throw new Error('Antigravity callback listener unavailable.'); }
        redirectUri = `http://localhost:${address.port}/oauth-callback`;
        const completion = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => complete(new Error(aiText('Antigravity sign-in timed out.', 'Antigravity 登录超时。'))), 5 * 60_000);
            complete = error => {
                if (settled) return;
                settled = true;
                if (error) loginController.abort(error);
                clearTimeout(timer);
                server.close();
                if (this.activeLogin === login) this.activeLogin = undefined;
                if (error) reject(error); else resolve();
            };
        });
        const login: AntigravityLogin = {
            authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
                client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirectUri,
                scope: SCOPES.join(' '), code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
                code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
            })}`,
            completion,
            cancel: () => complete(new Error(aiText('Antigravity sign-in cancelled.', 'Antigravity 登录已取消。'))),
        };
        this.activeLogin = login;
        server.on('error', error => complete(error));
        if (epoch !== this.epoch) login.cancel();
        return login;
    }

    async logout(): Promise<void> {
        this.dispose();
        const epoch = this.epoch;
        await this.mutateSecret(() => this.secrets.delete(ANTIGRAVITY_SECRET_KEY));
        if (epoch === this.epoch) {
            this.session = new AbortController();
            this.cachedStatus = undefined;
        }
    }

    dispose(): void {
        this.epoch++;
        this.activeLogin?.cancel();
        this.session.abort();
        this.cachedStatus = undefined;
        this.projectPromise = undefined;
        this.refreshPromise = undefined;
    }
}
