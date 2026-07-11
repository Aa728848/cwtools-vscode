import { expect } from 'chai';
import sinon from 'sinon';
import { QuickPickSelectionGuard } from '../../extension/quickPickSelectionGuard';

describe('QuickPickSelectionGuard', () => {
    it('ignores transient empty selections until the rebuilt selection is restored', () => {
        const guard = new QuickPickSelectionGuard();
        guard.beginProgrammaticUpdate(['category:CW240', 'key:a']);
        expect(guard.shouldIgnore([])).to.equal(true);
        expect(guard.active).to.equal(true);
        expect(guard.shouldIgnore(['category:CW240', 'key:a'])).to.equal(true);
        expect(guard.active).to.equal(false);
        expect(guard.shouldIgnore([])).to.equal(false);
    });

    it('releases the guard after the UI round-trip timeout', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const guard = new QuickPickSelectionGuard();
            guard.beginProgrammaticUpdate(['key:a']);
            expect(guard.active).to.equal(true);
            await clock.tickAsync(99);
            expect(guard.active).to.equal(true);
            await clock.tickAsync(1);
            expect(guard.active).to.equal(false);
        } finally {
            clock.restore();
        }
    });

    it('extends the guard when another rebuild occurs before selection settles', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const guard = new QuickPickSelectionGuard();
            guard.beginProgrammaticUpdate(['key:a']);
            guard.beginProgrammaticUpdate(['key:b']);
            expect(guard.active).to.equal(true);
            expect(guard.shouldIgnore(['key:a'])).to.equal(true);
            expect(guard.active).to.equal(true);
            expect(guard.shouldIgnore(['key:b'])).to.equal(true);
            expect(guard.active).to.equal(false);
        } finally {
            clock.restore();
        }
    });
});
