import * as crypto from 'crypto';
import * as path from 'path';
import { TOOL_REGISTRY, type AgentToolName } from '../tools/registry';

function canonicalize(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) return value.map(item => canonicalize(item));
    if (!value || typeof value !== 'object') {
        if (typeof value === 'string' && key && /(path|file|cwd|root)$/i.test(key)) {
            return path.normalize(value).replace(/\\/g, '/');
        }
        if (key && /(secret|token|password|api.?key)/i.test(key)) return '<redacted>';
        return value;
    }
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map(childKey => [childKey, canonicalize((value as Record<string, unknown>)[childKey], childKey)]));
}

export function createToolCallSignature(
    toolName: string,
    args: Record<string, unknown>,
    targetPaths: readonly string[] = [],
): string {
    return JSON.stringify({
        toolName,
        args: canonicalize(args),
        targetPaths: [...targetPaths].map(value => path.normalize(value).replace(/\\/g, '/')).sort(),
    });
}

export function createToolDedupeKey(
    toolName: string,
    args: Record<string, unknown>,
    authorizationScope: string,
    targetResourceRevision: string,
): string {
    const canonical = JSON.stringify({
        toolName,
        args: canonicalize(args),
        authorizationScope,
        targetResourceRevision,
    });
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface DedupeResult<T> {
    value: T;
    reused: boolean;
    sourceInvocationId: string;
}

interface CachedInvocation<T> {
    invocationId: string;
    promise: Promise<T>;
    successful: boolean;
}

export class ToolDedupeService {
    private readonly inStep = new Map<string, CachedInvocation<unknown>>();

    async execute<T>(
        request: {
            invocationId: string;
            toolName: string;
            args: Record<string, unknown>;
            authorizationScope: string;
            targetResourceRevision: string;
        },
        execute: () => Promise<T>,
    ): Promise<DedupeResult<T>> {
        const entry = TOOL_REGISTRY.get(request.toolName as AgentToolName);
        const reusable = entry?.idempotency === 'read' || entry?.idempotency === 'deterministic';
        const key = createToolDedupeKey(
            request.toolName,
            request.args,
            request.authorizationScope,
            request.targetResourceRevision,
        );
        const existing = reusable ? this.inStep.get(key) as CachedInvocation<T> | undefined : undefined;
        if (existing) {
            return { value: await existing.promise, reused: true, sourceInvocationId: existing.invocationId };
        }
        const cached: CachedInvocation<T> = {
            invocationId: request.invocationId,
            successful: false,
            promise: execute(),
        };
        if (reusable) this.inStep.set(key, cached as CachedInvocation<unknown>);
        try {
            const value = await cached.promise;
            cached.successful = true;
            return { value, reused: false, sourceInvocationId: request.invocationId };
        } catch (error) {
            if (this.inStep.get(key) === cached) this.inStep.delete(key);
            throw error;
        }
    }

    nextStep(): void {
        this.inStep.clear();
    }
}
