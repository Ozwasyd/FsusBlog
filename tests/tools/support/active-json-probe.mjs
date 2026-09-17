import { spawn } from 'node:child_process';

export async function runActiveJsonProbe({
    file,
    cwd,
    activeLine = 'ACTIVE',
    startupTimeoutMs = 30_000,
    activeTimeoutMs = 5_000
})
{
    const child = spawn(process.execPath, [file], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const completion = Promise.withResolvers();
    let stdout = '';
    let stderr = '';
    let activeObserved = false;
    let activeWatchdog = null;
    const rejectAndKill = (message) =>
    {
        child.kill('SIGKILL');
        completion.reject(new Error(stderr ? `${message}: ${stderr}` : message));
    };
    const startupWatchdog = setTimeout(
        () => rejectAndKill('probe did not reach active admission'),
        startupTimeoutMs
    );
    child.stdout.on('data', (chunk) =>
    {
        stdout += chunk;
        if (!activeObserved && stdout.split('\n').includes(activeLine))
        {
            activeObserved = true;
            clearTimeout(startupWatchdog);
            activeWatchdog = setTimeout(
                () => rejectAndKill('probe busy-looped after active admission'),
                activeTimeoutMs
            );
        }
    });
    child.stderr.on('data', (chunk) =>
    {
        stderr += chunk;
    });
    child.once('error', (error) => completion.reject(error));
    child.once('close', (code, signal) => completion.resolve({ code, signal }));

    let exit;
    try
    {
        exit = await completion.promise;
    }
    finally
    {
        clearTimeout(startupWatchdog);
        clearTimeout(activeWatchdog);
    }
    if (!activeObserved || exit.signal !== null || exit.code !== 0)
    {
        throw new Error(
            `probe failed: active=${activeObserved} code=${exit.code} signal=${exit.signal ?? 'none'} stderr=${stderr}`
        );
    }
    return JSON.parse(stdout.trim().split('\n').at(-1));
}
