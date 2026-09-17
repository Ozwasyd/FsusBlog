#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const toolFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(toolFile), '..', '..');
const defaultPolicy = 'tests/governance/operations-layout.json';

function text(value)
{
    return typeof value === 'string' ? value.trim() : '';
}

function array(value)
{
    return Array.isArray(value) ? value : [];
}

function object(value)
{
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readJson(file, label, errors)
{
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        errors.push(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
        return {};
    }
}

function trackedFiles(root, errors)
{
    const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'buffer'
    });
    if (result.status !== 0)
    {
        errors.push(`cannot enumerate repository files: ${String(result.stderr ?? result.stdout ?? '').trim()}`);
        return [];
    }
    return result.stdout.toString('utf8').split('\0').filter(Boolean)
        .map((file) => file.replaceAll(path.sep, '/'))
        .filter((file) => fs.existsSync(path.join(root, file)));
}

function isInside(relative, root)
{
    return relative === root || relative.startsWith(`${root}/`);
}

function isTextFile(file)
{
    try
    {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 1024 * 1024)
        {
            return false;
        }
        return !fs.readFileSync(file).includes(0);
    }
    catch
    {
        return false;
    }
}

function validatePolicy(policy)
{
    const errors = [];
    if (policy?.schema !== 'fsusblog.operations-layout.v1')
    {
        errors.push('operations layout schema must be fsusblog.operations-layout.v1');
    }
    if (policy?.operationsRoot !== 'ops')
    {
        errors.push('operationsRoot must be ops');
    }

    const domains = array(policy?.allowedDomains).map(text);
    if (domains.length === 0 || domains.some((domain) => !/^[a-z][a-z0-9-]*$/u.test(domain)) || new Set(domains).size !== domains.length)
    {
        errors.push('allowedDomains must contain unique lower-kebab path segments');
    }
    for (const required of ['development', 'docker', 'gateway', 'privacy'])
    {
        if (!domains.includes(required))
        {
            errors.push(`allowedDomains must include ${required}`);
        }
    }

    const canonical = array(policy?.canonicalAssets).map(text);
    if (canonical.some((asset) => !asset || path.posix.isAbsolute(asset) || asset.includes('..')) || new Set(canonical).size !== canonical.length)
    {
        errors.push('canonicalAssets must contain unique repository-relative paths');
    }
    const requiredCanonical = [
        'ops/development/dependencies.compose.yml',
        'ops/docker/docker-compose.development-backend.yml',
        'ops/docker/docker-compose.production.yml',
        'ops/gateway/production-openresty.conf',
        'config/deployment/zero-downtime-resource-policy.json'
    ];
    for (const required of requiredCanonical)
    {
        if (!canonical.includes(required))
        {
            errors.push(`canonicalAssets must include ${required}`);
        }
    }

    const forbidden = array(policy?.forbiddenPaths).map(text);
    if (!forbidden.includes('deploy'))
    {
        errors.push('forbiddenPaths must reject the top-level deploy root');
    }

    const localProxy = object(policy?.historicalLocalProxy);
    if (localProxy.disposition !== 'removed-no-supported-caller')
    {
        errors.push('historicalLocalProxy disposition must be removed-no-supported-caller');
    }
    for (const field of ['compose', 'gateway'])
    {
        if (!text(localProxy[field]) || !forbidden.includes(localProxy[field]))
        {
            errors.push(`historicalLocalProxy ${field} must be a forbidden path`);
        }
    }

    for (const exception of array(policy?.relativeMountExceptions))
    {
        if (!text(exception?.compose) || !text(exception?.source).startsWith('../') || !text(exception?.purpose))
        {
            errors.push('relativeMountExceptions require compose, parent-relative source, and purpose');
        }
    }

    const ownership = object(policy?.ownership);
    for (const required of ['/ops/ @Ozwasyd', '/config/deployment/ @Ozwasyd'])
    {
        if (!array(ownership.codeowners).map(text).includes(required))
        {
            errors.push(`ownership.codeowners must include ${required}`);
        }
    }
    for (const required of ['ops/**', 'config/deployment/**', 'tools/deployment/**'])
    {
        if (!array(ownership.deploymentLabelGlobs).map(text).includes(required))
        {
            errors.push(`ownership.deploymentLabelGlobs must include ${required}`);
        }
    }
    return errors;
}

