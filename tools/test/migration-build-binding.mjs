import fs from 'node:fs';
import path from 'node:path';

const {
    dotnetProjectLayout,
    productionBuildLayoutDigest,
    productionBuildLayoutSchema,
    productionDotnetArtifacts,
    resolveProductionBuildLayout,
    verifyProductionBuildRootIntegrity
} = await import(new URL('../test-matrix/production-build-layout.mjs', import.meta.url));
const { publishRunBoundMarker, readRunBoundMarker } = await import(new URL('../test-matrix/run-bound-marker.mjs', import.meta.url));
const { snapshotSourceState } = await import(new URL('../test-matrix/scheduler.mjs', import.meta.url));

const markerId = 'migration-tests-ready';

/** Closed producer identities: a matrix lane cannot impersonate the production bundle. */
export function migrationProducerIdentity(producer = 'backend-tests')
{
    if (producer === 'backend-tests')
    {
        return { bundleId: 'backend-tests', buildStepId: 'xunit-inventory-adapter-build', executionStepId: 'migration-test-execution' };
    }
    if (producer === 'backend-unit')
    {
        return { bundleId: 'matrix:backend-unit', buildStepId: 'migration-tests-build', executionStepId: 'migration-test-execution' };
    }
    throw new Error('Migration build requires a registered execution producer');
}

function requireOwnedPath(root, file, directory = false)
{
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    {
        throw new Error('Migration build artifact must stay inside the repository');
    }
    let cursor = root;
    for (const part of relative.split(path.sep))
    {
        cursor = path.join(cursor, part);
        if (fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error('Migration build artifacts cannot traverse symbolic links');
        }
    }
    const stat = fs.statSync(file);
    if (directory ? !stat.isDirectory() : !stat.isFile())
    {
        throw new Error('Migration build artifact has the wrong filesystem type');
    }
}

function collectFiles(root, directory, select)
{
    requireOwnedPath(root, directory, true);
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink())
        {
            throw new Error('Migration build artifacts cannot traverse symbolic links');
        }
        if (entry.isDirectory())
        {
            return collectFiles(root, file, select);
        }
        requireOwnedPath(root, file);
        return select(file) ? [file] : [];
    });
}

