import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    digest,
    gitHead,
    stableJson,
    toolchainIdentity,
    treeIdentity
} from './repository-governance-identity.mjs';
import { defaultManifest, loadAuthorityManifest, resolveAuthority } from './repository-governance-manifest.mjs';

export const receiptSchema = 'fsusblog.repository-governance-receipt.v1';
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { snapshotGitWorktree } = await import(pathToFileURL(path.join(
    moduleRoot,
    'tools/test-matrix/scheduler.mjs'
)).href);

function checkerIdentity(root, authority)
{
    const checkerSources = authority.commands.flatMap((command) => command.checkerSources);
    return treeIdentity(root, checkerSources);
}

async function runCommand(root, command, environment)
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(command.argv[0], command.argv.slice(1), {
            cwd: root,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) =>
        {
            stdout.push(chunk);
            process.stdout.write(chunk);
        });
        child.stderr.on('data', (chunk) =>
        {
            stderr.push(chunk);
            process.stderr.write(chunk);
        });
        child.on('error', reject);
        child.on('close', (exitCode, signal) => resolve({
            id: command.id,
            argv: command.argv,
            ruleIds: [...command.ruleIds].sort(),
            exitCode,
            signal,
            stdoutDigest: digest(Buffer.concat(stdout)),
            stderrDigest: digest(Buffer.concat(stderr))
        }));
    });
}

function contentAddressedReceiptPath(root, authorityId, contentDigest)
{
    return path.join(root, '.cache/repository-governance', authorityId, `${contentDigest.slice('sha256:'.length)}.json`);
}

function currentReceiptPath(root, authorityId)
{
    return path.join(root, '.cache/repository-governance', authorityId, 'current.json');
}

function receiptContent(receipt)
{
    const content = structuredClone(receipt);
    delete content.contentDigest;
    delete content.file;
    return content;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

export async function createGovernanceReceipt({
    root = moduleRoot,
    manifest = loadAuthorityManifest(root, defaultManifest),
    authorityId,
    env = process.env,
    executeCommand = runCommand,
    write = true
})
{
    const authority = resolveAuthority(manifest, authorityId);
    const beforeWorktree = await snapshotGitWorktree(root);
    const sourceState = { commit: gitHead(root), worktreeFingerprint: beforeWorktree.fingerprint };
    const inputs = treeIdentity(root, authority.inputs);
    const checkers = checkerIdentity(root, authority);
    const toolchain = toolchainIdentity(root, authority);
    const outputs = [];
    for (const command of authority.commands)
    {
        const output = await executeCommand(root, command, env);
        outputs.push(output);
        if (output.exitCode !== 0 || output.signal)
        {
            throw new Error(`governance command ${command.id} failed with ${output.signal ?? output.exitCode}`);
        }
    }
    const afterWorktree = await snapshotGitWorktree(root);
    if (afterWorktree.fingerprint !== beforeWorktree.fingerprint)
    {
        throw new Error(`${authorityId} changed repository inputs while producing its receipt`);
    }
    const outputContentDigest = digest(stableJson(outputs));
    const receipt = {
        schema: receiptSchema,
        authorityId,
        canonicalOwner: authority.canonicalOwner,
        status: 'success',
        sourceState,
        inputs,
        checkers,
        toolchain,
        ruleIds: [...new Set(authority.commands.flatMap((command) => command.ruleIds))].sort(),
        outputs,
        outputContentDigest
    };
    receipt.contentDigest = digest(stableJson(receiptContent(receipt)));
    if (write)
    {
        const addressed = contentAddressedReceiptPath(root, authorityId, receipt.contentDigest);
        writeJsonAtomic(addressed, receipt);
        writeJsonAtomic(currentReceiptPath(root, authorityId), receipt);
        receipt.file = addressed;
    }
    return receipt;
}

export async function verifyGovernanceReceipt({
    root = moduleRoot,
    manifest = loadAuthorityManifest(root, defaultManifest),
    authorityId,
    receipt,
    requireCurrentSource = true
})
{
    const authority = resolveAuthority(manifest, authorityId);
    const errors = [];
    if (receipt?.schema !== receiptSchema)
    {
        errors.push('receipt schema mismatch');
    }
    if (receipt?.authorityId !== authorityId)
    {
        errors.push('receipt authority mismatch');
    }
    if (receipt?.canonicalOwner !== authority.canonicalOwner)
    {
        errors.push('receipt canonical owner mismatch');
    }
    if (receipt?.status !== 'success')
    {
        errors.push('receipt status must be success');
    }
    const expectedInputs = treeIdentity(root, authority.inputs);
    const expectedCheckers = checkerIdentity(root, authority);
    const expectedToolchain = toolchainIdentity(root, authority);
    if (receipt?.inputs?.digest !== expectedInputs.digest)
    {
        errors.push('input tree digest mismatch');
    }
    if (receipt?.checkers?.digest !== expectedCheckers.digest)
    {
        errors.push('checker source digest mismatch');
    }
    if (receipt?.toolchain?.digest !== expectedToolchain.digest)
    {
        errors.push('parser/toolchain identity mismatch');
    }
    const expectedRuleIds = [...new Set(authority.commands.flatMap((command) => command.ruleIds))].sort();
    if (stableJson(receipt?.ruleIds) !== stableJson(expectedRuleIds))
    {
        errors.push('rule/test IDs mismatch');
    }
    if (receipt?.outputContentDigest !== digest(stableJson(receipt?.outputs)))
    {
        errors.push('output content digest mismatch');
    }
    if (receipt?.contentDigest !== digest(stableJson(receiptContent(receipt))))
    {
        errors.push('receipt content digest mismatch');
    }
    if (requireCurrentSource)
    {
        const snapshot = await snapshotGitWorktree(root);
        if (receipt?.sourceState?.commit !== gitHead(root))
        {
            errors.push('source commit mismatch');
        }
        if (receipt?.sourceState?.worktreeFingerprint !== snapshot.fingerprint)
        {
            errors.push('source worktree fingerprint mismatch');
        }
    }
    return { valid: errors.length === 0, errors };
}

export function readReceipt(root, authorityId, receiptFile)
{
    const file = receiptFile ? path.resolve(root, receiptFile) : currentReceiptPath(root, authorityId);
    return { file, receipt: JSON.parse(fs.readFileSync(file, 'utf8')) };
}
