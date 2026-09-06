import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const vscodeStub = {
    Uri: {
        file: (fsPath: string) => ({
            fsPath,
            toString: () => `file://${fsPath.replace(/\\/g, '/')}`,
        }),
    },
    MarkdownString: class {
        isTrusted = false;
        value = '';
        appendMarkdown(val: string) { this.value += val; }
    },
    Hover: class {
        constructor(public contents: any, public range: any) {}
    },
    Range: class {
        constructor(public startLine: number, public startChar: number, public endLine: number, public endChar: number) {}
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

describe('graphicsFeatures image hover cache invalidation', () => {
    function createSampleTga(width: number, height: number): Buffer {
        const header = Buffer.alloc(18);
        header[2] = 2; // uncompressed true-color
        header.writeUInt16LE(width, 12);
        header.writeUInt16LE(height, 14);
        header[16] = 32; // 32 bpp
        header[17] = 8;
        const pixels = crypto.randomBytes(width * height * 4);
        return Buffer.concat([header, pixels]);
    }

    it('invalidates cache and cleans up old temp file when image file is modified or deleted', async () => {
        const graphicsFeatures = loadGraphicsFeatures();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-img-test-'));
        const imagePath = path.join(tmpDir, 'test_texture.tga');
        const range = new vscodeStub.Range(0, 0, 0, 10) as unknown as import('vscode').Range;

        try {
            // 1. Write initial 200x200 image (produces >50KB base64, triggers temp file creation)
            fs.writeFileSync(imagePath, createSampleTga(200, 200));
            const stat1 = fs.statSync(imagePath);

            const hover1 = graphicsFeatures.__test.createImageHover(imagePath, 'gfx/test_texture.tga', range);
            expect(hover1).to.not.be.null;
            const md1 = (hover1 as any).contents.value as string;
            expect(md1).to.include('cwt_prev_');

            // Extract temp file path 1
            const tempMatch1 = /cwt_prev_[a-f0-9_]+\.png/i.exec(md1);
            expect(tempMatch1).to.not.be.null;
            const tempFile1 = path.join(os.tmpdir(), tempMatch1![0]);
            expect(fs.existsSync(tempFile1)).to.equal(true);

            // 2. Modify image content and advance mtime
            const newMtime = new Date(stat1.mtimeMs + 2000);
            fs.writeFileSync(imagePath, createSampleTga(200, 200));
            fs.utimesSync(imagePath, newMtime, newMtime);

            const hover2 = graphicsFeatures.__test.createImageHover(imagePath, 'gfx/test_texture.tga', range);
            expect(hover2).to.not.be.null;
            const md2 = (hover2 as any).contents.value as string;

            // Extract temp file path 2
            const tempMatch2 = /cwt_prev_[a-f0-9_]+\.png/i.exec(md2);
            expect(tempMatch2).to.not.be.null;
            const tempFile2 = path.join(os.tmpdir(), tempMatch2![0]);

            // Must have generated a new versioned temp file path
            expect(tempFile2).to.not.equal(tempFile1);
            expect(fs.existsSync(tempFile2)).to.equal(true);
            // Old temp file must have been cleaned up
            expect(fs.existsSync(tempFile1)).to.equal(false);

            // 3. Delete image file
            fs.unlinkSync(imagePath);
            const hover3 = graphicsFeatures.__test.createImageHover(imagePath, 'gfx/test_texture.tga', range);
            expect(hover3).to.be.null;
            // Temp file must be cleaned up and cache removed
            expect(fs.existsSync(tempFile2)).to.equal(false);
            expect(graphicsFeatures.__test.imageCache.get(imagePath)).to.be.undefined;
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }
    });

    it('safely runs cleanupOldTempFiles without throwing on locked or missing files', () => {
        const graphicsFeatures = loadGraphicsFeatures();
        expect(() => graphicsFeatures.__test.cleanupOldTempFiles()).to.not.throw();
    });
});

