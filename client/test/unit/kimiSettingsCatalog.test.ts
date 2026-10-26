import { expect } from 'chai';
import {
    kimiCatalogReasoningCapability,
    parseKimiCatalog,
    preferDeclaredReasoningCapability,
} from '../../extension/ai/kimi/catalog';
import type { ModelReasoningCapability } from '../../extension/ai/types';

/**
 * The settings page resolves one capability map for every provider/model pair and then
 * normalises the current model through it. These tests hold that pipeline to the same
 * precedence the page uses, without booting the extension host.
 */

const K31_STATIC: ModelReasoningCapability = { kind: 'effort', options: ['low', 'high', 'max'], defaultValue: 'max' };
const FOR_CODING_STATIC: ModelReasoningCapability = { kind: 'fixed', options: ['high'], defaultValue: 'high' };
/** What the static table says about an id it has never heard of. */
const STATIC_UNKNOWN: ModelReasoningCapability = { kind: 'none', options: ['none'], defaultValue: 'none' };

function key(providerId: string, model: string): string {
    return `${providerId}:${model}`;
}

function staticAnswer(modelId: string): ModelReasoningCapability {
    if (modelId === 'k3.1-pro' || modelId === 'k3.1-pro-highspeed') return K31_STATIC;
    if (modelId === 'kimi-for-coding') return FOR_CODING_STATIC;
    return STATIC_UNKNOWN;
}

/**
 * Mirrors `buildAndSendSettingsData`: the static answer is seeded for every selectable
 * model, the catalog overrides it where it declares something, and the current model is
 * resolved from the finished map.
 */
function settingsCapabilities(catalog: ReturnType<typeof parseKimiCatalog>) {
    const capabilities: Record<string, ModelReasoningCapability> = {};
    for (const modelId of ['k3.1-pro', 'k3.1-pro-highspeed', 'kimi-for-coding', 'k3.2-nova']) {
        capabilities[key('kimi-code-plan', modelId)] = staticAnswer(modelId);
    }
    for (const entry of catalog) {
        const slot = key('kimi-code-plan', entry.id);
        const declared = kimiCatalogReasoningCapability(entry, capabilities[slot]);
        if (declared === undefined) continue;
        capabilities[slot] = declared;
    }
    return capabilities;
}

function currentCapability(
    capabilities: Record<string, ModelReasoningCapability>,
    model: string,
): ModelReasoningCapability {
    return preferDeclaredReasoningCapability(
        capabilities,
        key('kimi-code-plan', model),
        staticAnswer(model),
    );
}

describe('kimi settings reasoning capability', () => {
    it('normalises the current model through the dynamic map, not a static re-lookup', () => {
        const catalog = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 262_144,
            supports_thinking_type: 'no',
        }]);
        const capabilities = settingsCapabilities(catalog);
        expect(capabilities[key('kimi-code-plan', 'k3.1-pro')]).to.deep.equal({
            kind: 'none',
            options: ['none'],
            defaultValue: 'none',
        });
        // The static table would still say max effort; the current model must not.
        expect(currentCapability(capabilities, 'k3.1-pro')).to.deep.equal({
            kind: 'none',
            options: ['none'],
            defaultValue: 'none',
        });
        expect(staticAnswer('k3.1-pro').defaultValue).to.equal('max');
    });

    it('does not let a static NO_REASONING mislabel a freshly declared dynamic model', () => {
        const catalog = parseKimiCatalog([{
            id: 'k3.2-nova',
            context_length: 1_048_576,
            supports_thinking_type: 'only',
            think_efforts: { valid_efforts: ['low', 'high', 'max'] },
        }]);
        const capabilities = settingsCapabilities(catalog);
        const resolved = currentCapability(capabilities, 'k3.2-nova');
        expect(resolved.kind).to.equal('effort');
        expect(resolved.options).to.deep.equal(['low', 'high', 'max']);
        // No static default exists for this id, so the ladder's own preference applies.
        expect(resolved.defaultValue).to.equal('high');
    });

    it('inherits the static default for a live ladder that omits one', () => {
        const catalog = parseKimiCatalog([{
            id: 'k3.1-pro',
            context_length: 262_144,
            supports_thinking_type: 'only',
            think_efforts: { valid_efforts: ['low', 'high', 'max'] },
        }]);
        const resolved = currentCapability(settingsCapabilities(catalog), 'k3.1-pro');
        expect(resolved).to.deep.equal({ kind: 'effort', options: ['low', 'high', 'max'], defaultValue: 'max' });
    });

    it('keeps the static answer for a silent catalog entry', () => {
        const catalog = parseKimiCatalog([{ id: 'kimi-for-coding', context_length: 1_048_576 }]);
        expect(currentCapability(settingsCapabilities(catalog), 'kimi-for-coding')).to.deep.equal(FOR_CODING_STATIC);
    });

    it('keeps the static answer for an empty declared ladder instead of inventing a level', () => {
        // An empty list is not a denial of thinking: the page must not show a fabricated
        // toggle of none/high that the service never offered.
        const catalog = parseKimiCatalog([{ id: 'k3.1-pro', context_length: 262_144, reasoning_options: [] }]);
        expect(currentCapability(settingsCapabilities(catalog), 'k3.1-pro')).to.deep.equal(K31_STATIC);
    });

    it('falls back to the static answer when no dynamic entry exists at all', () => {
        expect(preferDeclaredReasoningCapability(undefined, key('kimi-code-plan', 'k3.1-pro'), K31_STATIC))
            .to.deep.equal(K31_STATIC);
        expect(preferDeclaredReasoningCapability({}, key('kimi-code-plan', 'k3.1-pro'), K31_STATIC))
            .to.deep.equal(K31_STATIC);
        // Only the exact provider:model key counts; a neighbour's ladder is not inherited.
        expect(preferDeclaredReasoningCapability(
            { [key('kimi', 'k3.1-pro')]: { kind: 'none', options: ['none'], defaultValue: 'none' } },
            key('kimi-code-plan', 'k3.1-pro'),
            K31_STATIC,
        )).to.deep.equal(K31_STATIC);
    });
});
