/**
 * CWTools AI Module — Runner Cancellation System
 * 
 * Standardizes abort/cancellation checks, signals propagation,
 * and AbortError classification.
 */

export class AgentAbortError extends Error {
    constructor(message: string = 'Operation was aborted by the user.') {
        super(message);
        this.name = 'AbortError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Check if the provided signal is aborted, and throw a standardized AbortError.
 */
export function checkCancellation(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new AgentAbortError(
            signal.reason instanceof Error ? signal.reason.message : undefined
        );
    }
}

/**
 * Verify if an error is a cancellation-induced AbortError.
 */
export function isAbortError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof AgentAbortError) return true;
    if (error instanceof Error) {
        if (error.name === 'AbortError' || error.name === 'CancellationError') return true;
        const msg = error.message.toLowerCase();
        return msg.includes('aborted') || msg.includes('cancel');
    }
    const str = String(error).toLowerCase();
    return str.includes('aborted') || str.includes('cancel');
}
