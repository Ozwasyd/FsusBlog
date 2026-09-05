#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveContainedPath } from '../fact-extractors/identity.mjs';

const toolFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(toolFile), '../..');
const { parseYamlDocument } = await import(pathToFileURL(path.join(defaultRoot, 'tools/yaml/parse-document.mjs')).href);
const defaultPolicy = 'tests/governance/monolithic-distributed-architecture.json';
const productionBuildAuthority = 'tests/governance/backend-production-build-consumers.json';
const evaluationHelper = path.join(defaultRoot, 'tools/governance/evaluate-msbuild-entrypoints.mjs');
const evaluationSchema = 'fsusblog.msbuild-entrypoint-evaluation.v1';
const safeConfiguration = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

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

function canonicalTrustedExecutable(candidate, label)
{
    const lexical = path.resolve(candidate);
    const canonical = fs.realpathSync(lexical);
    const metadata = fs.lstatSync(canonical);
    const trustedRoots = ['/usr/bin', '/usr/local/bin', '/usr/lib/docker', '/usr/libexec/docker'];
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || !trustedRoots.some((root) => canonical === root || canonical.startsWith(`${root}/`))
        || (metadata.mode & 0o022) !== 0)
    {
        throw new Error(`${label} canonical executable is not a trusted non-symlink system binary: ${canonical}`);
    }
    return canonical;
}

