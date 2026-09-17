import { spawnSync } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

const bytesPerGiB = 1024 ** 3;
const cacheTtlMs = 1_000;
let darwinCache = null;

export function parseDarwinMemoryPressureAvailableBytes(output, totalMemoryBytes)
{
    const total = Number(totalMemoryBytes);
    const match = String(output ?? '').match(/System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/u);
    const percentage = Number(match?.[1]);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(percentage)
        || percentage < 0 || percentage > 100)
    {
        return null;
    }
    return total * percentage / 100;
}

function sampleDarwinAvailableMemoryBytes(totalMemoryBytes)
{
    const result = spawnSync('/usr/bin/memory_pressure', ['-Q'], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        windowsHide: true
    });
    if (result.status !== 0 || result.error)
    {
        return null;
    }
    return parseDarwinMemoryPressureAvailableBytes(result.stdout, totalMemoryBytes);
}

export function availableMemoryBytes({
    platform = process.platform,
    totalMemoryBytes = os.totalmem(),
    fallbackFreeMemoryBytes = os.freemem(),
    nowMs = Date.now(),
    darwinSampler = sampleDarwinAvailableMemoryBytes
} = {})
{
    const fallback = Math.max(0, Number(fallbackFreeMemoryBytes) || 0);
    if (platform !== 'darwin')
    {
        return fallback;
    }
    const useCache = darwinSampler === sampleDarwinAvailableMemoryBytes;
    if (useCache && darwinCache && nowMs - darwinCache.observedAtMs < cacheTtlMs)
    {
        return darwinCache.availableBytes;
    }
    let sampled = null;
    try
    {
        sampled = darwinSampler(totalMemoryBytes);
    }
    catch
    {
        sampled = null;
    }
    const availableBytes = Number.isFinite(sampled) && sampled >= 0
        ? Math.max(fallback, Math.min(Number(totalMemoryBytes), sampled))
        : fallback;
    if (useCache)
    {
        darwinCache = { observedAtMs: nowMs, availableBytes };
    }
    return availableBytes;
}

export function availableMemoryGiB(options = {})
{
    return availableMemoryBytes(options) / bytesPerGiB;
}
