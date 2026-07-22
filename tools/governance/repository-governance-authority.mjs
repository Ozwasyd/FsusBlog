#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultManifest = 'config/governance/repository-governance-authorities.json';
const receiptSchema = 'fsusblog.repository-governance-receipt.v1';
const { snapshotGitWorktree } = await import(pathToFileURL(path.join(
    defaultRoot,
    'tools/test-matrix/scheduler.mjs'
)).href);

function stableValue(value)
{
    if (Array.isArray(value))
    {
        return value.map(stableValue);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function stableJson(value)
{
    return JSON.stringify(stableValue(value));
}

function digest(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function normalizeDeclaration(value)
{
    return String(value ?? '').trim().replace(/^\.\//u, '').replaceAll('\\', '/');
}

function wildcardPattern(value)
{
    const normalized = normalizeDeclaration(value);
    let source = '';
    for (let index = 0; index < normalized.length; index += 1)
    {
        const character = normalized[index];
        if (character === '*' && normalized[index + 1] === '*')
        {
            if (normalized[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
        }
        else if (character === '*')
        {
            source += '[^/]*';
        }
        else if (character === '?')
        {
            source += '[^/]';
        }
        else
        {
            source += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
        }
    }
    return new RegExp(`^${source}$`, 'u');
}

function repositoryFiles(root)
{
    const result = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'buffer'
    });
    if (result.status !== 0)
    {
        throw new Error(`cannot enumerate repository inputs: ${result.stderr.toString('utf8').trim()}`);
    }
    return result.stdout.toString('utf8').split('\0').filter(Boolean)
        .map(normalizeDeclaration).sort();
}

function validateSafeDeclaration(declaration)
{
    if (!declaration || path.isAbsolute(declaration) || declaration === '..' || declaration.startsWith('../'))
    {
        throw new Error(`unsafe governance input declaration: ${declaration || '<empty>'}`);
    }
}

export function resolveInputFiles(rootValue, declarations)
{
    const root = path.resolve(rootValue);
    const candidates = repositoryFiles(root);
    const resolved = new Set();
    for (const rawDeclaration of declarations ?? [])
    {
        const declaration = normalizeDeclaration(rawDeclaration);
        validateSafeDeclaration(declaration);
        const absolute = path.join(root, declaration);
        const hasWildcard = /[?*]/u.test(declaration);
        const matches = hasWildcard
            ? candidates.filter((candidate) => wildcardPattern(declaration).test(candidate))
            : fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
        ? candidates.filter((candidate) => candidate.startsWith(`${declaration}/`))
        : candidates.filter((candidate) => candidate === declaration);
        if (matches.length === 0)
        {
            throw new Error(`governance input declaration matched no files: ${declaration}`);
        }
        for (const match of matches)
        {
            resolved.add(match);
        }
    }
    return [...resolved].sort();
}

function fileIdentity(root, relativePath)
{
    const absolute = path.join(root, relativePath);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink())
    {
        return { path: relativePath, mode: stat.mode, kind: 'symlink', digest: digest(fs.readlinkSync(absolute)) };
    }
    if (!stat.isFile())
    {
        throw new Error(`governance input is not a regular file: ${relativePath}`);
    }
    return { path: relativePath, mode: stat.mode, kind: 'file', digest: digest(fs.readFileSync(absolute)) };
}

function treeIdentity(root, declarations)
{
    const files = resolveInputFiles(root, declarations).map((file) => fileIdentity(root, file));
    return { files, digest: digest(stableJson(files)) };
}

function gitHead(root)
{
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(result.stdout.trim()))
    {
        throw new Error('repository governance requires a full Git source commit');
    }
    return result.stdout.trim();
}

function runtimeVersion(command, args)
{
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`cannot resolve governance toolchain ${command}`);
    }
    return `${command}:${result.stdout.trim() || result.stderr.trim()}`;
}

function toolchainIdentity(root, authority)
{
    const runtimeVersions = (authority.toolchain?.runtimes ?? []).map((runtime) =>
    {
        if (runtime === 'node')
        {
            return `node:${process.version}`;
        }
        if (runtime === 'bash')
        {
            return runtimeVersion('bash', ['--version']).split('\n')[0];
        }
        if (runtime === 'git')
        {
            return runtimeVersion('git', ['--version']);
        }
        throw new Error(`unsupported governance runtime identity: ${runtime}`);
    }).sort();
    const parserVersions = [...(authority.toolchain?.parsers ?? [])].sort();
    const sourceTree = treeIdentity(root, authority.toolchain?.identityFiles ?? []);
    const value = { runtimeVersions, parserVersions, sourceTree };
    return { ...value, digest: digest(stableJson(value)) };
}

