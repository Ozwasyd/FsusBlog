#!/usr/bin/env node
/**
 * Canonical test-surface discovery for the repository test inventory.
 *
 * Membership is projected from four authorities:
 *   1. directory closure (tests/backend, tests/migration, tests/frontend, tests/tools,
 *      tests/native, tests/security);
 *   2. matrix tier commands, evidence and artifacts;
 *   3. the coverage registry evidence paths;
 *   4. the backend requirement catalog profile commands/evidence paths.
 * Adapter capability decides the final classification. A referenced
 * executable entrypoint that has no adapter record (or is classified as a
 * non-executable support/fixture surface) fails closed.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ADAPTER_VERSION, SUPPORT_CLASSIFICATION, classifyFile, classifyXunitCompileOwner, xunitCompileDeclaration, xunitGeneratedCompilePathIsOwned, xunitTestProjects } from './adapters.mjs';
import { INVENTORY_SCHEMA, validateInventoryArtifact } from './schema.mjs';

const { parseMatrix } = await import(new URL('../test-matrix/parse-matrix.mjs', import.meta.url));

export const DIRECTORY_CLOSURE = [
    ...xunitTestProjects.map(({ directory }) => directory),
    'tests/frontend',
    'tests/tools',
    'tests/native',
    'tests/security'
];

// Canonical tooling test surface. These trees are declared by matrix/coverage
// requirement governance as executable test evidence; the membership rule
// mirrors the historical retention closure so the replacement ledger stays
// authoritative.
export const TOOLS_DIRECTORY_CLOSURE = [
    'tools/test',
    'tools/coverage',
    'tools/security'
];

const TOOLS_ROOT_CHECK_FILES = /^tools\/check-.*\.(?:mjs|sh)$/u;
const TOOLS_EXACT_FILES = [
    'tools/docs/generate-testing-docs.mjs',
    'tools/check-workflow-matrix-sync.mjs',
    'tools/run-test-matrix.mjs'
];

const WALK_IGNORE_DIRS = new Set([
    'bin',
    'obj',
    'node_modules',
    'coverage',
    'test-results',
    'TestResults',
    'playwright-report',
    'dist',
    '.tmp',
    '.artifacts'
]);

const EXECUTABLE_EXTENSIONS = new Set([
    '.sh',
    '.mjs',
    '.js',
    '.cjs',
    '.mts',
    '.ts',
    '.ps1'
]);

const DECLARATION_DIRECTORY = 'directory';

function sha256(value)
{
    return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function fileDigest(absolutePath)
{
    return sha256(readFileSync(absolutePath));
}

export function canonicalStringify(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object')
    {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
    }
    if (typeof value === 'string')
    {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean')
    {
        return String(value);
    }
    return 'null';
}

function walkFiles(root, relativeDirectory, results = new Map())
{
    const absolute = path.join(root, relativeDirectory);
    if (!existsSync(absolute))
    {
        return results;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true }))
    {
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory())
        {
            if (WALK_IGNORE_DIRS.has(entry.name))
            {
                continue;
            }
            walkFiles(root, relative, results);
        }
        else if (entry.isFile())
        {
            const bucket = results.get(relative) ?? { declaredBy: new Set(), executable: false };
            bucket.declaredBy.add(DECLARATION_DIRECTORY);
            results.set(relative, bucket);
        }
    }
    return results;
}

function collectToolsClosure(root, results)
{
    const addFile = (relative) =>
    {
        const bucket = results.get(relative) ?? { declaredBy: new Set(), executable: false };
        bucket.declaredBy.add(DECLARATION_DIRECTORY);
        results.set(relative, bucket);
    };
    for (const directory of TOOLS_DIRECTORY_CLOSURE)
    {
        const absolute = path.join(root, directory);
        if (!existsSync(absolute))
        {
            continue;
        }
        const predicate = directory === 'tools/security'
            ? (file) => /\.mjs$/u.test(file) && /\/check-[^/]+$/u.test(file)
            : (file) => /\.(?:sh|mjs)$/u.test(file);
        const files = walkFiles(root, directory, new Map());
        for (const relative of files.keys())
        {
            if (predicate(relative))
            {
                addFile(relative);
            }
        }
    }
    if (existsSync(path.join(root, 'tools')))
    {
        for (const entry of readdirSync(path.join(root, 'tools'), { withFileTypes: true }))
        {
            const relative = `tools/${entry.name}`;
            if (entry.isFile() && TOOLS_ROOT_CHECK_FILES.test(relative))
            {
                addFile(relative);
            }
        }
    }
    for (const relative of TOOLS_EXACT_FILES)
    {
        if (existsSync(path.join(root, relative)))
        {
            addFile(relative);
        }
    }
}

function commandReferencedFiles(command)
{
    const refs = [];
    for (const token of String(command ?? '').split(/\s+/))
    {
        const normalized = token.replace(/^['"]|['"]$/g, '').replace(/\\$/, '').replace(/^\.\//, '');
        if (!/^(tools|tests)\//u.test(normalized))
        {
            continue;
        }
        refs.push(normalized);
    }
    return refs;
}

function matrixProjections(matrix)
{
    const refs = [];
    const tierIds = [];
    for (const tier of matrix.tiers ?? [])
    {
        tierIds.push(tier.id);
        for (const file of commandReferencedFiles(tier.command))
        {
            refs.push({ path: file, declaration: `matrix:command:${tier.id}` });
        }
        for (const pathValue of [...(tier.evidence ?? []), ...(tier.artifacts ?? [])])
        {
            if (typeof pathValue !== 'string' || pathValue.startsWith('.tmp/') || pathValue.includes('*'))
            {
                continue;
            }
            if (!/^(tools|tests)\//u.test(pathValue))
            {
                continue;
            }
            const declaration = (tier.evidence ?? []).includes(pathValue)
                ? `matrix:evidence:${tier.id}`
                : `matrix:artifact:${tier.id}`;
            refs.push({ path: pathValue, declaration });
        }
    }
    return { refs, tierIds };
}

function addProjectedPath(root, relative, declaration, candidates)
{
    const absolute = path.join(root, relative);
    if (!existsSync(absolute))
    {
        return;
    }
    if (statSync(absolute).isDirectory())
    {
        const files = walkFiles(root, relative, new Map());
        for (const file of files.keys())
        {
            const bucket = candidates.get(file) ?? { declaredBy: new Set(), executable: false };
            bucket.declaredBy.add(declaration);
            candidates.set(file, bucket);
        }
        return;
    }
    if (!statSync(absolute).isFile())
    {
        return;
    }
    const bucket = candidates.get(relative) ?? { declaredBy: new Set(), executable: false };
    bucket.declaredBy.add(declaration);
    candidates.set(relative, bucket);
}

function coverageProjections(coverageRegistry)
{
    const refs = [];
    const coverageIds = [];
    for (const entry of coverageRegistry.entries ?? [])
    {
        coverageIds.push(entry.id);
        for (const pathValue of entry.evidencePaths ?? [])
        {
            if (typeof pathValue !== 'string' || pathValue.startsWith('.tmp/') || pathValue.includes('*'))
            {
                continue;
            }
            if (!/^(tools|tests)\//u.test(pathValue))
            {
                continue;
            }
            refs.push({ path: pathValue, declaration: `coverage:${entry.id}` });
        }
    }
    return { refs, coverageIds };
}

function requirementProjections(requirementCatalog)
{
    const refs = [];
    const profileIds = [];
    for (const profile of requirementCatalog.profiles ?? [])
    {
        profileIds.push(profile.id);
        for (const file of commandReferencedFiles(profile.command))
        {
            refs.push({ path: file, declaration: `requirement:command:${profile.id}` });
        }
        for (const pathValue of profile.evidencePaths ?? [])
        {
            if (typeof pathValue !== 'string' || pathValue.startsWith('.tmp/') || pathValue.includes('*'))
            {
                continue;
            }
            if (!/^(tools|tests)\//u.test(pathValue))
            {
                continue;
            }
            refs.push({ path: pathValue, declaration: `requirement:evidence:${profile.id}` });
        }
    }
    return { refs, profileIds };
}

function gitCommit(root)
{
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0)
    {
        return null;
    }
    const commit = String(result.stdout ?? '').trim();
    return /^[0-9a-f]{40}$/u.test(commit) ? commit : null;
}

export function collectClosureCandidates(root, matrix, coverageRegistry, requirementCatalog)
{
    const candidates = new Map();
    for (const directory of DIRECTORY_CLOSURE)
    {
        if (existsSync(path.join(root, directory)))
        {
            walkFiles(root, directory, candidates);
        }
    }
    collectToolsClosure(root, candidates);

    const matrixProjection = matrixProjections(matrix);
    for (const ref of matrixProjection.refs)
    {
        addProjectedPath(root, ref.path, ref.declaration, candidates);
    }

    const coverageProjection = coverageProjections(coverageRegistry);
    for (const ref of coverageProjection.refs)
    {
        addProjectedPath(root, ref.path, ref.declaration, candidates);
    }

    const requirementProjection = requirementProjections(requirementCatalog);
    for (const ref of requirementProjection.refs)
    {
        addProjectedPath(root, ref.path, ref.declaration, candidates);
    }

    return {
        candidates,
        matrixTierIds: matrixProjection.tierIds,
        coverageIds: coverageProjection.coverageIds,
        requirementProfileIds: requirementProjection.profileIds
    };
}

/**
 * Compute the canonical inventory artifact for a repository root.
 * Deterministic for identical source, matrix and catalog inputs.
 */
