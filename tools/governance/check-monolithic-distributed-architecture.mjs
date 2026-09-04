#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(toolFile), '../..');
const { parseYamlDocument } = await import(pathToFileURL(path.join(defaultRoot, 'tools/yaml/parse-document.mjs')).href);
const defaultPolicy = 'tests/governance/monolithic-distributed-architecture.json';

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

function evaluationFailure(project, reason, errors)
{
    const detail = String(reason).replace(/\s+/gu, ' ').trim().slice(0, 1000);
    errors.push(`cannot evaluate MSBuild project ${project}: ${detail || 'unknown evaluation failure'}`);
    return { executable: true, executableOutputType: false, webSdk: false };
}

function evaluateExecutableProject(root, project, errors)
{
    const result = spawnSync('dotnet', [
        'msbuild',
        project,
        '--nologo',
        '--verbosity:quiet',
        '--getProperty:OutputType',
        '--getProperty:UsingMicrosoftNETSdkWeb'
    ], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            DOTNET_CLI_TELEMETRY_OPTOUT: '1',
            DOTNET_NOLOGO: '1',
            DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
            MSBUILDTERMINALLOGGER: 'off'
        },
        maxBuffer: 1024 * 1024,
        timeout: 15_000
    });
    if (result.error)
    {
        return evaluationFailure(project, result.error.message, errors);
    }
    if (result.status !== 0)
    {
        const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
        return evaluationFailure(project, detail || `exit ${result.status}`, errors);
    }

    let properties;
    try
    {
        const document = JSON.parse(String(result.stdout ?? '').trim());
        properties = object(document?.Properties);
    }
    catch (error)
    {
        return evaluationFailure(
            project,
            `invalid property JSON: ${error instanceof Error ? error.message : String(error)}`,
            errors
        );
    }
    const propertyNames = Object.keys(properties).sort();
    if (JSON.stringify(propertyNames) !== JSON.stringify(['OutputType', 'UsingMicrosoftNETSdkWeb']))
    {
        return evaluationFailure(project, 'property result must contain exactly OutputType and UsingMicrosoftNETSdkWeb', errors);
    }

    const outputType = String(properties.OutputType ?? '').trim().toLowerCase();
    const usingWebSdk = String(properties.UsingMicrosoftNETSdkWeb ?? '').trim().toLowerCase();
    if (!['exe', 'library', 'winexe'].includes(outputType))
    {
        return evaluationFailure(project, `unsupported OutputType ${outputType || 'empty'}`, errors);
    }
    if (!['', 'false', 'true'].includes(usingWebSdk))
    {
        return evaluationFailure(project, `unsupported UsingMicrosoftNETSdkWeb ${usingWebSdk}`, errors);
    }
    const executableOutputType = outputType === 'exe' || outputType === 'winexe';
    const webSdk = usingWebSdk === 'true';
    return { executable: executableOutputType || webSdk, executableOutputType, webSdk };
}

function validatePolicy(policy)
{
    const errors = [];
    if (policy?.schema !== 'fsusblog.monolithic-distributed-architecture.v1')
    {
        errors.push('architecture policy schema must be fsusblog.monolithic-distributed-architecture.v1');
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

function validateProjectTopology(root, files, policy, errors)
{
    const projects = files.filter((file) => file.startsWith('src/') && file.endsWith('.csproj'));
    const projectInspections = new Map(projects.map((file) => [
        file,
        evaluateExecutableProject(root, file, errors)
    ]));
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
