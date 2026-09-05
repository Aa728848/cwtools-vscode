import { isRecord } from '../../../shared/protocolValidation';
import { aiText } from '../messages';
import { ANTIGRAVITY_ENDPOINTS } from './models';

export function antigravityHeaders(token: string): Record<string, string> {
    const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `antigravity/1.15.8 ${os}/${process.arch === 'x64' ? 'amd64' : process.arch}`,
        'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        'Client-Metadata': JSON.stringify({
            ideType: 'ANTIGRAVITY', pluginType: 'GEMINI',
            platform: process.platform === 'darwin' ? 'MACOS' : process.platform === 'win32' ? 'WINDOWS' : 'LINUX',
        }),
    };
}

export class AntigravityApiError extends Error {
    constructor(readonly status: number, operation: string, detail?: string) {
        super((status === 429
            ? aiText('Antigravity quota exhausted or rate limited (429).', 'Antigravity 额度已耗尽或请求受限（429）。')
            : aiText(`Antigravity ${operation} failed (${status}).`, `Antigravity ${operation} 失败（${status}）。`))
            + (detail ? ` ${detail}` : ''));
    }
}

/** Diagnostics must not consume an unlimited body or delay endpoint failover indefinitely. */
async function readErrorDetail(response: Response, token: string, signal: AbortSignal): Promise<string | undefined> {
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remaining = 16 * 1024;
    let body = '';
    let rejectRead: (reason: unknown) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectRead = reject; });
    const timeout = setTimeout(() => rejectRead(new Error('Antigravity error response timed out.')), 5_000);
    const onAbort = () => rejectRead(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        signal.throwIfAborted();
        while (remaining > 0) {
            const chunk = await Promise.race([reader.read(), interrupted]);
            if (chunk.done) break;
            const accepted = chunk.value.subarray(0, remaining);
            body += decoder.decode(accepted, { stream: true });
            remaining -= accepted.byteLength;
        }
        body += decoder.decode();
        let data: unknown;
        try { data = JSON.parse(body); } catch { return undefined; }
        if (!isRecord(data)) return undefined;
        const error = isRecord(data.error) ? data.error : data;
        if (typeof error.message !== 'string') return undefined;
        const message = token ? error.message.split(token).join('[REDACTED]') : error.message;
        return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
            .replace(/\s+/g, ' ').trim().slice(0, 1500) || undefined;
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
}

export type AntigravityAction = 'loadCodeAssist' | 'listCloudAICompanionProjects'
    | 'fetchAvailableModels' | 'retrieveUserQuotaSummary' | 'streamGenerateContent';

/** Fixed origins and no redirects: OAuth credentials never follow endpoint overrides. */
export async function postAntigravity(
    fetchFn: typeof fetch, token: string, action: AntigravityAction,
    body: Record<string, unknown>, signal: AbortSignal, claude = false,
): Promise<Response> {
    let failure: unknown;
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
        signal.throwIfAborted();
        try {
            const streaming = action === 'streamGenerateContent';
            const response = await fetchFn(`${endpoint}/v1internal:${action}${streaming ? '?alt=sse' : ''}`, {
                method: 'POST', redirect: 'error', signal,
                headers: {
                    ...antigravityHeaders(token),
                    ...(streaming ? { Accept: 'text/event-stream' } : {}),
                    ...(claude ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
                },
                body: JSON.stringify(body),
            });
            if (response.ok) return response;
            let detail: string | undefined;
            let diagnosticError: unknown;
            try { detail = await readErrorDetail(response, token, signal); }
            catch (error) { signal.throwIfAborted(); diagnosticError = error; }
            failure = Object.assign(new AntigravityApiError(response.status, action, detail),
                diagnosticError ? { cause: diagnosticError } : {});
            if (![404, 408, 429].includes(response.status) && response.status < 500) throw failure;
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof AntigravityApiError) throw error;
            failure = error;
        }
    }
    if (failure instanceof AntigravityApiError) throw failure;
    throw Object.assign(new Error(aiText(`Antigravity ${action} network request failed.`, `Antigravity ${action} 网络请求失败。`)), { cause: failure });
}

export function extractAntigravityProject(value: unknown, depth = 0): string | undefined {
    if (!isRecord(value) || depth > 4) return undefined;
    for (const key of ['antigravityProjectId', 'projectId', 'backendProjectId',
        'userDefinedCloudaicompanionProject', 'cloudaicompanionProject', 'project']) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        if (isRecord(candidate) && typeof candidate.id === 'string' && candidate.id.trim()) return candidate.id.trim();
    }
    for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
        const list = value[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (typeof item === 'string' && item.trim()) return item.trim();
            const project = extractAntigravityProject(item, depth + 1);
            if (project) return project;
        }
    }
    return undefined;
}