const XUNIT_ADAPTER_PROJECT = 'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj';

// Read only a canonical repository-owned file selected by the actual Compile graph.
export function observeXunitCompileSource(root, relative)
{
    if (typeof relative !== 'string' || !relative.endsWith('.cs') || path.isAbsolute(relative)
        || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..'))
    {
        throw new Error(`xunit Compile source is outside its canonical repository boundary: ${relative}`);
    }
    const repository = path.resolve(root);
    if (realpathSync(repository) !== repository)
    {
        throw new Error('xunit Compile repository root cannot be a path alias');
    }
    let cursor = repository;
    for (const part of relative.split('/'))
    {
        cursor = path.join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`xunit Compile source cannot use path aliases: ${relative}`);
        }
    }
    const prior = lstatSync(cursor);
    if (!prior.isFile() || prior.nlink !== 1 || realpathSync(cursor) !== cursor)
    {
        throw new Error(`xunit Compile source requires its current regular owned file: ${relative}`);
    }
    const descriptor = openSync(cursor, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try
    {
        const held = fstatSync(descriptor);
        const current = lstatSync(cursor);
        if (!held.isFile() || held.nlink !== 1 || held.dev !== current.dev || held.ino !== current.ino
            || current.dev !== prior.dev || current.ino !== prior.ino || realpathSync(cursor) !== cursor)
        {
            throw new Error(`xunit Compile source requires its current regular owned file: ${relative}`);
        }
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        const final = lstatSync(cursor);
        if (after.size !== bytes.length || held.size !== after.size || held.mtimeMs !== after.mtimeMs || held.ctimeMs !== after.ctimeMs
            || after.nlink !== 1 || realpathSync(cursor) !== cursor || final.dev !== after.dev || final.ino !== after.ino || final.isSymbolicLink())
        {
            throw new Error(`xunit Compile source changed during observation: ${relative}`);
        }
        return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    }
    finally
    {
        closeSync(descriptor);
    }
}

