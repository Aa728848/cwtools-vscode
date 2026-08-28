import { expect } from 'chai';
import { classifyRecoveryError } from '../../extension/ai/runner/recoveryCoordinator';

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
        workspaceFolders: [],
        textDocuments: [],
        isTrusted: true,
    },
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
    languages: {
        getDiagnostics: () => [],
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
};

function loadAgentRunner(options: { freshLiveContext?: boolean } = {}) {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    const agentRunnerPath = require.resolve('../../extension/ai/agentRunner');
    const liveContextPath = require.resolve('../../extension/ai/runner/liveContext');
    const cachedAgentRunner = require.cache[agentRunnerPath];
    const cachedLiveContext = require.cache[liveContextPath];
    if (options.freshLiveContext) {
        delete require.cache[agentRunnerPath];
        delete require.cache[liveContextPath];
    }
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner');
    } finally {
        moduleLoader._load = originalLoad;
        if (options.freshLiveContext) {
            delete require.cache[agentRunnerPath];
            delete require.cache[liveContextPath];
            if (cachedAgentRunner) require.cache[agentRunnerPath] = cachedAgentRunner;
            if (cachedLiveContext) require.cache[liveContextPath] = cachedLiveContext;
        }
    }
}

describe('AgentRunner 状态机与工具调度测试 (阶段 0 基线)', () => {
    describe('工具结果健康状态', () => {
        it('把带 success=false 或 ok=false 的结构化结果计为失败', () => {
            const { isToolResultFailure } = loadAgentRunner();
            expect(isToolResultFailure({ success: false, error: 'denied' })).to.equal(true);
            expect(isToolResultFailure({ ok: false, error: 'invalid args' })).to.equal(true);
            expect(isToolResultFailure({ error: 'thrown error' })).to.equal(true);
            expect(isToolResultFailure({ success: true })).to.equal(false);
            expect(isToolResultFailure({ diagnostics: [] })).to.equal(false);
        });
    });
    
    describe('Token 估算逻辑', () => {
        it('能够对纯 ASCII 文本进行快速估算 (短文本)', () => {
            const { estimateTokenCount } = loadAgentRunner();
            const text = 'hello world';
            // 短文本 (< 1000) 采用 estimateTokensFast 算法
            // 纯 ASCII 每一个 token 约等于 4 个字符
            const estimated = estimateTokenCount(text);
            expect(estimated).to.equal(3); // Math.ceil(11 / 4) = 3
        });

        it('能够对中英文混合文本进行估算', () => {
            const { estimateTokenCount } = loadAgentRunner();
            const text = '你好，世界！hello';
            // 短文本快速估算，包含 CJK 字符
            const estimated = estimateTokenCount(text);
            // 6个CJK，5个ASCII字符。混合 charsPerToken = 4*(5/11) + 1.5*(6/11) = 2.636
            // Math.ceil(11 / 2.636) = 5
            expect(estimated).to.be.closeTo(5, 2);
        });

        it('在大文本场景下使用精确估算', () => {
            const { estimateTokenCount } = loadAgentRunner();
            // 构造长于 1000 字符的文本以触发 estimateTokensPrecise 算法
            const longText = 'hello '.repeat(250); // 1500 字符
            const estimated = estimateTokenCount(longText);
            expect(estimated).to.be.closeTo(250, 50);
        });

        it('counts provider-native continuation state in context estimates', () => {
            const { estimateChatMessageTokens } = loadAgentRunner();
            const plain = estimateChatMessageTokens({ role: 'assistant', content: 'ok' });
            const withResponsesState = estimateChatMessageTokens({
                role: 'assistant',
                content: 'ok',
                responses_output_items: [{ type: 'reasoning', encrypted_content: 'x'.repeat(4000) }],
            });
            expect(withResponsesState).to.be.greaterThan(plain + 500);
        });
    });

    describe('统一恢复错误分类', () => {
        it('识别 5xx 服务器端错误', () => {
            expect(classifyRecoveryError('API returns 502 Bad Gateway').kind).to.equal('provider');
            expect(classifyRecoveryError(new Error('Internal error 500')).kind).to.equal('provider');
            expect(classifyRecoveryError('503 Service Temporarily Unavailable').kind).to.equal('provider');
        });

        it('识别网络超时和重置错误', () => {
            expect(classifyRecoveryError('request timed out').kind).to.equal('transport');
            expect(classifyRecoveryError(new Error('ETIMEDOUT')).kind).to.equal('transport');
            expect(classifyRecoveryError('ECONNRESET').kind).to.equal('transport');
        });

        it('区分限流与不可恢复业务错误', () => {
            expect(classifyRecoveryError('Invalid API Key').kind).to.equal('unknown');
            expect(classifyRecoveryError(new Error('rate limit reached')).kind).to.equal('rate_limit');
        });
    });

    describe('工具调度文件路径解析 (Tool Scheduling)', () => {
        it('正确解析 write_file 的目标文件路径', () => {
            const { getAgentToolTargetFiles } = loadAgentRunner();
            const workspaceRoot = 'C:\\workspace';
            const args = { file: 'events/test.txt' };
            const files = getAgentToolTargetFiles('write_file', args, workspaceRoot);
            
            expect(files).to.have.lengthOf(1);
            expect(files[0]).to.equal('C:\\workspace\\events\\test.txt');
        });

        it('正确解析 replace_lines 和 write_localisation 的 filePath 路径', () => {
            const { getAgentToolTargetFiles } = loadAgentRunner();
            const workspaceRoot = 'C:\\workspace';
            const args = { filePath: 'localisation/simp_chinese/l_simp_chinese.yml' };
            
            const filesRep = getAgentToolTargetFiles('replace_lines', args, workspaceRoot);
            expect(filesRep[0]).to.equal('C:\\workspace\\localisation\\simp_chinese\\l_simp_chinese.yml');

            const filesLoc = getAgentToolTargetFiles('write_localisation', args, workspaceRoot);
            expect(filesLoc[0]).to.equal('C:\\workspace\\localisation\\simp_chinese\\l_simp_chinese.yml');
        });

        it('能够对绝对路径跳过工作区前缀解析', () => {
            const { getAgentToolTargetFiles } = loadAgentRunner();
            const workspaceRoot = 'C:\\workspace';
            const args = { file: 'D:\\absolute\\events\\test.txt' };
            const files = getAgentToolTargetFiles('write_file', args, workspaceRoot);

            expect(files).to.have.lengthOf(1);
            // 确保使用 path.resolve 后的标准格式
            expect(files[0]!.toLowerCase()).to.equal('d:\\absolute\\events\\test.txt');
        });
    });

    describe('同名覆盖工具定义 (Superseded Write Tools)', () => {
        it('确认 write_file 被标记为可覆盖写工具', () => {
            const { SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } = loadAgentRunner();
            expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('write_file')).to.equal(true);
            expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('replace_lines')).to.equal(false);
        });
    });
});

