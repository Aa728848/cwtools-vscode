/**
 * Browser-safe Agent transcript contract and convergence reducer.
 *
 * Context memory is intentionally not represented here. This projection is
 * for durable/user-visible history and may be paged or transported at a lower
 * granularity without changing what the model sees.
 */

export type TranscriptGrade = 'off' | 'turn' | 'block' | 'delta';
export type TranscriptTurnState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TranscriptStepState = 'running' | 'completed' | 'failed';

export interface TranscriptFrame {
    frameId: string;
    kind: 'text' | 'thinking' | 'tool' | 'notice';
    text?: string;
    toolName?: string;
    toolCallId?: string;
    status?: string;
    payload?: unknown;
}

export interface TranscriptStep {
    stepId: string;
    ordinal: number;
    state: TranscriptStepState;
    frames: TranscriptFrame[];
}

export interface TranscriptTurn {
    turnId: string;
    ordinal: number;
    state: TranscriptTurnState;
    prompt?: string;
    startedAt?: number;
    endedAt?: number;
    error?: string;
    steps: TranscriptStep[];
}

export interface TranscriptEntity {
    id: string;
    kind: 'task' | 'interaction' | 'prompt' | 'todo' | 'marker';
    /** Timeline owner. Removing a turn also removes the entities anchored to it. */
    anchorTurnId?: string;
    anchorStepId?: string;
    state?: string;
    value: unknown;
    updatedAt: number;
}

export interface AgentTranscriptSnapshot {
    version: 1;
    agentId: string;
    sequence: number;
    turns: TranscriptTurn[];
    entities: TranscriptEntity[];
    meta: Record<string, unknown>;
    hasMoreOlder: boolean;
}

export type TranscriptOperation =
    | { op: 'reset'; snapshot: AgentTranscriptSnapshot }
    | { op: 'turn.upsert'; turn: Omit<TranscriptTurn, 'steps'> }
    | { op: 'step.upsert'; turnId: string; step: Omit<TranscriptStep, 'frames'> }
    | { op: 'frame.upsert'; turnId: string; stepId: string; frame: TranscriptFrame }
    | {
        op: 'append';
        target: { turnId: string; stepId: string; frameId: string };
        offset: number;
        text: string;
    }
    | { op: 'entity.upsert'; entity: TranscriptEntity }
    | { op: 'turns.remove'; turnIds: string[] }
    | { op: 'meta.merge'; meta: Record<string, unknown> };

export interface TranscriptOpBatch {
    version: 1;
    agentId: string;
    sequence: number;
    operations: TranscriptOperation[];
}

export interface TranscriptApplyResult {
    snapshot: AgentTranscriptSnapshot;
    accepted: TranscriptOperation[];
    gap?: {
        kind: 'batch_sequence' | 'append_offset';
        expected: number;
        received: number;
    };
}

export const TRANSCRIPT_SNAPSHOT_LIMITS = {
    turns: 80,
    stepsPerTurn: 256,
    stepsTotal: 2_000,
    framesPerStep: 12,
    framesTotal: 4_000,
    entities: 1_000,
    textChars: 2_000_000,
    payloadChars: 512_000,
    frameTextChars: 128_000,
    valueChars: 32_000,
    metaChars: 64_000,
} as const;

const TRUNCATED_TEXT = '\n\n[... transcript content truncated ...]\n\n';

function truncateHeadTail(text: string, limit: number): string {
    if (text.length <= limit) return text;
    if (limit <= TRUNCATED_TEXT.length) return TRUNCATED_TEXT.slice(0, limit);
    const available = limit - TRUNCATED_TEXT.length;
    const head = Math.ceil(available / 2);
    return text.slice(0, head) + TRUNCATED_TEXT + text.slice(text.length - (available - head));
}

