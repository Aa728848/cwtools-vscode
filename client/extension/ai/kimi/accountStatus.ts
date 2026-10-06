/**
 * Kimi Code 订阅会话在设置页上的状态。
 *
 * 只有两种情况需要区分：**已登录**（设备码换来的凭据可用或可续期）与**未登录**。
 * 手动粘贴的 API Key 由通用 API Key 槽位显示，不在这里重复。
 */

import type { KimiCodeTokenStore } from './tokenStore';

export interface KimiCodeAccountStatus {
    /** 是否持有订阅会话（设备码登录的凭据）。 */
    signedIn: boolean;
    /** 凭据存在但已被服务端拒绝续期：需要重新登录。 */
    needsRelogin: boolean;
    /** 失败原因；未登录时为 undefined。 */
    error?: string;
}

/**
 * 读取当前订阅会话状态。
 *
 * 只做本地判断，不发网络请求：设置页会频繁刷新，而「是否登录」不需要问服务端。
 * 令牌是否真的还能用，由真正发起对话时的续期结果决定。
 */
export async function getKimiCodeAccountStatus(store: KimiCodeTokenStore): Promise<KimiCodeAccountStatus> {
    try {
        const credentials = await store.read();
        if (credentials === undefined) return { signedIn: false, needsRelogin: false };
        if (store.isRejected(credentials.refreshToken)) {
            return { signedIn: true, needsRelogin: true };
        }
        return { signedIn: true, needsRelogin: false };
    } catch (error) {
        return {
            signedIn: false,
            needsRelogin: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