export function requireXunitConfiguration(configuration = 'Debug')
{
    if (!['Debug', 'Release'].includes(configuration))
    {
        throw new Error(`unsupported xunit configuration: ${configuration}`);
    }
    return configuration;
}

// This projects the result of a real MSBuild observation; it grants no SDK execution.
export function projectXunitCompileContext(root, project, context, configuration = 'Debug')
{
    requireXunitConfiguration(configuration);
    if (context.Properties?.Configuration !== configuration)
    {
        throw new Error(`xunit compile configuration differs for ${project.project}`);
    }
    const output = context.Properties?.TargetPath;
    const intermediate = context.Properties?.IntermediateOutputPath;
    const projectDirectory = path.dirname(path.resolve(root, project.project));
    const resolvedIntermediate = typeof intermediate === 'string' && intermediate.trim()
        ? path.resolve(projectDirectory, intermediate.replaceAll('\\', path.sep)) : null;
    const relativeIntermediate = resolvedIntermediate ? path.relative(path.resolve(root), resolvedIntermediate) : null;
    if (resolvedIntermediate && (relativeIntermediate === '..'
        || relativeIntermediate.startsWith(`..${path.sep}`) || path.isAbsolute(relativeIntermediate)
        || (path.sep === '/' && /^[A-Za-z]:/u.test(intermediate))))
    {
        throw new Error(`xunit intermediate context is outside its canonical repository boundary for ${project.project}`);
    }
    if (typeof output !== 'string' || !path.isAbsolute(output)
        || !existsSync(output) || !statSync(output).isFile()
        || !resolvedIntermediate || !existsSync(path.join(resolvedIntermediate, path.basename(output)))
        || !statSync(path.join(resolvedIntermediate, path.basename(output))).isFile())
    {
        throw new Error(`xunit project ${configuration} build output or intermediate context is missing for ${project.project}`);
    }
    if (realpathSync(path.join(resolvedIntermediate, path.basename(output)))
        !== path.join(resolvedIntermediate, path.basename(output)))
    {
        throw new Error(`xunit intermediate context cannot use a path alias for ${project.project}`);
    }
    if (!Array.isArray(context.Items?.Compile) || context.Items.Compile.length === 0)
    {
        throw new Error(`xunit project compile items are missing for ${project.project}`);
    }
    const sources = context.Items.Compile.map((item) =>
    {
        if (typeof item.FullPath !== 'string' || !path.isAbsolute(item.FullPath)
            || !item.FullPath.endsWith('.cs') || !existsSync(item.FullPath) || !statSync(item.FullPath).isFile())
        {
            throw new Error(`xunit compiled source is missing for ${project.project}: ${item.FullPath ?? '<missing FullPath>'}`);
        }
        return path.relative(root, item.FullPath).split(path.sep).join('/');
    });
    if (new Set(sources).size !== sources.length)
    {
        throw new Error(`xunit duplicate compiled source in ${project.project}`);
    }
    return { project, sources, output, intermediateOutput: path.join(resolvedIntermediate, path.basename(output)), configuration,
        sourceDigests: Object.fromEntries(sources.map((file) => [file, observeXunitCompileSource(root, file)])) };
}

