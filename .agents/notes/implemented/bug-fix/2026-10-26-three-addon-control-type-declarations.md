# Agent Note: Three.js 控制器入口的类型声明补全

Status: implemented

## Problem

`entityPreview.ts` 与 `particlePreview.ts` 通过
`three/examples/jsm/controls/{OrbitControls,TransformControls}.js` 使用官方控制器，但当前
`@types/three` 没有为这两个入口提供声明。严格类型检查和 Rollup 因此在既有 Webview 文件上
报 TS7016，拖拽事件参数也无法从控制器事件表获得类型。

## Decision

在既有的 `client/webview/vscode.d.ts` 中补充两个局部模块声明（该文件已被两个 Rollup
入口显式包含），复用类型包的 `Controls` 基类，并按项目实际调用面定义控制器成员：

- OrbitControls：相机与 DOM 构造参数、目标向量、距离、阻尼、平移、鼠标按键和 `update`。
- TransformControls：变换模式与空间、拖拽状态、helper、attach/detach、snap 设置，以及
  `objectChange` 和带布尔 `value` 的 `dragging-changed` 事件。

声明取自上游公开 d.ts 的对应定义，只保留当前使用面，不改变运行时代码、依赖版本或打包入口。

## Alternatives considered

1. **降级或固定另一版 `@types/three`**：否决。那会改变整个项目的类型基线并影响其他 Three.js
   使用点，而缺失只涉及两个 addon 入口。
2. **用 `any` 或宽泛模块声明压制错误**：否决。会继续掩盖拖拽事件与控制器成员的类型错误，
   违反仓库对外部数据显式收窄的约束。
3. **复制完整上游声明文件**：未采用。当前补全只服务两个现有使用点，最小声明更容易随实际
   调用面审查和维护；需要扩大使用面时应同步扩展声明。

## Consequences

- 两个 Webview 的 TypeScript 与 Rollup 类型路径可以使用官方控制器，不再依赖隐式 any。
- `dragging-changed` 的 `value` 明确为 boolean，`getMode`、`setSpace`、snap 参数与
  `attach/detach` 均有静态约束；基类继续提供 `enabled`、`dispose` 等共同行为。
- 声明是局部兼容层，不是完整的 Three.js addon 类型分发；新增控制器 API 使用时必须同步补充。
