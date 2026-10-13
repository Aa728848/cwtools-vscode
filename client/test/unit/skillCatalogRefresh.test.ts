/**
 * `/skill` 补全目录的热刷新链路。
 *
 * 背景：斜杠命令目录过去只在「恢复视图状态」和「Webview ready」两处下发，用户在会话
 * 中途通过 `save_skill` 或设置页安装/删除技能后，已经打开的命令弹窗仍按旧目录补全，
 * 必须重开面板才看得到新命令。本文件锁定三件事：
 *   1. `save_skill` 成功后触发一次重发，且重算出的目录包含刚保存的 `/skill:<name>`；
 *   2. 设置页 install/delete 成功后触发重发，删除后目录里不再有该命令；
 *   3. 失败路径（executor 的 result.success=false、install 的 catch、delete 的空目标
 *      提前返回与 catch）都不触发重发。
 * 面板侧的装配（三个触发点是否都接到同一个重发方法）由最后一条源码契约用例锁定——
 * `chatPanel.ts` 依赖 `vscode`，单测无法加载整个模块图，本仓库既有的面板契约也是
 * 用源码文本断言（见 webviewSmoke.test.ts / agentManagerContracts.test.ts）。
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSkills } from '../../extension/ai/skills';
import { getSlashCommandDescriptors } from '../../extension/ai/slashCommands';
import { GENERAL_WRITE } from './schedulingFixtures';
import {
    AgentToolExecutor,
    makeWorkspace,
    cleanupWorkspace,
    resetStubState,
    resetSandboxStorageForTesting,
} from './agentToolSafetyFixtures';

interface SettingsHostMessage {
    type: string;
    skills?: string[];
    success?: boolean;
}

/** A skill folder shaped like a local install source (no network install path). */
function writeLocalSkillFolder(sandbox: string, name: string): string {
    const folder = path.join(sandbox, 'sources', name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
        path.join(folder, 'SKILL.md'),
        `---\nname: ${name}\ndescription: installed from the settings page\n---\n\nFollow ${name}.\n`,
        'utf8',
    );
    return folder;
}

/** The catalog the panel recomputes when the resend callback fires. */
function catalogCommands(roots: { workspaceRoot: string; homeDir: string }): string[] {
    return getSlashCommandDescriptors(
        'en',
        listSkills(roots).map(skill => ({ name: skill.name, description: skill.description })),
    ).map(descriptor => descriptor.command);
}

describe('/skill catalog refresh (save_skill)', () => {
    let workspaceRoot: string;
    let homeDir: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
        homeDir = path.join(workspaceRoot, 'fake-home');
        fs.mkdirSync(homeDir, { recursive: true });
        resetStubState();
        resetSandboxStorageForTesting();
    });

    afterEach(() => {
        resetStubState();
        resetSandboxStorageForTesting();
        cleanupWorkspace(workspaceRoot);
    });

    it('resends once on success and the resend carries the just-saved /skill:<name>', async () => {
        const executor = new AgentToolExecutor({} as never, workspaceRoot);
        const catalogOnResend: string[][] = [];
        executor.onSkillSaved = () => {
            catalogOnResend.push(catalogCommands({ workspaceRoot, homeDir }));
        };

        const saved = await executor.execute('save_skill', {
            name: 'catalog-refresh-skill',
            description: 'Saved mid-session',
            body: '# Steps\n\nDo the thing.',
            scope: 'project',
        }, { runnerOptions: { schedulingState: GENERAL_WRITE } } as never) as { success?: boolean };

        expect(saved.success).to.equal(true);
        expect(catalogOnResend, 'expected exactly one catalog resend').to.have.length(1);
        expect(catalogOnResend[0]).to.include('/skill:catalog-refresh-skill');
        expect(catalogOnResend[0]).to.include('/skill');
    });

    it('never resends on a failed save', async () => {
        const executor = new AgentToolExecutor({} as never, workspaceRoot);
        const catalogOnResend: string[][] = [];
        executor.onSkillSaved = () => {
            catalogOnResend.push(catalogCommands({ workspaceRoot, homeDir }));
        };
        const context = { runnerOptions: { schedulingState: GENERAL_WRITE } } as never;

        expect((await executor.execute('save_skill', {
            name: 'rejected-skill', description: 'd', body: 'b', scope: 'project',
        }, context) as { success?: boolean }).success).to.equal(true);
        expect(catalogOnResend).to.have.length(1);

        // Conflict without overwrite, an unknown allowed_tools entry and a missing
        // scope all return success=false without touching the skill directory.
        const failureCases: Array<Record<string, unknown>> = [
            { name: 'rejected-skill', description: 'again', body: 'b2', scope: 'project' },
            { name: 'bad-tools', description: 'd', body: 'b', scope: 'project', allowed_tools: ['not_a_tool'] },
            { name: 'no-scope', description: 'd', body: 'b' },
        ];
        for (const args of failureCases) {
            const result = await executor.execute('save_skill', args, context) as { success?: boolean };
            expect(result.success, JSON.stringify(args)).to.equal(false);
        }

        expect(catalogOnResend, 'failed saves must not resend the catalog').to.have.length(1);
    });
});

