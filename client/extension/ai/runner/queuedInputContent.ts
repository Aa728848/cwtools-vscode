import type { ChatMessage } from '../types';
import type { AgentQueuedInput } from './inputQueue';

export function queuedInputContent(
    input: AgentQueuedInput,
    prefix: string,
    visionSupported: boolean,
): ChatMessage['content'] {
    const hasImages = !!input.images?.length;
    const unsupportedNotice = hasImages && !visionSupported
        ? '\n[Images were omitted because the active provider/model does not support native image input. Use the supplied pixel metrics only and do not guess visual content.]'
        : '';
    const text = `${prefix}\n${input.message}${unsupportedNotice}`;
    const images = visionSupported ? input.images : undefined;
    return images && images.length > 0
        ? [
            { type: 'text' as const, text },
            ...images.map(url => ({
                type: 'image_url' as const,
                image_url: { url, detail: 'auto' as const },
            })),
        ]
        : text;
}
