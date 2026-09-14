#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

const command = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'));
if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string'))
{
    throw new Error('physical execution bootstrap received an invalid command');
}

process.send?.({ type: 'physical-execution-bootstrap-ready' });
process.once('message', (message) =>
{
    if (message?.type !== 'physical-execution-start')
    {
        throw new Error('physical execution bootstrap received an invalid start handshake');
    }
    const child = spawn(command[0], command.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit'
    });
    child.once('spawn', () => process.send?.({ type: 'physical-execution-child-started', pid: child.pid }));
    child.once('error', (error) =>
    {
        console.error(`[physical-execution-bootstrap] ${error.message}`);
        process.exitCode = 127;
    });
    child.once('exit', (exitCode, signal) =>
    {
        if (signal)
        {
            process.kill(process.pid, signal);
            return;
        }
        process.exitCode = exitCode ?? 1;
    });
});
