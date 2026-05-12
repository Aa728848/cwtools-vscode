/**
 * Eddy CWTool Code — 质量门
 *
 * Builder Agent 完成后自动触发 Reviewer Agent 进行审查。
 * 支持多轮修复循环（最多 3 轮），确保代码质量。
 */

import type { SubAgentResult, TaskNode } from './types';
import type { AgentStep } from '../types';

/** 质量门审查结果 */
export interface QualityGateResult {
    /** 是否通过质量门 */
    passed: boolean;
    /** 审查报告 */
    reviewReport: string;
    /** 修复循环次数 */
    fixCycles: number;
    /** 最终剩余的未修复问题数 */
    remainingIssues: number;
}

/** 质量门配置 */
export interface QualityGateConfig {
    /** 最大修复循环次数 */
    maxFixCycles: number;
    /** 是否启用自动修复（false = 仅报告） */
    autoFix: boolean;
}

/** 默认配置 */
const DEFAULT_CONFIG: QualityGateConfig = {
    maxFixCycles: 3,
    autoFix: true,
};

/**
 * 质量门。
 *
 * 工作流程：
 * 1. Builder Agent 完成代码生成
 * 2. QualityGate 自动生成审查 prompt（基于 Builder 写入的文件列表）
 * 3. 调用 Reviewer Agent 审查
 * 4. 如果发现问题且 autoFix = true：
 *    - 生成修复 prompt 并调用 Builder Agent 修复
 *    - 重新审查（最多 maxFixCycles 轮）
 * 5. 输出最终审查报告
 */
export class QualityGate {
    private config: QualityGateConfig;

