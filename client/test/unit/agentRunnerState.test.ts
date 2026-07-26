import { expect } from 'chai';

const vscodeStub = {
    workspace: {
        getConfiguration: () => ({
            get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        }),
        workspaceFolders: [],
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

function loadAgentRunner() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

describe('AgentRunner 状态机与工具调度测试 (阶段 0 基线)', () => {
    
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

    describe('API 错误回退 (Fallback) 判定', () => {
        it('识别 5xx 服务器端错误', () => {
            const { isFallbackEligibleApiError } = loadAgentRunner();
            expect(isFallbackEligibleApiError('API returns 502 Bad Gateway')).to.equal(true);
            expect(isFallbackEligibleApiError(new Error('Internal error 500'))).to.equal(true);
            expect(isFallbackEligibleApiError('503 Service Temporarily Unavailable')).to.equal(true);
        });

        it('识别网络超时和重置错误', () => {
            const { isFallbackEligibleApiError } = loadAgentRunner();
            expect(isFallbackEligibleApiError('request timed out')).to.equal(true);
            expect(isFallbackEligibleApiError(new Error('ETIMEDOUT'))).to.equal(true);
            expect(isFallbackEligibleApiError('ECONNRESET')).to.equal(true);
        });

        it('普通业务错误不应被判定为 fallback-eligible', () => {
            const { isFallbackEligibleApiError } = loadAgentRunner();
            expect(isFallbackEligibleApiError('Invalid API Key')).to.equal(false);
            expect(isFallbackEligibleApiError(new Error('rate limit reached'))).to.equal(false);
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
