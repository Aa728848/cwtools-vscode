/**
 * OpenDesign 双形态凭据：OAuth（controlKey + runtimeKey）与控制台静态 API Key。
 *
 * 两种形态共用同一个 `'opendesign'` 账号池：
 * - OAuth 设备码登录携带 `controlKey` 与 `runtimeKey`，可读取余额/账单/5h·7d 套餐额度与控制面全量目录；
 * - 控制台粘贴或环境变量提供的静态 `api-key` 仅用于 `/v1/chat/completions` 与 `/v1/models`。
 *
 * 两类凭据都没有过期时间与 refresh token；吊销或额度用尽时通过号池冷却/失效标记与重登处理。
 */

import { createHash } from 'crypto';
import { isRecord } from '../../../shared/protocolValidation';

export const OPENDESIGN_SECRET_KEY = 'cwtools.ai.opendesign.credentials.v1';

export interface OpenDesignApiKeyCredentials {
    kind: 'api-key';
    apiKey: string;
    baseUrl?: string;
    addedAt: number;
    alias?: string;
    workspaceId?: string;
}

export interface OpenDesignOAuthUser {
    id?: string;
    email?: string;
    name?: string;
    plan?: string;
}

export interface OpenDesignOAuthCredentials {
    kind: 'oauth';
    controlKey: string;
    runtimeKey: string;
    baseUrl?: string;
    addedAt: number;
    user?: OpenDesignOAuthUser;
    workspaceId?: string;
}

export type OpenDesignCredentials = OpenDesignApiKeyCredentials | OpenDesignOAuthCredentials;

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

export function isOpenDesignOAuthCredentials(
    credentials: OpenDesignCredentials,
): credentials is OpenDesignOAuthCredentials {
    return credentials.kind === 'oauth';
}

/** 用于网关对话与 `/v1/models` 的 Bearer token。 */
export function openDesignRuntimeKey(credentials: OpenDesignCredentials): string {
    return isOpenDesignOAuthCredentials(credentials) ? credentials.runtimeKey : credentials.apiKey;
}

/** 用于 AMR 控制面（钱包余额、账单、工作区、套餐窗口）的 `vela_ctrl_…` key。 */
export function openDesignControlKey(credentials: OpenDesignCredentials): string | undefined {
    return isOpenDesignOAuthCredentials(credentials) ? credentials.controlKey : undefined;
}

/** 从持久化或外部对象解析 OpenDesign 凭据，形状不合法返回 undefined。 */
export function parseOpenDesignCredentials(value: unknown): OpenDesignCredentials | undefined {
    if (!isRecord(value)) return undefined;
    const baseUrl = asString(value.baseUrl);
    const workspaceId = asString(value.workspaceId);
    const addedAt = asNumber(value.addedAt) ?? Date.now();

    if (value.kind === 'oauth') {
        const controlKey = asString(value.controlKey);
        const runtimeKey = asString(value.runtimeKey);
        if (!controlKey || !runtimeKey) return undefined;
        const rawUser = isRecord(value.user) ? value.user : undefined;
        const user: OpenDesignOAuthUser | undefined = rawUser === undefined
            ? undefined
            : {
                ...(asString(rawUser.id) ? { id: asString(rawUser.id) } : {}),
                ...(asString(rawUser.email) ? { email: asString(rawUser.email) } : {}),
                ...(asString(rawUser.name) ? { name: asString(rawUser.name) } : {}),
                ...(asString(rawUser.plan) ? { plan: asString(rawUser.plan) } : {}),
            };
        return {
            kind: 'oauth',
            controlKey,
            runtimeKey,
            addedAt,
            ...(baseUrl ? { baseUrl } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(user && Object.keys(user).length > 0 ? { user } : {}),
        };
    }

    const apiKey = asString(value.apiKey);
    if (!apiKey) return undefined;
    const alias = asString(value.alias);
    return {
        kind: 'api-key',
        apiKey,
        addedAt,
        ...(baseUrl ? { baseUrl } : {}),
        ...(alias ? { alias } : {}),
        ...(workspaceId ? { workspaceId } : {}),
    };
}

/** 号池稳定身份键，按 `amr-user:` → `amr-email:` → `ctrl:<hash>` → `key:<hash>` 优先级生成，绝不暴露明文 key。 */
export function openDesignCredentialsIdentity(credentials: OpenDesignCredentials): string {
    if (isOpenDesignOAuthCredentials(credentials)) {
        if (credentials.user?.id) return `amr-user:${credentials.user.id}`;
        if (credentials.user?.email) return `amr-email:${credentials.user.email.toLowerCase()}`;
        return `ctrl:${createHash('sha256').update(credentials.controlKey).digest('hex')}`;
    }
    return `key:${createHash('sha256').update(credentials.apiKey).digest('hex')}`;
}

/** 供 UI 展示的安全描述，绝不输出明文密钥。 */
export function describeOpenDesignCredential(credentials: OpenDesignCredentials): string {
    if (isOpenDesignOAuthCredentials(credentials)) {
        return credentials.user?.name?.trim()
            || credentials.user?.email?.trim()
            || credentials.user?.id?.trim()
            || 'OAuth';
    }
    if (credentials.alias?.trim()) return credentials.alias.trim();
    const digest = createHash('sha256').update(credentials.apiKey).digest('hex').slice(0, 6);
    return `API Key #${digest}`;
}

export interface OpenDesignSecretPort {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

/** VS Code SecretStorage 封装：保存已登录或添加进来的 OpenDesign 账号列表。 */
export class OpenDesignCredentialStore {
    constructor(private readonly secrets: OpenDesignSecretPort) {}

    async read(): Promise<OpenDesignCredentials[]> {
        const raw = await this.secrets.get(OPENDESIGN_SECRET_KEY);
        if (!raw) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return [];
        }
        if (Array.isArray(parsed)) {
            return parsed
                .map(entry => parseOpenDesignCredentials(entry))
                .filter((entry): entry is OpenDesignCredentials => entry !== undefined);
        }
        const single = parseOpenDesignCredentials(parsed);
        return single ? [single] : [];
    }

    async add(credentials: OpenDesignCredentials): Promise<void> {
        const key = openDesignCredentialsIdentity(credentials);
        const existing = await this.read();
        const next = existing.filter(entry => openDesignCredentialsIdentity(entry) !== key);
        next.push(credentials);
        await this.secrets.store(OPENDESIGN_SECRET_KEY, JSON.stringify(next));
    }

    async remove(identityKey: string): Promise<void> {
        const existing = await this.read();
        await this.secrets.store(
            OPENDESIGN_SECRET_KEY,
            JSON.stringify(existing.filter(entry => openDesignCredentialsIdentity(entry) !== identityKey)),
        );
    }

    async clear(): Promise<void> {
        await this.secrets.delete(OPENDESIGN_SECRET_KEY);
    }
}
