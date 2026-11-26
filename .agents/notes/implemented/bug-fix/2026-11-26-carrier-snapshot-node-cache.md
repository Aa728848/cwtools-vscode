# Agent Note: CarrierSnapshot 节点遍历分配优化

Status: implemented

## Problem
大型 Stellaris Mod 的 CarrierSnapshot 构建会为每棵 root 节点树多次创建递归 seq 枚举器。真实 Kuat Mod 的 1721 个实体首次构建分配约 777MB，重复遍历造成明显短期分配压力。

## Decision
- 在单次 `buildSnapshot` 内以 root 对象身份缓存 `Node[]`，首次遍历保持 `allNodes` 原顺序，后续六个阶段复用数组；构建结束即释放缓存，不改变全局实体缓存生命周期。
- 保留每轮实体处理的 cancellation 检查与 BuildGate 语义，不改变 resourceEpoch 触发的新快照构建。
- 试验性的逐节点规范化 key 字典使分配回升到 568MB，已撤回，未纳入交付。

## Alternatives considered
- 全局长期缓存节点数组：会扩大实体生命周期和失效复杂度，否决。
- 通过提高 timeout 掩盖分配：不能降低内存压力，否决。

## Consequences
- 同一真实 Mod 首次构建分配从 777MB 降至 505MB，约减少 35%；耗时约 659ms，Event Graph 结果保持 993 节点、1977 条边、109 个来源文件。
- `dotnet build src/Main/` 0 警告、0 错误，Carrier 定向 .NET 测试 12/12、根 FSX 36/36 通过。完整冷启动探针仍约 90 秒，不能把该局部优化描述为全部启动性能治理完成。
