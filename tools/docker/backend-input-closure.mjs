#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statfsSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryRelativePath = 'config/build/backend-docker-inputs.json';
const dockerfileRelativePath = 'ops/docker/FsusBlog.Server.Dockerfile';
const buildScriptRelativePath = 'tools/build-final-image.sh';

export const backendAncestorFiles = [
    '/.editorconfig', '/.globalconfig', '/Directory.Build.props', '/Directory.Build.targets',
    '/Directory.Packages.props', '/NuGet.Config', '/NuGet.config', '/nuget.config', '/global.json'
];

function fail(message)
{
    throw new Error(`[backend-input-closure] ${message}`);
}

function parseArguments(argv)
{
    const command = argv[0];
    const options = { root: scriptRoot, output: '' };
    for (let index = 1; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (['--root', '--output', '--configuration', '--runtime', '--ready-to-run', '--target',
            '--single-file', '--tiered-pgo', '--quick-jit-for-loops', '--server-gc', '--release-id', '--commit-sha'].includes(argument))
        {
            const value = argv[index + 1];
            if (!value)
            {
                fail(`${argument} requires a value`);
            }
            options[argument.slice(2)] = value;
            index += 1;
            continue;
        }
        fail(`unknown argument: ${argument}`);
    }
    if (!['check', 'materialize', 'print', 'probe-buildkit'].includes(command))
    {
        fail('usage: backend-input-closure.mjs <check|materialize|print|probe-buildkit> [--root PATH] [--output PATH]');
    }
    if (command === 'materialize' && !options.output)
    {
        fail('materialize requires --output');
    }
    if (command === 'probe-buildkit' && !options.output)
    {
        fail('probe-buildkit requires --output');
    }
    return { command, ...options };
}

function normalizeRelative(root, value, description)
{
    const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
    const normalized = relative(root, absolute).split(sep).join('/');
    if (!normalized || normalized === '.' || normalized.startsWith('../') || isAbsolute(normalized))
    {
        fail(`${description} escapes the repository: ${value}`);
    }
    return normalized;
}

function sortedUnique(values)
{
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function requestedEvaluationProfile(inventory, options)
{
    const target = options.target ?? 'publish';
    if (!['publish', 'publish-debug'].includes(target))
    {
        fail('invalid requested target');
    }
    const configuration = options.configuration ?? inventory.evaluationProperties.Configuration;
    const runtime = options.runtime ?? inventory.evaluationProperties.RuntimeIdentifier;
    const ready = options['ready-to-run'] ?? 'false';
    if (!/^[A-Za-z0-9_.-]+$/u.test(configuration ?? '') || !/^[A-Za-z0-9_.-]+$/u.test(runtime ?? '') ||
      !['true', 'false'].includes(ready))
    {
        fail('invalid requested build profile');
    }
    const result = { Configuration: configuration, RuntimeIdentifier: runtime, PublishReadyToRun: ready };
    if (target === 'publish-debug')
    {
        if (ready !== 'false')
        {
            fail('publish-debug requires its existing ReadyToRun=false contract');
        }
        return { ...result, SelfContained: 'false', UseAppHost: 'false', TieredPGO: 'false', TieredCompilation: 'true' };
    }
    for (const name of ['single-file', 'tiered-pgo', 'quick-jit-for-loops', 'server-gc'])
    {
        if (options[name] !== undefined && !['true', 'false'].includes(options[name]))
        {
            fail(`invalid requested ${name}`);
        }
    }
    for (const name of ['release-id', 'commit-sha'])
    {
        if (options[name] !== undefined && !/^[A-Za-z0-9_.-]+$/u.test(options[name]))
        {
            fail(`invalid requested ${name}`);
        }
    }
    return { ...result, SelfContained: 'true', UseAppHost: 'true', PublishTrimmed: 'false',
        SkipClientDependenciesForPublish: 'true', SkipClientReleaseBuild: 'true', SkipClientReleaseArtifactCopy: 'true',
        FsusBlogReleaseId: options['release-id'] ?? 'local-unversioned',
        FsusBlogCommitSha: options['commit-sha'] ?? '0000000000000000000000000000000000000000',
        PublishSingleFile: options['single-file'] ?? 'true', TieredPGO: options['tiered-pgo'] ?? 'true',
        TieredCompilation: 'true', TieredCompilationQuickJitForLoops: options['quick-jit-for-loops'] ?? 'true',
        ServerGarbageCollection: options['server-gc'] ?? 'true', ReadyToRunUseCrossgen2: ready };
}

export function profileMarker(properties)
{
    return `${properties.Configuration}\n${properties.RuntimeIdentifier}\n${properties.PublishReadyToRun}\n`;
}

export function publishProfileMarker(properties)
{
    const head = [properties.SelfContained === 'false' ? 'publish-debug' : 'publish',
        properties.Configuration, properties.RuntimeIdentifier, properties.PublishReadyToRun];
    if (properties.SelfContained !== 'false')
    {
        head.push(properties.PublishSingleFile, properties.TieredPGO,
            properties.TieredCompilationQuickJitForLoops, properties.ServerGarbageCollection,
            properties.FsusBlogReleaseId, properties.FsusBlogCommitSha);
    }
    return `${head.join('\n')}\n`;
}

export function validateEvaluatedRestoreConfiguration(root, expected, observed)
{
    const configs = typeof observed === 'string' && observed.length > 0
        ? observed.split(';').map(path => path.length > 0 && isAbsolute(path) ? resolve(path) : null) : [];
    if (JSON.stringify(configs) !== JSON.stringify([resolve(root, expected)]))
    {
        fail('evaluated restore configuration is not the exact controlled singleton');
    }
}

export function validateStructuredRestoreSettings(root, expected, output)
{
    const settings = JSON.parse(output);
    const properties = settings?.Properties;
    if (!settings || Array.isArray(settings) || Object.keys(settings).join(',') !== 'Properties' ||
      !properties || Array.isArray(properties) ||
      JSON.stringify(Object.keys(properties).sort()) !== JSON.stringify(['RestoreConfigFile', '_OutputConfigFilePaths']) ||
      typeof properties.RestoreConfigFile !== 'string' || typeof properties._OutputConfigFilePaths !== 'string')
    {
        fail('MSBuild restore settings must contain exactly the two requested string properties');
    }
    validateEvaluatedRestoreConfiguration(root, expected, properties.RestoreConfigFile);
    validateEvaluatedRestoreConfiguration(root, expected, properties._OutputConfigFilePaths);
}

function assertStringArray(value, name)
{
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0))
    {
        fail(`${name} must be an array of non-empty strings`);
    }
    const sorted = sortedUnique(value);
    if (JSON.stringify(sorted) !== JSON.stringify(value))
    {
        fail(`${name} must be sorted and unique`);
    }
    return value;
}

