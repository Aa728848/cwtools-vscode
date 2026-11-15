import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('extension update policy', () => {
    const root = path.resolve(__dirname, '../../..');

    it('leaves updates to the VS Code Marketplace and ships no self-updater', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release/package.json'), 'utf8')) as {
            contributes?: { configuration?: unknown };
        };
        const rawSections = manifest.contributes?.configuration;
        const sections = (Array.isArray(rawSections) ? rawSections : [rawSections]) as Array<{ properties?: Record<string, unknown> }>;
        const properties = Object.assign({}, ...sections.map(section => section?.properties ?? {}));

        expect(properties).not.to.have.property('stellarisLanguageServices.checkForUpdates');

        for (const locale of ['package.nls.json', 'package.nls.zh.json', 'package.nls.zh-cn.json']) {
            const messages = JSON.parse(fs.readFileSync(path.join(root, 'release', locale), 'utf8')) as Record<string, unknown>;
            const staleKeys = Object.keys(messages).filter(key => key.toLowerCase().includes('checkforupdates'));
            expect(staleKeys, `${locale} should not document a self-update setting`).to.deep.equal([]);
        }

        expect(fs.existsSync(path.join(root, 'client/extension/updateChecker.ts'))).to.equal(false);
        const activation = fs.readFileSync(path.join(root, 'client/extension/extension.ts'), 'utf8');
        expect(activation).not.to.include('checkForUpdates');
    });
});
