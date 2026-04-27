import { h } from 'preact';

export function Header() {
    return (
        <div className="header">
            <div className="header-title">
                <svg className="header-brand-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                    <path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z" />
                    <circle fill="#e8c840" cx="13" cy="3" r="1" />
                </svg>
                <span className="brand-text">Eddy CWTool Code</span>
            </div>
            <div className="header-actions">
                <button className="icon-btn" id="btnNewTopic" title="新话题">+</button>
                <button className="icon-btn" id="btnTopics" title="历史话题">≡</button>
                <button className="icon-btn" id="btnSettings" title="设置">⋯</button>
            </div>
        </div>
    );
}
