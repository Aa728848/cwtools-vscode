/**
 * Kimi Code 设备码登录（RFC 8628）与凭据会话。
 *
 * Kimi Code 订阅与 Moonshot 开放平台是两套互不通用的系统：订阅的模型接口是
 * `https://api.kimi.com/coding/v1`，凭据只来自订阅 OAuth。把开放平台的 Key 用在这里
 * 会被判为 `401 Invalid Authentication`，所以本模块**只**做设备码登录。
 *
 * 三个必须照抄官方客户端的细节：
 * - 设备码流程无需回调端口，因此无浏览器环境也能手工完成（把用户码与链接展示给
 *   用户即可）；
 * - `slow_down` 要按 RFC 调宽轮询间隔（永久加宽，而不是只跳过一轮），否则会被
 *   服务端持续限流；
 * - 设备码**过期不是终局**：重新申请一次，让动作慢的用户仍能登录。
 *
 * 凭据存进 VS Code SecretStorage（`cwtools.ai.apiKey.kimi-code-plan`），与手动粘贴
 * API Key 共用同一个槽位：两种登录来源互不覆盖，后登录者生效。
 */

import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type * as vscode from 'vscode';
import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';

/** Kimi Code 订阅的公开客户端 id。 */
export const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
/** 设备授权端点（RFC 8628 §3.1）。 */
export const KIMI_DEVICE_AUTHORIZATION_PATH = '/api/oauth/device_authorization';
/** 令牌端点，同时服务设备码授权与刷新（RFC 8628 §3.4）。 */
export const KIMI_OAUTH_TOKEN_PATH = '/api/oauth/token';
export const KIMI_DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** 区域对应的 OAuth 主机；全球账号由 .ai 属性服务。 */
export const KIMI_REGION_OAUTH_HOSTS: Record<'mainland-cn' | 'global', string> = {
    'mainland-cn': 'https://auth.kimi.com',
    global: 'https://auth.kimi.ai',
};

/** 产品标识，与官方客户端同一套词表。 */
export const KIMI_MSH_PLATFORM = 'kimi_code_cli';
export const KIMI_MSH_VERSION = '1.0.0';

export const KIMI_DEVICE_INTERVAL_FALLBACK_SECONDS = 5;
export const KIMI_DEVICE_EXPIRES_FALLBACK_SECONDS = 600;
export const KIMI_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_TIMEOUT_MS = 30_000;

export interface KimiDeviceAuthorization {
    userCode: string;
    deviceCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
    host: string;
}

export interface KimiLogin {
    /** 用户码与一次性链接，直接展示给用户。 */
    authorization: KimiDeviceAuthorization;
    /** 登录完成（凭据已保存）后结算。 */
    completion: Promise<void>;
    cancel(): void;
}

/** 可打印 ASCII 的头值；清空后为空则省略该头。 */
function asciiHeaderValue(value: string): string | undefined {
    const printable = value.replace(/[^\x20-\x7E]/g, '').trim();
    return printable === '' ? undefined : printable;
}

/** 本机的人类可读描述，与官方客户端一致。 */
export function kimiDeviceModel(): string {
    const arch = os.arch();
    const release = os.release();
    if (process.platform === 'win32') {
        // Node 报告的是 Windows 内核版本（10.0.x），营销版本要看 build 号。
        const build = Number(release.split('.')[2] ?? '0');
        return `${build >= 22000 ? 'Windows 11' : 'Windows 10'} ${arch}`;
    }
    if (process.platform === 'darwin') return `macOS ${release} ${arch}`;
    return `${process.platform} ${release} ${arch}`;
}

/** 身份头：稳定设备 id + 平台/版本/机型，托管服务按此识别安装。 */
export function kimiIdentityHeaders(deviceId: string, extra: Record<string, string> = {}): Record<string, string> {
    const candidates: Array<[string, string | undefined]> = [
        ['user-agent', `cwtools-vscode ${KIMI_MSH_PLATFORM}/${KIMI_MSH_VERSION}`],
        ['x-msh-platform', KIMI_MSH_PLATFORM],
        ['x-msh-version', KIMI_MSH_VERSION],
        ['x-msh-device-name', os.hostname()],
        ['x-msh-device-model', kimiDeviceModel()],
        ['x-msh-os-version', os.release()],
        ['x-msh-device-id', deviceId],
    ];
    const headers: Record<string, string> = {};
    for (const [name, value] of candidates) {
        if (value === undefined) continue;
        const safe = asciiHeaderValue(value);
        if (safe !== undefined) headers[name] = safe;
    }
    return { ...headers, ...extra };
}

/**
 * 读取稳定设备 id，只创建一次。
 *
 * 它不是密钥，只需要保持稳定；写入失败时退化为进程内取值，而不是让登录失败。
 */
