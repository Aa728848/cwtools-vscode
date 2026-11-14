/**
 * WorkBuddy / CodeBuddy 订阅凭据：桌面端扫描（含 `$wbEncrypted` 解封）、加密存储与续期。
 *
 * 两个来源，**同一套凭据形状**：
 * - **桌面账号**：CodeBuddy / WorkBuddy 桌面端自己写的 `*.info` 文件（新版为
 *   `CodeBuddyExtension/Data/Public/auth/*.info`，可能含 `$wbEncrypted` 密文信封）。
 *   扩展端只读优先：明文文件或持有保护密钥且有效时原样使用；需要刷新且写回桌面文件时，
 *   保留原加密信封格式（重新封装 `$wbEncrypted`）或明文格式原子写回。无密钥或解密失败时，
 *   绝不将密文当作令牌发送，也不破坏磁盘原文件。
 * - **插件托管账号**：设置页通过官方浏览器授权添加，存进 VS Code `SecretStorage`。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRecord } from '../../../shared/protocolValidation';
import {
    WB_ATREST_SECRET_KEY,
    WorkBuddyAtRestError,
    activeWorkBuddyAtRestKey,
    deriveWorkBuddyKeyId,
    isWorkBuddySealedValue,
    openWorkBuddySealedField,
    parseWorkBuddyAtRestKeyText,
    sealWorkBuddyValue,
    setActiveWorkBuddyAtRestKey,
    verifyWorkBuddyKeyAgainstKeyBlob,
    type SealedEnvelope,
} from './atrest';
import {
    WORKBUDDY_DEFAULT_DOMAIN,
    workBuddyBackendForDomain,
    workBuddyRegionForDomain,
    type WorkBuddyRegion,
} from './types';
import { withResolvedIdentity } from './identity';

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
    /**
     * 当桌面 `*.info` 持 `$wbEncrypted` 密文信封且尚未解封时临时保留，绝不写入托管存储或外发。
     */
    sealed?: {
        accessToken?: SealedEnvelope;
        refreshToken?: SealedEnvelope;
    };
}

/** 扫描桌面加密凭据的诊断信息（供设置页按需呈现密钥提示，永不含密文或密钥值）。 */
export interface WorkBuddySealedDiagnostics {
    sealedFiles: number;
    opened: number;
    missingKey: boolean;
    lastError: string | null;
}

let lastSealedDiagnostics: WorkBuddySealedDiagnostics = {
    sealedFiles: 0,
    opened: 0,
    missingKey: false,
    lastError: null,
};

/** 返回最近一次桌面凭据扫描中 `$wbEncrypted` 文件的状态摘要。 */
export function workBuddySealedDiagnostics(): WorkBuddySealedDiagnostics {
    return { ...lastSealedDiagnostics };
}

function resetSealedDiagnostics(): void {
    lastSealedDiagnostics = { sealedFiles: 0, opened: 0, missingKey: false, lastError: null };
}

