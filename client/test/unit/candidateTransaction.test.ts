import { expect } from 'chai';
import { CandidateTransactionManager, sha256, CandidateFile } from '../../extension/ai/runner/candidateTransaction';

describe('CandidateTransactionManager', () => {
    const disk = new Map<string, string>([['a.txt', 'A'], ['b.txt', 'B']]);
    const host = (writes: string[] = [], validate = true) => ({
        readDisk: (p: string) => disk.get(p) ?? '',
        writeDisk: (p: string, c: string) => { writes.push(p); disk.set(p, c); },
        validateDisk: (_files: readonly CandidateFile[]) => validate,
    });
    afterEach(() => { disk.clear(); disk.set('a.txt', 'A'); disk.set('b.txt', 'B'); });

    it('stages bounded UTF-8 candidates and sorts paths at commit', async () => {
        const writes: string[] = []; const tx = new CandidateTransactionManager({ maxFiles: 2, maxBytes: 3 }); tx.begin();
        tx.stage('b.txt', 'é'); tx.stage('a.txt', 'x'); tx.validate(true);
        const result = await tx.commit(host(writes));
        expect(result.committed).to.equal(true); expect(result.state).to.equal('committed'); expect(writes).to.deep.equal(['a.txt', 'b.txt']); expect(tx.bytes).to.equal(3); expect(tx.files[0]?.contentHash).to.equal(sha256('x'));
    });
    it('rejects limits and enforces one active transaction', () => { const tx = new CandidateTransactionManager({ maxFiles: 1, maxBytes: 2 }); tx.begin(); expect(() => tx.begin()).to.throw('already active'); expect(() => tx.stage('a', 'abc')).to.throw('byte limit'); tx.discard(); expect(tx.state).to.equal('discarded'); });
    it('rejects external disk drift before any write', async () => { const writes: string[] = []; const tx = new CandidateTransactionManager(); tx.begin(); tx.stage('a.txt', 'new', sha256('A')); disk.set('a.txt', 'changed'); tx.validate(true); const result = await tx.commit(host(writes)); expect(result.committed).to.equal(false); expect(result.error).to.include('External disk drift'); expect(writes).to.deep.equal([]); });
    it('rolls back all writes when post-commit validation fails', async () => { const writes: string[] = []; const tx = new CandidateTransactionManager(); tx.begin(); tx.stage('a.txt', 'new A', sha256('A')); tx.stage('b.txt', 'new B', sha256('B')); tx.validate(true); const result = await tx.commit(host(writes, false)); expect(result.committed).to.equal(false); expect(result.rollback.succeeded).to.equal(true); expect(result.rollback.paths).to.deep.equal(['a.txt', 'b.txt']); expect(disk.get('a.txt')).to.equal('A'); expect(disk.get('b.txt')).to.equal('B'); expect(tx.state).to.equal('discarded'); });
    it('rolls back a host write that mutates and then throws', async () => {
        const tx = new CandidateTransactionManager();
        tx.begin();
        tx.stage('a.txt', 'new A', sha256('A'));
        tx.validate(true);
        const result = await tx.commit({
            readDisk: path => disk.get(path) ?? '',
            writeDisk: (path, content) => {
                disk.set(path, content);
                if (content === 'new A') throw new Error('partial host failure');
            },
        });
        expect(result.committed).to.equal(false);
        expect(result.rollback.attempted).to.equal(true);
        expect(disk.get('a.txt')).to.equal('A');
    });

    it('deletes a newly created file when post-commit validation fails', async () => {
        const tx = new CandidateTransactionManager();
        tx.begin();
        tx.stage('new.txt', 'new content');
        tx.validate(true);
        const result = await tx.commit({
            readDisk: path => disk.get(path) ?? '',
            writeDisk: (path, content) => { disk.set(path, content); },
            deleteDisk: path => { disk.delete(path); },
            validateDisk: () => false,
        });
        expect(result.committed).to.equal(false);
        expect(disk.has('new.txt')).to.equal(false);
    });

    it('marks rollback incomplete when semantic recovery does not become fresh', async () => {
        const tx = new CandidateTransactionManager();
        tx.begin();
        tx.stage('a.txt', 'new A', sha256('A'));
        tx.validate(true);
        const result = await tx.commit({
            readDisk: path => disk.get(path) ?? '',
            writeDisk: (path, content) => { disk.set(path, content); },
            validateDisk: () => false,
            afterRollback: () => ({ ok: false, error: 'LSP recovery pending' }),
        });
        expect(result.committed).to.equal(false);
        expect(result.rollback.succeeded).to.equal(false);
        expect(result.rollback.errors[0]?.error).to.include('LSP recovery');
        expect(tx.state).to.equal('active');
    });

    it('does not write when validation is false and supports discard', async () => { const writes: string[] = []; const tx = new CandidateTransactionManager(); tx.begin(); tx.stage('a.txt', 'new'); tx.validate(false); const result = await tx.commit(host(writes)); expect(result.committed).to.equal(false); expect(writes).to.deep.equal([]); expect(tx.state).to.equal('discarded'); });
});
