import type { ReasoningEffort } from '../types';

// Compatibility contract shared with dsh-chatgpt-subscription's Antigravity adapter.
export const ANTIGRAVITY_ENDPOINTS = [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
] as const;

export const ANTIGRAVITY_MODELS = [
    'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
    'gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
    'claude-opus-4-6', 'claude-sonnet-4-6', 'gpt-oss-120b',
] as const;

export function antigravityRuntimeModel(model: string, effort: ReasoningEffort): string {
    const low = effort === 'none' || effort === 'minimal' || effort === 'low';
    switch (model) {
        case 'gemini-3.8-flash':
        case 'gemini-3.7-flash': return `${model}-tiered`;
        case 'gemini-3.6-flash': return `${model}-${low ? 'low' : effort === 'medium' ? 'medium' : 'high'}`;
        case 'gemini-3.5-flash': return effort === 'none' || effort === 'minimal'
            ? `${model}-extra-low` : low || effort === 'medium' ? `${model}-low` : 'gemini-3-flash-agent';
        case 'gemini-3.1-pro': return low ? `${model}-low` : 'gemini-pro-agent';
        case 'claude-opus-4-6': return `${model}-thinking`;
        case 'gpt-oss-120b': return `${model}-medium`;
        default: return model;
    }
}

export function antigravityContextTokens(model: string): number {
    return model.startsWith('gpt-oss-') ? 262_144 : 1_048_576;
}

export function antigravityOutputTokens(model: string): number {
    return model.startsWith('claude-') ? 64_000
        : model.startsWith('gpt-oss-') ? 32_768
        : model.includes('pro') ? 65_535 : 65_536;
}
