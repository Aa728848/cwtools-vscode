import * as fs from 'fs';
import * as path from 'path';

// Audits vanilla Stellaris interface/**/*.gui against config/interface/gui_types.cwt
// and tracks named controls in key diplomacy / mod-customizable event windows so
// game updates that add new GUI widget types, properties, or engine-bound controls
// (such as 4.6's ideology_window in diplomacy_view.gui) surface during rules sync.

export type TrackedWindowRole = 'custom_gui_contract' | 'diplomacy_view';

export interface TrackedWindowSpec {
    file: string;
    windowName: string;
    role: TrackedWindowRole;
}

export interface GuiSurfaceFinding {
    key: string;
    count: number;
    example: string;
    exampleLine: number;
}

export interface TrackedGuiControl {
    /** Normalized widget type (lowercase), e.g. containerwindowtype. */
    type: string;
    /** Exact control name as declared in the vanilla .gui file. */
    name: string;
    /** Slash-separated named ancestor chain inside the tracked window. */
    parentPath: string;
    line: number;
}

export interface TrackedWindowBaselineEntry {
    file: string;
    windowName: string;
    role: TrackedWindowRole;
    /** Sorted unique "parentPath|type|name" control signatures. */
    controls: string[];
}

export interface GuiWindowBaseline {
    _schema: 'cwtools/stellaris-gui-window-baseline/v1';
    gameVersion: string;
    windows: TrackedWindowBaselineEntry[];
}

export interface TrackedWindowDiff {
    file: string;
    windowName: string;
    role: TrackedWindowRole;
    found: boolean;
    baselineMissing: boolean;
    controlCount: number;
    added: TrackedGuiControl[];
    removed: Array<{ type: string; name: string; parentPath: string }>;
}

export interface GuiAuditSummary {
    guiFilesScanned: number;
    widgetTypesSeen: number;
    uncoveredWidgetTypes: number;
    uncoveredProperties: number;
    trackedWindows: number;
    trackedControlsAdded: number;
    trackedControlsRemoved: number;
    baselineMissingWindows: number;
}

export interface GuiAuditReport {
    interfaceDir: string;
    guiCwtPath: string;
    baselinePath: string;
    baselineVersion: string;
    uncoveredWidgetTypes: GuiSurfaceFinding[];
    uncoveredProperties: GuiSurfaceFinding[];
    trackedWindows: TrackedWindowDiff[];
    summary: GuiAuditSummary;
}

export const DEFAULT_TRACKED_GUI_WINDOWS: readonly TrackedWindowSpec[] = [
    { file: 'diplomacy_event_view.gui', windowName: 'DiplomaticEventWindow', role: 'custom_gui_contract' },
    { file: 'diplomacy_event_view.gui', windowName: 'event_option_entry', role: 'custom_gui_contract' },
    { file: 'eventwindow.gui', windowName: 'EventWindow', role: 'custom_gui_contract' },
    { file: 'eventwindow.gui', windowName: 'event_window_option_entry', role: 'custom_gui_contract' },
    { file: 'diplomacy_view.gui', windowName: 'diplomacy_view', role: 'diplomacy_view' },
    { file: 'federation_view.gui', windowName: 'federation_view', role: 'diplomacy_view' },
    { file: 'galactic_community_view.gui', windowName: 'galactic_community_view', role: 'diplomacy_view' },
];

// Coordinate, color, margin/padding, and structural root keys used inside small
// nested sub-blocks (position = { x y }, size = { width height }, margin = { ... }).
const SUB_BLOCK_VALUE_KEYS = new Set([
    'guitypes',
    'x', 'y', 'width', 'height',
    'r', 'g', 'b', 'a',
    'top', 'bottom', 'left', 'right',
]);

