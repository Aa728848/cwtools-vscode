import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildProjectProfile,
    extractCustomRules,
    getProjectProfilePath,
    mergeDeepCompatibilityEvidence,
    queryProjectProfile,
    readProjectProfile,
    renderProjectRulesMarkdown,
} from '../../extension/ai/projectProfile';

describe('ProjectProfile localisation detection', () => {
    const tempBase = path.resolve(__dirname, '../../..', '.tmp-test-profile');

    function makeWorkspace(): string {
        fs.mkdirSync(tempBase, { recursive: true });
        return fs.mkdtempSync(path.join(tempBase, 'profile-test-'));
    }

    function cleanupWorkspace(workspaceRoot: string): void {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        try {
            fs.rmdirSync(tempBase);
        } catch {
            // directory not empty or busy
        }
    }

    it('should extract correct languages and avoid greedy parsing errors in filenames', () => {
        const workspaceRoot = makeWorkspace();
        try {
            const locDir = path.join(workspaceRoot, 'localisation');
            fs.mkdirSync(locDir, { recursive: true });

            // 写入几个代表性的本地化文件名，包含容易导致贪婪匹配错误的复杂文件名
            const testFiles = [
                'l_english.yml',
                'something_l_french.yml',
                'exe_eternal_throne_story_l_simp_chinese.yml', // 极易触发 eternal -> throne_story_l_simp_chinese 的贪婪匹配
                'my_l_cool_l_simp_chinese.yml',               // 包含多个 l_ 的混淆情况
            ];

            for (const file of testFiles) {
                fs.writeFileSync(path.join(locDir, file), '\ufeff# Empty loc file', 'utf8');
            }

            const profile = buildProjectProfile(workspaceRoot);

            // 验证语言标识是否精准提取并正确映射为 l_<lang>
            // 预期的语言只有 l_english, l_french, l_simp_chinese
            expect(profile.localisation.languages).to.deep.equal([
                'l_english',
                'l_french',
                'l_simp_chinese'
            ]);

            // 验证绝对不应该提取出的脏词
            expect(profile.localisation.languages).to.not.include('l_throne_story_l_simp_chinese');
            expect(profile.localisation.languages).to.not.include('l_cool_l_simp_chinese');
            expect(profile.localisation.languages).to.not.include('l_eternal_throne_story_l_simp_chinese');

        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('should fallback to path parts if filename does not contain l_ tag', () => {
        const workspaceRoot = makeWorkspace();
        try {
            // 在子目录中包含特定的语言目录名
            const locDir = path.join(workspaceRoot, 'localisation', 'l_simp_chinese');
            fs.mkdirSync(locDir, { recursive: true });
            fs.writeFileSync(path.join(locDir, 'events.yml'), '\ufeff# Empty', 'utf8');

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.localisation.languages).to.deep.equal(['l_simp_chinese']);
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('reports every first-level language directory even without matching files', () => {
        const workspaceRoot = makeWorkspace();
        try {
            const locDir = path.join(workspaceRoot, 'localisation');
            fs.mkdirSync(path.join(locDir, 'l_english'), { recursive: true });
            fs.mkdirSync(path.join(locDir, 'l_simp_chinese'), { recursive: true });
            fs.writeFileSync(path.join(locDir, 'l_english', 'events.yml'), '\ufeffl_english:\n', 'utf8');
            fs.writeFileSync(path.join(locDir, 'l_simp_chinese', 'events.yml'), '\ufeffl_simp_chinese:\n', 'utf8');

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.localisation.languages).to.deep.equal(['l_english', 'l_simp_chinese']);
            expect(profile.localisation.defaultLanguage).to.equal(undefined);
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('normalizes Stellaris english and simp_chinese directory names without an l_ prefix', () => {
        const workspaceRoot = makeWorkspace();
        try {
            const locDir = path.join(workspaceRoot, 'localisation');
            fs.mkdirSync(path.join(locDir, 'english'), { recursive: true });
            fs.mkdirSync(path.join(locDir, 'simp_chinese'), { recursive: true });
            fs.writeFileSync(path.join(locDir, 'english', 'samplemod.yml'), '\ufeffl_english:\n', 'utf8');
            fs.writeFileSync(path.join(locDir, 'simp_chinese', 'samplemod.yml'), '\ufeffl_simp_chinese:\n', 'utf8');

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.localisation.languages).to.deep.equal(['l_english', 'l_simp_chinese']);
            expect(profile.localisation.encoding).to.equal('UTF-8 with BOM');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('flags header mismatches and mixed BOM as warnings', () => {
        const workspaceRoot = makeWorkspace();
        try {
            const locDir = path.join(workspaceRoot, 'localisation', 'l_english');
            fs.mkdirSync(locDir, { recursive: true });
            fs.writeFileSync(path.join(locDir, 'a.yml'), '\ufeffl_english:\n', 'utf8');
            fs.writeFileSync(path.join(locDir, 'b.yml'), 'l_english:\n', 'utf8'); // no BOM, mixed with a.yml

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.localisation.encodingByLanguage).to.not.equal(undefined);
            expect(profile.warnings ?? []).to.satisfy((warnings: string[]) => warnings.some(warning => warning.includes('mixes BOM')));
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('should not report configured vanillaCache for an empty .cwtools directory', () => {
        const workspaceRoot = makeWorkspace();
        try {
            fs.mkdirSync(path.join(workspaceRoot, '.cwtools'));

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.validation.vanillaCache).to.equal('missing');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('reports configured vanillaCache only when a readable cache file exists', () => {
        const workspaceRoot = makeWorkspace();
        try {
            fs.mkdirSync(path.join(workspaceRoot, '.cwtools'));
            fs.writeFileSync(path.join(workspaceRoot, '.cwtools', 'stl.cwb'), 'binary-cache-data', 'utf8');

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.validation.vanillaCache).to.equal('configured');
            expect(profile.validation.vanillaCacheEvidence).to.match(/stl\.cwb$/);
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('discovers current content directories without a fixed entity-family list', () => {
        const workspaceRoot = makeWorkspace();
        try {
            const typedDir = path.join(workspaceRoot, 'common', 'ritual_definitions');
            fs.mkdirSync(typedDir, { recursive: true });
            fs.writeFileSync(path.join(typedDir, 'sample.txt'), 'sample_ritual = { }\n', 'utf8');

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.keyDirectories.map(directory => directory.path)).to.include('common/ritual_definitions');
            expect(profile.identifiers.byType).to.deep.equal({});
            expect(profile.identifiers.scriptedEffects).to.equal(undefined);
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('does not double count common vs its child directories', () => {
        const workspaceRoot = makeWorkspace();
        try {
            fs.mkdirSync(path.join(workspaceRoot, 'common', 'events'), { recursive: true });
            fs.mkdirSync(path.join(workspaceRoot, 'common', 'on_actions'), { recursive: true });
            fs.writeFileSync(path.join(workspaceRoot, 'common', 'direct.txt'), 'x = { }\n', 'utf8');
            fs.writeFileSync(path.join(workspaceRoot, 'common', 'events', 'e.txt'), 'event_a = { }\n', 'utf8');
            fs.writeFileSync(path.join(workspaceRoot, 'common', 'on_actions', 'o.txt'), 'on_x = { }\n', 'utf8');

            const profile = buildProjectProfile(workspaceRoot);
            const common = profile.keyDirectories.find(dir => dir.path === 'common');

            expect(common?.fileCount).to.equal(1);
            expect(profile.keyDirectories.map(dir => dir.path)).to.include('common/events');
            expect(profile.keyDirectories.map(dir => dir.path)).to.include('common/on_actions');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('extracts descriptor supported_version, remote_file_id and dependencies', () => {
        const workspaceRoot = makeWorkspace();
        try {
            fs.writeFileSync(path.join(workspaceRoot, 'descriptor.mod'), [
                'name="SampleMod Test Mod"',
                'supported_version="3.12.*"',
                'remote_file_id="123456789"',
                'tags={"Fleet" "Events"}',
                'dependencies={"Another Mod" "Third Mod"}',
            ].join('\n'), 'utf8');

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.modInfo?.supportedVersion).to.equal('3.12.*');
            expect(profile.modInfo?.remoteFileId).to.equal('123456789');
            expect(profile.modInfo?.dependencies).to.deep.equal(['Another Mod', 'Third Mod']);
            expect(profile.compatibility?.declaredDependencies.map(item => item.name)).to.deep.equal(['Another Mod', 'Third Mod']);
            expect(profile.compatibility?.dependencyRoots.every(item => item.status === 'unresolved')).to.equal(true);
            expect(profile.compatibility?.loadOrder.source).to.equal('descriptor_only');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('classifies namespace provenance and infers soft dependencies from compatibility evidence', () => {
        const workspaceRoot = makeWorkspace();
        try {
            const eventsDir = path.join(workspaceRoot, 'events');
            const placeholderDir = path.join(workspaceRoot, 'common', 'scripted_triggers');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(placeholderDir, { recursive: true });
            fs.mkdirSync(path.join(workspaceRoot, '.vscode'), { recursive: true });
            fs.writeFileSync(path.join(eventsDir, 'samplemod_events.txt'), 'namespace = samplemod\ncountry_event = { id = samplemod.1 }\n', 'utf8');
            fs.writeFileSync(path.join(placeholderDir, 'compat_placeholder.txt'), '#_|acot/sofe|\nacot_has_dark_energy = { always = no }\n', 'utf8');
            fs.writeFileSync(path.join(workspaceRoot, '.vscode', 'settings.json'), JSON.stringify({
                'stellarisLanguageServices.ai.ignoredDiagnostics': ['acot_sr_dark_energy', 'giga_system_scale'],
            }), 'utf8');

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.identifiers.namespaceDetails).to.deep.include({
                name: 'samplemod',
                origin: 'workspace_owned',
                files: ['events/samplemod_events.txt'],
                evidence: 'Namespace is declared in ordinary workspace event files.',
            });
            const acot = profile.compatibility?.possibleSoftDependencies.find(item => item.idOrPrefix === 'acot');
            expect(acot?.sources).to.deep.equal(['ignored_diagnostic', 'placeholder']);
            expect(profile.compatibility?.possibleSoftDependencies.map(item => item.idOrPrefix)).to.include('giga');
            expect(profile.compatibility?.coverage.unresolvedIdInference).to.equal('available');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('writes and reads a schemaVersion 2 profile and reports legacy V1 as legacyProfile', () => {
        const workspaceRoot = makeWorkspace();
        try {
            const profile = buildProjectProfile(workspaceRoot);
            expect(profile.schemaVersion).to.equal(2);

            const profilePath = getProjectProfilePath(workspaceRoot);
            fs.mkdirSync(path.dirname(profilePath), { recursive: true });
            fs.writeFileSync(profilePath, JSON.stringify({ ...profile, schemaVersion: 1 }), 'utf8');

            const legacy = readProjectProfile(workspaceRoot);
            expect(legacy?.schemaVersion).to.equal(2);
            expect(legacy?.legacyProfile).to.equal(true);
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });

    it('merges unresolved IDs and definition stacks into compatibility and namespace provenance', () => {
        const workspaceRoot = makeWorkspace();
        try {
            fs.mkdirSync(path.join(workspaceRoot, 'events'), { recursive: true });
            fs.writeFileSync(path.join(workspaceRoot, 'events', 'override_events.txt'), 'namespace = core\ncountry_event = { id = core.1 }\n', 'utf8');
            const profile = buildProjectProfile(workspaceRoot);

            mergeDeepCompatibilityEvidence(profile, {
                unresolved: [{ targetId: 'giga_system_scale', kind: 'missing_reference' }],
                definitionStacks: [{ id: 'core.1', layers: [{ origin: 'vanilla' }, { origin: 'workspace' }] }],
            });

            expect(profile.compatibility?.possibleSoftDependencies.find(item => item.idOrPrefix === 'giga')?.sources).to.include('unresolved_id');
            expect(profile.identifiers.namespaceDetails?.find(item => item.name === 'core')?.origin).to.equal('vanilla_override');
            expect(profile.compatibility?.coverage.evidenceSources).to.include('definition_stack');
        } finally {
            cleanupWorkspace(workspaceRoot);
        }
    });
});

describe('Paradox project profile boundaries', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-project-profile-'));
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('preserves Custom Rules from CRLF CWTOOLS.md content', () => {
        const rules = [
            '# CWTools Agent Project Rules',
            '',
            '## Custom Rules',
            '- KEEP_THIS_RULE',
            '- KEEP_THIS_RULE_TOO',
            '',
        ].join('\r\n');

        expect(extractCustomRules(rules)).to.equal('- KEEP_THIS_RULE\r\n- KEEP_THIS_RULE_TOO');
    });

    it('writes the complete detected directory list to CWTOOLS.md', () => {
        const profile = buildProjectProfile(workspaceRoot);
        profile.keyDirectories = Array.from({ length: 20 }, (_, index) => ({
            key: `dir-${index}`,
            path: `common/dir-${index}`,
            exists: true,
            fileCount: index + 1,
        }));

        const markdown = renderProjectRulesMarkdown(profile);
        expect(markdown).to.include('Complete list of 20 detected directories');
        expect(markdown).to.include('section="directories"');
        expect(markdown).to.include('`common/dir-0`');
        expect(markdown).to.include('`common/dir-19`');
    });

    it('normalizes legacy schemaVersion 1 profiles without identifiers.byType', () => {
        const profile = buildProjectProfile(workspaceRoot);
        const legacy = JSON.parse(JSON.stringify(profile)) as { identifiers: { byType?: unknown } };
        delete legacy.identifiers.byType;
        const profilePath = getProjectProfilePath(workspaceRoot);
        fs.mkdirSync(path.dirname(profilePath), { recursive: true });
        fs.writeFileSync(profilePath, JSON.stringify(legacy), 'utf8');

        expect(readProjectProfile(workspaceRoot)?.identifiers.byType).to.deep.equal({});
    });

    it('normalizes the minimal legacy profile consumed by project-knowledge refreshes', () => {
        const profilePath = getProjectProfilePath(workspaceRoot);
        fs.mkdirSync(path.dirname(profilePath), { recursive: true });
        fs.writeFileSync(profilePath, JSON.stringify({
            schemaVersion: 1,
            game: { id: 'stellaris' },
        }), 'utf8');

        const profile = readProjectProfile(workspaceRoot);
        expect(profile?.game.displayName).to.equal('stellaris');
        expect(profile?.workspaceKind).to.equal('generic');
        expect(profile?.routing.recommendedWorkflowByIntent).to.deep.equal([]);
    });

    it('rejects malformed and oversized profile files instead of throwing into prompt or LSP callers', () => {
        const profilePath = getProjectProfilePath(workspaceRoot);
        fs.mkdirSync(path.dirname(profilePath), { recursive: true });
        fs.writeFileSync(profilePath, '{"schemaVersion":1,"game":null}', 'utf8');
        expect(readProjectProfile(workspaceRoot)).to.equal(null);
        expect(queryProjectProfile(workspaceRoot).status).to.equal('error');

        fs.writeFileSync(profilePath, 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8');
        expect(readProjectProfile(workspaceRoot)).to.equal(null);
        expect(queryProjectProfile(workspaceRoot).status).to.equal('error');
    });

    it('returns compatibility section through query_project_profile', () => {
        const profile = buildProjectProfile(workspaceRoot);
        profile.modInfo = { ...profile.modInfo, supportedVersion: '3.12.*', dependencies: ['Other Mod'] };
        const profilePath = getProjectProfilePath(workspaceRoot);
        fs.mkdirSync(path.dirname(profilePath), { recursive: true });
        fs.writeFileSync(profilePath, JSON.stringify(profile), 'utf8');

        const result = queryProjectProfile(workspaceRoot, { section: 'compatibility' });
        expect(result.status).to.equal('ready');
        const data = result.data as { supportedVersion?: string; dependencies?: string[]; loadOrder?: { confidence: string }; coverage?: { unresolvedIdInference: string } };
        expect(data.supportedVersion).to.equal('3.12.*');
        expect(data.dependencies).to.deep.equal(['Other Mod']);
        expect(data.loadOrder?.confidence).to.equal('partial');
        expect(data.coverage?.unresolvedIdInference).to.equal('not_available');
    });
});
