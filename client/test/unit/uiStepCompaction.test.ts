import { expect } from 'chai';
import {
    aggregateStreamStepsForUi,
    compactMessagesForWebview,
    compactStepsForUi,
    prepareLiveStepForUi,
    pushLiveStepForReplay,
    UI_STREAM_CONTENT_LIMIT,
} from '../../extension/ai/chat/uiStepCompaction';

describe('uiStepCompaction', () => {
    it('merges consecutive thinking_content deltas instead of dropping them', () => {
        const steps = [
            { type: 'thinking_content', content: 'reason ', timestamp: 1 },
            { type: 'thinking_content', content: 'more', timestamp: 2 },
            { type: 'tool_call', content: 'Calling tool: read_file', toolName: 'read_file', timestamp: 3 },
        ];
        const compact = compactStepsForUi(steps);
        const thinking = compact.filter(s => s.type === 'thinking_content');
        expect(thinking).to.have.length(1);
        expect(thinking[0].content).to.equal('reason more');
        expect(compact.some(s => s.type === 'tool_call')).to.equal(true);
    });

    it('merges consecutive text_delta deltas and keeps process text', () => {
        const steps = [
            { type: 'text_delta', content: 'Hello ', timestamp: 1 },
            { type: 'text_delta', content: 'world', timestamp: 2 },
        ];
        const compact = compactStepsForUi(steps);
        expect(compact).to.have.length(1);
        expect(compact[0]).to.deep.include({ type: 'text_delta', content: 'Hello world' });
    });

    it('does not merge deltas separated by another step type', () => {
        const steps = [
            { type: 'thinking_content', content: 'a', timestamp: 1 },
            { type: 'tool_call', content: 'call', toolName: 'read_file', timestamp: 2 },
            { type: 'thinking_content', content: 'b', timestamp: 3 },
        ];
        const compact = compactStepsForUi(steps);
        expect(compact.filter(s => s.type === 'thinking_content')).to.have.length(2);
    });

    it('bounds aggregated stream content to UI_STREAM_CONTENT_LIMIT', () => {
        const steps = [
            { type: 'thinking_content', content: 'x'.repeat(UI_STREAM_CONTENT_LIMIT), timestamp: 1 },
            { type: 'thinking_content', content: 'y'.repeat(5000), timestamp: 2 },
        ];
        const compact = compactStepsForUi(steps);
        expect(compact).to.have.length(1);
        expect(compact[0].content.length).to.be.lessThan(UI_STREAM_CONTENT_LIMIT + 200);
        expect(compact[0].content).to.include('truncated');
    });

    it('still drops noisy orchestrator waiting steps', () => {
        const steps = [
            { type: 'orchestrator_progress', content: 'waiting for model response', timestamp: 1 },
            { type: 'tool_call', content: 'call', toolName: 'read_file', timestamp: 2 },
        ];
        const compact = compactStepsForUi(steps);
        expect(compact.map(s => s.type)).to.deep.equal(['tool_call']);
    });

    it('compactMessagesForWebview preserves reasoning steps in history messages', () => {
        const messages = [{
            role: 'assistant',
            content: 'done',
            steps: [
                { type: 'thinking_content', content: 'why ', timestamp: 1 },
                { type: 'thinking_content', content: 'because', timestamp: 2 },
                { type: 'tool_result', content: 'ok', toolName: 'read_file', timestamp: 3 },
            ],
        }];
        const compact = compactMessagesForWebview(messages);
        const thinking = compact[0].steps.filter((s: any) => s.type === 'thinking_content');
        expect(thinking).to.have.length(1);
        expect(thinking[0].content).to.equal('why because');
    });

    it('aggregateStreamStepsForUi keeps the first timestamp of a merged run', () => {
        const aggregated = aggregateStreamStepsForUi([
            { type: 'text_delta', content: 'a', timestamp: 10 },
            { type: 'text_delta', content: 'b', timestamp: 20 },
        ]);
        expect(aggregated[0].timestamp).to.equal(10);
    });

    it('pushLiveStepForReplay merges deltas without flooding the replay window', () => {
        const liveSteps: any[] = [];
        for (let i = 0; i < 500; i++) {
            pushLiveStepForReplay(liveSteps, { type: 'text_delta', content: `t${i}`, timestamp: i }, 6);
        }
        // 500 deltas merge into a single entry — tool steps are not evicted.
        expect(liveSteps).to.have.length(1);
        expect(liveSteps[0].content).to.include('t0');
        pushLiveStepForReplay(liveSteps, { type: 'tool_call', content: 'call', toolName: 'read_file', timestamp: 501 }, 6);
        pushLiveStepForReplay(liveSteps, { type: 'thinking_content', content: 'think', timestamp: 502 }, 6);
        expect(liveSteps.map(s => s.type)).to.deep.equal(['text_delta', 'tool_call', 'thinking_content']);
    });

    it('pushLiveStepForReplay enforces the max step bound for non-delta steps', () => {
        const liveSteps: any[] = [];
        for (let i = 0; i < 10; i++) {
            pushLiveStepForReplay(liveSteps, { type: 'tool_call', content: `c${i}`, toolName: 'read_file', timestamp: i }, 4);
        }
        expect(liveSteps).to.have.length(4);
        expect(liveSteps[0].content).to.equal('c6');
    });

    it('prepares the same compact bounded payload for live transport and replay', () => {
        const liveSteps: any[] = [];
        const transported = prepareLiveStepForUi(liveSteps, {
            type: 'tool_result',
            toolName: 'read_file',
            toolResult: { content: 'x'.repeat(20_000) },
            timestamp: 1,
        }, 4);
        expect(transported).to.equal(liveSteps[0]);
        expect(JSON.stringify(transported.toolResult).length).to.be.lessThan(7_000);

        const arrayPayload = prepareLiveStepForUi(liveSteps, {
            type: 'tool_result',
            toolName: 'search_mod_files',
            toolResult: { files: Array.from({ length: 2_000 }, (_, index) => ({ file: `common/test_${index}.txt` })) },
            timestamp: 2,
        }, 4);
        expect(JSON.stringify(arrayPayload.toolResult).length).to.be.lessThan(8_000);

        const suppressed = prepareLiveStepForUi(liveSteps, {
            type: 'orchestrator_progress',
            content: 'waiting for model response',
            timestamp: 3,
        }, 4);
        expect(suppressed).to.equal(undefined);
        expect(liveSteps).to.have.length(2);
    });
});