// Named block properties that belong to a widget rather than being widget types
// themselves, even when nested inside a container or widget.
const NON_WIDGET_BLOCK_KEYS = new Set([
    'background',
    'cursor',
    'decreasebutton',
    'expandbutton',
    'expandedwindow',
    'hitbox_margin',
    'hide_position',
    'if_resolution',
    'if_scaled_resolution',
    'increasebutton',
    'margin',
    'max_slots',
    'offset',
    'overlay',
    'padding',
    'pdx_tooltip_anchor_offset',
    'position',
    'show_position',
    'size',
    'slider',
    'slotsize',
    'text_offset',
    'track',
    'bordersize',
]);

function toPosix(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function readNormalizedText(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
}

function walkGuiFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name.toLowerCase() !== '.git') results.push(...walkGuiFiles(fullPath));
        } else if (entry.name.toLowerCase().endsWith('.gui')) {
            results.push(fullPath);
        }
    }
    return results.sort((a, b) => a.localeCompare(b));
}

function stripLineComment(line: string): string {
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = undefined;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '#') return line.slice(0, i);
    }
    return line;
}

function scanBraceLine(line: string, inQuote: boolean): { delta: number; inQuote: boolean } {
    let quoted = inQuote;
    let delta = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quoted) {
            if (ch === '\\') i++;
            else if (ch === '"') quoted = false;
            continue;
        }
        if (ch === '#') break;
        if (ch === '"') quoted = true;
        else if (ch === '{') delta++;
        else if (ch === '}') delta--;
    }
    return { delta, inQuote: quoted };
}

export interface GuiCwtCoverage {
    widgetTypes: Set<string>;
    properties: Set<string>;
}