export function readXunitProjectContext(root, project, configuration = 'Debug')
{
    requireXunitConfiguration(configuration);
    const args = ['msbuild', path.join(root, project.project), '--nologo', '-verbosity:quiet',
        `-property:Configuration=${configuration}`, '-property:BuildProjectReferences=false',
        '-getProperty:Configuration,TargetPath,IntermediateOutputPath', '-getItem:Compile'];
    const evaluate = (compile) =>
    {
        const evaluation = spawnSync('dotnet', [...args, ...(compile
            ? ['-target:Compile', '-property:SkipCompilerExecution=true', '-property:UseSharedCompilation=false'] : [])],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (evaluation.status !== 0)
        {
            throw new Error(`xunit project context failed for ${project.project}: ${evaluation.stderr || evaluation.stdout || evaluation.error?.message}`);
        }
        return projectXunitCompileContext(root, project, JSON.parse(evaluation.stdout), configuration);
    };
    const prior = evaluate(false);
    const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const priorOutputDigest = digest(prior.output);
    const priorIntermediateDigest = digest(prior.intermediateOutput);
    const current = evaluate(true);
    if (current.output !== prior.output || current.intermediateOutput !== prior.intermediateOutput
        || digest(current.output) !== priorOutputDigest || digest(current.intermediateOutput) !== priorIntermediateDigest)
    {
        throw new Error(`xunit Compile changed its previously built output context for ${project.project}`);
    }
    return current;
}

export function mergeXunitProjectResults(results, sourceFiles)
{
    const ownedFiles = new Set(sourceFiles.filter((file) => file.adapter === 'xunit').map((file) => file.path));
    const sourceOwners = new Map();
    const caseOwners = new Set();
    const testCases = [];
    const diagnostics = [];
    for (const { project, sources, report } of results)
    {
        for (const file of sources)
        {
            if (sourceOwners.has(file))
            {
                throw new Error(`xunit duplicate source ownership for ${file}: ${sourceOwners.get(file)} and ${project.project}`);
            }
            sourceOwners.set(file, project.project);
        }
        if (report.schema !== 'fsusblog.test-inventory.xunit-roslyn.v1' || !Array.isArray(report.testCases) || !Array.isArray(report.diagnostics))
        {
            throw new Error(`xunit invalid project report for ${project.project}`);
        }
        if (report.diagnostics.some((entry) => entry.severity === 'error'))
        {
            throw new Error(`xunit project semantic context failed for ${project.project}: ${JSON.stringify(report.diagnostics)}`);
        }
        for (const testCase of report.testCases)
        {
            if (caseOwners.has(testCase.id))
            {
                throw new Error(`xunit duplicate case identity: ${testCase.id}`);
            }
            caseOwners.add(testCase.id);
            if (!sources.includes(testCase.ownerFile))
            {
                throw new Error(`xunit case source is not owned by ${project.project}: ${testCase.ownerFile}`);
            }
            if (!ownedFiles.has(testCase.ownerFile))
            {
                throw new Error(`xunit case source is not registered in canonical inventory: ${testCase.ownerFile}`);
            }
            testCases.push(testCase);
        }
        diagnostics.push(...report.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity === 'error' ? 'error' : 'warning',
            code: diagnostic.code,
            file: diagnostic.file ?? null,
            message: diagnostic.message
        })));
    }
    return { testCases, diagnostics };
}

