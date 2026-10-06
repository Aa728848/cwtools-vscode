/**
 * WorkBuddy 浏览器授权登录与网关请求。
 *
 * 官方 IDE 的授权是「初始化 state → 打开浏览器 → 轮询令牌」三步；本模块复刻同一契约，
 * 并复用网关要求的身份头。
 *
 * 凭据只有在能回答 /v2/plugin/account 之后才落盘：浏览器授权只回 auth 块，**不告诉你
 * 这是哪个账号**，因此账号身份必须从该端点读回来，否则同一账号会被存成两条记录。
 */

import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';
import {
    WORKBUDDY_ACCOUNT_PATH,
    WORKBUDDY_CLIENT_PRODUCT,
    WORKBUDDY_CLIENT_USER_AGENT,
    WORKBUDDY_DEFAULT_DOMAIN,
    WORKBUDDY_DISCOVERY_TIMEOUT_MS,
    WORKBUDDY_HEADER_DOMAIN,
    WORKBUDDY_HEADER_ENTERPRISE_ID,
    WORKBUDDY_HEADER_IDE_NAME,
    WORKBUDDY_HEADER_PRODUCT,
    WORKBUDDY_HEADER_REFRESH_SOURCE,
    WORKBUDDY_HEADER_REFRESH_TOKEN,
    WORKBUDDY_HEADER_REQUESTED_WITH,
    WORKBUDDY_HEADER_TENANT_ID,
    WORKBUDDY_HEADER_USER_ID,
    WORKBUDDY_LOGIN_PENDING_CODE,
    WORKBUDDY_LOGIN_PLATFORM,
    WORKBUDDY_LOGIN_POLL_INTERVAL_MS,
    WORKBUDDY_LOGIN_STATE_PATH,
    WORKBUDDY_LOGIN_TIMEOUT_MS,
    WORKBUDDY_LOGIN_TOKEN_PATH,
    WORKBUDDY_REFRESH_PATH,
    WORKBUDDY_PROVIDER_NAME,
    isWorkBuddyIntlDomain,
    workBuddyBackendForDomain,
    workBuddyDomainForRegion,
    workBuddyRefreshSourceForDomain,
    workBuddyRegionForDomain,
    type WorkBuddyRegion,
} from './types';
import { writeBackWorkBuddyDesktopCredential, type WorkBuddyCredentials } from './credentials';
import { withResolvedIdentity } from './identity';

export interface WorkBuddyRequestOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

/**
 * 归属与身份头。
 *
 * 网关据此门控：国际区部署在缺 CLI user agent 或不匹配的 Origin/Referer 时答 401，
 * 两个部署都读账号身份头而不是只从 bearer token 推导。
 */
export function workBuddyHeaders(
    credentials: Pick<WorkBuddyCredentials, 'accessToken' | 'domain' | 'uid' | 'enterpriseId' | 'backend'>,
    extra: Record<string, string> = {},
): Record<string, string> {
    const domain = credentials.domain || WORKBUDDY_DEFAULT_DOMAIN;
    const intl = isWorkBuddyIntlDomain(domain);
    return {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + credentials.accessToken,
        [WORKBUDDY_HEADER_USER_ID]: credentials.uid ?? '',
        [WORKBUDDY_HEADER_ENTERPRISE_ID]: credentials.enterpriseId ?? '',
        [WORKBUDDY_HEADER_TENANT_ID]: credentials.enterpriseId ?? '',
        [WORKBUDDY_HEADER_DOMAIN]: domain,
        [WORKBUDDY_HEADER_PRODUCT]: WORKBUDDY_CLIENT_PRODUCT,
        [WORKBUDDY_HEADER_IDE_NAME]: 'CodeBuddyIDE',
        [WORKBUDDY_HEADER_REQUESTED_WITH]: 'XMLHttpRequest',
        'user-agent': WORKBUDDY_CLIENT_USER_AGENT,
        ...(intl ? { origin: credentials.backend, referer: credentials.backend + '/' } : {}),
        ...extra,
    };
}

/**
 * 用官方 IDE 使用的端点续期 access token。
 *
 * 响应带回的是整个新的 auth 块而不是单个 token，因此**合并**到当前凭据上：端点省略的
 * 字段（域、refresh 有效期）必须存活，否则下一次续期会失去目标。
 */