describe('/skill catalog refresh (settings page install/delete)', () => {
    let sandbox: string;
    let homeRoot: string;
    let refreshes: number;
    let messages: SettingsHostMessage[];
    let errors: string[];

    function makeManager(onChanged: (() => void) | undefined): InstanceType<ReturnType<typeof loadManager>> {
        const ChatSettingsManager = loadManager(homeRoot, errors);
        const aiService = { getKeyManager: () => ({ setKey: async () => undefined, deleteKey: async () => undefined }) };
        // Two-argument construction must stay valid; the refresh hook is optional.
        return onChanged
            ? new ChatSettingsManager(aiService as never, (msg: SettingsHostMessage) => messages.push(msg), undefined, onChanged)
            : new ChatSettingsManager(aiService as never, (msg: SettingsHostMessage) => messages.push(msg));
    }

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-skill-catalog-'));
        homeRoot = path.join(sandbox, 'home');
        fs.mkdirSync(homeRoot, { recursive: true });
        refreshes = 0;
        messages = [];
        errors = [];
    });

    afterEach(() => {
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it('adds and removes the /skill:<name> row, refreshing on both successes', async () => {
        const manager = makeManager(() => { refreshes++; });
        await manager.installSkill(writeLocalSkillFolder(sandbox, 'home-installed-skill'));

        expect(refreshes).to.equal(1);
        expect(fs.existsSync(path.join(homeRoot, '.cwtools', 'skills', 'home-installed-skill', 'SKILL.md'))).to.equal(true);
        expect(messages.some(msg => msg.type === 'skillInstallComplete' && msg.success === true)).to.equal(true);
        expect(latestSkillsList()).to.include('home-installed-skill');
        // The resend recomputes from disk, so the row exists the moment it fires.
        expect(catalogCommands({ workspaceRoot: sandbox, homeDir: path.join(homeRoot, '.cwtools') }))
            .to.include('/skill:home-installed-skill');

        await manager.deleteSkill('home-installed-skill');

        expect(refreshes).to.equal(2);
        expect(fs.existsSync(path.join(homeRoot, '.cwtools', 'skills', 'home-installed-skill'))).to.equal(false);
        expect(latestSkillsList()).to.not.include('home-installed-skill');
        expect(catalogCommands({ workspaceRoot: sandbox, homeDir: path.join(homeRoot, '.cwtools') }))
            .to.not.include('/skill:home-installed-skill');
    });

    it('does not refresh when the install fails', async () => {
        const manager = makeManager(() => { refreshes++; });
        // An existing file (not a folder) is a rejected source: the catch path runs.
        const badSource = path.join(sandbox, 'not-a-folder.md');
        fs.writeFileSync(badSource, 'not a skill', 'utf8');

        await manager.installSkill(badSource);

        expect(refreshes, 'a failed install must not resend the catalog').to.equal(0);
        expect(messages.some(msg => msg.type === 'skillInstallComplete' && msg.success === false)).to.equal(true);
        expect(latestSkillsList()).to.deep.equal([]);
    });

    it('does not refresh when the delete removes nothing or throws', async () => {
        const manager = makeManager(() => { refreshes++; });
        await manager.installSkill(writeLocalSkillFolder(sandbox, 'locked-skill'));
        expect(refreshes).to.equal(1);

        // Nothing on disk under that name, and a traversal name the resolver rejects.
        await manager.deleteSkill('never-installed');
        await manager.deleteSkill('../escape');
        expect(refreshes, 'a no-op delete must not resend the catalog').to.equal(1);

        // A failing removal hits the catch block before the success hook.
        const patchable = fs.promises as unknown as { rm: unknown };
        const originalRm = patchable.rm;
        patchable.rm = () => Promise.reject(new Error('directory is locked'));
        try {
            await manager.deleteSkill('locked-skill');
        } finally {
            patchable.rm = originalRm;
        }

        expect(refreshes, 'a failed delete must not resend the catalog').to.equal(1);
        expect(errors.some(line => line.includes('locked')), 'the delete must have failed through the catch path').to.equal(true);
    });

    it('keeps the two-argument construction working without the refresh hook', async () => {
        const manager = makeManager(undefined);
        await manager.installSkill(writeLocalSkillFolder(sandbox, 'legacy-shape-skill'));
        await manager.deleteSkill('legacy-shape-skill');

        expect(refreshes).to.equal(0);
        expect(latestSkillsList()).to.deep.equal([]);
        expect(messages.some(msg => msg.type === 'skillInstallComplete' && msg.success === true)).to.equal(true);
    });

    function latestSkillsList(): string[] {
        const lists = messages.filter(msg => msg.type === 'skillsList');
        return lists.length === 0 ? [] : lists[lists.length - 1]?.skills ?? [];
    }
});