function executableFromPath(name)
{
    for (const directory of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    {
        const candidate = path.resolve(directory, name);
        try
        {
            const candidateMetadata = fs.lstatSync(candidate);
            if (!candidateMetadata.isFile() && !candidateMetadata.isSymbolicLink())
            {
                continue;
            }
            fs.accessSync(candidate, fs.constants.X_OK);
            return canonicalTrustedExecutable(candidate, name);
        }
        catch (error)
        {
            if (fs.existsSync(candidate))
            {
                throw error;
            }
        }
    }
    throw new Error(`${name} executable is unavailable on PATH`);
}

function checkedProcess(executable, args, repositoryRoot, label)
{
    const result = spawnSync(executable, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0 || !String(result.stdout ?? '').trim())
    {
        throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
    }
    return String(result.stdout).trim();
}

export function resolveDockerComposeOracleIdentity({ root = defaultRoot } = {})
{
    const repositoryRoot = path.resolve(root);
    const dockerPath = executableFromPath('docker');
    const dockerVersion = checkedProcess(
        dockerPath,
        ['version', '--format', '{{.Client.Version}}'],
        repositoryRoot,
        'Docker client version probe'
    );
    const plugins = JSON.parse(checkedProcess(
        dockerPath,
        ['info', '--format', '{{json .ClientInfo.Plugins}}'],
        repositoryRoot,
        'Docker client plugin inventory probe'
    ));
    const compose = array(plugins).filter((entry) => entry?.Name === 'compose');
    if (compose.length !== 1 || typeof compose[0]?.Path !== 'string')
    {
        throw new Error('Docker Compose implementation must resolve to exactly one client plugin');
    }
    const composePath = canonicalTrustedExecutable(compose[0].Path, 'Docker Compose');
    const composeVersion = checkedProcess(
        dockerPath,
        ['compose', 'version', '--short'],
        repositoryRoot,
        'Docker Compose version probe'
    );
    const normalizeVersion = (value) => String(value).replace(/^v/u, '');
    if (normalizeVersion(compose[0].Version) !== normalizeVersion(composeVersion))
    {
        throw new Error('Docker Compose plugin inventory/version mismatch');
    }
    return {
        dockerExecutable: {
            canonicalPath: dockerPath,
            digest: digestText(fs.readFileSync(dockerPath)),
            version: dockerVersion
        },
        composeImplementation: {
            canonicalPath: composePath,
            digest: digestText(fs.readFileSync(composePath)),
            version: composeVersion
        }
    };
}

function validateExactKeys(value, keys, label, errors)
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
        return fs.readFileSync(resolveContainedPath(root, normalize(relative), 'file'), 'utf8');
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

function exactKeys(value, expected)
{
    return value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function evaluationFailure(project, code, errors)
{
    errors.push(`cannot evaluate MSBuild project ${project}: ${code}`);
    return { executable: true, executableOutputType: false, webSdk: false };
}

function executablePath(name)
{
    for (const directory of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    {
        const candidate = path.join(directory, name);
        try
        {
            fs.accessSync(candidate, fs.constants.X_OK);
            return fs.realpathSync(candidate);
        }
        catch
        {
            // Continue to the next caller-provided executable search directory.
        }
    }
    return null;
}

export function msbuildSandboxProperties(readOnlyBindings = [], runtimeMaxSeconds = 45)
{
    return [
        `RuntimeMaxSec=${runtimeMaxSeconds}s`,
        'TimeoutStopSec=5s',
        'KillMode=control-group',
        'SendSIGKILL=yes',
        'PrivateNetwork=yes',
        'RestrictAddressFamilies=AF_UNIX',
        'ProtectSystem=strict',
        'ProtectHome=tmpfs',
        'PrivateTmp=yes',
        'NoNewPrivileges=yes',
        'RestrictSUIDSGID=yes',
        'LockPersonality=yes',
        'ProtectKernelTunables=yes',
        'ProtectControlGroups=yes',
        'UMask=0077',
        ...readOnlyBindings.map((binding) => `BindReadOnlyPaths=${binding}`)
    ];
}

export function msbuildEvaluationEnvironment(dotnet)
{
    return [
        'PATH=/usr/bin:/bin',
        'LANG=C.UTF-8',
        `DOTNET_ROOT=${path.dirname(dotnet)}`,
        'HOME=/tmp',
        'DOTNET_CLI_HOME=/tmp',
        'TMPDIR=/tmp',
        'DOTNET_CLI_TELEMETRY_OPTOUT=1',
        'DOTNET_CLI_USE_MSBUILD_SERVER=0',
        'DOTNET_MULTILEVEL_LOOKUP=0',
        'DOTNET_NOLOGO=1',
        'DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1',
        'MSBUILDENABLEALLPROPERTYFUNCTIONS=0',
        'MSBUILDDISABLENODEREUSE=1',
        'MSBUILDTERMINALLOGGER=off'
    ];
}

function productionConfigurations(root, errors)
{
    let authority;
    try
    {
        authority = JSON.parse(fs.readFileSync(path.join(root, productionBuildAuthority), 'utf8'));
    }
    catch
    {
        errors.push('production build configuration authority is missing or invalid');
        return null;
    }
    const production = authority?.schema === 'fsusblog.backend-production-build-consumers.v1'
        ? authority?.producer?.configuration
        : null;
    if (typeof production !== 'string' || !safeConfiguration.test(production) || production === 'Debug')
    {
        errors.push('production build configuration authority is missing or invalid');
        return null;
    }
    return ['Debug', production];
}

export function parseMsbuildEvaluationEnvelope(source, expectedProjects)
{
    let document;
    try
    {
        document = JSON.parse(String(source).trim());
    }
    catch
    {
        throw new Error('invalid-evaluation-envelope');
    }
    if (!exactKeys(document, ['projects', 'schema'])
        || document.schema !== evaluationSchema
        || !Array.isArray(document.projects)
        || document.projects.length !== expectedProjects.length)
    {
        throw new Error('invalid-evaluation-envelope');
    }
    const expected = new Set(expectedProjects);
    for (const project of document.projects)
    {
        if (!exactKeys(project, ['errorCode', 'executableOutputType', 'project', 'webSdk'])
            || !expected.delete(project.project)
            || (project.errorCode !== null && !/^[a-z][a-z0-9-]*$/u.test(project.errorCode))
            || typeof project.executableOutputType !== 'boolean'
            || typeof project.webSdk !== 'boolean')
        {
            throw new Error('invalid-evaluation-envelope');
        }
    }
    if (expected.size !== 0)
    {
        throw new Error('invalid-evaluation-envelope');
    }
    return document.projects;
}

function sandboxControlEnvironment()
{
    return Object.fromEntries([
        ['DBUS_SESSION_BUS_ADDRESS', process.env.DBUS_SESSION_BUS_ADDRESS],
        ['LANG', 'C.UTF-8'],
        ['PATH', '/usr/bin:/bin'],
        ['XDG_RUNTIME_DIR', process.env.XDG_RUNTIME_DIR]
    ].filter(([, value]) => typeof value === 'string' && value.length > 0));
}

function commandSucceeds(command, args, env)
{
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        env,
        stdio: 'ignore',
        timeout: 5_000
    });
    return !result.error && result.status === 0;
}

function sandboxAuthority()
{
    const systemdRun = executablePath('systemd-run');
    const systemctl = executablePath('systemctl');
    if (!systemdRun || !systemctl)
    {
        return null;
    }
    const env = sandboxControlEnvironment();
    if (commandSucceeds(systemctl, ['--user', 'show-environment'], env))
    {
        return {
            controlCommand: systemctl,
            controlPrefix: ['--user'],
            runCommand: systemdRun,
            runPrefix: ['--user']
        };
    }
    const sudo = executablePath('sudo');
    if (sudo && fs.existsSync('/run/systemd/system')
        && commandSucceeds(sudo, ['-n', '/usr/bin/true'], env))
    {
        return {
            controlCommand: sudo,
            controlPrefix: ['-n', systemctl],
            runCommand: sudo,
            runPrefix: ['-n', systemdRun, `--uid=${process.getuid()}`]
        };
    }
    return null;
}

function unitControl(authority, args)
{
    return spawnSync(authority.controlCommand, [...authority.controlPrefix, ...args], {
        encoding: 'utf8',
        env: sandboxControlEnvironment(),
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000
    });
}

function unitState(authority, unit)
{
    const result = unitControl(authority, [
        'show',
        '--property=ActiveState',
        '--property=LoadState',
        unit
    ]);
    if (result.error || result.status !== 0)
    {
        return null;
    }
    const fields = Object.fromEntries(String(result.stdout).trim().split('\n').map((line) => {
        const separator = line.indexOf('=');
        return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : ['', ''];
    }));
    if (!exactKeys(fields, ['ActiveState', 'LoadState'])
        || !['activating', 'active', 'deactivating', 'failed', 'inactive', 'maintenance', 'reloading'].includes(fields.ActiveState)
        || !['error', 'loaded', 'masked', 'not-found', 'stub'].includes(fields.LoadState))
    {
        return null;
    }
    return fields;
}

function ensureUnitTerminal(authority, unit)
{
    let stopRequested = false;
    let resetRequested = false;
    const delay = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 20; attempt += 1)
    {
        const state = unitState(authority, unit);
        if (state === null)
        {
            return false;
        }
        if (state.ActiveState === 'inactive' && state.LoadState === 'not-found')
        {
            return true;
        }
        if (!['failed', 'inactive'].includes(state.ActiveState) && !stopRequested)
        {
            unitControl(authority, ['stop', unit]);
            stopRequested = true;
        }
        if (state.ActiveState === 'failed' && !resetRequested)
        {
            unitControl(authority, ['reset-failed', unit]);
            resetRequested = true;
        }
        Atomics.wait(delay, 0, 0, 50);
    }
    return false;
}