function loadInventory(root)
{
    const path = join(root, inventoryRelativePath);
    const inventory = JSON.parse(readFileSync(path, 'utf8'));
    if (inventory.schema !== 'fsusblog.backend-docker-inputs.v1')
    {
        fail('inventory schema is invalid');
    }
    if (typeof inventory.entryProject !== 'string')
    {
        fail('entryProject must be a string');
    }
    if (typeof inventory.restoreConfigFile !== 'string')
    {
        fail('restoreConfigFile must be explicit');
    }
    normalizeRelative(root, inventory.restoreConfigFile, 'restoreConfigFile');
    if (!inventory.evaluationProperties || typeof inventory.evaluationProperties !== 'object')
    {
        fail('evaluationProperties must be an object');
    }
    assertStringArray(inventory.itemTypes, 'itemTypes');
    assertStringArray(inventory.imports, 'imports');
    assertStringArray(inventory.restoreFiles, 'restoreFiles');
    assertStringArray(inventory.allowedExternalItemRoots, 'allowedExternalItemRoots');
    assertStringArray(inventory.allowedExternalItemFiles, 'allowedExternalItemFiles');
    assertStringArray(inventory.optionalPublishRoots, 'optionalPublishRoots');
    assertStringArray(inventory.forbiddenPrefixes, 'forbiddenPrefixes');
    if (!Array.isArray(inventory.projects) || inventory.projects.length === 0)
    {
        fail('projects must be non-empty');
    }
    const projectPaths = inventory.projects.map(project => project.path);
    if (JSON.stringify(sortedUnique(projectPaths)) !== JSON.stringify(projectPaths))
    {
        fail('projects must be sorted by path and unique');
    }
    for (const project of inventory.projects)
    {
        if (typeof project.path !== 'string')
        {
            fail('each project path must be a string');
        }
        assertStringArray(project.references, `references for ${project.path}`);
    }
    return inventory;
}

export function describeMsbuildFailure(error, query)
{
    const output = {};
    for (const stream of ['stdout', 'stderr'])
    {
        const bytes = Buffer.from(error[stream] ?? '');
        output[stream] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
            text: bytes.subarray(0, 16384).toString('utf8'), truncated: bytes.length > 16384 };
    }
    return JSON.stringify({ code: error.code ?? null, status: error.status ?? null,
        signal: error.signal ?? null, timeoutMs: 60000, query, output });
}

function runMsbuild(root, project, inventory, argument, additionalProperties = {})
{
    const propertyArguments = Object.entries({ ...inventory.evaluationProperties, ...additionalProperties,
        RestoreConfigFile: resolve(root, inventory.restoreConfigFile) })
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `-p:${name}=${value}`);
    try
    {
        return execFileSync('dotnet', ['msbuild', project, '-nologo', ...propertyArguments,
            ...(Array.isArray(argument) ? argument : [argument])], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            timeout: 60000,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    }
    catch (error)
    {
        fail(`MSBuild evaluation failed for ${project}: ${describeMsbuildFailure(error, argument)}`);
    }
}

function repositoryRelativeOrNull(root, value)
{
    const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
    const normalized = relative(root, absolute).split(sep).join('/');
    if (!normalized || normalized === '.' || normalized.startsWith('../') || isAbsolute(normalized))
    {
        return null;
    }
    return normalized;
}

export function isMissingSdkGlobalConfigDiscovery(root, item, compileItems, toolsPath)
{
    const identity = item.FullPath ?? item.Identity;
    if (!identity || !isAbsolute(identity) || typeof toolsPath !== 'string' || !isAbsolute(toolsPath))
    {
        return false;
    }
    try
    {
        lstatSync(identity);
        return false;
    }
    catch (error)
    {
        if (error.code !== 'ENOENT')
        {
            throw error;
        }
    }
    // MSBuildToolsPath is a reserved engine property queried from this same evaluation,
    // not a project-supplied SDK path. Match its defining import and discovery semantics.
    const authority = join(toolsPath, 'Roslyn', 'Microsoft.Managed.Core.targets');
    if (repositoryRelativeOrNull(root, authority) !== null || item.DefiningProjectFullPath !== authority ||
      !existsSync(authority) || lstatSync(authority).isSymbolicLink() || !lstatSync(authority).isFile())
    {
        return false;
    }
    const source = readFileSync(authority, 'utf8');
    if (!source.includes('<GlobalAnalyzerConfigFiles Include="@(_AllDirectoriesAbove->\'%(FullPath)\'->Distinct()->Combine(\'.globalconfig\'))" Condition="\'$(DiscoverGlobalAnalyzerConfigFiles)\' != \'false\'" />') ||
      !source.includes('<EditorConfigFiles Include="@(GlobalAnalyzerConfigFiles->Exists())" Condition="\'$(DiscoverGlobalAnalyzerConfigFiles)\' != \'false\'" />'))
    {
        return false;
    }
    return compileItems.some(compile =>
    {
        const fullPath = compile.FullPath;
        if (!fullPath || !isAbsolute(fullPath))
        {
            return false;
        }
        let directory = dirname(fullPath);
        while (true)
        {
            if (join(directory, '.globalconfig') === identity)
            {
                return true;
            }
            const parent = dirname(directory);
            if (parent === directory)
            {
                return false;
            }
            directory = parent;
        }
    });
}

export function selectEvaluatedInput(root, project, itemType, item)
{
    if (itemType === 'None')
    {
        const copyValues = [item.CopyToOutputDirectory, item.CopyToPublishDirectory];
        if (copyValues.every(value => value === undefined || value === '' || value === 'Never'))
        {
            return null;
        }
        if (copyValues.some(value => value && !['Never', 'Always', 'PreserveNewest', 'IfDifferent'].includes(value)))
        {
            fail(`unsupported None copy metadata in ${project}: ${item.Identity}`);
        }
    }
    const identity = item.FullPath ?? item.Identity;
    if (!identity)
    {
        fail(`${itemType} input has no identity in ${project}`);
    }
    const fullPath = isAbsolute(identity) ? identity : resolve(root, dirname(project), identity);
    if (!existsSync(fullPath))
    {
        fail(`${itemType} input is missing in ${project}: ${identity}`);
    }
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        fail(`${itemType} input must be a regular non-symlink file: ${identity}`);
    }
    const path = repositoryRelativeOrNull(root, realpathSync(fullPath));
    if (!path)
    {
        fail(`${itemType} input escapes the repository in ${project}: ${identity}`);
    }
    return path;
}