/**
 * Load `chatSettings.ts` with a controlled home directory: `~/.cwtools` is resolved
 * through `os.homedir()`, so the stub keeps the suite from touching the real home and
 * restores the `homeConfig` cache entry so no later test inherits the fake home.
 */
function loadManager(homeRoot: string, errorSink: string[]): typeof import('../../extension/ai/chatSettings').ChatSettingsManager {
    const vscodeStub = {
        workspace: {
            workspaceFolders: [],
            isTrusted: true,
            getConfiguration: () => ({
                get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
                update: async (): Promise<void> => undefined,
            }),
        },
        window: {
            showInformationMessage: () => Promise.resolve(undefined),
            showErrorMessage: (message: string) => { errorSink.push(message); return Promise.resolve(undefined); },
            showWarningMessage: () => Promise.resolve(undefined),
            createOutputChannel: () => ({
                appendLine: () => undefined,
                show: () => undefined,
                clear: () => undefined,
                dispose: () => undefined,
            }),
        },
    };
    const osStub = { ...os, homedir: () => homeRoot };
    const moduleLoader = require('module') as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (...args: unknown[]) {
        const request = args[0];
        if (request === 'vscode') return vscodeStub;
        if (request === 'os') return osStub;
        return originalLoad(...args);
    };
    const homeConfigPath = require.resolve('../../extension/ai/homeConfig');
    const cachedHomeConfig = require.cache[homeConfigPath];
    try {
        delete require.cache[homeConfigPath];
        for (const target of ['../../extension/ai/chatSettings', '../../extension/ai/errorReporter']) {
            delete require.cache[require.resolve(target)];
        }
        return (require('../../extension/ai/chatSettings') as typeof import('../../extension/ai/chatSettings')).ChatSettingsManager;
    } finally {
        moduleLoader._load = originalLoad;
        if (cachedHomeConfig) require.cache[homeConfigPath] = cachedHomeConfig;
        else delete require.cache[homeConfigPath];
    }
}

describe('/skill catalog refresh (panel wiring contract)', () => {
    const root = path.resolve(__dirname, '../../..');

    it('routes the two bootstrap sends and all three skill-changing paths through one resend method', () => {
        const host = fs.readFileSync(path.join(root, 'client/extension/ai/chatPanel.ts'), 'utf8');

        // One implementation, three callers: the catalog payload is assembled once.
        expect(host.match(/type: 'slashCommandList'/g) ?? []).to.have.length(1);
        expect(host).to.include("send({ type: 'slashCommandList', commands: this.slashCommandCatalog() });");
        // _restoreViewState + _syncViewChromeState share it, so the payload cannot drift.
        expect(host.match(/this[.]sendSlashCommandCatalog[(]send[)][;]/g) ?? []).to.have.length(2);
        // save_skill (executor) and the settings page (install/delete) both resend.
        expect(host).to.include('this.agentRunner.toolExecutor.onSkillSaved = () => this.sendSlashCommandCatalog();');
        expect(host).to.include('storageUri?.fsPath, () => this.sendSlashCommandCatalog()');

        const settings = fs.readFileSync(path.join(root, 'client/extension/ai/chatSettings.ts'), 'utf8');
        expect(settings.match(/this[.]onSkillCatalogChanged[?][.][(][)][;]/g) ?? []).to.have.length(2);

        const agentTools = fs.readFileSync(path.join(root, 'client/extension/ai/agentTools.ts'), 'utf8');
        expect(agentTools.match(/this[.]onSkillSaved[?][.][(][)][;]/g) ?? []).to.have.length(1);
    });
});
