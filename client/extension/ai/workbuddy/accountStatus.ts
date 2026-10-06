/**
 * WorkBuddy 订阅账号在设置页上的状态。
 *
 * 只做本地汇总（桌面扫描 + 托管存储），不发网络请求：设置页会频繁刷新，而「有哪些
 * 账号」不需要问服务端。账号按区域标注，因为两个区服务的模型清单不同。
 */

import {
    describeWorkBuddyCredential,
    isWorkBuddyCredentialFresh,
    workBuddyAccountKey,
    type WorkBuddyCredentials,
} from './credentials';
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
    /** 凭据是否仍有效；false 表示需要重新登录（或桌面端重新登录）。 */
    fresh: boolean;
}

export interface WorkBuddyAccountStatus {
    accounts: WorkBuddyAccountSummary[];
    /** 是否存在任何可用账号。 */
    available: boolean;
    error?: string;
}

export function summarizeWorkBuddyAccounts(
    accounts: readonly WorkBuddyCredentials[],
    isHidden: (accountKey: string) => boolean,
): WorkBuddyAccountStatus {
    const summaries = accounts.map(credentials => {
        const accountKey = workBuddyAccountKey(credentials);
        return {
            accountKey,
            label: describeWorkBuddyCredential(credentials),
            region: credentials.region,
            source: credentials.source,
            // 桌面账号归 IDE 所有：卡片只能隐藏，绝不删除它的文件。
            removable: credentials.source === 'managed',
            hidden: isHidden(accountKey),
            fresh: isWorkBuddyCredentialFresh(credentials),
        };
    });
    return {
        accounts: summaries,
        available: summaries.some(summary => !summary.hidden && summary.fresh),
    };
}
