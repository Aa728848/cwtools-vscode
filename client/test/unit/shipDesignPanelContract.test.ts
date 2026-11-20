import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('ship design panel release layout', () => {
    it('uses the same extension-root webview path as the shipped GUI and Entity panels', () => {
        const root = process.cwd();
        const ship = fs.readFileSync(path.join(root, 'client/extension/shipDesignPanel.ts'), 'utf8');
        const gui = fs.readFileSync(path.join(root, 'client/extension/guiPanel.ts'), 'utf8');
        const entity = fs.readFileSync(path.join(root, 'client/extension/entityPanel.ts'), 'utf8');
        const expected = "path.join(extensionPath, 'bin/client/webview')";
        expect(ship).to.include(expected);
        expect(gui).to.include(expected);
        expect(entity).to.include(expected);
        expect(ship).not.to.include("path.join(extensionPath, 'release', 'bin'");
    });

    it('opens in the current editor column and writes the Host draft only from save', () => {
        const ship = fs.readFileSync(path.join(process.cwd(), 'client/extension/shipDesignPanel.ts'), 'utf8');
        expect(ship).to.include('vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active');
        const operation = ship.slice(ship.indexOf('    private async applyOperation'), ship.indexOf('    private async receive'));
        expect(operation).to.include('this.draft.apply');
        expect(operation).not.to.include('this.writeDocument');
        const save = ship.slice(ship.indexOf("            case 'save':"), ship.indexOf("            case 'discard':"));
        expect(save).to.include('await this.writeDocument(this.draft.text)');
        expect(save).to.include('await this.document.save()');
    });

    it('resolves actual non-empty release assets from the packaged extension root', () => {
        const extensionPath = path.resolve('release');
        const webviewRoot = path.join(extensionPath, 'bin/client/webview');
        for (const name of ['shipDesignPreview.js', 'shipDesignPreview.css', 'skyboxEnvWorker.js']) {
            const file = path.join(webviewRoot, name);
            expect(fs.existsSync(file), name + ' must exist').to.equal(true);
            expect(fs.statSync(file).size, name + ' must not be empty').to.be.greaterThan(0);
        }
    });
});
