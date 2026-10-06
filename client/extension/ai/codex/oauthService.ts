import * as crypto from 'crypto';
import * as http from 'http';
import type * as vscode from 'vscode';
import type {
    CodexAccountStatus,
    CodexRateLimitBucket,
    CodexRateLimitWindow,
} from '../types';
import { aiText } from '../messages';
import {
    CODEX_OPENAI_BETA,
    type CodexCatalogEntry,
    type CodexCatalogSnapshotStore,
    loadCodexCatalog,
} from './modelCatalog';

/**
 * Models selectable in the Codex (ChatGPT subscription) channel. GPT-6.1 Sol is
 * the current workhorse; GPT-6 Sol/Luna stay as the previous generation, and
 * GPT-5.6/GPT-5.5 until their announced retirements take effect.
 */
export const CODEX_CHATGPT_MODELS = [
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
] as const;

/**
 * Context window the ChatGPT Codex service serves for the GPT-5.6 family.
 *
 * The listing publishes `context_window: 272000` per slug; this is the value a
 * shipped-table answer falls back to, and the ceiling
 * `clampConfiguredContextTokens` enforces for these models.
 */
export const CODEX_CHATGPT_CONTEXT_TOKENS = 272_000;

/**
 * Effective context window for the GPT-6 family.
 *
 * The Codex listing states 272K for these slugs and 872K as their ceiling. The
 * official client's own model manager reads the larger figure, so the shipped
 * default here is the window the service actually serves rather than the
 * conservative floor the listing prints. This number only feeds local
 * compaction and overflow decisions — it never reaches the wire, because the
 * subscription Responses endpoint rejects `max_output_tokens`.
 */
export const CODEX_CHATGPT_EFFECTIVE_CONTEXT_TOKENS = 384_000;

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

/**
 * The subscription backend is served under a beta flag, not as stable API.
 * Without `openai-beta` the endpoint is a different surface; the official Codex
 * CLI has always sent it, so omitting it is the line that turns into a 400/403
 * once the backend tightens.
 */