function validateRelativeComposeMounts(root, files, policy, errors)
{
    const exceptions = new Set(array(policy?.relativeMountExceptions).map((entry) => `${text(entry?.compose)}\0${text(entry?.source)}`));
    for (const compose of files.filter((file) => /compose/u.test(path.posix.basename(file)) && /\.ya?ml$/u.test(file)))
    {
        let source;
        try
        {
            source = fs.readFileSync(path.join(root, compose), 'utf8');
        }
        catch
        {
            continue;
        }
        for (const line of source.split(/\r?\n/u))
        {
            const match = /^\s*-\s*["']?(?<source>\.{1,2}\/[^:'"]*)\s*:/u.exec(line);
            const relativeSource = text(match?.groups?.source);
            if (!relativeSource)
            {
                continue;
            }
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(compose), relativeSource));
            if (isInside(resolved, policy.operationsRoot))
            {
                continue;
            }
            if (!exceptions.has(`${compose}\0${relativeSource}`))
            {
                errors.push(`Compose file crosses the operations root without an approved purpose: ${compose} mounts ${relativeSource}`);
            }
        }
    }
}

function validateStaleReferences(root, files, policy, policyFile, errors)
{
    const allowlist = new Set([
        policyFile,
        'tools/governance/check-operations-layout.mjs',
        'tests/tools/operations-layout.test.mjs',
        ...array(policy?.staleReferenceAllowlist).map(text)
    ]);
    const tokens = array(policy?.staleReferenceTokens).map(text).filter(Boolean);
    for (const file of files)
    {
        if (allowlist.has(file))
        {
            continue;
        }
        const absolute = path.join(root, file);
        if (!isTextFile(absolute))
        {
            continue;
        }
        const source = fs.readFileSync(absolute, 'utf8');
        for (const token of tokens)
        {
            if (source.includes(token))
            {
                errors.push(`stale operations path reference remains in ${file}: ${token}`);
            }
        }
    }
}

