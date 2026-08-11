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

function publishPrivateFile(file, content)
{
    const temporary = `${file}.next-${process.pid}`;
    try
    {
        fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
    }
    catch (error)
    {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

publishPrivateFile(readyFile, `${process.pid}\n`);
await waitFor(startFile);

const child = spawn(command[0], command.slice(1), {
    env: commandEnvironment,
    detached: true,
    stdio: 'inherit'
});
const result = await new Promise((resolve) =>
{
    child.once('spawn', () =>
    {
        publishPrivateFile(childFile, `${JSON.stringify({ pid: child.pid })}\n`);
    });
    child.once('error', (error) =>
    {
        const spawnError = {
            name: error.name,
            code: error.code ?? null,
            message: error.message
        };
        publishPrivateFile(
            childFile,
            `${JSON.stringify({ pid: null, spawnError })}\n`
        );
        resolve({ exitCode: null, signal: null, spawnError });
    });
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
});
publishPrivateFile(resultFile, `${JSON.stringify(result)}\n`);
await waitFor(finalizeFile);