/** Enroll only actual case owners from the selected, byte-bound Compile result. */
export function enrollAndMergeXunitProjectResults(root, results, sourceFiles, configuration = 'Debug')
{
    const owners = new Map();
    const enrollments = new Map();
    for (const result of results)
    {
        const declaration = xunitCompileDeclaration(result.project, configuration);
        if (result.configuration !== configuration || !result.sourceDigests)
        {
            throw new Error('xunit Compile enrollment requires its selected configuration and source observation');
        }
        for (const file of result.sources)
        {
            if (owners.has(file))
            {
                throw new Error(`xunit duplicate source ownership for ${file}`);
            }
            owners.set(file, result.project.project);
            if (observeXunitCompileSource(root, file) !== result.sourceDigests[file])
            {
                throw new Error(`xunit selected Compile source bytes changed: ${file}`);
            }
        }
        if (result.report.schema !== 'fsusblog.test-inventory.xunit-roslyn.v1'
            || !Array.isArray(result.report.testCases) || !Array.isArray(result.report.diagnostics)
            || result.report.diagnostics.some((entry) => entry.severity === 'error'))
        {
            throw new Error(`xunit project semantic context failed for ${result.project.project}`);
        }
        for (const testCase of result.report.testCases)
        {
            const file = testCase.ownerFile;
            if (!result.sources.includes(file))
            {
                throw new Error(`xunit case source is not owned by ${result.project.project}: ${file}`);
            }
            if (file.split('/').includes('obj') || file.startsWith('.tmp/'))
            {
                const intermediate = path.dirname(result.intermediateOutput ?? '');
                const absolute = path.resolve(root, file);
                if (!path.isAbsolute(intermediate) || !absolute.startsWith(`${intermediate}${path.sep}`)
                    || !xunitGeneratedCompilePathIsOwned(file, { project: result.project, configuration }))
                {
                    throw new Error(`xunit generated case is outside its selected intermediate owner: ${file}`);
                }
            }
            enrollments.set(file, { declaration, digest: result.sourceDigests[file] });
        }
    }
    // No mutation until all projects and byte observations have been admitted.
    for (const [file, enrollment] of enrollments)
    {
        const existing = sourceFiles.find((source) => source.path === file);
        if (existing && !['xunit', 'xunit-support', 'support'].includes(existing.adapter))
        {
            throw new Error(`xunit Compile case conflicts with an existing source owner: ${file}`);
        }
        if (existing && existing.sourceDigest !== enrollment.digest)
        {
            throw new Error(`xunit catalog source bytes changed before Compile enrollment: ${file}`);
        }
        const record = { path: file, ...classifyXunitCompileOwner(), sourceDigest: enrollment.digest,
            declaredBy: [...new Set([...(existing?.declaredBy ?? []), enrollment.declaration])].sort() };
        if (existing)
        {
            Object.assign(existing, record);
        }
        else
        {
            sourceFiles.push(record);
        }
    }
    sourceFiles.sort((left, right) => left.path.localeCompare(right.path));
    return mergeXunitProjectResults(results, sourceFiles);
}