function boundUnknown(value: unknown, limit: number): { value: unknown; truncated: boolean; used: number } {
    if (value === undefined) return { value, truncated: false, used: 0 };
    try {
        const serialized = JSON.stringify(value);
        if (serialized.length <= limit) return { value, truncated: false, used: serialized.length };
        if (limit < 20) return { value: undefined, truncated: true, used: 0 };
        const boundedValue = limit > 64
            ? { truncated: true, preview: truncateHeadTail(serialized, limit - 64) }
            : { truncated: true };
        return {
            value: boundedValue,
            truncated: true,
            used: JSON.stringify(boundedValue).length,
        };
    } catch {
        return { value: { truncated: true, preview: '[Unserializable transcript value]' }, truncated: true, used: 0 };
    }
}

function serializedLength(value: unknown): number {
    if (value === undefined) return 0;
    const serialized = JSON.stringify(value);
    return serialized?.length ?? 0;
}

function transcriptExceedsBounds(snapshot: AgentTranscriptSnapshot): boolean {
    if (snapshot.turns.length > TRANSCRIPT_SNAPSHOT_LIMITS.turns
        || snapshot.entities.length > TRANSCRIPT_SNAPSHOT_LIMITS.entities
        || serializedLength(snapshot.meta) > TRANSCRIPT_SNAPSHOT_LIMITS.metaChars) return true;
    let steps = 0;
    let frames = 0;
    let text = 0;
    let payload = 0;
    for (let turnIndex = snapshot.turns.length - 1; turnIndex >= 0; turnIndex--) {
        const turn = snapshot.turns[turnIndex]!;
        const appendSafe = turn.state === 'running' && turnIndex === snapshot.turns.length - 1;
        if (!appendSafe && turn.steps.length > TRANSCRIPT_SNAPSHOT_LIMITS.stepsPerTurn) return true;
        steps += appendSafe ? 0 : turn.steps.length;
        if (steps > TRANSCRIPT_SNAPSHOT_LIMITS.stepsTotal) return true;
        if (!appendSafe && turn.prompt) {
            if (turn.prompt.length > TRANSCRIPT_SNAPSHOT_LIMITS.frameTextChars) return true;
            text += turn.prompt.length;
        }
        for (const step of turn.steps) {
            if (!appendSafe && step.frames.length > TRANSCRIPT_SNAPSHOT_LIMITS.framesPerStep) return true;
            frames += appendSafe ? 0 : step.frames.length;
            if (frames > TRANSCRIPT_SNAPSHOT_LIMITS.framesTotal) return true;
            for (const frame of step.frames) {
                if (!appendSafe && frame.text) {
                    if (frame.text.length > TRANSCRIPT_SNAPSHOT_LIMITS.frameTextChars) return true;
                    text += frame.text.length;
                    if (text > TRANSCRIPT_SNAPSHOT_LIMITS.textChars) return true;
                }
                const framePayload = serializedLength(frame.payload);
                if (framePayload > TRANSCRIPT_SNAPSHOT_LIMITS.valueChars) return true;
                payload += framePayload;
                if (payload > TRANSCRIPT_SNAPSHOT_LIMITS.payloadChars) return true;
            }
        }
    }
    for (const entity of snapshot.entities) {
        const entityValue = serializedLength(entity.value);
        if (entityValue > TRANSCRIPT_SNAPSHOT_LIMITS.valueChars) return true;
        payload += entityValue;
        if (payload > TRANSCRIPT_SNAPSHOT_LIMITS.payloadChars) return true;
    }
    return false;
}

/**
 * Keeps the durable UI transcript replayable without allowing provider-sized
 * streams or tool payloads to make every checkpoint grow without bound.
 * Running turns are not text-truncated because append offsets must stay exact.
 */
