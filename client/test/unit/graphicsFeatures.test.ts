import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeStub = {
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
    },
};

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

describe('graphicsFeatures GFX sprite scan', () => {
    it('continues scanning vanilla files when the workspace sprite index is already large', async () => {
        const graphicsFeatures = loadGraphicsFeatures();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-gfx-'));

        try {
            const interfaceDir = path.join(tmp, 'interface');
            fs.mkdirSync(interfaceDir, { recursive: true });
            fs.writeFileSync(
                path.join(interfaceDir, 'vanilla.gfx'),
                [
                    'spriteTypes = {',
                    '  spriteType = {',
                    '    name = "GFX_vanilla_preview"',
                    '    texturefile = "gfx/interface/icons/vanilla.dds"',
                    '  }',
                    '}',
                ].join('\n'),
                'utf8',
            );

            const map = new Map<string, any>();
            for (let i = 0; i < 600; i++) {
                map.set(`GFX_workspace_${i}`, { name: `GFX_workspace_${i}`, uri: { fsPath: 'workspace.gfx' }, line: 0 });
            }

            await graphicsFeatures.__test.scanDirForGfx(tmp, map, { count: 0 }, 10);

            expect(map.get('GFX_vanilla_preview')?.texturefile).to.equal('gfx/interface/icons/vanilla.dds');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