export async function readOrCreateKimiDeviceId(storageDir: string): Promise<string> {
    const file = path.join(storageDir, 'kimi-code-device-id');
    try {
        const existing = (await fs.promises.readFile(file, 'utf8')).trim();
        if (existing !== '') return existing;
    } catch {
        // 文件不存在：继续创建。
    }
    const created = randomUUID();
    try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, created, { encoding: 'utf8', mode: 0o600 });
    } catch {
        // 只读的 home 目录仍然拿到一个可用（只是不稳定）的 id。
    }
    return created;
}

function oauthErrorFields(payload: unknown): { code: string; description: string } {
    const root = isRecord(payload) ? payload : {};
    const nested = isRecord(root.error) ? root.error : undefined;
    if (nested !== undefined) {
        return {
            code: typeof nested.code === 'string' ? nested.code : '',
            description: String(nested.message ?? nested.error_description ?? nested.detail ?? nested.type ?? ''),
        };
    }
    return {
        code: typeof root.error === 'string' ? root.error : '',
        description: String(root.error_description ?? root.error_message ?? ''),
    };
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** 启动设备授权（RFC 8628 §3.1）。公共客户端只发送 `client_id`。 */
export async function requestKimiDeviceAuthorization(options: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    host?: string;
    deviceId: string;
}): Promise<KimiDeviceAuthorization> {
    const fetchFn = options.fetchFn ?? fetch;
    const host = options.host ?? KIMI_REGION_OAUTH_HOSTS['mainland-cn'];
    const response = await fetchFn(`${host}${KIMI_DEVICE_AUTHORIZATION_PATH}`, {
        method: 'POST',
        headers: kimiIdentityHeaders(options.deviceId, {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        }),
        body: new URLSearchParams({ client_id: KIMI_CODE_CLIENT_ID }).toString(),
        signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
    });

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
        const { description } = oauthErrorFields(payload);
        throw new Error(aiText(
            `Kimi Code device authorization failed (${response.status})${description ? `: ${description}` : ''}`,
            `Kimi Code 设备授权失败（${response.status}）${description ? `：${description}` : ''}`,
        ));
    }

    const record = isRecord(payload) ? payload : {};
    const userCode = typeof record.user_code === 'string' ? record.user_code : '';
    const deviceCode = typeof record.device_code === 'string' ? record.device_code : '';
    const complete = typeof record.verification_uri_complete === 'string' ? record.verification_uri_complete : '';
    if (userCode === '' || deviceCode === '' || complete === '') {
        throw new Error(aiText(
            'Kimi Code device authorization did not return a device code and verification URL.',
            'Kimi Code 设备授权未返回设备码与验证链接。',
        ));
    }
    const expiresIn = Number(record.expires_in);
    const interval = Number(record.interval);
    return {
        userCode,
        deviceCode,
        verificationUri: typeof record.verification_uri === 'string' ? record.verification_uri : '',
        verificationUriComplete: complete,
        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : KIMI_DEVICE_EXPIRES_FALLBACK_SECONDS,
        interval: Number.isFinite(interval) && interval > 0 ? interval : KIMI_DEVICE_INTERVAL_FALLBACK_SECONDS,
        host,
    };
}

/** 设备码换到的令牌对。refresh token 必须一起保存，否则一小时后只能重新登录。 */
export interface KimiDeviceToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    expiresIn: number;
}

export type KimiPollOutcome =
    | { kind: 'success'; token: KimiDeviceToken }
    | { kind: 'pending'; slowDown: boolean }
    | { kind: 'expired' };

/**
 * 轮询一次设备令牌（RFC 8628 §3.4）。
 *
 * 5xx 是传输类失败而不是对设备码的判定，因此抛给调用方的重试/退避循环，而不是读作
 * 「仍在等待」——当成 pending 会一直空转到设备码过期。
 */