function evaluateProject(root, project, inventory)
{
    const itemTypes = sortedUnique([...inventory.itemTypes, 'None']);
    const query = `-getItem:${['ProjectReference', ...itemTypes].join(',')}`;
    const projectRoot = dirname(project).split(sep).join('/');
    const evaluationRoot = mkdtempSync(join(tmpdir(), 'fsusblog-backend-inputs-'));
    const evaluationProperties = {
        BaseIntermediateOutputPath: `${join(evaluationRoot, 'obj')}${sep}`,
        BaseOutputPath: `${join(evaluationRoot, 'bin')}${sep}`,
        MSBuildProjectExtensionsPath: `${join(evaluationRoot, 'obj')}${sep}`
    };
    try
    {
    // MSBuild emits raw text for one property, but structured JSON for multiple properties.
        validateStructuredRestoreSettings(root, inventory.restoreConfigFile, runMsbuild(root, project, inventory, [
            '-target:_GetRestoreProjectStyle;_GetRestoreSettings', '-getProperty:_OutputConfigFilePaths,RestoreConfigFile'
        ], evaluationProperties));
        const evaluated = JSON.parse(runMsbuild(root, project, inventory, [query, '-getProperty:MSBuildToolsPath'], evaluationProperties));
        const items = evaluated.Items ?? {};
        const references = (items.ProjectReference ?? [])
            .map(item => repositoryRelativeOrNull(root, item.FullPath ?? item.Identity))
            .map(path => path ?? fail(`ProjectReference escapes the repository in ${project}`));

        const inputs = [];
        for (const itemType of itemTypes)
        {
            for (const item of items[itemType] ?? [])
            {
                if (itemType === 'GlobalAnalyzerConfigFiles' && isMissingSdkGlobalConfigDiscovery(
                    root, item, items.Compile ?? [], evaluated.Properties?.MSBuildToolsPath))
                {
                    continue;
                }
                const path = selectEvaluatedInput(root, project, itemType, item);
                if (path === null)
                {
                    continue;
                }
                if (isWithin(path, `${projectRoot}/bin`) || isWithin(path, `${projectRoot}/obj`))
                {
                    continue;
                }
                inputs.push(path);
            }
        }

        const preprocessPath = join(evaluationRoot, 'project.xml');
        runMsbuild(root, project, inventory, `-preprocess:${preprocessPath}`, evaluationProperties);
        const imports = readFileSync(preprocessPath, 'utf8')
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(line => isAbsolute(line) && existsSync(line))
            .map(path => repositoryRelativeOrNull(root, realpathSync(path)))
            .filter(path => path !== null)
            .filter(path => path !== project);
        return { references: sortedUnique(references), inputs: sortedUnique(inputs), imports: sortedUnique(imports) };
    }
    finally
    {
        rmSync(evaluationRoot, { recursive: true, force: true });
    }
}

function isWithin(path, prefix)
{
    return path === prefix || path.startsWith(`${prefix}/`);
}

