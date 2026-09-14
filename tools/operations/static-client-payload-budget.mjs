#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const staticClientPayloadInventoryAlgorithm = 'sha256-path-nul-size-nul-content-sha256-lf-v1';
export const staticClientPayloadRoot = 'client-dist';
export const staticClientPayloadPathOrder = 'posix-relative-utf8-byte-ascending';
export const staticClientPayloadRecordFormat = 'path-utf8 NUL size-base10-ascii NUL content-sha256-lowerhex LF';
export const staticPayloadBudgetModeEnvironment = 'FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const defaultStaticClientPayloadBudgetPath = path.join(
    rootDir,
    'config',
    'performance',
    'static-client-payload-budget.v1.json'
);
export const defaultStaticClientPayloadBudgetSchemaPath = path.join(
    rootDir,
    'config',
    'schemas',
    'static-client-payload-budget.schema.json'
);

function assertExactKeys(value, expected, label)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    {
        throw new Error(`${label} fields must be exactly: ${wanted.join(', ')}`);
    }
}

export function loadStaticClientPayloadBudget(policyPath = defaultStaticClientPayloadBudgetPath)
{
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    assertExactKeys(policy, ['$schema', 'schema', 'budgetModel', 'baseline', 'maxTotalBytes'], 'static client payload policy');
    assertExactKeys(policy.baseline, [
        'fileCount',
        'totalBytes',
        'root',
        'pathOrder',
        'recordFormat',
        'inventoryAlgorithm',
        'inventorySha256'
    ], 'static client payload baseline');
    assertExactKeys(policy.maxTotalBytes, ['derivation'], 'static client payload maxTotalBytes');

    if (policy.$schema !== '../schemas/static-client-payload-budget.schema.json'
      || policy.schema !== 'fsusblog.static-client-payload-budget.v1'
      || policy.budgetModel !== 'audited-baseline-no-growth'
      || policy.maxTotalBytes.derivation !== 'baseline.totalBytes')
    {
        throw new Error('static client payload policy identity or derivation is invalid');
    }
    if (!Number.isSafeInteger(policy.baseline.fileCount) || policy.baseline.fileCount <= 0
      || !Number.isSafeInteger(policy.baseline.totalBytes) || policy.baseline.totalBytes <= 0)
    {
        throw new Error('static client payload baseline counts must be positive safe integers');
    }
    if (policy.baseline.root !== staticClientPayloadRoot
      || policy.baseline.pathOrder !== staticClientPayloadPathOrder
      || policy.baseline.recordFormat !== staticClientPayloadRecordFormat
      || policy.baseline.inventoryAlgorithm !== staticClientPayloadInventoryAlgorithm
      || !/^sha256:[0-9a-f]{64}$/u.test(policy.baseline.inventorySha256))
    {
        throw new Error('static client payload baseline inventory contract is invalid');
    }

    return {
        policyPath,
        schema: policy.schema,
        budgetModel: policy.budgetModel,
        maxTotalBytes: policy.baseline.totalBytes,
        maxFileCount: policy.baseline.fileCount,
        baseline: policy.baseline
    };
}

export function parsePositiveFiniteSafeBudget(rawValue, label, options = {})
{
    const multiplier = options.multiplier ?? 1;
    const source = rawValue === undefined ? options.defaultValue : rawValue;
    if (source === undefined || (typeof source === 'string' && source.trim().length === 0))
    {
        throw new Error(`${label} must be a non-empty positive finite safe value`);
    }
    const parsed = Number(source);
    const scaled = parsed * multiplier;
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || !Number.isSafeInteger(scaled) || scaled <= 0)
    {
        throw new Error(`${label} must be a positive finite safe integer`);
    }
    return scaled;
}