/** 稳定的账号身份键：优先 uid，其次 uin，最后域 + 昵称。 */
export function workBuddyAccountKey(
    credentials: Pick<WorkBuddyCredentials, 'uid' | 'uin' | 'nickname' | 'domain'>,
): string {
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

/**
 * 解析一个凭据对象（桌面端 `auth` 块或托管存储）。
 * 若含 `$wbEncrypted` 字段且当前尚未解封，会暂存在 `sealed` 上由 {@link unsealWorkBuddyCredentials} 解封。
 */
export function parseWorkBuddyCredentials(
    value: unknown,
    source: WorkBuddyCredentialSource,
    sourceFile = '',
    sourceMtimeMs = 0,
): WorkBuddyCredentials | undefined {
    if (!isRecord(value)) return undefined;
    const auth = isRecord(value.auth) ? value.auth : value;
    const rawAccess = auth.accessToken ?? auth.access_token;
    const sealedAccess = isWorkBuddySealedValue(rawAccess) ? rawAccess : undefined;
    const plainAccess = sealedAccess === undefined ? asString(rawAccess) : undefined;
    if (sealedAccess === undefined && plainAccess === undefined) return undefined;

    const rawRefresh = auth.refreshToken ?? auth.refresh_token;
    const sealedRefresh = isWorkBuddySealedValue(rawRefresh) ? rawRefresh : undefined;
    const plainRefresh = sealedRefresh === undefined ? (asString(rawRefresh) ?? '') : '';

    const domain = asString(auth.domain) ?? WORKBUDDY_DEFAULT_DOMAIN;
    const expiresIn = asNumber(auth.expiresIn) ?? asNumber(auth.expires_in);
    const expiresAt = asNumber(auth.expiresAt) ?? asNumber(auth.expires_at)
        ?? (expiresIn === undefined ? 0 : Date.now() + expiresIn * 1000);
    const account = isRecord(value.account) ? value.account : isRecord(auth.account) ? auth.account : {};

    const resolved = withResolvedIdentity({
        accessToken: plainAccess ?? '',
        refreshToken: plainRefresh,
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
        ...(sealedAccess !== undefined || sealedRefresh !== undefined
            ? {
                sealed: {
                    ...(sealedAccess ? { accessToken: sealedAccess } : {}),
                    ...(sealedRefresh ? { refreshToken: sealedRefresh } : {}),
                },
            }
            : {}),
    });
    return resolved;
}

/**
 * 将带 `sealed` 的凭据用进程内保护密钥解封成可直接发送的明文凭据；
 * 若无密钥、解封失败或解密结果为空串，返回 `null`（同时更新诊断摘要）。
 */
export function unsealWorkBuddyCredentials(credentials: WorkBuddyCredentials): WorkBuddyCredentials | null {
    if (!credentials.sealed) {
        return credentials.accessToken.trim() === '' ? null : credentials;
    }
    lastSealedDiagnostics.sealedFiles += 1;
    const key = activeWorkBuddyAtRestKey();
    if (key === null) {
        lastSealedDiagnostics.missingKey = true;
        return null;
    }
    try {
        const accessToken = credentials.sealed.accessToken !== undefined
            ? openWorkBuddySealedField(key, credentials.sealed.accessToken)
            : credentials.accessToken;
        if (accessToken.trim() === '') {
            throw new WorkBuddyAtRestError('解封得到的 accessToken 为空。');
        }
        const refreshToken = credentials.sealed.refreshToken !== undefined
            ? openWorkBuddySealedField(key, credentials.sealed.refreshToken)
            : credentials.refreshToken;
        lastSealedDiagnostics.opened += 1;
        const { sealed: _discard, ...plain } = credentials;
        return withResolvedIdentity({
            ...plain,
            accessToken: accessToken.trim(),
            refreshToken: refreshToken.trim(),
        });
    } catch (error) {
        lastSealedDiagnostics.lastError = error instanceof Error ? error.message : String(error);
        return null;
    }
}

/** 返回官方桌面端新版 auth 目录（支持 `CODEBUDDY_AUTH_DIR` 测试覆盖）。 */
export function workBuddyExtensionAuthDir(homeDir = os.homedir()): string {
    const override = process.env.CODEBUDDY_AUTH_DIR?.trim();
    if (override) return override;
    if (process.platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
    }
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local');
        return path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
    }
    const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share');
    return path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

function isCanonicalInfoFile(name: string): boolean {
    return /^(workbuddy|codebuddy)-desktop(-\w+)?\.info$/i.test(name);
}

/**
 * 列出官方桌面客户端 `*.info` 凭据文件（新版优先排序）。
 */
export function workBuddyDesktopCredentialFiles(homeDir = os.homedir()): string[] {
    const roots = [
        workBuddyExtensionAuthDir(homeDir),
        path.join(homeDir, '.codebuddy'),
        path.join(homeDir, '.workbuddy'),
        path.join(homeDir, 'AppData', 'Roaming', 'CodeBuddy'),
        path.join(homeDir, 'AppData', 'Roaming', 'WorkBuddy'),
        path.join(homeDir, 'Library', 'Application Support', 'CodeBuddy'),
        path.join(homeDir, '.config', 'CodeBuddy'),
    ];
    const seen = new Set<string>();
    const files: string[] = [];
    for (const root of [...new Set(roots)]) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.info')) continue;
            const fullPath = path.join(root, entry.name);
            const canonicalKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
            if (seen.has(canonicalKey)) continue;
            seen.add(canonicalKey);
            files.push(fullPath);
        }
    }
    return files.sort();
}

