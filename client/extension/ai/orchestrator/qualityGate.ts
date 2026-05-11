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
     * 生成审查 prompt。
     * 基于 Builder 的执行结果，构建针对性的审查指令。
     */
    buildReviewPrompt(builderResult: SubAgentResult): string {
        const fileList = builderResult.writtenFiles.length > 0
            ? builderResult.writtenFiles.map(f => `- ${f}`).join('\n')
            : '（无文件写入记录）';

        return [
            '## 质量门审查任务',
            '',
            '请审查以下文件的代码质量：',
            fileList,
            '',
            '审查要点：',
            '1. 对每个文件调用 `get_diagnostics` 检查 LSP 错误',
            '2. 检查跨文件引用一致性（事件 ID、修饰符名称、本地化 key）',
            '3. 验证作用域链的正确性',
            '4. 检查文件结构完整性（参照 Rule 3b）',
            '',
            '输出格式：',
            '- 如果所有文件零错误：输出 "PASSED: 所有文件通过质量检查"',
            '- 如果有错误：输出 "FAILED: N 个问题需要修复"，并列出具体问题',
        ].join('\n');
    }

    /**
     * 生成修复 prompt。
     * 基于 Reviewer 的审查报告，构建修复指令。
     */
    buildFixPrompt(reviewReport: string, writtenFiles: string[]): string {
        return [
            '## 质量门修复任务',
            '',
            '审查 Agent 发现了以下问题，请修复：',
            '',
            reviewReport,
            '',
            '相关文件：',
            ...writtenFiles.map(f => `- ${f}`),
            '',
            '修复要求：',
            '1. 只修复审查报告中列出的具体问题',
            '2. 不要删除或简化现有逻辑（遵循 Rule 3b）',
            '3. 修复后对每个修改的文件调用 `get_diagnostics` 验证',
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