describe('AgentRunner 手动上下文压缩集成', () => {
    it('低于自动阈值时仍执行一次用户请求的 summarizer', async () => {
        const { AgentRunner } = loadAgentRunner({ freshLiveContext: true });
        let calls = 0;
        const aiService = {
            getConfig: () => ({
                provider: 'openai',
                model: 'gpt-test',
                endpoint: '',
                customApiFormat: 'openai-chat-completions',
                maxContextTokens: 128_000,
            }),
            getEndpointForProvider: () => '',
            chatCompletion: async () => {
                calls++;
                return {
                    choices: [{ message: { role: 'assistant', content: 'MANUAL_SUMMARY' }, finish_reason: 'stop' }],
                };
            },
        };
        const toolExecutor = { parentAgentRunner: undefined };
        const promptBuilder = { buildCompactionPrompt: () => 'compact' };
        const runner = new AgentRunner(aiService as any, toolExecutor as any, promptBuilder as any);
        const history = [
            { role: 'user' as const, content: 'short request' },
            { role: 'assistant' as const, content: 'short answer' },
        ];

        const result = await runner.compactActiveHistory(history);

        expect(calls).to.equal(1);
        expect(result.compacted).to.equal(true);
        expect(history.some(message => String(message.content).includes('MANUAL_SUMMARY'))).to.equal(true);
    });
});
