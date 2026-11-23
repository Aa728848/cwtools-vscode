import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    auditGui,
    buildGuiWindowBaseline,
    collectGuiFileSurface,
    DEFAULT_TRACKED_GUI_WINDOWS,
    extractWindowControls,
    scanGuiCwtCoverage,
    writeGuiWindowBaseline,
    type TrackedWindowSpec,
} from './gui-audit';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STELLARIS_CONFIG = path.join(REPO_ROOT, 'submodules', 'cwtools-stellaris-config', 'config');
const CHECKED_IN_BASELINE = path.join(__dirname, 'gui-window-baseline.json');

describe('Stellaris rules GUI widget & diplomacy window audit', () => {
    it('matches mixed-case widget types and properties against gui_types.cwt without false positives', () => {
        const cwt = [
            'alias[gui:containerWindowType] = {',
            '\tname = scalar',
            '\tscroll_wheel_factor = float',
            '\tsize = { width = int height = int }',
            '}',
            'alias[gui_button:buttonType] = {',
            '\tname = scalar',
            '\tclicksound = <sound_effect>',
            '}',
            'alias[gui:gridBoxType] = {',
            '\tname = scalar',
            '\tslotsize = { width = int height = int }',
            '\tmax_slots = { x = int y = int }',
            '}',
        ].join('\n');
        const coverage = scanGuiCwtCoverage(cwt);

        const gui = [
            '# Top-level settings outside guiTypes (like core.gui) must be ignored',
            'default_clicksound = "click"',
            'default_ime_text_color = { 1 1 1 1 }',
            '',
            'guiTypes = {',
            '\tcontainerWindowType = {',
            '\t\tname = "sample_view"',
            '\t\tscroll_wheel_factor = 1.5',
            '\t\tButtonType = {',
            '\t\t\tname = "ok_btn"',
            '\t\t\tclickSound = "confirm" # fake_comment_prop = yes',
            '\t\t}',
            '\t\tgridboxType = {',
            '\t\t\tname = "items"',
            '\t\t\tslotSize = { width = 32 height = 32 }',
            '\t\t\tmax_slots = { x = 4 y = 2 }',
            '\t\t}',
            '\t}',
            '}',
        ].join('\n');

        const widgets = new Map();
        const props = new Map();
        collectGuiFileSurface(gui, 'sample.gui', widgets, props);

        expect(Array.from(widgets.keys()).sort()).to.deep.equal([
            'buttontype',
            'containerwindowtype',
            'gridboxtype',
        ]);
        for (const key of widgets.keys()) {
            expect(coverage.widgetTypes.has(key), `widget ${key}`).to.equal(true);
        }
        for (const key of props.keys()) {
            expect(coverage.properties.has(key), `property ${key}`).to.equal(true);
        }
        expect(props.has('default_clicksound')).to.equal(false);
        expect(props.has('default_ime_text_color')).to.equal(false);
    });

    it('detects uncovered widget types and properties with counts and example lines', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-audit-surface-'));
        try {
            const configDir = path.join(tmp, 'config');
            const ifaceDir = path.join(tmp, 'interface');
            fs.mkdirSync(path.join(configDir, 'interface'), { recursive: true });
            fs.mkdirSync(ifaceDir, { recursive: true });

            fs.writeFileSync(path.join(configDir, 'interface', 'gui_types.cwt'), [
                'alias[gui:containerWindowType] = {',
                '\tname = scalar',
                '}',
            ].join('\n'), 'utf8');

            fs.writeFileSync(path.join(ifaceDir, 'custom.gui'), [
                'guiTypes = {',
                '\tcontainerWindowType = {',
                '\t\tname = "root_win"',
                '\t\tbrand_new_prop = yes',
                '\t\tbrand_new_prop = no',
                '\t\tholoChartType = {',
                '\t\t\tname = "chart"',
                '\t\t}',
                '\t}',
                '}',
            ].join('\n'), 'utf8');

            const report = auditGui(ifaceDir, configDir, '', []);
            expect(report.summary.guiFilesScanned).to.equal(1);
            expect(report.uncoveredWidgetTypes).to.deep.equal([
                { key: 'holocharttype', count: 1, example: 'custom.gui', exampleLine: 6 },
            ]);
            expect(report.uncoveredProperties).to.deep.equal([
                { key: 'brand_new_prop', count: 2, example: 'custom.gui', exampleLine: 4 },
            ]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('tracks diplomacy & custom_gui window controls, including inline blocks and baseline drift', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-audit-windows-'));
        try {
            const configDir = path.join(tmp, 'config');
            const ifaceDir = path.join(tmp, 'interface');
            const baselinePath = path.join(tmp, 'baseline.json');
            fs.mkdirSync(path.join(configDir, 'interface'), { recursive: true });
            fs.mkdirSync(ifaceDir, { recursive: true });

            fs.writeFileSync(path.join(configDir, 'interface', 'gui_types.cwt'), [
                'alias[gui:containerWindowType] = { name = scalar }',
                'alias[gui_button:buttonType] = { name = scalar }',
                'alias[gui:iconType] = { name = scalar }',
            ].join('\n'), 'utf8');

            const v1Diplomacy = [
                'guiTypes = {',
                '\tcontainerWindowType = {',
                '\t\tname = "diplomacy_view"',
                '\t\tcontainerWindowType = {',
                '\t\t\tname = "diplomacy_tab"',
                '\t\t\tbuttonType = {',
                '\t\t\t\tname = "old_button"',
                '\t\t\t}',
                '\t\t}',
                '\t}',
                '}',
            ].join('\n');
            fs.writeFileSync(path.join(ifaceDir, 'diplomacy_view.gui'), v1Diplomacy, 'utf8');

            const specs: TrackedWindowSpec[] = [
                { file: 'diplomacy_view.gui', windowName: 'diplomacy_view', role: 'diplomacy_view' },
            ];
            const baseline = buildGuiWindowBaseline(ifaceDir, 'v4.5.0', specs);
            writeGuiWindowBaseline(baselinePath, baseline);

            // Clean comparison against baseline.
            const clean = auditGui(ifaceDir, configDir, baselinePath, specs);
            expect(clean.summary.trackedControlsAdded).to.equal(0);
            expect(clean.summary.trackedControlsRemoved).to.equal(0);
            expect(clean.summary.baselineMissingWindows).to.equal(0);
            expect(clean.trackedWindows[0]!.found).to.equal(true);

            // Simulate 4.6 adding ideology_window + an inline iconType and removing old_button.
            const v2Diplomacy = [
                'guiTypes = {',
                '\tcontainerWindowType = {',
                '\t\tname = "diplomacy_view"',
                '\t\tcontainerWindowType = {',
                '\t\t\tname = "diplomacy_tab"',
                '\t\t\tcontainerWindowType = {',
                '\t\t\t\tname = "ideology_window"',
                '\t\t\t}',
                '\t\t\ticonType = { name = "inline_badge" }',
                '\t\t}',
                '\t}',
                '}',
            ].join('\n');
            fs.writeFileSync(path.join(ifaceDir, 'diplomacy_view.gui'), v2Diplomacy, 'utf8');

            const drifted = auditGui(ifaceDir, configDir, baselinePath, specs);
            expect(drifted.summary.trackedControlsAdded).to.equal(2);
            expect(drifted.summary.trackedControlsRemoved).to.equal(1);
            expect(drifted.trackedWindows[0]!.added.map(c => `${c.parentPath}|${c.type}|${c.name}`)).to.deep.equal([
                'diplomacy_tab|containerwindowtype|ideology_window',
                'diplomacy_tab|icontype|inline_badge',
            ]);
            expect(drifted.trackedWindows[0]!.removed).to.deep.equal([
                { parentPath: 'diplomacy_tab', type: 'buttontype', name: 'old_button' },
            ]);

            // Missing baseline and missing window flags.
            const missingReport = auditGui(ifaceDir, configDir, path.join(tmp, 'missing.json'), [
                { file: 'diplomacy_view.gui', windowName: 'nonexistent_window', role: 'custom_gui_contract' },
            ]);
            expect(missingReport.summary.baselineMissingWindows).to.equal(1);
            expect(missingReport.trackedWindows[0]!.found).to.equal(false);
            expect(missingReport.trackedWindows[0]!.baselineMissing).to.equal(true);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('passes through unnamed layout wrapper blocks such as if_resolution when tracking paths', () => {
        const gui = [
            'guiTypes = {',
            '\tcontainerWindowType = {',
            '\t\tname = "DiplomaticEventWindow"',
            '\t\tif_resolution = {',
            '\t\t\tmin_height = 1080',
            '\t\t\tbuttonType = {',
            '\t\t\t\tname = "confirm_button"',
            '\t\t\t}',
            '\t\t}',
            '\t}',
            '}',
        ].join('\n');
        const extracted = extractWindowControls(gui, 'DiplomaticEventWindow');
        expect(extracted.found).to.equal(true);
        expect(extracted.controls.map(c => `${c.parentPath}|${c.type}|${c.name}`)).to.deep.equal([
            '|buttontype|confirm_button',
        ]);
    });

    it('covers core Stellaris widgets, v4.6 GUI properties, and ships a complete 7-window baseline', () => {
        const guiCwt = fs.readFileSync(path.join(STELLARIS_CONFIG, 'interface', 'gui_types.cwt'), 'utf8');
        const coverage = scanGuiCwtCoverage(guiCwt);
        for (const widget of ['containerwindowtype', 'effectbuttontype', 'gridboxtype', 'buttontype', 'instanttextboxtype', 'smoothlistboxtype']) {
            expect(coverage.widgetTypes.has(widget), `gui_types.cwt should declare ${widget}`).to.equal(true);
        }
        expect(coverage.properties.has('scroll_wheel_factor')).to.equal(true);
        expect(coverage.properties.has('max_slots')).to.equal(true);

        expect(fs.existsSync(CHECKED_IN_BASELINE), 'gui-window-baseline.json must exist').to.equal(true);
        const baseline = JSON.parse(fs.readFileSync(CHECKED_IN_BASELINE, 'utf8')) as {
            _schema: string;
            gameVersion: string;
            windows: Array<{ file: string; windowName: string; controls: string[] }>;
        };
        expect(baseline._schema).to.equal('cwtools/stellaris-gui-window-baseline/v1');
        expect(baseline.windows).to.have.length(DEFAULT_TRACKED_GUI_WINDOWS.length);
        const diploView = baseline.windows.find(w => w.file === 'diplomacy_view.gui' && w.windowName === 'diplomacy_view');
        expect(diploView, 'diplomacy_view baseline entry').to.exist;
        expect(diploView!.controls).to.include('diplomacy_tab|containerwindowtype|ideology_window');
    });
});

