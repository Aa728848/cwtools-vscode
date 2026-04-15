## Eddy's Stellaris CWTools

Stellaris 模组开发辅助工具，基于 [CWTools](https://github.com/cwtools/cwtools-vscode) 深度定制。

## 功能

### 语言服务
- **语法校验** — 实时检查脚本语法错误和规则违规
- **自动补全** — 上下文感知的代码补全（事件、修饰符、触发器等）
- **转到定义** — Ctrl+Click 跳转到事件、脚本值、内联脚本等定义
- **文件悬浮预览** — 鼠标悬浮显示 inline_script 引用文件内容
- **CodeLens** — 在代码上方显示本地化文本标签
- **算术表达式求值** — 悬浮显示 `value:xxx|` 表达式的计算结果

### GUI 预览
- **实时预览** — 在 VS Code 侧边栏预览 `.gui` 文件渲染效果
- **纹理解码** — 支持 DDS（BC1/BC2/BC3/BC7）和 TGA 纹理格式
- **9-Slice 渲染** — `corneredTileSpriteType` 使用 Canvas 9-切片绘制
- **多帧精灵** — 正确裁切和显示 `noOfFrames` 多帧贴图
- **图层面板** — 可视化元素层级树，点击定位到源码行
- **搜索** — Ctrl+F 搜索元素名称，高亮匹配
- **缩放/平移** — 鼠标滚轮缩放，拖拽平移

### 依赖图
- **技术/事件依赖图** — 可视化展示脚本间的引用关系

## 支持的游戏
* Stellaris

## 安装
1. 下载 `.vsix` 文件
2. VS Code 中按 `Ctrl+Shift+P`，选择 `Extensions: Install from VSIX...`
3. 首次启动时选择 Stellaris 原版游戏目录以生成缓存