export interface EntityAttachNode {
    attaches: ReadonlyArray<{ entityName: string }>;
}

/** Find a directed attach path, including both endpoints, if one exists. */
export function findEntityAttachPath(
    entities: ReadonlyMap<string, EntityAttachNode>,
    fromEntity: string,
    toEntity: string,
): string[] | undefined {
    const visiting = new Set<string>();
    const visit = (name: string, path: string[]): string[] | undefined => {
        if (name === toEntity) return [...path, name];
        if (visiting.has(name)) return undefined;
        visiting.add(name);
        const entity = entities.get(name);
        for (const attach of entity?.attaches ?? []) {
            const result = visit(attach.entityName, [...path, name]);
            if (result) return result;
        }
        visiting.delete(name);
        return undefined;
    };
    return visit(fromEntity, []);
}

/** A new parent → child edge is circular when child already reaches parent. */
export function getNewAttachCycle(
    entities: ReadonlyMap<string, EntityAttachNode>,
    parentEntity: string,
    childEntity: string,
): string[] | undefined {
    const path = findEntityAttachPath(entities, childEntity, parentEntity);
    return path ? [parentEntity, ...path] : undefined;
}