function ensureOwnedDirectory(root, directory)
{
    const relative = path.relative(root, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    {
        throw new Error('Migration marker directory must stay inside the repository');
    }
    let cursor = root;
    for (const part of relative.split(path.sep))
    {
        cursor = path.join(cursor, part);
        if (!fs.existsSync(cursor))
        {
            fs.mkdirSync(cursor);
        }
        requireOwnedPath(root, cursor, true);
    }
}

function migrationBuildLayoutContext({ root, runId, namespace, sourceState, producer }, { publishing = false } = {})
{
    migrationProducerIdentity(producer);
    root = path.resolve(root);
    if (fs.realpathSync(root) !== root
        || typeof namespace !== 'string' || !namespace.trim() || namespace !== namespace.trim()
        || !/^[0-9a-f]{40}$/u.test(sourceState?.commit ?? '')
        || !/^[0-9a-f]{64}$/u.test(sourceState?.worktreeFingerprint ?? ''))
    {
        throw new Error('Migration build requires canonical root, namespace and exact source identity');
    }
    const layout = resolveProductionBuildLayout({ root, runId });
    requireOwnedPath(root, layout.manifestFile);
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    const states = publishing ? ['building'] : ['building', 'complete'];
    if (manifest.schema !== productionBuildLayoutSchema || manifest.runId !== runId
        || manifest.sourceState?.commit !== sourceState.commit
        || manifest.sourceState?.worktreeFingerprint !== sourceState.worktreeFingerprint
        || manifest.owner?.namespace !== namespace
        || manifest.owner?.runId !== runId || manifest.owner?.schedulerRunId !== runId
        || manifest.owner?.sourceCommit !== sourceState.commit
        || manifest.owner?.worktreeFingerprint !== sourceState.worktreeFingerprint
        || !states.includes(manifest.owner?.state)
        || manifest.status !== (manifest.owner?.state === 'complete' ? 'success' : 'active')
        || manifest.paths?.runRoot !== path.relative(root, layout.runRoot).replaceAll(path.sep, '/'))
    {
        throw new Error('Migration build layout does not bind the current source, run, namespace and build state');
    }
    verifyProductionBuildRootIntegrity(layout);
    const artifacts = productionDotnetArtifacts(layout);
    const projects = [
        artifacts.migrationTests,
        artifacts.xunitAdapter,
        dotnetProjectLayout(layout, 'src/migration/FsusBlog.Migration.csproj'),
        dotnetProjectLayout(layout, 'src/shared/FsusBlog.Shared.csproj')
    ];
    for (const project of projects.slice(0, 2))
    {
        const declared = manifest.projects?.[project.name];
        if (declared?.projectFile !== project.projectFile
            || ['baseOutputPath', 'baseIntermediateOutputPath', 'projectExtensionsPath'].some((key) =>
                declared?.[key] !== path.relative(root, project[key]).replaceAll(path.sep, '/')))
        {
            throw new Error('Migration build layout substitutes a different project or output path');
        }
    }
    return { root, layout, artifacts, projects };
}

/** Bind the existing producer marker to this run's independent Release closure. */
export function migrationBuildMarkerContext(options, { publishing = false } = {})
{
    const { runId, namespace, sourceState, producer } = options;
    const owner = migrationProducerIdentity(producer);
    const { root, layout, artifacts, projects } = migrationBuildLayoutContext(options, { publishing });
    const files = projects.flatMap((project) =>
    {
        for (const file of [
            path.join(root, project.projectFile),
            path.join(project.outputDirectory, `${project.name}.dll`),
            path.join(project.intermediateDirectory, `${project.name}.dll`),
            project.assetsFile
        ])
        {
            requireOwnedPath(root, file);
        }
        return [
            project.assetsFile,
            ...collectFiles(root, project.outputDirectory, () => true),
            ...collectFiles(root, project.intermediateDirectory, (file) => /\.(?:cs|dll)$/u.test(file))
        ];
    });
    if (producer === 'backend-unit')
    {
        const directory = path.join(layout.runRoot, 'migration-unit-build');
        requireOwnedPath(root, path.join(directory, 'commands.json'));
        files.push(...collectFiles(root, directory, () => true));
    }
    for (const project of projects.slice(0, 2))
    {
        for (const suffix of ['deps.json', 'runtimeconfig.json'])
        {
            requireOwnedPath(root, path.join(project.outputDirectory, `${project.name}.${suffix}`));
        }
    }
    const file = path.join(root, '.tmp/test-runs', runId, `${markerId}.json`);
    return {
        file,
        expected: {
            root,
            markerId,
            runId,
            sourceState,
            producerBundleId: owner.bundleId,
            producerStepId: owner.buildStepId,
            artifacts: [...new Set(files)].sort(),
            bindings: {
                schema: 'fsusblog.migration-build-binding.v1',
                namespace,
                configuration: 'Release',
                project: artifacts.migrationTests.projectFile,
                adapterProject: artifacts.xunitAdapter.projectFile,
                buildLayoutDigest: productionBuildLayoutDigest(layout)
            }
        }
    };
}

async function requireCurrentSource({ root, sourceState })
{
    const current = await snapshotSourceState(root);
    if (current.commit !== sourceState?.commit || current.worktreeFingerprint !== sourceState?.worktreeFingerprint)
    {
        throw new Error('Migration build source identity differs from the current worktree');
    }
}

/** Validate source and active scheduler layout before a fast-lane build writes any output. */
export async function requireMigrationUnitBuildContext(options, env = process.env)
{
    if (options.producer !== 'backend-unit' || env.CURRENT_TIER !== 'backend-unit'
        || String(env.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? '').trim()
        || env.FSUSBLOG_TEST_RUN_ID !== options.runId || env.FSUSBLOG_TEST_NAMESPACE !== options.namespace
        || env.FSUSBLOG_TEST_SOURCE_COMMIT !== options.sourceState?.commit
        || env.FSUSBLOG_TEST_SOURCE_FINGERPRINT !== options.sourceState?.worktreeFingerprint)
    {
        throw new Error('Migration unit build requires its own matrix producer and scheduler identity');
    }
    await requireCurrentSource(options);
    const context = migrationBuildLayoutContext(options, { publishing: true });
    if (env.FSUSBLOG_PRODUCTION_BUILD_ROOT !== context.layout.runRoot)
    {
        throw new Error('Migration unit build environment substitutes another output root');
    }
    return context;
}

/** Publish the build owner's source/artifact marker, not execution or qualification evidence. */
export async function publishMigrationBuildReady(options)
{
    await requireCurrentSource(options);
    const { file, expected } = migrationBuildMarkerContext(options, { publishing: true });
    ensureOwnedDirectory(path.resolve(options.root), path.dirname(file));
    if (fs.existsSync(file))
    {
        requireOwnedPath(path.resolve(options.root), file);
    }
    const marker = publishRunBoundMarker({ file, ...expected });
    await requireCurrentSource(options);
    return { file, marker };
}

/** Reobserve the source and exact build closure before consuming its marker. */
export async function readMigrationBuildReady(options)
{
    await requireCurrentSource(options);
    const { file, expected } = migrationBuildMarkerContext(options);
    requireOwnedPath(path.resolve(options.root), file);
    const marker = readRunBoundMarker(file, expected);
    await requireCurrentSource(options);
    return { file, marker };
}
