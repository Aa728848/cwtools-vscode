export type InterfaceKnowledgeTopic =
    | 'overview'
    | 'gui_files'
    | 'gfx_files'
    | 'buttons_and_effects'
    | 'custom_windows'
    | 'off_canvas_hiding'
    | 'layout'
    | 'debugging'
    | 'all';

export interface InterfaceKnowledgeQuery {
    topic?: InterfaceKnowledgeTopic;
    query?: string;
    elementType?: string;
    limit?: number;
}

interface InterfaceKnowledgeEntry {
    id: string;
    topics: readonly InterfaceKnowledgeTopic[];
    title: string;
    summary: string;
    safePatterns: readonly string[];
    unsafePatterns: readonly string[];
    keywords: readonly string[];
    riskLevel: 'reference' | 'engine_constraint' | 'crash_risk';
    sourceSection: string;
}

const SOURCE = {
    title: 'Interface modding - Stellaris Wiki',
    canonicalUrl: 'https://stellaris.paradoxwikis.com/Interface_modding',
    revisionUrl: 'https://stellaris.paradoxwikis.com/index.php?title=Interface_modding&oldid=106757',
    revisionId: 106757,
    license: 'CC BY-SA 3.0',
    retrieval: 'bundled_curated_snapshot',
} as const;

const ENTRIES: readonly InterfaceKnowledgeEntry[] = [
    {
        id: 'preserve_engine_bound_controls',
        topics: ['off_canvas_hiding', 'custom_windows', 'layout'],
        title: 'Preserve engine-bound controls outside the visible canvas',
        summary: 'Existing named GUI instances may be looked up by hardcoded engine logic. Keep their type, name, parent hierarchy, and block present even when the control is not displayed.',
        safePatterns: [
            'Move the unused control far outside the visible canvas, for example position = { x = -9999 y = -9999 }.',
            'Preserve established project constants such as @invisible_position instead of normalizing their large values.',
            'Treat coordinates with an absolute component above 5000 as intentional off-canvas compatibility markers unless current vanilla evidence proves otherwise.',
        ],
        unsafePatterns: [
            'Deleting a named vanilla/custom_gui control because it is invisible or appears unused.',
            'Renaming or reparenting an off-canvas control during cleanup.',
            'Clamping, normalizing, auto-arranging, or pulling extreme coordinates back into the visible canvas.',
        ],
        keywords: ['off canvas', 'offscreen', 'hidden', 'delete', 'crash', 'ctd', 'invisible_position', 'position'],
        riskLevel: 'crash_risk',
        sourceSection: 'Custom Windows / Clearing',
    },
    {
        id: 'button_effect_relationship',
        topics: ['buttons_and_effects'],
        title: 'Choose button types according to their engine and script relationship',
        summary: 'buttonType actions are generally hardcoded. effectButtonType is the mod-facing button form whose effect property can reference /common/button_effects/ and participate in custom GUI behavior.',
        safePatterns: [
            'Use effectButtonType when a custom UI action must call a verified button effect.',
            'Resolve the effect identifier in current project or vanilla /common/button_effects/ before writing it.',
            'Preserve hardcoded button names when modifying an existing vanilla window.',
        ],
        unsafePatterns: [
            'Assuming a newly created buttonType gains behavior from its visual name or sprite.',
            'Inventing an effect identifier without checking project and vanilla definitions.',
            'Renaming an existing button without tracing its engine or script callers.',
        ],
        keywords: ['buttonType', 'effectButtonType', 'effect', 'button_effects', 'custom_gui', 'scripted_gui'],
        riskLevel: 'engine_constraint',
        sourceSection: 'Modifying GUI / buttonType / effectButtonType',
    },
    {
        id: 'custom_window_contract',
        topics: ['custom_windows', 'layout'],
        title: 'Custom windows reuse engine-recognized GUI contracts',
        summary: 'A diplomatic event custom_gui points to a specific containerWindowType. Required instances and expected structure must remain compatible with the engine-facing window contract.',
        safePatterns: [
            'Read the complete current vanilla container before modifying a custom_gui window.',
            'Keep required child instances and hide unused visual parts off-canvas.',
            'Preserve source order when the current template does not prove reordering is safe.',
        ],
        unsafePatterns: [
            'Replacing the window with a visually equivalent but structurally different tree.',
            'Deleting portrait, option, heading, background, or other inherited instances solely because the mod does not display them.',
        ],
        keywords: ['custom window', 'custom_gui', 'diplomatic', 'containerWindowType', 'hierarchy', 'instance'],
        riskLevel: 'crash_risk',
        sourceSection: 'Custom Windows / Start / Clearing',
    },
    {
        id: 'gui_and_gfx_roles',
        topics: ['overview', 'gui_files', 'gfx_files'],
        title: 'Separate GUI structure from GFX sprite libraries',
        summary: '.gui files define interface structure and layout; .gfx files bind GFX identifiers to sprite and texture resources used by GUI elements.',
        safePatterns: [
            'Trace .gui spriteType or quadTextureSprite references to verified .gfx definitions.',
            'Prefer new mod-owned .gfx library files over editing vanilla files directly.',
        ],
        unsafePatterns: [
            'Treating a GFX_* identifier as valid merely because a texture file exists.',
            'Guessing sprite identifiers or changing .gui and .gfx independently.',
        ],
        keywords: ['guiTypes', '.gui', '.gfx', 'spriteType', 'quadTextureSprite', 'texturefile', 'sprite library'],
        riskLevel: 'reference',
        sourceSection: 'Getting Started / GUI Files / GFX Files',
    },
    {
        id: 'layout_hierarchy',
        topics: ['gui_files', 'layout'],
        title: 'Interpret coordinates through the complete parent hierarchy',
        summary: 'Positions, orientations, origo, margins, clipping, and sizes are interpreted relative to parent containers. A local coordinate is not meaningful without its containing window.',
        safePatterns: [
            'Read the complete parent containerWindowType before changing a child position.',
            'Preserve orientation and origo until the active hierarchy has been inspected.',
        ],
        unsafePatterns: [
            'Flattening or reparenting controls based only on their apparent preview position.',
            'Auto-normalizing large coordinates without distinguishing visible layout from hidden engine instances.',
        ],
        keywords: ['containerWindowType', 'orientation', 'origo', 'position', 'size', 'margin', 'clipping'],
        riskLevel: 'engine_constraint',
        sourceSection: 'GUI Files / Element Attributes / containerWindowType',
    },
    {
        id: 'interface_debugging',
        topics: ['debugging'],
        title: 'Use the game interface debugging loop',
        summary: 'Stellaris provides targeted interface reload and inspection commands that shorten the edit-check cycle, but runtime checks remain necessary for engine-bound behavior.',
        safePatterns: [
            'Use reload <file>.gui for GUI-only changes when supported.',
            'Use reload texture all after texture changes and restart when texture resolution changes.',
            'Use guibounds and debugtooltip to locate engine UI instances and their source files.',
        ],
        unsafePatterns: [
            'Treating a clean static parse as proof that a custom window will not crash.',
        ],
        keywords: ['reload', 'reload texture all', 'guibounds', 'debugtooltip', 'console'],
        riskLevel: 'reference',
        sourceSection: 'Getting Started',
    },
];

