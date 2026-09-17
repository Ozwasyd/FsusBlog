import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

function normalizeOutputDeclaration(value)
{
    return String(value ?? '')
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\.\//u, '')
        .replace(/\/+$/u, '');
}

function wildcardPrefix(value)
{
    const wildcardIndex = value.search(/[?*]/u);
    return value.slice(0, wildcardIndex < 0 ? value.length : wildcardIndex).replace(/\/+$/u, '');
}

function outputDeclarationsOverlap(left, right)
{
    const leftValue = normalizeOutputDeclaration(left);
    const rightValue = normalizeOutputDeclaration(right);
    if (!leftValue || !rightValue)
    {
        return false;
    }
    const leftPrefix = wildcardPrefix(leftValue);
    const rightPrefix = wildcardPrefix(rightValue);
    return leftValue === rightValue
        || leftPrefix === rightPrefix
        || leftPrefix.startsWith(`${rightPrefix}/`)
        || rightPrefix.startsWith(`${leftPrefix}/`);
}

export function validateOwnedOutputDeclarations(commands)
{
    const errors = [];
    for (let rightIndex = 0; rightIndex < commands.length; rightIndex += 1)
    {
        const right = commands[rightIndex];
        for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1)
        {
            const left = commands[leftIndex];
            for (const rightOutput of right.ownedOutputs ?? [])
            {
                const leftOutput = (left.ownedOutputs ?? []).find((candidate) => (
                    outputDeclarationsOverlap(candidate, rightOutput)
                ));
                if (leftOutput !== undefined)
                {
                    errors.push(`${left.id} and ${right.id} declare overlapping ownedOutputs: ${leftOutput} <> ${rightOutput}`);
                }
            }
        }
    }
    return errors;
}

function signalProcessGroup(child, signal)
{
    if (process.platform === 'win32')
    {
        if (child.pid)
        {
            spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
                stdio: 'ignore',
                windowsHide: true
            });
        }
        return;
    }
    if (!child.pid)
    {
        return;
    }
    try
    {
        process.kill(-child.pid, signal);
    }
    catch (error)
    {
        if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null)
        {
            child.kill(signal);
        }
    }
}

export function executeManifestProcessGroup({ id, command, cwd, env, signal })
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(command[0], command.slice(1), {
            cwd,
            env,
            stdio: 'inherit',
            detached: process.platform !== 'win32'
        });
        let cancellationStarted = false;
        let escalationTimer;
        const cancel = () =>
        {
            if (cancellationStarted)
            {
                return;
            }
            cancellationStarted = true;
            signalProcessGroup(child, 'SIGTERM');
            escalationTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 1_000);
            escalationTimer.unref?.();
        };
        const cleanup = () =>
        {
            signal?.removeEventListener('abort', cancel);
            if (escalationTimer)
            {
                clearTimeout(escalationTimer);
            }
        };
        if (signal?.aborted)
        {
            cancel();
        }
        else
        {
            signal?.addEventListener('abort', cancel, { once: true });
        }
        child.on('error', (error) =>
        {
            cleanup();
            reject(error);
        });
        child.on('exit', (code, exitSignal) =>
        {
            if (cancellationStarted)
            {
                // The group leader may exit while a descendant ignores
                // SIGTERM. The saved PGID remains addressable, so force the
                // complete group down before reporting cancellation evidence.
                signalProcessGroup(child, 'SIGKILL');
                cleanup();
                reject(signal?.reason ?? new Error(`${id} cancelled`));
            }
            else if (code === 0)
            {
                cleanup();
                resolve();
            }
            else
            {
                cleanup();
                reject(new Error(`${id} failed (${exitSignal ? `signal ${exitSignal}` : `exit ${code}`})`));
            }
        });
    });
}