function evaluateExecutableProjects(root, projects, configurations, errors, runtimeMaxSeconds)
{
    if (configurations === null)
    {
        return new Map(projects.map((project) => [
            project,
            evaluationFailure(project, 'configuration-authority-invalid', errors)
        ]));
    }
    if (process.platform !== 'linux')
    {
        return new Map(projects.map((project) => [
            project,
            evaluationFailure(project, 'sandbox-unavailable', errors)
        ]));
    }
    const dotnet = executablePath('dotnet');
    const authority = sandboxAuthority();
    if (!dotnet || !authority)
    {
        return new Map(projects.map((project) => [
            project,
            evaluationFailure(project, 'sandbox-unavailable', errors)
        ]));
    }
    const input = Buffer.from(JSON.stringify({ configurations, dotnet, projects }), 'utf8').toString('base64url');
    const readOnlyBindings = [...new Set([root, defaultRoot])].sort();
    const unit = `fsusblog-msbuild-entrypoints-${process.pid}-${randomUUID().replaceAll('-', '')}.service`;
    let result = null;
    let unitIsTerminal = false;
    try
    {
        result = spawnSync(authority.runCommand, [
            ...authority.runPrefix,
            '--quiet',
            '--wait',
            '--pipe',
            '--collect',
            `--unit=${unit}`,
            '--service-type=exec',
            ...msbuildSandboxProperties(readOnlyBindings, runtimeMaxSeconds).map((property) => `--property=${property}`),
            `--working-directory=${root}`,
            '/usr/bin/env',
            '-i',
            ...msbuildEvaluationEnvironment(dotnet),
            process.execPath,
            evaluationHelper,
            input
        ], {
            cwd: root,
            encoding: 'utf8',
            env: sandboxControlEnvironment(),
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: (runtimeMaxSeconds * 1000) + 10_000
        });
    }
    catch
    {
        result = null;
    }
    finally
    {
        unitIsTerminal = ensureUnitTerminal(authority, unit);
    }
    let evaluations;
    try
    {
        if (!unitIsTerminal || result === null || result.error || result.status !== 0)
        {
            throw new Error('sandbox-failed');
        }
        evaluations = parseMsbuildEvaluationEnvelope(result.stdout, projects);
    }
    catch
    {
        return new Map(projects.map((project) => [
            project,
            evaluationFailure(project, 'sandbox-evaluation-failed', errors)
        ]));
    }
    return new Map(evaluations.map((evaluation) => [
        evaluation.project,
        evaluation.errorCode === null
            ? {
                executable: evaluation.executableOutputType || evaluation.webSdk,
                executableOutputType: evaluation.executableOutputType,
                webSdk: evaluation.webSdk
            }
            : evaluationFailure(evaluation.project, evaluation.errorCode, errors)
    ]));
}

