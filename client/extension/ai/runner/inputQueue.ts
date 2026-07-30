export type AgentQueuedInputKind =
    | 'interrupt'
    | 'approval'
    | 'steer'
    | 'retry'
    | 'continuation'
    | 'pending'
    | 'background_result';

export interface AgentQueuedInput {
    id: string;
    message: string;
    clientUserMessageId?: string;
    images?: string[];
    createdAt: number;
    kind: AgentQueuedInputKind;
    operationId?: string;
    sequence: number;
}

export class AgentInputQueue {
    private readonly queue: AgentQueuedInput[] = [];
    private sequence = 0;

    constructor(public readonly runId: string) {}

    enqueue(
        message: string,
        clientUserMessageId?: string,
        images?: string[],
        kind: AgentQueuedInputKind = 'steer',
        operationId?: string,
    ): AgentQueuedInput {
        const item: AgentQueuedInput = {
            id: `input_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            message,
            clientUserMessageId,
            images,
            createdAt: Date.now(),
            kind,
            operationId,
            sequence: this.sequence++,
        };
        this.queue.push(item);
        return item;
    }

    drain(kinds?: ReadonlySet<AgentQueuedInputKind>): AgentQueuedInput[] {
        const selected = kinds ? this.queue.filter(item => kinds.has(item.kind)) : [...this.queue];
        const selectedIds = new Set(selected.map(item => item.id));
        for (let index = this.queue.length - 1; index >= 0; index--) {
            if (selectedIds.has(this.queue[index]!.id)) this.queue.splice(index, 1);
        }
        return selected.sort((left, right) =>
            inputPriority(left.kind) - inputPriority(right.kind)
            || left.sequence - right.sequence);
    }

    peek(): AgentQueuedInput | undefined {
        return [...this.queue].sort((left, right) =>
            inputPriority(left.kind) - inputPriority(right.kind)
            || left.sequence - right.sequence)[0];
    }

    get size(): number {
        return this.queue.length;
    }
}

function inputPriority(kind: AgentQueuedInputKind): number {
    switch (kind) {
        case 'interrupt': return 0;
        case 'approval': return 1;
        case 'steer': return 2;
        case 'retry': return 3;
        case 'continuation': return 4;
        case 'pending': return 5;
        case 'background_result': return 6;
    }
}
