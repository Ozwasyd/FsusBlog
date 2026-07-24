export const MIGRATION_PLACEHOLDER_PREFIX = '__FSUSBLOG_TRANSLATION_PENDING__:';

export interface MigrationPlaceholderInfo {
    isPlaceholder: boolean;
    key: string | null;
    isValid: boolean;
    error?: string;
}

export function parseMigrationPlaceholder(value: string, expectedPath?: string): MigrationPlaceholderInfo {
    if (typeof value !== 'string' || !value.startsWith(MIGRATION_PLACEHOLDER_PREFIX)) {
        return { isPlaceholder: false, key: null, isValid: false };
    }
    const key = value.slice(MIGRATION_PLACEHOLDER_PREFIX.length);
    if (!key || key.includes(' ') || key.startsWith('.') || key.endsWith('.')) {
        return { isPlaceholder: true, key, isValid: false, error: 'invalid key format in placeholder' };
    }
    if (expectedPath && key !== expectedPath) {
        return {
            isPlaceholder: true,
            key,
            isValid: false,
            error: `placeholder key mismatch: expected "${expectedPath}", got "${key}"`
        };
    }
    return { isPlaceholder: true, key, isValid: true };
}

export interface EnumeratedPlaceholder {
    path: string;
    placeholder: string;
    key: string;
    isValid: boolean;
    error?: string;
}

export function enumeratePlaceholders(obj: unknown, path = ''): EnumeratedPlaceholder[] {
    const results: EnumeratedPlaceholder[] = [];
    if (!obj || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            const info = parseMigrationPlaceholder(obj, path);
            if (info.isPlaceholder) {
                results.push({
                    path,
                    placeholder: obj,
                    key: info.key ?? '',
                    isValid: info.isValid,
                    error: info.error
                });
            }
        }
        return results;
    }

    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        const currentPath = path ? `${path}.${key}` : key;
        results.push(...enumeratePlaceholders(val, currentPath));
    }

    return results;
}

export function extractInterpolationParams(message: string): string[] {
    const matches = message.match(/\{([A-Za-z][A-Za-z0-9]*)\}/gu);
    if (!matches) {
        return [];
    }
    const params = matches.map((m) => m.slice(1, -1));
    return Array.from(new Set(params)).sort();
}

const FORBIDDEN_PLACEHOLDER_SUBSTRINGS = ['TODO_TRANSLATE', 'TODO', 'TBD', 'Translation pending'];

export function validateLeafValue(val: unknown, path: string): string | null {
    if (typeof val !== 'string') {
        return `Leaf node "${path}" is not a string (type: ${typeof val})`;
    }
    for (const forbidden of FORBIDDEN_PLACEHOLDER_SUBSTRINGS) {
        if (val.includes(forbidden)) {
            return `Leaf node "${path}" contains forbidden placeholder phrase "${forbidden}"`;
        }
    }
    const placeholder = parseMigrationPlaceholder(val, path);
    if (placeholder.isPlaceholder && !placeholder.isValid) {
        return `Leaf node "${path}" has invalid placeholder: ${placeholder.error}`;
    }
    return null;
}

export interface ParityValidationResult {
    isValid: boolean;
    errors: string[];
}

export function validateLocaleParity(zh: Record<string, unknown>, en: Record<string, unknown>, path = ''): ParityValidationResult {
    const errors: string[] = [];

    const zhKeys = new Set(Object.keys(zh));
    const enKeys = new Set(Object.keys(en));

    for (const key of zhKeys) {
        const currentPath = path ? `${path}.${key}` : key;
        if (!enKeys.has(key)) {
            errors.push(`Missing key in en-US: "${currentPath}"`);
            continue;
        }

        const zhVal = zh[key];
        const enVal = en[key];

        const zhType = typeof zhVal;
        const enType = typeof enVal;

        if (zhType !== enType) {
            errors.push(`Type mismatch at "${currentPath}": zh-CN is ${zhType}, en-US is ${enType}`);
            continue;
        }

        if (zhType === 'object' && zhVal !== null && enVal !== null) {
            const childResult = validateLocaleParity(
                zhVal as Record<string, unknown>,
                enVal as Record<string, unknown>,
                currentPath
            );
            errors.push(...childResult.errors);
        } else {
            const zhLeafErr = validateLeafValue(zhVal, currentPath);
            if (zhLeafErr) errors.push(zhLeafErr);

            const enLeafErr = validateLeafValue(enVal, currentPath);
            if (enLeafErr) errors.push(enLeafErr);

            if (typeof zhVal === 'string' && typeof enVal === 'string') {
                const zhPlaceholder = parseMigrationPlaceholder(zhVal, currentPath);
                const enPlaceholder = parseMigrationPlaceholder(enVal, currentPath);

                if (!zhPlaceholder.isPlaceholder && !enPlaceholder.isPlaceholder) {
                    const zhParams = extractInterpolationParams(zhVal);
                    const enParams = extractInterpolationParams(enVal);
                    if (zhParams.join(',') !== enParams.join(',')) {
                        errors.push(
                            `Interpolation parameter mismatch at "${currentPath}": zh-CN has [${zhParams.join(', ')}], en-US has [${enParams.join(', ')}]`
                        );
                    }
                }
            }
        }
    }

    for (const key of enKeys) {
        if (!zhKeys.has(key)) {
            const currentPath = path ? `${path}.${key}` : key;
            errors.push(`Extra key in en-US not present in zh-CN: "${currentPath}"`);
        }
    }

    return {
        isValid: errors.length === 0,
        errors
    };
}
