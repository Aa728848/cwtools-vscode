/**
 * CWTools AI Module — Runner Step Emitter
 * 
 * Centralizes agent reasoning step dispatching, text streaming,
 * progress reporting, and UI synchronization.
 */

import type { AgentStep } from '../types';

export class StepEmitter {
    public readonly steps: AgentStep[] = [];

    constructor(private readonly onStepCallback?: (step: AgentStep) => void) {}

    /**
     * Emit a raw AgentStep.
     */
    public emit(step: AgentStep): void {
        this.steps.push(step);
        this.onStepCallback?.(step);
    }

    /**
     * Helper to emit a simple text delta (for streaming responses).
     */
    public emitTextDelta(content: string): void {
        this.emit({
            type: 'text_delta',
            content,
            timestamp: Date.now()
        });
    }

    /**
     * Helper to emit high-level orchestrator progress.
     */
    public emitProgress(content: string, toolName?: string): void {
        this.emit({
            type: 'orchestrator_progress',
            content,
            toolName,
            timestamp: Date.now()
        });
    }

    /**
     * Helper to emit warning messages.
     */
    public emitWarning(content: string): void {
        this.emit({
            type: 'orchestrator_progress',
            content: `[WARNING] ${content}`,
            timestamp: Date.now()
        });
    }
}
