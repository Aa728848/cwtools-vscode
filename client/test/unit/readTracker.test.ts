import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTracker } from '../../extension/ai/runner/readTracker';

describe('ReadTracker path-key normalization', () => {
    let tmpDir: string;
    let filePath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readtracker-test-'));
        filePath = path.join(tmpDir, 'common', 'events', 'test_events.txt');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'country_event = {\n\tid = test.1\n}\n', 'utf-8');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('blocks writes to files never read', () => {
        const tracker = new ReadTracker();
        const check = tracker.canWrite(filePath);
        expect(check.ok).to.equal(false);
        expect(check.reason).to.contain('was not read');
    });

    it('allows writes after markRead with the identical path', () => {
        const tracker = new ReadTracker();
        tracker.markRead(filePath);
        expect(tracker.canWrite(filePath).ok).to.equal(true);
    });

    it('matches forward-slash reads against native-separator writes', () => {
        const tracker = new ReadTracker();
        tracker.markRead(filePath.replace(/\\/g, '/'));
        expect(tracker.canWrite(filePath).ok).to.equal(true);
    });

    it('matches native-separator reads against forward-slash writes', () => {
        const tracker = new ReadTracker();
        tracker.markRead(filePath);
        expect(tracker.canWrite(filePath.replace(/\\/g, '/')).ok).to.equal(true);
    });

    if (process.platform === 'win32') {
        it('matches paths differing only in drive-letter case (win32)', () => {
            const tracker = new ReadTracker();
            const upper = filePath.charAt(0).toUpperCase() + filePath.slice(1);
            const lower = filePath.charAt(0).toLowerCase() + filePath.slice(1);
            tracker.markRead(upper);
            expect(tracker.canWrite(lower).ok).to.equal(true);
        });
    }

    it('blocks writes after external modification (mtime changed)', () => {
        const tracker = new ReadTracker();
        tracker.markRead(filePath);
        // Force a different mtime regardless of filesystem timestamp resolution
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, future, future);
        const check = tracker.canWrite(filePath);
        expect(check.ok).to.equal(false);
        expect(check.reason).to.contain('modified externally');
    });

    it('markWritten refreshes the record so follow-up edits pass', () => {
        const tracker = new ReadTracker();
        tracker.markRead(filePath);
        fs.writeFileSync(filePath, 'changed = yes\n', 'utf-8');
        tracker.markWritten(filePath.replace(/\\/g, '/'));
        expect(tracker.canWrite(filePath).ok).to.equal(true);
    });

    it('invalidate removes the record across path formats', () => {
        const tracker = new ReadTracker();
        tracker.markRead(filePath);
        tracker.invalidate(filePath.replace(/\\/g, '/'));
        expect(tracker.canWrite(filePath).ok).to.equal(false);
    });

    it('allows writes to files that do not exist yet (new file creation)', () => {
        const tracker = new ReadTracker();
        expect(tracker.canWrite(path.join(tmpDir, 'new_file.txt')).ok).to.equal(true);
    });
});