export function boundTranscriptSnapshot(snapshot: AgentTranscriptSnapshot): AgentTranscriptSnapshot {
    if (!transcriptExceedsBounds(snapshot)) return snapshot;
    let truncated = snapshot.turns.length > TRANSCRIPT_SNAPSHOT_LIMITS.turns
        || snapshot.entities.length > TRANSCRIPT_SNAPSHOT_LIMITS.entities;
    const turns = snapshot.turns.slice(-TRANSCRIPT_SNAPSHOT_LIMITS.turns).map(turn => ({
        ...turn,
        steps: turn.steps.map(step => ({ ...step, frames: step.frames.map(frame => ({ ...frame })) })),
    }));
    let remainingSteps: number = TRANSCRIPT_SNAPSHOT_LIMITS.stepsTotal;
    let remainingFrames: number = TRANSCRIPT_SNAPSHOT_LIMITS.framesTotal;
    let remainingText: number = TRANSCRIPT_SNAPSHOT_LIMITS.textChars;
    let remainingPayload: number = TRANSCRIPT_SNAPSHOT_LIMITS.payloadChars;

    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
        const turn = turns[turnIndex]!;
        const appendSafe = turn.state === 'running' && turnIndex === turns.length - 1;
        const originalSteps = turn.steps;
        const stepAllowance = Math.min(TRANSCRIPT_SNAPSHOT_LIMITS.stepsPerTurn, remainingSteps);
        turn.steps = appendSafe
            ? originalSteps
            : stepAllowance > 0 ? originalSteps.slice(-stepAllowance) : [];
        remainingSteps = Math.max(0, remainingSteps - turn.steps.length);
        if (turn.steps.length !== originalSteps.length) truncated = true;

        if (turn.prompt !== undefined && turn.state !== 'running') {
            const limit = Math.min(TRANSCRIPT_SNAPSHOT_LIMITS.frameTextChars, remainingText);
            const nextPrompt = truncateHeadTail(turn.prompt, limit);
            truncated ||= nextPrompt.length !== turn.prompt.length;
            turn.prompt = nextPrompt;
            remainingText -= nextPrompt.length;
        }

        for (let stepIndex = turn.steps.length - 1; stepIndex >= 0; stepIndex--) {
            const step = turn.steps[stepIndex]!;
            const originalFrames = step.frames;
            const frameAllowance = Math.min(TRANSCRIPT_SNAPSHOT_LIMITS.framesPerStep, remainingFrames);
            step.frames = appendSafe
                ? originalFrames
                : frameAllowance > 0 ? originalFrames.slice(-frameAllowance) : [];
            remainingFrames = Math.max(0, remainingFrames - step.frames.length);
            if (step.frames.length !== originalFrames.length) truncated = true;

            for (let frameIndex = step.frames.length - 1; frameIndex >= 0; frameIndex--) {
                const frame = step.frames[frameIndex]!;
                if (frame.text !== undefined && turn.state !== 'running') {
                    const limit = Math.min(TRANSCRIPT_SNAPSHOT_LIMITS.frameTextChars, remainingText);
                    const nextText = truncateHeadTail(frame.text, limit);
                    truncated ||= nextText.length !== frame.text.length;
                    frame.text = nextText;
                    remainingText -= nextText.length;
                }
                const boundedPayload = boundUnknown(
                    frame.payload,
                    Math.min(TRANSCRIPT_SNAPSHOT_LIMITS.valueChars, remainingPayload),
                );
                frame.payload = boundedPayload.value;
                remainingPayload = Math.max(0, remainingPayload - boundedPayload.used);
                truncated ||= boundedPayload.truncated;
            }
        }
    }

    const retainedTurnIds = new Set(turns.map(turn => turn.turnId));
    const entities = snapshot.entities
        .filter(entity => !entity.anchorTurnId || retainedTurnIds.has(entity.anchorTurnId))
        .slice(-TRANSCRIPT_SNAPSHOT_LIMITS.entities)
        .map(entity => {
            const boundedValue = boundUnknown(
                entity.value,
                Math.min(TRANSCRIPT_SNAPSHOT_LIMITS.valueChars, remainingPayload),
            );
            remainingPayload = Math.max(0, remainingPayload - boundedValue.used);
            truncated ||= boundedValue.truncated;
            return { ...entity, value: boundedValue.value };
        });
    if (entities.length !== snapshot.entities.length) truncated = true;
    const boundedMeta = boundUnknown(snapshot.meta, TRANSCRIPT_SNAPSHOT_LIMITS.metaChars);
    truncated ||= boundedMeta.truncated;

    return {
        ...snapshot,
        turns,
        entities,
        meta: boundedMeta.value && typeof boundedMeta.value === 'object' && !Array.isArray(boundedMeta.value)
            ? boundedMeta.value as Record<string, unknown>
            : { truncated: true },
        hasMoreOlder: snapshot.hasMoreOlder || truncated,
    };
}

