import { expect } from 'chai';
import type { GuiSelectionContextData } from '../../shared/guiPreview';

const source = [
    'guiTypes = {',
    '    containerWindowType = {',
    '        name = "root"',
    '        buttonType = {',
    '            name = "confirm"',
    '            position = { x = 10 y = 20 }',
    '        }',
    '    }',
    '}',
].join('\n');

function context(): GuiSelectionContextData {
    return {
        uri: 'interface/test.gui', documentVersion: 3,
        elements: [{ path: '0.0', ancestors: ['root'], name: 'confirm', type: 'buttonType', line: 4, endLine: 7 }],
        region: { x: 1, y: 2, width: 30, height: 40 },
    };
}

describe('GUI selection prompt generation', () => {
    it('uses current source, hierarchy, region and off-canvas safety guidance', () => {
        const { buildGuiSelectionPrompt } = loadGuiContextModule();
        const prompt = buildGuiSelectionPrompt(source, context(), 4, false);
        expect(prompt).to.include('path=0.0');
        expect(prompt).to.include('name = "confirm"');
        expect(prompt).to.include('Marquee region');
        expect(prompt).to.include('off-canvas controls');
        expect(prompt).to.include('attached=3, current=4');
    });

    it('marks stale or ambiguous elements instead of guessing', () => {
        const { buildGuiSelectionPrompt } = loadGuiContextModule();
        const stale = { ...context(), elements: [{ ...context().elements[0]!, name: 'missing' }] };
        const prompt = buildGuiSelectionPrompt(source, stale, 3, true);
        expect(prompt).to.include('Stale or ambiguous GUI element');
        expect(prompt).to.include('unsaved changes');
    });

    it('bounds oversized source excerpts', () => {
        const { buildGuiSelectionPrompt } = loadGuiContextModule();
        const large = source.replace('position = { x = 10 y = 20 }', `position = { x = 10 y = 20 } # ${'x'.repeat(6000)}`);
        const prompt = buildGuiSelectionPrompt(large, context(), 3, false);
        expect(prompt).to.include('[truncated]');
        expect(prompt.length).to.be.lessThan(6500);
    });
});

function loadGuiContextModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return {};
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/guiContext') as typeof import('../../extension/ai/guiContext');
    } finally {
        moduleLoader._load = originalLoad;
    }
}
