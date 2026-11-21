# CWT Language Golden Corpus / CWT 语言金样语料

本目录固定 CWT 文档管线（见 [`ARCHITECTURE.md`](../../../../ARCHITECTURE.md#cwt-文档管线) 与 [`docs/diagnostic-codes.md`](../../../../docs/diagnostic-codes.md)）的语义基线：每个 fixture 都有明确的预期解析与诊断结果，供 F# 契约测试（`src/Main/CwtLanguageService.Tests.fsx`）、单文件语义测试（`src/Main/CwtLanguageSemantics.Tests.fsx`）、跨文件索引/激活测试及集成测试（`npm run test:cwt-lsp`、`npm run test:cwt-game-lsp`）复用。

fixture 内容从 `submodules/cwtools-stellaris-config/config/` 的真实规则中提炼，保持最小化，不复制大文件。所有 fixture 均不依赖本机游戏安装。

## 目录

| 目录 | 用途 |
| --- | --- |
| `valid/` | 语法合法、语义完整，应成功解析并产出规则/类型/枚举/值模型 |
| `invalid/` | 语法或规则选项/表达式非法，应产生 parser/结构（`CWT0xx`）或单文件语义诊断（`CWT1xx`/`CWT2xx`） |
| `semantic/` | 语法合法但存在跨文件/重复定义语义错误（`CWT301`/`CWT302`），供项目索引负向诊断使用 |

## 当前契约

- `CKParser.parseString` 对 `valid/` 全部返回 `Success`；对 `invalid/` 中的语法错误样本返回 `Failure`。
- `RulesParser.parseConfigWithMetadataDetailed` 对 `valid/` 返回成功及规则/元数据模型，对解析失败返回结构化解析错误（与 `empty.cwt` 的合法空模型明确区分）。
- `CWTools.CwtLanguage` 单文件语义服务产出 `CWT1xx`（根块与指令）和 `CWT2xx`（字段表达式）诊断；`CwtProjectIndex` 产出跨文件项目诊断（`CWT301`/`CWT302`/`CWT401`）。

## fixture 说明

### valid/

| 文件 | 覆盖内容 | 预期 |
| --- | --- | --- |
| `empty.cwt` | 空文件 | 解析成功，合法空模型 |
| `only_comments.cwt` | 仅 `#`/`###`/`##` 注释 | 解析成功，合法空模型 |
| `shared_root_blocks.cwt` | `types`/`enums`/`aliases`/`scopes`/`scope_groups`/`links`/`modifier_categories` 根块 | 解析成功，产出规则 |
| `field_expressions.cwt` | 属性规则与 leaf value 规则中的共享字段表达式 | 解析成功，产出规则 |
| `rule_options.cwt` | `## cardinality`/`severity`/`push_scope`/`replace_scopes`/`completion_type`/`file_extensions`/`color_type`/`type_prefix_from` | 解析成功，选项被读取 |
| `subtypes.cwt` | `type[...]` 下的 `subtype[x]`/`subtype[!x]` | 解析成功 |
| `legacy_blocks.cwt` | `localisation_commands`（Legacy/Clausewitz） | 解析成功，产出规则 |
| `jomini_blocks.cwt` | `priorities`/`system_scopes`/`locales`/`database_object_types`/`on_actions`/`override_modes_info`（Jomini/Modern） | 解析成功，产出扩展元数据；`override_modes_info` 同时产生一条根规则，其余元数据块规则为空 |
| `inject.cwt` + `inject_target.cwt` | `## inject = inject_target.cwt@injected_group/*` 跨文件注入 | 解析成功；`parseConfigs` 合并两者后目标块包含注入子规则 |

### invalid/

| 文件 | 覆盖内容 | 预期 |
| --- | --- | --- |
| `missing_close_brace.cwt` | 缺失 `}`（典型编辑中状态） | `CKParser` Failure；产生 `CWT001` 语法诊断 |
| `unexpected_token.cwt` | 未闭合字符串等无法恢复的语法 | `CKParser` Failure；产生 `CWT001` 语法诊断 |
| `incomplete_line.cwt` | 末尾未完成行（输入中状态） | `CKParser` 宽容恢复，保留已完成规则 |
| `bad_cardinality.cwt` | `## cardinality = banana` 非法选项值 | 语法解析通过；单文件语义诊断报告 `CWT102` |
| `bad_field_expression.cwt` | `int[0..banana]` 非法字段表达式 | 语法解析通过；单文件语义诊断报告 `CWT201` |

### semantic/

| 文件 | 覆盖内容 | 预期 |
| --- | --- | --- |
| `undefined_type_reference.cwt` | `<undefined_type>` 引用不存在的 type | 语法解析成功；项目索引产生 `CWT301` 未定义引用诊断 |
| `duplicate_definition.cwt` | 同文件重复定义 `type[dup]` | 语法解析成功；项目索引产生 `CWT302` 重复定义诊断 |

## 错误分类与激活边界

- **解析失败（`CWT001`）**：阻止项目索引纳入与规则热替换激活（保留 last-known-good，报 `CWT900`）。
- **Error 级单文件/项目语义诊断**（如 `CWT102`、`CWT113`、`CWT201`、`CWT302`、`CWT401`）：阻止候选规则热替换激活（报 `CWT900`）；Warning 级诊断默认不阻断激活（除非显式提升为阻断项）。
- 详细错误码与激活机制见 [`docs/diagnostic-codes.md`](../../../../docs/diagnostic-codes.md) 与 [`ARCHITECTURE.md`](../../../../ARCHITECTURE.md#cwt-文档管线)。
