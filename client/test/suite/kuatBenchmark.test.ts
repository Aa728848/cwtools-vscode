import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateInitFile } from '../../extension/ai/chatInit';
import { generateProjectKnowledge } from '../../extension/ai/projectKnowledge';
import { readProjectProfile } from '../../extension/ai/projectProfile';
import { IndexService } from '../../extension/indexing/indexService';
import { activate } from '../utils';

suite('Stellaris Agent real-project benchmark', function () {
    const requestedRoot = process.env.CWTOOLS_BENCHMARK_WORKSPACE;
    const run = requestedRoot ? test : test.skip;

    run('rebuilds and queries the configured real project', async function () {
        this.timeout(20 * 60 * 1000);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        assert.ok(workspaceRoot, 'A workspace folder is required.');
        assert.strictEqual(path.resolve(workspaceRoot!), path.resolve(requestedRoot!), 'Benchmark workspace does not match CWTOOLS_BENCHMARK_WORKSPACE.');
        await activate();

        const index = new IndexService();
        await index.start();
        const startedAt = Date.now();
        try {
            const init = await generateInitFile(() => undefined, () => undefined, index);
            assert.strictEqual(init.success, true, 'Kuat /init failed');
        } finally {
            index.dispose();
        }
        const fullExportDurationMs = Date.now() - startedAt;
        const knowledgeRoot = path.join(workspaceRoot!, '.cwtools', 'project', 'knowledge');
        const manifestPath = path.join(knowledgeRoot, 'manifest.json');
        const databasePath = path.join(knowledgeRoot, 'knowledge.sqlite');
        const fullManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        assert.strictEqual(fullManifest.schemaVersion, 7);
        assert.ok(fullManifest.status === 'ready' || fullManifest.status === 'partial', `Unexpected knowledge status: ${String(fullManifest.status)}`);

        const profile = readProjectProfile(workspaceRoot!);
        assert.ok(profile, 'Kuat project profile was not generated.');
        const incrementalStartedAt = Date.now();
        const incrementalManifest = await generateProjectKnowledge(workspaceRoot!, profile!, {
            mode: 'incremental',
            changedFiles: [path.join(workspaceRoot!, 'events', 'kuat_under_shadow_extramonster_expand_events.txt')],
            complete: true,
            requireReady: true,
        });
        const incrementalExportDurationMs = Date.now() - incrementalStartedAt;
        assert.strictEqual(incrementalManifest.schemaVersion, 7);
        assert.strictEqual(incrementalManifest.generationMode, 'incremental');
        assert.ok(incrementalManifest.baseline, 'Incremental export omitted its baseline metrics.');
        assert.ok(incrementalManifest.coverage, 'Incremental export omitted coverage metrics.');

        const scenarios: Array<{ name: string; command: string; args: unknown[] }> = [
            {
                name: 'inline-template', command: 'cwtools.ai.queryProjectKnowledgeDb', args: [{
                    databasePath, identifiers: ['kuat_reasearch_event/kuat_system_research_repeatable_options'],
                    includeEventGraph: true, limit: 100,
                }],
            },
            {
                name: 'event-state', command: 'cwtools.ai.queryProjectKnowledgeDb', args: [{
                    databasePath, identifiers: ['kuat_extramonster_expand.35'], includeEventGraph: true, limit: 100,
                }],
            },
            {
                name: 'inline-live', command: 'cwtools.ai.exploreInlineGraph', args: [{
                    template: 'kuat_reasearch_event/kuat_system_research_repeatable_options', limit: 100,
                }],
            },
            {
                name: 'pdx-flow', command: 'cwtools.ai.analyzePdxFlow', args: [{
                    definitionId: 'kuat_extramonster_expand.35', entityType: 'event', limit: 100,
                }],
            },
            {
                name: 'definition-override', command: 'cwtools.ai.compareDefinitionWithVanilla',
                args: ['event', 'kuat_extramonster_expand.35'],
            },
            {
                name: 'interface-graph', command: 'cwtools.ai.exploreProject', args: [
                    '', path.join(workspaceRoot!, 'interface', 'kuat_system_selector_ui.gui'),
                    '', false, 2, 100, 200, true,
                ],
            },
            {
                name: 'localisation-audit', command: 'cwtools.ai.queryLocalisationAudit', args: [{
                    key: 'kuat_extramonster_expand', prefix: true, limit: 100,
                }],
            },
        ];
        const results: Record<string, unknown> = {};
        for (const scenario of scenarios) {
            const samples: number[] = [];
            let last: unknown;
            for (let iteration = 0; iteration < 20; iteration++) {
                const queryStartedAt = performance.now();
                last = await vscode.commands.executeCommand(scenario.command, ...scenario.args);
                samples.push(performance.now() - queryStartedAt);
            }
            samples.sort((a, b) => a - b);
            const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)]!;
            assert.ok(p95 < 2_000, `${scenario.name} p95 ${p95.toFixed(2)}ms exceeded 2s`);
            const record = last && typeof last === 'object' ? last as Record<string, unknown> : {};
            assert.notStrictEqual(record.ok, false, `${scenario.name} returned an error`);
            results[scenario.name] = { p95Ms: p95, lastResult: last };
        }

        const report = {
            generatedAt: new Date().toISOString(),
            workspaceRoot,
            fullExportDurationMs,
            incrementalExportDurationMs,
            databaseSizeBytes: fs.statSync(databasePath).size,
            manifestStatus: incrementalManifest.status,
            schemaVersion: incrementalManifest.schemaVersion,
            fullBaseline: fullManifest.baseline,
            fullCoverage: fullManifest.coverage,
            incrementalBaseline: incrementalManifest.baseline,
            incrementalCoverage: incrementalManifest.coverage,
            scenarios: results,
        };
        fs.writeFileSync(path.join(knowledgeRoot, 'kuat-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    });
});
