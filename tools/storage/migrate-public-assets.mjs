#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'fsusblog.public-assets-migration.v1';
const INVALID_TEMP_NAMES = new Set(['.incoming', '.upload-sessions']);

export class PublicAssetMigrationError extends Error
{
    constructor(code, message)
    {
        super(message);
        this.name = 'PublicAssetMigrationError';
        this.code = code;
    }
}

export function inventoryTree(root)
{
    const normalizedRoot = path.resolve(root);
    const entries = [];
    walk(normalizedRoot, '');
    return entries.sort((left, right) => left.path.localeCompare(right.path));

    function walk(directory, relativeDirectory)
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            if (INVALID_TEMP_NAMES.has(entry.name))
            {
                continue;
            }
            const relativePath = path.posix.join(relativeDirectory, entry.name);
            const absolutePath = path.join(directory, entry.name);
            if (entry.isSymbolicLink())
            {
                throw new PublicAssetMigrationError('symlink_rejected', `symbolic links are not migration inputs: ${relativePath}`);
            }
            if (entry.isDirectory())
            {
                walk(absolutePath, relativePath);
            }
            else if (entry.isFile())
            {
                const bytes = fs.readFileSync(absolutePath);
                entries.push(Object.freeze({
                    path: relativePath,
                    length: bytes.length,
                    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
                }));
            }
        }
    }
}

export function migratePublicAssets(options)
{
    const source = path.resolve(required(options.source, 'source'));
    const publicRoot = path.resolve(required(options.publicRoot, 'publicRoot'));
    const target = path.join(publicRoot, 'illustration');
    if (options.confirmStopWrites !== true)
    {
        throw new PublicAssetMigrationError(
            'stop_writes_confirmation_required',
            'migration requires an explicit stopped-writes confirmation'
        );
    }
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory())
    {
        throw new PublicAssetMigrationError('source_missing', `legacy source directory does not exist: ${source}`);
    }
    if (fs.lstatSync(source).isSymbolicLink() || fs.realpathSync(source) !== source)
    {
        throw new PublicAssetMigrationError('symlink_rejected', 'legacy source root cannot be a symbolic link');
    }

    const sourceInventory = inventoryTree(source);
    fs.mkdirSync(publicRoot, { recursive: true });
    if (fs.lstatSync(publicRoot).isSymbolicLink() || fs.realpathSync(publicRoot) !== publicRoot)
    {
        throw new PublicAssetMigrationError('symlink_rejected', 'public asset root cannot be a symbolic link');
    }

    const lockPath = path.join(publicRoot, '.public-assets-migration.lock');
    let lockDescriptor;
    try
    {
        lockDescriptor = fs.openSync(lockPath, 'wx', 0o600);
    }
    catch (error)
    {
        if (error?.code === 'EEXIST')
        {
            throw new PublicAssetMigrationError(
                'migration_in_progress',
                'another public-asset migration owns the target root'
            );
        }
        throw error;
    }

    try
    {
        if (fs.existsSync(target))
        {
            if (!fs.statSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink())
            {
                throw new PublicAssetMigrationError('target_conflict', 'migration target is not a regular directory');
            }
            const targetInventory = inventoryTree(target);
            ensureSameInventory(sourceInventory, targetInventory, 'target_conflict');
            cleanupInvalidTemporaryState(source, options.legacySessionRoot);
            return report('already-complete', source, target, sourceInventory);
        }

        const staging = fs.mkdtempSync(path.join(publicRoot, '.illustration-migration-'));
        try
        {
            copyTree(source, staging);
            options.afterCopy?.(staging);
            const stagedInventory = inventoryTree(staging);
            ensureSameInventory(sourceInventory, stagedInventory, 'hash_mismatch');
            if (fs.existsSync(target))
            {
                throw new PublicAssetMigrationError('target_conflict', 'migration target appeared before atomic install');
            }
            fs.renameSync(staging, target);
            fsyncDirectory(publicRoot);
            const installedInventory = inventoryTree(target);
            ensureSameInventory(sourceInventory, installedInventory, 'hash_mismatch');
            cleanupInvalidTemporaryState(source, options.legacySessionRoot);
            return report('migrated', source, target, installedInventory);
        }
        catch (error)
        {
            fs.rmSync(staging, { recursive: true, force: true });
            throw error;
        }
    }
    finally
    {
        fs.closeSync(lockDescriptor);
        fs.rmSync(lockPath, { force: true });
    }
}