function replaceTurn(
    turns: readonly TranscriptTurn[],
    turnId: string,
    update: (turn: TranscriptTurn) => TranscriptTurn,
): TranscriptTurn[] {
    return turns.map(turn => turn.turnId === turnId ? update(turn) : turn);
}

function emptyTurn(turnId: string): TranscriptTurn {
    return { turnId, ordinal: Number.MAX_SAFE_INTEGER, state: 'running', steps: [] };
}

function emptyStep(stepId: string): TranscriptStep {
    return { stepId, ordinal: Number.MAX_SAFE_INTEGER, state: 'running', frames: [] };
}

function applyOperation(
    snapshot: AgentTranscriptSnapshot,
    operation: TranscriptOperation,
): { snapshot: AgentTranscriptSnapshot; changed: boolean; gap?: TranscriptApplyResult['gap'] } {
    switch (operation.op) {
        case 'reset':
            return { snapshot: cloneTranscriptSnapshot(operation.snapshot), changed: true };
        case 'turn.upsert': {
            const current = snapshot.turns.find(turn => turn.turnId === operation.turn.turnId);
            const next: TranscriptTurn = { ...operation.turn, steps: current?.steps ?? [] };
            const turns = current
                ? replaceTurn(snapshot.turns, next.turnId, () => next)
                : [...snapshot.turns, next].sort((a, b) => a.ordinal - b.ordinal || a.turnId.localeCompare(b.turnId));
            return { snapshot: { ...snapshot, turns }, changed: JSON.stringify(current) !== JSON.stringify(next) };
        }
        case 'step.upsert': {
            const currentTurn = snapshot.turns.find(turn => turn.turnId === operation.turnId) ?? emptyTurn(operation.turnId);
            const currentStep = currentTurn.steps.find(step => step.stepId === operation.step.stepId);
            const nextStep: TranscriptStep = { ...operation.step, frames: currentStep?.frames ?? [] };
            const steps = currentStep
                ? currentTurn.steps.map(step => step.stepId === nextStep.stepId ? nextStep : step)
                : [...currentTurn.steps, nextStep].sort((a, b) => a.ordinal - b.ordinal || a.stepId.localeCompare(b.stepId));
            const nextTurn = { ...currentTurn, steps };
            const turns = snapshot.turns.some(turn => turn.turnId === operation.turnId)
                ? replaceTurn(snapshot.turns, operation.turnId, () => nextTurn)
                : [...snapshot.turns, nextTurn];
            return { snapshot: { ...snapshot, turns }, changed: JSON.stringify(currentStep) !== JSON.stringify(nextStep) };
        }
        case 'frame.upsert': {
            const turn = snapshot.turns.find(item => item.turnId === operation.turnId) ?? emptyTurn(operation.turnId);
            const step = turn.steps.find(item => item.stepId === operation.stepId) ?? emptyStep(operation.stepId);
            const current = step.frames.find(frame => frame.frameId === operation.frame.frameId);
            if (current && JSON.stringify(current) === JSON.stringify(operation.frame)) {
                return { snapshot, changed: false };
            }
            const frames = current
                ? step.frames.map(frame => frame.frameId === operation.frame.frameId ? operation.frame : frame)
                : [...step.frames, operation.frame];
            const nextStep = { ...step, frames };
            const steps = turn.steps.some(item => item.stepId === step.stepId)
                ? turn.steps.map(item => item.stepId === step.stepId ? nextStep : item)
                : [...turn.steps, nextStep];
            const nextTurn = { ...turn, steps };
            const turns = snapshot.turns.some(item => item.turnId === turn.turnId)
                ? replaceTurn(snapshot.turns, turn.turnId, () => nextTurn)
                : [...snapshot.turns, nextTurn];
            return { snapshot: { ...snapshot, turns }, changed: true };
        }
        case 'append': {
            const turn = snapshot.turns.find(item => item.turnId === operation.target.turnId);
            const step = turn?.steps.find(item => item.stepId === operation.target.stepId);
            const frame = step?.frames.find(item => item.frameId === operation.target.frameId);
            const currentText = frame?.text ?? '';
            if (!turn || !step || !frame || operation.offset > currentText.length) {
                return {
                    snapshot,
                    changed: false,
                    gap: { kind: 'append_offset', expected: currentText.length, received: operation.offset },
                };
            }
            const overlap = Math.max(0, currentText.length - operation.offset);
            const suffix = operation.text.slice(overlap);
            if (!suffix) return { snapshot, changed: false };
            return applyOperation(snapshot, {
                op: 'frame.upsert',
                turnId: turn.turnId,
                stepId: step.stepId,
                frame: { ...frame, text: currentText + suffix },
            });
        }
        case 'entity.upsert': {
            const current = snapshot.entities.find(entity => entity.id === operation.entity.id);
            if (current && JSON.stringify(current) === JSON.stringify(operation.entity)) {
                return { snapshot, changed: false };
            }
            const entities = current
                ? snapshot.entities.map(entity => entity.id === operation.entity.id ? operation.entity : entity)
                : [...snapshot.entities, operation.entity];
            entities.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
            return { snapshot: { ...snapshot, entities }, changed: true };
        }
        case 'turns.remove': {
            const ids = new Set(operation.turnIds);
            const turns = snapshot.turns.filter(turn => !ids.has(turn.turnId));
            const entities = snapshot.entities.filter(entity => !entity.anchorTurnId || !ids.has(entity.anchorTurnId));
            return {
                snapshot: { ...snapshot, turns, entities },
                changed: turns.length !== snapshot.turns.length || entities.length !== snapshot.entities.length,
            };
        }
        case 'meta.merge': {
            const meta = { ...snapshot.meta, ...operation.meta };
            return { snapshot: { ...snapshot, meta }, changed: JSON.stringify(meta) !== JSON.stringify(snapshot.meta) };
        }
    }
}

