import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HostArchetypeArtifactStore } from '../../extension/ai/tools/archetypeArtifacts';

function expectFailure(operation: () => Promise<unknown>, pattern: RegExp): Promise<void> {
    return operation().then(
        () => { throw new Error('Expected archetype artifact operation to fail.'); },
        error => { expect(error instanceof Error ? error.message : String(error)).to.match(pattern); },
    );
}

describe('host archetype artifacts', () => {
    let root: string;
    let source: string;
    const placeholders = { '$ID$': 'identifier' as const };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-archetype-artifact-'));
        source = path.join(root, 'events', 'sample.txt');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, 'country_event = { id = $ID$ }\n', 'utf8');
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('creates an opaque artifact and instantiates typed values from its verified workspace source', async () => {
        const store = new HostArchetypeArtifactStore(root);
        const artifact = await store.extract({
            filePath: 'events/sample.txt', definitionIdentity: 'sample.1', definitionPath: 'events/sample.txt', placeholders,
        }, async (identity, canonicalPath) => identity === 'sample.1' && canonicalPath === fs.realpathSync(source));

        expect(artifact.artifactId).to.match(/^arch_[A-Za-z0-9_-]{32}$/);
        expect(artifact).not.to.have.property('text');
        expect(artifact.definitionPath).to.equal('events/sample.txt');
        expect(await store.instantiate(artifact.artifactId, { '$ID$': { kind: 'identifier', value: 'sample.2' } }))
            .to.equal('country_event = { id = sample.2 }\n');
    });

    it('rejects unverified identities, outside files, drift, expiry, and foreign artifact ids', async () => {
        const store = new HostArchetypeArtifactStore(root);
        await expectFailure(() => store.extract({
            filePath: 'events/sample.txt', definitionIdentity: 'forged', definitionPath: 'events/sample.txt', placeholders,
        }, async () => false), /not verified/);

        const outside = path.join(path.dirname(root), path.basename(root) + '-outside.txt');
        fs.writeFileSync(outside, 'x = $ID$\n', 'utf8');
        try {
            await expectFailure(() => store.extract({ filePath: outside, definitionIdentity: 'x', definitionPath: outside, placeholders }, async () => true), /workspace file/);
        } finally { fs.rmSync(outside, { force: true }); }

        const artifact = await store.extract({ filePath: source, definitionIdentity: 'sample.1', definitionPath: source, placeholders }, async () => true);
        fs.appendFileSync(source, '# drift\n');
        await expectFailure(() => store.instantiate(artifact.artifactId, { '$ID$': { kind: 'identifier', value: 'x' } }), /hash drift/);
        await expectFailure(() => store.instantiate('arch_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {}), /expired, unknown, or belongs/);

        let now = 0;
        const expiring = new HostArchetypeArtifactStore(root, () => now);
        const expiringArtifact = await expiring.extract({ filePath: source, definitionIdentity: 'sample.1', definitionPath: source, placeholders }, async () => true);
        now = 16 * 60 * 1000;
        await expectFailure(() => expiring.instantiate(expiringArtifact.artifactId, {}), /expired, unknown, or belongs/);
    });
});
