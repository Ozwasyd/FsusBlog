#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(toolFile), '../..');
const { parseYamlDocument } = await import(pathToFileURL(path.join(defaultRoot, 'tools/yaml/parse-document.mjs')).href);
const defaultPolicy = 'tests/governance/monolithic-distributed-architecture.json';

function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function digestCanonical(value)
{
    return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function digestText(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys, label, errors)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        errors.push(`${label} must be an object`);
        return false;
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
    {
        errors.push(`${label} fields must be exactly ${expected.join(', ')}`);
        return false;
    }
    return true;
}

function normalize(value)
{
    return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}

function array(value)
{
    return Array.isArray(value) ? value : [];
}

function object(value)
{
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isInside(candidate, root)
{
    const file = normalize(candidate);
    const boundary = normalize(root);
    return file === boundary || file.startsWith(`${boundary}/`);
}

function read(root, relative, errors)
{
    try
    {
        return fs.readFileSync(path.join(root, normalize(relative)), 'utf8');
    }
    catch (error)
    {
        errors.push(`cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}`);
        return '';
    }
}

function trackedFiles(root, errors)
{
    const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0)
    {
        errors.push(`cannot enumerate tracked files: ${(result.stderr || result.stdout || 'git ls-files failed').trim()}`);
        return [];
    }
    return result.stdout.split('\0').map(normalize).filter(Boolean).sort();
}