const TOPICS = new Set<InterfaceKnowledgeTopic>([
    'overview',
    'gui_files',
    'gfx_files',
    'buttons_and_effects',
    'custom_windows',
    'off_canvas_hiding',
    'layout',
    'debugging',
    'all',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
    return typeof record?.[key] === 'string' ? record[key].trim() : '';
}

function tokens(value: string): string[] {
    return value.toLowerCase().match(/[a-z0-9_./@-]{2,}|[\u4e00-\u9fff]{2,}/g)?.slice(0, 24) ?? [];
}

function normalizeTopic(value: unknown): InterfaceKnowledgeTopic {
    return typeof value === 'string' && TOPICS.has(value as InterfaceKnowledgeTopic)
        ? value as InterfaceKnowledgeTopic
        : 'all';
}

export function queryInterfaceKnowledge(input: unknown = {}): Record<string, unknown> {
    const args = asRecord(input);
    const topic = normalizeTopic(args?.topic);
    const query = stringField(args, 'query');
    const elementType = stringField(args, 'elementType');
    const queryTokens = tokens(`${query} ${elementType}`);
    const rawLimit = typeof args?.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 5;
    const limit = Math.max(1, Math.min(rawLimit, 10));

    const ranked = ENTRIES
        .map((entry, index) => {
            const searchable = [
                entry.id,
                entry.title,
                entry.summary,
                ...entry.keywords,
                ...entry.safePatterns,
                ...entry.unsafePatterns,
            ].join(' ').toLowerCase();
            const topicScore = topic === 'all' || entry.topics.includes(topic) ? 20 : 0;
            const tokenScore = queryTokens.reduce((score, token) =>
                score + (searchable.includes(token) ? 4 : 0), 0);
            const riskScore = entry.riskLevel === 'crash_risk' ? 2 : entry.riskLevel === 'engine_constraint' ? 1 : 0;
            return { entry, index, score: topicScore + tokenScore + riskScore };
        })
        .filter(item => topic === 'all' || item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, limit)
        .map(({ entry }) => entry);

    const criticalSafetyRules = ENTRIES
        .filter(entry => entry.riskLevel === 'crash_risk')
        .map(entry => ({
            id: entry.id,
            title: entry.title,
            summary: entry.summary,
            safePatterns: entry.safePatterns,
            unsafePatterns: entry.unsafePatterns,
            riskLevel: entry.riskLevel,
        }));

    return {
        status: 'ready',
        scope: 'stellaris_interface',
        topic,
        query: query || undefined,
        elementType: elementType || undefined,
        source: SOURCE,
        // Fact-layer split: static versioned engine guidance vs project facts
        // vs the current-version vanilla contract vs what still needs runtime
        // confirmation. The model must never present engineGuidance as a
        // project fact or an unresolved behavior as settled.
        engineGuidance: {
            versioned: true,
            bundledAt: SOURCE.revisionId,
            criticalSafetyRules,
            entries: ranked,
            instruction: 'Large off-canvas coordinates are intentional compatibility evidence. Never delete, rename, reparent, clamp, or auto-arrange those controls as cleanup.',
        },
        projectGraph: {
            available: false,
            hint: 'Use query_workspace_index with source="gui" (and includeAssetChain for sprite targets) or explore_pdx_project for current project GUI facts.',
        },
        vanillaContract: {
            available: false,
            hint: 'Use query_workspace_index with origin="vanilla" source="gui" or explore_pdx_project on the vanilla GUI file for current-version structure.',
        },
        unresolved: [
            'Window open/close timing and engine-bound control lookup are hardcoded runtime behavior that static analysis cannot confirm.',
            'Effect identifiers resolved through scripted GUI or generated button effects still require an in-game verification.',
        ],
        requiredNextChecks: [
            'Read the complete current project or vanilla parent GUI block before editing.',
            'Verify .gui to GFX_* to .gfx references with current project and vanilla evidence.',
            'Resolve effectButtonType effect identifiers in /common/button_effects/ or the current scripted GUI model.',
            'Run fresh diagnostics after writing; runtime-bound window contracts still require an in-game check.',
        ],
    };
}