export async function pollKimiDeviceToken(
    authorization: KimiDeviceAuthorization,
    options: { fetchFn?: typeof fetch; signal?: AbortSignal; deviceId: string },
): Promise<KimiPollOutcome> {
    const fetchFn = options.fetchFn ?? fetch;
    const response = await fetchFn(`${authorization.host}${KIMI_OAUTH_TOKEN_PATH}`, {
        method: 'POST',
        headers: kimiIdentityHeaders(options.deviceId, {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
        }),
        body: new URLSearchParams({
            client_id: KIMI_CODE_CLIENT_ID,
            device_code: authorization.deviceCode,
            grant_type: KIMI_DEVICE_CODE_GRANT_TYPE,
        }).toString(),
        signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
    });

    const payload: unknown = await response.json().catch(() => undefined);
    const record = isRecord(payload) ? payload : {};
    if (response.status === 200 && typeof record.access_token === 'string' && record.access_token !== '') {
        const accessToken = record.access_token;
        const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : '';
        if (refreshToken === '') {
            // Without a refresh token the credential dies in an hour and the user
            // is sent back to sign in; that is not a usable subscription login.
            throw new Error(aiText(
                'Kimi Code returned no refresh token, so the session could not be renewed.',
                'Kimi Code 未返回 refresh token，会话无法续期。',
            ));
        }
        const expiresIn = Number(record.expires_in);
        const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
        return {
            kind: 'success',
            token: {
                accessToken,
                refreshToken,
                expiresAt: Date.now() + lifetime * 1000,
                expiresIn: lifetime,
            },
        };
    }
    if (response.status >= 500) {
        throw new Error(aiText(
            `Kimi Code token polling server error: ${response.status}.`,
            `Kimi Code 令牌轮询服务端错误：${response.status}。`,
        ));
    }
    const { code, description } = oauthErrorFields(payload);
    if (code === 'authorization_pending') return { kind: 'pending', slowDown: false };
    if (code === 'slow_down') return { kind: 'pending', slowDown: true };
    if (code === 'expired_token') return { kind: 'expired' };
    if (code === 'access_denied') {
        throw new Error(description || aiText('The Kimi Code authorization request was denied.', 'Kimi Code 授权请求被拒绝。'));
    }
    throw new Error(description || aiText(
        `Kimi Code token polling failed (${response.status}).`,
        `Kimi Code 令牌轮询失败（${response.status}）。`,
    ));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('aborted'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface KimiCodeOAuthOptions {
    /** 存设备 id 的目录（通常是扩展的 globalStorage）。 */
    storageDir: string;
    /** 保存设备码换到的令牌对（与手动粘贴 API Key 分开一个槽位）。 */
    saveToken: (token: KimiDeviceToken) => Promise<void>;
    openBrowser: (url: string) => void;
    fetchFn?: typeof fetch;
    /** 区域；默认国区。 */
    region?: 'mainland-cn' | 'global';
    /** 展示用户码的回调，供设置卡片渲染。 */
    onUserCode?: (authorization: KimiDeviceAuthorization) => void;
}

/**
 * 拥有 Kimi Code 设备码登录流程的会话。
 *
 * 外层循环实现官方客户端的 RFC 8628 恢复：设备码过期不是致命错误，而是用一份新的
 * 授权重新开始，让动作慢的用户仍然能登录。
 */
export class KimiCodeOAuthService {
    private activeCancel?: (reason?: Error) => void;

    constructor(private readonly options: KimiCodeOAuthOptions) {}

    async startLogin(): Promise<KimiLogin> {
        this.activeCancel?.(new Error(aiText(
            'A newer Kimi Code sign-in was started.',
            '已开始新的 Kimi Code 登录。',
        )));

        const fetchFn = this.options.fetchFn ?? fetch;
        const region = this.options.region ?? 'mainland-cn';
        const deviceId = await readOrCreateKimiDeviceId(this.options.storageDir);
        const authorization = await requestKimiDeviceAuthorization({
            fetchFn,
            host: KIMI_REGION_OAUTH_HOSTS[region],
            deviceId,
        });

        this.options.onUserCode?.(authorization);
        try {
            this.options.openBrowser(authorization.verificationUriComplete);
        } catch {
            // 卡片始终渲染链接，所以打开失败是可恢复的。
        }

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

        const cancel = (reason = new Error(aiText(
            'Kimi Code sign-in was cancelled.',
            'Kimi Code 登录已取消。',
        ))) => {
            controller.abort(reason);
            finish(reason);
        };
        this.activeCancel = cancel;

        const deadline = Date.now() + KIMI_LOGIN_TIMEOUT_MS;
        void (async () => {
            try {
                let current = authorization;
                let interval = Math.max(current.interval, 1);
                while (true) {
                    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('cancelled');
                    if (Date.now() > deadline) {
                        throw new Error(aiText('Kimi Code sign-in timed out.', 'Kimi Code 登录超时。'));
                    }
                    const outcome = await pollKimiDeviceToken(current, {
                        fetchFn,
                        signal: controller.signal,
                        deviceId,
                    });
                    if (outcome.kind === 'success') {
                        await this.options.saveToken(outcome.token);
                        finish();
                        return;
                    }
                    if (outcome.kind === 'expired') {
                        // 不是终局：用一份新的设备码重新开始。
                        current = await requestKimiDeviceAuthorization({
                            fetchFn,
                            host: KIMI_REGION_OAUTH_HOSTS[region],
                            deviceId,
                        });
                        this.options.onUserCode?.(current);
                        interval = Math.max(current.interval, 1);
                        continue;
                    }
                    // RFC 8628：slow_down 永久加宽轮询间隔。
                    if (outcome.slowDown) interval += 5;
                    await sleep(interval * 1000, controller.signal);
                }
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        })();

        return { authorization, completion, cancel: () => cancel() };
    }

    dispose(): void {
        this.activeCancel?.();
        this.activeCancel = undefined;
    }
}
