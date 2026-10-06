import { expect } from 'chai';
import {
    COMMAND_CODE_DISABLED_EFFORT,
    COMMAND_CODE_MODELS,
    commandCodeInputModalities,
    commandCodeModelDef,
    commandCodeModelSupportsImage,
    commandCodeReasoningEfforts,
    commandCodeWireEffort,
} from '../../extension/ai/commandcode/modelCapabilities';
import { getProvider } from '../../extension/ai/providers';

describe('Command Code capability table', () => {
    it('describes a full registry rather than the models someone happened to use', () => {
        // The table is transcribed from the official CLI's registry; a thin table
        // silently strips image input and the effort selector from real models.
        expect(COMMAND_CODE_MODELS.length).to.be.greaterThan(50);
        const ids = COMMAND_CODE_MODELS.map(model => model.id);
        expect(new Set(ids).size).to.equal(ids.length);
    });

    // The public catalog and the CLI registry spell one model differently; a
    // user picking the catalog's id must not silently lose its capabilities.
    it('resolves a free-tier id onto its registry entry', () => {
        expect(commandCodeModelDef('meituan/LongCat-2.0:free')).to.equal(commandCodeModelDef('meituan/LongCat-2.0'));
        expect(commandCodeModelSupportsImage('meituan/LongCat-2.0:free'))
            .to.equal(commandCodeModelSupportsImage('meituan/LongCat-2.0'));
        // An unknown id still resolves to nothing, suffix or not.
        expect(commandCodeModelDef('unlisted/vendor:free')).to.equal(undefined);
    });

    it('covers every model the provider advertises', () => {
        // A shipped model missing from the table loses its capabilities, so the
        // two lists must not drift apart.
        const missing = getProvider('commandcode').models.filter(id => commandCodeModelDef(id) === undefined);
        expect(missing).to.deep.equal([]);
    });

    // The registry's own example of why a family test cannot decide modalities:
    // the same vendor serves a text-only model and a vision model.
    it('decides modalities per exact id, not by vendor or name', () => {
        expect(commandCodeModelSupportsImage('deepseek/deepseek-v4-flash')).to.equal(false);
        expect(commandCodeModelSupportsImage('deepseek/deepseek-v4.1-flash')).to.equal(true);
        expect(commandCodeModelSupportsImage('deepseek/deepseek-v4-flash-vision-exp')).to.equal(true);
        expect(commandCodeModelSupportsImage('z-ai/glm-5.3-flash')).to.equal(true);
        expect(commandCodeModelSupportsImage('zai-org/GLM-5.3')).to.equal(false);
    });

    // An unknown id must claim as little as possible: a false "images accepted"
    // sends bytes to a request the endpoint rejects.
    it('falls back to text-only with no ladder for an unknown id', () => {
        expect(commandCodeInputModalities('unlisted/vendor-model')).to.deep.equal(['text']);
        expect(commandCodeModelSupportsImage('unlisted/vendor-model')).to.equal(false);
        expect(commandCodeReasoningEfforts('unlisted/vendor-model')).to.deep.equal([]);
        expect(commandCodeModelDef('unlisted/vendor-model')).to.equal(undefined);
    });

    // The registry spells "do not think" as off and DSH spells it none; the
    // registry value must never be advertised, or the picker offers a level DSH
    // cannot express.
    it('translates the registry off level into none and never advertises off', () => {
        const withOff = COMMAND_CODE_MODELS.filter(model => model.reasoningEfforts.includes('off'));
        expect(withOff.length).to.be.greaterThan(0);
        for (const model of withOff) {
            const advertised = commandCodeReasoningEfforts(model.id);
            expect(advertised).to.include(COMMAND_CODE_DISABLED_EFFORT);
            expect(advertised).to.not.include('off' as never);
        }
    });

    // The OpenAI-family wire has no off level, so it is expressed by omitting
    // the field — which is exactly what the official CLI does.
    it('drops the disabled level from the wire instead of sending it', () => {
        expect(commandCodeWireEffort('none')).to.equal(undefined);
        expect(commandCodeWireEffort('off')).to.equal(undefined);
        expect(commandCodeWireEffort('')).to.equal(undefined);
        expect(commandCodeWireEffort(undefined)).to.equal(undefined);
        expect(commandCodeWireEffort('high')).to.equal('high');
        expect(commandCodeWireEffort('max')).to.equal('max');
    });

    it('records a context window for the models the registry pins one on', () => {
        expect(commandCodeModelDef('moonshotai/Kimi-K3')!.contextWindow).to.equal(1_000_000);
        expect(commandCodeModelDef('z-ai/glm-5.3-flash')!.contextWindow).to.equal(1_048_576);
        // The registry leaves the output cap unstated for many models.
        expect(commandCodeModelDef('moonshotai/Kimi-K3')!.maxTokens).to.equal(null);
    });
});
