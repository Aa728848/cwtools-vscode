# Agent Note: CWTools 领域写入默认激活

Status: implemented

## Problem

六个领域写入工具最初通过 `--enable-writes` / `--allow-domain-writes` 显式开启。用户随后明确要求写入工具默认激活，并确认不新增 CLI 只读开关。仅修改 CLI 默认值不足以实现该行为：旧 Bridge 代理会传 `allowDomainWrites: false`，直接 Bridge 调用也可能省略该字段，扩展因此仍会拒绝写入。

## Decision

- Bridge 与 Standalone 在支持的游戏工作区默认披露并允许 `write_localisation`、`typed_pdx_write`、`candidate_transaction`、`convert_image_to_dds`、`convert_audio`、`deploy_mod_asset`。
- CLI `enableWrites=true` 为默认值；`--enable-writes` 和 `--allow-domain-writes` 作为幂等兼容别名保留。不提供 `--read-only`。
- MCP schema 和名称判断在未传 `includeWrites` 时包含写工具。嵌入式 Host 的 `readonlyMode` / `writesEnabled` 防御层仍保留，但不再是 CLI 默认路径。
- Bridge 的 `allowDomainWrites` 保留在线协议中作兼容字段，但扩展不再根据缺失或 `false` 拒绝白名单写入。写调用继续走 `workspace_write`、`forceAutoApplyWrites`、路径包含性、排序锁和既有预检。
- 非白名单工具仍拒绝；非支持/歧义项目仍无工具；CWT-only 仍只有七项无游戏模型能力。Standalone 的 `--allow-tool` 白名单行为不变。

本决策取代此前“默认严格只读、写工具显式 opt-in”的策略，见 [内置 Agent 与 MCP 写入能力 Note](../simplification/2026-11-06-streamline-builtin-agent-to-paradox-single-agent.md)。项目识别与能力门禁不受本默认策略影响，见 [工作区识别 Note](2026-11-10-evidence-based-workspace-detection.md)。

## Alternatives considered

1. **只把 CLI 默认值改为 true**：否决。旧代理和直接 Bridge 调用仍会被扩展的 `allowDomainWrites` 门禁拒绝，形成名实不符。
2. **新增 `--read-only`**：用户明确选择不提供 CLI 只读开关；内部 Host 防御字段仍保留用于嵌入和测试。
3. **默认开启但允许任意写入**：否决。默认改变只适用于六个既有白名单工具，路径、锁和预检不能绕过。
4. **改写历史版本 Changelog**：否决。历史发布记录保持原样，仅更新当前产品文档、维护规则与 Agent Note。

## Consequences

- 新安装和旧代理在支持的游戏工作区都获得默认领域写入能力，无需额外参数。
- 默认开启不等于取消边界：项目识别、CWT-only、非白名单拒绝、路径沙箱和诊断预检仍是强制约束。
- 当前双语文档、CLI 帮助、包描述和维护指南均描述默认写入；历史发布记录不变。
- 根仓库与子模块的契约覆盖默认列表、默认 Host、旧 Bridge 标志兼容、嵌入式只读防御和项目能力拒绝。
