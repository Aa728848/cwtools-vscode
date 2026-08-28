import { expect } from 'chai';
import type { HostMessage } from '../../extension/ai/types';
import { parseWebviewMessage } from '../../extension/ai/chat/webviewProtocol';
import { parseHostMessage, type HostProtocolMessage } from '../../webview/chat/hostProtocol';

type HostMessageTypesMatch = Exclude<HostMessage['type'], HostProtocolMessage['type']> extends never
    ? Exclude<HostProtocolMessage['type'], HostMessage['type']> extends never
        ? true
        : false
    : false;

const hostMessageTypesMatch: HostMessageTypesMatch = true;

describe('AI chat protocol boundaries', () => {
    it('accepts well-formed Webview messages', () => {
        expect(parseWebviewMessage({ type: 'ready' })).to.deep.equal({ type: 'ready' });
        expect(parseWebviewMessage({
            type: 'sendMessage',
            text: 'hello',
            images: ['data:image/png;base64,AA=='],
            agentProfile: { domain: 'general', intent: 'execute', strategy: 'single' },
        })).to.not.equal(null);
        expect(parseWebviewMessage({
            type: 'permissionResponse',
            permissionId: 'permission-1',
            decision: 'acceptForSession',
        })).to.not.equal(null);
        expect(parseWebviewMessage({
            type: 'questionResponse',
            questionId: 'question-1',
            answers: { scope: 'workspace', checks: ['compile', 'test'] },
        })).to.not.equal(null);
    });

    it('rejects unknown or malformed Webview messages', () => {
        expect(parseWebviewMessage(null)).to.equal(null);
        expect(parseWebviewMessage({ type: 'unknown-command' })).to.equal(null);
        expect(parseWebviewMessage({ type: 'sendMessage', text: 42 })).to.equal(null);
        expect(parseWebviewMessage({ type: 'switchMode', mode: 'root' })).to.equal(null);
        expect(parseWebviewMessage({ type: 'openContextReference', context: { type: 'file' } })).to.equal(null);
        expect(parseWebviewMessage({
            type: 'submitPlanAnnotations',
            annotations: [{ section: 'one', note: 1 }],
        })).to.equal(null);
        expect(parseWebviewMessage({
            type: 'questionResponse',
            questionId: 'question-1',
            answers: { scope: 42 },
        })).to.equal(null);
    });

    it('validates settings before they reach SecretStorage-backed handlers', () => {
        const settings = {
            provider: 'openai',
            model: 'gpt-test',
            apiKey: '',
            endpoint: 'https://example.test',
            maxContextTokens: 128000,
            agentFileWriteMode: 'confirm',
            reasoningEffort: 'medium',
            responseVerbosity: 'low',
            codexServiceTier: 'fast',
            inlineCompletion: {},
            translationPreview: {},
        };
        expect(parseWebviewMessage({ type: 'saveSettings', settings })).to.not.equal(null);
        expect(parseWebviewMessage({ type: 'saveSettings', settings: { ...settings, maxContextTokens: 'large' } })).to.equal(null);
        expect(parseWebviewMessage({ type: 'saveSettings', settings: { ...settings, responseVerbosity: 'verbose' } })).to.equal(null);
        expect(parseWebviewMessage({ type: 'saveSettings', settings: { ...settings, codexServiceTier: 'turbo' } })).to.equal(null);
    });

    it('accepts the provider fields used by connection tests', () => {
        const settings = {
            provider: 'deepseek',
            model: 'deepseek-chat',
            apiKey: '',
            endpoint: 'https://api.deepseek.com/v1',
            customApiFormat: 'openai-chat-completions',
        };

        expect(parseWebviewMessage({ type: 'testConnection', settings })).to.not.equal(null);
        expect(parseWebviewMessage({
            type: 'testConnection',
            settings: { ...settings, endpoint: 42 },
        })).to.equal(null);
        expect(parseWebviewMessage({
            type: 'testConnection',
            settings: { ...settings, customApiFormat: 'unknown' },
        })).to.equal(null);
    });

    it('accepts well-formed Host messages and rejects malformed payloads', () => {
        expect(hostMessageTypesMatch).to.equal(true);
        expect(parseHostMessage({ type: 'clearChat' })).to.deep.equal({ type: 'clearChat' });
        expect(parseHostMessage({ type: 'agentStep', step: { type: 'thinking', content: 'x' } })).to.not.equal(null);
        expect(parseHostMessage({ type: 'agentRoutingStatus', phase: 'classifying' })).to.not.equal(null);
        expect(parseHostMessage({ type: 'agentRoutingStatus', phase: 'unknown' })).to.equal(null);
        expect(parseHostMessage({
            type: 'permissionRequest',
            permissionId: 'p1',
            itemId: 'i1',
            tool: 'write_file',
            description: 'write',
            availableDecisions: ['accept', 'decline'],
        })).to.not.equal(null);
        expect(parseHostMessage({
            type: 'questionRequest',
            questionId: 'q1',
            topicId: 'topic-1',
            questions: [{
                id: 'scope',
                question: 'Which scope?',
                options: [
                    { label: 'Workspace', description: 'Use the full workspace.' },
                    { label: 'File', description: 'Use the active file.' },
                ],
            }],
        })).to.not.equal(null);
        expect(parseHostMessage({
            type: 'questionRequest',
            questionId: 'q1',
            topicId: 'topic-1',
            questions: [{ id: 'scope', question: 'Which scope?', options: [] }],
        })).to.equal(null);
        expect(parseHostMessage({
            type: 'questionRequest',
            questionId: 'q1',
            questions: [{
                id: 'scope',
                question: 'Which scope?',
                options: [
                    { label: 'Workspace', description: 'Use the full workspace.' },
                    { label: 'File', description: 'Use the active file.' },
                ],
            }],
        })).to.equal(null);

        expect(parseHostMessage('clearChat')).to.equal(null);
        expect(parseHostMessage({ type: 'agentStep', step: 'not-an-object' })).to.equal(null);
        expect(parseHostMessage({ type: 'generationError', error: 500 })).to.equal(null);
        expect(parseHostMessage({ type: 'runSnapshot', snapshot: null })).to.equal(null);
    });
});
