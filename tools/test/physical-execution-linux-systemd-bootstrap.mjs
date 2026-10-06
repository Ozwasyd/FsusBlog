import { spawn } from 'node:child_process';
import { createHash, verify } from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
    finalizePrivateDotnetScratch,
    preparePrivateDotnetScratch,
    verifyPrivateDotnetScratchBinding
} from './physical-execution-private-dotnet-scratch.mjs';

const [controlRoot] = process.argv.slice(2);
if (!controlRoot)
{
    process.exit(2);
}

const command = JSON.parse(fs.readFileSync(`${controlRoot}/command.json`, 'utf8'));
const commandEnvironment = JSON.parse(fs.readFileSync(`${controlRoot}/environment.json`, 'utf8'));
const admission = JSON.parse(fs.readFileSync(`${controlRoot}/admission.json`, 'utf8'));
const privateDotnetScratchBinding = admission.privateDotnetScratch
    ? Object.fromEntries(Object.entries(admission.privateDotnetScratch)
        .filter(([key]) => !['unitName', 'hostMountNamespace', 'hostTmpIdentity'].includes(key)))
    : null;
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

let privateDotnetScratchState = null;
if (admission.privateDotnetScratch)
{
    try
    {
        verifyPrivateDotnetScratchBinding(privateDotnetScratchBinding, {
            environment: commandEnvironment,
            cwd: process.cwd(),
            controlRoot
        });
        privateDotnetScratchState = preparePrivateDotnetScratch({
            hostNamespace: admission.privateDotnetScratch.hostMountNamespace,
            unitNamespace: fs.readlinkSync('/proc/self/ns/mnt'),
            hostTmpIdentity: admission.privateDotnetScratch.hostTmpIdentity,
            privateTmp: 'yes'
        });
        publishPrivateFile(`${controlRoot}/private-dotnet-scratch-prepared.json`, JSON.stringify({
            binding: privateDotnetScratchBinding,
            mountNamespace: privateDotnetScratchState.mountNamespace,
            path: admission.privateDotnetScratch.path,
            authorityId: admission.authorityId
        }));
    }
    catch (error)
    {
        let cleanup = 'not-prepared';
        if (privateDotnetScratchState)
        {
            try
            {
                finalizePrivateDotnetScratch(privateDotnetScratchState, {
                    unitNamespace: fs.readlinkSync('/proc/self/ns/mnt')
                });
                cleanup = 'removed';
            }
            catch
            {
                cleanup = 'unverifiable';
            }
        }
        publishPrivateFile(`${controlRoot}/private-dotnet-scratch-finalized.json`, JSON.stringify({
            cleanup,
            reason: error.message,
            path: admission.privateDotnetScratch.path,
            binding: privateDotnetScratchBinding,
            authorityId: admission.authorityId,
            unitName: admission.privateDotnetScratch.unitName
        }));
        const spawnError = { name: error.name, code: error.code ?? null, message: error.message };
        publishPrivateFile(childFile, `${JSON.stringify({ pid: null, spawnError })}\n`);
        publishPrivateFile(resultFile, `${JSON.stringify({ exitCode: 125, signal: null, spawnError })}\n`);
        await waitFor(finalizeFile);
        process.exit(125);
    }
}

