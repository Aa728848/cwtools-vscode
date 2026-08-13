# CWT Language Golden Corpus / CWT 语言金样语料

Phase 0 交付物之一(docs/cwt-language-support-handoff.md §Phase 0)。
固定 CWT 文档管线的语义基线:每个 fixture 都有明确的预期解析结果,
供 F# 契约测试(`src/Main/CwtLanguageService.Tests.fsx`)、单文件语义测试
(`src/Main/CwtLanguageSemantics.Tests.fsx`)与后续 Phase 3 的诊断、补全、
索引测试复用。

fixture 内容从 `submodules/cwtools-stellaris-config/config/` 的真实规则中提炼,
保持最小化,不复制大文件。所有 fixture 不依赖本机游戏安装。

## 目录

| 目录 | 用途 |
| --- | --- |
| `valid/` | 语法合法、语义完整,应成功解析并产出规则/类型/枚举/值模型 |
| `invalid/` | 语法非法,应产生 parser/结构诊断;错误恢复策略的对象 |
| `semantic/` | 语法合法但语义错误(未定义引用、重复定义),供 Phase 3 负向诊断使用 |

## 基线契约(Phase 0)

Phase 0 只记录现有行为,不改变实现。契约如下:

- `CKParser.parseString` 对 `valid/` 全部返回 `Success`;对 `invalid/` 全部返回 `Failure`。
- `RulesParser.parseConfigWithMetadata` 对 `valid/` 返回非空 `rules`(除只含元数据块的文件);
  对 `invalid/` 返回全空模型(`parseConfigWithMetadata` 当前解析失败时返回空模型,
  调用方无法区分"合法空文件"与"解析失败",这是已知技术债,见交接文档 §3.3)。
- `empty.cwt` 是唯一的"合法空模型"样例,用于区分上述两种情况。

## fixture 说明

### valid/

| 文件 | 覆盖内容 | 预期 |
| --- | --- | --- |
| `empty.cwt` | 空文件 | 解析成功,空模型 |
| `only_comments.cwt` | 仅 `#`/`###`/`##` 注释 | 解析成功,空模型 |
| `shared_root_blocks.cwt` | `types`/`enums`/`aliases`/`scopes`/`scope_groups`/`links`/`modifier_categories` 根块 | 解析成功,产出规则 |
| `field_expressions.cwt` | 属性规则与 leaf value 规则中的共享字段表达式 | 解析成功,产出规则 |
| `rule_options.cwt` | `## cardinality`/`severity`/`push_scope`/`replace_scopes`/`completion_type`/`file_extensions`/`color_type`/`type_prefix_from` | 解析成功,选项被读取 |
| `subtypes.cwt` | `type[...]` 下的 `subtype[x]`/`subtype[!x]` | 解析成功 |
| `legacy_blocks.cwt` | `localisation_commands`(Legacy/Clausewitz) | 解析成功,产出规则 |
| `jomini_blocks.cwt` | `priorities`/`system_scopes`/`locales`/`database_object_types`/`on_actions`/`override_modes_info`(Jomini/Modern) | 解析成功,产出扩展元数据;`override_modes_info` 同时产生一条根规则(实测),其余元数据块规则为空 |
| `inject.cwt` + `inject_target.cwt` | `## inject = inject_target.cwt@injected_group/*` 跨文件注入 | 解析成功;`parseConfigs` 合并两者后目标块包含注入子规则 |

### invalid/

| 文件 | 覆盖内容 | 预期 |
| --- | --- | --- |
| `missing_close_brace.cwt` | 缺失 `}`(典型编辑中状态) | CKParser Failure;单文件 parser 诊断 |
| `unexpected_token.cwt` | 未闭合字符串等无法恢复的语法 | CKParser Failure |
| `incomplete_line.cwt` | 末尾未完成行(输入中状态) | CKParser Success(宽容恢复),已完成规则保留——编辑器契约(交接文档 §6.3) |
| `bad_cardinality.cwt` | `## cardinality = banana` 非法选项值 | CKParser 成功(注释不参与语法),语义选项解析失败/忽略——记录基线 |
| `bad_field_expression.cwt` | `int[0..banana]` 非法字段表达式 | 待基线确认:可能整体解析失败或该规则被跳过 |

### semantic/

| 文件 | 覆盖内容 | 预期(Phase 3 起) |
| --- | --- | --- |
| `undefined_type_reference.cwt` | `<undefined_type>` 引用不存在的 type | 语法解析成功;Phase 3 产生 CWT3xx 未定义引用诊断 |
| `duplicate_definition.cwt` | 同文件重复定义 `type[dup]` | 语法解析成功;Phase 3 产生重复定义诊断 |

## 错误分类基线(阻止索引 vs 只阻止规则激活)

Phase 0 的实测结论记录在 `docs/cwt-language-support-baseline.md`,要点:

- CKParser `Failure`(括号、token 结构):阻止项目索引与规则激活。
- 语义选项非法(`## cardinality = banana` 等):不阻止解析,是否阻止激活待 Phase 4 决策。
- `parseConfigWithMetadata` 的失败返回空模型:阻止索引(无法区分空文件),这是 Phase 2 要解决的缺口。
