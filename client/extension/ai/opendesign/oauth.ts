/**
 * OpenDesign 设备授权登录流（AMR Control Plane CLI Device Flow）。
 *
 * 1. `POST {apiBase}/cli/device-authorizations` 申请 `deviceId`、`userCode`、`activationUrl`、`deviceSecret`；
 * 2. 打开浏览器跳转 `activationUrl` 让用户确认 `userCode`；
 * 3. `POST {apiBase}/cli/device-authorizations/{deviceId}/token` 轮询获取双密钥对（`controlKey` + `runtimeKey`）及账号信息。
 */

import * as os from 'os';
import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';
import {
    OPENDESIGN_AMR_API_BASE,
    OPENDESIGN_DEVICE_AUTHORIZATIONS_PATH,
    OPENDESIGN_DEVICE_CLIENT_NAME,
    OPENDESIGN_DEVICE_CLIENT_PROFILE,
    OPENDESIGN_LOGIN_TIMEOUT_MS,
    OPENDESIGN_OAUTH_TIMEOUT_MS,
} from './types';
import type { OpenDesignOAuthCredentials } from './credentials';

const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const DEFAULT_DEVICE_EXPIRES_SECONDS = 300;

export class OpenDesignOAuthError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly cause?: unknown;

    constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
        super(message);
        this.name = 'OpenDesignOAuthError';
        this.status = options.status;
        this.code = options.code;
        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}

export interface OpenDesignDeviceAuthorization {
    deviceId: string;
    userCode: string;
    activationUrl: string;
    deviceSecret: string;
    expiresAt: number;
    pollIntervalSeconds: number;
}

export type OpenDesignDevicePoll =
    | { pending: true }
    | { pending: false; credentials: OpenDesignOAuthCredentials };

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function positiveSeconds(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timer = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timer]) : timer;
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

function errorMessageOf(json: unknown, text: string): string {
    if (isRecord(json)) {
        const direct = json.error ?? json.message;
        if (typeof direct === 'string' && direct.trim() !== '') return direct.trim().slice(0, 200);
        if (isRecord(direct) && typeof direct.message === 'string' && direct.message.trim() !== '') {
            return direct.message.trim().slice(0, 200);
        }
    }
    return text.trim().slice(0, 200);
}

/** 启动 OpenDesign 设备码授权。 */
export async function startOpenDesignDeviceAuth(options: {
    fetchFn?: typeof fetch;
    apiBase?: string;
    host?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
} = {}): Promise<OpenDesignDeviceAuthorization> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = (options.apiBase ?? OPENDESIGN_AMR_API_BASE).replace(/\/+$/, '');
    const host = options.host ?? (os.hostname() || 'cwtools-vscode');
    const response = await fetchFn(`${base}${OPENDESIGN_DEVICE_AUTHORIZATIONS_PATH}`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            host,
            profile: OPENDESIGN_DEVICE_CLIENT_PROFILE,
            cliVersion: OPENDESIGN_DEVICE_CLIENT_NAME,
        }),
        signal: timeoutSignal(options.signal, options.timeoutMs ?? OPENDESIGN_OAUTH_TIMEOUT_MS),
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
        try { payload = JSON.parse(text); } catch { payload = null; }
    }

    if (!response.ok) {
        const detail = errorMessageOf(payload, text);
        throw new OpenDesignOAuthError(
            aiText(
                `OpenDesign device authorization failed (${response.status})${detail ? `: ${detail}` : ''}`,
                `OpenDesign 设备授权失败（${response.status}）${detail ? `：${detail}` : ''}`,
            ),
            { status: response.status },
        );
    }

    const record = isRecord(payload) ? payload : {};
    const deviceId = nonEmpty(record.deviceId);
    const userCode = nonEmpty(record.userCode);
    const activationUrl = nonEmpty(record.activationUrl);
    const deviceSecret = nonEmpty(record.deviceSecret);
    if (!deviceId || !userCode || !activationUrl || !deviceSecret) {
        throw new OpenDesignOAuthError(
            aiText(
                'OpenDesign device authorization response was missing required fields.',
                'OpenDesign 设备授权返回字段不完整。',
            ),
            { status: response.status },
        );
    }
    const expiresAtMs = Date.parse(String(record.expiresAt ?? ''));
    return {
        deviceId,
        userCode,
        activationUrl,
        deviceSecret,
        expiresAt: Number.isFinite(expiresAtMs) && expiresAtMs > 0
            ? expiresAtMs
            : Date.now() + positiveSeconds(record.expiresIn, DEFAULT_DEVICE_EXPIRES_SECONDS) * 1000,
        pollIntervalSeconds: positiveSeconds(record.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS),
    };
}