export function createEmptyTranscript(agentId: string): AgentTranscriptSnapshot {
    return {
        version: 1,
        agentId,
        sequence: 0,
        turns: [],
        entities: [],
        meta: {},
        hasMoreOlder: false,
    };
}

export function applyTranscriptBatch(
    snapshot: AgentTranscriptSnapshot,
    batch: TranscriptOpBatch,
): TranscriptApplyResult {
    if (batch.agentId !== snapshot.agentId) {
        return {
            snapshot,
            accepted: [],
            gap: { kind: 'batch_sequence', expected: snapshot.sequence + 1, received: batch.sequence },
        };
    }
    if (batch.sequence <= snapshot.sequence) return { snapshot, accepted: [] };
    if (batch.sequence !== snapshot.sequence + 1) {
        return {
            snapshot,
            accepted: [],
            gap: { kind: 'batch_sequence', expected: snapshot.sequence + 1, received: batch.sequence },
        };
    }
    let next = snapshot;
    const accepted: TranscriptOperation[] = [];
    for (const operation of batch.operations) {
        const applied = applyOperation(next, operation);
        if (applied.gap) return { snapshot: next, accepted, gap: applied.gap };
        next = applied.snapshot;
        if (applied.changed) accepted.push(operation);
    }
    return { snapshot: boundTranscriptSnapshot({ ...next, sequence: batch.sequence }), accepted };
}