function listFiles(root, relativeRoot)
{
    const absoluteRoot = join(root, relativeRoot);
    let rootStat;
    try
    {
        rootStat = lstatSync(absoluteRoot);
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
        {
            return [];
        }
        throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    {
        fail(`backend publish input root must be a regular directory: ${relativeRoot}`);
    }
    if (repositoryRelativeOrNull(root, realpathSync(absoluteRoot)) !== relativeRoot)
    {
        fail(`backend publish input root escapes the repository: ${relativeRoot}`);
    }
    const result = [];
    const visit = (absolute, relativePath) =>
    {
        for (const entry of readdirSync(absolute, { withFileTypes: true }))
        {
            const childRelative = `${relativePath}/${entry.name}`;
            const childAbsolute = join(absolute, entry.name);
            if (entry.isSymbolicLink())
            {
                fail(`symlink is forbidden in backend input inventory: ${childRelative}`);
            }
            if (entry.isDirectory())
            {
                visit(childAbsolute, childRelative);
            }
            else if (entry.isFile())
            {
                result.push(childRelative);
            }
            else
            {
                fail(`unsupported filesystem entry in backend input inventory: ${childRelative}`);
            }
        }
    };
    visit(absoluteRoot, relativeRoot);
    return sortedUnique(result);
}

export function assertDockerfile(root)
{
    const source = readFileSync(join(root, dockerfileRelativePath), 'utf8');
    if (/^\s*FROM\s+.+\s+AS\s+backend-inputs\s*$/imu.test(source))
    {
        fail('Dockerfile must not shadow the verified backend-inputs named context');
    }
    const stageMatches = [...source.matchAll(/^\s*FROM\s+.+?\s+AS\s+([A-Za-z0-9_.-]+)\s*$/gmu)];
    const stages = new Map(stageMatches.map((match, index) => [
        match[1].toLowerCase(),
        source.slice(match.index, stageMatches[index + 1]?.index ?? source.length)
    ]));
    const instructionsByStage = new Map([...stages].map(([stage, stageSource]) =>
    {
        const instructions = [];
        let current = '';
        for (const rawLine of stageSource.split(/\r?\n/u))
        {
            const line = rawLine.trim();
            if (!current && (!line || line.startsWith('#')))
            {
                continue;
            }
            const continued = line.endsWith('\\');
            const fragment = continued ? line.slice(0, -1).trimEnd() : line;
            current = current ? `${current} ${fragment}` : fragment;
            if (!continued)
            {
                instructions.push(current);
                current = '';
            }
        }
        if (current)
        {
            instructions.push(current);
        }
        return [stage, instructions];
    }));
    const expectedCopiesByStage = new Map([
        ['build', [
            'COPY --from=backend-inputs /restore/ /src/',
            'COPY --from=backend-inputs /compile/ /src/'
        ]],
        ['publish', ['COPY --from=backend-inputs /publish/ /src/']],
        ['publish-debug', []]
    ]);
    const ancestorGuard = `RUN for input in ${backendAncestorFiles.join(' ')}; do test ! -e "$input" && test ! -L "$input" || exit 1; done`;
    const buildInstructions = instructionsByStage.get('build') ?? [];
    if (buildInstructions.filter(line => line === ancestorGuard).length !== 1 ||
      buildInstructions.indexOf(ancestorGuard) > buildInstructions.indexOf('COPY --from=backend-inputs /restore/ /src/'))
    {
        fail('backend SDK ancestor absence guard is missing or late');
    }
    const restoreMarker = String.raw`RUN test "$(cat /src/.backend-input-profile)" = "$(printf '%s\n%s\n%s\n' "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" "$PUBLISH_READY_TO_RUN")"`;
    const publishMarker = String.raw`RUN test "$(cat /src/.backend-publish-profile)" = "$(printf '%s\n' publish "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" "$PUBLISH_READY_TO_RUN" "$PUBLISH_SINGLE_FILE" "$TIERED_PGO" "$QUICK_JIT_FOR_LOOPS" "$SERVER_GC" "$FSUSBLOG_RELEASE_ID" "$FSUSBLOG_COMMIT_SHA")"`;
    const debugMarker = String.raw`RUN test "$(cat /src/.backend-publish-profile)" = "$(printf '%s\n' publish-debug "$BUILD_CONFIGURATION" "$TARGET_RUNTIME" false)"`;
    for (const stage of ['build', 'publish', 'publish-debug'])
    {
        const instructions = instructionsByStage.get(stage) ?? [];
        const marker = stage === 'publish-debug' ? restoreMarker.replace('"$PUBLISH_READY_TO_RUN"', 'false') : restoreMarker;
        const requiredMarkers = stage === 'build' ? [marker] : [marker, stage === 'publish' ? publishMarker : debugMarker];
        const commands = instructions.filter(line => /^RUN dotnet (restore|publish) /u.test(line));
        if (commands.length !== 1 || requiredMarkers.some(value => instructions.filter(line => line === value).length !== 1 ||
        instructions.indexOf(value) > instructions.indexOf(commands[0])))
        {
            fail(`profile consumer marker binding mismatch in ${stage}`);
        }
        const command = commands[0];
        const expected = stage === 'build'
            ? ['--configfile /src/config/build/backend-restore.xml', '--runtime "$TARGET_RUNTIME"', '/p:Configuration="$BUILD_CONFIGURATION"',
        '/p:PublishReadyToRun="$PUBLISH_READY_TO_RUN"', '/p:ReadyToRunUseCrossgen2="$PUBLISH_READY_TO_RUN"']
            : ['-c "$BUILD_CONFIGURATION"', '-r "$TARGET_RUNTIME"', '/p:RestoreConfigFile=/src/config/build/backend-restore.xml',
        ...Object.entries(requestedEvaluationProfile({ evaluationProperties: {} }, {
          target: stage, configuration: 'Configuration', runtime: 'Runtime'
        })).filter(([key]) => !['Configuration', 'RuntimeIdentifier', 'SelfContained'].includes(key)).map(([key, value]) =>
{
          const variables = { PublishReadyToRun: 'PUBLISH_READY_TO_RUN', ReadyToRunUseCrossgen2: 'PUBLISH_READY_TO_RUN',
            PublishSingleFile: 'PUBLISH_SINGLE_FILE', TieredPGO: 'TIERED_PGO', TieredCompilationQuickJitForLoops: 'QUICK_JIT_FOR_LOOPS',
            ServerGarbageCollection: 'SERVER_GC', FsusBlogReleaseId: 'FSUSBLOG_RELEASE_ID', FsusBlogCommitSha: 'FSUSBLOG_COMMIT_SHA' };
          return `/p:${key}=${stage === 'publish' && variables[key] ? `"$${variables[key]}"` : value}`;
        }), `--self-contained ${stage === 'publish' ? 'true' : 'false'}`];
        for (const token of expected)
        {
            const key = token.includes('=') ? token.split('=')[0] + '=' : token.split(' ')[0] + ' ';
            const offset = command.indexOf(token);
            const end = offset + token.length;
            if (offset < 0 || (end !== command.length && command[end] !== ' ') || command.split(key).length !== 2)
            {
                fail(`profile command binding mismatch in ${stage}: ${key}`);
            }
        }
    }
    for (const [stage, expectedCopies] of expectedCopiesByStage)
    {
        const instructions = instructionsByStage.get(stage);
        if (!instructions)
        {
            fail(`backend SDK stage is missing: ${stage}`);
        }
        const actualCopies = instructions.filter(line => /^COPY\s+/u.test(line));
        if (JSON.stringify(actualCopies) !== JSON.stringify(expectedCopies))
        {
            fail(`backend SDK COPY authority mismatch for ${stage}: ${actualCopies.join(', ') || '<none>'}`);
        }
    }
    for (const stage of ['build-musl', 'build-glibc'])
    {
        const instructions = instructionsByStage.get(stage) ?? [];
        const allowedSource = `node-runtime-${stage.slice('build-'.length)}`;
        for (const instruction of instructions.filter(line => /^(?:ADD|COPY)\s+/u.test(line)))
        {
            const sourceMatch = instruction.match(/^COPY\s+--from=([^\s]+)\s+/u);
            if (!sourceMatch || sourceMatch[1] !== allowedSource)
            {
                fail(`backend SDK base stage reads an unverified context in ${stage}: ${instruction}`);
            }
        }
    }
    for (const stage of ['build-musl', 'build-glibc', ...expectedCopiesByStage.keys()])
    {
        for (const instruction of instructionsByStage.get(stage) ?? [])
        {
            if (/^ADD\s+/u.test(instruction))
            {
                fail(`backend SDK ADD authority is forbidden in ${stage}: ${instruction}`);
            }
            if (!/^RUN\s+/u.test(instruction))
            {
                continue;
            }
            for (const mount of instruction.matchAll(/--mount=([^\s]+)/gu))
            {
                const type = mount[1].split(',').find(option => option.startsWith('type='))?.slice(5) ?? 'bind';
                if (!['cache', 'secret'].includes(type))
                {
                    fail(`backend SDK RUN mount reads an unverified context in ${stage}: ${mount[0]}`);
                }
            }
        }
    }
    const actualBackendInputCopies = [...instructionsByStage].flatMap(([stage, instructions]) =>
        instructions
            .filter(instruction => /^COPY\s+--from=backend-inputs\s+/u.test(instruction))
            .map(instruction => `${stage}:${instruction}`));
    const expectedBackendInputCopies = [...expectedCopiesByStage].flatMap(([stage, instructions]) =>
        instructions.map(instruction => `${stage}:${instruction}`));
    if (JSON.stringify(actualBackendInputCopies) !== JSON.stringify(expectedBackendInputCopies))
    {
        fail(`backend-inputs named-context authority mismatch: ${actualBackendInputCopies.join(', ') || '<none>'}`);
    }
}

export function assertBuildScript(root)
{
    const source = readFileSync(join(root, buildScriptRelativePath), 'utf8');
    const materializers = source.match(/^node "\$ROOT_DIR\/tools\/docker\/backend-input-closure\.mjs" materialize \\\r?\n\s+--root "\$ROOT_DIR" \\\r?\n\s+--configuration Release --runtime "\$TARGET_RUNTIME" --ready-to-run "\$PUBLISH_READY_TO_RUN" \\\r?\n\s+--target publish --single-file "\$PUBLISH_SINGLE_FILE" --tiered-pgo "\$TIERED_PGO" \\\r?\n\s+--quick-jit-for-loops "\$QUICK_JIT_FOR_LOOPS" --server-gc "\$SERVER_GC" \\\r?\n\s+--release-id "\$RELEASE_ID" --commit-sha "\$COMMIT_SHA" \\\r?\n\s+--output "\$BACKEND_INPUT_CONTEXT"\s*$/gmu) ?? [];
    if (materializers.length !== 1)
    {
        fail(`final-image build must invoke the backend input materializer exactly once: ${materializers.length}`);
    }
    const contextAssignments = source.match(/^BACKEND_INPUT_CONTEXT="\$\(mktemp -d\)" \|\| Fail "unable to create backend input context"\s*$/gmu) ?? [];
    if (contextAssignments.length !== 1)
    {
        fail(`final-image backend input temporary context assignment must be exact: ${contextAssignments.length}`);
    }
    const contexts = [...source.matchAll(/^\s*--build-context\s+"backend-inputs=([^"\s\\]+)"\s+\\\s*$/gmu)]
        .map(match => match[1]);
    if (JSON.stringify(contexts) !== JSON.stringify(['$BACKEND_INPUT_CONTEXT']))
    {
        fail(`final-image backend-inputs context binding must be exact: ${contexts.join(', ') || '<none>'}`);
    }
}

export function evaluateClosure(root, inventory)
{
    const declaredProjects = inventory.projects.map(project => project.path);
    const declaredProjectSet = new Set(declaredProjects);
    for (const path of [
        ...declaredProjects,
        ...inventory.imports,
        ...inventory.restoreFiles,
        ...inventory.optionalPublishRoots
    ])
    {
        if (inventory.forbiddenPrefixes.some(prefix => isWithin(path, prefix)))
        {
            fail(`forbidden path entered backend inventory: ${path}`);
        }
    }
    if (!declaredProjectSet.has(inventory.entryProject))
    {
        fail('entryProject is not declared in projects');
    }
    if (inventory.allowedExternalItemFiles.includes('.editorconfig') &&
      !/^\s*root\s*=\s*true\s*$/imu.test(readFileSync(join(root, '.editorconfig'), 'utf8')))
    {
        fail('repository .editorconfig must declare root = true to exclude host parent configuration');
    }

    const referencesByProject = new Map(inventory.projects.map(project => [project.path, project.references]));
    const reachableProjects = new Set();
    const pendingProjects = [inventory.entryProject];
    while (pendingProjects.length > 0)
    {
        const project = pendingProjects.pop();
        if (reachableProjects.has(project))
        {
            continue;
        }
        reachableProjects.add(project);
        for (const reference of referencesByProject.get(project) ?? [])
        {
            pendingProjects.push(reference);
        }
    }
    const unreachableProjects = declaredProjects.filter(project => !reachableProjects.has(project));
    if (unreachableProjects.length > 0)
    {
        fail(`declared projects are not reachable from entryProject: ${unreachableProjects.join(',')}`);
    }

    const compileInputs = new Set();
    const actualImports = new Set();
    for (const project of inventory.projects)
    {
        const projectPath = normalizeRelative(root, project.path, 'project');
        if (!existsSync(join(root, projectPath)))
        {
            fail(`declared project is missing: ${projectPath}`);
        }
        const observations = [inventory.restoreEvaluationProperties, inventory.evaluationProperties]
            .filter(Boolean).map(properties => evaluateProject(root, projectPath, { ...inventory, evaluationProperties: properties }));
        const evaluated = Object.fromEntries(['references', 'inputs', 'imports'].map(key =>
            [key, sortedUnique(observations.flatMap(value => value[key]))]));
        if (JSON.stringify(evaluated.references) !== JSON.stringify(project.references))
        {
            fail(`ProjectReference closure mismatch for ${projectPath}: expected=${project.references.join(',')} actual=${evaluated.references.join(',')}`);
        }
        for (const reference of evaluated.references)
        {
            if (!declaredProjectSet.has(reference))
            {
                fail(`undeclared project dependency: ${reference}`);
            }
        }
        for (const input of evaluated.inputs)
        {
            compileInputs.add(input);
        }
        for (const imported of evaluated.imports)
        {
            actualImports.add(imported);
        }
    }

    const imports = sortedUnique(actualImports);
    if (JSON.stringify(imports) !== JSON.stringify(inventory.imports))
    {
        fail(`MSBuild import closure mismatch: expected=${inventory.imports.join(',')} actual=${imports.join(',')}`);
    }

    const projectRoots = inventory.projects.map(project => dirname(project.path).split(sep).join('/'));
    for (const input of compileInputs)
    {
        if (inventory.forbiddenPrefixes.some(prefix => isWithin(input, prefix)))
        {
            fail(`forbidden path entered backend compile closure: ${input}`);
        }
        const allowed = projectRoots.some(prefix => isWithin(input, prefix)) ||
      inventory.allowedExternalItemRoots.some(prefix => isWithin(input, prefix)) ||
      inventory.allowedExternalItemFiles.includes(input) ||
      inventory.imports.includes(input);
        if (!allowed)
        {
            fail(`MSBuild input is outside declared source roots: ${input}`);
        }
    }

    for (const path of inventory.restoreFiles)
    {
        if (!existsSync(join(root, path)))
        {
            fail(`restore input is missing: ${path}`);
        }
        const stat = lstatSync(join(root, path));
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            fail(`restore input must be a regular file: ${path}`);
        }
    }
    const expectedRestore = sortedUnique([
        inventory.restoreConfigFile,
        ...inventory.imports,
        ...discoverRepositoryRestoreConfiguration(root, declaredProjects, false),
        ...inventory.projects.map(project => project.path),
        ...inventory.projects.map(project => join(dirname(project.path), 'packages.lock.json').split(sep).join('/'))
    ]);
    if (JSON.stringify(expectedRestore) !== JSON.stringify(inventory.restoreFiles))
    {
        fail(`restoreFiles are not the exact project/import/lock closure: expected=${expectedRestore.join(',')} actual=${inventory.restoreFiles.join(',')}`);
    }

    const compile = sortedUnique([...compileInputs].filter(path => !inventory.restoreFiles.includes(path)));
    const publish = sortedUnique(inventory.optionalPublishRoots.flatMap(path => listFiles(root, path)));
    for (const path of publish)
    {
        if (inventory.forbiddenPrefixes.some(prefix => isWithin(path, prefix)))
        {
            fail(`forbidden path entered backend publish closure: ${path}`);
        }
    }
    return { restore: inventory.restoreFiles, compile, publish };
}