function validatePolicy(policy)
{
    const errors = [];
    exactKeys(policy, [
        'blueGreenMounts', 'composeServices', 'contentDigest', 'documentation', 'domainForbiddenPatterns',
        'domainRoots', 'mainApplication', 'remoteInvocation', 'runtimeModes', 'runtimeRoleOwnership',
        'schema', 'singleModeGuard'
    ], 'architecture policy', errors);
    if (policy?.schema !== 'fsusblog.monolithic-distributed-architecture.v2')
    {
        errors.push('architecture policy schema must be fsusblog.monolithic-distributed-architecture.v2');
    }
    const { contentDigest, ...unsignedPolicy } = object(policy);
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(contentDigest ?? ''))
        || digestCanonical(unsignedPolicy) !== contentDigest)
    {
        errors.push('architecture policy contentDigest does not match canonical content');
    }
    exactKeys(policy?.mainApplication, [
        'composeService', 'dockerfile', 'frontendIntegrationTokens', 'productionEntrypoint',
        'productionTarget', 'project'
    ], 'mainApplication', errors);
    if (policy?.mainApplication?.productionTarget !== 'final'
        || JSON.stringify(policy?.mainApplication?.productionEntrypoint) !== JSON.stringify(['./FsusBlog.Server']))
    {
        errors.push('mainApplication production process must be final -> ./FsusBlog.Server');
    }
    for (const field of ['project', 'dockerfile', 'composeService'])
    {
        if (!String(policy?.mainApplication?.[field] ?? '').trim())
        {
            errors.push(`mainApplication.${field} is required`);
        }
    }
    if (JSON.stringify(policy?.runtimeModes) !== JSON.stringify(['single', 'static-role', 'adaptive']))
    {
        errors.push('runtimeModes must be exactly single, static-role, adaptive');
    }
    const ownership = object(policy?.runtimeRoleOwnership);
    exactKeys(ownership, [
        'authorityState', 'coResidency', 'container', 'process', 'separation', 'service',
        'supportedModes', 'unsupportedDeployments'
    ], 'runtimeRoleOwnership', errors);
    if (ownership.process !== 'one-fsusblog-server-process-per-application-container'
        || ownership.container !== 'one-application-container-per-release-slot'
        || ownership.coResidency !== 'selected-runtime-roles-share-process-container-and-service'
        || ownership.separation !== 'blue-green-release-slots-not-runtime-role-services'
        || ownership.authorityState !== 'closed-current'
        || ownership.service !== policy?.mainApplication?.composeService
        || JSON.stringify(ownership.supportedModes) !== JSON.stringify(policy?.runtimeModes)
        || JSON.stringify(ownership.unsupportedDeployments) !== JSON.stringify([
            'fixed-role-business-sidecar',
            'multiple-application-services-per-slot',
            'per-role-container-split',
            'per-role-process-split'
        ]))
    {
        errors.push('runtimeRoleOwnership must close the current application service and unsupported split deployments');
    }
    const mounts = object(policy?.blueGreenMounts);
    if (Object.keys(mounts).length === 0)
    {
        errors.push('blueGreenMounts must classify the complete production application mount set');
    }
    const mountIdentities = new Map();
    for (const [target, mount] of Object.entries(mounts))
    {
        exactKeys(mount, ['access', 'protection', 'scope', 'source', 'volumeName'], `blueGreenMounts.${target}`, errors);
        if (!target.startsWith('/') || typeof mount.source !== 'string' || mount.source.length === 0
            || !['read-only', 'read-write'].includes(mount.access)
            || !['operator-shared', 'release-artifact-store', 'release-identity', 'shared-between-slots', 'slot-private'].includes(mount.scope)
            || !['exact-active-release-gc-authority', 'identity-bound-read-only', 'outside-release-cleanup', 'retained-with-slot'].includes(mount.protection)
            || !(mount.volumeName === null || typeof mount.volumeName === 'string'))
        {
            errors.push(`blueGreenMounts.${target} contains an invalid closed classification`);
        }
        if (mount.scope === 'slot-private'
            && (typeof mount.volumeName !== 'string'
                || !mount.volumeName.includes('${FSUSBLOG_SLOT_')))
        {
            errors.push(`blueGreenMounts.${target} slot-private identity must be slot-specific`);
        }
        if (mount.scope !== 'slot-private'
            && (String(mount.source).includes('${FSUSBLOG_SLOT_')
                || String(mount.volumeName ?? '').includes('${FSUSBLOG_SLOT_')))
        {
            errors.push(`blueGreenMounts.${target} non-slot-private identity must not be slot-specific`);
        }
        for (const [kind, identity] of [['source', mount.source], ['volumeName', mount.volumeName]])
        {
            if (typeof identity !== 'string' || identity.length === 0) continue;
            const key = `${kind}\0${identity}`;
            const prior = mountIdentities.get(key) ?? [];
            if (prior.some((entry) => entry.scope !== mount.scope
                && (entry.scope === 'slot-private' || mount.scope === 'slot-private')))
            {
                errors.push(`blueGreenMounts.${target} ${kind} identity crosses slot-private and shared scope`);
            }
            prior.push({ target, scope: mount.scope });
            mountIdentities.set(key, prior);
        }
    }
    const composeServices = object(policy?.composeServices);
    if (Object.keys(composeServices).length === 0)
    {
        errors.push('composeServices must classify every Compose file');
    }
    for (const [file, services] of Object.entries(composeServices))
    {
        if (!/\.ya?ml$/u.test(file) || !file.includes('compose'))
        {
            errors.push(`invalid Compose policy path: ${file}`);
        }
        for (const [service, kind] of Object.entries(object(services)))
        {
            if (!service || !['application', 'gateway', 'infrastructure'].includes(kind))
            {
                errors.push(`invalid Compose service classification: ${file}#${service}`);
            }
        }
    }
    if (array(policy?.domainRoots).length === 0 || array(policy?.domainForbiddenPatterns).length === 0)
    {
        errors.push('domain roots and forbidden patterns are required');
    }
    if (array(policy?.remoteInvocation?.allowedRoots).length === 0 || array(policy?.remoteInvocation?.patterns).length === 0)
    {
        errors.push('remote invocation patterns and allowed roots are required');
    }
    if (array(policy?.documentation?.linkedFrom).length < 2 || array(policy?.documentation?.requiredPhrases).length === 0)
    {
        errors.push('documentation must have two link owners and required phrases');
    }
    return errors;
}

