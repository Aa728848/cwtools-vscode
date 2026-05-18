import { expect } from 'chai';
import { ArtifactStore } from '../../extension/ai/artifactStore';

describe('ArtifactStore', () => {
    it('builds stable artifact ids with topic and sanitized key', () => {
        const store = new ArtifactStore(() => 'topic-1');
        const id = store.buildId('plan', 'foo/bar baz.md');
        expect(id).to.equal('topic-1:plan:foo_bar_baz.md');
    });

    it('keeps createdAt on upsert and sorts by createdAt desc', () => {
        const store = new ArtifactStore(() => 'topic');
        const originalNow = Date.now;
        let tick = 1000;
        Date.now = () => tick++;
        try {
            store.upsert({ id: 'a', kind: 'plan', title: 'A', createdAt: 10 });
            store.upsert({ id: 'b', kind: 'plan', title: 'B', createdAt: 20 });
            store.upsert({ id: 'a', kind: 'plan', title: 'A2' });

            const list = store.list();
            expect(list.map(x => x.id)).to.deep.equal(['b', 'a']);
            expect(list.find(x => x.id === 'a')?.createdAt).to.equal(10);
            expect(list.find(x => x.id === 'a')?.title).to.equal('A2');
        } finally {
            Date.now = originalNow;
        }
    });

    it('clears all artifacts', () => {
        const store = new ArtifactStore(() => 'topic');
        store.upsert({ id: 'a', kind: 'plan', title: 'A' });
        expect(store.size).to.equal(1);
        const emptied = store.clear();
        expect(emptied).to.deep.equal([]);
        expect(store.size).to.equal(0);
    });
});
