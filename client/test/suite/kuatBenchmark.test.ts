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
    const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const arrayOf = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

    function firstEventId(workspaceRoot: string, operator: string): string | undefined {
        const eventsRoot = path.join(workspaceRoot, 'events');
        for (const file of fs.readdirSync(eventsRoot).filter(name => name.endsWith('.txt')).sort()) {
            const content = fs.readFileSync(path.join(eventsRoot, file), 'utf8');
            const match = new RegExp(`${operator}\\s*=\\s*\\{[\\s\\S]{0,1200}?\\bid\\s*=\\s*"?([A-Za-z0-9_.:-]+)`, 'i').exec(content);
            if (match?.[1]) return match[1];
        }
        return undefined;
    }

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
        assert.deepStrictEqual(profile!.localisation.languages, ['l_english', 'l_simp_chinese'], 'Kuat localisation directories were not normalized semantically.');
        assert.ok(profile!.identifiers.namespaceDetails?.some(item => item.name.toLowerCase().includes('kuat') && item.origin === 'workspace_owned'), 'Kuat namespace provenance was not classified.');
        const softDependencies = profile!.compatibility?.possibleSoftDependencies ?? [];
        assert.ok(softDependencies.some(item => item.idOrPrefix === 'acot' && item.sources?.includes('placeholder') && item.sources?.includes('ignored_diagnostic')), 'Kuat ACOT soft-dependency evidence was not merged.');
        assert.ok(softDependencies.some(item => item.idOrPrefix === 'giga'), 'Kuat Gigastructures compatibility evidence was not inferred.');
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

        const carrierEventId = firstEventId(workspaceRoot!, 'carrier_event');
        const situationEventId = firstEventId(workspaceRoot!, 'situation_event');
        assert.ok(carrierEventId, 'Kuat fixture no longer contains a carrier_event semantic sample.');
        assert.ok(situationEventId, 'Kuat fixture no longer contains a situation_event semantic sample.');
        const scenarios: Array<{ name: string; command: string; args: unknown[] }> = [
            {
                name: 'inline-template', command: 'cwtools.ai.queryProjectKnowledgeDb', args: [{
                    databasePath, identifiers: ['kuat_reasearch_event/kuat_system_research_repeatable_options'],
                    includeEventGraph: true, limit: 100,
                }],
            },
            {
                name: 'carrier-event', command: 'cwtools.ai.queryProjectKnowledgeDb', args: [{
                    databasePath, identifiers: [carrierEventId], includeEventGraph: true, limit: 100,
                }],
            },
            {
                name: 'situation-event', command: 'cwtools.ai.queryProjectKnowledgeDb', args: [{
                    databasePath, identifiers: [situationEventId], includeEventGraph: true, limit: 100,
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
            if (scenario.name === 'inline-live') {
                assert.ok(arrayOf(record.invocations).length > 0, 'Kuat inline query returned no invocations.');
                assert.ok(arrayOf(record.expansions).length > 0 || arrayOf(record.generatedReferences).length > 0, 'Kuat inline query returned no instantiated semantics.');
            } else if (scenario.name === 'pdx-flow') {
                assert.ok(Number(record.version) >= 4, 'Kuat PDX flow result predates inline/interprocedural cost propagation.');
                const coverage = recordOf(record.coverage);
                assert.ok(Number(coverage.definitionsConsidered) > 0, 'Kuat PDX flow did not analyze a definition.');
                assert.ok(Array.isArray(record.propagatedCosts), 'Kuat PDX flow omitted propagatedCosts.');
            } else if (scenario.name === 'event-state' || scenario.name === 'carrier-event' || scenario.name === 'situation-event') {
                const eventGraph = recordOf(record.eventGraph);
                const expected = scenario.name === 'carrier-event' ? carrierEventId
                    : scenario.name === 'situation-event' ? situationEventId : 'kuat_extramonster_expand.35';
                assert.ok(arrayOf(eventGraph.nodes).some(node => String(recordOf(node).id ?? recordOf(node).eventId) === expected), `${scenario.name} did not return its typed event node.`);
            } else if (scenario.name === 'interface-graph') {
                assert.ok(arrayOf(record.nodes).length > 0, 'Kuat interface graph returned no nodes.');
                assert.ok(arrayOf(record.edges).length > 0, 'Kuat interface graph returned no edges.');
            } else if (scenario.name === 'localisation-audit') {
                assert.ok(arrayOf(record.languages).length >= 2 || arrayOf(record.entries).length > 0, 'Kuat localisation audit returned no bilingual evidence.');
            }
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
