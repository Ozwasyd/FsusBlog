import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);

function option(name, fallback = null)
{
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
}

const root = path.resolve(option('--root', defaultRoot));
const catalogPath = path.resolve(
    option('--catalog', path.join(root, 'config/testing/authoring-extension-terminal-matrix.json')));
const evidencePath = option('--evidence');
const receiptPath = option('--write-receipt');
const errors = [];

function digestBytes(bytes)
{
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readFile(relativePath, label = relativePath)
{
    const absolutePath = path.resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`))
    {
        errors.push(`${label} escapes the repository root`);
        return null;
    }
    try
    {
        return fs.readFileSync(absolutePath);
    }
    catch
    {
        errors.push(`${label} is missing`);
        return null;
    }
}

function readJson(absolutePath, label)
{
    try
    {
        return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    }
    catch (error)
    {
        errors.push(`${label} is unreadable: ${error.message}`);
        return null;
    }
}

function compareExact(label, actual, expected)
{
    if (JSON.stringify(actual) !== JSON.stringify(expected))
    {
        errors.push(`${label} drifted: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    }
}

function enumMembers(source, symbol)
{
    const match = source.match(new RegExp(`public\\s+enum\\s+${symbol}\\s*\\{([\\s\\S]*?)\\}`));
    if (!match)
    {
        errors.push(`${symbol} enum declaration is missing`);
        return [];
    }
    return match[1]
        .split(',')
        .map((entry) => entry.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*(?:=|$)/)?.[1])
        .filter(Boolean);
}

function recordFields(source, symbol)
{
    const match = source.match(new RegExp(`public\\s+sealed\\s+record\\s+${symbol}\\s*\\(([\\s\\S]*?)\\);`));
    if (!match)
    {
        errors.push(`${symbol} record declaration is missing`);
        return [];
    }
    return match[1]
        .split(',')
        .map((entry) => entry.trim().match(/([A-Za-z][A-Za-z0-9_]*)$/)?.[1])
        .filter(Boolean);
}

function verifyFixture(reference, label)
{
    if (typeof reference !== 'string' || reference.split('#').length !== 2)
    {
        errors.push(`${label} must be one exact path#symbol reference`);
        return;
    }
    const [relativePath, symbol] = reference.split('#');
    const bytes = readFile(relativePath, label);
    if (bytes && !new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(bytes.toString('utf8')))
    {
        errors.push(`${label} symbol ${symbol} is missing from ${relativePath}`);
    }
}

