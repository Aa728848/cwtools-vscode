/**
 * WorkBuddy 订阅凭据：桌面端扫描、加密存储与续期。
 *
 * 两个来源，**同一套凭据形状**：
 * - **桌面账号**：CodeBuddy 桌面端自己写的 `*.info` 文件。本线路**只读优先**——仍在
 *   有效期内就原样使用；进入续期窗口才轮换，并把新的 `auth` 块**原子写回原文件**，
 *   否则桌面端手里只剩一个已作废的 refresh token 会掉线。
 * - **插件托管账号**：设置页通过官方浏览器授权添加，存进 VS Code SecretStorage。
 *
 * 桌面账号归 IDE 所有：卡片只对托管账号显示「删除」，桌面账号只能在本扩展里隐藏。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isRecord } from '../../../shared/protocolValidation';
import {
    WORKBUDDY_DEFAULT_DOMAIN,
    workBuddyBackendForDomain,
    workBuddyRegionForDomain,
    type WorkBuddyRegion,
} from './types';

/** SecretStorage 里托管账号的键。 */
export const WORKBUDDY_SECRET_KEY = 'cwtools.ai.workbuddy.credentials.v1';
/** 凭据来源。 */
export type WorkBuddyCredentialSource = 'desktop' | 'managed';

export interface WorkBuddyCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    domain: string;
    backend: string;
    region: WorkBuddyRegion;
    uid?: string;
    nickname?: string;
    uin?: string;
    enterpriseId?: string;
    accountType?: string;
    source: WorkBuddyCredentialSource;
    /** 桌面账号的来源文件；托管账号为空串。 */
    sourceFile: string;
    /** 桌面账号来源文件的修改时间，用于判断是否被桌面端更新过。 */
    sourceMtimeMs: number;
}

/** 稳定的账号身份键：优先 uid，其次 uin，最后域 + 昵称。 */
export function workBuddyAccountKey(credentials: Pick<WorkBuddyCredentials, 'uid' | 'uin' | 'nickname' | 'domain'>): string {
    if (credentials.uid) return `uid:${credentials.uid}`;
    if (credentials.uin) return `uin:${credentials.uin}`;
    return `name:${credentials.domain || WORKBUDDY_DEFAULT_DOMAIN}:${credentials.nickname ?? 'unknown'}`;
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

/** 解析一个凭据对象（桌面端 `auth` 块或托管存储），形状不合法时返回 undefined。 */
export function parseWorkBuddyCredentials(
    value: unknown,
    source: WorkBuddyCredentialSource,
    sourceFile = '',
    sourceMtimeMs = 0,
): WorkBuddyCredentials | undefined {
    if (!isRecord(value)) return undefined;
    const auth = isRecord(value.auth) ? value.auth : value;
    const accessToken = asString(auth.accessToken) ?? asString(auth.access_token);
    if (accessToken === undefined) return undefined;
    const domain = asString(auth.domain) ?? WORKBUDDY_DEFAULT_DOMAIN;
    const expiresIn = asNumber(auth.expiresIn) ?? asNumber(auth.expires_in);
    const expiresAt = asNumber(auth.expiresAt) ?? asNumber(auth.expires_at)
        ?? (expiresIn === undefined ? 0 : Date.now() + expiresIn * 1000);
    const account = isRecord(value.account) ? value.account : isRecord(auth.account) ? auth.account : {};
    return {
        accessToken,
        refreshToken: asString(auth.refreshToken) ?? asString(auth.refresh_token) ?? '',
        expiresAt,
        domain,
        backend: workBuddyBackendForDomain(domain),
        region: workBuddyRegionForDomain(domain),
        ...(asString(account.uid) ?? asString(auth.uid) ? { uid: asString(account.uid) ?? asString(auth.uid) } : {}),
        ...(asString(account.nickname) ?? asString(auth.nickname) ? { nickname: asString(account.nickname) ?? asString(auth.nickname) } : {}),
        ...(asString(account.uin) ?? asString(auth.uin) ? { uin: asString(account.uin) ?? asString(auth.uin) } : {}),
        ...(asString(account.enterpriseId) ?? asString(auth.enterpriseId) ? { enterpriseId: asString(account.enterpriseId) ?? asString(auth.enterpriseId) } : {}),
        ...(asString(account.type) ?? asString(auth.accountType) ? { accountType: asString(account.type) ?? asString(auth.accountType) } : {}),
        source,
        sourceFile,
        sourceMtimeMs,
    };
}

/**
 * 桌面端凭据文件的候选位置。
 *
 * 官方 IDE 把凭据写在用户配置目录下的 `*.info` 文件里；不同版本/区域的目录名不同，
 * 因此这里列出候选而不是只猜一个。
 */
export function workBuddyDesktopCredentialFiles(homeDir = os.homedir()): string[] {
    const roots = [
        path.join(homeDir, '.codebuddy'),
        path.join(homeDir, '.workbuddy'),
        path.join(homeDir, 'AppData', 'Roaming', 'CodeBuddy'),
        path.join(homeDir, 'AppData', 'Roaming', 'WorkBuddy'),
        path.join(homeDir, 'Library', 'Application Support', 'CodeBuddy'),
        path.join(homeDir, '.config', 'CodeBuddy'),
    ];
    const files: string[] = [];
    for (const root of roots) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.info')) continue;
            files.push(path.join(root, entry.name));
        }
    }
    return files.sort();
}

