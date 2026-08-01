import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    decodeTechTreePngDataUri,
    normalizeTechTreeLine,
    resolveAllowedTechTreeSourcePath,
} from '../../extension/techTreeSafety';

describe('Tech tree Webview input safety', () => {
    let tempRoot: string;
    let allowedRoot: string;
    let outsideRoot: string;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-tech-tree-safety-'));
        allowedRoot = path.join(tempRoot, 'workspace');
        outsideRoot = path.join(tempRoot, 'outside');
        fs.mkdirSync(allowedRoot);
        fs.mkdirSync(outsideRoot);
        fs.writeFileSync(path.join(allowedRoot, 'inside.txt'), 'inside');
        fs.writeFileSync(path.join(outsideRoot, 'outside.txt'), 'outside');
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('resolves files only within configured roots', () => {
        const inside = path.join(allowedRoot, 'inside.txt');
        const outside = path.join(outsideRoot, 'outside.txt');
        expect(resolveAllowedTechTreeSourcePath('inside.txt', [allowedRoot])).to.equal(fs.realpathSync(inside));
        expect(resolveAllowedTechTreeSourcePath(inside, [allowedRoot])).to.equal(fs.realpathSync(inside));
        expect(resolveAllowedTechTreeSourcePath('../outside/outside.txt', [allowedRoot])).to.equal(undefined);
        expect(resolveAllowedTechTreeSourcePath(outside, [allowedRoot])).to.equal(undefined);
        expect(resolveAllowedTechTreeSourcePath({ path: inside }, [allowedRoot])).to.equal(undefined);
    });

    it('rejects symlink and junction escapes', function (this: Mocha.Context) {
        const link = path.join(allowedRoot, 'outside-link');
        try {
            fs.symlinkSync(outsideRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') this.skip();
            throw error;
        }
        expect(resolveAllowedTechTreeSourcePath('outside-link/outside.txt', [allowedRoot])).to.equal(undefined);
    });

    it('accepts bounded PNG data and rejects malformed or oversized payloads', () => {
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const dataUri = `data:image/png;base64,${signature.toString('base64')}`;
        expect(decodeTechTreePngDataUri(dataUri, signature.length)).to.deep.equal(signature);
        expect(decodeTechTreePngDataUri(dataUri, signature.length - 1)).to.equal(undefined);
        expect(decodeTechTreePngDataUri('data:image/png;base64,ZmFrZQ==')).to.equal(undefined);
        expect(decodeTechTreePngDataUri('data:image/jpeg;base64,ZmFrZQ==')).to.equal(undefined);
    });

    it('normalizes only positive integer source lines', () => {
        expect(normalizeTechTreeLine(1, 10)).to.equal(0);
        expect(normalizeTechTreeLine(20, 10)).to.equal(9);
        for (const value of [0, -1, 1.5, Number.NaN, '1']) {
            expect(normalizeTechTreeLine(value, 10), String(value)).to.equal(undefined);
        }
    });
});