const catalog = readJson(catalogPath, 'authoring extension terminal matrix');
if (!catalog)
{
    process.exitCode = 1;
}
else
{
    compareExact(
        'catalog fields',
        Object.keys(catalog).sort(),
        ['canonicalCommand', 'registries', 'requiredSuites', 'schema', 'terminalEvidence'].sort());
    if (catalog.schema !== 'fsusblog.authoring-extension-terminal-matrix.v1')
    {
        errors.push('catalog schema is not fsusblog.authoring-extension-terminal-matrix.v1');
    }
    if (catalog.canonicalCommand !== 'node tools/security/check-authoring-extension-terminal-matrix.mjs')
    {
        errors.push('canonical command drifted');
    }

    const registryIds = new Set();
    for (const [index, registry] of (catalog.registries ?? []).entries())
    {
        const label = `registries[${index}]`;
        compareExact(
            `${label} fields`,
            Object.keys(registry).sort(),
            ['expected', 'id', 'kind', 'negativeFixture', 'ownerFixture', 'positiveFixture', 'source', 'symbol'].sort());
        if (!registry.id || registryIds.has(registry.id))
        {
            errors.push(`${label} id is missing or duplicate`);
        }
        registryIds.add(registry.id);
        if (!Array.isArray(registry.expected) || registry.expected.length === 0 ||
            new Set(registry.expected).size !== registry.expected.length)
        {
            errors.push(`${label} expected registry must be non-empty and unique`);
        }

        const source = readFile(registry.source, `${label}.source`)?.toString('utf8');
        if (source)
        {
            const actual = registry.kind === 'enum'
                ? enumMembers(source, registry.symbol)
                : registry.kind === 'record'
                    ? recordFields(source, registry.symbol)
                    : [];
            if (registry.kind !== 'enum' && registry.kind !== 'record')
            {
                errors.push(`${label}.kind is not closed`);
            }
            compareExact(`${registry.id} members`, actual, registry.expected);
        }
        verifyFixture(registry.positiveFixture, `${label}.positiveFixture`);
        verifyFixture(registry.negativeFixture, `${label}.negativeFixture`);
        verifyFixture(registry.ownerFixture, `${label}.ownerFixture`);
    }

    const requiredSuites = catalog.requiredSuites ?? [];
    if (new Set(requiredSuites).size !== requiredSuites.length)
    {
        errors.push('requiredSuites contains duplicates');
    }
    for (const suite of requiredSuites)
    {
        readFile(suite, `required suite ${suite}`);
    }

    const terminalIds = new Set();
    const blockers = [];
    for (const [index, requirement] of (catalog.terminalEvidence ?? []).entries())
    {
        compareExact(
            `terminalEvidence[${index}] fields`,
            Object.keys(requirement).sort(),
            ['id', 'state']);
        if (!requirement.id || terminalIds.has(requirement.id))
        {
            errors.push(`terminalEvidence[${index}] id is missing or duplicate`);
        }
        terminalIds.add(requirement.id);
        if (requirement.state !== 'source-ready')
        {
            blockers.push(`${requirement.id}:${requirement.state}`);
        }
    }

    let receipt = null;
    if (evidencePath || receiptPath)
    {
        if (!evidencePath)
        {
            errors.push('--write-receipt requires --evidence');
        }
        else
        {
            const evidence = readJson(path.resolve(evidencePath), 'terminal evidence');
            if (evidence)
            {
                compareExact(
                    'terminal evidence fields',
                    Object.keys(evidence).sort(),
                    ['artifacts', 'schema']);
                if (evidence.schema !== 'fsusblog.authoring-extension-terminal-evidence.v1')
                {
                    errors.push('terminal evidence schema is invalid');
                }
                const artifacts = new Map();
                for (const artifact of evidence.artifacts ?? [])
                {
                    if (!artifact.id || artifacts.has(artifact.id))
                    {
                        errors.push('terminal evidence artifact id is missing or duplicate');
                        continue;
                    }
                    compareExact(
                        `terminal artifact ${artifact.id} fields`,
                        Object.keys(artifact).sort(),
                        ['id', 'path', 'sha256', 'status']);
                    artifacts.set(artifact.id, artifact);
                }

                const artifactDigests = {};
                for (const id of terminalIds)
                {
                    const artifact = artifacts.get(id);
                    if (!artifact || artifact.status !== 'passed' ||
                        typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256))
                    {
                        errors.push(`terminal evidence ${id} is not one passing digest-bound artifact`);
                        continue;
                    }
                    const bytes = readFile(artifact.path, `terminal evidence ${id}`);
                    if (bytes && digestBytes(bytes) !== artifact.sha256)
                    {
                        errors.push(`terminal evidence ${id} digest mismatched`);
                    }
                    artifactDigests[id] = artifact.sha256;
                }
                for (const id of artifacts.keys())
                {
                    if (!terminalIds.has(id))
                    {
                        errors.push(`terminal evidence contains unknown artifact ${id}`);
                    }
                }

                if (errors.length === 0)
                {
                    const sourcePaths = [...new Set([
                        path.relative(root, catalogPath),
                        'tools/security/check-authoring-extension-terminal-matrix.mjs',
                        ...catalog.registries.map((entry) => entry.source),
                        ...requiredSuites
                    ])].sort();
                    const sourceDigests = Object.fromEntries(sourcePaths.map((sourcePath) => [
                        sourcePath,
                        digestBytes(readFile(sourcePath, `receipt source ${sourcePath}`))
                    ]));
                    receipt = {
                        schema: 'fsusblog.authoring-extension-terminal-receipt.v1',
                        status: 'terminal-accepted',
                        canonicalCommand: catalog.canonicalCommand,
                        sourceDigests,
                        registryDigest: digestBytes(Buffer.from(JSON.stringify(catalog.registries))),
                        artifactDigests,
                        warnings: []
                    };
                    receipt.receiptDigest = digestBytes(Buffer.from(JSON.stringify(receipt)));
                }
            }
        }
    }

    if (errors.length === 0 && receiptPath && receipt)
    {
        fs.mkdirSync(path.dirname(path.resolve(receiptPath)), { recursive: true });
        fs.writeFileSync(path.resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
    }

    if (errors.length === 0)
    {
        console.log(
            `[authoring-extension-terminal-matrix] audit registries=${registryIds.size} suites=${requiredSuites.length} blockers=${blockers.length}`);
        for (const blocker of blockers)
        {
            console.log(`[authoring-extension-terminal-matrix] blocker ${blocker}`);
        }
        if (receipt)
        {
            console.log(`[authoring-extension-terminal-matrix] terminal receipt=${receipt.receiptDigest}`);
        }
    }
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[authoring-extension-terminal-matrix] ${error}`);
    }
    process.exitCode = 1;
}