export function discoverRepositoryRestoreConfiguration(root, projects, includeImplicitNuget = true)
{
    const directories = new Set(['.']);
    for (const project of projects)
    {
        let directory = dirname(project);
        while (directory !== '.')
        {
            directories.add(directory);
            const parent = dirname(directory);
            if (parent === directory || directory.startsWith('..') || isAbsolute(directory))
            {
                fail(`restore configuration project path escapes repository: ${project}`);
            }
            directory = parent;
        }
    }
    const inputs = [];
    for (const directory of directories)
    {
        for (const name of readdirSync(join(root, directory)))
        {
            if ((!includeImplicitNuget || name.toLowerCase() !== 'nuget.config') && name !== 'global.json')
            {
                continue;
            }
            const path = join(directory, name).split(sep).join('/');
            const stat = lstatSync(join(root, path));
            if (!stat.isFile() || stat.isSymbolicLink())
            {
                fail(`restore configuration must be a regular file: ${path}`);
            }
            inputs.push(path);
        }
    }
    return sortedUnique(inputs);
}

function copyDomain(root, output, domain, paths)
{
    const domainRoot = join(output, domain);
    mkdirSync(domainRoot, { recursive: true });
    for (const path of paths)
    {
        const source = join(root, path);
        const destination = join(domainRoot, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination, { preserveTimestamps: false });
    }
}

