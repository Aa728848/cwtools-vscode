/**
 * Antigravity 单次请求的图片体积预算。
 *
 * Google 对带 inline data 的请求有约 20 MB 的上限，而同一个请求体里还要放
 * 系统指令、对话文本与工具声明。没有这个上限时，图片密集的会话会把请求体一路
 * 撑到被 Google 拒收，而让它失败的那几张图恰好是模型最不需要的。
 *
 * 超限时**最旧的图片先被替换为占位文本**，并且这条占位对模型可见——被静默丢弃
 * 的图片比一条说明更难诊断（模型会在一个「图根本不存在」的对话上作答，现场没有
 * 任何线索指向原因）。
 */

import type { ChatMessage, ContentPart } from '../types';

/** 一个 Antigravity 请求允许携带的 base64 图片总量。 */
export const ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * 被省略图片的模型可见替换文本。
 *
 * 与 DSH 自身占位文案同一措辞，且明确要求模型「需要时重新读取或请用户重新附上」，
 * 而不是让它以为图片是空白的。
 */
export const ANTIGRAVITY_OMITTED_IMAGE_TEXT =
    '[image omitted to keep the request within its image limit; older images are omitted first. '
    + 'If this image is still needed, read its file again when a path is available; '
    + 'otherwise ask the user to attach it again.]';

/** 原始图片字节对应的 base64 长度（含 padding）。 */
function base64Length(bytes: number): number {
    return Math.ceil(bytes / 3) * 4;
}

/** 一个图片块在请求里占用的 base64 长度；无法测量时返回 undefined。 */
function imagePartBytes(part: ContentPart): number | undefined {
    if (part.type !== 'image_url') return undefined;
    const match = /^data:[^;,]+;base64,(.+)$/i.exec(part.image_url.url);
    return match ? match[1]!.length : undefined;
}

/**
 * 在请求超过图片预算时，把最旧的图片替换为占位文本。
 *
 * 只作用于**本次请求**：持久历史保持原样，所以下一轮如果仍然需要这张图，它依旧
 * 在那里（只是这一轮可能又被省略）。
 *
 * @returns 本来就在预算内时原样返回，否则返回浅拷贝。
 */
export function offloadAntigravityRequestImages(messages: ChatMessage[]): ChatMessage[] {
    const lengths: number[] = [];
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            const bytes = imagePartBytes(part);
            if (bytes !== undefined) lengths.push(bytes);
        }
    }
    const excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES;
    if (excess <= 0) return messages;

    let omitted = 0;
    let freed = 0;
    for (const bytes of lengths) {
        if (freed >= excess) break;
        freed += bytes;
        omitted += 1;
    }

    let remaining = omitted;
    return messages.map(message => {
        if (remaining === 0 || !Array.isArray(message.content)) return message;
        let replaced = false;
        const content = message.content.map((part): ContentPart => {
            if (remaining === 0 || imagePartBytes(part) === undefined) return part;
            remaining -= 1;
            replaced = true;
            return { type: 'text', text: ANTIGRAVITY_OMITTED_IMAGE_TEXT };
        });
        return replaced ? { ...message, content } : message;
    });
}
