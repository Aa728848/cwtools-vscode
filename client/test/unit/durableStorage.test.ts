import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteJson, readJsonWithBackup } from '../../extension/ai/runner/durableStorage';

describe('durable storage', () => {
    it('serializes concurrent generations and retains the previous complete value', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-durable-storage-'));
        try {
            const filePath = path.join(tmpRoot, 'state.json');
            await Promise.all([
                atomicWriteJson(filePath, { generation: 1 }),
                atomicWriteJson(filePath, { generation: 2 }),
                atomicWriteJson(filePath, { generation: 3 }),
            ]);

            expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).to.deep.equal({ generation: 3 });
            expect(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf-8'))).to.deep.equal({ generation: 2 });

            fs.writeFileSync(filePath, '{damaged', 'utf-8');
            const recovered = readJsonWithBackup<{ generation: number }>(filePath);
            expect(recovered?.value).to.deep.equal({ generation: 2 });
            expect(recovered?.recoveredFromBackup).to.equal(true);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
