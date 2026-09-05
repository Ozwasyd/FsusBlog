#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const schema = 'fsusblog.msbuild-entrypoint-evaluation.v1';
const requestedProperties = [
    'OutputType',
    'TargetFramework',
    'TargetFrameworks',
    'UsingMicrosoftNETSdkWeb'
];
const safeConfiguration = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const safeTargetFramework = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u;
const evaluationEnvironmentNames = [
    'PATH',
    'LANG',
    'DOTNET_ROOT',
    'HOME',
    'DOTNET_CLI_HOME',
    'TMPDIR',
    'DOTNET_CLI_TELEMETRY_OPTOUT',
    'DOTNET_CLI_USE_MSBUILD_SERVER',
    'DOTNET_MULTILEVEL_LOOKUP',
    'DOTNET_NOLOGO',
    'DOTNET_SKIP_FIRST_TIME_EXPERIENCE',
    'MSBUILDENABLEALLPROPERTYFUNCTIONS',
    'MSBUILDDISABLENODEREUSE',
    'MSBUILDTERMINALLOGGER'
];

function exactKeys(value, expected)
{
    return value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function decodeInput(encoded)
{
    let input;
    try
    {
        input = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    }
    catch
    {
        throw new Error('invalid-input');
    }
    if (!exactKeys(input, ['configurations', 'dotnet', 'projects'])
        || !path.isAbsolute(input.dotnet)
        || !Array.isArray(input.projects)
        || input.projects.length === 0
        || input.projects.some((project) => typeof project !== 'string'
            || path.isAbsolute(project)
            || project.includes('..')
            || !project.startsWith('src/')
            || !project.endsWith('.csproj'))
        || !Array.isArray(input.configurations)
        || input.configurations.length < 2
        || input.configurations.some((configuration) => !safeConfiguration.test(configuration)))
    {
        throw new Error('invalid-input');
    }
    return input;
}

export function parseMsbuildPropertyDocument(source)
{
    let document;
    try
    {
        document = JSON.parse(String(source).trim());
    }
    catch
    {
        throw new Error('invalid-property-json');
    }
    if (!exactKeys(document, ['Properties'])
        || !exactKeys(document.Properties, requestedProperties)
        || requestedProperties.some((property) => typeof document.Properties[property] !== 'string'))
    {
        throw new Error('invalid-property-shape');
    }
    return document.Properties;
}

function evaluationEnvironment()
{
    return Object.fromEntries(evaluationEnvironmentNames.map((name) => [name, process.env[name] ?? '']));
}

function evaluateProperties(dotnet, project, configuration, targetFramework = null)
{
    const result = spawnSync(dotnet, [
        'msbuild',
        project,
        '--nologo',
        '--verbosity:quiet',
        '--nodeReuse:false',
        `--property:Configuration=${configuration}`,
        ...(targetFramework === null ? [] : [`--property:TargetFramework=${targetFramework}`]),
        ...requestedProperties.map((property) => `--getProperty:${property}`)
    ], {
        encoding: 'utf8',
        env: evaluationEnvironment(),
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000
    });
    if (result.error?.code === 'ETIMEDOUT')
    {
        return { errorCode: 'msbuild-timeout' };
    }
    if (result.error || result.status !== 0)
    {
        return { errorCode: 'msbuild-failed' };
    }
    let properties;
    try
    {
        properties = parseMsbuildPropertyDocument(result.stdout);
    }
    catch (error)
    {
        return { errorCode: error.message };
    }
    const outputType = properties.OutputType.trim().toLowerCase();
    const usingWebSdk = properties.UsingMicrosoftNETSdkWeb.trim().toLowerCase();
    if (!['exe', 'library', 'winexe'].includes(outputType))
    {
        return { errorCode: 'unsupported-output-type' };
    }
    if (!['', 'false', 'true'].includes(usingWebSdk))
    {
        return { errorCode: 'unsupported-web-sdk-property' };
    }
    return {
        errorCode: null,
        executableOutputType: outputType === 'exe' || outputType === 'winexe',
        targetFramework: properties.TargetFramework.trim(),
        targetFrameworks: properties.TargetFrameworks.trim(),
        webSdk: usingWebSdk === 'true'
    };
}

function targetFrameworkSet(evaluation)
{
    const values = [
        evaluation.targetFramework,
        ...evaluation.targetFrameworks.split(';').map((value) => value.trim())
    ].filter(Boolean);
    if (values.some((value) => !safeTargetFramework.test(value)))
    {
        return null;
    }
    return [...new Set(values)].sort();
}

function evaluateConfiguration(dotnet, project, configuration)
{
    const discovery = evaluateProperties(dotnet, project, configuration);
    if (discovery.errorCode)
    {
        return { errorCode: discovery.errorCode, evaluations: [] };
    }
    const evaluations = [discovery];
    const targetFrameworks = targetFrameworkSet(discovery);
    if (targetFrameworks === null || targetFrameworks.length > 32)
    {
        return { errorCode: 'invalid-target-framework-set', evaluations: [] };
    }
    const pending = [...targetFrameworks];
    const evaluated = new Set();
    while (pending.length > 0)
    {
        const targetFramework = pending.shift();
        if (evaluated.has(targetFramework))
        {
            continue;
        }
        evaluated.add(targetFramework);
        const inner = evaluateProperties(dotnet, project, configuration, targetFramework);
        if (inner.errorCode)
        {
            return { errorCode: inner.errorCode, evaluations: [] };
        }
        if (inner.targetFramework !== targetFramework)
        {
            return { errorCode: 'target-framework-identity-drift', evaluations: [] };
        }
        evaluations.push(inner);
        const discovered = targetFrameworkSet(inner);
        if (discovered === null)
        {
            return { errorCode: 'invalid-target-framework-set', evaluations: [] };
        }
        for (const candidate of discovered)
        {
            if (!evaluated.has(candidate) && !pending.includes(candidate))
            {
                pending.push(candidate);
            }
        }
        pending.sort();
        if (evaluated.size + pending.length > 32)
        {
            return { errorCode: 'invalid-target-framework-set', evaluations: [] };
        }
    }
    return { errorCode: null, evaluations };
}

function evaluateProject(dotnet, project, configurations)
{
    const evaluations = [];
    for (const configuration of configurations)
    {
        const result = evaluateConfiguration(dotnet, project, configuration);
        if (result.errorCode)
        {
            return { project, errorCode: result.errorCode, executableOutputType: false, webSdk: false };
        }
        evaluations.push(...result.evaluations);
    }
    return {
        project,
        errorCode: null,
        executableOutputType: evaluations.some((evaluation) => evaluation.executableOutputType),
        webSdk: evaluations.some((evaluation) => evaluation.webSdk)
    };
}

function main()
{
    try
    {
        const input = decodeInput(process.argv[2] ?? '');
        const projects = input.projects.map((project) =>
            evaluateProject(input.dotnet, project, input.configurations));
        process.stdout.write(`${JSON.stringify({ schema, projects })}\n`);
    }
    catch
    {
        process.stdout.write(`${JSON.stringify({ schema, projects: [], errorCode: 'invalid-input' })}\n`);
        process.exitCode = 2;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
