#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './release-assets.mjs';
import { executeReleaseAssetGc, normalizeGcState, RELEASE_GC_EVIDENCE_SCHEMA } from './release-gc.mjs';
const {readRolloutState} = await import(new URL('../deployment/release-rollout-lib.mjs', import.meta.url));
const {readSlotState} = await import(new URL('../deployment/slot-lib.mjs', import.meta.url));
const {readDestructiveOperationAuthority, verifyArtifactGcActiveIdentity} = await import(new URL('../deployment/destructive-operation-authority.mjs', import.meta.url));
let options = {};
try
{
    options = parseArgs(process.argv.slice(2));
    if (options.apply === true && options.locked === true
      && (!process.env.FSUSBLOG_GC_LOCK_TOKEN || options['lock-token'] !== process.env.FSUSBLOG_GC_LOCK_TOKEN))
    {
        throw new Error('internal GC lock handoff is invalid');
    }
    if (options.apply === true && options.locked !== true && !hasInheritedDeploymentLock(options))
    {
        const deploymentLock = path.resolve(options['deployment-lock']
      ?? process.env.FSUSBLOG_DEPLOYMENT_LOCK_FILE
      ?? '/var/lock/fsusblog-deployment.lock');
        fs.mkdirSync(path.dirname(deploymentLock), { recursive: true, mode: 0o700 });
        const token = crypto.randomUUID();
        const child = spawnSync('flock', [
            '--nonblock', deploymentLock, process.execPath, fileURLToPath(import.meta.url),
            ...process.argv.slice(2), '--locked', '--lock-token', token
        ], { stdio: 'inherit', env: { ...process.env, FSUSBLOG_GC_LOCK_TOKEN: token } });
        if (child.error)
        {
            throw child.error;
        }
        process.exit(child.status ?? 1);
    }
    const storeDirectory = path.resolve(options.store ?? process.env.FSUSBLOG_RELEASE_ASSET_STORE ?? '/var/lib/fsusblog/release-assets');
    const stateFile = path.resolve(options.state ?? process.env.FSUSBLOG_RELEASE_RETENTION_STATE ?? path.join(storeDirectory, 'retention-state.json'));
    const state = normalizeGcState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    const activeProtection = options.apply === true ? readActiveProtection(options, state) : null;
    const evidence = executeReleaseAssetGc({
        storeDirectory,
        state,
        apply: options.apply === true,
        evidenceFile: options.out ? path.resolve(options.out) : null,
        lockFile: options.lock ? path.resolve(options.lock) : null,
        activeProtection,
        refreshProtection: options.apply === true ? () => readActiveProtection(options, state) : null
    });
    process.stdout.write(`${JSON.stringify({ ...evidence, retentionState: stateFile })}\n`);
}
catch (error)
{
    const report = {
        schema: RELEASE_GC_EVIDENCE_SCHEMA,
        status: 'fail',
        dryRun: options.apply !== true,
        releaseActions: [],
        objectActions: [],
        errors: [error instanceof Error ? error.message : String(error)]
    };
    if (options.out)
    {
        try
        {
            writeJsonAtomic(path.resolve(options.out), report);
        }
        catch
        // eslint-disable-next-line no-empty
        {}
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
}

function parseArgs(argv)
{
    const parsed = {};
    for (let index = 0; index < argv.length; index += 1)
    {
        const name = argv[index];
        if (name === '--apply')
        {
            parsed.apply = true;
            continue;
        }
        if (name === '--dry-run')
        {
            parsed.apply = false;
            continue;
        }
        if (name === '--locked')
        {
            parsed.locked = true;
            continue;
        }
        if (!name?.startsWith('--'))
        {
            throw new Error(`invalid argument: ${name ?? '<end>'}`);
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--'))
        {
            throw new Error(`missing value for ${name}`);
        }
        parsed[name.slice(2)] = value;
        index += 1;
    }
    return parsed;
}

function readActiveProtection(parsed, expectedRetentionState)
{
    const slotStateFile = requiredPath(parsed, 'slot-state');
    const rolloutStateFile = requiredPath(parsed, 'rollout-state');
    const stateFile = requiredPath(parsed, 'state');
    const currentRetentionState = normalizeGcState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    if (JSON.stringify(currentRetentionState) !== JSON.stringify(expectedRetentionState))
    {
        throw new Error('durable retention state changed after GC planning');
    }
    return verifyArtifactGcActiveIdentity({
        authority: readDestructiveOperationAuthority(parsed.authority),
        slotState: readSlotState(slotStateFile, { allowMissing: false }),
        rolloutState: readRolloutState(rolloutStateFile),
        retentionState: currentRetentionState
    });
}

function requiredPath(parsed, name)
{
    if (!parsed[name])
    {
        throw new Error(`GC apply requires --${name}`);
    }
    return path.resolve(parsed[name]);
}

function hasInheritedDeploymentLock(parsed)
{
    const descriptor = process.env.FSUSBLOG_DEPLOYMENT_LOCK_FD;
    if (!/^[0-9]+$/u.test(descriptor ?? ''))
    {
        return false;
    }
    const deploymentLock = path.resolve(parsed['deployment-lock']
    ?? process.env.FSUSBLOG_DEPLOYMENT_LOCK_FILE
    ?? '/var/lock/fsusblog-deployment.lock');
    try
    {
        return fs.realpathSync(`/proc/self/fd/${descriptor}`) === fs.realpathSync(deploymentLock);
    }
    catch
    {
        throw new Error('inherited deployment lock descriptor is invalid');
    }
}
