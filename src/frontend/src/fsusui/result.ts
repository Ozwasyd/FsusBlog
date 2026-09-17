import { isFsusOk, type FsusResult } from '@ozwasyd/element-plus/result';

export type FsusUiResult<T = unknown> = FsusResult<T>;

export function isFsusUiResult(value: unknown): value is FsusUiResult
{
    if (typeof value !== 'object' || value === null || !('ok' in value))
    {
        return false;
    }

    const candidate = value as { ok?: unknown; };
    if (candidate.ok === true)
    {
        return 'value' in value;
    }

    return candidate.ok === false && 'error' in value;
}

export function isFsusUiOk(value: unknown): boolean
{
    if (isFsusUiResult(value))
    {
        return isFsusOk(value) && value.value !== false;
    }

    return false;
}

export function getFsusUiErrorMessage(value: unknown, fallback: string): string
{
    if (!isFsusUiResult(value) || value.ok)
    {
        return fallback;
    }

    return value.error?.message || fallback;
}