/** Extract declared widget types and property keys from config/interface/gui_types.cwt. */
export function scanGuiCwtCoverage(cwtContent: string): GuiCwtCoverage {
    const widgetTypes = new Set<string>();
    const properties = new Set<string>();
    const stripped = cwtContent.split(/\r?\n/).map(stripLineComment).join('\n');

    for (const match of stripped.matchAll(/alias\[(gui|gui_button):([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
        const widget = match[2]!.toLowerCase();
        widgetTypes.add(widget);
        properties.add(widget);
    }
    for (const match of stripped.matchAll(/alias\[(?:gui_[A-Za-z0-9_]+|overlay):([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
        properties.add(match[1]!.toLowerCase());
    }
    for (const line of stripped.split('\n')) {
        const keyMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*==?\s*/);
        if (keyMatch) {
            const key = keyMatch[1]!.toLowerCase();
            if (!['types', 'enums', 'alias_name', 'path', 'severity'].includes(key)) {
                properties.add(key);
            }
        }
    }
    return { widgetTypes, properties };
}

interface RawCount {
    count: number;
    example: string;
    exampleLine: number;
}

function recordCount(map: Map<string, RawCount>, key: string, example: string, exampleLine: number) {
    const existing = map.get(key);
    if (existing) existing.count++;
    else map.set(key, { count: 1, example, exampleLine });
}

function isWidgetTypeKey(keyLower: string, atGuiTypesRoot: boolean): boolean {
    if (NON_WIDGET_BLOCK_KEYS.has(keyLower) || SUB_BLOCK_VALUE_KEYS.has(keyLower)) return false;
    if (atGuiTypesRoot) return true;
    return /type$/.test(keyLower);
}

/**
 * Scan one .gui file inside its guiTypes = { ... } block(s) and collect widget
 * type names and property keys. Top-level file settings outside guiTypes (such
 * as core.gui's default_clicksound) are intentionally excluded.
 */
export function collectGuiFileSurface(
    content: string,
    relPath: string,
    widgetTypes: Map<string, RawCount>,
    properties: Map<string, RawCount>,
): void {
    const lines = content.split(/\r?\n/);
    let depth = 0;
    let inGuiTypes = false;
    let guiTypesDepth = -1;
    let inQuote = false;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i] ?? '';
        const startsInQuote = inQuote;
        const stripped = stripLineComment(rawLine);

        if (!startsInQuote) {
            if (!inGuiTypes) {
                if (depth === 0 && /^\s*guiTypes\s*=\s*\{/i.test(stripped)) {
                    inGuiTypes = true;
                    guiTypesDepth = 0;
                }
            } else {
                const relDepth = depth - guiTypesDepth;
                const match = stripped.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\{)?/);
                if (match) {
                    const keyLower = match[1]!.toLowerCase();
                    const opensBlock = Boolean(match[2]);
                    if (relDepth === 1 && opensBlock) {
                        if (isWidgetTypeKey(keyLower, true)) {
                            recordCount(widgetTypes, keyLower, relPath, i + 1);
                        } else if (!SUB_BLOCK_VALUE_KEYS.has(keyLower)) {
                            recordCount(properties, keyLower, relPath, i + 1);
                        }
                    } else if (relDepth >= 2) {
                        if (opensBlock && isWidgetTypeKey(keyLower, false)) {
                            recordCount(widgetTypes, keyLower, relPath, i + 1);
                        } else if (!SUB_BLOCK_VALUE_KEYS.has(keyLower)) {
                            recordCount(properties, keyLower, relPath, i + 1);
                        }
                    }
                }
            }
        }

        const scanned = scanBraceLine(rawLine, inQuote);
        inQuote = scanned.inQuote;
        depth += scanned.delta;
        if (depth <= 0) {
            depth = 0;
            inGuiTypes = false;
            guiTypesDepth = -1;
        } else if (inGuiTypes && depth <= guiTypesDepth) {
            inGuiTypes = false;
            guiTypesDepth = -1;
        }
    }
}

interface ParsedGuiBlock {
    key: string;
    line: number;
    name?: string;
    children: ParsedGuiBlock[];
}

/** Lightweight brace-tree parser for extracting named widget hierarchies from one .gui file. */
function parseGuiBlocks(content: string): ParsedGuiBlock[] {
    const lines = content.split(/\r?\n/);
    const roots: ParsedGuiBlock[] = [];
    const stack: ParsedGuiBlock[] = [];
    let inQuote = false;

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i] ?? '';
        const startsInQuote = inQuote;
        const stripped = stripLineComment(rawLine);

        if (!startsInQuote) {
            const top = stack[stack.length - 1];
            const nameMatch = stripped.match(/^\s*name\s*=\s*(?:"([^"]*)"|([A-Za-z0-9_.-]+))/i);
            if (top && !top.name && nameMatch) {
                top.name = (nameMatch[1] ?? nameMatch[2] ?? '').trim();
            }
            const blockMatch = stripped.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/);
            if (blockMatch) {
                const node: ParsedGuiBlock = { key: blockMatch[1]!, line: i + 1, children: [] };
                const inlineNameMatch = stripped.match(/\bname\s*=\s*(?:"([^"]*)"|([A-Za-z0-9_.-]+))/i);
                if (inlineNameMatch) {
                    node.name = (inlineNameMatch[1] ?? inlineNameMatch[2] ?? '').trim();
                }
                if (top) top.children.push(node);
                else roots.push(node);
                // If the block closes on the same line, do not leave it on the stack.
                const delta = scanBraceLine(rawLine, false).delta;
                if (delta > 0) {
                    stack.push(node);
                    for (let extra = 1; extra < delta; extra++) {
                        stack.push({ key: '', line: i + 1, children: [] });
                    }
                }
                inQuote = scanBraceLine(rawLine, inQuote).inQuote;
                continue;
            }
        }

        const scanned = scanBraceLine(rawLine, inQuote);
        inQuote = scanned.inQuote;
        if (scanned.delta > 0) {
            for (let k = 0; k < scanned.delta; k++) {
                stack.push({ key: '', line: i + 1, children: [] });
            }
        } else if (scanned.delta < 0) {
            for (let k = 0; k < -scanned.delta && stack.length > 0; k++) {
                stack.pop();
            }
        }
    }

    return roots;
}

export function controlSignature(control: Pick<TrackedGuiControl, 'parentPath' | 'type' | 'name'>): string {
    return `${control.parentPath}|${control.type}|${control.name}`;
}

export function parseControlSignature(signature: string): { parentPath: string; type: string; name: string } {
    const [parentPath = '', type = '', ...rest] = signature.split('|');
    return { parentPath, type, name: rest.join('|') };
}

/** Extract all named controls inside a specific top-level window of a .gui file. */
export function extractWindowControls(content: string, windowName: string): { found: boolean; controls: TrackedGuiControl[] } {
    const roots = parseGuiBlocks(content);
    let targetWindow: ParsedGuiBlock | undefined;

    for (const root of roots) {
        if (root.key.toLowerCase() !== 'guitypes') continue;
        for (const child of root.children) {
            if (child.name === windowName) {
                targetWindow = child;
                break;
            }
        }
        if (targetWindow) break;
    }

    if (!targetWindow) return { found: false, controls: [] };

    const controls: TrackedGuiControl[] = [];
    const visit = (nodes: readonly ParsedGuiBlock[], parentPath: string) => {
        for (const node of nodes) {
            const typeLower = node.key.toLowerCase();
            if (!typeLower) continue;
            if (node.name) {
                controls.push({
                    type: typeLower,
                    name: node.name,
                    parentPath,
                    line: node.line,
                });
                const nextParent = parentPath ? `${parentPath}/${node.name}` : node.name;
                visit(node.children, nextParent);
            } else {
                visit(node.children, parentPath);
            }
        }
    };

    visit(targetWindow.children, '');
    controls.sort((a, b) => controlSignature(a).localeCompare(controlSignature(b)) || a.line - b.line);
    return { found: true, controls };
}

function readWindowBaseline(baselinePath: string): GuiWindowBaseline | null {
    if (!baselinePath || !fs.existsSync(baselinePath)) return null;
    try {
        const raw: unknown = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const obj = raw as Record<string, unknown>;
        if (!Array.isArray(obj.windows)) return null;
        const windows: TrackedWindowBaselineEntry[] = [];
        for (const item of obj.windows) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const rec = item as Record<string, unknown>;
            if (typeof rec.file !== 'string' || typeof rec.windowName !== 'string' || !Array.isArray(rec.controls)) continue;
            const role: TrackedWindowRole = rec.role === 'custom_gui_contract' ? 'custom_gui_contract' : 'diplomacy_view';
            const controls = rec.controls.filter((c): c is string => typeof c === 'string').sort();
            windows.push({ file: rec.file, windowName: rec.windowName, role, controls });
        }
        return {
            _schema: 'cwtools/stellaris-gui-window-baseline/v1',
            gameVersion: typeof obj.gameVersion === 'string' ? obj.gameVersion : '',
            windows,
        };
    } catch {
        return null;
    }
}

export function buildGuiWindowBaseline(
    interfaceDir: string,
    gameVersion: string,
    specs: readonly TrackedWindowSpec[] = DEFAULT_TRACKED_GUI_WINDOWS,
): GuiWindowBaseline {
    const windows: TrackedWindowBaselineEntry[] = [];
    for (const spec of specs) {
        const fullPath = path.join(interfaceDir, spec.file);
        if (!fs.existsSync(fullPath)) continue;
        const { found, controls } = extractWindowControls(readNormalizedText(fullPath), spec.windowName);
        if (!found) continue;
        const unique = Array.from(new Set(controls.map(controlSignature))).sort();
        windows.push({
            file: spec.file,
            windowName: spec.windowName,
            role: spec.role,
            controls: unique,
        });
    }
    return {
        _schema: 'cwtools/stellaris-gui-window-baseline/v1',
        gameVersion,
        windows,
    };
}

export function writeGuiWindowBaseline(baselinePath: string, baseline: GuiWindowBaseline): void {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
}

export function auditGui(
    interfaceDir: string,
    configDir: string,
    baselinePath = '',
    specs: readonly TrackedWindowSpec[] = DEFAULT_TRACKED_GUI_WINDOWS,
): GuiAuditReport {
    const guiCwtPath = path.join(configDir, 'interface', 'gui_types.cwt');
    const cwtCoverage = fs.existsSync(guiCwtPath)
        ? scanGuiCwtCoverage(readNormalizedText(guiCwtPath))
        : { widgetTypes: new Set<string>(), properties: new Set<string>() };

    const guiFiles = walkGuiFiles(interfaceDir);
    const widgetTypes = new Map<string, RawCount>();
    const properties = new Map<string, RawCount>();

    for (const file of guiFiles) {
        const relPath = toPosix(path.relative(interfaceDir, file));
        collectGuiFileSurface(readNormalizedText(file), relPath, widgetTypes, properties);
    }

    const byCount = (a: GuiSurfaceFinding, b: GuiSurfaceFinding) => b.count - a.count || a.key.localeCompare(b.key);
    const uncoveredWidgetTypes: GuiSurfaceFinding[] = [];
    for (const [key, info] of widgetTypes) {
        if (!cwtCoverage.widgetTypes.has(key)) {
            uncoveredWidgetTypes.push({ key, count: info.count, example: info.example, exampleLine: info.exampleLine });
        }
    }
    uncoveredWidgetTypes.sort(byCount);

    const uncoveredProperties: GuiSurfaceFinding[] = [];
    for (const [key, info] of properties) {
        if (!cwtCoverage.properties.has(key)) {
            uncoveredProperties.push({ key, count: info.count, example: info.example, exampleLine: info.exampleLine });
        }
    }
    uncoveredProperties.sort(byCount);

    const baseline = readWindowBaseline(baselinePath);
    const baselineByKey = new Map<string, TrackedWindowBaselineEntry>();
    for (const entry of baseline?.windows ?? []) {
        baselineByKey.set(`${entry.file.toLowerCase()}::${entry.windowName}`, entry);
    }

    const trackedWindows: TrackedWindowDiff[] = [];
    let trackedControlsAdded = 0;
    let trackedControlsRemoved = 0;
    let baselineMissingWindows = 0;

    for (const spec of specs) {
        const fullPath = path.join(interfaceDir, spec.file);
        const extracted = fs.existsSync(fullPath)
            ? extractWindowControls(readNormalizedText(fullPath), spec.windowName)
            : { found: false, controls: [] };
        const baseEntry = baselineByKey.get(`${spec.file.toLowerCase()}::${spec.windowName}`);

        if (!baseEntry) {
            baselineMissingWindows++;
            trackedWindows.push({
                file: spec.file,
                windowName: spec.windowName,
                role: spec.role,
                found: extracted.found,
                baselineMissing: true,
                controlCount: extracted.controls.length,
                added: [],
                removed: [],
            });
            continue;
        }

        const baseSet = new Set(baseEntry.controls);
        const currentBySig = new Map<string, TrackedGuiControl>();
        for (const control of extracted.controls) {
            const sig = controlSignature(control);
            if (!currentBySig.has(sig)) currentBySig.set(sig, control);
        }

        const added: TrackedGuiControl[] = [];
        for (const [sig, control] of currentBySig) {
            if (!baseSet.has(sig)) added.push(control);
        }
        added.sort((a, b) => controlSignature(a).localeCompare(controlSignature(b)));

        const removed: Array<{ type: string; name: string; parentPath: string }> = [];
        for (const sig of baseSet) {
            if (!currentBySig.has(sig)) removed.push(parseControlSignature(sig));
        }
        removed.sort((a, b) => controlSignature(a).localeCompare(controlSignature(b)));

        trackedControlsAdded += added.length;
        trackedControlsRemoved += removed.length;

        trackedWindows.push({
            file: spec.file,
            windowName: spec.windowName,
            role: spec.role,
            found: extracted.found,
            baselineMissing: false,
            controlCount: currentBySig.size,
            added,
            removed,
        });
    }

    return {
        interfaceDir,
        guiCwtPath,
        baselinePath,
        baselineVersion: baseline?.gameVersion ?? '',
        uncoveredWidgetTypes,
        uncoveredProperties,
        trackedWindows,
        summary: {
            guiFilesScanned: guiFiles.length,
            widgetTypesSeen: widgetTypes.size,
            uncoveredWidgetTypes: uncoveredWidgetTypes.length,
            uncoveredProperties: uncoveredProperties.length,
            trackedWindows: trackedWindows.length,
            trackedControlsAdded,
            trackedControlsRemoved,
            baselineMissingWindows,
        },
    };
}

function detectGameVersionFromInterfaceDir(interfaceDir: string): string {
    try {
        const settingsPath = path.join(path.dirname(interfaceDir), 'launcher-settings.json');
        if (!fs.existsSync(settingsPath)) return '';
        const raw: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
        const obj = raw as Record<string, unknown>;
        if (typeof obj.rawVersion === 'string' && obj.rawVersion) return obj.rawVersion;
        if (typeof obj.version === 'string' && obj.version) return obj.version;
        return '';
    } catch {
        return '';
    }
}

function parseCliArgs(argv: string[]) {
    const getArg = (flag: string, fallback = '') => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] ? path.resolve(argv[idx + 1]!) : fallback;
    };
    return {
        interfaceDir: getArg('--vanilla-interface'),
        config: getArg('--config'),
        baseline: getArg('--baseline', path.join(__dirname, 'gui-window-baseline.json')),
        updateBaseline: argv.includes('--update-baseline'),
        ci: argv.includes('--ci'),
    };
}

