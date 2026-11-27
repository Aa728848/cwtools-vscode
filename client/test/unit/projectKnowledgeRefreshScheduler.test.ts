import { expect } from 'chai';
import sinon from 'sinon';
import { ProjectKnowledgeRefreshScheduler } from '../../extension/projectKnowledgeRefreshScheduler';

describe('ProjectKnowledgeRefreshScheduler', () => {
    let clock: sinon.SinonFakeTimers;
    let scheduler: ProjectKnowledgeRefreshScheduler | undefined;

    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => {
        scheduler?.dispose();
        scheduler = undefined;
        clock.restore();
    });

    it('coalesces changed files and ignores an already published fingerprint', async () => {
        const calls: Array<{ full: boolean; files: string[] }> = [];
        scheduler = new ProjectKnowledgeRefreshScheduler(async (full, files) => {
            calls.push({ full, files });
            return true;
        }, 20, 100);
        scheduler.scheduleFile('events/b.txt', 'b1');
        scheduler.scheduleFile('events/a.txt', 'a1');
        scheduler.scheduleFile('events/a.txt', 'a1');
        await clock.tickAsync(20);
        expect(calls).to.deep.equal([{ full: false, files: ['events/a.txt', 'events/b.txt'] }]);
        scheduler.scheduleFile('events/a.txt', 'a1');
        await clock.tickAsync(120);
        expect(calls).to.have.length(1);
    });

    it('keeps a failed batch pending without retrying until another event', async () => {
        let attempts = 0;
        scheduler = new ProjectKnowledgeRefreshScheduler(async () => {
            attempts++;
            return attempts > 1;
        }, 20, 100);
        scheduler.scheduleFile('events/a.txt', 'a1');
        await clock.tickAsync(20);
        await clock.tickAsync(150);
        expect(attempts).to.equal(1);
        scheduler.scheduleFile('events/a.txt', 'a1');
        await clock.tickAsync(20);
        expect(attempts).to.equal(2);
        scheduler.scheduleFile('events/a.txt', 'a1');
        await clock.tickAsync(100);
        expect(attempts).to.equal(2);
    });

    it('flushes at the maximum wait even when events keep resetting the trailing timer', async () => {
        let calls = 0;
        scheduler = new ProjectKnowledgeRefreshScheduler(async () => { calls++; return true; }, 30, 60);
        scheduler.scheduleFile('events/a.txt', 'a0');
        for (let index = 1; index <= 3; index++) {
            await clock.tickAsync(20);
            if (index < 3) scheduler.scheduleFile('events/a.txt', 'a' + index);
        }
        expect(calls).to.equal(1);
    });

    it('preserves a full refresh requested while an incremental refresh is running', async () => {
        const calls: boolean[] = [];
        let release: ((value: boolean) => void) | undefined;
        scheduler = new ProjectKnowledgeRefreshScheduler(async full => {
            calls.push(full);
            if (calls.length === 1) return await new Promise<boolean>(resolve => { release = resolve; });
            return true;
        }, 20, 100);
        scheduler.scheduleFile('events/a.txt', 'a1');
        await clock.tickAsync(20);
        scheduler.scheduleFull();
        release?.(true);
        await clock.tickAsync(0);
        await clock.tickAsync(20);
        expect(calls).to.deep.equal([false, true]);
    });

    it('coalesces repeated deletion notifications after a successful export', async () => {
        let calls = 0;
        scheduler = new ProjectKnowledgeRefreshScheduler(async () => { calls++; return true; }, 20, 100);
        scheduler.scheduleFile('events/a.txt', null);
        await clock.tickAsync(20);
        scheduler.scheduleFile('events/a.txt', null);
        await clock.tickAsync(100);
        expect(calls).to.equal(1);
    });
});
