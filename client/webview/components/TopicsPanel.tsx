import { h } from 'preact';

export function TopicsPanel() {
    return (
        <div className="topics-panel" id="topicsPanel">
            <div className="topics-panel-header">
                <vscode-button appearance="secondary" class="new-topic-btn" id="btnNewTopicPanel" style={{ width: '100%' }}>＋ 新话题</vscode-button>
                <div className="topics-search-row">
                    <vscode-text-field id="topicsSearch" class="topics-search-input" placeholder="🔍 搜索对话..." style={{ flex: 1 }}></vscode-text-field>
                    <vscode-button appearance="secondary" id="btnExportTopic" title="导出当前对话 (Markdown)">⬇ 导出</vscode-button>
                </div>
            </div>
            <div className="topics-list" id="topicsList"></div>
        </div>
    );
}
