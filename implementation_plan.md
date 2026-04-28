# SemanticTokens Delta 增量解析方案 (重构版)

## 🎯 业务目标
将 CWTools VSCode 的 `semanticTokens/full` 全量高亮下发替换为按需发送的 `full/delta` 增量包。
利用 O(N) 的一维 `int[]` 比对算法，跳过复杂结构体解构带来的 “Relative Line / Char 位移错乱” 的致命隐患，实现极简且安全的增量下发，大幅下压客户端与服务器间的网络与重绘开销。

> [!CAUTION]
> **绝对准则**：必须基于已转化好的**相对编码 Int 数组 (`int[]`)**求变更。绝对不能以 `rawTokens (元组类型)` 进行 Diff 求变再重新应用偏移，否则增量点后所有高亮坐标瞬间错位。

---

## 1. 类型体系搭建 (Types.fs)

必须完全契合 LSP 3.16 官方协议规范定义的字段命名（特别是 `start`，否则客户端拒收）。

```fsharp
// Delta 客户端请求载荷：带回上次分配的 resultId
type SemanticTokensDeltaParams =
    { textDocument: TextDocumentIdentifier
      previousResultId: string }

// 单次编辑区间描述
type SemanticTokensEdit =
    { start: int          // [⚠️重要] 必须命名为 start，非 deleteStart
      deleteCount: int    // 覆盖旧 Token 的长度 (整数个数)
      data: int[] }       // 替换的新整数数组片段

// 增量返回载荷
type SemanticTokensDelta =
    { resultId: string
      edits: SemanticTokensEdit list }

// 合并配置项支持
type SemanticTokensOptions =
    { legend: SemanticTokensLegend
      full: bool
      range: bool
      delta: bool } // 初始化时置为 true

// 请求载荷分发标记
type Request =
    ...
    | SemanticTokensFullDelta of SemanticTokensDeltaParams

// Server 接口
type ILanguageServer =
    ...
    abstract member SemanticTokensFullDelta: SemanticTokensDeltaParams -> Async<Choice<SemanticTokens, SemanticTokensDelta> option>
```

---

## 2. 路由派发 (LanguageServer.fs)

增加对应的拆包转发规则，由 F# / Newtonsoft 统一序列化处理并下发。

```fsharp
// 在 processRequest 路由主干内增加 Match 分支：
| Request.SemanticTokensFullDelta(p) ->
    ProcessRequest(p, true, fun s -> s.SemanticTokensFullDelta(p))
```

---

## 3. 核心计算与管理控制 (Program.fs)

### 3.1 内存与缓存映射

由于规避了中间结构体的冗余缓存，原先字典仅需新增保存 `resultId`。

```fsharp
// semanticTokensCache 记录形态： 
// FilePath -> (contentHash, encodedDataList: int[], resultId)
let semanticTokensCache =
    ConcurrentDictionary<string, int * int[] * string>()
```

### 3.2 纯净版 O(n) 一维数组 Delta 算法

直接对最后完成的生成整型数据做剥头去尾比对。**跨距步长固定为 `5`**（5个整数构筑一个 Semantic Token：deltaLine, deltaChar, length, tokenType, tokenModifiers）。

```fsharp
let computeDelta (oldTokens: int[]) (newTokens: int[]) =
    let mutable startIndex = 0
    // 1. 左侧找不同（步幅为 5）
    while startIndex < oldTokens.Length && startIndex < newTokens.Length && oldTokens.[startIndex] = newTokens.[startIndex] do
        startIndex <- startIndex + 5 

    let mutable oldEnd = oldTokens.Length - 5
    let mutable newEnd = newTokens.Length - 5
    // 2. 右侧找不同（步幅为 5）
    while oldEnd >= startIndex && newEnd >= startIndex && oldTokens.[oldEnd] = newTokens.[newEnd] do
        oldEnd <- oldEnd - 5
        newEnd <- newEnd - 5

    // 3. 计算移除区与置换插入区
    let deleteCount = (oldEnd - startIndex + 5) 
    let inserted    = newTokens.[startIndex .. newEnd + 4] 
    
    { start = startIndex
      deleteCount = deleteCount
      data = inserted }
```

### 3.3 请求处理流水线

```fsharp
// 伪代码执行逻辑：
member this.SemanticTokensFullDelta(p: SemanticTokensDeltaParams) = async {
    let fileText = docs.GetText(FileInfo(filePath)) |> Option.defaultValue ""
    let hash = contentHash fileText

    match semanticTokensCache.TryGetValue(filePath) with
    | true, (cachedHash, cachedData, cachedResultId) when cachedHash = hash ->
        // 1. 文件没有被改动，如果是 Delta 请求但客户端已同步该 Hash，返回空 Edit。
        if p.previousResultId = cachedResultId then 
            return Choice2Of2 { resultId = cachedResultId; edits = [] }
        else
            // 若 resultId 错位，直接下发本地现存最新的 Full 套件即可
            return Choice1Of2 { resultId = cachedResultId; data = cachedData }
            
    | true, (_, oldDataArray, oldResultId) ->
        // 2. 文件变更且存在缓存根基
        let newDataArray = 重新遍历_AST_生成_Int_Array_核心函数(...)
        let newResultId  = System.Guid.NewGuid().ToString()  // [📌新分配 ID]
        
        cachePut semanticTokensCache filePath (hash, newDataArray, newResultId)

        // 判断上次持有的 ID 是否匹配，不匹配则强制 Full，阻断连续 Delta 断供
        if p.previousResultId = oldResultId then
            let edit = computeDelta oldDataArray newDataArray
            return Choice2Of2 { resultId = newResultId; edits = [ edit ] }
        else
            return Choice1Of2 { resultId = newResultId; data = newDataArray }

    | _ ->
        // 3. 完全无缓存初始生成
        let newDataArray = 重新遍历_AST_生成_Int_Array_核心函数(...)
        let newResultId  = System.Guid.NewGuid().ToString() 
        cachePut semanticTokensCache filePath (hash, newDataArray, newResultId)
        
        return Choice1Of2 { resultId = newResultId; data = newDataArray }
}
```

> [!TIP]
> 这里的 `resultId` 选用了随机 `Guid` 会比利用文件时间戳或累加器来得更加直接与无状态。每次由于 Hash 变更或初次创建触发了全新的分析，分配一组新 ID 并顺势塞给下一个阶段的记录。

---

## 4. 预期功能测试路线
1. 构建执行 `dotnet build src/Main/Main.fsproj -c Release` 保证全量函数和语法闭环。
2. VS Code Client Trace 日志检查下：首开 File 强制返回 `{ resultId: "guid", data: [...] }`。
3. 删除一行宏定义，检查 LSP 通道中是否发送出对应的 `delta: { edits: [ { start: N, deleteCount: 5, data: [] } ] }`。
4. 增删包含代码层及块，验证文件下方的其余高亮不受任何断档、串位影响！