/** 扫描桌面端凭据文件；坏文件被跳过而不是让整个扫描失败。 */
export function scanWorkBuddyDesktopCredentials(homeDir = os.homedir()): WorkBuddyCredentials[] {
    const found: WorkBuddyCredentials[] = [];
    for (const file of workBuddyDesktopCredentialFiles(homeDir)) {
        let raw: string;
        let mtimeMs: number;
        try {
            raw = fs.readFileSync(file, 'utf8');
            mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
            continue;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const credentials = parseWorkBuddyCredentials(parsed, 'desktop', file, mtimeMs);
        if (credentials) found.push(credentials);
    }
    return found;
}

/**
 * 只改 `auth` 块地把续期结果原子写回桌面凭据文件。
 *
 * 桌面端的 refresh token 会轮换；若只写进本插件自己的存储，IDE 手里就只剩一个已作废的
 * token 并掉线。写回走临时文件 + rename，失败或中断都让原文件逐字节不变。
 */
export function writeBackWorkBuddyDesktopCredential(credentials: WorkBuddyCredentials): void {
    if (credentials.source !== 'desktop' || !credentials.sourceFile) return;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(credentials.sourceFile, 'utf8')); } catch { return; }
    if (!isRecord(parsed)) return;
    const container = isRecord(parsed.auth) ? parsed : undefined;
    if (!container) return;
    const auth = isRecord(container.auth) ? container.auth : {};
    const next = {
        ...parsed,
        auth: {
            ...auth,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
            domain: credentials.domain,
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

/**
 * 托管账号的持久化端口；由 Extension Host 用 SecretStorage 实现。
 *
 * 方法返回 `Thenable` 而不是 `Promise`：VS Code 的 `SecretStorage` 正是这样声明的，
 * 收窄成 `Promise` 会让真实实现无法传入。
 */
export interface WorkBuddySecretPort {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

export class WorkBuddyCredentialStore {
    constructor(private readonly secrets: WorkBuddySecretPort) {}

    /** 读取全部托管账号；存储损坏时按「没有托管账号」处理。 */
    async readManaged(): Promise<WorkBuddyCredentials[]> {
        const raw = await this.secrets.get(WORKBUDDY_SECRET_KEY);
        if (!raw) return [];
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return []; }
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(entry => parseWorkBuddyCredentials(entry, 'managed'))
            .filter((entry): entry is WorkBuddyCredentials => entry !== undefined);
    }

    /** 按账号身份合并写入：同一账号再次登录是**更新**，不产生幽灵账号。 */
    async addManaged(credentials: WorkBuddyCredentials): Promise<void> {
        const key = workBuddyAccountKey(credentials);
        const existing = await this.readManaged();
        const next = existing.filter(entry => workBuddyAccountKey(entry) !== key);
        next.push({ ...credentials, source: 'managed', sourceFile: '', sourceMtimeMs: 0 });
        await this.secrets.store(WORKBUDDY_SECRET_KEY, JSON.stringify(next));
    }

    async removeManaged(accountKey: string): Promise<void> {
        const existing = await this.readManaged();
        await this.secrets.store(
            WORKBUDDY_SECRET_KEY,
            JSON.stringify(existing.filter(entry => workBuddyAccountKey(entry) !== accountKey)),
        );
    }

    async clear(): Promise<void> {
        await this.secrets.delete(WORKBUDDY_SECRET_KEY);
    }
}

/** 合并桌面扫描与托管账号；同一账号以托管那份为准（它是显式登录的）。 */
export function mergeWorkBuddyAccounts(
    desktop: readonly WorkBuddyCredentials[],
    managed: readonly WorkBuddyCredentials[],
): WorkBuddyCredentials[] {
    const byKey = new Map<string, WorkBuddyCredentials>();
    for (const credentials of desktop) byKey.set(workBuddyAccountKey(credentials), credentials);
    for (const credentials of managed) byKey.set(workBuddyAccountKey(credentials), credentials);
    return [...byKey.values()];
}

/** 一个凭据是否仍在有效期内（留出提前量）。 */
export function isWorkBuddyCredentialFresh(credentials: WorkBuddyCredentials, marginMs = 60_000): boolean {
    if (credentials.expiresAt <= 0) return true;
    return credentials.expiresAt - Date.now() > marginMs;
}

/** 把凭据里的 token 摘要成可安全展示的形态（绝不回显明文）。 */
export function describeWorkBuddyCredential(credentials: WorkBuddyCredentials): string {
    return [credentials.nickname ?? credentials.uid ?? credentials.uin, credentials.region === 'intl' ? '国际区' : '国区']
        .filter(Boolean)
        .join(' · ');
}


