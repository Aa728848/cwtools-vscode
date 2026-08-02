export type BestEffortDiagnosticContext = Record<string, string | number | boolean | undefined>;

export interface BestEffortReporterOptions {
    cooldownMs?: number;
    maxKeys?: number;
    now?: () => number;
}

/**
 * Creates a bounded, rate-limited reporter for failures that must not abort the
 * main workflow. Context keys are sorted so equivalent failures share a key.
 */
export function createBestEffortReporter(
    sink: (message: string, error: unknown) => void,
    options: BestEffortReporterOptions = {},
): (operation: string, context: BestEffortDiagnosticContext, error: unknown) => void {
    const cooldownMs = options.cooldownMs ?? 30_000;
    const maxKeys = options.maxKeys ?? 64;
    const now = options.now ?? Date.now;
    const lastReportedAt = new Map<string, number>();

    return (operation, context, error) => {
        const contextText = Object.entries(context)
            .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(' ');
        const key = `${operation}|${contextText}`;
        const timestamp = now();
        const previous = lastReportedAt.get(key);
        if (previous !== undefined && timestamp - previous < cooldownMs) return;
        if (!lastReportedAt.has(key) && lastReportedAt.size >= maxKeys) {
            const oldest = lastReportedAt.keys().next().value as string | undefined;
            if (oldest !== undefined) lastReportedAt.delete(oldest);
        }
        lastReportedAt.delete(key);
        lastReportedAt.set(key, timestamp);
        sink(`${operation} failed${contextText ? ` (${contextText})` : ''}`, error);
    };
}
