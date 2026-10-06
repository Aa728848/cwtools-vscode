/**
 * 工具参数 Schema 的出站清洗。
 *
 * `$schema` 是 JSON Schema 的**元键**，描述 schema 本身而不是一个参数；带它上线的工具声明
 * 会被若干网关判为非法。本扩展自己的 schema 不带它，因此这主要是为外部/MCP 工具兜底。
 */

/**
 * 去掉一个参数 schema 里的 `$schema`。
 *
 * 浅拷贝：调用方持有的对象必须保持原样，这里改的是即将上线的副本。
 */
export function stripToolMetaSchema(schema: unknown): unknown {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
    const record = schema as Record<string, unknown>;
    if (!('$schema' in record)) return schema;
    const next = { ...record };
    delete next.$schema;
    return next;
}
