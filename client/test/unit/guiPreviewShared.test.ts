import { expect } from 'chai';
import {
    createGuiElementReference,
    flattenGuiElements,
    isGuiPreviewSnapshot,
    isGuiSelection,
    resolveGuiElementReference,
    type GuiElement,
} from '../../shared/guiPreview';
import { computeGuiCanvasSize, computeTopLeft, effectiveSize, isOffCanvasElement } from '../../webview/guiLayout';

function element(type: string, name: string, children: GuiElement[] = []): GuiElement {
    return {
        type, name, position: { x: 10, y: 20 }, size: { width: 100, height: 40 },
        children, properties: {}, line: 2, endLine: 5, propertyLines: {},
    };
}

describe('shared GUI preview references and layout', () => {
    it('resolves source references by hierarchy and re-resolves line shifts', () => {
        const button = element('buttonType', 'confirm');
        const tree = [element('containerWindowType', 'root', [button])];
        const item = flattenGuiElements(tree)[1]!;
        const reference = createGuiElementReference(item.element, item.path, item.ancestors);
        expect(reference.path).to.equal('0.0');
        button.line = 20;
        button.endLine = 24;
        const resolved = resolveGuiElementReference(tree, reference);
        expect(resolved?.element.line).to.equal(20);
        expect(resolved?.path).to.equal('0.0');
    });

    it('rejects ambiguous same-name fallback matches', () => {
        const tree = [element('containerWindowType', 'root', [
            element('buttonType', 'same'), element('buttonType', 'same'),
        ])];
        const reference = createGuiElementReference(tree[0]!.children[0]!, '9.9', ['root']);
        expect(resolveGuiElementReference(tree, reference)).to.equal(undefined);
    });

    it('validates bounded marquee selections and snapshots', () => {
        const tree = [element('containerWindowType', 'root')];
        const reference = createGuiElementReference(tree[0]!, '0', []);
        expect(isGuiSelection({ elements: [reference], region: { x: 0, y: 0, width: 20, height: 30 } })).to.equal(true);
        expect(isGuiSelection({ elements: [reference], region: { x: 0, y: 0, width: -1, height: 30 } })).to.equal(false);
        expect(isGuiSelection({ elements: [reference], region: { x: Number.NaN, y: 0, width: 1, height: 1 } })).to.equal(false);
        expect(isGuiPreviewSnapshot({ status: 'ready', elements: tree })).to.equal(true);
        expect(isGuiPreviewSnapshot({ status: 'ready', elements: [{ bad: true }] })).to.equal(false);
    });

    it('shares Clausewitz anchor, percentage size and canvas calculations', () => {
        expect(computeTopLeft(800, 600, 100, 40, 'CENTER', 'CENTER', 0, 0, false)).to.deep.equal({ x: 350, y: 280 });
        const child = element('buttonType', 'percent');
        child.percentWidth = true;
        child.size.width = 50;
        expect(effectiveSize(child, 400, 200).w).to.equal(200);
        child.position.x = 6000;
        expect(isOffCanvasElement(child)).to.equal(true);
        const centered = element('windowType', 'centered');
        centered.orientation = 'CENTER';
        expect(computeGuiCanvasSize([centered])).to.deep.equal({ width: 1920, height: 1080 });
    });
});
