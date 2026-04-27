import { h } from 'preact';
import { Header } from './Header';
import { TopicsPanel } from './TopicsPanel';
import { InputArea } from './InputArea';
import { SettingsPage } from './SettingsPage';
import { Icons } from '../svgIcons';

const renderHtml = (html: string) => <span dangerouslySetInnerHTML={{ __html: html }} />;

export function AppShell() {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
            <Header />
            <TopicsPanel />

            {/* Mode Indicator & Todo */}
            <div className="mode-indicator" id="modeIndicator">📋 Plan Mode — 只读分析，不修改文件</div>
            <div className="todo-panel" id="todoPanel">
                <div className="todo-panel-title">Tasks</div>
                <div id="todoList"></div>
            </div>

            {/* Chat Area */}
            <div className="chat-area" id="chatArea">
                <div className="empty-state" id="emptyState">
                    <div className="empty-icon">
                        <svg width="40" height="40" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                            <path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z" />
                            <circle fill="#e8c840" cx="13" cy="3" r="1" />
                        </svg>
                    </div>
                    <div style={{ fontSize: '13px', fontFamily: 'Georgia,serif' }}>Eddy CWTool Code Assistant</div>
                    <div className="empty-tagline">描述你的需求，AI 将生成并验证 Paradox 脚本</div>
                    <div className="suggest-cards">
                        <vscode-button appearance="secondary" class="suggest-card" data-suggest="检查当前文件的 LSP 错误并修复">
                            {renderHtml(Icons.search)} 检查 LSP 错误
                        </vscode-button>
                        <vscode-button appearance="secondary" class="suggest-card" data-suggest="解释 from、root、prev 这三个作用域的区别和用法">
                            {renderHtml(Icons.book)} 作用域解释
                        </vscode-button>
                        <vscode-button appearance="secondary" class="suggest-card" data-suggest="为当前触发器添加详细注释说明其逻辑">
                            {renderHtml(Icons.edit)} 添加注释
                        </vscode-button>
                        <vscode-button appearance="secondary" class="suggest-card" data-suggest="分析当前文件并列出潜在的语法和逻辑问题">
                            {renderHtml(Icons.shield)} 代码审查
                        </vscode-button>
                    </div>
                </div>
            </div>

            {/* Token Usage */}
            <div id="tokenUsageBar" style={{ display: 'none' }}>
                <div className="token-usage-bar"><div className="token-usage-fill" id="tokenUsageFill" style={{ width: '0%' }}></div></div>
                <div className="token-usage-label" id="tokenUsageLabel"></div>
            </div>

            <InputArea />
            <SettingsPage />
        </div>
    );
}