function digestDomain(root, paths)
{
    const hash = createHash('sha256');
    for (const path of paths)
    {
        hash.update(path);
        hash.update('\0');
        hash.update(readFileSync(join(root, path)));
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}

function digestFile(path)
{
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

const buildkitVertexSelectors = Object.freeze({
    restoreCopy: /\[build \d+\/\d+\] COPY --from=backend-inputs \/restore\/ \/src\/$/u,
    restoreRun: /\[build \d+\/\d+\] RUN dotnet restore "\.\/src\/backend\/FsusBlog\.Server\.csproj"/u,
    compileCopy: /\[build \d+\/\d+\] COPY --from=backend-inputs \/compile\/ \/src\/$/u,
    publishRun: /\[publish-debug \d+\/\d+\] RUN dotnet publish "\.\/FsusBlog\.Server\.csproj"/u
});

export function parseBuildkitProgress(raw)
{
    const vertices = new Map();
    for (const line of raw.split(/\r?\n/u))
    {
        let event;
        try
        {
            event = JSON.parse(line);
        }
        catch
        {
            continue;
        }
        const updates = Array.isArray(event.vertexes) ? event.vertexes : [];
        for (const update of updates)
        {
            if (typeof update.digest !== 'string')
            {
                continue;
            }
            const current = vertices.get(update.digest) ?? {
                vertex: update.digest,
                name: '',
                cached: false,
                completed: false,
                error: ''
            };
            if (typeof update.name === 'string')
            {
                current.name = update.name.replace(/\s+/gu, ' ').trim();
            }
            if (update.cached === true)
            {
                current.cached = true;
            }
            if (typeof update.completed === 'string')
            {
                current.completed = true;
            }
            if (typeof update.error === 'string' && update.error)
            {
                current.error = update.error;
            }
            vertices.set(update.digest, current);
        }
    }

    return Object.fromEntries(Object.entries(buildkitVertexSelectors).map(([id, selector]) =>
    {
        const matches = [...vertices.values()].filter(vertex => selector.test(vertex.name));
        if (matches.length !== 1)
        {
            fail(`BuildKit progress must contain exactly one ${id} vertex, found ${matches.length}`);
        }
        const vertex = matches[0];
        if (!vertex.completed || vertex.error)
        {
            fail(`BuildKit ${id} vertex did not complete cleanly`);
        }
        return [id, vertex];
    }));
}

function assertCached(vertex, description)
{
    if (!vertex.cached)
    {
        fail(`${description} was not served from BuildKit cache`);
    }
}

function assertNotCached(vertex, description)
{
    if (vertex.cached)
    {
        fail(`${description} unexpectedly reused BuildKit cache`);
    }
}

export function verifyBuildkitProbeRelationships(probes)
{
    const required = ['cold', 'unrelated', 'backend-source', 'msbuild-import'];
    for (const id of required)
    {
        if (!probes[id]?.vertices || !probes[id]?.closure?.domains)
        {
            fail(`BuildKit probe is missing ${id}`);
        }
    }
    for (const [id, vertex] of Object.entries(probes.cold.vertices))
    {
        if (vertex.cached)
        {
            fail(`cold BuildKit ${id} vertex unexpectedly used cache`);
        }
    }
    for (const id of Object.keys(buildkitVertexSelectors))
    {
        assertCached(probes.unrelated.vertices[id], `unrelated-input ${id}`);
    }
    for (const domain of ['restore', 'compile', 'publish'])
    {
        if (probes.cold.closure.domains[domain].digest !== probes.unrelated.closure.domains[domain].digest)
        {
            fail(`unrelated inputs changed the real candidate ${domain} closure`);
        }
    }
    if (probes.unrelated.closure.domains.restore.digest !==
      probes['backend-source'].closure.domains.restore.digest)
    {
        fail('backend source changed the real candidate restore closure');
    }
    if (probes.unrelated.closure.domains.compile.digest ===
      probes['backend-source'].closure.domains.compile.digest)
    {
        fail('backend source kept the stale real candidate compile closure');
    }
    if (probes['backend-source'].closure.domains.restore.digest ===
      probes['msbuild-import'].closure.domains.restore.digest)
    {
        fail('MSBuild import kept the stale real candidate restore closure');
    }
    assertCached(probes['backend-source'].vertices.restoreCopy, 'backend-source restore copy');
    assertCached(probes['backend-source'].vertices.restoreRun, 'backend-source restore');
    assertNotCached(probes['backend-source'].vertices.compileCopy, 'backend-source compile copy');
    assertNotCached(probes['backend-source'].vertices.publishRun, 'backend-source publish');
    assertNotCached(probes['msbuild-import'].vertices.restoreCopy, 'MSBuild import restore copy');
    assertNotCached(probes['msbuild-import'].vertices.restoreRun, 'MSBuild import restore');
    assertNotCached(probes['msbuild-import'].vertices.publishRun, 'MSBuild import publish');
}

function runRequired(command, args, options = {})
{
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        env: options.env ?? process.env,
        maxBuffer: 128 * 1024 * 1024
    });
    if (result.error)
    {
        fail(`${options.description ?? command} could not start: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
        fail(`${options.description ?? command} failed with exit ${result.status}${output ? `: ${output}` : ''}`);
    }
    return result;
}

function writeMutation(root, relativePath, contents)
{
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
}

function appendXmlComment(path, token)
{
    const source = readFileSync(path, 'utf8');
    const replacement = `  <!-- issue-2723-buildkit-probe:${token} -->\n</Project>\n`;
    if (!/\s*<\/Project>\s*$/u.test(source))
    {
        fail('Directory.Build.props has no terminal Project element');
    }
    writeFileSync(path, source.replace(/\s*<\/Project>\s*$/u, `\n${replacement}`));
}

function createCandidateSnapshot(root, runtimeRoot)
{
    const trackedStatus = runRequired(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=no'],
        { cwd: root, description: 'candidate tracked-status check' }
    ).stdout.trim();
    if (trackedStatus)
    {
        fail('probe-buildkit requires a tracked-clean candidate');
    }
    const snapshot = join(runtimeRoot, 'candidate');
    const archive = join(runtimeRoot, 'candidate.tar');
    mkdirSync(snapshot, { recursive: true });
    runRequired('git', ['archive', '--format=tar', '--output', archive, 'HEAD'], {
        cwd: root,
        description: 'candidate Git archive'
    });
    runRequired('tar', ['-xf', archive, '-C', snapshot], { description: 'candidate archive extraction' });
    rmSync(archive);
    return snapshot;
}

function materializeProbeContext(snapshot, runtimeRoot, id, evidenceRoot)
{
    const context = join(runtimeRoot, `backend-inputs-${id}`);
    runRequired(
        process.execPath,
        [join(snapshot, 'tools/docker/backend-input-closure.mjs'), 'materialize', '--root', snapshot,
            '--target', 'publish-debug', '--configuration', 'Debug', '--runtime', 'linux-musl-x64', '--ready-to-run', 'false', '--output', context],
        { cwd: snapshot, description: `${id} backend input materialization` }
    );
    const closure = JSON.parse(readFileSync(join(context, 'closure.json'), 'utf8'));
    const receiptPath = closure.evaluationEvidence?.path;
    if (typeof receiptPath !== 'string' || !isWithin(receiptPath, join(snapshot, '.tmp/backend-input-evaluations')) ||
        digestFile(receiptPath) !== closure.evaluationEvidence.sha256)
    {
        fail(`${id} evaluation receipt does not bind the candidate materializer`);
    }
    const retained = join(evidenceRoot, `${id}.evaluation`);
    cpSync(dirname(receiptPath), retained, { recursive: true });
    closure.evaluationEvidence = {
        ...closure.evaluationEvidence,
        path: join(retained, 'execution.json'),
        originalPath: receiptPath,
        logDirectory: retained
    };
    return { context, closure };
}

function buildProbeImage(snapshot, context, id, tag, evidenceRoot, noCache)
{
    const metadataPath = join(evidenceRoot, `${id}.metadata.json`);
    const logPath = join(evidenceRoot, `${id}.buildkit.rawjson`);
    const args = [
        'buildx', 'build',
        '--progress=rawjson',
        '--load',
        '--network=host',
        '--target', 'publish-debug',
        '--build-arg', 'RUNTIME_BASE_FLAVOR=musl',
        '--build-arg', 'BUILD_CONFIGURATION=Debug',
        '--build-arg', 'TARGET_RUNTIME=linux-musl-x64',
        '--build-context', `backend-inputs=${context}`,
        '--metadata-file', metadataPath,
        '--tag', tag,
        '--file', join(snapshot, dockerfileRelativePath)
    ];
    if (noCache)
    {
        args.push('--no-cache');
    }
    args.push(snapshot);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const result = spawnSync('docker', args, {
        cwd: snapshot,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024
    });
    const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(logPath, raw);
    if (result.error)
    {
        fail(`${id} BuildKit build could not start: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        fail(`${id} BuildKit build failed with exit ${result.status}; see ${logPath}`);
    }
    const imageId = runRequired('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], {
        description: `${id} image inspection`
    }).stdout.trim();
    return {
        id,
        startedAt,
        durationMs: Date.now() - started,
        imageId,
        vertices: parseBuildkitProgress(raw),
        rawLog: { path: logPath, sha256: digestFile(logPath) },
        metadata: { path: metadataPath, sha256: digestFile(metadataPath) }
    };
}

