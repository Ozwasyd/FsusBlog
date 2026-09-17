import { spawn } from 'node:child_process';
import { verify } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [controlRoot] = process.argv.slice(2);
if (!controlRoot)
{
    process.exit(2);
}

const command = JSON.parse(fs.readFileSync(`${controlRoot}/command.json`, 'utf8'));
const commandEnvironment = JSON.parse(fs.readFileSync(`${controlRoot}/environment.json`, 'utf8'));
const admission = JSON.parse(fs.readFileSync(`${controlRoot}/admission.json`, 'utf8'));
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

const child = spawn(admission.python, ['-I', '-S', fileURLToPath(new URL('./physical-execution-linux-preexec.py', import.meta.url))], {
    detached: true,
    stdio: ['inherit', 'inherit', 'inherit', 'pipe']
});
let execError = null;
let registered = false;
const messages = createInterface({ input: child.stdio[3] });
messages.on('line', async (line) =>
{
    try
    {
        const message = JSON.parse(line);
        if (message.spawnError)
        {
            execError = message.spawnError;
            return;
        }
        if (typeof message.registration !== 'string')
        {
            throw new Error('physical execution helper registration is missing');
        }
        publishPrivateFile(childFile, `${message.registration}\n`);
        registered = true;
        await waitFor(`${controlRoot}/release.json`);
        const release = JSON.parse(fs.readFileSync(`${controlRoot}/release.json`, 'utf8'));
        if (release.registration !== message.registration
            || !verify(null, Buffer.from(release.registration), admission.publicKey,
                Buffer.from(release.signature, 'base64')))
        {
            throw new Error('physical execution pre-exec release signature is invalid');
        }
        child.stdio[3].end(`${JSON.stringify({ release: message.registration })}\n`);
    }
    catch (error)
    {
        execError = { name: error.name, code: error.code ?? null, message: error.message };
        child.kill('SIGTERM');
    }
});
child.stdio[3].on('error', (error) =>
{
    execError ??= { name: error.name, code: error.code ?? null, message: error.message };
    child.kill('SIGTERM');
});
const result = await new Promise((resolve) =>
{
    child.once('spawn', () =>
    {
        child.stdio[3].write(`${JSON.stringify({
            authorityId: admission.authorityId,
            command,
            environmentJson: JSON.stringify(commandEnvironment)
        })}\n`);
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
        registered = true;
        resolve({ exitCode: null, signal: null, spawnError });
    });
    child.once('close', (exitCode, signal) =>
    {
        if (!registered)
        {
            execError ??= {
                name: 'Error', code: null,
                message: `pre-exec helper failed before registration (exit ${exitCode}, signal ${signal})`
            };
            publishPrivateFile(childFile, `${JSON.stringify({ pid: null, spawnError: execError })}\n`);
        }
        resolve({ exitCode, signal, spawnError: execError });
    });
});
publishPrivateFile(resultFile, `${JSON.stringify(result)}\n`);
await waitFor(finalizeFile);
