# Agent Note: 聊天面板与弹层的双向开合过渡体系

Status: implemented

## Problem

聊天 webview 中大量面板与弹出层只有「打开动画」或纯 `display:none` 瞬隐：话题面板与设置页打开时有 `slideDownIn`/`slideRightIn` 动画、关闭时靠撤掉 `display` 瞬间消失；5 个 composer 弹出菜单、slash 弹窗与 @ 引用弹窗用 `.show` 直接切换 `display`；设置页手风琴、diff 摘要折叠、单文件 diff 展开、问答卡片分页、内联编辑附件区、manager 话题左栏与 manager 文件行折叠全部是瞬变（manager 文件行折叠甚至靠 remove/insertAdjacentHTML 重建 DOM）。

## Decision

统一为「常驻挂载 + class 驱动」的双向过渡，落地于 `client/webview/chatPanel.css`、`client/webview/agentManager.css` 与少量 TS 显隐逻辑：

- **浮层面板（`.topics-panel`、`.settings-page`）**：基础态改为 `visibility:hidden; opacity:0; pointer-events:none` + transform，`visibility` 参与 transition（关闭时 `visibility 0s linear .2s` 延迟到淡出结束，打开时 `.show`/`.active` 用 `transition-delay:0s` 立即显现）。设置页隐藏态为 `position:absolute; inset:0`，激活态回到 flex 流内，关闭淡出覆盖在即时复原的聊天区之上。嵌入 side-workspace 复用时（`.side-workspace-body` 上下文）显式重置为无过渡、始终可见，与浮层上下文严格区分。
- **弹出菜单（`.composer-menu`/`.model-menu` 共 5 个、`.slash-popup`、@ 弹窗 `#atPopup`）**：`display:none` 改为常驻 `display:block` + visibility/opacity/`translateY(4px)` 的 120ms 过渡；`chatPanel.ts` 中 @ 弹窗的 3 处 `style.display` 直写全部删除，只切 `.show`。
- **高度型折叠**：设置页手风琴（`.accordion-body`）、diff 摘要（`.ds-files`）、单文件 diff（`.ds-diff-collapse`）、manager 文件行（`.manager-diff-collapse`）、Todo `<details>` 全部使用 `display:grid; grid-template-rows: 0fr→1fr` 纯 CSS 高度过渡。多子元素场景由 TS 包一层内层容器（`.accordion-body-inner`、`.ds-files-inner`、`.manager-diff-clip`）；裁剪层放在外层网格上、内层仅 `min-height:0`，使打开态焦点框（`:focus-visible` outline）能绘制进 body padding 区不被裁掉。
- **manager 话题左栏**：用 `@property` 注册 `--manager-active-left-width` 并在 `body.agent-manager-shell` 上同时过渡该自定义属性与 `grid-template-columns`（约 200ms），左栏面板自身过渡 opacity/visibility；`@property` 不被识别时 grid 列过渡仍兜底。
- **manager 文件行折叠**：`updateWorkspaceFileToggle` 不再 remove/重建 diff DOM，初始渲染始终挂载 diff 行，折叠只是 `is-collapsed` class 切换。
- **问答卡片分页 / 内联编辑附件区**：`.qc-hidden` / `.row-hidden` class 切换；`display` 翻转自动重放入场 keyframes 动画（`questionCardIn`、`inlineEditRowIn`）。
- **Todo `<details>`**：拦截 summary 点击，关闭时先加 `.todo-closing` 让 grid-rows 播完（`transitionend` + 260ms 超时兜底）再移除 `open` 属性，避免 UA 立即隐藏内容导致关闭动画丢失。
- **减弱动态效果**：`chatPanel.css` 全局 `prefers-reduced-motion` 规则自动覆盖全部新过渡；`agentManager.css` 的显式豁免清单同步补入 `body.agent-manager-shell`、`.topics-panel`、`.manager-diff-collapse`。

## Alternatives considered

- **保留 display 切换、只补打开动画**：否决。关闭瞬隐正是要消灭的对象，且 display 无法参与过渡。
- **手风琴用 max-height 过渡**：否决。需要拍脑袋的高度上限，大内容会被截断或产生延迟卡顿；grid-rows 按内容自适应。
- **内层 `overflow:hidden` 的教科书 grid-rows 写法**：未完全照搬。裁剪层改放外层网格容器，内层只设 `min-height:0`，否则打开态下手风琴内输入框的 focus-visible 焦点框（超出内容盒约 3px）会被内层裁掉；settings 页手风琴另用负 margin + 等值 padding 的出血处理保住横向焦点框。
- **manager 文件行折叠保留 remove/重建**：否决。重建丢失展开状态且无法过渡；常驻 DOM 的初次渲染成本换取状态保留与动画，可接受。

## Consequences

- 所有列出的面板/弹层/折叠区获得双向过渡；`prefers-reduced-motion` 下自动全部降级为瞬时。
- 浮层元素常驻挂载但 `visibility:hidden`，不进入 Tab 序也不响应指针（`pointer-events:none`），无布局位移（浮层均脱离文档流；设置页隐藏态为 absolute）。
- `webviewSmoke.test.ts` 新增源码契约断言，锁定 class 驱动过渡与 side-workspace 嵌入豁免的形态，防止回退到 display 瞬隐。
