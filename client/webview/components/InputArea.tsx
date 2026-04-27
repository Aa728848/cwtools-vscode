import { h } from 'preact';

export function InputArea() {
    return (
        <div className="input-wrapper" style={{ position: 'relative' }}>
            <div id="slashPopup" className="slash-popup"></div>
            <div className="input-container">
                <div className="file-badge-area" id="fileBadgeArea"></div>
                <div className="image-preview-area" id="imagePreviewArea"></div>
                <div className="input-row">
                    <textarea id="input" placeholder="描述你的需求... (/ 输入命令)" rows={1}></textarea>
                </div>
                <div className="input-controls">
                    <div className="ctrl-group">
                        <vscode-dropdown class="mode-select" id="modeSel" title="切换模式">
                            <vscode-option value="build">构建模式</vscode-option>
                            <vscode-option value="plan">计划模式</vscode-option>
                            <vscode-option value="explore">分析模式</vscode-option>
                            <vscode-option value="general">问答模式</vscode-option>
                            <vscode-option value="review">审查模式</vscode-option>
                        </vscode-dropdown>
                        <select className="model-selector" id="quickModelSelect" title="当前模型"></select>
                        <button className="img-pick-btn" id="imgPickBtn" title="上传图片">+</button>
                    </div>
                    <vscode-button class="send-btn" id="sendBtn" title="发送 (Enter)">↑</vscode-button>
                </div>
            </div>
        </div>
    );
}
