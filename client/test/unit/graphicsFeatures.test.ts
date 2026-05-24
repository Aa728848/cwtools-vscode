import { expect } from 'chai';

const vscodeStub = {};

function loadGraphicsFeatures() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/graphicsFeatures') as typeof import('../../extension/graphicsFeatures');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('graphicsFeatures image path links', () => {
    let findImagePathSpansInLine: typeof import('../../extension/graphicsFeatures').findImagePathSpansInLine;
    let isImagePathLinkText: typeof import('../../extension/graphicsFeatures').isImagePathLinkText;

    before(() => {
        const graphicsFeatures = loadGraphicsFeatures();
        findImagePathSpansInLine = graphicsFeatures.findImagePathSpansInLine;
        isImagePathLinkText = graphicsFeatures.isImagePathLinkText;
    });

    it('finds quoted and unquoted image paths', () => {
        const quoted = findImagePathSpansInLine('texturefile = "gfx/interface/icons/test.dds"');
        expect(quoted).to.deep.equal([
            { path: 'gfx/interface/icons/test.dds', start: 15, end: 43 },
        ]);

        const unquoted = findImagePathSpansInLine('texturefile = gfx/interface/icons/test.png');
        expect(unquoted).to.deep.equal([
            { path: 'gfx/interface/icons/test.png', start: 14, end: 42 },
        ]);
    });

    it('ignores paths in comments', () => {
        const spans = findImagePathSpansInLine('# texturefile = "gfx/interface/icons/test.dds"');
        expect(spans).to.deep.equal([]);
    });

    it('identifies server document links that should be replaced by explorer links', () => {
        expect(isImagePathLinkText('gfx/interface/icons/test.dds')).to.equal(true);
        expect(isImagePathLinkText('"gfx/interface/icons/test.tga"')).to.equal(true);
        expect(isImagePathLinkText('interface/example.gfx')).to.equal(false);
    });
});
