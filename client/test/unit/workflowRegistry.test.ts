import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getWorkflow,
    getAllWorkflows,
    getAllWorkflowIds,
    getWorkflowAllowedTools,
    checkWorkflowContext,
    saveProjectWorkflow,
} from '../../extension/ai/workflowRegistry';

describe('AI Workflow Registry', () => {
    it('has at least 5 registered workflows', () => {
        expect(getAllWorkflows().length).to.be.greaterThanOrEqual(5);
    });

    it('getAllWorkflowIds returns matching IDs', () => {
        const ids = getAllWorkflowIds();
        for (const id of ids) {
            expect(getWorkflow(id)).to.not.be.undefined;
        }
    });

    it('getWorkflow returns undefined for unknown IDs', () => {
        expect(getWorkflow('nonexistent')).to.be.undefined;
    });

    // ── Diagnostic Fix Workflow ────────────────────────────────────────

    it('diagnostic-fix workflow exists and has correct mode', () => {
        const wf = getWorkflow('diagnostic-fix');
        expect(wf).to.not.be.undefined;
        expect(wf!.mode).to.equal('build');
        expect(wf!.title).to.equal('Diagnostic Fix');
    });

    it('diagnostic-fix workflow has 4 phases', () => {
        const wf = getWorkflow('diagnostic-fix')!;
        expect(wf.phases).to.have.lengthOf(4);
        expect(wf.phases.map(p => p.id)).to.deep.equal(['collect', 'analyze', 'fix', 'verify']);
    });

    it('diagnostic-fix requires diagnostics context', () => {
        const wf = getWorkflow('diagnostic-fix')!;
        const diagReq = wf.requiredContext.find(r => r.kind === 'diagnostics');
        expect(diagReq).to.not.be.undefined;
        expect(diagReq!.required).to.be.true;
    });

    it('diagnostic-fix has verification step for zero errors', () => {
        const wf = getWorkflow('diagnostic-fix')!;
        expect(wf.verification).to.have.lengthOf(1);
        expect(wf.verification[0]!.id).to.equal('zero-errors');
        expect(wf.verification[0]!.required).to.be.true;
    });

    // ── Localisation Generation Workflow ────────────────────────────────

    it('loc-generation workflow exists and runs in build mode', () => {
        const wf = getWorkflow('loc-generation');
        expect(wf).to.not.be.undefined;
        expect(wf!.mode).to.equal('build');
    });

    it('loc-generation includes write_localisation in tool policy', () => {
        const wf = getWorkflow('loc-generation')!;
        expect(wf.toolPolicy.strategy).to.equal('allowlist');
        expect(wf.toolPolicy.tools).to.include('write_localisation');
    });

    // ── Event Chain Design Workflow ─────────────────────────────────────

    it('event-chain-design runs in plan mode', () => {
        const wf = getWorkflow('event-chain-design');
        expect(wf).to.not.be.undefined;
        expect(wf!.mode).to.equal('plan');
    });

    it('event-chain-design includes write_design_blueprint', () => {
        const wf = getWorkflow('event-chain-design')!;
        expect(wf.toolPolicy.tools).to.include('write_design_blueprint');
    });

    it('event-chain-design includes common review and reward planning gates', () => {
        const wf = getWorkflow('event-chain-design')!;
        expect(wf.phases.map(p => p.id)).to.include.members(['common-review', 'rewards']);
        expect(wf.verification.map(v => v.id)).to.include.members(['common-review-written', 'reward-plan-written', 'blueprint-written']);
        expect(wf.promptSupplement).to.include('common/');
        expect(wf.promptSupplement).to.include('concrete common entity families');
    });

    // ── Rules Sync Review Workflow ──────────────────────────────────────

    it('rules-sync-review runs in review mode', () => {
        const wf = getWorkflow('rules-sync-review');
        expect(wf).to.not.be.undefined;
        expect(wf!.mode).to.equal('review');
    });

    // ── Asset Wiring Workflow ──────────────────────────────────────────

    it('asset-wiring includes sprite and sound lookup tools', () => {
        const wf = getWorkflow('asset-wiring')!;
        expect(wf.toolPolicy.tools).to.include('find_sprite_candidates');
        expect(wf.toolPolicy.tools).to.include('find_sound_candidates');
    });

    it('all workflows can query the shared workspace index', () => {
        for (const wf of getAllWorkflows()) {
            expect(wf.toolPolicy.tools, wf.id).to.include('query_workspace_index');
        }
    });

    it('all workflows can query the /init project profile', () => {
        for (const wf of getAllWorkflows()) {
            expect(wf.toolPolicy.tools, wf.id).to.include('query_project_profile');
        }
    });

    // ── Tool policy derivation ─────────────────────────────────────────

    it('getWorkflowAllowedTools returns allowlist directly for allowlist strategy', () => {
        const wf = getWorkflow('diagnostic-fix')!;
        const tools = getWorkflowAllowedTools(wf, []);
        expect(tools).to.deep.equal(wf.toolPolicy.tools);
    });

    // ── Context checking ───────────────────────────────────────────────

    it('checkWorkflowContext returns empty when all required context is present', () => {
        const wf = getWorkflow('diagnostic-fix')!;
        const missing = checkWorkflowContext(wf, { diagnostics: true, activeFile: true, workspace: true });
        expect(missing).to.be.empty;
    });

    it('checkWorkflowContext reports missing required context', () => {
        const wf = getWorkflow('diagnostic-fix')!;
        const missing = checkWorkflowContext(wf, { diagnostics: false, activeFile: false });
        expect(missing.length).to.be.greaterThan(0);
    });

    it('checkWorkflowContext ignores non-required context', () => {
        const wf = getWorkflow('diagnostic-fix')!;
        // activeFile is not required for diagnostic-fix
        const missing = checkWorkflowContext(wf, { diagnostics: true });
        expect(missing).to.be.empty;
    });

    // ── All workflows have prompt supplements where expected ───────────

    it('saves project workflow markdown and parses it back', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-workflow-'));
        try {
            let snapshottedPath = '';
            let snapshottedContent: string | null | undefined = undefined;
            const result = saveProjectWorkflow({
                id: 'Saved Demo',
                title: 'Saved Demo',
                description: 'Reusable saved workflow.',
                mode: 'plan',
                promptSupplement: 'Follow the saved process and verify the result.',
                allowedTools: ['read_file', 'save_workflow', 'unknown_tool' as any],
                requiredContext: ['workspace!'],
                verificationTool: 'get_diagnostics',
            }, tempRoot, (filePath, previousContent) => {
                snapshottedPath = filePath;
                snapshottedContent = previousContent;
            });

            expect(result.success).to.be.true;
            expect(result.id).to.equal('saved-demo');
            expect(result.filePath).to.equal(path.join(tempRoot, '.cwtools-ai', 'workflows', 'saved-demo.md'));
            expect(fs.existsSync(result.filePath!)).to.be.true;
            expect(snapshottedPath).to.equal(result.filePath);
            expect(snapshottedContent).to.equal(null);
            expect(result.workflow!.mode).to.equal('plan');
            expect(result.workflow!.toolPolicy.strategy).to.equal('allowlist');
            expect(result.workflow!.toolPolicy.tools).to.include('read_file');
            expect(result.workflow!.toolPolicy.tools).to.include('save_workflow');
            expect(result.workflow!.toolPolicy.tools).to.not.include('unknown_tool' as any);
            expect(result.workflow!.verification[0]!.verificationTool).to.equal('get_diagnostics');
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('saves script-mode project workflows and parses them back', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-script-workflow-'));
        try {
            const result = saveProjectWorkflow({
                id: 'Script Pipeline',
                title: 'Script Pipeline',
                description: 'Dynamic PDXScript coordination workflow.',
                mode: 'script',
                promptSupplement: 'Dispatch read waves before narrow Builder write waves.',
                allowedTools: ['read_file', 'dispatch_agents', 'query_blackboard', 'merge_results'],
                requiredContext: ['workspace!'],
            }, tempRoot);

            expect(result.success).to.be.true;
            expect(result.workflow!.mode).to.equal('script');
            expect(result.workflow!.toolPolicy.tools).to.include('dispatch_agents');
            expect(result.workflow!.toolPolicy.tools).to.include('merge_results');
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('all workflows have valid structure', () => {
        for (const wf of getAllWorkflows()) {
            expect(wf.id, `${wf.id}.id`).to.be.a('string').and.not.be.empty;
            expect(wf.title, `${wf.id}.title`).to.be.a('string').and.not.be.empty;
            expect(wf.description, `${wf.id}.description`).to.be.a('string').and.not.be.empty;
            expect(wf.mode, `${wf.id}.mode`).to.be.a('string');
            expect(wf.phases, `${wf.id}.phases`).to.be.an('array').and.not.be.empty;
            expect(wf.toolPolicy.tools, `${wf.id}.toolPolicy.tools`).to.be.an('array').and.not.be.empty;
        }
    });
});
