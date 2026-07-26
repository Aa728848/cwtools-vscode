import { parsePdx, type PdxNode } from './guiParser';

export const GUI_OFF_CANVAS_THRESHOLD = 5_000;
export const GUI_SAFE_HIDDEN_POSITION = -9_999;

export interface OffCanvasGuiContract {
    type: string;
    name: string;
    parentPath: string;
    line: number;
    x: number;
    y: number;
}

export interface GuiOffCanvasSafetyResult {
    allowed: boolean;
    preservedCount: number;
    protectedControls: OffCanvasGuiContract[];
    missingControls: OffCanvasGuiContract[];
    parseError?: string;
}

function propertyValue(nodes: readonly PdxNode[], key: string): string | number | undefined {
    return nodes.find(node => node.key.toLowerCase() === key.toLowerCase())?.value;
}

function numericProperty(nodes: readonly PdxNode[], key: string): number | undefined {
    const value = propertyValue(nodes, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringProperty(nodes: readonly PdxNode[], key: string): string | undefined {
    const value = propertyValue(nodes, key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isOffCanvas(x: number, y: number): boolean {
    return Math.abs(x) > GUI_OFF_CANVAS_THRESHOLD || Math.abs(y) > GUI_OFF_CANVAS_THRESHOLD;
}

function contractKey(contract: Pick<OffCanvasGuiContract, 'type' | 'name' | 'parentPath'>): string {
    return `${contract.parentPath}\u0000${contract.type.toLowerCase()}\u0000${contract.name.toLowerCase()}`;
}

function collectGuiContracts(content: string): {
    all: Map<string, number>;
    offCanvas: OffCanvasGuiContract[];
} {
    const roots = parsePdx(content);
    const all = new Map<string, number>();
    const offCanvas: OffCanvasGuiContract[] = [];

    const visit = (nodes: readonly PdxNode[], parentPath: string): void => {
        for (const node of nodes) {
            const children = node.children;
            if (!children) continue;

            const name = stringProperty(children, 'name');
            const position = children.find(child =>
                child.key.toLowerCase() === 'position' && Array.isArray(child.children));
            const x = position?.children ? numericProperty(position.children, 'x') : undefined;
            const y = position?.children ? numericProperty(position.children, 'y') : undefined;
            const isNamedGuiElement = name !== undefined;
            const currentPath = isNamedGuiElement
                ? `${parentPath}/${node.key}:${name}`
                : `${parentPath}/${node.key}`;

            if (isNamedGuiElement) {
                const contract = {
                    type: node.key,
                    name,
                    parentPath,
                    line: node.line,
                    x: x ?? 0,
                    y: y ?? 0,
                };
                const key = contractKey(contract);
                all.set(key, (all.get(key) ?? 0) + 1);
                if (x !== undefined && y !== undefined && isOffCanvas(x, y)) {
                    offCanvas.push(contract);
                }
            }

            visit(children, currentPath);
        }
    };

    visit(roots, '');
    return { all, offCanvas };
}

/**
 * Protect GUI instances that are intentionally kept outside the visible canvas.
 * Their large coordinates are an engine-compatibility marker, not dead layout.
 */
export function validateOffCanvasGuiPreservation(
    previousContent: string,
    nextContent: string,
): GuiOffCanvasSafetyResult {
    try {
        const previous = collectGuiContracts(previousContent);
        const next = collectGuiContracts(nextContent);
        const remaining = new Map(next.all);
        const missingControls: OffCanvasGuiContract[] = [];

        for (const contract of previous.offCanvas) {
            const key = contractKey(contract);
            const count = remaining.get(key) ?? 0;
            if (count <= 0) {
                missingControls.push(contract);
            } else {
                remaining.set(key, count - 1);
            }
        }

        return {
            allowed: missingControls.length === 0,
            preservedCount: previous.offCanvas.length - missingControls.length,
            protectedControls: previous.offCanvas,
            missingControls,
        };
    } catch (error) {
        return {
            allowed: false,
            preservedCount: 0,
            protectedControls: [],
            missingControls: [],
            parseError: error instanceof Error ? error.message : String(error),
        };
    }
}
