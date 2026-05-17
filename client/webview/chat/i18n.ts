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
    markdown: {
        waitingForChoice: string;
    };
    settings: {
        unselectedProvider: string;
        unsetModel: string;
        defaultEndpoint: string;
        automatic: string;
        localModel: string;
        apiKeyConfigured: string;
        apiKeyMissing: string;
        inlinePrefix: string;
        inlineSameProvider: string;
        inlineOff: string;
        writeAuto: string;
        writeConfirm: string;
        contextPrefix: string;
        mcpUnit: string;
        providerChip: string;
        writeChip: string;
        reasoningChip: string;
    };
    live: {
        waitingForOutput: string;
        thoughts: string;
        tools: string;
        text: string;
        subtask: string;
        starting: string;
        back: string;
        subagent: string;
        realtimeProcess: string;
        reads: string;
        writes: string;
        thinkingDetails: string;
    };
    annotations: {
        plan: AnnotationI18nText;
        orchestratorPlan: AnnotationI18nText;
        walkthrough: AnnotationI18nText;
        blueprint: AnnotationI18nText;
    };
}

export interface AnnotationI18nText {
    title: string;
    hint: string;
    approve: string;
    approved: string;
    submit: string;
    submitted: string;
    addTitle: string;
    placeholder: string;
    confirm: string;
    cancel: string;
    edit: string;
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
    markdown: {
        waitingForChoice: 'Waiting for your choice...',
    },
    settings: {
        unselectedProvider: 'No provider selected',
        unsetModel: 'No model configured',
        defaultEndpoint: 'Default endpoint',
        automatic: 'automatic',
        localModel: 'Local model',
        apiKeyConfigured: 'API key configured',
        apiKeyMissing: 'API key missing',
        inlinePrefix: 'Inline',
        inlineSameProvider: 'same provider',
        inlineOff: 'Inline: off',
        writeAuto: 'Auto write',
        writeConfirm: 'Confirm writes',
        contextPrefix: 'context',
        mcpUnit: 'MCP',
        providerChip: 'Provider',
        writeChip: 'Write',
        reasoningChip: 'Reasoning',
    },
    live: {
        waitingForOutput: 'Waiting for output',
        thoughts: 'thoughts',
        tools: 'tools',
        text: 'text',
        subtask: 'Subtask',
        starting: 'Starting...',
        back: 'Back',
        subagent: 'Subagent',
        realtimeProcess: 'Live process',
        reads: 'reads',
        writes: 'writes',
        thinkingDetails: 'Thinking details',
    },
    annotations: {
        plan: {
            title: 'Inline annotations',
            hint: 'Click a section to add annotations',
            approve: 'Approve execution',
            approved: 'Started...',
            submit: 'Submit annotations',
            submitted: 'Submitted',
            addTitle: 'Add annotation',
            placeholder: 'Enter annotation...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
        orchestratorPlan: {
            title: 'Multi-agent plan annotations',
            hint: 'Approval starts DAG dispatch and parallel execution',
            approve: 'Start multi-agent',
            approved: 'Multi-agent started...',
            submit: 'Submit annotations',
            submitted: 'Submitted',
            addTitle: 'Add annotation',
            placeholder: 'Enter annotation...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
        walkthrough: {
            title: 'Walkthrough annotations',
            hint: 'Click a section to request changes',
            approve: 'Confirm complete',
            approved: 'Confirmed',
            submit: 'Request revision',
            submitted: 'Submitted',
            addTitle: 'Request changes',
            placeholder: 'Tell the AI what needs to change...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
        blueprint: {
            title: 'Design blueprint annotations',
            hint: 'Click a section to add annotations',
            approve: 'Approve blueprint',
            approved: 'Blueprint approved',
            submit: 'Submit annotations',
            submitted: 'Submitted',
            addTitle: 'Add annotation',
            placeholder: 'Enter annotation...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
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
    markdown: {
        waitingForChoice: '等待你的选择...',
    },
    settings: {
        unselectedProvider: '未选择 Provider',
        unsetModel: '未设置模型',
        defaultEndpoint: '默认端点',
        automatic: '自动',
        localModel: '本地模型',
        apiKeyConfigured: 'API Key 已配置',
        apiKeyMissing: 'API Key 未配置',
        inlinePrefix: '补全',
        inlineSameProvider: '同主模型',
        inlineOff: '补全: 关闭',
        writeAuto: '写入自动',
        writeConfirm: '写入确认',
        contextPrefix: '上下文',
        mcpUnit: 'MCP',
        providerChip: 'Provider',
        writeChip: '写入',
        reasoningChip: '推理',
    },
    live: {
        waitingForOutput: '等待输出',
        thoughts: '思考',
        tools: '工具',
        text: '文本',
        subtask: '子任务',
        starting: '正在启动...',
        back: '返回',
        subagent: '子代理',
        realtimeProcess: '实时过程集中显示',
        reads: '读取',
        writes: '写入',
        thinkingDetails: '思考详情',
    },
    annotations: {
        plan: {
            title: '在线批注',
            hint: '点击段落添加批注',
            approve: '同意执行',
            approved: '已开始执行...',
            submit: '提交批注',
            submitted: '已提交',
            addTitle: '添加批注',
            placeholder: '输入批注内容...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
        orchestratorPlan: {
            title: '多 Agent 计划批注',
            hint: '确认后进入 DAG 分派与并行执行',
            approve: '启动多 Agent',
            approved: '已启动多 Agent...',
            submit: '提交批注',
            submitted: '已提交',
            addTitle: '添加批注',
            placeholder: '输入批注内容...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
        walkthrough: {
            title: 'Walkthrough 批注',
            hint: '点击段落添加批注要求',
            approve: '确认完成',
            approved: '已确认',
            submit: '重新修改',
            submitted: '已提交',
            addTitle: '提出修改要求',
            placeholder: '告诉 AI 哪里需要如何修改...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
        blueprint: {
            title: '设计蓝图批注',
            hint: '点击段落添加批注',
            approve: '同意蓝图',
            approved: '蓝图已批准',
            submit: '提交批注',
            submitted: '已提交',
            addTitle: '添加批注',
            placeholder: '输入批注内容...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
    },
};

export function normalizeChatLocale(locale?: string | null): ChatLocale {
    return (locale || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

export function getChatI18n(locale?: string | null): ChatI18nText {
    return normalizeChatLocale(locale) === 'zh-cn' ? ZH_CN : EN;
}
