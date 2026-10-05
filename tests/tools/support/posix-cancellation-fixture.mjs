import path from 'node:path';

// Coordinate setup before fault injection; do not change scheduler termination budgets.
export function posixCancellationFailureSource({ pidFile, startupTimeoutMs = 5000 })
{
    if (typeof pidFile !== 'string' || !path.isAbsolute(pidFile)
        || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 5000)
    {
        throw new Error('POSIX cancellation fixture requires an absolute PID path and finite setup bound');
    }
    return [
        "import fs from 'node:fs'",
        "import { performance } from 'node:perf_hooks'",
        "import { setTimeout as delay } from 'node:timers/promises'",
        `const pidFile = ${JSON.stringify(pidFile)}`,
        `const deadline = performance.now() + ${startupTimeoutMs}`,
        'function refuse(reason) { process.stderr.write(`fixture readiness refused: ${reason}\\n`); process.exit(8) }',
        'let ready = false',
        'while (performance.now() < deadline) {',
        '    let value = null',
        "    try { value = fs.readFileSync(pidFile, 'utf8') } catch (error) { if (error.code !== 'ENOENT') refuse('unreadable PID') }",
        "    if (value !== null && value !== '') {",
        "        if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) refuse('malformed PID')",
        '        const pid = Number(value)',
        "        try { process.kill(pid, 0) } catch { refuse('dead or unobservable grandchild') }",
        "        if (process.platform === 'linux') {",
        '            let stat',
        "            try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8') } catch { refuse('dead or unobservable grandchild') }",
        "            const state = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0]",
        "            if (!/^[A-Za-z]$/u.test(state) || ['Z', 'X'].includes(state.toUpperCase())) refuse('dead or unobservable grandchild')",
        '        }',
        '        ready = true',
        '        break',
        '    }',
        '    await delay(10)',
        '}',
        "if (!ready) refuse('setup bound exceeded before grandchild publication')",
        'setTimeout(() => process.exit(7), 180)'
    ].join('\n') + '\n';
}