const child = spawn(admission.python, ['-I', '-S', fileURLToPath(new URL('./physical-execution-linux-preexec.py', import.meta.url))], {
    detached: true,
    stdio: ['inherit', 'inherit', 'inherit', 'pipe']
});
let execError = null;
let registered = false;
const messages = createInterface({ input: child.stdio[3] });
let nativeMessageTask = null;
if (admission.nativeInputCarrier)
{
    const deadlineAt = Date.now() + admission.nativeInputHandshakeTimeoutMs;
    const waitNative = (file) => new Promise((resolve, reject) =>
    {
        const timer = setInterval(() =>
        {
            if (Date.now() >= deadlineAt || child.exitCode !== null || child.signalCode !== null)
            {
                clearInterval(timer);
                reject(new Error('native input phase ended without its exact parent instruction'));
            }
            else if (fs.existsSync(file)) { clearInterval(timer); resolve(); }
        }, intervalMs);
    });
    nativeMessageTask = (async () =>
    {
        let phase = 'initial';
        let initialRegistration;
        for await (const line of messages)
        {
            if (Buffer.byteLength(line, 'utf8') > 262144) throw new Error('native input registration exceeds its bound');
            const message = JSON.parse(line);
            if (message.spawnError) { execError = message.spawnError; return; }
            if (Object.keys(message).join(',') !== 'registration' || typeof message.registration !== 'string')
                throw new Error('native input helper message roster differs');
            if (phase === 'initial')
            {
                initialRegistration = JSON.parse(message.registration);
                if (JSON.stringify(initialRegistration.requiredNativeInputs) !== JSON.stringify(admission.nativeInputCarrier))
                    throw new Error('native initial registration omitted required original carrier');
                publishPrivateFile(childFile, `${message.registration}\n`);
                registered = true;
                phase = 'receive-only';
                await waitNative(`${controlRoot}/input-admission.json`);
                const packet = JSON.parse(fs.readFileSync(`${controlRoot}/input-admission.json`, 'utf8'));
                if (Object.keys(packet).sort().join(',') !== 'instruction,signature'
                    || typeof packet.instruction !== 'string'
                    || !verify(null, Buffer.from(packet.instruction), admission.publicKey, Buffer.from(packet.signature, 'base64')))
                    throw new Error('native receive-only parent signature differs');
                const body = JSON.parse(packet.instruction);
                if (Object.keys(body).sort().join(',') !== 'carrier,phase,registrationSha256,timeoutSeconds'
                    || body.phase !== 'receive-only'
                    || body.registrationSha256 !== createHash('sha256').update(message.registration).digest('hex')
                    || JSON.stringify(body.carrier) !== JSON.stringify(admission.nativeInputCarrier)
                    || !Number.isFinite(body.timeoutSeconds) || body.timeoutSeconds <= 0
                    || body.timeoutSeconds * 1000 > admission.nativeInputHandshakeTimeoutMs)
                    throw new Error('native receive-only instruction binding differs');
                child.stdio[3].write(`${JSON.stringify({ receive: body })}\n`);
                phase = 'final';
                continue;
            }
            if (phase !== 'final') throw new Error('native input registration is duplicated or out of order');
            const { nativeInputs, ...preserved } = JSON.parse(message.registration);
            if (!nativeInputs || JSON.stringify(preserved) !== JSON.stringify(initialRegistration))
                throw new Error('native final registration changed its initial process/command state');
            publishPrivateFile(`${controlRoot}/child-inputs.json`, `${message.registration}\n`);
            phase = 'release';
            await waitNative(`${controlRoot}/release.json`);
            const release = JSON.parse(fs.readFileSync(`${controlRoot}/release.json`, 'utf8'));
            if (release.registration !== message.registration
                || !verify(null, Buffer.from(release.registration), admission.publicKey, Buffer.from(release.signature, 'base64')))
                throw new Error('native final execution signature differs');
            child.stdio[3].end(`${JSON.stringify({ release: message.registration })}\n`);
            phase = 'running';
        }
        if (phase !== 'running') throw new Error('native helper closed before its final signed execution release');
    })().catch((error) =>
    {
        execError = { name: error.name, code: error.code ?? null, message: error.message };
        child.kill('SIGTERM');
    });
}
else messages.on('line', async (line) =>
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
            privateTmpPlan: admission.privateTmpPlan,
            command,
            environmentJson: JSON.stringify(commandEnvironment),
            ...(admission.nativeInputCarrier ? { nativeInputCarrier: admission.nativeInputCarrier } : {})
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
if (nativeMessageTask) { await nativeMessageTask; result.spawnError = execError; }
publishPrivateFile(resultFile, `${JSON.stringify(result)}\n`);
await waitFor(finalizeFile);
if (privateDotnetScratchState)
{
    try
    {
        const observation = finalizePrivateDotnetScratch(privateDotnetScratchState, {
            unitNamespace: fs.readlinkSync('/proc/self/ns/mnt')
        });
        publishPrivateFile(`${controlRoot}/private-dotnet-scratch-finalized.json`, JSON.stringify({
            ...observation,
            binding: privateDotnetScratchBinding,
            authorityId: admission.authorityId,
            unitName: admission.privateDotnetScratch.unitName
        }));
    }
    catch (error)
    {
        publishPrivateFile(`${controlRoot}/private-dotnet-scratch-finalized.json`, JSON.stringify({
            cleanup: 'unverifiable',
            reason: error.message,
            authorityId: admission.authorityId,
            unitName: admission.privateDotnetScratch.unitName
        }));
        process.exitCode = 125;
    }
}
