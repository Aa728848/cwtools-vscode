export function resolveEntitySelectionIndex(
    entityNames: readonly string[],
    preferredName: string | undefined,
    fallbackIndex: number,
): number {
    if (entityNames.length === 0) return -1;

    if (preferredName) {
        const namedIndex = entityNames.indexOf(preferredName);
        if (namedIndex >= 0) return namedIndex;
    }

    const safeFallback = Number.isInteger(fallbackIndex) ? fallbackIndex : 0;
    return Math.min(Math.max(safeFallback, 0), entityNames.length - 1);
}
