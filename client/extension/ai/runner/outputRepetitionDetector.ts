/**
 * Detects exact cyclic output while a model response is still streaming.
 *
 * The detector intentionally waits for four aligned repetitions of a sizeable
 * block. This avoids treating ordinary repeated identifiers, table rows, or
 * code syntax as a model doom-loop while still catching paragraph-scale
 * repetition before it consumes the full output budget.
 */

export interface OutputRepetitionMatch {
    cycleChars: number;
    repetitions: number;
    preview: string;
}

const MAX_BUFFER_CHARS = 24_000;
const SIGNATURE_CHARS = 96;
const MIN_CYCLE_CHARS = 160;
const MAX_CYCLE_CHARS = 5_000;
const REQUIRED_REPETITIONS = 4;

function normalizeStreamText(text: string): string {
    return text.replace(/\s+/g, ' ').trimStart();
}

export class OutputRepetitionDetector {
    private buffer = '';
    private matched = false;

    append(chunk: string): OutputRepetitionMatch | undefined {
        if (this.matched || !chunk) return undefined;

        this.buffer = normalizeStreamText(this.buffer + chunk);
        if (this.buffer.length > MAX_BUFFER_CHARS) {
            this.buffer = this.buffer.slice(-MAX_BUFFER_CHARS);
        }

        const minimumLength = MIN_CYCLE_CHARS * REQUIRED_REPETITIONS;
        if (this.buffer.length < minimumLength) return undefined;

        const signatureLength = Math.min(SIGNATURE_CHARS, Math.floor(this.buffer.length / REQUIRED_REPETITIONS));
        const signatureStart = this.buffer.length - signatureLength;
        const signature = this.buffer.slice(signatureStart);
        const positions: number[] = [signatureStart];

        let searchBefore = signatureStart;
        while (positions.length < REQUIRED_REPETITIONS && searchBefore > 0) {
            const previous = this.buffer.lastIndexOf(signature, searchBefore - 1);
            if (previous < 0) break;
            positions.unshift(previous);
            searchBefore = previous;
        }

        if (positions.length < REQUIRED_REPETITIONS) return undefined;

        const cycleChars = positions[1]! - positions[0]!;
        if (cycleChars < MIN_CYCLE_CHARS || cycleChars > MAX_CYCLE_CHARS) return undefined;
        for (let i = 2; i < positions.length; i++) {
            if (positions[i]! - positions[i - 1]! !== cycleChars) return undefined;
        }

        const cycle = this.buffer.slice(positions[0], positions[1]);
        for (let i = 1; i < positions.length - 1; i++) {
            if (this.buffer.slice(positions[i], positions[i + 1]) !== cycle) return undefined;
        }

        this.matched = true;
        return {
            cycleChars,
            repetitions: REQUIRED_REPETITIONS,
            preview: cycle.slice(0, 240),
        };
    }
}