export function resolveStaticPayloadBudgetExecution(env, overrideEnvironmentNames)
{
    const rawMode = env[staticPayloadBudgetModeEnvironment];
    const mode = rawMode === undefined ? 'default' : String(rawMode).trim();
    if (!['default', 'diagnostic', 'authoritative'].includes(mode))
    {
        throw new Error(`${staticPayloadBudgetModeEnvironment} must be diagnostic or authoritative when set`);
    }
    const overrideKeys = overrideEnvironmentNames.filter((name) => env[name] !== undefined);
    if (overrideKeys.length > 0 && mode !== 'diagnostic')
    {
        throw new Error(`budget overrides require ${staticPayloadBudgetModeEnvironment}=diagnostic: ${overrideKeys.join(', ')}`);
    }
    return {
        mode,
        overrideApplied: overrideKeys.length > 0,
        overrideKeys,
        qualificationEligible: mode !== 'diagnostic'
    };
}

function sha256File(file)
{
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compareUtf8Bytes(left, right)
{
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function computeStaticClientPayloadInventory(clientDistRoot)
{
    const absoluteRoot = path.resolve(clientDistRoot);
    const rootStat = fs.lstatSync(absoluteRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    {
        throw new Error(`client dist root must be a real directory: ${absoluteRoot}`);
    }

    const files = [];
    const visit = (directory, segments) =>
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const entrySegments = [...segments, entry.name];
            const relativePath = entrySegments.join('/');
            const fullPath = path.join(directory, entry.name);
            if (entry.isSymbolicLink())
            {
                throw new Error(`client dist inventory rejects symbolic links: ${relativePath}`);
            }
            if (entry.isDirectory())
            {
                visit(fullPath, entrySegments);
                continue;
            }
            if (!entry.isFile())
            {
                throw new Error(`client dist inventory rejects non-regular entries: ${relativePath}`);
            }
            if (relativePath.includes('\0'))
            {
                throw new Error('client dist inventory paths cannot contain NUL');
            }
            const stat = fs.statSync(fullPath);
            files.push({
                path: relativePath,
                bytes: stat.size,
                contentSha256: sha256File(fullPath)
            });
        }
    };
    visit(absoluteRoot, []);
    files.sort((left, right) => compareUtf8Bytes(left.path, right.path));

    const aggregate = crypto.createHash('sha256');
    let totalBytes = 0;
    for (const file of files)
    {
        totalBytes += file.bytes;
        if (!Number.isSafeInteger(totalBytes))
        {
            throw new Error('client dist total bytes exceed the safe integer range');
        }
        aggregate.update(Buffer.from(file.path, 'utf8'));
        aggregate.update(Buffer.from([0]));
        aggregate.update(Buffer.from(String(file.bytes), 'ascii'));
        aggregate.update(Buffer.from([0]));
        aggregate.update(Buffer.from(file.contentSha256, 'ascii'));
        aggregate.update(Buffer.from('\n', 'ascii'));
    }

    return {
        fileCount: files.length,
        totalBytes,
        root: staticClientPayloadRoot,
        pathOrder: staticClientPayloadPathOrder,
        recordFormat: staticClientPayloadRecordFormat,
        inventoryAlgorithm: staticClientPayloadInventoryAlgorithm,
        inventorySha256: `sha256:${aggregate.digest('hex')}`
    };
}

export function staticClientPayloadInventoryErrors(inventory, baseline)
{
    const fields = [
        'fileCount',
        'totalBytes',
        'root',
        'pathOrder',
        'recordFormat',
        'inventoryAlgorithm',
        'inventorySha256'
    ];
    return fields
        .filter((field) => inventory[field] !== baseline[field])
        .map((field) => `${field} mismatch: actual=${inventory[field]} expected=${baseline[field]}`);
}

export function assertStaticClientPayloadInventory(inventory, baseline)
{
    const errors = staticClientPayloadInventoryErrors(inventory, baseline);
    if (errors.length > 0)
    {
        throw new Error(`static client payload inventory mismatch\n${errors.join('\n')}`);
    }
}

function invalidPolicyMutations(policy)
{
    const mutate = (change) =>
    {
        const candidate = structuredClone(policy);
        change(candidate);
        return candidate;
    };
    return [
        mutate((candidate) =>
        {
            candidate.unexpected = true;
        }),
        mutate((candidate) =>
        {
            delete candidate.baseline;
        }),
        mutate((candidate) =>
        {
            candidate.baseline.fileCount = 0;
        }),
        mutate((candidate) =>
        {
            candidate.baseline.totalBytes = 0;
        }),
        mutate((candidate) =>
        {
            candidate.baseline.root = 'publish-root';
        }),
        mutate((candidate) =>
        {
            candidate.baseline.pathOrder = 'locale-order';
        }),
        mutate((candidate) =>
        {
            candidate.baseline.recordFormat = 'json';
        }),
        mutate((candidate) =>
        {
            candidate.baseline.inventorySha256 = 'sha256:invalid';
        }),
        mutate((candidate) =>
        {
            candidate.maxTotalBytes.derivation = 'manual';
        })
    ];
}

export async function validateStaticClientPayloadBudgetConfig(options = {})
{
    const policyPath = path.resolve(options.policyPath ?? defaultStaticClientPayloadBudgetPath);
    const schemaPath = path.resolve(options.schemaPath ?? defaultStaticClientPayloadBudgetSchemaPath);
    const [{ validateJsonSchema }, policy, schema] = await Promise.all([
        import(new URL('../test-matrix/schema-validator/validate.mjs', import.meta.url)),
        Promise.resolve(JSON.parse(fs.readFileSync(policyPath, 'utf8'))),
        Promise.resolve(JSON.parse(fs.readFileSync(schemaPath, 'utf8')))
    ]);
    const errors = validateJsonSchema(policy, schema);
    if (errors.length > 0)
    {
        throw new Error(`static client payload config violates its schema\n${errors.join('\n')}`);
    }
    for (const candidate of invalidPolicyMutations(policy))
    {
        if (validateJsonSchema(candidate, schema).length === 0)
        {
            throw new Error('static client payload schema accepted a required negative mutation');
        }
    }
    return loadStaticClientPayloadBudget(policyPath);
}

function parseArgs(argv)
{
    const options = { check: false, validateConfig: false };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--root')
        {
            options.root = argv[++index];
        }
        else if (arg === '--policy')
        {
            options.policyPath = argv[++index];
        }
        else if (arg === '--schema')
        {
            options.schemaPath = argv[++index];
        }
        else if (arg === '--check')
        {
            options.check = true;
        }
        else if (arg === '--validate-config')
        {
            options.validateConfig = true;
        }
        else if (arg === '--help')
        {
            options.help = true;
        }
        else
        {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
}

function usage()
{
    return 'usage: static-client-payload-budget.mjs --validate-config | --root <client-dist> [--check] [--policy <file>] [--schema <file>]';
}

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    if (options.help)
    {
        console.log(usage());
        return;
    }
    if (options.validateConfig)
    {
        if (options.root || options.check)
        {
            throw new Error('--validate-config cannot be combined with --root or --check');
        }
        const authority = await validateStaticClientPayloadBudgetConfig(options);
        console.log(`[static-client-payload-budget] config ok | files=${authority.maxFileCount} bytes=${authority.maxTotalBytes}`);
        return;
    }
    if (!options.root)
    {
        throw new Error(usage());
    }
    const inventory = computeStaticClientPayloadInventory(options.root);
    if (options.check)
    {
        const authority = await validateStaticClientPayloadBudgetConfig(options);
        assertStaticClientPayloadInventory(inventory, authority.baseline);
        console.log(`[static-client-payload-budget] inventory ok | files=${inventory.fileCount} bytes=${inventory.totalBytes} digest=${inventory.inventorySha256}`);
        return;
    }
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    main().catch((error) =>
    {
        console.error(`[static-client-payload-budget] blocked: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