function copyTree(source, destination)
{
    for (const entry of fs.readdirSync(source, { withFileTypes: true }))
    {
        if (INVALID_TEMP_NAMES.has(entry.name))
        {
            continue;
        }
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isSymbolicLink())
        {
            throw new PublicAssetMigrationError(
                'symlink_rejected',
                `symbolic links are not migration inputs: ${sourcePath}`
            );
        }
        if (entry.isDirectory())
        {
            fs.mkdirSync(destinationPath);
            copyTree(sourcePath, destinationPath);
        }
        else if (entry.isFile())
        {
            fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
            const descriptor = fs.openSync(destinationPath, 'r');
            try
            {
                fs.fsyncSync(descriptor);
            }
            finally
            {
                fs.closeSync(descriptor);
            }
        }
    }
    fsyncDirectory(destination);
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

function ensureSameInventory(expected, actual, code)
{
    if (expected.length !== actual.length)
    {
        throw new PublicAssetMigrationError(
            code,
            `inventory count mismatch: expected ${expected.length}, got ${actual.length}`
        );
    }
    for (let index = 0; index < expected.length; index += 1)
    {
        const left = expected[index];
        const right = actual[index];
        if (left.path !== right.path || left.length !== right.length || left.sha256 !== right.sha256)
        {
            throw new PublicAssetMigrationError(code, `inventory mismatch at ${left.path}`);
        }
    }
}

function cleanupInvalidTemporaryState(source, configuredLegacySessionRoot)
{
    for (const name of INVALID_TEMP_NAMES)
    {
        fs.rmSync(path.join(source, name), { recursive: true, force: true });
    }
    const legacySessionRoot = configuredLegacySessionRoot
        ? path.resolve(configuredLegacySessionRoot)
        : path.resolve(source, '..', '..', '..', '.upload-sessions');
    fs.rmSync(legacySessionRoot, { recursive: true, force: true });
}

function report(status, source, target, inventory)
{
    return Object.freeze({
        schema: SCHEMA,
        status,
        source,
        target,
        count: inventory.length,
        totalBytes: inventory.reduce((sum, entry) => sum + entry.length, 0),
        files: inventory
    });
}

function required(value, name)
{
    if (typeof value !== 'string' || value.trim().length === 0)
    {
        throw new PublicAssetMigrationError('argument_invalid', `${name} is required`);
    }
    return value;
}

function parseArguments(argv)
{
    const options = { confirmStopWrites: false };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--confirm-stop-writes')
        {
            options.confirmStopWrites = true;
            continue;
        }
        if (!['--source', '--public-root', '--legacy-session-root'].includes(argument) || index + 1 >= argv.length)
        {
            throw new PublicAssetMigrationError(
                'argument_invalid',
                `unknown or incomplete argument: ${argument}`
            );
        }
        const value = argv[index += 1];
        if (argument === '--source')
        {
            options.source = value;
        }
        if (argument === '--public-root')
        {
            options.publicRoot = value;
        }
        if (argument === '--legacy-session-root')
        {
            options.legacySessionRoot = value;
        }
    }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        console.log(JSON.stringify(migratePublicAssets(parseArguments(process.argv.slice(2))), null, 2));
    }
    catch (error)
    {
        const code = error instanceof PublicAssetMigrationError ? error.code : 'migration_failed';
        console.error(JSON.stringify({ schema: SCHEMA, status: 'failed', code, error: error.message }));
        process.exitCode = 1;
    }
}