export async function refreshWorkBuddyCredentials(
    credentials: WorkBuddyCredentials,
    options: WorkBuddyRequestOptions = {},
): Promise<WorkBuddyCredentials> {
    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(credentials.backend + WORKBUDDY_REFRESH_PATH, {
        method: 'POST',
        headers: workBuddyHeaders(credentials, {
            [WORKBUDDY_HEADER_REFRESH_TOKEN]: credentials.refreshToken,
            [WORKBUDDY_HEADER_REFRESH_SOURCE]: workBuddyRefreshSourceForDomain(credentials.domain),
        }),
        body: '{}',
        signal: timeoutSignal(options.signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS),
    });

    const text = await response.text().catch(() => '');
    // 被服务端拒绝的续期对该账号是**终局**；传输失败是临时的，必须让账号留在原地。
    if (!response.ok) {
        // 状态码随错误一起抛出：号池据此把这次续期判为「凭据已死」并停用该账号。
        // 丢了它，一次被拒的刷新会被当成临时故障，账号会一直留在轮转里被选中。
        throw Object.assign(
            new Error(WORKBUDDY_PROVIDER_NAME + ' token refresh failed (' + response.status + ')'
                + (text ? ': ' + text.slice(0, 200) : '')),
            { status: response.status },
        );
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error(WORKBUDDY_PROVIDER_NAME + ' token refresh returned non-JSON.'); }
    if (!isRecord(payload)) throw new Error(WORKBUDDY_PROVIDER_NAME + ' token refresh was rejected.');
    const data = isRecord(payload.data) ? payload.data : undefined;
    if (payload.code !== 0 || data === undefined) {
        throw new Error(WORKBUDDY_PROVIDER_NAME + ' token refresh was rejected: ' + (asString(payload.msg) ?? 'no detail'));
    }
    const accessToken = asString(data.accessToken);
    if (accessToken === undefined) throw new Error(WORKBUDDY_PROVIDER_NAME + ' token refresh returned no access token.');
    const expiresIn = asNumber(data.expiresIn);
    const expiresAt = asNumber(data.expiresAt) ?? (expiresIn === undefined ? credentials.expiresAt : Date.now() + expiresIn * 1000);
    const domain = asString(data.domain) ?? credentials.domain;
    const next: WorkBuddyCredentials = {
        ...credentials,
        accessToken,
        refreshToken: asString(data.refreshToken) ?? credentials.refreshToken,
        expiresAt,
        // 端点通常会回显域；不回显时账号留在原来的后端上。
        domain,
        backend: workBuddyBackendForDomain(domain),
        region: workBuddyRegionForDomain(domain),
    };
    // 桌面账号的 refresh token 会轮换：只写进插件存储会让 IDE 手里剩一个作废的 token。
    writeBackWorkBuddyDesktopCredential(next);
    return next;
}