function buildRootContextWitness(snapshot, runtimeRoot, tag, evidenceRoot, mutations)
{
    const dockerfile = join(runtimeRoot, 'root-context-witness.Dockerfile');
    const copies = Object.keys(mutations).map((source, index) =>
        `COPY ${JSON.stringify([source, `/root-context/input-${index}`])}`);
    writeFileSync(dockerfile, `# syntax=docker/dockerfile:1.7\nFROM scratch\n${copies.join('\n')}\n`);
    const metadataPath = join(evidenceRoot, 'root-context.metadata.json');
    const logPath = join(evidenceRoot, 'root-context.buildkit.rawjson');
    const result = spawnSync('docker', [
        'buildx', 'build',
        '--progress=rawjson',
        '--load',
        '--metadata-file', metadataPath,
        '--tag', tag,
        '--file', dockerfile,
        snapshot
    ], { cwd: snapshot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(logPath, raw);
    if (result.error)
    {
        fail(`root-context witness build could not start: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        fail(`root-context witness build failed with exit ${result.status}; see ${logPath}`);
    }

    const containerName = `fsusblog-issue-2723-context-${randomUUID().replaceAll('-', '')}`;
    const copiedRoot = join(runtimeRoot, 'root-context-copy');
    try
    {
        mkdirSync(copiedRoot);
        runRequired('docker', ['create', '--name', containerName, tag, '/bin/true'], {
            description: 'root-context witness container creation'
        });
        runRequired('docker', ['cp', `${containerName}:/root-context/.`, copiedRoot], {
            description: 'root-context witness extraction'
        });
        for (const [index, contents] of Object.values(mutations).entries())
        {
            if (readFileSync(join(copiedRoot, `input-${index}`), 'utf8') !== contents)
            {
                fail(`root-context witness input-${index} bytes changed`);
            }
        }
    }
    finally
    {
        spawnSync('docker', ['container', 'rm', '--force', containerName], { encoding: 'utf8' });
    }
    return {
        sourcePaths: Object.keys(mutations),
        rawLog: { path: logPath, sha256: digestFile(logPath) },
        metadata: { path: metadataPath, sha256: digestFile(metadataPath) }
    };
}

function assertSdkContext(tag, present, absent)
{
    const commands = [
        ...present.map(path => `test -f '${path}'`),
        ...absent.map(path => `test ! -e '${path}'`)
    ].join(' && ');
    runRequired('docker', ['run', '--rm', '--entrypoint', 'sh', tag, '-ceu', commands], {
        description: 'backend SDK context inspection'
    });
    return { present, absent };
}

function runBuildkitProbe(root, output)
{
    const outputPath = resolve(output);
    const evidenceRoot = `${outputPath}.d`;
    if (existsSync(outputPath) || existsSync(evidenceRoot))
    {
        fail('probe-buildkit output must not already exist');
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    mkdirSync(evidenceRoot);
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'fsusblog-backend-buildkit-'));
    const token = randomUUID().replaceAll('-', '');
    const tagPrefix = `fsusblog-issue-2723-probe-${token}`;
    const tags = [];
    try
    {
        const snapshot = createCandidateSnapshot(root, runtimeRoot);
        const revision = runRequired('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
        const tree = runRequired('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }).stdout.trim();
        const probes = {};

        let unrelatedMutations;
        for (const [id, noCache] of [['cold', true], ['unrelated', false]])
        {
            if (id === 'unrelated')
            {
                unrelatedMutations = {
                    '.env': `ISSUE_2723_SECRET_PROBE=${token}\n`,
                    'build/artifacts/wasm-release/issue-2723-probe-receipt.json': `{"probe":"${token}"}\n`,
                    'docs/issue-2723-buildkit-probe.md': `${token}\n`,
                    'src/frontend/src/issue2723BuildkitProbe.ts': `export const issue2723Probe = '${token}'\n`,
                    'tests/tools/issue-2723-buildkit-probe.test.mjs': `// ${token}\n`,
                    'tools/issue-2723-buildkit-probe.mjs': `// ${token}\n`
                };
                for (const [path, contents] of Object.entries(unrelatedMutations))
                {
                    writeMutation(snapshot, path, contents);
                }
                const dockerignore = join(snapshot, '.dockerignore');
                writeFileSync(dockerignore, `${readFileSync(dockerignore, 'utf8')}\n!.env\n`);
            }
            const materialized = materializeProbeContext(snapshot, runtimeRoot, id, evidenceRoot);
            const tag = `${tagPrefix}-${id}`;
            tags.push(tag);
            probes[id] = {
                ...buildProbeImage(snapshot, materialized.context, id, tag, evidenceRoot, noCache),
                closure: materialized.closure,
                cacheKeys: Object.fromEntries(Object.entries(materialized.closure.domains).map(
                    ([domain, value]) => [domain, value.digest]
                ))
            };
        }

        const unrelatedPaths = [
            '/src/.env',
            '/src/.dockerignore',
            '/src/build/artifacts/wasm-release/issue-2723-probe-receipt.json',
            '/src/docs/issue-2723-buildkit-probe.md',
            '/src/src/frontend/src/issue2723BuildkitProbe.ts',
            '/src/tests/tools/issue-2723-buildkit-probe.test.mjs',
            '/src/tools/issue-2723-buildkit-probe.mjs'
        ];
        probes.unrelated.sdkContext = assertSdkContext(
            `${tagPrefix}-unrelated`,
            ['/src/src/backend/Program.cs', '/src/.backend-input-profile', '/src/.backend-publish-profile', '/src/config/build/backend-restore.xml'],
            unrelatedPaths
        );
        const expectedSdkFiles = {
            '/src/.backend-input-profile': createHash('sha256').update(profileMarker(probes.unrelated.closure.evaluationProperties)).digest('hex'),
            '/src/.backend-publish-profile': createHash('sha256').update(publishProfileMarker(probes.unrelated.closure.evaluationProperties)).digest('hex'),
            '/src/config/build/backend-restore.xml': createHash('sha256').update(readFileSync(join(root, 'config/build/backend-restore.xml'))).digest('hex')
        };
        const sdkHashes = runRequired('docker', ['run', '--rm', '--entrypoint', 'sha256sum',
            `${tagPrefix}-unrelated`, ...Object.keys(expectedSdkFiles)], { description: 'SDK profile/config byte witness' }).stdout;
        validateSdkFileHashes(expectedSdkFiles, sdkHashes);
        probes.unrelated.sdkContext.profileAndRestoreConfigHashes = expectedSdkFiles;
        const rootContextTag = `${tagPrefix}-root-context`;
        tags.push(rootContextTag);
        probes.unrelated.rootContextWitness = buildRootContextWitness(
            snapshot,
            runtimeRoot,
            rootContextTag,
            evidenceRoot,
            unrelatedMutations
        );

        const backendProbePath = `src/backend/Issue2723BuildkitProbe${token}.cs`;
        writeMutation(snapshot, backendProbePath, [
            'namespace FsusBlog.BuildInputProbe;',
            '',
            `internal static class Issue2723BuildkitProbe${token}`,
            '{',
            `    internal const string Marker = "${token}";`,
            '}',
            ''
        ].join('\n'));
        let materialized = materializeProbeContext(snapshot, runtimeRoot, 'backend-source', evidenceRoot);
        let tag = `${tagPrefix}-backend-source`;
        tags.push(tag);
        probes['backend-source'] = {
            ...buildProbeImage(snapshot, materialized.context, 'backend-source', tag, evidenceRoot, false),
            closure: materialized.closure,
            cacheKeys: Object.fromEntries(Object.entries(materialized.closure.domains).map(
                ([domain, value]) => [domain, value.digest]
            )),
            mutation: backendProbePath
        };
        probes['backend-source'].sdkContext = assertSdkContext(
            tag,
            [`/src/${backendProbePath}`],
            unrelatedPaths
        );

        appendXmlComment(join(snapshot, 'Directory.Build.props'), token);
        materialized = materializeProbeContext(snapshot, runtimeRoot, 'msbuild-import', evidenceRoot);
        tag = `${tagPrefix}-msbuild-import`;
        tags.push(tag);
        probes['msbuild-import'] = {
            ...buildProbeImage(snapshot, materialized.context, 'msbuild-import', tag, evidenceRoot, false),
            closure: materialized.closure,
            cacheKeys: Object.fromEntries(Object.entries(materialized.closure.domains).map(
                ([domain, value]) => [domain, value.digest]
            )),
            mutation: 'Directory.Build.props'
        };

        verifyBuildkitProbeRelationships(probes);
        const relativeEvidenceRoot = relative(dirname(outputPath), evidenceRoot).split(sep).join('/');
        for (const probe of Object.values(probes))
        {
            probe.rawLog.path = `${relativeEvidenceRoot}/${probe.id}.buildkit.rawjson`;
            probe.metadata.path = `${relativeEvidenceRoot}/${probe.id}.metadata.json`;
        }
        probes.unrelated.rootContextWitness.rawLog.path = `${relativeEvidenceRoot}/root-context.buildkit.rawjson`;
        probes.unrelated.rootContextWitness.metadata.path = `${relativeEvidenceRoot}/root-context.metadata.json`;
        const filesystem = statfsSync(root, { bigint: true });
        const receipt = {
            schema: 'fsusblog.backend-docker-input-buildkit-probe.v1',
            status: 'passed',
            createdAtUtc: new Date().toISOString(),
            source: {
                revision,
                tree,
                dockerfileSha256: digestFile(join(root, dockerfileRelativePath)),
                inventorySha256: digestFile(join(root, inventoryRelativePath)),
                checkerSha256: digestFile(join(root, 'tools/docker/backend-input-closure.mjs'))
            },
            environment: {
                dockerVersion: runRequired('docker', ['version', '--format', '{{.Client.Version}}/{{.Server.Version}}']).stdout.trim(),
                buildxVersion: runRequired('docker', ['buildx', 'version']).stdout.trim(),
                availableBytesBeforeImageCleanup: String(filesystem.bavail * filesystem.bsize)
            },
            probes,
            assertions: {
                unrelatedInputsPreserveBackendClosureKeysAndCache: true,
                backendSourceInvalidatesCompileAndPublish: true,
                msbuildImportInvalidatesRestoreAndPublish: true,
                secretAndUnrelatedInputsPresentInRootContext: true,
                sdkContextExcludesSecretAndUnrelatedInputs: true
            }
        };
        writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
        return receipt;
    }
    finally
    {
        for (const tag of tags)
        {
            spawnSync('docker', ['image', 'rm', '--force', tag], { encoding: 'utf8' });
        }
        rmSync(runtimeRoot, { recursive: true, force: true });
    }
}

