import type { ToolDefinition } from '../types';

/**
 * 递归计算 Schema 的最大深度和叶子节点数，用于判断是否触发自动展平
 */
export function analyzeSchema(schema: ToolDefinition): { depth: number; leafCount: number; shouldFlatten: boolean } {
    const params = schema.function.parameters;
    if (!params || params.type !== 'object' || !params.properties) {
        return { depth: 1, leafCount: 0, shouldFlatten: false };
    }

    let maxDepth = 1;
    let leafCount = 0;

    function traverse(obj: any, currentDepth: number) {
        if (obj && obj.type === 'object' && obj.properties) {
            let hasChild = false;
            for (const key of Object.keys(obj.properties)) {
                hasChild = true;
                traverse(obj.properties[key], currentDepth + 1);
            }
            if (!hasChild) {
                leafCount++;
            }
        } else if (obj && obj.type === 'array' && obj.items) {
            traverse(obj.items, currentDepth + 1);
        } else {
            leafCount++;
            if (currentDepth > maxDepth) {
                maxDepth = currentDepth;
            }
        }
    }

    traverse(params, 1);

    // 触发展平的条件：深度 > 2，或者叶子节点数 > 10
    const shouldFlatten = maxDepth > 2 || leafCount > 10;

    return { depth: maxDepth, leafCount, shouldFlatten };
}

/**
 * 展平 schema 中的 properties，将嵌套对象使用 '.' 连接 key，并把它们拉平到最外层
 */
export function flattenSchema(schema: ToolDefinition): ToolDefinition {
    const params = schema.function.parameters;
    if (!params || params.type !== 'object' || !params.properties) {
        return schema;
    }

    const flatProperties: Record<string, any> = {};
    const flatRequired: string[] = [];
    let conflict = false;

    function buildFlat(obj: any, prefix: string, isParentRequired: boolean) {
        if (obj && obj.type === 'object' && obj.properties) {
            const keys = Object.keys(obj.properties);
            const requiredSet = new Set<string>(obj.required || []);
            for (const key of keys) {
                const childObj = obj.properties[key];
                const fullKey = prefix ? `${prefix}.${key}` : key;
                const isChildRequired = isParentRequired && requiredSet.has(key);

                if (childObj && childObj.type === 'object' && childObj.properties) {
                    buildFlat(childObj, fullKey, isChildRequired);
                } else {
                    if (flatProperties[fullKey] !== undefined) {
                        conflict = true;
                    }
                    flatProperties[fullKey] = childObj;
                    if (isChildRequired) {
                        flatRequired.push(fullKey);
                    }
                }
            }
        }
    }

    buildFlat(params, '', true);

    // 如果出现命名冲突，回退到原 schema 格式以保稳妥
    if (conflict) {
        return schema;
    }

    return {
        ...schema,
        function: {
            ...schema.function,
            parameters: {
                type: 'object',
                properties: flatProperties,
                required: flatRequired
            }
        }
    };
}

/**
 * 将扁平的参数（例如 { "filter.range.from": 1 }）逆向组装回嵌套的对象结构，供工具实际执行
 */
export function nestArguments(args: Record<string, any>): Record<string, any> {
    const nested: Record<string, any> = {};

    for (const key of Object.keys(args)) {
        const val = args[key];
        if (key.includes('.')) {
            const parts = key.split('.');
            let current = nested;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i]!;
                if (i === parts.length - 1) {
                    current[part] = val;
                } else {
                    if (current[part] === undefined) {
                        current[part] = {};
                    }
                    current = current[part];
                }
            }
        } else {
            nested[key] = val;
        }
    }

    return nested;
}