function main() {
    const args = parseCliArgs(process.argv.slice(2));
    if (!args.interfaceDir || !args.config) {
        console.error('Usage: npx ts-node tools/rules-sync/gui-audit.ts --vanilla-interface <dir> --config <configDir> [--baseline <file.json>] [--update-baseline] [--ci]');
        process.exit(1);
    }

    if (args.updateBaseline) {
        const version = detectGameVersionFromInterfaceDir(args.interfaceDir);
        const baseline = buildGuiWindowBaseline(args.interfaceDir, version);
        writeGuiWindowBaseline(args.baseline, baseline);
        console.log(`[gui-audit] updated baseline (${version || 'unknown'}): ${baseline.windows.length} windows -> ${args.baseline}`);
    }

    const report = auditGui(args.interfaceDir, args.config, args.baseline);
    const s = report.summary;
    console.log(
        `[gui-audit] files=${s.guiFilesScanned} widget_types=${s.widgetTypesSeen} uncovered_types=${s.uncoveredWidgetTypes} uncovered_props=${s.uncoveredProperties} tracked_windows=${s.trackedWindows} (+${s.trackedControlsAdded} -${s.trackedControlsRemoved})`,
    );
    for (const item of report.uncoveredWidgetTypes) {
        console.log(`  [uncovered type] ${item.key} (count=${item.count}, e.g. ${item.example}:${item.exampleLine})`);
    }
    for (const item of report.uncoveredProperties) {
        console.log(`  [uncovered prop] ${item.key} (count=${item.count}, e.g. ${item.example}:${item.exampleLine})`);
    }
    for (const win of report.trackedWindows) {
        if (!win.found) {
            console.log(`  [missing window] ${win.file} :: ${win.windowName}`);
        }
        if (win.baselineMissing) {
            console.log(`  [no baseline] ${win.file} :: ${win.windowName} (${win.controlCount} controls)`);
            continue;
        }
        if (win.added.length || win.removed.length) {
            console.log(`  [window drift] ${win.file} :: ${win.windowName} (+${win.added.length} -${win.removed.length})`);
            for (const c of win.added) {
                console.log(`    + ${c.parentPath ? c.parentPath + '/' : ''}${c.name} (${c.type}, L${c.line})`);
            }
            for (const c of win.removed) {
                console.log(`    - ${c.parentPath ? c.parentPath + '/' : ''}${c.name} (${c.type})`);
            }
        }
    }

    const hasMissingTrackedWindow = report.trackedWindows.some(w => !w.found);
    const hasDrift = s.uncoveredWidgetTypes > 0
        || s.uncoveredProperties > 0
        || s.trackedControlsAdded > 0
        || s.trackedControlsRemoved > 0
        || s.baselineMissingWindows > 0
        || hasMissingTrackedWindow;
    if (args.ci && hasDrift) process.exit(2);
}

if (require.main === module) main();