export function filterTranscriptOperations(
    grade: TranscriptGrade,
    operations: readonly TranscriptOperation[],
): TranscriptOperation[] {
    if (grade === 'off') return [];
    if (grade === 'delta') return operations.map(operation =>
        operation.op === 'reset'
            ? { ...operation, snapshot: redactTranscriptSnapshot(operation.snapshot, grade) }
            : operation);
    if (grade === 'block') return operations
        .filter(operation => operation.op !== 'append')
        .map(operation => {
            if (operation.op === 'reset') {
                return { ...operation, snapshot: redactTranscriptSnapshot(operation.snapshot, grade) };
            }
            if (operation.op === 'frame.upsert') {
                return { ...operation, frame: { ...operation.frame, payload: undefined } };
            }
            return operation;
        });
    return operations.filter(operation =>
        operation.op === 'reset'
        || operation.op === 'turn.upsert'
        || operation.op === 'entity.upsert'
        || operation.op === 'turns.remove'
        || operation.op === 'meta.merge')
        .map(operation => operation.op === 'reset'
            ? { ...operation, snapshot: redactTranscriptSnapshot(operation.snapshot, grade) }
            : operation);
}

/** Redact a snapshot to the same information boundary as streamed operations. */
export function redactTranscriptSnapshot(
    snapshot: AgentTranscriptSnapshot,
    grade: TranscriptGrade,
): AgentTranscriptSnapshot {
    if (grade === 'delta') return cloneTranscriptSnapshot(snapshot);
    if (grade === 'block') {
        return {
            ...cloneTranscriptSnapshot(snapshot),
            turns: snapshot.turns.map(turn => ({
                ...turn,
                steps: turn.steps.map(step => ({
                    ...step,
                    frames: step.frames.map(frame => ({ ...frame, payload: undefined })),
                })),
            })),
        };
    }
    if (grade === 'turn') {
        return {
            ...cloneTranscriptSnapshot(snapshot),
            turns: snapshot.turns.map(turn => ({ ...turn, steps: [] })),
        };
    }
    return {
        ...createEmptyTranscript(snapshot.agentId),
        sequence: snapshot.sequence,
        meta: { grade: 'off' },
    };
}

export function paginateTranscriptTurns(
    snapshot: AgentTranscriptSnapshot,
    options: { beforeOrdinal?: number; pageSize: number },
): { turns: TranscriptTurn[]; hasMore: boolean } {
    const pageSize = Math.max(1, Math.min(200, Math.floor(options.pageSize)));
    const eligible = options.beforeOrdinal === undefined
        ? snapshot.turns
        : snapshot.turns.filter(turn => turn.ordinal < options.beforeOrdinal!);
    const turns = eligible.slice(-pageSize);
    return { turns: turns.map(turn => ({ ...turn, steps: [...turn.steps] })), hasMore: eligible.length > turns.length };
}

export function cloneTranscriptSnapshot(snapshot: AgentTranscriptSnapshot): AgentTranscriptSnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as AgentTranscriptSnapshot;
}

export class AgentTranscriptStore {
    private snapshotValue: AgentTranscriptSnapshot;
    private readonly listeners = new Set<(result: TranscriptApplyResult) => void>();

    constructor(agentId: string, snapshot?: AgentTranscriptSnapshot) {
        this.snapshotValue = snapshot
            ? boundTranscriptSnapshot(cloneTranscriptSnapshot(snapshot))
            : createEmptyTranscript(agentId);
    }

    apply(batch: TranscriptOpBatch): TranscriptApplyResult {
        const result = applyTranscriptBatch(this.snapshotValue, batch);
        this.snapshotValue = result.snapshot;
        if (result.accepted.length > 0 || result.gap) {
            for (const listener of this.listeners) listener(result);
        }
        return result;
    }

    next(operations: TranscriptOperation[]): TranscriptApplyResult {
        return this.apply(this.nextBatch(operations));
    }

    nextBatch(operations: TranscriptOperation[]): TranscriptOpBatch {
        return {
            version: 1,
            agentId: this.snapshotValue.agentId,
            sequence: this.snapshotValue.sequence + 1,
            operations,
        };
    }

    snapshot(): AgentTranscriptSnapshot {
        return cloneTranscriptSnapshot(this.snapshotValue);
    }

    subscribe(listener: (result: TranscriptApplyResult) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
