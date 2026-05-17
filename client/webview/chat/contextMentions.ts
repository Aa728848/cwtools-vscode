import { Icons } from '../svgIcons';

export type ActiveContextType =
    | 'code_selection'
    | 'diagnostics'
    | 'file'
    | 'folder'
    | 'scope'
    | 'symbol'
    | 'vanilla'
    | 'blackboard';

export interface ActiveContext {
    id: string;
    type: ActiveContextType;
    label: string;
    description?: string;
    uri?: string;
    startLine?: number;
    endLine?: number;
    line?: number;
    column?: number;
    name?: string;
    kind?: string;
    vanillaType?: string;
    vanillaId?: string;
    key?: string;
    tokenEstimate?: number;
    cacheStatus?: 'live' | 'disk' | 'cached' | 'large' | 'missing' | 'external' | 'unknown';
}

export interface MentionResult {
    type?: ActiveContextType;
    uri?: string;
    label: string;
    desc: string;
    startLine?: number;
    endLine?: number;
    line?: number;
    column?: number;
    name?: string;
    kind?: string;
    vanillaType?: string;
    vanillaId?: string;
    key?: string;
    tokenEstimate?: number;
    cacheStatus?: ActiveContext['cacheStatus'];
}

export const CONTEXT_TYPE_META: Record<ActiveContextType, { icon: keyof typeof Icons; label: string }> = {
    code_selection: { icon: 'file', label: 'selection' },
    diagnostics: { icon: 'stethoscope', label: 'diagnostics' },
    file: { icon: 'file', label: 'file' },
    folder: { icon: 'folder', label: 'folder' },
    scope: { icon: 'ruler', label: 'scope' },
    symbol: { icon: 'link', label: 'symbol' },
    vanilla: { icon: 'package', label: 'vanilla' },
    blackboard: { icon: 'clipboard', label: 'blackboard' },
};

export function generateContextId(now = Date.now(), random = Math.random()): string {
    return 'ctx_' + now + '_' + Math.floor(random * 1000);
}

export function mentionResultToActiveContext(result: MentionResult): ActiveContext {
    return {
        id: generateContextId(),
        type: result.type || 'file',
        label: result.label,
        description: result.desc,
        uri: result.uri,
        startLine: result.startLine,
        endLine: result.endLine,
        line: result.line,
        column: result.column,
        name: result.name,
        kind: result.kind,
        vanillaType: result.vanillaType,
        vanillaId: result.vanillaId,
        key: result.key,
        tokenEstimate: result.tokenEstimate,
        cacheStatus: result.cacheStatus,
    };
}

export function stripConsumedMentionText(raw: string, contexts: ActiveContext[]): string {
    let text = raw;
    for (const ctx of contexts) {
        const labels = new Set<string>([ctx.label]);
        if (ctx.uri) labels.add(ctx.uri.replace(/\\/g, '/').split('/').pop() || ctx.uri);
        if (ctx.key) labels.add(`blackboard:${ctx.key}`);
        if (ctx.vanillaType) labels.add(`vanilla::${ctx.vanillaType}${ctx.vanillaId ? `:${ctx.vanillaId}` : ''}`);
        for (const label of labels) {
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text.replace(new RegExp(`(^|\\n)\\s*@${escaped}\\s*(?=\\n|$)`, 'gi'), '$1');
        }
    }
    return text.trim();
}
