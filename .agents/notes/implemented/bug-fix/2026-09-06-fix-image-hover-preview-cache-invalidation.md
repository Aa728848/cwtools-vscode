# Agent Note: 修复图片悬停预览修改或删除后仍显示旧图的缓存失效缺陷

Status: implemented

## Problem

在编辑 `.gfx` 或相关游戏脚本时，用户悬停在 `texturefile`（如 `.dds` / `.tga`）上，插件会调用 `createImageHover` 解码图片并呈现 Hover 预览。对于解码后 base64 数据量较大（>50,000 字符）的图像，插件会将其转存至系统 `%TEMP%` 目录下以防止 VS Code Markdown 崩溃。
然而原逻辑存在严重缺陷：
1. **磁盘临时文件哈希未绑定文件修改时间**：生成文件名使用 `cwt_prev_${md5(fullPath)}.png`，仅依赖文件绝对路径，且逻辑判断 `if (!fs.existsSync(tempPath)) { fs.writeFileSync(...) }`。一旦该文件曾经预览过，即使原 DDS 被修改、重命名覆盖或删掉重下，磁盘上的旧临时文件依然存在且绝不更新，导致预览始终展示数周前的僵尸旧图；
2. **内存 LRU 缓存未校验 mtime**：内存中的 `imageCache` 仅以 `fullPath` 为键，未比对文件 `mtimeMs` 和 `size`，VS Code 运行期间外部文件变化无法触发刷新；
3. **缺少图片文件监视器**：工作区文件监听器仅覆盖了 `.gfx` 和部分 room 文件，未监视通用的 `.dds`/`.tga`/`.png` 变更。

## Decision

1. **缓存条目绑定文件修改时间与文件大小**：
   重构 `imageCache` 条目为 `CachedImage { result, mtimeMs, size, tempFilePath }`，在调用 `createImageHover` 时同步校验 `stat.mtimeMs` 与 `stat.size`。一旦文件内容变化，立即作废内存缓存并触发重新解码。若文件被删除，`statSync` 失败时立即清除该路径的缓存并返回 `null`。
2. **临时文件生成采用版本化哈希与原子清理**：
   临时文件名由路径哈希与版本哈希组合生成：`cwt_prev_${pathHash}_${versionHash}.png`（其中 `versionHash` 基于 `mtimeMs:size` 计算）。文件变动后天然指向新的临时文件 URI，规避编辑器及渲染进程缓存；同时在重新生成或失效时，主动删除前一版本的临时文件。
3. **工作区实时图片文件监听**：
   在 `registerGraphicsFeatures` 中注册针对于 `**/*.{dds,tga,png,DDS,TGA,PNG}` 的 `FileSystemWatcher`，在文件发生变更、创建或删除时主动从 `imageCache` 中剔除并删除临时文件。
4. **提升后台临时文件清理的健壮性**：
   在 `cleanupOldTempFiles` 的逐个文件清理中包裹异常防护，避免单个被占用的文件导致整个 24h 兜底清理循环中断。
5. **回归测试全覆盖**：
   在 `client/test/unit/graphicsFeatures.test.ts` 中新增针对高熵图片修改、时间戳更新、旧临时文件自动删除、原图删除后返回 `null` 并清理缓存的自动化回归测试。

## Alternatives considered

- **直接使用图片内容完整 Hash（MD5）作为缓存键**：
  在主线程提供 Hover 响应时若对数十兆的大尺寸 DDS 计算完整内容 MD5，在性能较差的机器或大型 Mod 下会导致悬停出现可感知的掉帧或延迟。采用 `stat.mtimeMs` + `stat.size` 配合精准版本化文件名，兼顾了 O(1) 的极速响应与 100% 可靠的缓存失效判定。
- **在 Markdown file:// 链接后拼接 query 参数（`?v=timestamp`）**：
  部分宿主平台或底层 Chromium 在直接处理 `file://` 协议时可能会将查询参数解析为文件路径的一部分导致文件未找到。采用文件名携带 `versionHash` 既保证了天然的 URL 不重复，又避免了任何协议兼容性风险。

## Consequences

- 彻底解决了用户反馈的“更改原图甚至删掉原图后预览依然显示旧图”的问题，修改或重放图片能立即在编辑器 Hover 中实时呈现最新图像；
- 旧的临时文件在图片每次变更时会被精准删除，不再长期占用系统 `%TEMP%` 目录磁盘空间；
- 增加了针对性回归测试并保持全量测试与发布门禁 100% 通过。