function runXunitRoslynAdapter(root, projectPath, configuration)
{
    const adapterProject = path.join(root, XUNIT_ADAPTER_PROJECT);
    if (!existsSync(adapterProject))
    {
        throw new Error(`xunit adapter project is not present at ${XUNIT_ADAPTER_PROJECT}; cannot extract ${projectPath}`);
    }
    const build = spawnSync(
        'dotnet',
        ['build', adapterProject, '--configuration', configuration, '-v:q'],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    if (build.status !== 0)
    {
        const detail = String(build.stderr || build.stdout || build.error?.message || '')
            .trim()
            .split(/\r?\n/u)
            .slice(-12)
            .join('\n');
        throw new Error(`xunit roslyn adapter build failed (exit ${build.status}): ${detail}`);
    }
    const result = spawnSync(
        'dotnet',
        [
            'run',
            '--project',
            adapterProject,
            '--configuration',
            configuration,
            '--no-build',
            '--no-launch-profile',
            '--',
            root,
            path.join(root, projectPath),
            '--configuration',
            configuration
        ],
        { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
    );
    if (result.status !== 0)
    {
        const detail = String(result.stderr || result.stdout || result.error?.message || '')
            .trim()
            .split(/\r?\n/u)
            .slice(-12)
            .join('\n');
        throw new Error(`xunit roslyn adapter failed for ${projectPath} (exit ${result.status}): ${detail}`);
    }
    let report;
    try
    {
        report = JSON.parse(result.stdout);
    }
    catch (error)
    {
        throw new Error(
            `xunit roslyn adapter output is not valid JSON: ${error.message}`,
            { cause: error }
        );
    }
    return report;
}

const TS_ADAPTER_ENTRY = 'tools/test-inventory/ts-ast-adapter/index.mjs';

function runTsAstAdapter(root, sourceFiles)
{
    const tsFiles = sourceFiles.filter((file) => (
        file.adapter === 'vitest' || file.adapter === 'node-test' || file.adapter === 'playwright'
    ));
    if (tsFiles.length === 0)
    {
        return { testCases: [], suiteRecords: [], diagnostics: [] };
    }
    const adapterEntry = path.join(root, TS_ADAPTER_ENTRY);
    if (!existsSync(adapterEntry))
    {
        return {
            testCases: [],
            suiteRecords: [],
            diagnostics: [{
                severity: 'warning',
                code: 'ts-ast-adapter-unavailable',
                file: null,
                message: `ts adapter entry is not present at ${TS_ADAPTER_ENTRY}; JS/TS cases were not extracted`
            }]
        };
    }
    const requestDir = path.join(root, '.tmp');
    mkdirSync(requestDir, { recursive: true });
    const requestPath = path.join(requestDir, 'ts-ast-adapter-request.json');
    writeFileSync(requestPath, JSON.stringify({
        root,
        files: tsFiles.map((file) => ({ path: file.path, adapter: file.adapter }))
    }));
    const result = spawnSync(
        process.execPath,
        [adapterEntry, requestPath],
        { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
    );
    if (result.status !== 0)
    {
        const detail = String(result.stderr ?? result.stdout ?? '').trim().split(/\r?\n/u).slice(-12).join('\n');
        throw new Error(`ts ast adapter failed (exit ${result.status}): ${detail}`);
    }
    let report;
    try
    {
        report = JSON.parse(result.stdout);
    }
    catch (error)
    {
        throw new Error(
            `ts ast adapter output is not valid JSON: ${error.message}`,
            { cause: error }
        );
    }
    const ownedFiles = new Set(tsFiles.map((file) => file.path));
    const testCases = (report.testCases ?? []).filter((testCase) => ownedFiles.has(testCase.ownerFile));
    const suiteRecords = (report.suiteRecords ?? []).filter((suite) => ownedFiles.has(suite.file));
    const diagnostics = (report.diagnostics ?? []).map((diagnostic) => ({
        severity: diagnostic.severity === 'error' ? 'error' : 'warning',
        code: diagnostic.code,
        file: diagnostic.file ?? null,
        message: diagnostic.message
    }));
    return { testCases, suiteRecords, diagnostics };
}

const NATIVE_ENTRY_ADAPTER_ENTRY = 'tools/test-inventory/native-entry-adapter/index.mjs';
const NATIVE_ENTRY_ADAPTERS = new Set([
    'native-smoke',
    'native-fuzz',
    'native-cmake',
    'native-corpus',
    'node-script',
    'shell'
]);

function runNativeEntryAdapter(root, sourceFiles, matrix)
{
    const nativeFiles = sourceFiles.filter((file) => NATIVE_ENTRY_ADAPTERS.has(file.adapter));
    if (nativeFiles.length === 0)
    {
        return { testCases: [], diagnostics: [] };
    }
    const adapterEntry = path.join(root, NATIVE_ENTRY_ADAPTER_ENTRY);
    if (!existsSync(adapterEntry))
    {
        return {
            testCases: [],
            diagnostics: [{
                severity: 'warning',
                code: 'native-entry-adapter-unavailable',
                file: null,
                message: `native entry adapter is not present at ${NATIVE_ENTRY_ADAPTER_ENTRY}; native/shell cases were not extracted`
            }]
        };
    }
    const requestDir = path.join(root, '.tmp');
    mkdirSync(requestDir, { recursive: true });
    const requestPath = path.join(requestDir, 'native-entry-adapter-request.json');
    writeFileSync(requestPath, JSON.stringify({
        root,
        files: nativeFiles.map((file) => ({
            path: file.path,
            adapter: file.adapter,
            declaredBy: file.declaredBy
        })),
        matrixTiers: (matrix.tiers ?? []).map((tier) => ({
            id: tier.id,
            command: tier.command,
            evidence: tier.evidence ?? [],
            artifacts: tier.artifacts ?? []
        }))
    }));
    const result = spawnSync(
        process.execPath,
        [adapterEntry, requestPath],
        { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
    );
    if (result.status !== 0)
    {
        const detail = String(result.stderr ?? result.stdout ?? '').trim().split(/\r?\n/u).slice(-12).join('\n');
        throw new Error(`native entry adapter failed (exit ${result.status}): ${detail}`);
    }
    let report;
    try
    {
        report = JSON.parse(result.stdout);
    }
    catch (error)
    {
        throw new Error(
            `native entry adapter output is not valid JSON: ${error.message}`,
            { cause: error }
        );
    }
    const ownedFiles = new Set(nativeFiles.map((file) => file.path));
    const testCases = (report.testCases ?? []).filter((testCase) => ownedFiles.has(testCase.ownerFile));
    const diagnostics = (report.diagnostics ?? []).map((diagnostic) => ({
        severity: diagnostic.severity === 'error' ? 'error' : 'warning',
        code: diagnostic.code,
        file: diagnostic.file ?? null,
        message: diagnostic.message
    }));
    return { testCases, diagnostics };
}

export function discoverTestInventory(root, { includeSourceState = true, runAdapters = true, configuration = 'Debug' } = {})
{
    requireXunitConfiguration(configuration);
    const matrixText = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const matrix = parseMatrix(matrixText);
    const coverageRegistry = JSON.parse(readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'));
    const requirementCatalog = JSON.parse(
        readFileSync(path.join(root, 'tests/backend/Fixtures/backend-test-requirements.json'), 'utf8')
    );

    const { candidates, matrixTierIds, coverageIds, requirementProfileIds } = collectClosureCandidates(
        root,
        matrix,
        coverageRegistry,
        requirementCatalog
    );

    const sourceFiles = [];
    const diagnostics = [];
    for (const [relative, bucket] of [...candidates.entries()].sort((left, right) => left[0].localeCompare(right[0])))
    {
        const absolute = path.join(root, relative);
        const source = readFileSync(absolute, 'utf8');
        const extension = path.extname(relative).toLowerCase();
        const executable = EXECUTABLE_EXTENSIONS.has(extension);
        let classification;
        try
        {
            classification = classifyFile(relative, source);
        }
        catch (error)
        {
            throw new Error(
                `${error.message} (declared by ${[...bucket.declaredBy].sort().join(', ')})`,
                { cause: error }
            );
        }
        if (classification === null)
        {
            const commandDeclared = [...bucket.declaredBy].some((declaration) => (
                declaration.startsWith('matrix:command:') || declaration.startsWith('requirement:command:')
            ));
            if (executable && commandDeclared)
            {
                throw new Error(
                    `test inventory fail closed: executable test surface ${relative} has no adapter record `
          + `(declared by ${[...bucket.declaredBy].sort().join(', ')})`
                );
            }
            classification = SUPPORT_CLASSIFICATION;
        }
        const commandDeclared = [...bucket.declaredBy].some((declaration) => (
            declaration.startsWith('matrix:command:') || declaration.startsWith('requirement:command:')
        ));
        if (executable && commandDeclared && classification.kind !== 'discoverable-test')
        {
            throw new Error(
                `test inventory fail closed: executable test surface ${relative} was classified as `
        + `${classification.kind} (${classification.adapter}) instead of a discoverable test `
        + `(declared by ${[...bucket.declaredBy].sort().join(', ')})`
            );
        }
        sourceFiles.push({
            path: relative,
            adapter: classification.adapter,
            adapterVersion: classification.adapterVersion,
            kind: classification.kind,
            sourceDigest: fileDigest(absolute),
            declaredBy: [...bucket.declaredBy].sort(),
            caseIdentity: classification.caseIdentity
        });
        if (classification.kind === 'discoverable-test' && classification.caseIdentity.extractionStatus === 'deferred')
        {
            diagnostics.push({
                severity: 'info',
                code: 'case-extraction-deferred',
                file: relative,
                message: `${classification.adapter} adapter case extraction is deferred to ${classification.caseIdentity.deferredTo}`
            });
        }
        if (classification.caseIdentity.mode === 'dynamic')
        {
            diagnostics.push({
                severity: 'info',
                code: 'dynamic-case-obligation',
                file: relative,
                message: `runtime inventory must record executed case ids after ${classification.caseIdentity.generationLocation} execution`
            });
        }
    }

    let adapterCases = [];
    let adapterSuiteRecords = [];
    let adapterDiagnostics = [];
    if (runAdapters)
    {
        const projectResults = xunitTestProjects
            .filter(({ project }) => existsSync(path.join(root, project)))
            .map((project) => ({
                ...readXunitProjectContext(root, project, configuration),
                report: runXunitRoslynAdapter(root, project.project, configuration)
            }));
        const xunitResult = enrollAndMergeXunitProjectResults(root, projectResults, sourceFiles, configuration);
        adapterCases = xunitResult.testCases;
        adapterDiagnostics = xunitResult.diagnostics;
        const tsResult = runTsAstAdapter(root, sourceFiles);
        adapterCases = [...adapterCases, ...tsResult.testCases];
        adapterSuiteRecords = tsResult.suiteRecords;
        adapterDiagnostics = [...adapterDiagnostics, ...tsResult.diagnostics];
        const nativeEntryResult = runNativeEntryAdapter(root, sourceFiles, matrix);
        adapterCases = [...adapterCases, ...nativeEntryResult.testCases];
        adapterDiagnostics = [...adapterDiagnostics, ...nativeEntryResult.diagnostics];
    }
    const sourceState = includeSourceState ? { commit: gitCommit(root) } : null;
    const discoverySources = {
        directories: [...DIRECTORY_CLOSURE].sort(),
        toolsDirectories: [...TOOLS_DIRECTORY_CLOSURE].sort(),
        matrixTiers: [...matrixTierIds].sort(),
        coverageEntries: [...coverageIds].sort(),
        requirementProfiles: [...requirementProfileIds].sort()
    };
    const content = {
        schema: INVENTORY_SCHEMA,
        adapterVersion: ADAPTER_VERSION,
        sourceState,
        discoverySources,
        sourceFiles,
        testCases: adapterCases.sort((left, right) => left.id.localeCompare(right.id)),
        suiteRecords: adapterSuiteRecords.sort((left, right) => left.id.localeCompare(right.id)),
        diagnostics: [...diagnostics, ...adapterDiagnostics].sort((left, right) => (
            left.severity.localeCompare(right.severity)
      || left.code.localeCompare(right.code)
      || String(left.file ?? '').localeCompare(String(right.file ?? ''))
        ))
    };
    return finalizeTestInventory(content);
}

export function finalizeTestInventory(content)
{
    const inventoryDigest = sha256(canonicalStringify(content));
    return validateInventoryArtifact({ ...content, inventoryDigest });
}
