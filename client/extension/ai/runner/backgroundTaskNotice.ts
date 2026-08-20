/**
 * Eddy CWTool Code — Background task settlement notice.
 *
 * Formats the `[BACKGROUND TASK RESULT]` system message a parent agent receives
 * when one of its background tasks settles.
 *
 * The design rule this file exists to hold: the endings that most need an
 * account to the parent are exactly the ones where the child never got to write
 * its own summary — a token ceiling, a provider fault, a cancellation, a host
 * restart. A bare `Status: failed` reads to a model as "that attempt was
 * unlucky, dispatch it again", which is the most expensive possible response.
 * So the notice always states a stop reason, always carries whatever content was
 * preserved, and says so explicitly when nothing was.
 */

export interface BackgroundTaskNoticePayload {
    taskId: string;
    status: string;
    /** Normalized reason the task stopped producing work. */
    stopReason?: string;
    /** Host-side summary recorded at settlement. */
    resultSummary?: string;
    /** Content preserved from the child, kept even when it failed. */
    lastMessage?: string;
    /** Path to the full appended output log, when one exists. */
    outputRef?: string;
}

/**
 * Build the notice body for one settled background task.
 * @param payload Settlement facts read from the task record.
 * @returns A single system-message body; never empty.
 */
export function formatBackgroundTaskNotice(payload: BackgroundTaskNoticePayload): string {
    const summary = (payload.resultSummary ?? '').trim();
    const preserved = (payload.lastMessage ?? '').trim();
    return [
        '[BACKGROUND TASK RESULT]',
        `Task: ${payload.taskId}`,
        `Status: ${payload.status}`,
        payload.stopReason ? `Stop reason: ${payload.stopReason}` : '',
        summary ? `Summary: ${summary}` : '',
        // Only when it adds something the summary does not already say.
        preserved && preserved !== summary
            ? `Preserved final message from the sub-agent:\n${preserved}`
            : '',
        !summary && !preserved
            ? 'The sub-agent produced no closing message. Inspect its output or graph before re-dispatching identical work.'
            : '',
        payload.outputRef ? `Full output: ${payload.outputRef}` : '',
    ].filter(Boolean).join('\n');
}
