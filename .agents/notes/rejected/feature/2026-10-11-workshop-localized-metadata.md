# Agent Note: 工坊物品多语言标题/描述与 AI 快速翻译（未采纳）

Status: rejected — 锁定的 steamworks.js@0.4.0 未暴露 ISteamUGC::SetItemUpdateLanguage，工坊侧无法写入分语言元数据；用户据此决定整体放弃该方向。

## Problem

用户提出两点：Steam 创意工坊上传的「描述」与「更新说明」是否支持多种语言、能否为上传表单增加语言支持，以及能否基于现有 AI 基础设施增加其他语言的快速翻译。

现有实现（见 [2026-10-07-steam-workshop-upload.md](../../implemented/feature/2026-10-07-steam-workshop-upload.md)）：`WorkshopUploadRequest` 只有单份 title/description/changeNote；适配层接口 `SteamUgcUpdate` 只有 title/description/changeNote/previewPath/contentPath/tags/visibility 七个字段，`buildUpdate` 逐字透传，全链路没有语言维度。

## 核查结论（事实）

- **Steam 侧支持**：ISteamUGC 的 `SetItemUpdateLanguage` 可为标题与描述指定语言，未设置时按 `english` 处理（Steamworks 官方文档各语言版本一致）。工坊物品元数据在平台侧确实可分语言存储。
- **绑定库不支持**：`node_modules/steamworks.js/client.d.ts` 中 `workshop.UgcUpdate` 仅 `title/description/changeNote/previewPath/contentPath/tags/visibility`；整个 d.ts 无 `SetItemUpdateLanguage` 或任何本地化写入导出（唯一 `language?` 出现在 `WorkshopItemQueryConfig`，属查询侧参数）。npm 上 `steamworks.js` 最新版仍为 0.4.0（2024-08 发布），无升级路径。
- 结论：「工坊页面按读者语言显示不同文本」在本仓库当前技术选型下没有实现路径，除非自建 N-API 原生模块或更换绑定库。

## Alternatives considered

- **自建/更换原生模块以调用 SetItemUpdateLanguage**：唯一能真正写入分语言元数据的路径，但需自行编译并随 VSIX 分发原生模块，或放弃现有精确锁版的薄适配层；与既有决策冲突且本机无法验证。用户否决。
- **本地多语言草稿（每种语言一份 title/description/changeNote，上传时选一份提交）**：不需要新 API，且是将来接入真实多语言能力的前置基础；但无法让工坊页面按读者语言展示，用户认为价值不足。否决。
- **单份描述内嵌多语言分段**：一次上传即可让读者看到全部语言，但作者无法分语言管理，也没有真正的工坊语言元数据。否决。
- **就地翻译按钮（只翻译当前描述/更新说明，不落库多语言）**：复用 `translationPreview` 已有的 AI 路由（`config.translationPreview`，留空跟随对话模型）、`protectPdxTokens` 标记保护与结果缓存，实现成本低。用户在同轮明确表示翻译整块不做。否决。

## 结论与影响

- 工坊上传表单保持单份元数据现状：`title`/`description`/`changeNote` 不做语言维度扩展，`client/extension/workshopUpload.ts` 的 `SteamUgcUpdate` 适配层不变。
- 不新增工坊相关的 AI 翻译入口；`client/extension/translationPreview.ts` 维持只服务编辑器注释翻译的现状。
- 若将来更换绑定库（既有笔记已列出的换库触发条件之一），`SetItemUpdateLanguage` 可作为重新评估本方向的前提；届时应新建 Note 并交叉链接本条。
