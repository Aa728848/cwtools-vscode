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
    const block = 'country_event = { id = $ID$ }\n';

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-archetype-artifact-'));
        source = path.join(root, 'events', 'sample.txt');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, block + 'other_event = { id = other.1 }\n', 'utf8');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('stores only the verified definition block and scopes the opaque artifact', async () => {
        const store = new HostArchetypeArtifactStore(root);
        const artifact = await store.extract({ filePath: source, definitionIdentity: 'sample.1', definitionPath: source, placeholders, scopeId: 'run-1' }, async () => ({ content: block }));
        expect(artifact.artifactId).to.match(/^arch_[A-Za-z0-9_-]{32}$/);
        const output = await store.instantiate(artifact.artifactId, { '$ID$': { kind: 'identifier', value: 'sample.2' } }, 'run-1');
        expect(output).to.equal('country_event = { id = sample.2 }\n');
        expect(output).not.to.include('other_event');
        await expectFailure(() => store.instantiate(artifact.artifactId, {}, 'run-2'), /another session/);
    });

    it('rejects unverified identities, outside files, drift, expiry, and foreign ids', async () => {
        const store = new HostArchetypeArtifactStore(root);
        await expectFailure(() => store.extract({ filePath: source, definitionIdentity: 'forged', definitionPath: source, placeholders, scopeId: 'run-1' }, async () => undefined), /not verified/);
        const outside = path.join(path.dirname(root), path.basename(root) + '-outside.txt');
        fs.writeFileSync(outside, block, 'utf8');
        try { await expectFailure(() => store.extract({ filePath: outside, definitionIdentity: 'x', definitionPath: outside, placeholders, scopeId: 'run-1' }, async () => ({ content: block })), /workspace file/); }
        finally { fs.rmSync(outside, { force: true }); }
        const artifact = await store.extract({ filePath: source, definitionIdentity: 'sample.1', definitionPath: source, placeholders, scopeId: 'run-1' }, async () => ({ content: block }));
        fs.appendFileSync(source, '# drift\n');
        await expectFailure(() => store.instantiate(artifact.artifactId, { '$ID$': { kind: 'identifier', value: 'x' } }, 'run-1'), /hash drift/);
        await expectFailure(() => store.instantiate('arch_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {}, 'run-1'), /expired, unknown, or belongs/);
        let now = 0;
        const expiring = new HostArchetypeArtifactStore(root, () => now);
        const expiringArtifact = await expiring.extract({ filePath: source, definitionIdentity: 'sample.1', definitionPath: source, placeholders, scopeId: 'run-1' }, async () => ({ content: block }));
        now = 16 * 60 * 1000;
        await expectFailure(() => expiring.instantiate(expiringArtifact.artifactId, {}, 'run-1'), /expired, unknown, or belongs/);
    });
});
