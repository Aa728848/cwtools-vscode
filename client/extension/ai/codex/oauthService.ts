import * as crypto from 'crypto';
import * as http from 'http';
import type * as vscode from 'vscode';
import type {
    CodexAccountStatus,
    CodexRateLimitBucket,
    CodexRateLimitWindow,
} from '../types';
import { aiText } from '../messages';

export const CODEX_CHATGPT_MODELS = [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.2',
] as const;

export const CODEX_CHATGPT_API_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CHATGPT_OAUTH_ISSUER = 'https://auth.openai.com';
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const OAUTH_PORT = 1455;
const OAUTH_CALLBACK_PATH = '/auth/callback';
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_PORT}${OAUTH_CALLBACK_PATH}`;
const OAUTH_TIMEOUT_MS = 5 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const STATUS_CACHE_MS = 15_000;
const SECRET_KEY = 'cwtools.ai.codexChatgpt.oauth.v1';

interface StoredOAuthCredentials {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: number;
    accountId?: string;
}

interface OAuthTokenResponse {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
}

interface OpenAiAuthClaims {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    organizations?: Array<{ id?: string }>;
}

interface OAuthClaims {
    email?: string;
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    organizations?: Array<{ id?: string }>;
    'https://api.openai.com/auth'?: OpenAiAuthClaims;
}

interface UsageWindow {
    used_percent?: unknown;
    limit_window_seconds?: unknown;
    reset_at?: unknown;
}

interface UsageResponse {
    plan_type?: unknown;
    rate_limit?: {
        primary_window?: UsageWindow;
        secondary_window?: UsageWindow;
    };
    code_review_rate_limit?: {
        primary_window?: UsageWindow;
        secondary_window?: UsageWindow;
    };
}

export interface ChatGptOAuthLogin {
    authUrl: string;
    completion: Promise<void>;
    cancel(): void;
}

type FetchLike = typeof fetch;

function parseJwtClaims(token: string | undefined): OAuthClaims | undefined {
    if (!token) return undefined;
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    try {
        return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as OAuthClaims;
    } catch {
        return undefined;
    }
}

function extractAccountId(tokens: Pick<StoredOAuthCredentials, 'accessToken' | 'idToken'>): string | undefined {
    for (const token of [tokens.idToken, tokens.accessToken]) {
        const claims = parseJwtClaims(token);
        const accountId = claims?.chatgpt_account_id
            ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id
            ?? claims?.organizations?.[0]?.id
            ?? claims?.['https://api.openai.com/auth']?.organizations?.[0]?.id;
        if (accountId) return accountId;
    }
    return undefined;
}

function accountClaims(credentials: StoredOAuthCredentials): OAuthClaims {
    return parseJwtClaims(credentials.idToken)
        ?? parseJwtClaims(credentials.accessToken)
        ?? {};
}

function numeric(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function mapUsageWindow(window: UsageWindow | undefined): CodexRateLimitWindow | null {
    if (!window) return null;
    const usedPercent = numeric(window.used_percent);
    if (usedPercent === undefined) return null;
    const seconds = numeric(window.limit_window_seconds);
    const resetsAt = numeric(window.reset_at);
    return {
        usedPercent,
        windowDurationMins: seconds === undefined ? null : seconds / 60,
        resetsAt: resetsAt ?? null,
    };
}

export function mapCodexUsage(data: UsageResponse | undefined): CodexRateLimitBucket[] {
    if (!data) return [];
    const result: CodexRateLimitBucket[] = [];
    const addBucket = (limitId: string, limitName: string, source: UsageResponse['rate_limit']) => {
        if (!source) return;
        const primary = mapUsageWindow(source.primary_window);
        const secondary = mapUsageWindow(source.secondary_window);
        if (!primary && !secondary) return;
        result.push({
            limitId,
            limitName,
            planType: typeof data.plan_type === 'string' ? data.plan_type : null,
            primary,
            secondary,
        });
    };
    addBucket('codex', 'Codex', data.rate_limit);
    addBucket('code-review', 'Code review', data.code_review_rate_limit);
    return result;
}

function authUrl(verifier: string, state: string): string {
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: 'openid profile email offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        // This public OAuth client and backend compatibility contract are the
        // same ones used by OpenCode's built-in ChatGPT Plus/Pro integration.
        originator: 'opencode',
    });
    return `${CHATGPT_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

function successPage(): string {
    return '<!doctype html><meta charset="utf-8"><title>CWTools</title><h1>ChatGPT sign-in completed / ChatGPT 登录完成</h1><p>You can close this window. / 可以关闭此窗口。</p>';
}

function errorPage(): string {
    return '<!doctype html><meta charset="utf-8"><title>CWTools</title><h1>ChatGPT sign-in failed / ChatGPT 登录失败</h1><p>Return to VS Code for details. / 请返回 VS Code 查看详情。</p>';
}

/**
 * Owns ChatGPT OAuth credentials for the subscription provider.
 * Tokens are stored only in VS Code SecretStorage and never in settings files.
 */
export class ChatGptOAuthService implements vscode.Disposable {
    private cachedStatus?: { value: CodexAccountStatus; at: number };
    private refreshPromise?: Promise<StoredOAuthCredentials>;
    private activeLoginCancel?: (reason?: Error) => void;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly fetchFn: FetchLike = fetch,
        private readonly clientVersion = 'unknown',
    ) {}

    async getAccountStatus(force = false): Promise<CodexAccountStatus> {
        if (!force && this.cachedStatus && Date.now() - this.cachedStatus.at < STATUS_CACHE_MS) {
            return this.cachedStatus.value;
        }
        const stored = await this.readCredentials();
        if (!stored) {
            return {
                available: true,
                signedIn: false,
                authMode: 'oauth',
                accountType: null,
                models: [...CODEX_CHATGPT_MODELS],
                rateLimits: [],
            };
        }
        try {
            const credentials = await this.ensureCredentials(stored);
            const claims = accountClaims(credentials);
            const nested = claims['https://api.openai.com/auth'];
            const usage = await this.fetchUsage(credentials).catch(() => undefined);
            const planType = typeof usage?.plan_type === 'string'
                ? usage.plan_type
                : claims.chatgpt_plan_type ?? nested?.chatgpt_plan_type ?? null;
            const value: CodexAccountStatus = {
                available: true,
                signedIn: true,
                authMode: 'oauth',
                accountType: 'chatgpt',
                email: claims.email ?? null,
                planType,
                models: [...CODEX_CHATGPT_MODELS],
                rateLimits: mapCodexUsage(usage),
            };
            this.cachedStatus = { value, at: Date.now() };
            return value;
        } catch (error) {
            return {
                available: true,
                signedIn: false,
                authMode: 'oauth',
                accountType: null,
                models: [...CODEX_CHATGPT_MODELS],
                rateLimits: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async getRequestHeaders(forceRefresh = false): Promise<Record<string, string>> {
        const stored = await this.readCredentials();
        if (!stored) {
            throw new Error(aiText(
                'Sign in with ChatGPT before using the subscription provider.',
                '请先使用 ChatGPT 登录，再使用订阅 Provider。',
            ));
        }
        const credentials = forceRefresh
            ? await this.refreshCredentials(stored)
            : await this.ensureCredentials(stored);
        return {
            Authorization: `Bearer ${credentials.accessToken}`,
            ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
            originator: 'opencode',
            'User-Agent': `cwtools-vscode/${this.clientVersion}`,
        };
    }

    async startLogin(): Promise<ChatGptOAuthLogin> {
        this.activeLoginCancel?.(new Error(aiText('A newer ChatGPT sign-in was started.', '已开始新的 ChatGPT 登录。')));
        const verifier = crypto.randomBytes(48).toString('base64url');
        const state = crypto.randomBytes(32).toString('base64url');

        let resolveCompletion!: () => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<void>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });

        let settled = false;
        const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined };
        const server = http.createServer((request, response) => {
            void this.handleOAuthCallback(request, response, state, verifier).then(completed => {
                if (!completed) return;
                if (settled) return;
                settled = true;
                if (timer.current) clearTimeout(timer.current);
                server.close();
                this.activeLoginCancel = undefined;
                this.cachedStatus = undefined;
                resolveCompletion();
            }).catch(error => {
                if (settled) return;
                settled = true;
                if (timer.current) clearTimeout(timer.current);
                server.close();
                this.activeLoginCancel = undefined;
                rejectCompletion(error instanceof Error ? error : new Error(String(error)));
            });
        });

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            server.once('error', onError);
            server.listen(OAUTH_PORT, 'localhost', () => {
                server.off('error', onError);
                resolve();
            });
        }).catch(error => {
            server.close();
            throw new Error(aiText(
                `Could not start the ChatGPT OAuth callback on port ${OAUTH_PORT}: ${error instanceof Error ? error.message : String(error)}`,
                `无法在端口 ${OAUTH_PORT} 启动 ChatGPT OAuth 回调：${error instanceof Error ? error.message : String(error)}`,
            ));
        });

        const cancel = (reason = new Error(aiText('ChatGPT sign-in was cancelled.', 'ChatGPT 登录已取消。'))) => {
            if (settled) return;
            settled = true;
            if (timer.current) clearTimeout(timer.current);
            server.close();
            this.activeLoginCancel = undefined;
            rejectCompletion(reason);
        };
        this.activeLoginCancel = cancel;
        timer.current = setTimeout(() => cancel(new Error(aiText(
            'Timed out waiting for ChatGPT sign-in.',
            '等待 ChatGPT 登录超时。',
        ))), OAUTH_TIMEOUT_MS);

        return { authUrl: authUrl(verifier, state), completion, cancel: () => cancel() };
    }

    async logout(): Promise<void> {
        this.activeLoginCancel?.();
        await this.secrets.delete(SECRET_KEY);
        this.cachedStatus = undefined;
    }

    dispose(): void {
        this.activeLoginCancel?.();
        this.activeLoginCancel = undefined;
    }

    private async handleOAuthCallback(
        request: http.IncomingMessage,
        response: http.ServerResponse,
        expectedState: string,
        verifier: string,
    ): Promise<boolean> {
        const url = new URL(request.url ?? '/', `http://localhost:${OAUTH_PORT}`);
        if (url.pathname !== OAUTH_CALLBACK_PATH) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return false;
        }
        const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (error || !code || state !== expectedState) {
            response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(errorPage());
            throw new Error(error || aiText(
                'ChatGPT returned an invalid OAuth callback.',
                'ChatGPT 返回了无效的 OAuth 回调。',
            ));
        }
        try {
            const tokens = await this.exchangeCode(code, verifier);
            await this.storeTokenResponse(tokens);
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(successPage());
            return true;
        } catch (exchangeError) {
            response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(errorPage());
            throw exchangeError;
        }
    }

    private async exchangeCode(code: string, verifier: string): Promise<OAuthTokenResponse> {
        const response = await this.fetchFn(`${CHATGPT_OAUTH_ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: OAUTH_REDIRECT_URI,
                client_id: CHATGPT_OAUTH_CLIENT_ID,
                code_verifier: verifier,
            }).toString(),
        });
        if (!response.ok) {
            throw new Error(aiText(
                `ChatGPT token exchange failed (${response.status}).`,
                `ChatGPT Token 交换失败（${response.status}）。`,
            ));
        }
        return response.json() as Promise<OAuthTokenResponse>;
    }

    private async readCredentials(): Promise<StoredOAuthCredentials | undefined> {
        const raw = await this.secrets.get(SECRET_KEY);
        if (!raw) return undefined;
        try {
            const parsed = JSON.parse(raw) as Partial<StoredOAuthCredentials>;
            if (!parsed.accessToken || !parsed.refreshToken || !Number.isFinite(parsed.expiresAt)) return undefined;
            return parsed as StoredOAuthCredentials;
        } catch {
            return undefined;
        }
    }

    private async storeCredentials(credentials: StoredOAuthCredentials): Promise<void> {
        await this.secrets.store(SECRET_KEY, JSON.stringify(credentials));
        this.cachedStatus = undefined;
    }

    private async storeTokenResponse(
        tokens: OAuthTokenResponse,
        previous?: StoredOAuthCredentials,
    ): Promise<StoredOAuthCredentials> {
        if (!tokens.access_token || (!tokens.refresh_token && !previous?.refreshToken)) {
            throw new Error(aiText(
                'ChatGPT did not return complete OAuth credentials.',
                'ChatGPT 未返回完整的 OAuth 凭据。',
            ));
        }
        const credentials: StoredOAuthCredentials = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? previous!.refreshToken,
            idToken: tokens.id_token ?? previous?.idToken,
            expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            accountId: previous?.accountId,
        };
        credentials.accountId = extractAccountId(credentials) ?? credentials.accountId;
        await this.storeCredentials(credentials);
        return credentials;
    }

    private ensureCredentials(credentials: StoredOAuthCredentials): Promise<StoredOAuthCredentials> {
        return credentials.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS
            ? Promise.resolve(credentials)
            : this.refreshCredentials(credentials);
    }

    private refreshCredentials(credentials: StoredOAuthCredentials): Promise<StoredOAuthCredentials> {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this.fetchFn(`${CHATGPT_OAUTH_ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: credentials.refreshToken,
                client_id: CHATGPT_OAUTH_CLIENT_ID,
            }).toString(),
        }).then(async response => {
            if (!response.ok) {
                if (response.status === 400 || response.status === 401) {
                    await this.secrets.delete(SECRET_KEY);
                }
                throw new Error(aiText(
                    `ChatGPT OAuth refresh failed (${response.status}). Sign in again.`,
                    `ChatGPT OAuth 刷新失败（${response.status}）。请重新登录。`,
                ));
            }
            return this.storeTokenResponse(await response.json() as OAuthTokenResponse, credentials);
        }).finally(() => {
            this.refreshPromise = undefined;
        });
        return this.refreshPromise;
    }

    private async fetchUsage(credentials: StoredOAuthCredentials): Promise<UsageResponse> {
        const response = await this.fetchFn(CODEX_CHATGPT_USAGE_URL, {
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
                originator: 'opencode',
                'User-Agent': `cwtools-vscode/${this.clientVersion}`,
            },
        });
        if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
        return response.json() as Promise<UsageResponse>;
    }
}