function parseDockerfileStages(source)
{
    const logicalLines = [];
    let current = '';
    for (const raw of String(source).split(/\r?\n/u))
    {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#'))
        {
            continue;
        }
        current = current ? `${current} ${trimmed}` : trimmed;
        if (current.endsWith('\\'))
        {
            current = current.slice(0, -1).trimEnd();
            continue;
        }
        logicalLines.push(current);
        current = '';
    }
    if (current)
    {
        logicalLines.push(current);
    }
    const stages = new Map();
    let stage = null;
    for (const line of logicalLines)
    {
        const from = /^FROM\s+\S+(?:\s+AS\s+(?<name>[A-Za-z0-9_.-]+))?$/iu.exec(line);
        if (from)
        {
            stage = { entrypoints: [] };
            stages.set(from.groups?.name ?? `unnamed-${stages.size}`, stage);
            continue;
        }
        const entrypoint = /^ENTRYPOINT\s+(?<value>.+)$/iu.exec(line);
        if (entrypoint && stage)
        {
            try
            {
                const value = JSON.parse(entrypoint.groups.value);
                if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
                {
                    throw new Error('must be a non-empty JSON string array');
                }
                stage.entrypoints.push(value);
            }
            catch (error)
            {
                stage.entrypoints.push({ error: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    return stages;
}

function parseComposeMount(value)
{
    let text = String(value);
    let access = 'read-write';
    if (text.endsWith(':ro'))
    {
        access = 'read-only';
        text = text.slice(0, -3);
    }
    else if (text.endsWith(':rw'))
    {
        text = text.slice(0, -3);
    }
    const separator = text.lastIndexOf(':');
    if (separator <= 0 || !text.slice(separator + 1).startsWith('/'))
    {
        throw new Error(`unsupported production Compose mount syntax: ${value}`);
    }
    return { source: text.slice(0, separator), target: text.slice(separator + 1), access };
}

export function observeRuntimeRoleDeploymentAuthority({ root = defaultRoot, policyFile = defaultPolicy } = {})
{
    const errors = [];
    const repositoryRoot = path.resolve(root);
    let policy = {};
    const policyPath = path.isAbsolute(policyFile) ? policyFile : path.join(repositoryRoot, policyFile);
    try
    {
        policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    }
    catch (error)
    {
        errors.push(`architecture policy is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    errors.push(...validatePolicy(policy));

    const sourcePaths = {
        policy: normalize(path.relative(repositoryRoot, policyPath)),
        project: normalize(policy?.mainApplication?.project),
        dockerfile: normalize(policy?.mainApplication?.dockerfile),
        productionCompose: 'ops/docker/docker-compose.production.yml'
    };
    const sources = {};
    for (const [id, relative] of Object.entries(sourcePaths))
    {
        sources[id] = { path: relative, text: read(repositoryRoot, relative, errors) };
    }

    const stages = parseDockerfileStages(sources.dockerfile.text);
    const productionStage = stages.get(policy?.mainApplication?.productionTarget);
    if (!productionStage || productionStage.entrypoints.length !== 1
        || JSON.stringify(productionStage.entrypoints[0]) !== JSON.stringify(policy?.mainApplication?.productionEntrypoint))
    {
        errors.push('production Docker target must expose exactly the authority-owned application process entrypoint');
    }

    let compose = {};
    try
    {
        compose = parseYamlDocument(sources.productionCompose.text, { source: sourcePaths.productionCompose });
    }
    catch (error)
    {
        errors.push(`cannot parse production Compose topology: ${error instanceof Error ? error.message : String(error)}`);
    }
    const classified = object(policy?.composeServices?.[sourcePaths.productionCompose]);
    const applicationServices = Object.entries(classified).filter(([, kind]) => kind === 'application').map(([id]) => id);
    const expectedService = policy?.mainApplication?.composeService;
    if (applicationServices.length !== 1 || applicationServices[0] !== expectedService
        || Object.keys(object(compose.services)).filter((id) => classified[id] === 'application').length !== 1)
    {
        errors.push('production topology must contain exactly one authority-owned application service');
    }
    const service = object(compose.services?.[expectedService]);
    if (service.container_name !== '${FSUSBLOG_CONTAINER_NAME:?Set slot-specific container name (fsus-app-blue or fsus-app-green)}'
        || service.labels?.['io.fsusblog.deployment.project'] !== '${FSUSBLOG_COMPOSE_PROJECT_NAME:?Set slot-specific Compose project}'
        || JSON.stringify(array(service.ports)) !== JSON.stringify([
            '127.0.0.1:${FSUSBLOG_SLOT_PORT:?Set blue=8081 or green=8082}:8080'
        ]))
    {
        errors.push('production application service is missing exact container/project/loopback slot separation');
    }

    const observedMounts = {};
    for (const value of array(service.volumes))
    {
        try
        {
            const mount = parseComposeMount(value);
            if (Object.hasOwn(observedMounts, mount.target))
            {
                errors.push(`duplicate production application mount target: ${mount.target}`);
            }
            observedMounts[mount.target] = mount;
        }
        catch (error)
        {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    const declaredMounts = object(policy?.blueGreenMounts);
    if (JSON.stringify(Object.keys(observedMounts).sort()) !== JSON.stringify(Object.keys(declaredMounts).sort()))
    {
        errors.push('production application mount inventory does not exactly match blueGreenMounts authority');
    }
    for (const [target, declaration] of Object.entries(declaredMounts))
    {
        const observed = observedMounts[target];
        if (!observed || observed.source !== declaration.source || observed.access !== declaration.access)
        {
            errors.push(`production application mount ${target} conflicts with blueGreenMounts authority`);
            continue;
        }
        const topLevelVolume = object(compose.volumes)[declaration.source];
        const actualVolumeName = topLevelVolume && typeof topLevelVolume === 'object' ? topLevelVolume.name ?? null : null;
        if (actualVolumeName !== declaration.volumeName)
        {
            errors.push(`production application mount ${target} volume identity conflicts with blueGreenMounts authority`);
        }
    }

    const ownership = object(policy?.runtimeRoleOwnership);
    const unsigned = {
        schema: 'fsusblog.runtime-role-deployment-observation.v1',
        authoritySchema: policy?.schema ?? null,
        authorityContentDigest: policy?.contentDigest ?? null,
        sourceDigests: Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, {
            path: source.path,
            digest: digestText(source.text)
        }])),
        application: {
            project: policy?.mainApplication?.project ?? null,
            dockerTarget: policy?.mainApplication?.productionTarget ?? null,
            processEntrypoint: policy?.mainApplication?.productionEntrypoint ?? [],
            composeService: expectedService ?? null,
            applicationServiceCount: applicationServices.length
        },
        ownership: {
            process: ownership.process ?? null,
            container: ownership.container ?? null,
            service: ownership.service ?? null,
            coResidency: ownership.coResidency ?? null,
            separation: ownership.separation ?? null,
            authorityState: errors.length === 0 ? ownership.authorityState : 'conflict-unknown',
            claimEligible: errors.length === 0,
            failureReasons: [...new Set(errors)].sort()
        },
        volumeTopology: Object.fromEntries(Object.entries(declaredMounts).sort(([left], [right]) => left.localeCompare(right)).map(
            ([target, declaration]) => [target, { ...declaration }]))
    };
    return { ...unsigned, observationDigest: digestCanonical(unsigned) };
}

function validateProjectTopology(root, files, policy, errors)
{
    const projects = files.filter((file) => file.startsWith('src/') && file.endsWith('.csproj'));
    const entrypoints = projects.filter((file) =>
    {
        const source = read(root, file, errors);
        return /<Project\s+Sdk="Microsoft\.NET\.Sdk\.Web"/u.test(source)
      || /<OutputType>\s*(?:Exe|WinExe)\s*<\/OutputType>/u.test(source);
    });
    const expected = normalize(policy.mainApplication.project);
    if (entrypoints.length !== 1 || entrypoints[0] !== expected)
    {
        errors.push(`product source must expose exactly one business entrypoint (${expected}); found ${entrypoints.join(', ') || 'none'}`);
    }
    const mainProject = read(root, expected, errors);
    for (const token of array(policy.mainApplication.frontendIntegrationTokens))
    {
        if (!mainProject.includes(token))
        {
            errors.push(`main application must publish frontend assets through the same artifact: missing ${token}`);
        }
    }

    const dockerfiles = files.filter((file) => file.startsWith('ops/docker/') && /Dockerfile$/u.test(file));
    const expectedDockerfile = normalize(policy.mainApplication.dockerfile);
    if (dockerfiles.length !== 1 || dockerfiles[0] !== expectedDockerfile)
    {
        errors.push(`production topology must expose exactly one application Dockerfile (${expectedDockerfile}); found ${dockerfiles.join(', ') || 'none'}`);
    }
}

function validateComposeTopology(root, files, policy, errors)
{
    const composeFiles = files.filter((file) => file.startsWith('ops/') && /compose/u.test(path.posix.basename(file)) && /\.ya?ml$/u.test(file));
    const declared = object(policy.composeServices);
    for (const file of composeFiles)
    {
        if (!Object.hasOwn(declared, file))
        {
            errors.push(`Compose file has no architecture classification: ${file}`);
        }
    }
    for (const file of Object.keys(declared))
    {
        if (!composeFiles.includes(file))
        {
            errors.push(`classified Compose file is missing: ${file}`);
        }
        let document = {};
        try
        {
            document = parseYamlDocument(read(root, file, errors), { source: file });
        }
        catch (error)
        {
            errors.push(`cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const actualServices = Object.keys(object(document.services)).sort();
        const expectedServices = Object.keys(object(declared[file])).sort();
        if (JSON.stringify(actualServices) !== JSON.stringify(expectedServices))
        {
            errors.push(`Compose services drifted in ${file}: expected ${expectedServices.join(', ')}, found ${actualServices.join(', ')}`);
        }
        for (const [service, kind] of Object.entries(object(declared[file])))
        {
            if (kind === 'application' && service !== policy.mainApplication.composeService)
            {
                errors.push(`fixed business sidecar is forbidden: ${file}#${service}`);
            }
        }
    }
}

function validateSourceBoundaries(root, files, policy, errors)
{
    const csharp = files.filter((file) => file.startsWith('src/') && file.endsWith('.cs'));
    const domainFiles = csharp.filter((file) => array(policy.domainRoots).some((domainRoot) => isInside(file, domainRoot)));
    for (const file of domainFiles)
    {
        const source = read(root, file, errors);
        for (const rule of array(policy.domainForbiddenPatterns))
        {
            try
            {
                if (new RegExp(rule.pattern, 'u').test(source))
                {
                    errors.push(`domain source ${file} depends on ${rule.label}`);
                }
            }
            catch
            {
                errors.push(`invalid domain pattern for ${rule.label}`);
            }
        }
    }

    const allowedRoots = array(policy.remoteInvocation.allowedRoots);
    for (const file of csharp)
    {
        const source = read(root, file, errors);
        for (const pattern of array(policy.remoteInvocation.patterns))
        {
            let matches = false;
            try
            {
                matches = new RegExp(pattern, 'u').test(source);
            }
            catch
            {
                errors.push(`invalid remote invocation pattern: ${pattern}`);
            }
            if (matches && !allowedRoots.some((allowedRoot) => isInside(file, allowedRoot)))
            {
                errors.push(`remote invocation must stay behind a port or adapter boundary: ${file}`);
            }
        }
    }
}

function validateSingleMode(root, policy, errors)
{
    const guard = object(policy.singleModeGuard);
    const runtime = read(root, guard.runtimeOptions, errors);
    for (const token of array(guard.runtimeRequiredTokens))
    {
        if (!runtime.includes(token))
        {
            errors.push(`single mode runtime guard is missing: ${token}`);
        }
    }
    const bootstrap = read(root, guard.bootstrap, errors);
    let cursor = -1;
    for (const token of array(guard.bootstrapOrderedTokens))
    {
        const index = bootstrap.indexOf(token);
        if (index < 0 || index <= cursor)
        {
            errors.push(`single mode local fast path ordering is missing or reversed: ${token}`);
        }
        cursor = index;
    }
}

function validateDocumentation(root, files, policy, errors)
{
    const docs = object(policy.documentation);
    const boundary = read(root, docs.boundary, errors);
    for (const phrase of [...array(docs.requiredPhrases), ...array(docs.requiredIssueTitles)])
    {
        if (!boundary.includes(phrase))
        {
            errors.push(`monolithic distributed boundary is missing wording: ${phrase}`);
        }
    }
    const linkToken = path.posix.basename(docs.boundary);
    for (const owner of array(docs.linkedFrom))
    {
        if (!read(root, owner, errors).includes(linkToken))
        {
            errors.push(`${owner} must link the monolithic distributed boundary`);
        }
    }
    for (const file of files.filter((candidate) => candidate.startsWith('docs/') && candidate.endsWith('.md')))
    {
        const source = read(root, file, errors);
        for (const assertion of array(docs.forbiddenAssertions))
        {
            if (source.includes(assertion))
            {
                errors.push(`fixed-service architecture assertion is forbidden in ${file}: ${assertion}`);
            }
        }
    }
}

export function checkMonolithicDistributedArchitecture({ root = defaultRoot, policyFile = defaultPolicy, files: suppliedFiles } = {})
{
    const errors = [];
    const absoluteRoot = path.resolve(root);
    let policy = {};
    try
    {
        const absolutePolicy = path.isAbsolute(policyFile) ? policyFile : path.join(absoluteRoot, policyFile);
        policy = JSON.parse(fs.readFileSync(absolutePolicy, 'utf8'));
    }
    catch (error)
    {
        errors.push(`architecture policy is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    errors.push(...validatePolicy(policy));
    const files = (suppliedFiles ?? trackedFiles(absoluteRoot, errors)).map(normalize).filter(Boolean).sort();
    validateProjectTopology(absoluteRoot, files, policy, errors);
    validateComposeTopology(absoluteRoot, files, policy, errors);
    validateSourceBoundaries(absoluteRoot, files, policy, errors);
    validateSingleMode(absoluteRoot, policy, errors);
    validateDocumentation(absoluteRoot, files, policy, errors);
    return { ok: errors.length === 0, errors, checkedFiles: files.length };
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
        const result = checkMonolithicDistributedArchitecture(parseArgs(process.argv.slice(2)));
        if (!result.ok)
        {
            for (const error of result.errors)
            {
                console.error(`[monolithic-distributed-architecture] ${error}`);
            }
            process.exit(1);
        }
        console.log(`[monolithic-distributed-architecture] ok files=${result.checkedFiles}`);
    }
    catch (error)
    {
        console.error(`[monolithic-distributed-architecture] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
