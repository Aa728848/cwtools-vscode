import { expect } from 'chai';
import { ScopedTodoStore } from '../../extension/ai/tools/scopedTodoStore';

describe('ScopedTodoStore', () => {
    it('keeps child Agent todos from replacing root todos', () => {
        const store = new ScopedTodoStore();
        store.set([{ id: 'root-1', content: 'Root task', status: 'in_progress' }]);
        store.set([{ id: 'child-1', content: 'Child task', status: 'pending' }], 'worker-a');

        expect(store.get()).to.deep.equal([
            { id: 'root-1', content: 'Root task', status: 'in_progress' },
        ]);
        expect(store.get('worker-a')).to.deep.equal([
            { id: 'child-1', content: 'Child task', status: 'pending' },
        ]);
    });

    it('clears only the requested Agent scope', () => {
        const store = new ScopedTodoStore();
        store.set([{ id: 'root-1', content: 'Root task', status: 'pending' }]);
        store.set([{ id: 'child-1', content: 'Child task', status: 'done' }], 'worker-a');

        store.clear('worker-a');

        expect(store.get('worker-a')).to.deep.equal([]);
        expect(store.get()).to.have.length(1);
    });

    it('returns defensive copies', () => {
        const store = new ScopedTodoStore();
        store.set([{ id: 'root-1', content: 'Root task', status: 'pending' }]);

        const snapshot = store.get();
        snapshot[0]!.status = 'done';

        expect(store.get()[0]!.status).to.equal('pending');
    });
});
