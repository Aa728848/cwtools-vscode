/**
 * Anthropic 系线路的图片几何限制。
 *
 * 单请求的图片长边有上限，**一张请求里图片超过阈值后上限还会进一步收紧**。这两条合起来
 * 很要命：历史会保留每一张图，所以长会话只能加图不能减图；一旦越过收紧后的界线，
 * 之后每一轮都是 400，而且没有任何本地补救能救回来——除非当场把那张图换掉。
 *
 * 本模块**测量**而不缩放：DSH 没有可用的图片重采样路径，所以超限时按同一条规则把图片换成
 * 对模型可见的占位文本，而不是发出一张原样的大图去换一个确定的 400。
 */

import type { ChatMessage, ContentPart } from './types';
import {
    ANTHROPIC_MANY_IMAGE_EDGE,
    ANTHROPIC_MANY_IMAGE_THRESHOLD,
    ANTHROPIC_MAX_IMAGE_EDGE,
    imageLongEdgeFromDataUrl,
    OMITTED_IMAGE_TEXT,
} from './requestImageBudget';

/** 某个 provider 的图片长边上限；未列出的线路没有长边限制。 */
export function requestImageEdgeLimit(providerId: string, imageCount: number): number | undefined {
    if (providerId !== 'claude-subscription' && providerId !== 'commandcode-messages' && providerId !== 'claude') {
        return undefined;
    }
    return imageCount > ANTHROPIC_MANY_IMAGE_THRESHOLD
        ? ANTHROPIC_MANY_IMAGE_EDGE
        : ANTHROPIC_MAX_IMAGE_EDGE;
}

function imagePartLongEdge(part: ContentPart): number | undefined {
    if (part.type !== 'image_url') return undefined;
    return imageLongEdgeFromDataUrl(part.image_url.url);
}

/**
 * 把超过长边上限的图片替换为占位文本。
 *
 * 无法测量尺寸的格式（WebP 变体、远端 URL）**保持原样**：猜测一个尺寸去换掉一张其实合法的
 * 图片，比不做这件事更糟。
 *
 * @returns 没有超限时原样返回。
 */
export function enforceRequestImageEdge(messages: ChatMessage[], providerId: string): ChatMessage[] {
    let imageCount = 0;
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (imagePartLongEdge(part) !== undefined) imageCount += 1;
        }
    }
    const limit = requestImageEdgeLimit(providerId, imageCount);
    if (limit === undefined) return messages;
    let changed = false;
    const next = messages.map(message => {
        if (!Array.isArray(message.content)) return message;
        let replaced = false;
        const content = message.content.map((part): ContentPart => {
            const edge = imagePartLongEdge(part);
            if (edge === undefined || edge <= limit) return part;
            replaced = true;
            return { type: 'text', text: OMITTED_IMAGE_TEXT };
        });
        if (!replaced) return message;
        changed = true;
        return { ...message, content };
    });
    return changed ? next : messages;
}