export function validateAuthorityManifest(manifest)
{
    const errors = [];
    if (manifest?.schema !== 'fsusblog.repository-governance-authorities.v1')
    {
        errors.push('unsupported authority manifest schema');
    }
    const required = new Set([
        'application-static-governance',
        'test-asset-governance',
        'workflow-lint',
        'document-governance',
        'community-governance'
    ]);
    const authorities = Array.isArray(manifest?.authorities) ? manifest.authorities : [];
    const authorityIds = new Set();
    const commandIds = new Set();
    const checkerOwners = new Map();
    const ruleOwners = new Map();
    for (const authority of authorities)
    {
        if (!required.delete(authority?.id))
        {
            errors.push(`unexpected or duplicate authority: ${authority?.id ?? '<missing>'}`);
        }
        authorityIds.add(authority?.id);
        if (typeof authority?.canonicalOwner !== 'string' || !authority.canonicalOwner.trim())
        {
            errors.push(`${authority?.id ?? '<missing>'} canonicalOwner is required`);
        }
        if (!Array.isArray(authority?.inputs) || authority.inputs.length === 0)
        {
            errors.push(`${authority?.id} inputs are required`);
        }
        if (!Array.isArray(authority?.commands) || authority.commands.length === 0)
        {
            errors.push(`${authority?.id} commands are required`);
        }
        if (!Array.isArray(authority?.toolchain?.identityFiles) || authority.toolchain.identityFiles.length === 0)
        {
            errors.push(`${authority?.id} toolchain identityFiles are required`);
        }
        for (const command of authority?.commands ?? [])
        {
            if (!command?.id || commandIds.has(command.id))
            {
                errors.push(`duplicate or missing governance command id: ${command?.id ?? '<missing>'}`);
            }
            commandIds.add(command?.id);
            if (!Array.isArray(command?.argv) || command.argv.length === 0)
            {
                errors.push(`${command?.id} argv is required`);
            }
            if (!Array.isArray(command?.checkerSources) || command.checkerSources.length === 0)
            {
                errors.push(`${command?.id} checkerSources are required`);
            }
            if (!Array.isArray(command?.ruleIds) || command.ruleIds.length === 0)
            {
                errors.push(`${command?.id} ruleIds are required`);
            }
            for (const checker of command?.checkerSources ?? [])
            {
                const normalized = normalizeDeclaration(checker);
                if (checkerOwners.has(normalized))
                {
                    errors.push(`${normalized} checker is owned by both ${checkerOwners.get(normalized)} and ${authority.id}`);
                }
                checkerOwners.set(normalized, authority.id);
            }
            for (const ruleId of command?.ruleIds ?? [])
            {
                if (ruleOwners.has(ruleId))
                {
                    errors.push(`${ruleId} rule/test ID is owned by both ${ruleOwners.get(ruleId)} and ${authority.id}`);
                }
                ruleOwners.set(ruleId, authority.id);
            }
        }
    }
    if (required.size > 0)
    {
        errors.push(`missing governance authorities: ${[...required].join(', ')}`);
    }
    return errors;
}

export function loadAuthorityManifest(root = defaultRoot, manifestFile = defaultManifest)
{
    const manifest = JSON.parse(fs.readFileSync(path.resolve(root, manifestFile), 'utf8'));
    const errors = validateAuthorityManifest(manifest);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    return manifest;
}

function resolveAuthority(manifest, authorityId)
{
    const authority = manifest.authorities.find((entry) => entry.id === authorityId);
    if (!authority)
    {
        throw new Error(`unknown repository governance authority: ${authorityId}`);
    }
    return authority;
}

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
    root = defaultRoot,
    manifest = loadAuthorityManifest(root),
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
    root = defaultRoot,
    manifest = loadAuthorityManifest(root),
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

function readReceipt(root, authorityId, receiptFile)
{
    const file = receiptFile ? path.resolve(root, receiptFile) : currentReceiptPath(root, authorityId);
    return { file, receipt: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function parseArguments(argv)
{
    const [action, authorityId, ...rest] = argv;
    const options = { action, authorityId };
    for (let index = 0; index < rest.length; index += 1)
    {
        if (rest[index] === '--receipt')
        {
            options.receiptFile = rest[++index];
        }
        else if (rest[index] === '--manifest')
        {
            options.manifestFile = rest[++index];
        }
        else
        {
            throw new Error(`unknown repository governance option: ${rest[index]}`);
        }
    }
    return options;
}

export async function main(argv = process.argv.slice(2), { root = defaultRoot } = {})
{
    const options = parseArguments(argv);
    const manifest = loadAuthorityManifest(root, options.manifestFile ?? defaultManifest);
    if (options.action === 'validate-manifest')
    {
        console.log(`[repository-governance] manifest ok authorities=${manifest.authorities.length}`);
        return;
    }
    if (!options.authorityId)
    {
        throw new Error('repository governance authority id is required');
    }
    if (options.action === 'run')
    {
        const receipt = await createGovernanceReceipt({ root, manifest, authorityId: options.authorityId });
        console.log(`[repository-governance] produced authority=${options.authorityId} receipt=${path.relative(root, receipt.file)} digest=${receipt.contentDigest}`);
        return;
    }
    if (options.action === 'verify' || options.action === 'ensure')
    {
        try
        {
            const { file, receipt } = readReceipt(root, options.authorityId, options.receiptFile);
            const result = await verifyGovernanceReceipt({ root, manifest, authorityId: options.authorityId, receipt });
            if (!result.valid)
            {
                throw new Error(result.errors.join('; '));
            }
            console.log(`[repository-governance] verified authority=${options.authorityId} receipt=${path.relative(root, file)} digest=${receipt.contentDigest}`);
            return;
        }
        catch (error)
        {
            if (options.action !== 'ensure')
            {
                throw error;
            }
            console.log(`[repository-governance] current receipt unavailable authority=${options.authorityId}; executing exact-input checker`);
            const receipt = await createGovernanceReceipt({ root, manifest, authorityId: options.authorityId });
            console.log(`[repository-governance] produced authority=${options.authorityId} receipt=${path.relative(root, receipt.file)} digest=${receipt.contentDigest}`);
            return;
        }
    }
    throw new Error('usage: repository-governance-authority.mjs validate-manifest | run|verify|ensure <authority> [--receipt file]');
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    main().catch((error) =>
    {
        console.error(`[repository-governance] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
