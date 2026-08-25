# CWT fixtures

These deterministic CWT fixtures exercise the Rust CWT parser, rule IR, rules engine, document service, project index, navigation, and validation contracts. Keep fixtures small, UTF-8, sorted where order matters, and independent from machine-local game data. When changing a fixture, compare the Rust result with the clean full-build result and cover additions, edits, removals, renames, and overlay transitions.

这些确定性 CWT fixture 用于验证 Rust CWT parser、规则 IR、规则引擎、文档服务、项目索引、跳转与校验契约。Fixture 应保持精简、UTF-8；顺序有意义时必须排序，并且不依赖本机游戏数据。修改 fixture 时，要将 Rust 结果与干净的全量构建结果对比，并覆盖新增、编辑、删除、重命名和 overlay 切换。
