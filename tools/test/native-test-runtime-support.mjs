import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export function commandPath(command)
{
    const result = spawnSync('which', [command], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

export function commandVersion(command, args = ['--version'])
{
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return result.status === 0 ? String(result.stdout || result.stderr).trim() : null;
}

export function sourceCommit(root)
{
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '0'.repeat(40);
}

export function runNativeCommand(root, command, args)
{
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        stdio: 'inherit',
        env: process.env
    });
    return result.status ?? 1;
}

export function writeNativeReceipt(out, receipt)
{
    fs.mkdirSync(new URL('.', `file://${out}`), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
}
