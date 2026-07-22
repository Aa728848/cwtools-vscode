import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { buildProjectProfile } from '../../extension/ai/projectProfile';

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

    it('should detect the canonical .cwtools vanilla cache directory', () => {
        const workspaceRoot = makeWorkspace();
        try {
            fs.mkdirSync(path.join(workspaceRoot, '.cwtools'));

            const profile = buildProjectProfile(workspaceRoot);

            expect(profile.validation.vanillaCache).to.equal('configured');
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
});
