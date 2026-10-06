/**
 * Antigravity 单次请求的图片体积预算。
 *
 * 实现与其余线路共用（见 `requestImageBudget.ts`）：三条线路的预算不同，但「超限时把最旧的
 * 图片换成对模型可见的占位文本」是同一条规则，写三遍只会各自漂移。
 */

export {
    ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES,
    OMITTED_IMAGE_TEXT as ANTIGRAVITY_OMITTED_IMAGE_TEXT,
    offloadRequestImages,
} from '../requestImageBudget';
import { ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES, offloadRequestImages } from '../requestImageBudget';
import type { ChatMessage } from '../types';

/**
 * 在请求超过图片预算时，把最旧的图片替换为占位文本。
 *
 * @returns 本来就在预算内时原样返回，否则返回浅拷贝。
 */
export function offloadAntigravityRequestImages(messages: ChatMessage[]): ChatMessage[] {
    return offloadRequestImages(messages, ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES);
}