export function checkOperationsLayout({ root = defaultRoot, policyFile = defaultPolicy, files: suppliedFiles } = {})
{
    const errors = [];
    const absoluteRoot = path.resolve(root);
    const normalizedPolicyFile = path.isAbsolute(policyFile)
        ? path.relative(absoluteRoot, policyFile).replaceAll(path.sep, '/')
        : policyFile.replaceAll(path.sep, '/');
    const absolutePolicy = path.isAbsolute(policyFile) ? policyFile : path.join(absoluteRoot, policyFile);
    const policy = readJson(absolutePolicy, 'operations layout policy', errors);
    errors.push(...validatePolicy(policy));

    const files = (suppliedFiles ?? trackedFiles(absoluteRoot, errors)).map((file) => file.replaceAll(path.sep, '/'));
    const fileSet = new Set(files);

    for (const forbidden of array(policy?.forbiddenPaths).map(text).filter(Boolean))
    {
        if (fileSet.has(forbidden) || files.some((file) => isInside(file, forbidden)) || fs.existsSync(path.join(absoluteRoot, forbidden)))
        {
            errors.push(`forbidden operations path exists: ${forbidden}`);
        }
    }

    const allowedDomains = new Set(array(policy?.allowedDomains).map(text));
    for (const file of files.filter((candidate) => candidate.startsWith('ops/')))
    {
        const domain = file.split('/')[1];
        if (!allowedDomains.has(domain))
        {
            errors.push(`unowned operations domain: ops/${domain}`);
        }
        if (/\.(?:sh|mjs|cjs|js|ts|py|cs)$/u.test(file))
        {
            errors.push(`executable source must stay under tools/deployment or tools/operations, not ${file}`);
        }
    }

    for (const asset of array(policy?.canonicalAssets).map(text).filter(Boolean))
    {
        const absolute = path.join(absoluteRoot, asset);
        let stat;
        try
        {
            stat = fs.lstatSync(absolute);
        }
        catch
        {
            errors.push(`canonical operations asset is missing: ${asset}`);
            continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            errors.push(`canonical operations asset must be a regular non-symlink file: ${asset}`);
        }
    }

    for (const file of files)
    {
        const basename = path.posix.basename(file);
        if (/compose/u.test(basename) && /\.ya?ml$/u.test(file) && !file.startsWith('ops/'))
        {
            errors.push(`Compose definition must live under ops/: ${file}`);
        }
        if (/Dockerfile/u.test(basename) && !file.startsWith('ops/docker/'))
        {
            errors.push(`production Dockerfile must live under ops/docker/: ${file}`);
        }
        if (/(?:nginx|openresty|active-upstream)/u.test(basename) && /\.conf(?:\.(?:example|template))?$/u.test(basename) && !file.startsWith('ops/gateway/'))
        {
            errors.push(`gateway template must live under ops/gateway/: ${file}`);
        }
        if (basename === 'zero-downtime-resource-policy.json' && file !== 'config/deployment/zero-downtime-resource-policy.json')
        {
            errors.push(`deployment policy must live under config/deployment/: ${file}`);
        }
    }

    validateRelativeComposeMounts(absoluteRoot, files, policy, errors);
    validateStaleReferences(absoluteRoot, files, policy, normalizedPolicyFile, errors);

    const ownership = object(policy?.ownership);
    let codeowners = '';
    try
    {
        codeowners = fs.readFileSync(path.join(absoluteRoot, '.github/CODEOWNERS'), 'utf8');
    }
    catch
    {
        errors.push('operations ownership file is missing: .github/CODEOWNERS');
    }
    const codeownerLines = new Set(codeowners.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
    for (const token of array(ownership.codeowners).map(text).filter(Boolean))
    {
        if (!codeownerLines.has(token))
        {
            errors.push(`.github/CODEOWNERS does not cover operations asset pattern: ${token}`);
        }
    }

    let labeler = '';
    try
    {
        labeler = fs.readFileSync(path.join(absoluteRoot, '.github/labeler.yml'), 'utf8');
    }
    catch
    {
        errors.push('operations ownership file is missing: .github/labeler.yml');
    }
    const deploymentStart = labeler.indexOf('"area:deployment":');
    const deploymentTail = deploymentStart >= 0 ? labeler.slice(deploymentStart) : '';
    const nextLabel = deploymentTail.slice(1).search(/\n"[^"]+":\s*(?:\r?\n|$)/u);
    const deploymentBlock = nextLabel >= 0 ? deploymentTail.slice(0, nextLabel + 1) : deploymentTail;
    if (deploymentStart < 0)
    {
        errors.push('.github/labeler.yml is missing the area:deployment block');
    }
    for (const token of array(ownership.deploymentLabelGlobs).map(text).filter(Boolean))
    {
        if (!deploymentBlock.includes(token))
        {
            errors.push(`.github/labeler.yml does not cover operations asset pattern: ${token}`);
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        operationsAssetCount: files.filter((file) => file.startsWith('ops/')).length,
        operationsDomainCount: new Set(files.filter((file) => file.startsWith('ops/')).map((file) => file.split('/')[1])).size
    };
}

function parseArgs(args)
{
    const options = { root: defaultRoot, policyFile: defaultPolicy };
    for (let index = 0; index < args.length; index += 1)
    {
        const argument = args[index];
        if (argument === '--root')
        {
            options.root = args[++index];
        }
        else if (argument.startsWith('--root='))
        {
            options.root = argument.slice('--root='.length);
        }
        else if (argument === '--policy')
        {
            options.policyFile = args[++index];
        }
        else if (argument.startsWith('--policy='))
        {
            options.policyFile = argument.slice('--policy='.length);
        }
        else
        {
            throw new Error(`unknown option ${argument}`);
        }
    }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile)
{
    try
    {
        const result = checkOperationsLayout(parseArgs(process.argv.slice(2)));
        if (!result.ok)
        {
            for (const error of result.errors)
            {
                console.error(`[operations-layout] ${error}`);
            }
            process.exit(1);
        }
        console.log(`[operations-layout] ok domains=${result.operationsDomainCount} assets=${result.operationsAssetCount}`);
    }
    catch (error)
    {
        console.error(`[operations-layout] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
