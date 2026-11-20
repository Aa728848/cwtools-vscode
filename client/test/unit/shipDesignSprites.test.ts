import { expect } from 'chai';
import { ShipDesignSpriteResolver } from '../../extension/shipDesign/sprites';

class Source {
    private readonly files = new Map<string, string>([
        ['interface/icons.gfx', [
            'spriteTypes = {',
            ' spriteType = { name = GFX_TEST texturefile = "gfx/icons/test.png" }',
            ' spriteType = { name = GFX_SHEET texturefile = "gfx/icons/sheet.png" noOfFrames = 3 }',
            ' spriteType = { name = GFX_FRAME sprite_sheet_sprite_type = GFX_SHEET default_frame = 2 }',
            '}',
        ].join('\n')],
    ]);
    async readText(path: string): Promise<string | undefined> { return this.files.get(path.toLowerCase()); }
    async readBinary(): Promise<ArrayBuffer> { return new Uint8Array([1, 2, 3]).buffer; }
    resolvePath(path: string): string { return '/virtual/' + path; }
    async listFiles(directory: string): Promise<string[]> {
        const prefix = directory.toLowerCase() + '/';
        return [...this.files.keys()].filter(path => path.startsWith(prefix));
    }
}

describe('ship design sprite resolver', () => {
    it('decodes direct sprites and resolves sheet frames without filesystem access in Webview', async () => {
        const resolver = new ShipDesignSpriteResolver(new Source());
        const direct = await resolver.resolve('GFX_TEST');
        expect(direct?.uri).to.equal('data:image/png;base64,AQID');
        expect(direct?.frames).to.equal(1);
        const frame = await resolver.resolve('GFX_FRAME');
        expect(frame?.frames).to.equal(3);
        expect(frame?.frame).to.equal(2);
        expect(frame?.uri).to.equal('data:image/png;base64,AQID');
        const missing = await resolver.resolve('GFX_MISSING');
        expect(missing?.uri).to.equal(undefined);
    });
});