/** 轮询一次设备码授权状态；批准后返回含双密钥的 `OpenDesignOAuthCredentials`。 */
export async function pollOpenDesignDevice(
    authorization: Pick<OpenDesignDeviceAuthorization, 'deviceId' | 'deviceSecret'>,
    options: {
        fetchFn?: typeof fetch;
        apiBase?: string;
        signal?: AbortSignal;
        timeoutMs?: number;
    } = {},
): Promise<OpenDesignDevicePoll> {
    const fetchFn = options.fetchFn ?? fetch;
    const base = (options.apiBase ?? OPENDESIGN_AMR_API_BASE).replace(/\/+$/, '');
    const response = await fetchFn(
        `${base}${OPENDESIGN_DEVICE_AUTHORIZATIONS_PATH}/${encodeURIComponent(authorization.deviceId)}/token`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ deviceSecret: authorization.deviceSecret }),
            signal: timeoutSignal(options.signal, options.timeoutMs ?? OPENDESIGN_OAUTH_TIMEOUT_MS),
        },
    );

    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
        try { json = JSON.parse(text); } catch { json = null; }
    }
    const record = isRecord(json) ? json : {};
    if (response.ok) {
        const runtimeKey = nonEmpty(record.runtimeKey);
        const controlKey = nonEmpty(record.controlKey);
        if (runtimeKey !== undefined && controlKey !== undefined) {
            const rawUser = isRecord(record.user) ? record.user : undefined;
            const user = rawUser === undefined
                ? undefined
                : {
                    ...(nonEmpty(rawUser.id) ? { id: nonEmpty(rawUser.id) } : {}),
                    ...(nonEmpty(rawUser.email) ? { email: nonEmpty(rawUser.email) } : {}),
                    ...(nonEmpty(rawUser.name) ? { name: nonEmpty(rawUser.name) } : {}),
                    ...(nonEmpty(rawUser.plan) ? { plan: nonEmpty(rawUser.plan) } : {}),
                };
            return {
                pending: false,
                credentials: {
                    kind: 'oauth',
                    controlKey,
                    runtimeKey,
                    addedAt: Date.now(),
                    ...(user && Object.keys(user).length > 0 ? { user } : {}),
                },
            };
        }
        const status = nonEmpty(record.status) ?? '';
        if (status === '' || status === 'pending') return { pending: true };
        throw new OpenDesignOAuthError(
            aiText(`OpenDesign authorization was ${status}.`, `OpenDesign 授权状态为 ${status}。`),
            { status: response.status, code: status },
        );
    }

    const detail = errorMessageOf(json, text);
    throw new OpenDesignOAuthError(
        detail === ''
            ? aiText(`OpenDesign poll failed (${response.status})`, `OpenDesign 轮询失败（${response.status}）`)
            : detail,
        { status: response.status },
    );
}

export interface OpenDesignLogin {
    authorization: OpenDesignDeviceAuthorization;
    completion: Promise<OpenDesignOAuthCredentials>;
    cancel(): void;
}

export interface OpenDesignOAuthServiceOptions {
    saveCredentials: (credentials: OpenDesignOAuthCredentials) => Promise<void>;
    openBrowser: (url: string) => void;
    fetchFn?: typeof fetch;
    apiBase?: string;
    host?: () => string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onUserCode?: (authorization: OpenDesignDeviceAuthorization) => void;
}

/** 拥有 OpenDesign 设备码登录流程生命周期的服务（对齐 MiniMax/Kimi 模式）。 */
export class OpenDesignOAuthService {
    private activeCancel?: (reason?: Error) => void;

    constructor(private readonly options: OpenDesignOAuthServiceOptions) {}

    async startLogin(): Promise<OpenDesignLogin> {
        this.activeCancel?.(new Error(aiText(
            'A newer OpenDesign sign-in was started.',
            '已开始新的 OpenDesign 登录。',
        )));
        const fetchFn = this.options.fetchFn ?? fetch;
        const authorization = await startOpenDesignDeviceAuth({
            fetchFn,
            ...(this.options.apiBase === undefined ? {} : { apiBase: this.options.apiBase }),
            ...(this.options.host === undefined ? {} : { host: this.options.host() }),
        });
        this.options.onUserCode?.(authorization);
        if (/^https:\/\//i.test(authorization.activationUrl)) {
            try {
                this.options.openBrowser(authorization.activationUrl);
            } catch {
                // 通知栏/卡片会展示激活 URL，打开浏览器失败时仍可人工跳转。
            }
        }

        const controller = new AbortController();
        let settled = false;
        let resolveCompletion!: (value: OpenDesignOAuthCredentials) => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<OpenDesignOAuthCredentials>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        completion.catch(() => undefined);

        const finish = (error?: Error, result?: OpenDesignOAuthCredentials): void => {
            if (settled) return;
            settled = true;
            this.activeCancel = undefined;
            if (error) rejectCompletion(error);
            else if (result) resolveCompletion(result);
        };
        const cancel = (reason?: Error): void => {
            const failure = reason ?? new Error(aiText('OpenDesign sign-in was cancelled.', 'OpenDesign 登录已取消。'));
            controller.abort(failure);
            finish(failure);
        };
        this.activeCancel = cancel;

        const deadline = Math.min(
            Date.now() + (this.options.timeoutMs ?? OPENDESIGN_LOGIN_TIMEOUT_MS),
            authorization.expiresAt > 0 ? authorization.expiresAt + 5_000 : Number.MAX_SAFE_INTEGER,
        );
        const pollMs = this.options.pollIntervalMs ?? Math.max(authorization.pollIntervalSeconds, 1) * 1000;

        void (async () => {
            try {
                while (true) {
                    if (controller.signal.aborted) return;
                    if (Date.now() > deadline) {
                        finish(new Error(aiText('OpenDesign sign-in timed out.', 'OpenDesign 登录超时。')));
                        return;
                    }
                    const outcome = await pollOpenDesignDevice(authorization, {
                        fetchFn,
                        ...(this.options.apiBase === undefined ? {} : { apiBase: this.options.apiBase }),
                        signal: controller.signal,
                    });
                    if (!outcome.pending) {
                        await this.options.saveCredentials(outcome.credentials);
                        finish(undefined, outcome.credentials);
                        return;
                    }
                    await sleep(pollMs, controller.signal);
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
