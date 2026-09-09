/**
 * Retry policy for a detected streamed-output repetition.
 *
 * A reasoning-stream loop is not a transport failure: the model re-enters the
 * same reasoning attractor, so re-issuing the request with identical thinking
 * settings reproduces the loop and the second detection ends the whole run.
 * The retry for a reasoning loop therefore asks for the lowest thinking shape
 * the provider supports (thinking disabled / effort reduced), which removes the
 * stream that looped while keeping the task and its completed steps alive.
 *
 * A repeated visible response is a different failure: thinking is left
 * untouched and the retry only drops the repeated answer.
 */

export type OutputRepetitionKind = 'reasoning' | 'response';

export interface OutputRepetitionRetryPlan {
    /** Run this single retry with the lowest available thinking shape. */
    lowThinking: boolean;
    /** Model-facing directive pushed before the retry. */
    directive: string;
}

const REASONING_RETRY_DIRECTIVE = '[SYSTEM] Your previous stream entered an exact repeated-output cycle and was stopped. Do not restate the abandoned reasoning. Thinking is disabled for this retry: re-evaluate from the latest verified state, then make one concrete tool call or return one concise final answer. If context is insufficient, say what is missing instead of repeating.';

const RESPONSE_RETRY_DIRECTIVE = '[SYSTEM] Your previous response entered an exact repeated-output cycle and was discarded. Do not restate it. Make one concrete tool call or return one concise final answer; report missing context instead of repeating.';

export function planOutputRepetitionRetry(kind: OutputRepetitionKind): OutputRepetitionRetryPlan {
    return kind === 'reasoning'
        ? { lowThinking: true, directive: REASONING_RETRY_DIRECTIVE }
        : { lowThinking: false, directive: RESPONSE_RETRY_DIRECTIVE };
}
