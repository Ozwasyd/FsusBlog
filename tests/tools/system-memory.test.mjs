import assert from 'node:assert/strict';
import test from 'node:test';

import {
    availableMemoryBytes,
    parseDarwinMemoryPressureAvailableBytes
} from '../../tools/test/system-memory.mjs';

test('Darwin memory pressure percentage resolves reusable memory', () =>
{
    assert.equal(
        parseDarwinMemoryPressureAvailableBytes('System-wide memory free percentage: 40%\n', 16 * 1024),
        6.4 * 1024
    );
});

test('Darwin available memory never undercuts the Node fallback', () =>
{
    assert.equal(availableMemoryBytes({
        platform: 'darwin',
        totalMemoryBytes: 16_000,
        fallbackFreeMemoryBytes: 2_000,
        darwinSampler: () => 1_000
    }), 2_000);
});

test('Darwin probe failure and non-Darwin hosts use the Node fallback', () =>
{
    assert.equal(availableMemoryBytes({
        platform: 'darwin',
        totalMemoryBytes: 16_000,
        fallbackFreeMemoryBytes: 2_000,
        darwinSampler: () => null
    }), 2_000);
    assert.equal(availableMemoryBytes({
        platform: 'linux',
        totalMemoryBytes: 16_000,
        fallbackFreeMemoryBytes: 3_000,
        darwinSampler: () => 8_000
    }), 3_000);
});
