import { h } from 'preact';
import { Icons } from '../svgIcons';

const renderHtml = (html: string) => <span dangerouslySetInnerHTML={{ __html: html }} />;

export function SettingsPage() {
    return (
        <div className="settings-page" id="settingsPage">
            <div className="settings-header">
                <button className="settings-back-btn" id="settingsBackBtn">←</button>
                <span className="settings-title">
                    {renderHtml(Icons.gear)} AI 设置
                </span>
            </div>
            <div className="settings-body">
                <div className="accordion-section open" id="chatModelSection">
                    <div className="accordion-header" id="accChat"><span>{renderHtml(Icons.bot)} 对话模型</span><span className="accordion-arrow">▶</span></div>
                    <div className="accordion-body">
                        <div className="settings-group">
                            <label className="settings-label">Provider</label>
                            <select className="settings-select" id="settingsProvider"></select>
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">Model</label>
                            <div className="model-row" style={{position:'relative'}}>
                                <input className="settings-input" id="settingsModelInput" type="text" placeholder="输入模型名，或点右侧下拉框搜索" autoComplete="off" />
                                <div id="settingsModelDatalist" className="ap-dropdown"></div>
                                <button className="detect-btn" id="delModelBtn" style={{marginLeft:'4px', padding:'0 8px', width:'auto'}} title="删除列表中当前字面的模型">{renderHtml(Icons.trash)}删除</button>
                                <button className="detect-btn" id="detectBtn" style={{display:'none', marginLeft:'4px'}}>{renderHtml(Icons.search)}检测</button>
                            </div>
                            <div className="settings-hint" id="modelHint"></div>
                        </div>
                        <div className="settings-group" id="apiKeyGroup">
                            <label className="settings-label">{renderHtml(Icons.key)} API Key</label>
                            <div className="settings-hint" id="apiKeyStatus" style={{color:'#4caf50', marginBottom:'3px'}}></div>
                            <div className="settings-key-row">
                                <input className="settings-input" id="settingsApiKey" type="password" placeholder="输入新 Key（留空保留已有）" autoComplete="off" />
                                <button className="key-toggle-btn" id="keyToggleBtn">👁</button>
                                <button className="detect-btn" id="fetchApiModelsBtn" style={{marginLeft:'4px', padding:'0 8px', width:'auto', borderRadius:'4px'}} title="用此 Key 去对应端点拉取模型">{renderHtml(Icons.cloud)}获取模型</button>
                            </div>
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">{renderHtml(Icons.link)} Endpoint <span style={{opacity:0.5, fontWeight:400}}>(可选)</span></label>
                            <input className="settings-input" id="settingsEndpoint" type="text" placeholder="留空使用默认" />
                            <div className="settings-hint" id="endpointHint"></div>
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">{renderHtml(Icons.ruler)} 上下文大小 (tokens)</label>
                            <input className="settings-input" id="settingsCtx" type="number" min="0" placeholder="0 = provider 默认" />
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">{renderHtml(Icons.stethoscope)} 思考深度 / Reasoning Effort <span style={{opacity:0.5, fontWeight:400}}>(供支持的模型使用)</span></label>
                            <select className="settings-select" id="settingsReasoningEffort">
                                <option value="low">Low (快速)</option>
                                <option value="medium">Medium (中等)</option>
                                <option value="high">High (默认)</option>
                                <option value="max">Max (DeepSeek-V4/o3 高强度思考)</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div className="accordion-section" id="inlineSection">
                    <div className="accordion-header" id="accInline"><span>{renderHtml(Icons.edit)} 补全模型</span><span className="accordion-arrow">▶</span></div>
                    <div className="accordion-body">
                        <div className="settings-toggle-row">
                            <span className="settings-toggle-label">启用 AI 补全</span>
                            <label className="toggle-switch"><input type="checkbox" id="inlineEnabled" /><span className="toggle-track"></span></label>
                        </div>
                        <div className="settings-toggle-row" style={{marginTop:'12px'}}>
                            <span className="settings-toggle-label" style={{display:'block'}}>启用 FIM 模式 (需选择支持的模型)</span>
                            <label className="toggle-switch"><input type="checkbox" id="inlineFimMode" /><span className="toggle-track"></span></label>
                            <div className="settings-hint" style={{marginTop:'4px'}}>使用针对补全优化的高速 Endpoint。启用后将在列表内过滤不支持的模型。</div>
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">Provider</label>
                            <select className="settings-select" id="inlineProvider"><option value="">- 与对话相同 -</option></select>
                        </div>
                        <div className="settings-group">
                            <div className="model-row" style={{position:'relative'}}>
                                <input className="settings-input" id="inlineModelInput" type="text" placeholder="例如 gpt-4" autoComplete="off" />
                                <div id="inlineModelDatalist" className="ap-dropdown"></div>
                            </div>
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">Endpoint</label>
                            <input className="settings-input" id="inlineEndpoint" type="text" placeholder="留空与对话相同" />
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">防抖延迟 (ms)</label>
                            <input className="settings-input" id="inlineDebounce" type="number" min="100" step="100" placeholder="500" />
                        </div>
                        <div className="settings-toggle-row" style={{marginTop:'12px'}}>
                            <span className="settings-toggle-label">防重叠代码修剪 (Overlap Stripping)</span>
                            <label className="toggle-switch"><input type="checkbox" id="inlineOverlapStripping" /><span className="toggle-track"></span></label>
                        </div>
                    </div>
                </div>
                <div style={{borderTop: '1px solid var(--border)', margin: '12px 0 8px', paddingTop: '6px'}}>
                    <span style={{fontSize:'11px', opacity:0.5, letterSpacing:'0.05em'}}>行为与工具</span>
                </div>
                <div className="accordion-section" id="mcpSection" style={{marginTop: '12px'}}>
                    <div className="accordion-header" id="accMcp"><span>{renderHtml(Icons.plugin)} MCP (模型上下文协议)</span><span className="accordion-arrow">▶</span></div>
                    <div className="accordion-body">
                        <div className="settings-hint" style={{marginBottom: '5px'}}>配置外部数据源为 AI 代理注入额外的上下文信息。</div>
                        <div id="mcpServersList" style={{display:'flex', flexDirection:'column', gap:'8px'}}></div>
                        <button className="settings-test-btn" id="addMcpServerBtn" style={{marginTop: '4px'}}>{renderHtml(Icons.plus)}新增 MCP Server</button>
                    </div>
                </div>
                <div className="accordion-section" id="agentSection" style={{marginTop: '12px'}}>
                    <div className="accordion-header" id="accAgent"><span>{renderHtml(Icons.shield)} Agent 设置</span><span className="accordion-arrow">▶</span></div>
                    <div className="accordion-body">
                        <div className="settings-group">
                            <label className="settings-label">文件写入模式</label>
                            <select className="settings-select" id="agentWriteMode">
                                <option value="confirm">确认模式 — 写操作前 diff 确认（推荐）</option>
                                <option value="auto">自动模式 — 直接写入（高级）</option>
                            </select>
                        </div>
                        <div className="settings-toggle-row">
                            <span className="settings-toggle-label">强制思考引擎 (Forced Reflection)</span>
                            <label className="toggle-switch"><input type="checkbox" id="forcedThinkingMode" /><span className="toggle-track"></span></label>
                            <div className="settings-hint" style={{marginTop:'4px'}}>在出错自动修复时，强制 AI 优先调用分析工具“口述”修正方案以降低幻觉率。会增加一些请求延迟。</div>
                        </div>
                        <div className="settings-group">
                            <label className="settings-label">{renderHtml(Icons.search)} Brave Search API Key <span style={{opacity:0.5, fontWeight:400}}>(可选)</span></label>
                            <div className="settings-key-row">
                                <input className="settings-input" id="braveSearchApiKey" type="password" placeholder="留空则使用 DuckDuckGo 降级搜索" autoComplete="off" />
                                <button className="key-toggle-btn" id="braveKeyToggleBtn" onClick={() => {
                                    const k = document.getElementById('braveSearchApiKey') as HTMLInputElement;
                                    if (k) k.type = k.type === 'password' ? 'text' : 'password';
                                }}>👁</button>
                            </div>
                            <div className="settings-hint">填写后 web_search 工具将使用 Brave Search API，结果质量更高。Key 请在 <a href="https://api.search.brave.com/" target="_blank" rel="noopener">api.search.brave.com</a> 获取。</div>
                            
                            <label className="settings-label">{renderHtml(Icons.search)} Exa API Key <span style={{opacity:0.5, fontWeight:400}}>(可选)</span></label>
                            <div className="settings-key-row">
                                <input className="settings-input" id="exaApiKey" type="password" placeholder="留空则使用 Brave/DuckDuckGo 降级搜索" autoComplete="off" />
                                <button className="key-toggle-btn" id="exaKeyToggleBtn" onClick={() => {
                                    const k = document.getElementById('exaApiKey') as HTMLInputElement;
                                    if (k) k.type = k.type === 'password' ? 'text' : 'password';
                                }}>👁</button>
                            </div>
                            <div className="settings-hint">填写后 codesearch 工具将使用 Exa 语义代码搜索，结果质量更高。Key 请在 <a href="https://dashboard.exa.ai/" target="_blank" rel="noopener">dashboard.exa.ai</a> 获取。</div>
                        </div>
                    </div>
                </div>
                <div className="accordion-section" id="usageSection" style={{marginTop: '12px', borderColor: 'rgba(100,149,237,0.3)'}}>
                    <div className="accordion-header" id="accUsage"><span>{renderHtml(Icons.chart)} Token 消耗统计</span><span className="accordion-arrow">▶</span></div>
                    <div className="accordion-body">
                        <div className="settings-group">
                            <div id="usageStatsContent" style={{fontSize:'12px', lineHeight: 1.6, opacity: 0.9}}>
                                加载中...
                            </div>
                            <button className="settings-test-btn" id="refreshUsageBtn" style={{marginTop: '8px'}}>{renderHtml(Icons.refresh)}刷新统计</button>
                            <button className="settings-test-btn" id="clearUsageBtn" style={{marginTop: '5px', color: '#e66', borderColor: 'rgba(200,80,80,0.3)'}}>{renderHtml(Icons.trash)}清空统计</button>
                        </div>
                    </div>
                </div>
            </div>
            <div className="settings-footer">
                <div className="test-result" id="testResult"></div>
                <button className="settings-test-btn" id="testConnBtn">{renderHtml(Icons.info)}测试连接</button>
                <button className="settings-save-btn" id="saveSettingsBtn">{renderHtml(Icons.save)}保存设置</button>
            </div>
        </div>
    );
}
