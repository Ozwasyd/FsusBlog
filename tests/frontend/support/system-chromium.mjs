import { existsSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SYSTEM_CHROMIUM_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
];

export function resolveSystemChromiumExecutablePath()
{
    if (process.env.FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY === '1')
    {
        return undefined;
    }
    return process.env.PLAYWRIGHT_CHROMIUM_PATH
    || SYSTEM_CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate))
    || undefined;
}

function availableBytes(target)
{
    try
    {
        const stats = statfsSync(target, { bigint: true });
        return stats.bavail * stats.bsize;
    }
    catch
    {
        return null;
    }
}

export function shouldDisableChromiumDevShmUsage()
{
    const sharedMemoryAvailable = availableBytes('/dev/shm');
    if (sharedMemoryAvailable === null || sharedMemoryAvailable <= 0n)
    {
        return true;
    }

    const temporaryStorageAvailable = availableBytes(tmpdir());
    if (temporaryStorageAvailable === null)
    {
        return false;
    }

    // Chromium should use whichever machine-backed scratch location currently
    // has more headroom instead of forcing every host onto disk-backed /tmp.
    return temporaryStorageAvailable > sharedMemoryAvailable;
}

/**
 * @param {import('@playwright/test').LaunchOptions} [options]
 * @returns {import('@playwright/test').LaunchOptions}
 */
export function systemChromiumLaunchOptions(options = {})
{
    const executablePath = resolveSystemChromiumExecutablePath();
    const disableDevShmUsage = shouldDisableChromiumDevShmUsage();
    const args = Array.from(new Set([
        ...(Array.isArray(options.args) ? options.args : []),
        '--no-sandbox',
        ...(disableDevShmUsage ? ['--disable-dev-shm-usage'] : [])
    ]));
    const ignoreDefaultArgs = options.ignoreDefaultArgs === true
        ? true
        : Array.from(new Set([
        ...(Array.isArray(options.ignoreDefaultArgs) ? options.ignoreDefaultArgs : []),
        ...(!disableDevShmUsage ? ['--disable-dev-shm-usage'] : [])
      ]));

    return {
        ...options,
        ...(executablePath ? { executablePath } : {}),
        ...(ignoreDefaultArgs === true || ignoreDefaultArgs.length > 0 ? { ignoreDefaultArgs } : {}),
        args
    };
}