/** 读取已登录账号的身份事实；失败返回 undefined 而不是让登录失败。 */
export async function fetchWorkBuddyIdentity(
    credentials: WorkBuddyCredentials,
    options: WorkBuddyRequestOptions = {},
): Promise<Partial<Pick<WorkBuddyCredentials, 'uid' | 'nickname' | 'uin' | 'enterpriseId'>> | undefined> {
    const fetchFn = options.fetchFn ?? fetch;
    try {
        const response = await fetchFn(credentials.backend + WORKBUDDY_ACCOUNT_PATH, {
            headers: workBuddyHeaders(credentials),
            signal: timeoutSignal(options.signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        const payload: unknown = await response.json().catch(() => undefined);
        if (!isRecord(payload) || payload.code !== 0) return undefined;
        const account = isRecord(payload.data) ? payload.data : undefined;
        if (account === undefined) return undefined;
        return {
            ...(asString(account.uid) ? { uid: asString(account.uid) } : {}),
            ...(asString(account.nickname) ? { nickname: asString(account.nickname) } : {}),
            ...(asString(account.uin) ? { uin: asString(account.uin) } : {}),
            ...(asString(account.enterpriseId) ? { enterpriseId: asString(account.enterpriseId) } : {}),
        };
    } catch {
        return undefined;
    }
}

export interface WorkBuddyLoginAttempt {
    state: string;
    authUrl: string;
    region: WorkBuddyRegion;
    domain: string;
}

function loginHeaders(domain: string): Record<string, string> {
    const backend = workBuddyBackendForDomain(domain);
    const intl = isWorkBuddyIntlDomain(domain);
    return {
        'content-type': 'application/json',
        accept: 'application/json',
        [WORKBUDDY_HEADER_DOMAIN]: domain,
        [WORKBUDDY_HEADER_PRODUCT]: WORKBUDDY_CLIENT_PRODUCT,
        [WORKBUDDY_HEADER_IDE_NAME]: 'CodeBuddyIDE',
        [WORKBUDDY_HEADER_REQUESTED_WITH]: 'XMLHttpRequest',
        'user-agent': WORKBUDDY_CLIENT_USER_AGENT,
        ...(intl ? { origin: backend, referer: backend + '/' } : {}),
    };
}

/** 初始化一次浏览器授权。 */
export async function requestWorkBuddyLoginState(
    region: WorkBuddyRegion,
    options: WorkBuddyRequestOptions = {},
): Promise<WorkBuddyLoginAttempt> {
    const fetchFn = options.fetchFn ?? fetch;
    const domain = workBuddyDomainForRegion(region);
    const backend = workBuddyBackendForDomain(domain);
    const response = await fetchFn(backend + WORKBUDDY_LOGIN_STATE_PATH + '?platform=' + WORKBUDDY_LOGIN_PLATFORM, {
        method: 'POST',
        headers: loginHeaders(domain),
        body: '{}',
        signal: timeoutSignal(options.signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    let root: Record<string, unknown> | undefined;
    try {
        const parsed: unknown = JSON.parse(text);
        root = isRecord(parsed) ? parsed : undefined;
    } catch { root = undefined; }
    if (!response.ok || root?.code !== 0 || !isRecord(root.data)) {
        throw new Error(WORKBUDDY_PROVIDER_NAME + ' login init failed (HTTP ' + response.status + '): '
            + (asString(root?.msg) ?? text.slice(0, 160)));
    }
    const state = asString(root.data.state);
    const authUrl = asString(root.data.authUrl);
    if (!state || !authUrl) throw new Error(WORKBUDDY_PROVIDER_NAME + ' login response lacked state or authUrl.');
    return { state, authUrl, region, domain };
}

/**
 * 解析一次令牌轮询。
 *
 * 返回 null 表示**仍在等待授权**（业务码 11217），而不是失败。
 */
export function parseWorkBuddyLoginCredential(payload: unknown, attempt: WorkBuddyLoginAttempt): WorkBuddyCredentials | null {
    if (!isRecord(payload)) throw new Error(WORKBUDDY_PROVIDER_NAME + ' login poll response was invalid.');
    const code = asNumber(payload.code);
    if (code === WORKBUDDY_LOGIN_PENDING_CODE) return null;
    if (code !== 0) throw new Error(WORKBUDDY_PROVIDER_NAME + ' login failed: ' + (asString(payload.msg) ?? 'code ' + String(code)));
    const data = isRecord(payload.data) ? payload.data : payload;
    const auth = isRecord(data.auth) ? data.auth : data;
    const account = isRecord(data.account) ? data.account
        : isRecord(auth.account) ? auth.account
            : isRecord(data.user) ? data.user
                : isRecord(auth.user) ? auth.user
                    : {};
    const accessToken = asString(auth.accessToken) ?? asString(auth.access_token) ?? asString(data.token);
    if (!accessToken) throw new Error(WORKBUDDY_PROVIDER_NAME + ' login response lacked an access token.');
    const domain = asString(auth.domain) ?? attempt.domain;
    const expiresIn = asNumber(auth.expiresIn) ?? asNumber(auth.expires_in);
    const expiresAt = asNumber(auth.expiresAt) ?? asNumber(auth.expires_at)
        ?? (expiresIn === undefined ? Date.now() + 60 * 60 * 1000 : Date.now() + expiresIn * 1000);
    const uid = asString(account.uid) ?? asString(data.uid);
    const nickname = asString(account.nickname) ?? asString(account.name) ?? asString(data.nickname);
    const uin = asString(account.uin) ?? asString(data.uin);
    const enterpriseId = asString(account.enterpriseId) ?? asString(data.enterpriseId);
    const accountType = asString(account.type) ?? asString(data.accountType);
    // The login response carries only the auth block, so the account may still be unnamed
    // here; the token's own claims name it either way.
    return withResolvedIdentity({
        accessToken,
        refreshToken: asString(auth.refreshToken) ?? asString(auth.refresh_token)
            ?? asString(data.refreshToken) ?? asString(data.refresh_token) ?? '',
        expiresAt,
        domain,
        backend: workBuddyBackendForDomain(domain),
        region: workBuddyRegionForDomain(domain),
        ...(uid ? { uid } : {}),
        ...(nickname ? { nickname } : {}),
        ...(uin ? { uin } : {}),
        ...(enterpriseId ? { enterpriseId } : {}),
        ...(accountType ? { accountType } : {}),
        source: 'managed',
        sourceFile: '',
        sourceMtimeMs: 0,
    });
}

/** 轮询一次令牌。 */
export async function pollWorkBuddyLogin(
    attempt: WorkBuddyLoginAttempt,
    options: WorkBuddyRequestOptions = {},
): Promise<WorkBuddyCredentials | null> {
    const fetchFn = options.fetchFn ?? fetch;
    const backend = workBuddyBackendForDomain(attempt.domain);
    const response = await fetchFn(
        backend + WORKBUDDY_LOGIN_TOKEN_PATH + '?platform=' + WORKBUDDY_LOGIN_PLATFORM + '&state=' + encodeURIComponent(attempt.state),
        { headers: loginHeaders(attempt.domain), signal: timeoutSignal(options.signal, WORKBUDDY_DISCOVERY_TIMEOUT_MS) },
    );
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(WORKBUDDY_PROVIDER_NAME + ' login poll failed (HTTP ' + response.status + '): ' + text.slice(0, 160));
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error(WORKBUDDY_PROVIDER_NAME + ' login poll returned non-JSON.'); }
    return parseWorkBuddyLoginCredential(payload, attempt);
}

export interface WorkBuddyLogin {
    authUrl: string;
    region: WorkBuddyRegion;
    /** 凭据已保存后结算。 */
    completion: Promise<void>;
    cancel(): void;
}

export interface WorkBuddyOAuthOptions {
    saveCredentials: (credentials: WorkBuddyCredentials) => Promise<void>;
    openBrowser: (url: string) => void;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    /** 轮询间隔；测试可缩短。 */
    pollIntervalMs?: number;
}

/**
 * 拥有 WorkBuddy 浏览器授权流程的会话。
 *
 * 凭据在**身份确定之后**才落盘：浏览器授权只回 auth 块，不说这是哪个账号；先存后改正是
 * 「同一账号被存成两条记录」的成因。身份读取是尽力而为——一个不肯回答额外请求的部署
 * 仍然要能完成登录。
 */
export class WorkBuddyOAuthService {
    private activeCancel?: (reason?: Error) => void;

    constructor(private readonly options: WorkBuddyOAuthOptions) {}

    async startLogin(region: WorkBuddyRegion): Promise<WorkBuddyLogin> {
        this.activeCancel?.(new Error(aiText(
            'A newer WorkBuddy sign-in was started.',
            '已开始新的 WorkBuddy 登录。',
        )));

        const fetchFn = this.options.fetchFn ?? fetch;
        const attempt = await requestWorkBuddyLoginState(region, { fetchFn });
        try { this.options.openBrowser(attempt.authUrl); } catch { /* 卡片始终渲染链接 */ }

        const controller = new AbortController();
        let settled = false;
        let resolveCompletion!: () => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<void>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        completion.catch(() => undefined);

        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            this.activeCancel = undefined;
            if (error) rejectCompletion(error);
            else resolveCompletion();
        };
        const cancel = (reason?: Error): void => {
            const failure = reason ?? new Error(aiText('WorkBuddy sign-in was cancelled.', 'WorkBuddy 登录已取消。'));
            controller.abort(failure);
            finish(failure);
        };
        this.activeCancel = cancel;

        const deadline = Date.now() + (this.options.timeoutMs ?? WORKBUDDY_LOGIN_TIMEOUT_MS);
        const interval = this.options.pollIntervalMs ?? WORKBUDDY_LOGIN_POLL_INTERVAL_MS;
        void (async () => {
            try {
                while (Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, interval));
                    if (controller.signal.aborted) return;
                    const credentials = await pollWorkBuddyLogin(attempt, { fetchFn, signal: controller.signal });
                    if (credentials === null) continue;
                    const identity = await fetchWorkBuddyIdentity(credentials, { fetchFn, signal: controller.signal });
                    const resolved: WorkBuddyCredentials = withResolvedIdentity(
                        identity === undefined ? credentials : { ...credentials, ...identity });
                    await this.options.saveCredentials(resolved);
                    finish();
                    return;
                }
                finish(new Error(aiText('WorkBuddy sign-in timed out.', 'WorkBuddy 登录超时。')));
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        })();

        return { authUrl: attempt.authUrl, region, completion, cancel: () => cancel() };
    }

    dispose(): void {
        this.activeCancel?.();
        this.activeCancel = undefined;
    }
}
