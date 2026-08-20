/**
 * Eddy CWTool Code — Abort-aware permission requests.
 *
 * A permission request is an unbounded wait on a human. The host UI resolves it
 * when the user clicks a card, and nothing else settles it — so any `await` on
 * one must also be able to lose to the run's abort signal.
 *
 * This matters most for a dispatched sub-agent: nobody is necessarily watching
 * its card, and the awaiting tool call sits inside the child's reasoning loop.
 * Without an escape the child's inner promise chain never settles; the
 * orchestrator's own idle watchdog eventually walks away from the node, leaving
 * a dangling await and a stale approval card behind it.
 *
 * Deny-on-abort is the only safe resolution: an abort is not consent.
 */

export type PermissionRequestFn = (
    id: string,
    tool: string,
    description: string,
    command?: string,
    context?: unknown,
) => Promise<boolean>;

export interface PermissionRequestParams {
    id: string;
    tool: string;
    description: string;
    command?: string;
    /** Tool context forwarded to the host verbatim. */
    context?: unknown;
}

/**
 * Await a permission request, losing to `abortSignal` rather than hanging.
 * @param requestPermission Host approval channel.
 * @param params Request identity and description.
 * @param abortSignal Run/child signal; an already-aborted signal denies immediately.
 * @returns Whether the operation was approved. Abort resolves `false`.
 */
export async function requestPermissionWithAbort(
    requestPermission: PermissionRequestFn,
    params: PermissionRequestParams,
    abortSignal?: AbortSignal,
): Promise<boolean> {
    if (abortSignal?.aborted) return false;
    if (!abortSignal) {
        return requestPermission(params.id, params.tool, params.description, params.command, params.context);
    }
    let onAbort: (() => void) | undefined;
    const abortDeny = new Promise<boolean>(resolve => {
        onAbort = () => resolve(false);
        abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([
            requestPermission(params.id, params.tool, params.description, params.command, params.context),
            abortDeny,
        ]);
    } finally {
        if (onAbort) abortSignal.removeEventListener('abort', onAbort);
    }
}
