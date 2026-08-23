import { tokenize, TokenType, type Token } from '../../pdxTokenizer';

export interface OverlayDefinition {
    kind: 'event' | 'scripted_effect' | 'scripted_trigger' | 'on_action';
    id: string;
    file: string;
    line: number;
}

export interface OverlayReference {
    kind: 'event' | 'scripted_effect' | 'scripted_trigger';
    id: string;
    file: string;
    line: number;
}

export interface OverlayCatalogIssue {
    code: 'overlay_duplicate_definition' | 'overlay_unresolved_reference';
    severity: 'error';
    message: string;
    file: string;
    line: number;
    column: number;
}

export interface OverlayCatalogResult {
    definitions: OverlayDefinition[];
    references: OverlayReference[];
    issues: OverlayCatalogIssue[];
}

interface Node { key: string; value?: string; children: Node[]; line: number }
const atom = (token: Token | undefined): token is Token => token?.type === TokenType.Identifier || token?.type === TokenType.String || token?.type === TokenType.Number;

function parse(tokens: Token[], start = 0, stop = false): { nodes: Node[]; next: number } {
    const nodes: Node[] = [];
    let i = start;
    while (i < tokens.length) {
        const token = tokens[i]!;
        if (token.type === TokenType.EOF || (stop && token.type === TokenType.RBrace)) return { nodes, next: i + (token.type === TokenType.RBrace ? 1 : 0) };
        if (!atom(token) || tokens[i + 1]?.type !== TokenType.Equals) { i++; continue; }
        const rhs = tokens[i + 2];
        if (rhs?.type === TokenType.LBrace) {
            const nested = parse(tokens, i + 3, true);
            nodes.push({ key: token.value, children: nested.nodes, line: token.line });
            i = nested.next;
        } else if (atom(rhs)) {
            nodes.push({ key: token.value, value: rhs.value, children: [], line: token.line });
            i += 3;
        } else i++;
    }
    return { nodes, next: i };
}

const scalar = (node: Node | undefined): string | undefined => node?.value;
function collectCalls(nodes: Node[], file: string, out: OverlayReference[]): void {
    for (const node of nodes) {
        const directKind = node.key.endsWith('_event') || node.key === 'event' ? 'event'
            : node.key === 'scripted_effect' ? 'scripted_effect'
            : node.key === 'scripted_trigger' ? 'scripted_trigger' : undefined;
        if (directKind) {
            const id = scalar(node.children.find(child => child.key === 'id')) ?? node.value;
            if (id) out.push({ kind: directKind, id, file, line: node.line });
        } else if (node.children.length === 0 && node.value === undefined && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(node.key)) {
            // Empty named blocks are definitions, not calls; ignore here.
        }
        collectCalls(node.children, file, out);
    }
}

/** Request-scoped overlay catalog for definitions introduced together. */
export function validateOverlayCatalog(files: readonly { file: string; content: string }[], liveIds: ReadonlySet<string> = new Set()): OverlayCatalogResult {
    const definitions: OverlayDefinition[] = [];
    const references: OverlayReference[] = [];
    for (const file of files) {
        const roots = parse(tokenize(file.content)).nodes;
        for (const root of roots) {
            if (root.key.endsWith('_event')) {
                const id = scalar(root.children.find(child => child.key === 'id'));
                if (id) definitions.push({ kind: 'event', id, file: file.file, line: root.line });
            } else if (root.key === 'on_action') {
                const id = scalar(root.children.find(child => child.key === 'id'));
                if (id) definitions.push({ kind: 'on_action', id, file: file.file, line: root.line });
            } else if (/scripted_effects/i.test(file.file)) definitions.push({ kind: 'scripted_effect', id: root.key, file: file.file, line: root.line });
            else if (/scripted_triggers/i.test(file.file)) definitions.push({ kind: 'scripted_trigger', id: root.key, file: file.file, line: root.line });
        }
        collectCalls(roots, file.file, references);
    }
    definitions.sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file) || a.line - b.line);
    references.sort((a, b) => a.id.localeCompare(b.id) || a.file.localeCompare(b.file) || a.line - b.line);
    const byId = new Map<string, OverlayDefinition[]>();
    for (const definition of definitions) byId.set(definition.id, [...(byId.get(definition.id) ?? []), definition]);
    const issues: OverlayCatalogIssue[] = [];
    for (const [id, matches] of byId) if (matches.length > 1) for (const match of matches) issues.push({ code: 'overlay_duplicate_definition', severity: 'error', message: `Duplicate overlay definition: ${id}`, file: match.file, line: match.line, column: 0 });
    for (const reference of references) if (!byId.has(reference.id) && !liveIds.has(reference.id)) issues.push({ code: 'overlay_unresolved_reference', severity: 'error', message: `Overlay reference is unresolved: ${reference.id}`, file: reference.file, line: reference.line, column: 0 });
    return { definitions, references, issues: issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code)) };
}
