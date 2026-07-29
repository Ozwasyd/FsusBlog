import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

const [controlRoot] = process.argv.slice(2);
if (!controlRoot)
{
    process.exit(2);
}

const command = JSON.parse(fs.readFileSync(`${controlRoot}/command.json`, 'utf8'));
const commandEnvironment = JSON.parse(fs.readFileSync(`${controlRoot}/environment.json`, 'utf8'));
const readyFile = `${controlRoot}/ready`;
const startFile = `${controlRoot}/start`;
const childFile = `${controlRoot}/child.json`;
const resultFile = `${controlRoot}/result.json`;
const finalizeFile = `${controlRoot}/finalize`;
const intervalMs = 10;

function waitFor(file)
{
    return new Promise((resolve) =>
    {
        const timer = setInterval(() =>
        {
            if (!fs.existsSync(file))
            {
                return;
            }
            clearInterval(timer);
            resolve();
        }, intervalMs);
    });
}

fs.writeFileSync(readyFile, `${process.pid}\n`, { mode: 0o600 });
await waitFor(startFile);

const child = spawn(command[0], command.slice(1), {
    env: commandEnvironment,
    stdio: 'inherit'
});
fs.writeFileSync(childFile, `${JSON.stringify({ pid: child.pid })}\n`, { mode: 0o600 });
const result = await new Promise((resolve, reject) =>
{
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
});
fs.writeFileSync(resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
await waitFor(finalizeFile);