    constructor(config?: Partial<QualityGateConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 生成综合审查 prompt。
     * 基于所有写入的文件列表构建针对性的审查指令。
     */
    buildCombinedReviewPrompt(writtenFiles: string[], preFetchedDiagnostics?: string): string {
        const fileList = writtenFiles.length > 0
            ? writtenFiles.map(f => `- ${f}`).join('\n')
            : '(No file write records)';

        const diagnosticsSection = preFetchedDiagnostics 
            ? `\n## Pre-fetched LSP Diagnostics:\n${preFetchedDiagnostics}\n` 
            : '';

        return [
            '## Quality Gate Review Task',
            '',
            'Please review the code quality of the following files:',
            fileList,
            diagnosticsSection,
            'Review Checklist:',
            '1. Call `get_diagnostics` for each file to check for LSP errors (or review the pre-fetched diagnostics above). You MUST resolve ALL LSP red errors!',
            '2. Check for logic conflict issues (e.g., an event has `option` but uses `hide_window = yes`, which is a contradiction). Such conflicts MUST be reported and fixed.',
            '3. Check cross-file reference consistency (Event IDs, Modifier names, Localization keys).',
            '4. Verify the correctness of the scope chain.',
            '5. Check file structure integrity (Refer to Rule 3b).',
            '',
            'Output Format:',
            '- If all files have zero errors and no logic conflicts: Output "PASSED: All files passed quality checks."',
            '- If there are errors or logic conflicts: Output "FAILED: N issues need to be fixed", and list the specific issues and fix suggestions in detail.',
        ].join('\n');
    }

    /**
     * 执行审查。
     * 拉起 Reviewer Agent 并分析结果。
     */
    async reviewOutput(
        agentRunner: import('../agentRunner').AgentRunner,
        writtenFiles: string[],
        options: Partial<import('../agentRunner').AgentRunnerOptions>,
    ): Promise<QualityGateResult> {
        if (writtenFiles.length === 0) {
            return { passed: true, reviewReport: '无文件修改', fixCycles: 0, remainingIssues: 0 };
        }

        let preFetchedDiagnostics = '';
        try {
            const diagResults: string[] = [];
            for (const file of writtenFiles) {
                if (!file.endsWith('.txt') && !file.endsWith('.gui')) continue;
                const res = await agentRunner.toolExecutor.execute('get_diagnostics', { file, severity: 'error' });
                if (res && typeof res === 'object' && (res as any).totalDiagnosticCount > 0) {
                    diagResults.push(`File: ${file}\n${JSON.stringify((res as any).diagnostics, null, 2)}`);
                }
            }
            if (diagResults.length > 0) {
                preFetchedDiagnostics = diagResults.join('\n\n');
            }
        } catch (e) {
            // ignore
        }

        const prompt = this.buildCombinedReviewPrompt(writtenFiles, preFetchedDiagnostics);
        
        // 执行 Reviewer Agent
        const reviewResult = await agentRunner.run(
            prompt,
            {}, // context
            [], // conversationHistory
            {
                ...options,
                mode: 'review', // 强制使用审查模式
            }
        );

        const parsed = this.parseReviewResult(reviewResult.explanation);
        
        return {
            passed: parsed.passed,
            reviewReport: reviewResult.explanation,
            fixCycles: 0,
            remainingIssues: parsed.issueCount,
        };
    }

    /**
     * (保留旧接口兼容) 生成审查 prompt。
     */
    buildReviewPrompt(builderResult: SubAgentResult, preFetchedDiagnostics?: string): string {
        const fileList = builderResult.writtenFiles.length > 0
            ? builderResult.writtenFiles.map(f => `- ${f}`).join('\n')
            : '(No file write records)';

        const diagnosticsSection = preFetchedDiagnostics 
            ? `\n## Pre-fetched LSP Diagnostics:\n${preFetchedDiagnostics}\n` 
            : '';

        return [
            '## Quality Gate Review Task',
            '',
            'Please review the code quality of the following files:',
            fileList,
            diagnosticsSection,
            'Review Checklist:',
            '1. Call `get_diagnostics` for each file to check for LSP errors (or review the pre-fetched diagnostics above). You MUST resolve ALL LSP red errors!',
            '2. Check for logic conflict issues (e.g., an event has `option` but uses `hide_window = yes`, which is a contradiction). Such conflicts MUST be reported and fixed.',
            '3. Check cross-file reference consistency (Event IDs, Modifier names, Localization keys).',
            '4. Verify the correctness of the scope chain.',
            '5. Check file structure integrity (Refer to Rule 3b).',
            '',
            'Output Format:',
            '- If all files have zero errors and no logic conflicts: Output "PASSED: All files passed quality checks."',
            '- If there are errors or logic conflicts: Output "FAILED: N issues need to be fixed", and list the specific issues.',
        ].join('\n');
    }

    /**
     * 生成修复 prompt。
     * 基于 Reviewer 的审查报告，构建修复指令。
     */
    buildFixPrompt(reviewReport: string, writtenFiles: string[]): string {
        return [
            '## Quality Gate Fix Task',
            '',
            'The Review Agent has found the following issues, please fix them:',
            '',
            reviewReport,
            '',
            'Related Files:',
            ...writtenFiles.map(f => `- ${f}`),
            '',
            'Fix Requirements:',
            '1. Only fix the specific issues listed in the review report. You MUST fix ALL LSP red errors and logic conflicts (e.g., `hide_window = yes` used with `option`).',
            '2. Do not delete or simplify existing logic (Follow Rule 3b).',
            '3. After fixing, call `get_diagnostics` for each modified file to verify that the errors are resolved.',
        ].join('\n');
    }

    /**
     * 解析审查报告，判断是否通过。
     */
    parseReviewResult(reviewOutput: string): { passed: boolean; issueCount: number } {
        const upper = reviewOutput.toUpperCase();
        if (upper.includes('PASSED') || upper.includes('通过')) {
            return { passed: true, issueCount: 0 };
        }
        // 尝试提取问题数量
        const match = reviewOutput.match(/(\d+)\s*(?:个|issues?|problems?|errors?)/i);
        const issueCount = match ? parseInt(match[1]!, 10) : 1;
        return { passed: false, issueCount };
    }

    /** 获取配置 */
    getConfig(): QualityGateConfig {
        return { ...this.config };
    }
}
