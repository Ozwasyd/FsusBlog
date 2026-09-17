#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { requireSlot, resolveSlotConfig } from './slot-lib.mjs';

function parseArgs(argv)
{
    const command = argv[0];
    const options = {};
    for (let index = 1; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        options[name.slice(2)] = value;
    }
    return { command, options };
}

export function renderUpstream(slot, environment = process.env)
{
    const config = resolveSlotConfig(slot, environment);
    return `server 127.0.0.1:${config.port};\n`;
}

export function inspectUpstreamFile(file, environment = process.env)
{
    const content = fs.readFileSync(file, 'utf8');
    for (const slot of ['blue', 'green'])
    {
        const config = resolveSlotConfig(slot, environment);
        if (content === renderUpstream(slot, environment))
        {
            return { slot, host: '127.0.0.1', port: config.port, sha256: sha256(content), file: path.resolve(file) };
        }
    }
    throw new Error('active upstream must contain exactly one controlled loopback blue/green server line');
}

export function initializeUpstreamFile(file, slotValue, environment = process.env)
{
    const slot = requireSlot(slotValue);
    const target = path.resolve(file);
    if (fs.existsSync(target))
    {
        const current = inspectUpstreamFile(target, environment);
        if (current.slot !== slot)
        {
            throw new Error(`active upstream already selects ${current.slot}; use gateway-switch.sh instead of initialization`);
        }
        return { ...current, status: 'already-initialized' };
    }
    atomicWriteFile(target, renderUpstream(slot, environment), 0o644);
    return { ...inspectUpstreamFile(target, environment), status: 'initialized' };
}

export function prepareGatewayFiles(input)
{
    const slot = requireSlot(input.slot);
    const activeFile = path.resolve(input.activeFile);
    const gatewayConfig = path.resolve(input.gatewayConfig);
    const activeDirectory = path.dirname(activeFile);
    fs.mkdirSync(activeDirectory, { recursive: true, mode: 0o755 });
    const suffix = `${process.pid}-${crypto.randomUUID()}`;
    const preparedFile = path.join(activeDirectory, `.${path.basename(activeFile)}.next-${suffix}`);
    const stagedConfig = path.join(path.dirname(gatewayConfig), `.${path.basename(gatewayConfig)}.stage-${suffix}`);
    const upstream = renderUpstream(slot, input.environment);
    writeDurableFile(preparedFile, upstream, 0o644, true);

    const configSource = fs.readFileSync(gatewayConfig, 'utf8');
    const includePattern = new RegExp(`(^[\\t ]*include[\\t ]+)${escapeRegExp(activeFile)};[\\t ]*$`, 'gmu');
    const matches = [...configSource.matchAll(includePattern)];
    if (matches.length !== 1)
    {
        fs.rmSync(preparedFile, { force: true });
        throw new Error(`gateway config must include ${activeFile} exactly once`);
    }
    const stagedSource = configSource.replace(includePattern, `$1${preparedFile};`);
    writeDurableFile(stagedConfig, stagedSource, 0o600, true);
    return {
        slot,
        activeFile,
        gatewayConfig,
        preparedFile,
        stagedConfig,
        upstreamSha256: sha256(upstream),
        stagedConfigSha256: sha256(stagedSource)
    };
}

export function installPreparedUpstream(input)
{
    const activeFile = path.resolve(input.activeFile);
    const preparedFile = path.resolve(input.preparedFile);
    inspectUpstreamFile(activeFile, input.environment);
    const prepared = inspectUpstreamFile(preparedFile, input.environment);
    const backupFile = path.resolve(input.backupFile);
    writeDurableFile(backupFile, fs.readFileSync(activeFile), 0o600, true);
    fs.renameSync(preparedFile, activeFile);
    fsyncDirectory(path.dirname(activeFile));
    return { ...prepared, activeFile, backupFile };
}

export function restoreUpstream(input)
{
    const activeFile = path.resolve(input.activeFile);
    const backupFile = path.resolve(input.backupFile);
    const backup = inspectUpstreamFile(backupFile, input.environment);
    atomicWriteFile(activeFile, fs.readFileSync(backupFile), 0o644);
    return { ...backup, activeFile, restoredFrom: backupFile };
}

export function writeEvidenceAtomic(file, evidence)
{
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))
    {
        throw new Error('gateway evidence must be an object');
    }
    if (containsSensitiveField(evidence))
    {
        throw new Error('gateway evidence contains a sensitive field name');
    }
    atomicWriteFile(path.resolve(file), `${JSON.stringify(evidence, null, 2)}\n`, 0o600);
}

function writeDurableFile(file, content, mode, exclusive)
{
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const descriptor = fs.openSync(file, exclusive ? 'wx' : 'w', mode);
    try
    {
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    fsyncDirectory(directory);
}

function atomicWriteFile(file, content, mode)
{
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
    try
    {
        writeDurableFile(temporary, content, mode, true);
        fs.renameSync(temporary, file);
        fsyncDirectory(directory);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

function fsyncDirectory(directory)
{
    const descriptor = fs.openSync(directory, 'r');
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function containsSensitiveField(value)
{
    if (Array.isArray(value))
    {
        return value.some(containsSensitiveField);
    }
    if (!value || typeof value !== 'object')
    {
        return false;
    }
    for (const [key, nested] of Object.entries(value))
    {
        if (/(?:password|passwd|token|privatekey|secret|credential)$/iu.test(key))
        {
            return true;
        }
        if (containsSensitiveField(nested))
        {
            return true;
        }
    }
    return false;
}

async function main()
{
    const { command, options } = parseArgs(process.argv.slice(2));
    let output;
    switch (command)
    {
        case 'render':
            process.stdout.write(renderUpstream(options.slot));
            return;
        case 'inspect':
            output = inspectUpstreamFile(options.file);
            break;
        case 'initialize':
            output = initializeUpstreamFile(options.active, options.slot);
            break;
        case 'prepare':
            output = prepareGatewayFiles({ slot: options.slot, activeFile: options.active, gatewayConfig: options.config });
            break;
        case 'install':
            output = installPreparedUpstream({ activeFile: options.active, preparedFile: options.prepared, backupFile: options.backup });
            break;
        case 'restore':
            output = restoreUpstream({ activeFile: options.active, backupFile: options.backup });
            break;
        case 'write-evidence': {
            const chunks = [];
            for await (const chunk of process.stdin)
            {
                chunks.push(chunk);
            }
            const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            writeEvidenceAtomic(options.output, evidence);
            output = { status: 'ok', output: path.resolve(options.output) };
            break;
        }
        default:
            throw new Error('usage: gateway-control.mjs <render|inspect|initialize|prepare|install|restore|write-evidence> [options]');
    }
    console.log(JSON.stringify(output));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href)
{
    main().catch(error =>
    {
        console.error(`[gateway-control] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
