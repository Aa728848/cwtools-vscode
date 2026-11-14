/**
 * WorkBuddy 订阅账号及 `$wbEncrypted` 保护密钥、国区签到在设置页上的只读状态摘要。
 *
 * 绝不向 Webview 传回任何明文 accessToken、refreshToken 或 AES-GCM 密钥文本。
 */

import {
    describeWorkBuddyCredential,
    isWorkBuddyCredentialFresh,
    workBuddyAccountKey,
    workBuddySealedDiagnostics,
    type WorkBuddyCredentials,
} from './credentials';
import type { WorkBuddyCheckinSummary } from './checkinService';
import type { WorkBuddyRegion } from './types';

export interface WorkBuddyAccountSummary {
    /** 稳定身份键；卡片据此隐藏/恢复桌面账号。 */
    accountKey: string;
    label: string;
    region: WorkBuddyRegion;
    source: 'desktop' | 'managed';
    /** 桌面账号不可删除，只能在本扩展中隐藏。 */
    removable: boolean;
    hidden: boolean;
    /** 凭据是否仍在有效期内；false 表示需要重新登录（或刷新桌面端会话）。 */
    fresh: boolean;
}

export interface WorkBuddyAccountStatus {
    accounts: WorkBuddyAccountSummary[];
    /** 是否存在任何未隐藏且仍可用的账号。 */
    available: boolean;
    /** 本次扫描遇到的桌面 `$wbEncrypted` 密文 `.info` 文件总数。 */
    encryptedDesktopCount: number;
    /** 其中已被当前保护密钥成功解封的文件数。 */
    openedEncryptedCount: number;
    /** 存在桌面 `$wbEncrypted` 文件且尚未配置密钥时为 true。 */
    missingAtRestKey: boolean;
    /** 当前进程或 SecretStorage 是否持有可用的 `$wbEncrypted` 解封密钥。 */
    hasAtRestKey: boolean;
    /** 当前保护密钥的 16 位十六进制指纹（永不暴露密钥本体）。 */
    atRestKeyId: string | null;
    /** 最近一次解封错误（例如密钥编号不匹配）。 */
    lastAtRestError?: string;
    /** 国区每日签到汇总状态。 */
    checkin?: WorkBuddyCheckinSummary;
    error?: string;
}

export interface WorkBuddyStatusExtras {
    hasAtRestKey?: boolean;
    atRestKeyId?: string | null;
    checkin?: WorkBuddyCheckinSummary;
    error?: string;
}

/** 汇总所有已发现的 WorkBuddy 账号、桌面解密状态及国区签到状态。 */
export function summarizeWorkBuddyAccounts(
    accounts: readonly WorkBuddyCredentials[],
    isHidden: (accountKey: string) => boolean,
    extras: WorkBuddyStatusExtras = {},
): WorkBuddyAccountStatus {
    const sealed = workBuddySealedDiagnostics();
    const summaries: WorkBuddyAccountSummary[] = accounts.map(credentials => {
        const accountKey = workBuddyAccountKey(credentials);
        return {
            accountKey,
            label: describeWorkBuddyCredential(credentials),
            region: credentials.region,
            source: credentials.source,
            removable: credentials.source === 'managed',
            hidden: isHidden(accountKey),
            fresh: isWorkBuddyCredentialFresh(credentials),
        };
    });

    return {
        accounts: summaries,
        available: summaries.some(summary => !summary.hidden && summary.fresh),
        encryptedDesktopCount: sealed.sealedFiles,
        openedEncryptedCount: sealed.opened,
        missingAtRestKey: sealed.missingKey,
        hasAtRestKey: extras.hasAtRestKey ?? false,
        atRestKeyId: extras.atRestKeyId ?? null,
        ...(sealed.lastError ? { lastAtRestError: sealed.lastError } : {}),
        ...(extras.checkin ? { checkin: extras.checkin } : {}),
        ...(extras.error ? { error: extras.error } : {}),
    };
}
