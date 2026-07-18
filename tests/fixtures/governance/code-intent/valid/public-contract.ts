/**
 * Resolves a stable wire cursor, or null when the external value is not usable.
 */
export function resolveWireCursor(value: number): number | null {
    return value >= 0 ? value : null
}