/**
 * 扫描桌面端 `*.info` 凭据文件；跳过损坏或无法解封的密文文件并更新 {@link workBuddySealedDiagnostics}。
 */
export function scanWorkBuddyDesktopCredentials(homeDir = os.homedir()): WorkBuddyCredentials[] {
    resetSealedDiagnostics();
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
        const parsedCreds = parseWorkBuddyCredentials(parsed, 'desktop', file, mtimeMs);
        if (!parsedCreds) continue;
        const usable = unsealWorkBuddyCredentials(parsedCreds);
        if (usable) found.push(usable);
    }
    return found.sort((a, b) => {
        const aCanonical = isCanonicalInfoFile(path.basename(a.sourceFile)) ? 1 : 0;
        const bCanonical = isCanonicalInfoFile(path.basename(b.sourceFile)) ? 1 : 0;
        if (aCanonical !== bCanonical) return bCanonical - aCanonical;
        return b.expiresAt - a.expiresAt;
    });
}

/**
 * 重新读取单个桌面端凭据文件；文件失效或当前密钥无法解封时返回 `undefined`。
 */
export function readWorkBuddyDesktopFile(filePath: string): WorkBuddyCredentials | undefined {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) return undefined;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        const creds = parseWorkBuddyCredentials(parsed, 'desktop', filePath, stats.mtimeMs);
        if (!creds) return undefined;
        return unsealWorkBuddyCredentials(creds) ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * 只改 `auth` 块地把续期结果原子写回桌面凭据文件。
 *
 * 如果原文件使用 `$wbEncrypted` 加密封装：
 * - 若当前进程持有可用的保护密钥，则以相同的 AES-256-GCM 字段封包格式重密封写回；
 * - 若未持有密钥（例如未解锁状态），则安全跳过，绝不降级成明文覆写或损坏密文原文件。
 */
