import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { collectProcessIdentity } from './process-identity.mjs';

const { canonicalJson, digestCanonical } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));

export const systemdSenderReadySchema = 'fsusblog.physical-systemd-sender-ready.v1';
export const systemdSenderReceiptSchema = 'fsusblog.physical-systemd-sender-terminal.v1';

export function systemdSenderReadyIsComplete(ready)
{
    return Boolean(exactKeys(ready, ['schema', 'authorityId', 'planDigest', 'publicKey', 'processIdentity'])
        && ready.schema === systemdSenderReadySchema
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(ready.authorityId)
        && /^sha256:[a-f0-9]{64}$/u.test(ready.planDigest)
        && ready.processIdentity?.schema === 'fsusblog.process-identity.v1'
        && ready.processIdentity.status === 'verified'
        && Number.isSafeInteger(ready.processIdentity.pid) && ready.processIdentity.pid > 0
        && typeof ready.processIdentity.processStartIdentity === 'string'
        && ready.processIdentity.processStartIdentity.length > 0
        && /^sha256:[a-f0-9]{64}$/u.test(ready.processIdentity.executableDigest)
        && /^sha256:[a-f0-9]{64}$/u.test(ready.processIdentity.commandDigest)
        && typeof ready.publicKey === 'string'
        && /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/u.test(ready.publicKey));
}

function exactKeys(value, keys)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function privateControlRoot(controlRoot)
{
    if (typeof controlRoot !== 'string' || !path.isAbsolute(controlRoot)
        || fs.realpathSync(controlRoot) !== controlRoot)
    {
        throw new Error('systemd sender requires a literal private control root');
    }
    const stat = fs.lstatSync(controlRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0)
    {
        throw new Error('systemd sender control root is not an owned private directory');
    }
    return controlRoot;
}

