/**
 * Regression tests for the DeepSeek-support improvements:
 *  - per-model compaction ratios and tool-result archive limits
 *  - per-provider model supplement selection
 */

import { expect } from 'chai';

// Modules whose import chain touches vscode are loaded through a stub.
const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T) => defaultValue,
        }),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        }),
    },
};

const moduleLoader = require('module') as { _load: (...args: any[]) => any };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.apply(this, [request, ...args]);
};

// ─── per-model compaction ratios and archive limits ───────────────────────────

describe('resolveCompactionRatios / resolveToolResultArchiveLimit', () => {
    let compaction: typeof import('../../extension/ai/runner/compaction');

    before(() => {
        compaction = require('../../extension/ai/runner/compaction') as typeof compaction;
    });

    it('keeps the historical defaults for non-DeepSeek models', () => {
        expect(compaction.resolveCompactionRatios('claude', 'claude-opus-4-8')).to.deep.equal({
            thresholdRatio: 0.80,
            targetRatio: 0.60,
            midLoopRatio: 0.78,
        });
    });

    it('raises the watermarks for DeepSeek providers and relay-hosted DeepSeek models', () => {
        const expected = { thresholdRatio: 0.85, targetRatio: 0.65, midLoopRatio: 0.80 };
        expect(compaction.resolveCompactionRatios('deepseek', 'deepseek-v4-pro')).to.deep.equal(expected);
        expect(compaction.resolveCompactionRatios('deepseek', 'deepseek-flash')).to.deep.equal(expected);
        expect(compaction.resolveCompactionRatios('openrouter', 'deepseek/deepseek-v4-pro')).to.deep.equal(expected);
        expect(compaction.resolveCompactionRatios(undefined, 'siliconflow:deepseek-ai/DeepSeek-V4-Flash')).to.deep.equal(expected);
    });

    it('doubles tool-result archive limits for DeepSeek and keeps defaults elsewhere', () => {
        expect(compaction.resolveToolResultArchiveLimit('read_file', 'deepseek', 'deepseek-v4-pro')).to.equal(32_000);
        expect(compaction.resolveToolResultArchiveLimit('read_file', 'deepseek', 'deepseek-flash')).to.equal(32_000);
        expect(compaction.resolveToolResultArchiveLimit('query_rules', 'deepseek', 'deepseek-v4-pro')).to.equal(120_000);
        expect(compaction.resolveToolResultArchiveLimit('read_file', 'claude', 'claude-opus-4-8')).to.equal(16_000);
        expect(compaction.resolveToolResultArchiveLimit('query_rules', undefined, undefined)).to.equal(60_000);
    });

    it('drives the periodic mid-loop trigger from the per-model watermark', () => {
        expect(compaction.resolveMidLoopBlockRatio('deepseek', 'deepseek-v4-pro')).to.equal(0.80);
        expect(compaction.resolveMidLoopBlockRatio('claude', 'claude-opus-4-8')).to.equal(0.78);
    });
});

// ─── per-provider model supplement ────────────────────────────────────────────

describe('modelSupplementForProvider', () => {
    let promptBuilder: typeof import('../../extension/ai/promptBuilder');

    before(() => {
        promptBuilder = require('../../extension/ai/promptBuilder') as typeof promptBuilder;
    });

    it('guides DeepSeek toward batch edits', () => {
        const supplement = promptBuilder.modelSupplementForProvider('deepseek');
        expect(supplement).to.include('parallel edit_file');
    });

    it('keeps the provider-specific supplements and defaults intact', () => {
        expect(promptBuilder.modelSupplementForProvider('claude')).to.include('Claude');
        expect(promptBuilder.modelSupplementForProvider('google')).to.include('Gemini');
        expect(promptBuilder.modelSupplementForProvider('openai')).to.include('batch your tool calls');
        expect(promptBuilder.modelSupplementForProvider(undefined)).to.equal('');
    });
});
