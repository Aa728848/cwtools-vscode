/**
 * Tech Tree Parser — Parses Stellaris technology/*.txt files.
 *
 * Each technology block looks like:
 *   tech_some_name = {
 *     cost = 1000
 *     area = physics
 *     tier = 1
 *     category = { computing }
 *     prerequisites = { tech_a tech_b }
 *     ...
 *   }
 *
 * We extract: id, area, tier, category, prerequisites, weight(0=rare),
 * is_rare, is_dangerous, start_tech.
 */

export type TechArea = 'physics' | 'society' | 'engineering' | 'unknown';

export interface TechNode {
    id: string;
    area: TechArea;
    tier: number;
    category: string;
    cost: number;
    /** localization key (usually same as id) */
    title: string;
    /** Weight = 0 → only appears via event unlock / scripted */
    isRare: boolean;
    isDangerous: boolean;
    isStartTech: boolean;
    file: string;
    line: number;
}

export interface TechEdge {
    /** prerequisite tech */
    source: string;
    /** tech that requires source */
    target: string;
}

export interface TechGraph {
    nodes: TechNode[];
    edges: TechEdge[];
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a single technology file and return all tech nodes + prerequisite edges.
 */
export function parseTechFile(content: string, filePath: string): TechGraph {
    const nodes: TechNode[] = [];
    const edges: TechEdge[] = [];

    const lines = content.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trim();

        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) { i++; continue; }

        // Match top-level tech block: word = {
        const blockMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_]*)[\s\t]*=[\s\t]*\{/);
        if (blockMatch && !trimmed.startsWith('prerequisites') && !trimmed.startsWith('category')) {
            const techId = blockMatch[1]!;
            const startLine = i + 1;

            // Gather the entire block content
            let depth = 0;
            const bodyLines: string[] = [];

            // Count opening brace on this line (ignore comments)
            const noCommentLine = trimmed.split('#')[0] || '';
            for (const ch of noCommentLine) {
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
            }
            bodyLines.push(trimmed);
            i++;

            while (i < lines.length && depth > 0) {
                const innerLine = lines[i]!;
                const innerTrimmed = innerLine.trim();
                const innerNoComment = innerTrimmed.split('#')[0] || '';
                for (const ch of innerNoComment) {
                    if (ch === '{') depth++;
                    else if (ch === '}') depth--;
                }
                bodyLines.push(innerTrimmed);
                i++;
            }

            const body = bodyLines.join('\n');
            const cleanBody = body.replace(/#[^\r\n]*/g, '');

            // Only parse if it has an area field (confirms it's a tech block)
            const areaMatch = cleanBody.match(/\barea\s*=\s*(\w+)/);
            if (!areaMatch) continue;

            const area = normalizeArea(areaMatch[1]!);
            const tierMatch = cleanBody.match(/\btier\s*=\s*(\d+)/);
            const costMatch = cleanBody.match(/\bcost\s*=\s*([\d.]+)/);
            const catMatch = cleanBody.match(/\bcategory\s*=\s*\{\s*([a-zA-Z0-9_]+)/);
            const isRare = /\bweight\s*=\s*0\b/.test(cleanBody) || /\bis_rare\s*=\s*yes\b/.test(cleanBody);
            const isDangerous = /\bis_dangerous\s*=\s*yes\b/.test(cleanBody);
            const isStartTech = /\bstart_tech\s*=\s*yes\b/.test(cleanBody);

            nodes.push({
                id: techId,
                area,
                tier: tierMatch ? parseInt(tierMatch[1]!) : 0,
                category: catMatch ? catMatch[1]! : '',
                cost: costMatch ? parseFloat(costMatch[1]!) : 0,
                title: techId, // will be resolved to loc name later
                isRare,
                isDangerous,
                isStartTech,
                file: filePath,
                line: startLine,
            });

            // Extract prerequisites = { tech_a tech_b }
            // Can be multi-line, so search the block body
            const prereqMatch = cleanBody.match(/\bprerequisites\s*=\s*\{([^}]*)\}/s);
            if (prereqMatch) {
                const prereqContent = prereqMatch[1]!;
                const prereqIds = prereqContent.trim().split(/[\s\n\r\t]+/)
                    .map(s => s.replace(/^"|"$/g, ''))        // strip surrounding quotes
                    .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));
                for (const prereqId of prereqIds) {
                    if (prereqId !== techId) {
                        edges.push({ source: prereqId, target: techId });
                    }
                }
            }

            continue;
        }

        i++;
    }

    return { nodes, edges };
}

function normalizeArea(area: string): TechArea {
    const a = area.toLowerCase();
    if (a === 'physics') return 'physics';
    if (a === 'society') return 'society';
    if (a === 'engineering') return 'engineering';
    return 'unknown';
}

// ─── Graph utilities ──────────────────────────────────────────────────────────

export function mergeTechGraphs(graphs: TechGraph[]): TechGraph {
    const nodeMap = new Map<string, TechNode>();
    const allEdges: TechEdge[] = [];

    for (const g of graphs) {
        for (const node of g.nodes) {
            if (!nodeMap.has(node.id)) nodeMap.set(node.id, node);
        }
        allEdges.push(...g.edges);
    }

    // Deduplicate edges
    const seen = new Set<string>();
    const edges: TechEdge[] = [];
    for (const e of allEdges) {
        const key = `${e.source}→${e.target}`;
        if (!seen.has(key)) { seen.add(key); edges.push(e); }
    }

    return { nodes: Array.from(nodeMap.values()), edges };
}

/**
 * From a seed set of tech IDs, BFS-expand to find their prerequisites
 * and all techs that depend on them.
 */
export function extractTechSubgraph(
    full: TechGraph,
    seedIds: Set<string>,
    depth: number = 8,
): TechGraph {
    const visited = new Set<string>();
    let frontier = [...seedIds];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const id of frontier) {
            if (visited.has(id)) continue;
            visited.add(id);
            for (const e of full.edges) {
                if (e.target === id && !visited.has(e.source)) next.push(e.source);
                if (e.source === id && !visited.has(e.target)) next.push(e.target);
            }
        }
        frontier = next;
    }
    for (const id of frontier) visited.add(id);

    const nodes = full.nodes.filter(n => visited.has(n.id));
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = full.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { nodes, edges };
}
