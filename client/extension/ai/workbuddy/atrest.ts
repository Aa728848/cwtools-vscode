/**
 * WorkBuddy / CodeBuddy 桌面端 `$wbEncrypted` 磁盘密文凭据解封器。
 *
 * 自 2026-09-24 起桌面端不再明文存放 `accessToken` 与 `refreshToken`，改用 AES-256-GCM
 * 封装格式 `{ "$wbEncrypted": { scheme: "sym-v1", suite: 1, keyId, nonce, ciphertext, tag } }`。
 * 本模块负责：
 * - 解析用户提供的保护密钥（64 位 Hex 或 44 位 Base64 `^[A-Za-z0-9+/]{43}=$` 对其 ASCII 文本做 SHA-256）；
 * - 按官方端一致的 `WB-AAD\0` 协议组帧相关联认证数据（AAD）并解封密文字段；
 * - 若桌面端目录下存在 `.wb-key` 校验块，保存前优先验证密钥 `keyId` 及密文一致性，防止输错掩盖有效密钥。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRecord } from '../../../shared/protocolValidation';

export const WB_ATREST_SECRET_KEY = 'cwtools.ai.workbuddy.atrestKey.v1';

const ENVELOPE_KEY = '$wbEncrypted';
const SCHEME = 'sym-v1';
const DEFAULT_SUITE = 1;
const FORMAT_VERSION = 1;
const FLAG_PLAINTEXT_UTF8 = 0x00;

interface Framing {
    readonly magic: string;
    readonly code: number;
}

const FRAMING: Record<'file' | 'field', Framing> = {
    file: { magic: 'WBEF1', code: 1 },
    field: { magic: 'WBEV1', code: 2 },
};

/**
 * 表示凭据密封态或保护密钥校验失败；保留静态提示文案而不泄露密文内容。
 */
export class WorkBuddyAtRestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkBuddyAtRestError';
    }
}

export interface SealedPayload {
    scheme: typeof SCHEME;
    suite: number;
    keyId: string;
    nonce: string;
    ciphertext: string;
    tag: string;
}

export type SealedEnvelope = {
    [ENVELOPE_KEY]: SealedPayload;
};

let processAtRestKey: Buffer | null = null;

/** 返回当前进程持有的 32 字节 `$wbEncrypted` 保护密钥副本。 */
export function activeWorkBuddyAtRestKey(): Buffer | null {
    return processAtRestKey === null ? null : Buffer.from(processAtRestKey);
}

/** 安装或清空当前进程持有的 32 字节保护密钥（仅内存保留）。 */
export function setActiveWorkBuddyAtRestKey(key: Buffer | null): void {
    if (key === null) {
        processAtRestKey = null;
        return;
    }
    if (key.length !== 32) {
        throw new WorkBuddyAtRestError(`保护密钥长度必须为 32 字节（收到 ${key.length} 字节）。`);
    }
    processAtRestKey = Buffer.from(key);
}

/** 对 32 字节原始密钥计算官方一致的 16 位十六进制 keyId。 */
export function deriveWorkBuddyKeyId(key: Buffer): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 解析用户粘贴的保护密钥文本（兼容 64 位 Hex 或 44 位 Base64）。
 *
 * 说明：256 位随机密钥经 64-hex 直接解码成 32 字节；而桌面客户端导出的 44 位 Base64
 * （43 个 Base64 字符 + 1 个 `=`）则与其约定一致，先对其 ASCII 文本做 SHA-256 映射到 32 字节。
 */
export function parseWorkBuddyAtRestKeyText(text: string): Buffer {
    const trimmed = text.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }
    if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
        return createHash('sha256').update(trimmed, 'utf8').digest();
    }
    throw new WorkBuddyAtRestError(
        '密钥格式无效：请输入 64 位十六进制密钥，或 44 位以 "=" 结尾的 Base64 密钥。',
    );
}

/** 构造 AES-GCM 使用的长度前缀（length-prefixed）片段。 */
function lp(value: string): Buffer {
    const bytes = Buffer.from(value, 'utf8');
    const len = Buffer.allocUnsafe(2);
    len.writeUInt16BE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
}

function u32BE(value: number): Buffer {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32BE(value, 0);
    return buf;
}

/** 组帧 `$wbEncrypted` 规范的 AES-256-GCM AAD（与桌面客户端逐字节一致）。 */
function associatedData(framing: Framing, suite: number, keyId: string): Buffer {
    return Buffer.concat([
        Buffer.from('WB-AAD\0', 'ascii'),
        Buffer.from([FORMAT_VERSION]),
        lp(framing.magic),
        lp(SCHEME),
        u32BE(suite),
        lp(keyId),
        Buffer.from([framing.code, FLAG_PLAINTEXT_UTF8, 0x00]),
    ]);
}

/** 判断未知 JSON 字段是否为合法的 `$wbEncrypted` 信封对象。 */
export function isWorkBuddySealedValue(value: unknown): value is SealedEnvelope {
    if (!isRecord(value)) return false;
    const inner = value[ENVELOPE_KEY];
    if (!isRecord(inner)) return false;
    return inner.scheme === SCHEME
        && typeof inner.suite === 'number'
        && Number.isInteger(inner.suite)
        && typeof inner.keyId === 'string'
        && typeof inner.nonce === 'string'
        && typeof inner.ciphertext === 'string'
        && typeof inner.tag === 'string';
}

