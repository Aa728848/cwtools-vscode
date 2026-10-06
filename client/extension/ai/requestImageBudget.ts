/**
 * 各线路的单次请求图片预算。
 *
 * 三条线路的预算**互不相同**，且都不是「传输层能接受多少」：
 * - **Anthropic 系**（claude-subscription / commandcode-messages）：单请求 8 MB base64，长边
 *   8000 px；一张请求里图片**超过 20 张**时长边进一步收紧到 2000 px。历史会保留每一张图，
 *   所以一个长会话只能加不能减——一旦越过这个界线，后续每一轮都 400 且不可恢复。
 * - **Kimi Code**：整包 2 MB，图片与正文、工具声明共享同一份预算，因此图片额度取更小的
 *   1.5 MB，留出信封空间。
 * - **Antigravity**：12 MB。
 *
 * 超限时**最旧的图片先变成占位文本**，并且占位对模型可见：被静默丢弃的图片比一条说明更难
 * 诊断——模型会在一个「图根本不存在」的对话上作答，现场没有任何线索指向原因。
 *
 * 只作用于**本次请求**：持久历史保持原样，下一轮如果仍然需要这张图它依旧在那里。
 */

import type { ChatMessage, ContentPart } from './types';

/** 一个请求允许携带的 base64 图片总量（按线路）。 */
export const ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024;
/** Kimi Code 的图片额度：整包 2 MB，图片只拿其中 1.5 MB。 */
export const KIMI_MAX_REQUEST_IMAGE_BYTES = 1_500_000;
/** Anthropic 系单请求的图片额度。 */
export const ANTHROPIC_MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024;
/** Anthropic 系图片长边上限。 */
export const ANTHROPIC_MAX_IMAGE_EDGE = 8000;
/** 图片数量越过这个数后，长边上限改用更紧的那个。 */
export const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
/** 图片数量越过阈值后适用的长边上限。 */
export const ANTHROPIC_MANY_IMAGE_EDGE = 2000;

/**
 * 被省略图片的模型可见替换文本。
 *
 * 与 DSH 自身占位文案同一措辞，且明确要求模型「需要时重新读取或请用户重新附上」，而不是
 * 让它以为图片是空白的。
 */
export const OMITTED_IMAGE_TEXT =
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

/** 该 provider 的图片预算；未列出的线路没有图片预算。 */
export function imageBudgetForProvider(providerId: string): number | undefined {
    if (providerId === 'antigravity') return ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES;
    if (providerId === 'kimi-code-plan' || providerId === 'kimi') return KIMI_MAX_REQUEST_IMAGE_BYTES;
    if (providerId === 'claude-subscription' || providerId === 'commandcode-messages' || providerId === 'claude') {
        return ANTHROPIC_MAX_REQUEST_IMAGE_BYTES;
    }
    return undefined;
}

/** 该 provider 的图片长边上限；未列出的线路没有长边限制。 */
export function imageEdgeLimitForProvider(providerId: string, imageCount: number): number | undefined {
    if (providerId !== 'claude-subscription' && providerId !== 'commandcode-messages' && providerId !== 'claude') {
        return undefined;
    }
    return imageCount > ANTHROPIC_MANY_IMAGE_THRESHOLD
        ? ANTHROPIC_MANY_IMAGE_EDGE
        : ANTHROPIC_MAX_IMAGE_EDGE;
}

/**
 * 在请求超过图片预算时，把最旧的图片替换为占位文本。
 *
 * @returns 本来就在预算内时原样返回，否则返回浅拷贝。
 */
export function offloadRequestImages(messages: ChatMessage[], maxBytes: number): ChatMessage[] {
    const lengths: number[] = [];
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            const bytes = imagePartBytes(part);
            if (bytes !== undefined) lengths.push(bytes);
        }
    }
    const excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - maxBytes;
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
            return { type: 'text', text: OMITTED_IMAGE_TEXT };
        });
        return replaced ? { ...message, content } : message;
    });
}

/** 一个请求里的图片张数。 */
export function countRequestImages(messages: ChatMessage[]): number {
    let count = 0;
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (imagePartBytes(part) !== undefined) count += 1;
        }
    }
    return count;
}

/** 一个 data URL 图片的像素长边；无法测量时返回 undefined。 */
export function imageLongEdgeFromDataUrl(url: string): number | undefined {
    const match = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,(.+)$/i.exec(url);
    if (match === null) return undefined;
    const bytes = Buffer.from(match[1]!, 'base64');
    // PNG / GIF 走 IHDR，JPEG 走 SOF 标记；其余格式在这里一律不猜。
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
        return Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) { offset += 1; continue; }
            const marker = bytes[offset + 1]!;
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return bytes.readUInt16BE(offset + 7);
            }
            offset += 2 + bytes.readUInt16BE(offset + 2);
        }
    }
    return undefined;
}
