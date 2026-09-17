import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const safeNodeBuiltins = new Set([
    'node:fs',
    'node:path',
    'node:process',
    'node:url'
]);
const producerCapabilityPattern =
    /(?:node:child_process|child_process|spawnSync|spawn\s*\(|execFile|execSync|run-test-matrix|dotnet\s+(?:build|test)|vitest|playwright)/u;
const dynamicOrCommonJsPattern = /(?:\bimport\s*\(|\brequire\s*\()/u;
const moduleRequestParser = [
    "import vm from 'node:vm';",
    "let source = '';",
    "for await (const chunk of process.stdin) source += chunk;",
    "const module = new vm.SourceTextModule(source, { identifier: 'receipt-command-source' });",
    'process.stdout.write(JSON.stringify(module.moduleRequests.map(({ specifier }) => specifier)));'
].join('\n');
const dataScalePermissions = Object.freeze({
    fsRead: Object.freeze([
        '.tmp/scale/*',
        '.tmp/downloaded-artifacts/*',
        '.tmp/release-evidence/*'
    ]),
    fsWrite: Object.freeze([
        '.tmp/release-evidence/*'
    ]),
    childProcess: false,
    worker: false
});
const dataScaleEvidenceArgv = Object.freeze([
    'node',
    '--permission',
    ...dataScalePermissions.fsRead.map((entry) => `--allow-fs-read=${entry}`),
    ...dataScalePermissions.fsWrite.map((entry) => `--allow-fs-write=${entry}`),
    'tools/test/aggregate-data-scale-evidence.mjs'
]);

function shellArgument(value)
{
    if (!/[\s*?[\\\]'"]/u.test(value))
    {
        return value;
    }
    if (value.includes("'"))
    {
        throw new Error(`canonical receipt argument cannot be shell-quoted safely: ${value}`);
    }
    return `'${value}'`;
}

function shellCommand(argv)
{
    return argv.map(shellArgument).join(' ');
}

export const canonicalReceiptCommandSources = Object.freeze({
    'data-scale-evidence-summary': Object.freeze({
        id: 'data-scale-evidence-summary',
        commandKind: 'receipt',
        semanticKind: 'structured-receipt-aggregate',
        command: shellCommand(dataScaleEvidenceArgv),
        argv: dataScaleEvidenceArgv,
        permissions: dataScalePermissions,
        source: 'tools/test/aggregate-data-scale-evidence.mjs',
        producerSpawnPolicy: 'forbidden'
    })
});

function isWithin(parent, candidate)
{
    const relative = path.relative(parent, candidate);
    return relative === ''
        || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parseStaticModuleRequests(source, importer)
{
    const parsed = spawnSync(process.execPath, [
        '--experimental-vm-modules',
        '--input-type=module',
        '--eval',
        moduleRequestParser
    ], {
        input: source,
        encoding: 'utf8',
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });
    if (parsed.status !== 0)
    {
        const detail = parsed.stderr.trim() || `parser exited with ${parsed.status}`;
        throw new Error(`${importer} static import parser failed: ${detail}`);
    }
    return [...new Set(JSON.parse(parsed.stdout))].sort();
}

function resolveRelativeImport(root, importer, specifier)
{
    const target = path.resolve(path.dirname(importer), specifier);
    if (!isWithin(root, target))
    {
        throw new Error(`${path.relative(root, importer)} import escapes root: ${specifier}`);
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile())
    {
        throw new Error(`${path.relative(root, importer)} import cannot be resolved: ${specifier}`);
    }
    const realTarget = fs.realpathSync(target);
    if (!isWithin(root, realTarget))
    {
        throw new Error(`${path.relative(root, importer)} import resolves outside root: ${specifier}`);
    }
    return realTarget;
}

function scanModuleClosure(root, entry)
{
    const errors = [];
    const pending = [entry];
    const visited = new Set();
    while (pending.length > 0)
    {
        const file = pending.pop();
        if (visited.has(file))
        {
            continue;
        }
        visited.add(file);
        const relative = path.relative(root, file).replaceAll(path.sep, '/');
        const source = fs.readFileSync(file, 'utf8');
        if (producerCapabilityPattern.test(source))
        {
            errors.push(`${relative} contains a producer-spawn capability`);
        }
        if (dynamicOrCommonJsPattern.test(source))
        {
            errors.push(`${relative} contains dynamic import or require`);
        }
        let specifiers;
        try
        {
            specifiers = parseStaticModuleRequests(source, relative);
        }
        catch (error)
        {
            errors.push(error instanceof Error ? error.message : String(error));
            continue;
        }
        for (const specifier of specifiers)
        {
            if (safeNodeBuiltins.has(specifier))
            {
                continue;
            }
            if (!specifier.startsWith('./') && !specifier.startsWith('../'))
            {
                errors.push(`${relative} imports forbidden builtin or bare package: ${specifier}`);
                continue;
            }
            try
            {
                pending.push(resolveRelativeImport(root, file, specifier));
            }
            catch (error)
            {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
    }
    return {
        files: [...visited].map((file) => path.relative(root, file).replaceAll(path.sep, '/')).sort(),
        errors
    };
}

function validatePermissionBoundary(sourceId, contract)
{
    const errors = [];
    const permissions = contract.permissions;
    if (!permissions || permissions.childProcess !== false || permissions.worker !== false)
    {
        errors.push(`${sourceId} must deny child-process and worker permissions`);
    }
    const expectedArguments = [
        'node',
        '--permission',
        ...(permissions?.fsRead ?? []).map((entry) => `--allow-fs-read=${entry}`),
        ...(permissions?.fsWrite ?? []).map((entry) => `--allow-fs-write=${entry}`),
        contract.source
    ];
    if (!Array.isArray(contract.argv)
        || JSON.stringify(contract.argv) !== JSON.stringify(expectedArguments))
    {
        errors.push(`${sourceId} argv must exactly encode its declared permission boundary`);
    }
    if (contract.command !== shellCommand(expectedArguments))
    {
        errors.push(`${sourceId} command must exactly encode its canonical permission argv`);
    }
    const allowFlags = (contract.argv ?? []).filter((argument) => argument.startsWith('--allow-'));
    const expectedAllowFlags = [
        ...(permissions?.fsRead ?? []).map((entry) => `--allow-fs-read=${entry}`),
        ...(permissions?.fsWrite ?? []).map((entry) => `--allow-fs-write=${entry}`)
    ];
    if (JSON.stringify(allowFlags) !== JSON.stringify(expectedAllowFlags)
        || allowFlags.some((argument) =>
            argument.startsWith('--allow-child-process')
            || argument.startsWith('--allow-worker')))
    {
        errors.push(`${sourceId} may grant only its exact filesystem read/write permissions`);
    }
    for (const entry of [...(permissions?.fsRead ?? []), ...(permissions?.fsWrite ?? [])])
    {
        if (typeof entry !== 'string'
            || !entry.startsWith('.tmp/')
            || !entry.endsWith('/*')
            || entry.includes('..')
            || path.isAbsolute(entry))
        {
            errors.push(`${sourceId} permission path must be an exact repository .tmp subtree wildcard: ${entry}`);
        }
    }
    return errors;
}

export function validateCanonicalReceiptCommandSource(sourceId, options = {})
{
    const errors = [];
    const contract = canonicalReceiptCommandSources[sourceId];
    if (!contract)
    {
        return { contract: null, files: [], errors: [`unknown canonical receipt command source: ${sourceId}`] };
    }
    if (contract.commandKind !== 'receipt' || contract.producerSpawnPolicy !== 'forbidden')
    {
        errors.push(`${sourceId} must declare commandKind=receipt and producerSpawnPolicy=forbidden`);
    }
    errors.push(...validatePermissionBoundary(sourceId, contract));
    const root = path.resolve(options.root ?? repositoryRoot);
    const sourcePath = path.resolve(root, contract.source);
    if (!isWithin(root, sourcePath))
    {
        errors.push(`${sourceId} canonical receipt source escapes root: ${contract.source}`);
        return { contract, files: [], errors };
    }
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())
    {
        errors.push(`${sourceId} canonical receipt source is missing: ${contract.source}`);
        return { contract, files: [], errors };
    }
    const realSourcePath = fs.realpathSync(sourcePath);
    if (!isWithin(root, realSourcePath))
    {
        errors.push(`${sourceId} canonical receipt source resolves outside root: ${contract.source}`);
        return { contract, files: [], errors };
    }
    const closure = scanModuleClosure(root, realSourcePath);
    errors.push(...closure.errors.map((error) => `${sourceId}: ${error}`));
    return { contract, files: closure.files, errors };
}