function validatePolicy(policy)
{
    const errors = [];
    validateExactKeys(policy, [
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
    validateExactKeys(policy?.mainApplication, [
        'composeService', 'dockerfile', 'frontendIntegrationTokens', 'productionEntrypoint',
        'productionImage', 'productionTarget', 'project'
    ], 'mainApplication', errors);
    if (policy?.mainApplication?.productionTarget !== 'final'
        || JSON.stringify(policy?.mainApplication?.productionEntrypoint) !== JSON.stringify(['./FsusBlog.Server'])
        || policy?.mainApplication?.productionImage
            !== '${FSUSBLOG_IMAGE_REF:?Set immutable repository@sha256 digest from release-manifest.json}')
    {
        errors.push('mainApplication production process/image must be the final immutable FsusBlog.Server artifact');
    }
    for (const field of ['project', 'dockerfile', 'composeService'])
    {
        if (!String(policy?.mainApplication?.[field] ?? '').trim())
        {
            errors.push(`mainApplication.${field} is required`);
        }
    }
    const executableProjectClassifications = object(policy?.executableProjectClassifications);
    if (Object.keys(executableProjectClassifications).length === 0)
    {
        errors.push('executableProjectClassifications must classify every executable project');
    }
    for (const [project, classification] of Object.entries(executableProjectClassifications))
    {
        if (project !== normalize(project) || !project.startsWith('src/') || !project.endsWith('.csproj'))
        {
            errors.push(`invalid executable project classification path: ${project}`);
        }
        if (!['business-application', 'non-business-tool'].includes(classification))
        {
            errors.push(`invalid executable project classification: ${project}#${classification}`);
        }
    }
    if (JSON.stringify(policy?.runtimeModes) !== JSON.stringify(['single', 'static-role', 'adaptive']))
    {
        errors.push('runtimeModes must be exactly single, static-role, adaptive');
    }
    const ownership = object(policy?.runtimeRoleOwnership);
    validateExactKeys(ownership, [
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
        validateExactKeys(mount, ['access', 'protection', 'scope', 'source', 'volumeName'], `blueGreenMounts.${target}`, errors);
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
            stage = { commands: [], entrypoints: [] };
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
        const command = /^CMD\s+(?<value>.+)$/iu.exec(line);
        if (command && stage)
        {
            try
            {
                const value = JSON.parse(command.groups.value);
                if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
                {
                    throw new Error('must be a non-empty JSON string array');
                }
                stage.commands.push(value);
            }
            catch (error)
            {
                stage.commands.push({ error: error instanceof Error ? error.message : String(error) });
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

function validateComposeServiceRoster(compose, classified, sourcePath, errors)
{
    const actualServices = Object.keys(object(compose.services)).sort();
    const expectedServices = Object.keys(object(classified)).sort();
    if (JSON.stringify(actualServices) !== JSON.stringify(expectedServices))
    {
        errors.push(`Compose services drifted in ${sourcePath}: expected ${expectedServices.join(', ')}, found ${actualServices.join(', ')}`);
    }
    return { actualServices, expectedServices };
}

function observeEffectiveComposeModel(repositoryRoot, sourcePath, errors)
{
    let oracleIdentity;
    try
    {
        oracleIdentity = resolveDockerComposeOracleIdentity({ root: repositoryRoot });
    }
    catch (error)
    {
        errors.push(`canonical Docker Compose oracle identity failed: ${error instanceof Error ? error.message : String(error)}`);
        return {};
    }
    const run = (allProfiles) =>
    {
        const args = ['compose', '-f', sourcePath];
        if (allProfiles)
        {
            args.push('--profile', '*');
        }
        args.push('config', '--format', 'json', '--no-interpolate');
        const result = spawnSync(oracleIdentity.dockerExecutable.canonicalPath, args, {
            cwd: repositoryRoot,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024
        });
        if (result.status !== 0)
        {
            errors.push(`canonical Docker Compose effective-model observation failed (${allProfiles ? 'all-profiles' : 'default'}): ${(result.stderr || result.stdout || 'docker compose config failed').trim()}`);
            return {};
        }
        try
        {
            return JSON.parse(result.stdout);
        }
        catch (error)
        {
            errors.push(`canonical Docker Compose effective-model output is invalid: ${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
    };
    const defaultModel = run(false);
    const allProfileModel = run(true);
    const project = (model, defaultActiveOnly) => Object.fromEntries(Object.entries(object(model.services))
        .filter(([, value]) => !defaultActiveOnly || array(value?.profiles).length === 0)
        .sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => [id, {
            image: value?.image ?? null,
            build: value?.build ?? null,
            pullPolicy: value?.pull_policy ?? null,
            profiles: array(value?.profiles).sort(),
            entrypoint: value?.entrypoint ?? null,
            command: value?.command ?? null
        }]));
    const unsigned = {
        oracle: 'docker-compose-config-json-no-interpolate',
        oracleVersion: oracleIdentity.composeImplementation.version,
        dockerExecutable: oracleIdentity.dockerExecutable,
        composeImplementation: oracleIdentity.composeImplementation,
        sourcePath,
        defaultServices: project(defaultModel, true),
        allProfileServices: project(allProfileModel, false)
    };
    return { ...unsigned, modelDigest: digestCanonical(unsigned) };
}

function inspectProductionApplication(repositoryRoot, policy, compose, dockerfileSource, errors)
{
    const sourcePath = 'ops/docker/docker-compose.production.yml';
    const classified = object(policy?.composeServices?.[sourcePath]);
    const effectiveCompose = observeEffectiveComposeModel(repositoryRoot, sourcePath, errors);
    const defaultServices = Object.keys(object(effectiveCompose.defaultServices)).sort();
    const actualServices = Object.keys(object(effectiveCompose.allProfileServices)).sort();
    const expectedServices = Object.keys(classified).sort();
    if (JSON.stringify(actualServices) !== JSON.stringify(expectedServices)
        || JSON.stringify(defaultServices) !== JSON.stringify(expectedServices))
    {
        errors.push(`Compose effective services drifted in ${sourcePath}: expected default/all ${expectedServices.join(', ')}, found default ${defaultServices.join(', ')} and all ${actualServices.join(', ')}`);
    }
    const applicationServices = actualServices.filter((id) => classified[id] === 'application');
    const expectedService = policy?.mainApplication?.composeService;
    if (applicationServices.length !== 1 || applicationServices[0] !== expectedService)
    {
        errors.push('production topology must contain exactly one authority-owned application service');
    }

    const stages = parseDockerfileStages(dockerfileSource);
    const productionStage = stages.get(policy?.mainApplication?.productionTarget);
    if (!productionStage || productionStage.entrypoints.length !== 1
        || productionStage.commands.length !== 0
        || JSON.stringify(productionStage.entrypoints[0]) !== JSON.stringify(policy?.mainApplication?.productionEntrypoint))
    {
        errors.push('production Docker target must expose exactly the authority-owned PID1 with no CMD tail');
    }

    const service = object(compose.services?.[expectedService]);
    const effectiveService = object(effectiveCompose.allProfileServices?.[expectedService]);
    if (effectiveService.image !== policy?.mainApplication?.productionImage
        || effectiveService.build !== null
        || effectiveService.pullPolicy !== 'always'
        || array(effectiveService.profiles).length !== 0
        || effectiveService.entrypoint !== null
        || effectiveService.command !== null)
    {
        errors.push('production effective application service must use only the immutable pulled image, remain default-active, and inherit Docker PID1 without Compose overrides');
    }
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

    return {
        actualServices,
        applicationServices,
        declaredMounts,
        effectiveCompose,
        effectiveService,
        expectedService,
        service,
        productionStage
    };
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

    let compose = {};
    try
    {
        compose = parseYamlDocument(sources.productionCompose.text, { source: sourcePaths.productionCompose });
    }
    catch (error)
    {
        errors.push(`cannot parse production Compose topology: ${error instanceof Error ? error.message : String(error)}`);
    }
    const production = inspectProductionApplication(repositoryRoot, policy, compose, sources.dockerfile.text, errors);
    const {
        actualServices, applicationServices, declaredMounts, effectiveCompose,
        effectiveService, expectedService, productionStage
    } = production;

    const ownership = object(policy?.runtimeRoleOwnership);
    const unsigned = {
        schema: 'fsusblog.runtime-role-deployment-observation.v1',
        authoritySchema: policy?.schema ?? null,
        authorityContentDigest: policy?.contentDigest ?? null,
        sourceDigests: Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, {
            path: source.path,
            digest: digestText(source.text)
        }])),
        effectiveCompose,
        application: {
            project: policy?.mainApplication?.project ?? null,
            dockerTarget: policy?.mainApplication?.productionTarget ?? null,
            processEntrypoint: productionStage?.entrypoints?.[0] ?? [],
            composeService: expectedService ?? null,
            image: effectiveService.image ?? null,
            serviceRoster: actualServices,
            applicationServiceCount: applicationServices.length,
            composeEntrypointOverride: effectiveService.entrypoint === null ? 'absent' : effectiveService.entrypoint,
            composeCommandOverride: effectiveService.command === null ? 'absent' : effectiveService.command,
            effectivePid1: productionStage?.entrypoints?.[0] ?? [],
            pid1Source: 'docker-final-entrypoint-no-compose-override'
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

function validateProjectTopology(root, files, policy, errors, runtimeMaxSeconds)
{
    const projects = files.filter((file) => file.startsWith('src/') && file.endsWith('.csproj'));
    const configurations = productionConfigurations(root, errors);
    const projectInspections = evaluateExecutableProjects(root, projects, configurations, errors, runtimeMaxSeconds);
    const entrypoints = projects.filter((file) => projectInspections.get(file)?.executable === true);
    const classifications = object(policy.executableProjectClassifications);
    const classifiedProjects = Object.keys(classifications).map(normalize).sort();
    for (const project of entrypoints.filter((file) => !Object.hasOwn(classifications, file)))
    {
        errors.push(`executable project has no architecture classification: ${project}`);
    }
    for (const project of classifiedProjects.filter((file) => !entrypoints.includes(file)))
    {
        errors.push(`classified executable project is missing or no longer executable: ${project}`);
    }
    for (const project of entrypoints.filter((file) => classifications[file] === 'non-business-tool'))
    {
        const inspection = projectInspections.get(project);
        if (inspection?.webSdk)
        {
            errors.push(`non-business tool must not use the Web SDK: ${project}`);
        }
        if (!inspection?.executableOutputType)
        {
            errors.push(`non-business tool must declare an executable OutputType: ${project}`);
        }
    }
    const expected = normalize(policy.mainApplication.project);
    const businessEntrypoints = entrypoints.filter((file) => classifications[file] !== 'non-business-tool');
    if (businessEntrypoints.length !== 1 || businessEntrypoints[0] !== expected
        || classifications[expected] !== 'business-application')
    {
        errors.push(`product source must expose exactly one business entrypoint (${expected}); found ${businessEntrypoints.join(', ') || 'none'}`);
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
        validateComposeServiceRoster(document, declared[file], file, errors);
        if (file === 'ops/docker/docker-compose.production.yml')
        {
            inspectProductionApplication(
                root,
                policy,
                document,
                read(root, policy.mainApplication.dockerfile, errors),
                errors);
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

export function checkMonolithicDistributedArchitecture({
    root = defaultRoot,
    policyFile = defaultPolicy,
    files: suppliedFiles,
    sandboxRuntimeMaxSeconds = 45
} = {})
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
    if (!Number.isInteger(sandboxRuntimeMaxSeconds)
        || sandboxRuntimeMaxSeconds < 1
        || sandboxRuntimeMaxSeconds > 45)
    {
        errors.push('MSBuild sandbox runtime maximum is invalid');
        sandboxRuntimeMaxSeconds = 45;
    }
    validateProjectTopology(absoluteRoot, files, policy, errors, sandboxRuntimeMaxSeconds);
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
