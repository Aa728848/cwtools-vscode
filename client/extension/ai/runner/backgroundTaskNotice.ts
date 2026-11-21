/**
 * CWTools AI Module — Background task settlement notice formatter.
 *
 * Formats `[BACKGROUND TASK RESULT]` system messages when a background task
 * settles (retained for legacy/compatibility notification paths).
 *
 * Design rule: failures where a task stopped without writing its own summary
 * (token ceiling, provider fault, cancellation, host restart) must still state
 * a stop reason and carry whatever content was preserved, rather than emitting
 * a bare `Status: failed` that invites blind retries.
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