export function validateSdkFileHashes(expected, output)
{
    const lines = output.trim().split(/\r?\n/u);
    const actual = {};
    for (const line of lines)
    {
        const match = /^([a-f0-9]{64}) {2}(\/src\/[^\r\n]+)$/u.exec(line);
        if (!match || Object.hasOwn(actual, match[2]))
        {
            fail('invalid SDK byte witness');
        }
        actual[match[2]] = match[1];
    }
    if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort()))
    {
        fail('SDK profile/config byte witness mismatch');
    }
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const root = realpathSync(resolve(options.root));
    const inventory = loadInventory(root);
    inventory.evaluationProperties = requestedEvaluationProfile(inventory, options);
    inventory.restoreEvaluationProperties = { Configuration: inventory.evaluationProperties.Configuration,
        RuntimeIdentifier: inventory.evaluationProperties.RuntimeIdentifier,
        PublishReadyToRun: inventory.evaluationProperties.PublishReadyToRun,
        ReadyToRunUseCrossgen2: inventory.evaluationProperties.PublishReadyToRun };
    assertDockerfile(root);
    assertBuildScript(root);
    const { evaluateBackendEnvironment } = await import('./backend-input-environment.mjs');
    const { closure, evidence } = await evaluateBackendEnvironment(root, inventory, backendAncestorFiles);
    const summary = {
        schema: 'fsusblog.backend-docker-input-closure.v1',
        inventory: inventoryRelativePath,
        evaluationEvidence: evidence,
        evaluationProperties: inventory.evaluationProperties,
        restoreEvaluationProperties: inventory.restoreEvaluationProperties,
        profileDigest: createHash('sha256').update(profileMarker(inventory.evaluationProperties))
            .update(publishProfileMarker(inventory.evaluationProperties)).digest('hex'),
        domains: Object.fromEntries(Object.entries(closure).map(([domain, paths]) => [domain, {
            count: paths.length,
            digest: domain === 'restore' ? `sha256:${createHash('sha256').update(digestDomain(root, paths))
        .update(profileMarker(inventory.evaluationProperties)).update(publishProfileMarker(inventory.evaluationProperties)).digest('hex')}` : digestDomain(root, paths),
            paths
        }]))
    };

    if (options.command === 'probe-buildkit')
    {
        const receipt = runBuildkitProbe(root, options.output);
        console.log(`[backend-input-closure] BuildKit probe passed revision=${receipt.source.revision}`);
        return;
    }
    if (options.command === 'materialize')
    {
        const output = resolve(options.output);
        if (existsSync(output) && readdirSync(output).length > 0)
        {
            fail(`refusing non-empty output directory: ${output}`);
        }
        mkdirSync(output, { recursive: true });
        for (const [domain, paths] of Object.entries(closure))
        {
            copyDomain(root, output, domain, paths);
        }
        writeFileSync(join(output, 'restore', '.backend-input-profile'), profileMarker(inventory.evaluationProperties));
        writeFileSync(join(output, 'restore', '.backend-publish-profile'), publishProfileMarker(inventory.evaluationProperties));
        writeFileSync(join(output, 'closure.json'), `${JSON.stringify(summary, null, 2)}\n`);
    }
    if (options.command === 'print')
    {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
    else
    {
        console.log(`[backend-input-closure] ok restore=${closure.restore.length} compile=${closure.compile.length} publish=${closure.publish.length}`);
    }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
{
    try
    {
        await main();
    }
    catch (error)
    {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