export function codexSubscriptionHeaders(
    credentials: Pick<StoredOAuthCredentials, 'accessToken' | 'accountId'>,
    userAgent: string,
): Record<string, string> {
    return {
        Authorization: `Bearer ${credentials.accessToken}`,
        ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
        'openai-beta': CODEX_OPENAI_BETA,
        originator: 'opencode',
        'User-Agent': userAgent,
    };
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
    /** In-flight rotations, keyed by the refresh token they belong to. */
    private readonly refreshPromises = new Map<string, Promise<StoredOAuthCredentials>>();
    private activeLoginCancel?: (reason?: Error) => void;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly fetchFn: FetchLike = fetch,
        private readonly clientVersion = 'unknown',
        private readonly catalogSnapshot?: CodexCatalogSnapshotStore,
        /**
         * Called after a browser sign-in stored a credential.
         *
         * The account pool needs to learn about a new sign-in here: the pool keeps
         * its own document, so writing only the legacy slot leaves a second account
         * stored but unschedulable — it would never join rotation.
         */
        private readonly onSignedIn?: (credentials: StoredOAuthCredentials) => Promise<void>,
    ) {}

    /** User agent every subscription request carries; kept in one place so the wire identity cannot drift. */
    get userAgent(): string {
        return `cwtools-vscode/${this.clientVersion}`;
    }

    /**
     * Read the live subscription model catalog for the signed-in account.
     *
     * The shipped table stays the floor: it answers before the first sign-in and
     * when a listing call fails. Only a live listing is persisted.
     */
    async getModelCatalog(force = false): Promise<readonly CodexCatalogEntry[]> {
        const stored = await this.readCredentials();
        if (!stored) return [];
        try {
            const credentials = await this.ensureCredentials(stored);
            return await loadCodexCatalog({
                fetchFn: this.fetchFn,
                headers: codexSubscriptionHeaders(credentials, this.userAgent),
                accountKey: credentials.accountId ?? 'default',
                force,
                ...(this.catalogSnapshot ? { snapshot: this.catalogSnapshot } : {}),
            });
        } catch {
            return [];
        }
    }

    /**
     * Credential accessors for the account pool.
     *
     * The pool owns account selection and rotation bookkeeping, so it needs to
     * read, refresh and write the stored credential directly rather than going
     * through the single-account request path.
     */
    async readStoredCredentials(): Promise<StoredOAuthCredentials | undefined> {
        return this.readCredentials();
    }

    async saveStoredCredentials(credentials: StoredOAuthCredentials): Promise<void> {
        await this.storeCredentials(credentials);
    }

    async clearStoredCredentials(): Promise<void> {
        await this.secrets.delete(SECRET_KEY);
        this.cachedStatus = undefined;
    }

    /**
     * Rotate one credential for the account pool.
     *
     * Persistence is left to the pool: it writes the rotation into its own
     * document and mirrors only the primary account into the legacy slot.
     */
    async refreshStoredCredentials(credentials: StoredOAuthCredentials): Promise<StoredOAuthCredentials> {
        return this.refreshCredentials(credentials, false);
    }

    /**
     * Access token + account id for the account-scoped turn-state tracker.
     *
     * The tracker keys its entries by an opaque digest of these two values, so a
     * rotation or a sign-in change invalidates state minted by the previous
     * signer without ever putting that fact on the wire.
     */
    async getTurnStateCredentials(forceRefresh = false): Promise<{ accessToken: string; accountId?: string }> {
        const stored = await this.readCredentials();
        if (!stored) return { accessToken: '' };
        const credentials = forceRefresh
            ? await this.refreshCredentials(stored)
            : await this.ensureCredentials(stored);
        return {
            accessToken: credentials.accessToken,
            ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
        };
    }

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
            const [usage, catalog] = await Promise.all([
                this.fetchUsage(credentials).catch(() => undefined),
                this.getModelCatalog(force).catch(() => [] as readonly CodexCatalogEntry[]),
            ]);
            const planType = typeof usage?.plan_type === 'string'
                ? usage.plan_type
                : claims.chatgpt_plan_type ?? nested?.chatgpt_plan_type ?? null;
            // The listing is the authority on what this account may call; the
            // shipped table only stands in when it named nothing usable.
            const live = catalog.length > 0;
            const value: CodexAccountStatus = {
                available: true,
                signedIn: true,
                authMode: 'oauth',
                accountType: 'chatgpt',
                email: claims.email ?? null,
                planType,
                models: live ? catalog.map(entry => entry.id) : [...CODEX_CHATGPT_MODELS],
                ...(live ? {
                    modelContextWindows: Object.fromEntries(
                        catalog
                            .filter(entry => entry.contextWindow !== null && entry.contextWindow! > 0)
                            .map(entry => [entry.id, entry.contextWindow!]),
                    ),
                    catalogLive: true,
                } : {}),
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
        return codexSubscriptionHeaders(credentials, this.userAgent);
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
            const credentials = await this.storeTokenResponse(tokens);
            // Joining the pool is what makes a second sign-in a second account
            // rather than a replacement; the dedupe key keeps a repeat sign-in on
            // the same row. A failure here must not fail the sign-in itself.
            await this.onSignedIn?.(credentials).catch(() => undefined);
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

    /**
     * Turn a token response into a credential.
     *
     * Split out from persistence because the pool owns writing its own accounts:
     * it needs the rotated credential without it also landing in the single
     * legacy slot, where it would overwrite whichever account lives there.
     */
    private buildCredentials(
        tokens: OAuthTokenResponse,
        previous?: StoredOAuthCredentials,
    ): StoredOAuthCredentials {
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
        return credentials;
    }

    private async storeTokenResponse(
        tokens: OAuthTokenResponse,
        previous?: StoredOAuthCredentials,
    ): Promise<StoredOAuthCredentials> {
        const credentials = this.buildCredentials(tokens, previous);
        await this.storeCredentials(credentials);
        return credentials;
    }

    private ensureCredentials(credentials: StoredOAuthCredentials): Promise<StoredOAuthCredentials> {
        return credentials.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS
            ? Promise.resolve(credentials)
            : this.refreshCredentials(credentials);
    }

    /**
     * Rotate one credential, single-flighted **per credential**.
     *
     * Keying the in-flight promise by refresh token matters once a pool holds
     * several accounts: a global slot would hand account B the promise belonging
     * to account A and return A's rotated credential for B's request.
     *
     * @param persist - false when the account pool owns persistence; the pool
     *   writes the rotation back into its own document, and writing it to the
     *   single legacy slot as well would overwrite another account's credential.
     */
    private refreshCredentials(credentials: StoredOAuthCredentials, persist = true): Promise<StoredOAuthCredentials> {
        const key = credentials.refreshToken;
        const inFlight = this.refreshPromises.get(key);
        if (inFlight !== undefined) return inFlight;
        const task = this.fetchFn(`${CHATGPT_OAUTH_ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: credentials.refreshToken,
                client_id: CHATGPT_OAUTH_CLIENT_ID,
            }).toString(),
        }).then(async response => {
            if (!response.ok) {
                if ((response.status === 400 || response.status === 401) && persist) {
                    // Only clear the slot this credential actually occupies; a
                    // pooled account's rejection is the pool's to record.
                    const stored = await this.readCredentials();
                    if (stored?.refreshToken === credentials.refreshToken) {
                        await this.secrets.delete(SECRET_KEY);
                    }
                }
                throw Object.assign(new Error(aiText(
                    `ChatGPT OAuth refresh failed (${response.status}). Sign in again.`,
                    `ChatGPT OAuth 刷新失败（${response.status}）。请重新登录。`,
                )), { status: response.status });
            }
            const tokens = await response.json() as OAuthTokenResponse;
            return persist
                ? this.storeTokenResponse(tokens, credentials)
                : this.buildCredentials(tokens, credentials);
        }).finally(() => {
            if (this.refreshPromises.get(key) === task) this.refreshPromises.delete(key);
        });
        this.refreshPromises.set(key, task);
        return task;
    }

    private async fetchUsage(credentials: StoredOAuthCredentials): Promise<UsageResponse> {
        const response = await this.fetchFn(CODEX_CHATGPT_USAGE_URL, {
            headers: codexSubscriptionHeaders(credentials, this.userAgent),
        });
        if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
        return response.json() as Promise<UsageResponse>;
    }
}
