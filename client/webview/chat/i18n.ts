export type ChatLocale = 'en' | 'zh-cn';

export interface ChatModeMeta {
    label: string | null;
    bodyClass: string;
}

export interface ChatI18nText {
    locale: ChatLocale;
    promptExamples: string[];
    modeLabels: Record<string, ChatModeMeta>;
    slashDescriptions: Record<string, string>;
    artifact: {
        emptyTitle: string;
        emptySubtitle: string;
        emptyFilterTitle: string;
        emptyFilterSubtitle: string;
        status: Record<string, string>;
    };
    buttons: {
        cancelGeneration: string;
        send: string;
    };
}

const EN: ChatI18nText = {
    locale: 'en',
    promptExamples: [
        'Check LSP errors in the current file and fix them',
        'Add a scripted_trigger that checks planet owner traits',
        'Explain the difference between from, root, and prev scopes',
        'Create an on_action that replenishes escort ships every month',
        'Add a mineral-cost building under common/buildings',
        'Fix the scope error in the current effect block',
        'Analyze the current file and list possible syntax issues',
        'Add validation guards to this scripted_effect',
        'Add immediate variable initialization to the current event',
        'Explain the difference between scripted_trigger and limit',
        'Optimize this loop that checks every planet',
        'Create a modifier formula based on empire technology level',
    ],
    modeLabels: {
        build: { label: null, bodyClass: 'build-mode' },
        plan: { label: 'Plan Mode - read-only planning, no file changes', bodyClass: 'plan-mode' },
        explore: { label: 'Explore Mode - inspect project structure', bodyClass: 'explore-mode' },
        general: { label: 'Utility Mode - scripts, tools, and non-PDXScript tasks', bodyClass: 'utility-mode' },
        utility: { label: 'Utility Mode - scripts, tools, and non-PDXScript tasks', bodyClass: 'utility-mode' },
        review: { label: 'Review Mode - code review', bodyClass: 'review-mode' },
        loc_translator: { label: 'Translation Mode - localisation file translation', bodyClass: 'build-mode' },
        loc_writer: { label: 'Writing Mode - localisation content creation', bodyClass: 'build-mode' },
        orchestrator: { label: 'Multi-Agent Execution - DAG dispatch and parallel collaboration', bodyClass: 'orchestrator-mode' },
    },
    slashDescriptions: {
        '/init': 'Scan the project and generate a CWTOOLS.md rules file',
        '/clear': 'Clear the current conversation and start a new topic',
        '/fork': 'Fork the conversation from the current point',
        '/archive': 'Archive the current topic',
        '/workflow:list': 'List available AI workflows',
        '/workflow:off': 'Turn off the active AI workflow',
        '/mode:build': 'Switch to Build mode',
        '/mode:plan': 'Switch to Plan mode',
        '/mode:explore': 'Switch to Explore mode',
        '/mode:utility': 'Switch to Utility mode',
        '/mode:review': 'Switch to Review mode',
        '/mode:orchestrator': 'Switch to multi-agent Orchestrator mode',
    },
    artifact: {
        emptyTitle: 'No Artifacts',
        emptySubtitle: 'Plans, blueprints, diagnostics, diffs, and walkthroughs will appear here.',
        emptyFilterTitle: 'No items in this filter',
        emptyFilterSubtitle: 'Switch back to All to view other artifacts.',
        status: {
            pending: 'pending',
            running: 'running',
            done: 'done',
            failed: 'failed',
        },
    },
    buttons: {
        cancelGeneration: 'Cancel generation (Esc)',
        send: 'Send',
    },
};

const ZH_CN: ChatI18nText = {
    locale: 'zh-cn',
    promptExamples: [
        '检查当前文件的 LSP 错误并修复',
        '为 scripted_trigger 添加检查星球所有者特性的条件',
        '解释 from、root、prev 这三个作用域的区别',
        '创建一个每月给舰队补充护卫舰的 on_action',
        '在 common/buildings 中添加一个需要矿物的新建筑',
        '修复当前效果块中的作用域错误',
        '分析当前文件并列出潜在的语法问题',
        '给这个 scripted_effect 添加错误检测逻辑',
        '为当前事件添加 immediate 触发器初始化变量',
        '解释 scripted_trigger 和 limit 的区别',
        '帮我优化这个循环检查所有星球的触发器',
        '创建一个基于帝国科技等级的 modifier 公式',
    ],
    modeLabels: {
        build: { label: null, bodyClass: 'build-mode' },
        plan: { label: '计划模式 - 只读规划，不修改文件', bodyClass: 'plan-mode' },
        explore: { label: '分析模式 - 探索项目结构', bodyClass: 'explore-mode' },
        general: { label: '泛用模式 - 脚本、工具与非 PDXScript 工程任务', bodyClass: 'utility-mode' },
        utility: { label: '泛用模式 - 脚本、工具与非 PDXScript 工程任务', bodyClass: 'utility-mode' },
        review: { label: '审查模式 - 代码审查', bodyClass: 'review-mode' },
        loc_translator: { label: '翻译模式 - 本地化文件翻译', bodyClass: 'build-mode' },
        loc_writer: { label: '写作模式 - 本地化内容创作', bodyClass: 'build-mode' },
        orchestrator: { label: '多 Agent 执行 - DAG 分派与并行协作', bodyClass: 'orchestrator-mode' },
    },
    slashDescriptions: {
        '/init': '扫描项目，生成 CWTOOLS.md 规则文件',
        '/clear': '清空当前对话，开始新话题',
        '/fork': '从当前位置分叉对话',
        '/archive': '归档当前话题',
        '/workflow:list': '列出可用 AI 工作流',
        '/workflow:off': '关闭当前 AI 工作流',
        '/mode:build': '切换到构建模式',
        '/mode:plan': '切换到计划模式',
        '/mode:explore': '切换到分析模式',
        '/mode:utility': '切换到泛用模式',
        '/mode:review': '切换到审查模式',
        '/mode:orchestrator': '切换到多 Agent 执行模式',
    },
    artifact: {
        emptyTitle: '暂无 Artifacts',
        emptySubtitle: '计划、蓝图、诊断、Diff 和 Walkthrough 会在这里集中出现。',
        emptyFilterTitle: '当前筛选无内容',
        emptyFilterSubtitle: '切回“全部”查看其他 Artifacts。',
        status: {
            pending: '等待中',
            running: '运行中',
            done: '完成',
            failed: '失败',
        },
    },
    buttons: {
        cancelGeneration: '取消生成 (Esc)',
        send: '发送',
    },
};

export function normalizeChatLocale(locale?: string | null): ChatLocale {
    return (locale || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

export function getChatI18n(locale?: string | null): ChatI18nText {
    return normalizeChatLocale(locale) === 'zh-cn' ? ZH_CN : EN;
}
