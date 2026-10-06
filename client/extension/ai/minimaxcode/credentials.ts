/**
 * MiniMax Code 订阅凭据：桌面端复用、设备码登录与续期。
 *
 * 两种来源，**同一套凭据形状**：
 * - **桌面端登录态**：`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`，由
 *   MiniMax Code 自己写。本线路**只读优先**——仍在有效期（且距到期还有 5 分钟以上）
 *   就原样使用；进入续期窗口才轮换，并**原子替换**（临时文件 + rename），失败或中断都
 *   让原文件保持逐字节不变。**不创建、不删除、不等待 `auth.lock`**：那是桌面端自己的
 *   刷新锁，第二方碰它就可能打断官方客户端的刷新。
 * - **插件托管凭据**：没有桌面凭据时用 RFC 8628 设备码登录，存进 VS Code SecretStorage。
 *
 * 登出只作用于本插件自己那份：桌面端的登录态会被续期写回（只读优先），但**绝不撤销、
 * 绝不删除**——撤销它等于把用户从正在跑的 MiniMax Code 里踢下线。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isRecord } from '../../../shared/protocolValidation';
import { MINIMAX_CODE_REGION_HOSTS, type MinimaxCodeRegion } from './types';

/** SecretStorage 里托管凭据的键。 */
export const MINIMAX_CODE_SECRET_KEY = 'cwtools.ai.minimaxCode.oauth.v1';
/** 凭据来源。 */
export type MinimaxCodeCredentialSource = 'desktop' | 'managed';

export interface MinimaxCodeCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    region: MinimaxCodeRegion;
    source: MinimaxCodeCredentialSource;
    /** 桌面端来源文件；托管凭据为空串。 */
    sourceFile: string;
    /** 桌面端来源文件的记录槽身份（同一槽每次轮换都是同一账号）。 */
    recordKey: string;
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

/** 解析一个凭据对象，形状不合法时返回 undefined。 */
export function parseMinimaxCodeCredentials(
    value: unknown,
    source: MinimaxCodeCredentialSource,
    region: MinimaxCodeRegion,
    sourceFile = '',
    recordKey = '',
): MinimaxCodeCredentials | undefined {
    if (!isRecord(value)) return undefined;
    const auth = isRecord(value.auth) ? value.auth : value;
    const accessToken = asString(auth.accessToken) ?? asString(auth.access_token) ?? asString(auth.token);
    if (accessToken === undefined) return undefined;
    const expiresIn = asNumber(auth.expiresIn) ?? asNumber(auth.expires_in);
    const expiresAt = asNumber(auth.expiresAt) ?? asNumber(auth.expires_at)
        ?? (expiresIn === undefined ? 0 : Date.now() + expiresIn * 1000);
    return {
        accessToken,
        refreshToken: asString(auth.refreshToken) ?? asString(auth.refresh_token) ?? '',
        expiresAt,
        // 读回凭据时**以记录里存的区域为准**，而不是拿默认区域覆盖它。
        region,
        source,
        sourceFile,
        recordKey,
    };
}

/**
 * 桌面端凭据的候选路径。
 *
 * 两个区域都会被探测，因此国际区账号不会因为没有国区文件而「未登录」。
 */
export function minimaxCodeDesktopCredentialPaths(homeDir = os.homedir()): Array<{ region: MinimaxCodeRegion; file: string; recordKey: string }> {
    const buildEnvs = ['prod', 'pre', 'dev'];
    const found: Array<{ region: MinimaxCodeRegion; file: string; recordKey: string }> = [];
    for (const region of ['cn', 'global'] as const) {
        for (const buildEnv of buildEnvs) {
            const recordKey = `${buildEnv}/${region}/mcode-public`;
            found.push({
                region,
                recordKey,
                file: path.join(homeDir, '.minimax', 'auth', buildEnv, region, 'mcode-public', 'auth.json'),
            });
        }
    }
    return found;
}

/** 扫描桌面端凭据；坏文件被跳过而不是让整个扫描失败。 */
export function scanMinimaxCodeDesktopCredentials(homeDir = os.homedir()): MinimaxCodeCredentials[] {
    const found: MinimaxCodeCredentials[] = [];
    for (const candidate of minimaxCodeDesktopCredentialPaths(homeDir)) {
        let raw: string;
        try { raw = fs.readFileSync(candidate.file, 'utf8'); } catch { continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const credentials = parseMinimaxCodeCredentials(parsed, 'desktop', candidate.region, candidate.file, candidate.recordKey);
        if (credentials) found.push(credentials);
    }
    return found;
}

/**
 * 原子地把续期结果写回桌面凭据文件。
 *
 * 走临时文件 + rename：失败或中断都让原文件保持逐字节不变，桌面端不会读到半截 JSON。
 * 只改 auth 块，其它字段原样保留。
 */
export function writeBackMinimaxCodeDesktopCredential(credentials: MinimaxCodeCredentials): void {
    if (credentials.source !== 'desktop' || !credentials.sourceFile) return;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(credentials.sourceFile, 'utf8')); } catch { return; }
    if (!isRecord(parsed)) return;
    const auth = isRecord(parsed.auth) ? parsed.auth : undefined;
    if (!auth) return;
    const next = {
        ...parsed,
        auth: {
            ...auth,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
        },
    };
    const temporary = `${credentials.sourceFile}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, credentials.sourceFile);
    } catch {
        try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    }
}

/** 托管凭据的持久化端口；方法返回 Thenable 以匹配 VS Code 的 SecretStorage。 */
export interface MinimaxCodeSecretPort {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

export class MinimaxCodeCredentialStore {
    constructor(private readonly secrets: MinimaxCodeSecretPort) {}

    async readManaged(): Promise<MinimaxCodeCredentials | undefined> {
        const raw = await this.secrets.get(MINIMAX_CODE_SECRET_KEY);
        if (!raw) return undefined;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return undefined; }
        const region = isRecord(parsed) && (parsed.region === 'global' || parsed.region === 'cn')
            ? parsed.region as MinimaxCodeRegion
            : 'cn';
        return parseMinimaxCodeCredentials(parsed, 'managed', region);
    }

    async save(credentials: MinimaxCodeCredentials): Promise<void> {
        await this.secrets.store(MINIMAX_CODE_SECRET_KEY, JSON.stringify({
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
            region: credentials.region,
        }));
    }

    async clear(): Promise<void> {
        await this.secrets.delete(MINIMAX_CODE_SECRET_KEY);
    }
}

/** 合并桌面与托管凭据：托管的（显式登录的）优先。 */
export function mergeMinimaxCodeCredentials(
    desktop: readonly MinimaxCodeCredentials[],
    managed: MinimaxCodeCredentials | undefined,
): MinimaxCodeCredentials[] {
    if (!managed) return [...desktop];
    // 桌面端同一个记录槽身份只保留一行；托管凭据作为独立来源追加。
    return [...desktop, managed];
}

/**
 * 凭据是否仍在有效期内。
 *
 * 提前量默认 5 分钟：access token 实测只有 1 小时，而「到期前 60 秒」等于每次都在令牌
 * 已经会被拒收的那一瞬间才去轮换。
 */
export function isMinimaxCodeCredentialFresh(credentials: MinimaxCodeCredentials, marginMs = 5 * 60 * 1000): boolean {
    if (credentials.expiresAt <= 0) return true;
    return credentials.expiresAt - Date.now() > marginMs;
}

/** 该凭据对应的 agent 主机。 */
export function minimaxCodeAgentHost(credentials: Pick<MinimaxCodeCredentials, 'region'>): string {
    return MINIMAX_CODE_REGION_HOSTS[credentials.region].agent;
}
