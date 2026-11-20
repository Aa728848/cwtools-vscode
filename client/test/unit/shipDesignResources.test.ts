import { expect } from 'chai';
import { ShipDesignResourceLoader, shipDesignContentOrigin, type ShipDesignResourceSource } from '../../extension/shipDesign/resources';

class Source implements ShipDesignResourceSource {
    constructor(private readonly resolvableMeshes = true) {
        this.seed();
    }

    private readonly text = new Map<string, string>();
    private readonly binary = new Map<string, ArrayBuffer>();
    private seed(): void {
        this.text.set('gfx/models/ships/test.asset', [
            'entity = {',
            ' name = root_entity pdxmesh = root_mesh scale = 2 default_state = idle',
            ' locator = { name = part1 position = { 1 2 3 } rotation = { 0 0 0 } }',
            ' state = { name = idle locator = { name = gun1 position = { 4 5 6 } rotation = { 0 0 0 } } }',
            ' attach = { hardpoint = child_entity }',
            '}',
            'entity = { name = child_entity pdxmesh = child_mesh attach = { back = root_entity } }',
        ].join('\n'));
        this.text.set('gfx/models/ships/test.gfx', [
            'pdxmesh = { name = root_mesh file = "gfx/models/ships/root.mesh" scale = 3 }',
            'pdxmesh = { name = child_mesh file = "gfx/models/ships/child.mesh" }',
        ].join('\n'));
        this.text.set('gfx/models/ships/root_diffuse.dds', '');
        this.binary.set('gfx/models/ships/root.mesh', new Uint8Array([1, 2, 3]).buffer);
        this.binary.set('gfx/models/ships/child.mesh', new Uint8Array([4, 5]).buffer);
    }

    async readText(relativePath: string): Promise<string | undefined> {
        return this.text.get(relativePath.toLowerCase());
    }

    async readBinary(relativePath: string): Promise<ArrayBuffer | undefined> {
        return this.binary.get(relativePath.toLowerCase());
    }

    resolvePath(relativePath: string): string | undefined {
        const folded = relativePath.toLowerCase();
        if (this.binary.has(folded)) return this.resolvableMeshes ? '/absolute/' + relativePath : undefined;
        return this.text.has(folded) ? '/absolute/' + relativePath : undefined;
    }

    async listFiles(relativeDirectory: string): Promise<string[]> {
        const prefix = relativeDirectory.toLowerCase().replace(/\/$/, '') + '/';
        const children = new Set<string>();
        const collect = (path: string): void => {
            if (!path.startsWith(prefix)) return;
            const first = path.slice(prefix.length).split('/')[0];
            if (first) children.add(prefix + first);
        };
        for (const path of this.text.keys()) collect(path);
        for (const path of this.binary.keys()) collect(path);
        return [...children].sort();
    }
}

describe('ship design resource loader', () => {
    it('streams resolvable meshes by Webview URI instead of inlining their bytes', async () => {
        const loader = new ShipDesignResourceLoader(new Source(), absolute => 'webview://' + absolute);
        const result = await loader.load('ROOT_ENTITY');
        expect(result.asset.meshUri).to.equal('webview:///absolute/gfx/models/ships/root.mesh');
        expect(result.asset.meshBase64).to.equal(undefined);
        expect(result.asset.attaches[0]?.entity.meshUri).to.equal('webview:///absolute/gfx/models/ships/child.mesh');
        expect(result.warnings.join('\n')).not.to.contain('Mesh file not readable');
    });

    it('falls back to inline mesh bytes, flattened state locators, textures, scale and bounded attaches', async () => {
        const loader = new ShipDesignResourceLoader(new Source(false), absolute => 'webview://' + absolute);
        const result = await loader.load('ROOT_ENTITY');
        expect(result.asset.name).to.equal('root_entity');
        expect(result.asset.meshUri).to.equal(undefined);
        expect(result.asset.meshBase64).to.equal('AQID');
        expect(result.asset.scale).to.equal(6);
        expect(result.asset.locators.map(locator => locator.name)).to.deep.equal(['part1', 'gun1']);
        expect(result.asset.textureMap['root_diffuse.dds']).to.equal('webview:///absolute/gfx/models/ships/root_diffuse.dds');
        expect(result.asset.attaches).to.have.length(1);
        expect(result.asset.attaches[0]?.locatorName).to.equal('hardpoint');
        expect(result.asset.attaches[0]?.entity.name).to.equal('child_entity');
        expect(result.asset.attaches[0]?.entity.meshBase64).to.equal('BAU=');
        expect(result.asset.attaches[0]?.entity.attaches).to.have.length(0);
        expect(result.warnings.join('\n')).to.contain('Attach cycle skipped');
    });

    it('classifies resolved definition files as mod or vanilla content', () => {
        const roots = ['C:/Mods/MyMod'];
        expect(shipDesignContentOrigin('C:/Mods/MyMod/common/component_templates/a.txt', roots)).to.equal('mod');
        expect(shipDesignContentOrigin('D:/Game/Stellaris/common/component_templates/a.txt', roots)).to.equal('vanilla');
        expect(shipDesignContentOrigin('C:/Mods/MyModExtra/common/a.txt', roots)).to.equal('vanilla');
        expect(shipDesignContentOrigin(undefined, roots)).to.equal(undefined);
    });

    it('fails clearly for an unknown entity', async () => {
        const loader = new ShipDesignResourceLoader(new Source(), absolute => absolute);
        let error: unknown;
        try { await loader.load('MISSING_ENTITY'); } catch (caught) { error = caught; }
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.contain('Entity not found');
    });
});
