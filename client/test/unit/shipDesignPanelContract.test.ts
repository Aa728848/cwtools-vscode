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

    it('makes overflowing component clusters scrollable via the slot strip instead of clipping', () => {
        const css = fs.readFileSync(path.join(process.cwd(), 'client/webview/shipDesignPreview.css'), 'utf8');
        const layer = css.slice(css.indexOf('.sd-slot-layer {'), css.indexOf('.sd-slot-layer-bottom'));
        // The layer-scroll rule is uniquely marked; anchor on it to avoid older duplicate '.sd-strip' rules.
        const marker = css.indexOf('The strip owns a real, draggable vertical scrollbar');
        const strip = css.slice(css.lastIndexOf('.sd-strip {', marker), css.indexOf('}', marker));
        // Two layers must fit the strip box (no 43% clip) and the layer must stay click-through so the
        // empty viewport band still reaches the 3D canvas.
        expect(layer).to.include('max-block-size: calc(50% - 6px)');
        expect(layer).not.to.include('max-block-size: 43%');
        expect(layer).to.include('overflow-x: auto');
        expect(layer).to.include('overflow-y: hidden');
        expect(layer).to.include('pointer-events: none');
        // The strip owns the real, draggable vertical scrollbar for a cluster taller than its layer.
        expect(strip).to.include('overflow-y: auto');
        expect(strip).to.include('overflow-x: hidden');
        expect(strip).to.include('max-block-size: 100%');
        expect(strip).to.include('pointer-events: auto');
        expect(strip).not.to.include('pointer-events: none');
        // Centring must not clip the top of an overflowing cluster.
        expect(strip).to.include('justify-content: safe center');
    });
});
