import { expect } from 'chai';
import type { ChatMessage } from '../../extension/ai/types';
import {
    cloneChatMessage,
    inspectTranscriptIntegrity,
    normalizeTranscriptForPersistence,
    selectProviderSafeTail,
    splitTranscriptForCompaction,
} from '../../extension/ai/runner/contextTranscript';

describe('canonical context transcript', () => {
    it('deep-clones provider-native continuation metadata', () => {
        const source: ChatMessage = {
            role: 'assistant',
            content: null,
            responses_output_items: [{ type: 'message', content: [{ type: 'output_text', text: 'one' }] }],
            anthropic_thinking_blocks: [{ type: 'thinking', thinking: 'one', signature: 'sig' }],
            tool_calls: [{
                id: 'call_1',
                thoughtSignature: 'gemini-sig',
                type: 'function',
                function: { name: 'read_file', arguments: '{}' },
            }],
        };
        const cloned = cloneChatMessage(source);
        ((cloned.responses_output_items![0]!.content as any[])[0] as any).text = 'changed';
        cloned.anthropic_thinking_blocks![0]!.thinking = 'changed';

        expect((((source.responses_output_items![0]!.content as any[])[0]) as any).text).to.equal('one');
        expect(source.anthropic_thinking_blocks![0]!.thinking).to.equal('one');
        expect(cloned.tool_calls![0]!.thoughtSignature).to.equal('gemini-sig');
    });

    it('removes orphan and duplicate tool messages and closes unfinished calls', () => {
        const messages: ChatMessage[] = [
            { role: 'tool', tool_call_id: 'orphan', content: 'orphan' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_a', name: 'read_file', content: '{"ok":true}' },
            { role: 'tool', tool_call_id: 'call_a', name: 'read_file', content: 'duplicate' },
            { role: 'user', content: 'continue' },
            {
                role: 'assistant',
                content: 'duplicate call id',
                tool_calls: [
                    { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_a', name: 'read_file', content: 'duplicate later result' },
        ];

        const normalized = normalizeTranscriptForPersistence(messages);
        expect(normalized.map(message => message.role)).to.deep.equal([
            'assistant', 'tool', 'tool', 'user', 'assistant',
        ]);
        expect(normalized[0]?.tool_calls?.map(call => call.id)).to.deep.equal(['call_a', 'call_b']);
        expect(normalized[1]?.tool_call_id).to.equal('call_a');
        expect(normalized[2]?.tool_call_id).to.equal('call_b');
        expect(JSON.parse(String(normalized[2]?.content)).interrupted).to.equal(true);
        expect(normalized[4]?.tool_calls).to.equal(undefined);
        expect(inspectTranscriptIntegrity(normalized).valid).to.equal(true);
    });

    it('keeps a complete assistant-tool group when selecting a bounded tail', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'old request' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    { id: 'call_2', type: 'function', function: { name: 'grep', arguments: '{}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'one' },
            { role: 'tool', tool_call_id: 'call_2', name: 'grep', content: 'two' },
        ];

        const tail = selectProviderSafeTail(messages, 2);
        expect(tail.map(message => message.role)).to.deep.equal(['assistant', 'tool', 'tool']);
        expect(inspectTranscriptIntegrity(tail).valid).to.equal(true);
    });

    it('keeps a rolling recovery summary pair together at a resume tail boundary', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: '[Context Recovery] use the summary' },
            { role: 'assistant', content: '## Conversation Summary (compacted)\nIMPORTANT_STATE' },
            { role: 'user', content: 'latest request' },
        ];

        const tail = selectProviderSafeTail(messages, 2);
        expect(tail.map(message => message.content)).to.deep.equal([
            '[Context Recovery] use the summary',
            '## Conversation Summary (compacted)\nIMPORTANT_STATE',
            'latest request',
        ]);
    });

    it('keeps every leading system instruction outside the compacted region', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'base system' },
            { role: 'system', content: 'workspace policy' },
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'recent request' },
            { role: 'assistant', content: 'recent answer' },
        ];

        const split = splitTranscriptForCompaction(messages, 2);
        expect(split.persistentSystemMessages.map(message => message.content)).to.deep.equal([
            'base system',
            'workspace policy',
        ]);
        expect(split.olderMessages.map(message => message.content)).to.deep.equal(['old request', 'old answer']);
        expect(split.recentMessages.map(message => message.content)).to.deep.equal(['recent request', 'recent answer']);
    });
});
