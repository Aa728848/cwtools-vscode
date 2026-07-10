export interface AgentQueuedInput {
    id: string;
    message: string;
    clientUserMessageId?: string;
    images?: string[];
    createdAt: number;
}

export class AgentInputQueue {
    private readonly queue: AgentQueuedInput[] = [];

    constructor(public readonly runId: string) {}

    enqueue(message: string, clientUserMessageId?: string, images?: string[]): AgentQueuedInput {
        const item: AgentQueuedInput = {
            id: `input_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            message,
            clientUserMessageId,
            images,
            createdAt: Date.now(),
        };
        this.queue.push(item);
        return item;
    }

    drain(): AgentQueuedInput[] {
        return this.queue.splice(0, this.queue.length);
    }

    get size(): number {
        return this.queue.length;
    }
}