function decodeBase64(field: string, encoded: string, expectedBytes?: number): Buffer {
    const trimmed = encoded.trim();
    const out = Buffer.from(trimmed, 'base64');
    if (out.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
        throw new WorkBuddyAtRestError(`信封字段 ${field} 不是合法 Base64 编码。`);
    }
    if (expectedBytes !== undefined && out.length !== expectedBytes) {
        throw new WorkBuddyAtRestError(`信封字段 ${field} 长度为 ${out.length} 字节，预期 ${expectedBytes} 字节。`);
    }
    return out;
}

function openEnvelope(key: Buffer, envelope: SealedEnvelope, framing: Framing): string {
    const inner = envelope[ENVELOPE_KEY];
    const expectedKeyId = deriveWorkBuddyKeyId(key);
    if (inner.keyId !== expectedKeyId) {
        throw new WorkBuddyAtRestError(
            `密钥编号不匹配：信封需要 ${inner.keyId}，当前持有 ${expectedKeyId}。`,
        );
    }
    if (inner.suite !== DEFAULT_SUITE) {
        throw new WorkBuddyAtRestError(`不支持的加密套件版本 ${inner.suite}。`);
    }
    const nonce = decodeBase64('nonce', inner.nonce, 12);
    const ciphertext = decodeBase64('ciphertext', inner.ciphertext);
    const tag = decodeBase64('tag', inner.tag, 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associatedData(framing, inner.suite, inner.keyId));
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw new WorkBuddyAtRestError('AES-256-GCM 密文认证失败（密钥错误或文件已损坏）。');
    }
}

/** 解封单个字段级别 `$wbEncrypted` 信封；若传入普通字符串则原样返回。 */
export function openWorkBuddySealedField(key: Buffer, value: unknown): string {
    if (typeof value === 'string') return value;
    if (!isWorkBuddySealedValue(value)) {
        throw new WorkBuddyAtRestError('字段既不是明文字符串，也不是有效的 $wbEncrypted 信封。');
    }
    return openEnvelope(key, value, FRAMING.field);
}

/** 解封完整文件级 `$wbEncrypted` 信封（如 `.wb-key` 等校验文档）。 */
export function openWorkBuddySealedFile(key: Buffer, value: unknown): string {
    if (!isWorkBuddySealedValue(value)) {
        throw new WorkBuddyAtRestError('校验文档不是有效的 $wbEncrypted 文件信封。');
    }
    return openEnvelope(key, value, FRAMING.file);
}

/** 构造加密信封（供单元测试或内部封装使用）。 */
export function sealWorkBuddyValue(
    key: Buffer,
    plaintext: string,
    kind: 'file' | 'field' = 'field',
): SealedEnvelope {
    if (key.length !== 32) {
        throw new WorkBuddyAtRestError(`保护密钥长度必须为 32 字节（收到 ${key.length} 字节）。`);
    }
    const framing = FRAMING[kind];
    const keyId = deriveWorkBuddyKeyId(key);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associatedData(framing, DEFAULT_SUITE, keyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        [ENVELOPE_KEY]: {
            scheme: SCHEME,
            suite: DEFAULT_SUITE,
            keyId,
            nonce: nonce.toString('base64'),
            ciphertext: ciphertext.toString('base64'),
            tag: tag.toString('base64'),
        },
    };
}

/** 计算可能的桌面客户端 `.wb-key` 校验文档候选路径。 */
export function workBuddyKeyBlobCandidates(): string[] {
    const out: string[] = [];
    const envDir = process.env.CODEBUDDY_AUTH_DIR?.trim();
    if (envDir) out.push(path.join(envDir, '.wb-key'));
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA?.trim()
            || (process.env.USERPROFILE?.trim() ? path.join(process.env.USERPROFILE.trim(), 'AppData', 'Local') : '');
        const appData = process.env.APPDATA?.trim();
        if (local) {
            out.push(path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth', '.wb-key'));
        }
        if (appData) {
            out.push(
                path.join(appData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', '.wb-key'),
                path.join(appData, 'CodeBuddy', '.wb-key'),
                path.join(appData, 'WorkBuddy', '.wb-key'),
            );
        }
    } else if (process.platform === 'darwin') {
        const home = process.env.HOME?.trim();
        if (home) {
            out.push(
                path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', '.wb-key'),
                path.join(home, 'Library', 'Application Support', 'CodeBuddy', '.wb-key'),
            );
        }
    } else {
        const home = process.env.HOME?.trim();
        const xdg = process.env.XDG_DATA_HOME?.trim() || (home ? path.join(home, '.local', 'share') : '');
        if (xdg) {
            out.push(path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth', '.wb-key'));
        }
    }
    return [...new Set(out)];
}

/**
 * 若本地存在桌面端 `.wb-key` 文件，用其校验待采纳的保护密钥，防止输入错误覆盖可用状态。
 * 若本地不存在 `.wb-key`，按无校验跳过。
 */
export async function verifyWorkBuddyKeyAgainstKeyBlob(
    key: Buffer,
    candidates: readonly string[] = workBuddyKeyBlobCandidates(),
): Promise<void> {
    for (const file of candidates) {
        let raw: string;
        try {
            raw = await fs.readFile(file, 'utf8');
        } catch {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch {
            continue;
        }
        if (isWorkBuddySealedValue(parsed)) {
            openWorkBuddySealedFile(key, parsed);
            return;
        }
        if (isRecord(parsed) && typeof parsed.keyId === 'string' && parsed.keyId.trim() !== '') {
            const actual = deriveWorkBuddyKeyId(key);
            if (parsed.keyId.trim() !== actual) {
                throw new WorkBuddyAtRestError(
                    `密钥编号不匹配：本地桌面配置需要 ${parsed.keyId.trim()}，输入密钥计算为 ${actual}。`,
                );
            }
            return;
        }
    }
}