export function writeBackWorkBuddyDesktopCredential(credentials: WorkBuddyCredentials): void {
    if (credentials.source !== 'desktop' || !credentials.sourceFile) return;
    if (!credentials.accessToken || credentials.accessToken.trim() === '') return;
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(credentials.sourceFile, 'utf8')); } catch { return; }
    if (!isRecord(parsed) || !isRecord(parsed.auth)) return;

    const auth = parsed.auth;
    const isSealedFile = isWorkBuddySealedValue(auth.accessToken) || isWorkBuddySealedValue(auth.refreshToken);
    let nextAccess: unknown = credentials.accessToken;
    let nextRefresh: unknown = credentials.refreshToken;
    if (isSealedFile) {
        const key = activeWorkBuddyAtRestKey();
        if (key === null) return;
        nextAccess = sealWorkBuddyValue(key, credentials.accessToken, 'field');
        if (credentials.refreshToken !== '') {
            nextRefresh = sealWorkBuddyValue(key, credentials.refreshToken, 'field');
        }
    }

    const next = {
        ...parsed,
        auth: {
            ...auth,
            accessToken: nextAccess,
            ...(credentials.refreshToken !== '' ? { refreshToken: nextRefresh } : {}),
            expiresAt: credentials.expiresAt,
            domain: credentials.domain,
            lastRefreshTime: Date.now(),
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
 * 托管账号与保护密钥的持久化端口；由 Extension Host 用 VS Code `SecretStorage` 实现。
 */
export interface WorkBuddySecretPort {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

/**
 * WorkBuddy SecretStorage 托管凭据与 `$wbEncrypted` 保护密钥仓库。
 */
export class WorkBuddyCredentialStore {
    constructor(private readonly secrets: WorkBuddySecretPort) {}

    /** 读取全部托管账号；存储损坏时按空列表处理，不让设置页崩溃。 */
    async readManaged(): Promise<WorkBuddyCredentials[]> {
        const raw = await this.secrets.get(WORKBUDDY_SECRET_KEY);
        if (!raw) return [];
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { return []; }
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(entry => parseWorkBuddyCredentials(entry, 'managed'))
            .filter((entry): entry is WorkBuddyCredentials => entry !== undefined && entry.accessToken !== '');
    }

    /** 按账号身份合并写入：同一账号再次登录是更新，不产生重复行。 */
    async addManaged(credentials: WorkBuddyCredentials): Promise<void> {
        const key = workBuddyAccountKey(credentials);
        const existing = await this.readManaged();
        const next = existing.filter(entry => workBuddyAccountKey(entry) !== key);
        const { sealed: _discard, ...plain } = credentials;
        next.push({ ...plain, source: 'managed', sourceFile: '', sourceMtimeMs: 0 });
        await this.secrets.store(WORKBUDDY_SECRET_KEY, JSON.stringify(next));
    }

    /** 从托管存储删除一个账号。 */
    async removeManaged(accountKey: string): Promise<boolean> {
        const existing = await this.readManaged();
        const next = existing.filter(entry => workBuddyAccountKey(entry) !== accountKey);
        if (next.length === existing.length) return false;
        if (next.length === 0) await this.secrets.delete(WORKBUDDY_SECRET_KEY);
        else await this.secrets.store(WORKBUDDY_SECRET_KEY, JSON.stringify(next));
        return true;
    }

    /** 从 SecretStorage 读取并安装 `$wbEncrypted` 保护密钥到当前进程。 */
    async loadAtRestKey(): Promise<boolean> {
        const hex = (await this.secrets.get(WB_ATREST_SECRET_KEY))?.trim() ?? '';
        if (!/^[0-9a-f]{64}$/i.test(hex)) {
            setActiveWorkBuddyAtRestKey(null);
            return false;
        }
        setActiveWorkBuddyAtRestKey(Buffer.from(hex, 'hex'));
        return true;
    }

    /** 校验并持久化用户粘贴的 `$wbEncrypted` 保护密钥，返回展示用的 16 位十六进制 keyId。 */
    async adoptAtRestKey(keyText: string, keyBlobCandidates?: readonly string[]): Promise<string> {
        const key = parseWorkBuddyAtRestKeyText(keyText);
        await verifyWorkBuddyKeyAgainstKeyBlob(key, keyBlobCandidates);
        await this.secrets.store(WB_ATREST_SECRET_KEY, key.toString('hex'));
        setActiveWorkBuddyAtRestKey(key);
        return deriveWorkBuddyKeyId(key);
    }

    /** 清除已保存的 `$wbEncrypted` 保护密钥（同时清空进程内存密钥）。 */
    async clearAtRestKey(): Promise<void> {
        setActiveWorkBuddyAtRestKey(null);
        await this.secrets.delete(WB_ATREST_SECRET_KEY);
    }

    /** 当前进程或 SecretStorage 是否持有可用的 `$wbEncrypted` 解封密钥。 */
    async hasAtRestKey(): Promise<boolean> {
        if (activeWorkBuddyAtRestKey() !== null) return true;
        return this.loadAtRestKey();
    }

    /** 返回当前密钥摘要 keyId（永不返回密钥原文）。 */
    currentAtRestKeyId(): string | null {
        const key = activeWorkBuddyAtRestKey();
        return key ? deriveWorkBuddyKeyId(key) : null;
    }
}

/** 凭据是否仍在有效期内（距离过期至少留有 marginMs 缓冲）。 */
export function isWorkBuddyCredentialFresh(credentials: WorkBuddyCredentials, marginMs = 60_000): boolean {
    if (!credentials.accessToken || credentials.accessToken.trim() === '') return false;
    if (!Number.isFinite(credentials.expiresAt) || credentials.expiresAt <= 0) return true;
    return credentials.expiresAt - Date.now() > marginMs;
}

/** 生成用于 UI 与日志的安全账号标签（绝不含访问令牌与密钥原文）。 */
export function describeWorkBuddyCredential(credentials: WorkBuddyCredentials): string {
    return [credentials.nickname ?? credentials.uid ?? credentials.uin, credentials.region === 'intl' ? '国际区' : '国区']
        .filter(Boolean)
        .join(' · ');
}