function readPlan(controlRoot)
{
    const file = path.join(controlRoot, 'sender-plan.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0)
    {
        throw new Error('systemd sender plan is not an owned private file');
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size
            || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs)
        {
            throw new Error('systemd sender plan changed during open');
        }
        const plan = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
        const after = fs.fstatSync(descriptor);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
        {
            throw new Error('systemd sender plan changed during read');
        }
        if (!exactKeys(plan, ['authorityId', 'args', 'cwd'])
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(plan.authorityId)
            || !Array.isArray(plan.args) || plan.args.length === 0
            || plan.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
            || typeof plan.cwd !== 'string' || !path.isAbsolute(plan.cwd)
            || fs.realpathSync(plan.cwd) !== plan.cwd)
        {
            throw new Error('systemd sender plan is incomplete');
        }
        return plan;
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function writeTerminal(controlRoot, body, privateKey)
{
    const signature = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64');
    const file = path.join(controlRoot, 'sender-terminal.json');
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try
    {
        fs.writeFileSync(descriptor, `${JSON.stringify({ ...body, signature })}\n`);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    const directory = fs.openSync(controlRoot, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        fs.fsyncSync(directory);
    }
    finally
    {
        fs.closeSync(directory);
    }
}

export function verifySystemdSenderTerminal(receipt, ready)
{
    if (!systemdSenderReadyIsComplete(ready)
        || !exactKeys(receipt, ['schema', 'authorityId', 'planDigest', 'processIdentity',
            'submission', 'exitCode', 'signal', 'errorCode', 'terminalAt', 'signature'])
        || receipt.schema !== systemdSenderReceiptSchema
        || receipt.authorityId !== ready.authorityId || receipt.planDigest !== ready.planDigest
        || digestCanonical(receipt.processIdentity) !== digestCanonical(ready.processIdentity)
        || !['not-submitted', 'sender-returned'].includes(receipt.submission)
        || !Number.isFinite(Date.parse(receipt.terminalAt))
        || (receipt.exitCode !== null && (!Number.isSafeInteger(receipt.exitCode) || receipt.exitCode < 0))
        || (receipt.signal !== null && typeof receipt.signal !== 'string')
        || (receipt.errorCode !== null && typeof receipt.errorCode !== 'string')
        || typeof receipt.signature !== 'string'
        || !/^[A-Za-z0-9+/]{86}==$/u.test(receipt.signature))
    {
        return false;
    }
    if (receipt.submission === 'not-submitted'
        && (receipt.exitCode !== null || receipt.signal !== null || receipt.errorCode !== null))
    {
        return false;
    }
    if (receipt.submission === 'sender-returned'
        && receipt.exitCode === null && receipt.signal === null && receipt.errorCode === null)
    {
        return false;
    }
    const { signature, ...body } = receipt;
    try
    {
        return verify(null, Buffer.from(canonicalJson(body)), ready.publicKey, Buffer.from(signature, 'base64'));
    }
    catch
    {
        return false;
    }
}

function relay(source, destination, onFailure)
{
    // Keep draining the sender after its controller dies. An EPIPE is not a
    // reason to abandon a submitted request or its terminal receipt.
    destination.on('error', (error) =>
    {
        onFailure(error);
        source.resume();
    });
    source.on('error', onFailure);
    source.on('data', (chunk) =>
    {
        if (!destination.destroyed && !destination.write(chunk))
        {
            source.pause();
            destination.once('drain', () => source.resume());
        }
    });
}

export function runSystemdSender(controlRoot)
{
    privateControlRoot(controlRoot);
    const plan = readPlan(controlRoot);
    const identity = collectProcessIdentity(process.pid);
    if (identity.status !== 'verified')
    {
        throw new Error('systemd sender process identity is unverifiable');
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const ready = {
        schema: systemdSenderReadySchema,
        authorityId: plan.authorityId,
        planDigest: digestCanonical(plan),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        processIdentity: identity
    };
    let released = false;
    let finished = false;
    let outputFailed = false;
    const outputFailure = () =>
    {
        outputFailed = true;
        process.exitCode = 1;
    };
    const finish = (submission, exitCode = null, signal = null, errorCode = null) =>
    {
        if (finished)
        {
            return;
        }
        finished = true;
        writeTerminal(controlRoot, { schema: systemdSenderReceiptSchema, authorityId: plan.authorityId,
            planDigest: ready.planDigest, processIdentity: identity, submission,
            exitCode, signal, errorCode, terminalAt: new Date().toISOString() }, privateKey);
        process.exitCode = !outputFailed && (submission === 'not-submitted' || exitCode === 0) ? 0 : 1;
        if (process.connected)
        {
            process.disconnect();
        }
    };
    process.on('disconnect', () =>
    {
        if (!released)
        {
            finish('not-submitted');
        }
    });
    process.on('message', (message) =>
    {
        if (finished || released || !exactKeys(message, ['type', 'authorityId', 'planDigest'])
            || message.type !== 'release' || message.authorityId !== ready.authorityId
            || message.planDigest !== ready.planDigest)
        {
            return;
        }
        released = true;
        let child;
        try
        {
            child = spawn('systemd-run', plan.args, {
                cwd: plan.cwd, env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
            });
        }
        catch (error)
        {
            finish('sender-returned', null, null, error.code ?? 'SPAWN_FAILED');
            return;
        }
        relay(child.stdout, process.stdout, outputFailure);
        relay(child.stderr, process.stderr, outputFailure);
        child.once('error', (error) => finish('sender-returned', null, null, error.code ?? 'SPAWN_FAILED'));
        child.once('exit', (code, signal) => finish('sender-returned', code, signal));
    });
    if (typeof process.send !== 'function')
    {
        throw new Error('systemd sender requires a private parent IPC channel');
    }
    process.send(ready);
    return ready;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
{
    try
    {
        runSystemdSender(process.argv[2]);
    }
    catch (error)
    {
        process.stderr.write(`systemd sender preparation failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
