import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compositionDigest, validateCompositionContracts } from '@fsusblog/layout-governance/composition-contracts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const sourceBytes = readFileSync(fileURLToPath(import.meta.url));
const moduleOwners = {
    'composition-analyzer': 'tests/frontend/support/layout/compositionAnalyzer.mjs',
    'composition-source': 'tests/frontend/support/layout/compositionSource.mjs',
    'composition-routes': 'tests/frontend/support/layout/compositionRoutes.mjs',
    'composition-dom': 'tests/frontend/support/layout/compositionDom.mjs'
};
const dependencyOwners = {
    'composition-contracts': 'tests/frontend/support/layout/compositionContracts.mjs',
    'schema-validator': 'tools/test-matrix/schema-validator/validate.mjs',
    'fsusui-source-resolver': 'src/frontend/scripts/fsusui-root.mjs'
};
const loadedDependencyUrls = Object.fromEntries(Object.keys(dependencyOwners).map((name) =>
    [name, import.meta.resolve(`@fsusblog/layout-governance/${name}`)]));
let loadedModules;

function packageLink(require, name)
{
    const link = require.resolve.paths(name).map((directory) => resolve(directory, name))
        .find((directory) => existsSync(resolve(directory, 'package.json')));
    if (!link)
    {
        fail('module-owner-mismatch', `installed package owner unavailable: ${name}`);
    }
    return { path: link, owner: realpathSync(link) };
}

function fail(code, message)
{
    const error = new Error(`[composition-diagnostic-consumer] ${message}`);
    error.code = `composition-diagnostic-${code}`;
    throw error;
}

/** Declared scene selection only. This cannot establish observed runtime state. */
export function projectCompositionSceneState(inputs, scene)
{
    validateCompositionContracts(inputs);
    if (!scene || Object.keys(scene).some((key) => !['archetype', 'routePattern', 'state'].includes(key)))
    {
        fail('scene-invalid', 'source/state diagnostic accepts archetype, routePattern and state only');
    }
    const archetype = inputs.matrix.archetypes.find((entry) => `${entry.surface}/${entry.kind}` === scene?.archetype);
    if (!archetype || scene.routePattern !== archetype.path)
    {
        fail('scene-unregistered', 'scene must bind the sole current archetype route');
    }
    const required = archetype.compositionContract.requiredStateFixtures;
    const selections = required.filter((entry) => entry.id === scene.state);
    if (selections.length !== 1)
    {
        fail('state-unregistered', 'scene state must be an exact-one declared state ID, not its value or a default');
    }
    const selected = selections[0];
    const priority = archetype.compositionContract.actionPriority;
    return {
        archetype,
        state: { [selected.dimensionId]: selected.id },
        selection: { id: selected.id, dimensionId: selected.dimensionId, value: selected.value,
            fixtureRef: selected.fixtureRef, ownerIssue: selected.bindingOwnerIssue },
        exclusiveActionState: priority.kind === 'exclusive-states'
            ? priority.cases.find((entry) => entry.stateId === selected.id && priority.stateDimensionId === selected.dimensionId) ?? null
            : null,
        runtimeStateAdmission: 'not-observed',
        qualificationEligible: false
    };
}

function parserSnapshot()
{
    const require = createRequire(resolve(repositoryRoot, 'src/frontend/package.json'));
    const files = new Map();
    const aliases = [];
    const packages = new Set();
    function visit(name, parentRequire, requireEntry = false)
    {
        let request = name;
        let entry;
        try
        {
            entry = realpathSync(parentRequire.resolve(request));
        }
        catch (error)
        {
            if (requireEntry)
            {
                throw error;
            }
            // Type-only dependencies such as csstype have metadata but no JS entry.
            request = `${name}/package.json`;
            entry = realpathSync(parentRequire.resolve(request));
        }
        aliases.push({ name, request, entry, parentRequire, link: packageLink(parentRequire, name) });
        let root = dirname(entry);
        while (!existsSync(resolve(root, 'package.json'))
            || !JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name)
        {
            const parent = dirname(root);
            if (parent === root)
            {
                fail('parser-owner-mismatch', `parser package metadata unavailable: ${name}`);
            }
            root = parent;
        }
        const metadataPath = resolve(root, 'package.json');
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        if (metadata.name !== name)
        {
            fail('parser-owner-mismatch', `parser entry resolves to another package: ${name}`);
        }
        if (!packages.has(root))
        {
            packages.add(root);
            function collect(directory)
            {
                for (const item of readdirSync(directory, { withFileTypes: true }))
                {
                    const path = resolve(directory, item.name);
                    if (item.name === 'node_modules')
                    {
                        continue;
                    }
                    if (item.isDirectory())
                    {
                        collect(path);
                    }
                    else if (/\.(?:js|mjs|cjs|json)$/u.test(item.name))
                    {
                        if (!item.isFile() || realpathSync(path) !== path)
                        {
                            fail('parser-owner-mismatch', `parser file is not its regular owner: ${path}`);
                        }
                        files.set(path, readFileSync(path));
                    }
                }
            }
            collect(root);
            const childRequire = createRequire(metadataPath);
            for (const dependency of Object.keys(metadata.dependencies ?? {}))
            {
                visit(dependency, childRequire);
            }
        }
        return { entry, metadataPath, version: metadata.version };
    }
    const sources = Object.fromEntries(['typescript', '@vue/compiler-sfc', '@vue/compiler-dom', 'vue'].map((name) =>
        [name, visit(name, require, true)]));
    for (const path of files.keys())
    {
        if (require.cache[path])
        {
            fail('parser-cache-unbound', `parser was cached before its byte snapshot: ${path}`);
        }
    }
    return { sources, files, aliases };
}

async function canonicalModules(expectedSourceCommit)
{
    const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    if (actualCommit !== expectedSourceCommit)
    {
        fail('source-drift', 'current source differs from the explicitly supplied commit');
    }
    const urls = {};
    for (const [name, path] of Object.entries({ ...moduleOwners, ...dependencyOwners }))
    {
        try
        {
            urls[name] = import.meta.resolve(`@fsusblog/layout-governance/${name}`);
        }
        catch
        {
            fail('public-api-unavailable', `canonical public ${name} export is absent from this checkout`);
        }
        if (realpathSync(fileURLToPath(urls[name])) !== resolve(repositoryRoot, path))
        {
            fail('module-owner-mismatch', `canonical public ${name} resolves outside its owner`);
        }
    }
    if (Object.keys(dependencyOwners).some((name) => urls[name] !== loadedDependencyUrls[name]))
    {
        fail('module-owner-mismatch', 'statically loaded canonical dependency changed owner');
    }
    const controlRequire = createRequire(resolve(repositoryRoot, moduleOwners['composition-source']));
    const controlLink = packageLink(controlRequire, '@fsusblog/control-legality');
    const controlSource = realpathSync(controlRequire.resolve('@fsusblog/control-legality/source'));
    if (controlSource !== resolve(repositoryRoot, 'tools/frontend/control-legality/source.mjs')
        || controlLink.owner !== resolve(repositoryRoot, 'tools/frontend/control-legality'))
    {
        fail('module-owner-mismatch', 'composition source actually loads another control-legality owner');
    }
    if (!loadedModules)
    {
        const bytes = new Map([...Object.values(moduleOwners), ...Object.values(dependencyOwners), 'package.json',
            'tests/frontend/support/layout/compositionContracts.mjs', 'tools/frontend/control-legality/source.mjs',
            'tools/frontend/control-legality/package.json', 'tools/frontend/control-legality/package-lock.json',
            'tests/frontend/package.json', 'tests/frontend/package-lock.json',
            'src/frontend/package.json', 'src/frontend/package-lock.json']
            .map((path) => [path, readFileSync(resolve(repositoryRoot, path))]));
        for (const [path, actual] of bytes)
        {
            const committed = execFileSync('git', ['show', `${expectedSourceCommit}:${path}`],
                { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 });
            if (!actual.equals(committed))
            {
                fail('version-drift', `canonical capability differs from the supplied Git blob: ${path}`);
            }
        }
        const parsers = parserSnapshot();
        const [analyzer, source, routes, dom] = await Promise.all([
            import('@fsusblog/layout-governance/composition-analyzer'),
            import('@fsusblog/layout-governance/composition-source'),
            import('@fsusblog/layout-governance/composition-routes'),
            import('@fsusblog/layout-governance/composition-dom')
        ]);
        loadedModules = { analyzer, source, routes, dom, urls, bytes, parsers };
    }
    for (const alias of loadedModules.parsers.aliases)
    {
        if (realpathSync(alias.parentRequire.resolve(alias.request)) !== alias.entry
            || realpathSync(alias.link.path) !== alias.link.owner)
        {
            fail('parser-owner-mismatch', `loaded parser dependency changed owner: ${alias.name}`);
        }
    }
    for (const [path, bytes] of loadedModules.parsers.files)
    {
        if (realpathSync(path) !== path || !readFileSync(path).equals(bytes))
        {
            fail('version-drift', `loaded parser dependency changed bytes: ${path}`);
        }
    }
    if (compositionDigest(urls) !== compositionDigest(loadedModules.urls)
        || !readFileSync(fileURLToPath(import.meta.url)).equals(sourceBytes))
    {
        fail('version-drift', 'loaded consumer or public import ownership changed');
    }
    for (const [path, bytes] of loadedModules.bytes)
    {
        if (!readFileSync(resolve(repositoryRoot, path)).equals(bytes))
        {
            fail('version-drift', `loaded canonical source/dependency changed: ${path}`);
        }
    }
    return loadedModules;
}

/** Consume the canonical source/state/DOM diagnostic without issuing visual or runtime acceptance. */
export async function inspectCompositionObservationDiagnostic(options)
{
    const allowed = new Set(['scene', 'runId', 'expectedSourceCommit', 'fsusUIRoot', 'observationBytes']);
    if (!options || Object.keys(options).some((key) => !allowed.has(key)))
    {
        fail('options-invalid', 'caller graph, module, loader, repository, verifier and authority overrides are forbidden');
    }
    const { runId, expectedSourceCommit, fsusUIRoot, observationBytes } = options;
    const scene = structuredClone(options.scene);
    if (typeof runId !== 'string' || !runId.trim() || !/^[a-f0-9]{40}$/u.test(expectedSourceCommit ?? ''))
    {
        fail('run-binding-required', 'explicit run ID and exact expected source commit required');
    }
    if (observationBytes !== undefined && !Buffer.isBuffer(observationBytes))
    {
        fail('bytes-required', 'explicit canonical observation Buffer required');
    }
    const { analyzer, routes, dom } = await canonicalModules(expectedSourceCommit);
    const baseline = analyzer.createLocalCompositionBaseline(fsusUIRoot);
    const run = analyzer.createCompositionRun({ repositoryRoot, fsusUIRoot, fsusUIBaselineIdentity: baseline, runId });
    if (run.worktree.commit !== expectedSourceCommit)
    {
        fail('source-drift', 'current source differs from the explicitly supplied commit');
    }
    const projected = projectCompositionSceneState(run.inputs, scene);
    const routeModel = routes.resolveCompositionRoutes(run.source, resolve(repositoryRoot, 'src/frontend/src/router/index.ts'));
    const bindings = routes.bindCompositionArchetypes(run.inputs.matrix, routeModel)
        .filter(({ archetype }) => `${archetype.surface}/${archetype.kind}` === scene.archetype);
    if (bindings.length !== 1 || bindings[0].errors.length)
    {
        fail('route-binding-invalid', 'canonical route AST cannot bind this scene exact-one');
    }
    const graph = run.source.graph(bindings[0].entryFiles);
    const runBinding = { worktree: run.worktree, analyzerDigest: run.analyzerDigest, fsusUIBaselineDigest: baseline.baselineDigest };
    let observed = null;
    if (observationBytes !== undefined)
    {
        const receipt = JSON.parse(observationBytes.toString('utf8'));
        if (receipt.archetype !== scene.archetype)
        {
            fail('scene-mismatch', 'canonical observation belongs to another archetype');
        }
        dom.verifyCompositionObservation(receipt, { graph, identity: run.identity, runId, runBinding,
            archetype: projected.archetype, state: projected.state });
        observed = { contentDigest: compositionDigest(observationBytes.toString('base64')),
            errors: receipt.errors, observationsPassed: receipt.observationsPassed,
            qualification: receipt.qualification, fullVisualVerified: receipt.fullVisualVerified };
    }
    run.verifyCurrent();
    await canonicalModules(expectedSourceCommit);
    const parserSources = Object.fromEntries(Object.entries(loadedModules.parsers.sources).map(([name, parser]) =>
        [name, { ...parser, entryDigest: createHash('sha256').update(loadedModules.parsers.files.get(parser.entry)).digest('hex'),
            metadataDigest: createHash('sha256').update(loadedModules.parsers.files.get(parser.metadataPath)).digest('hex') }]));
    return {
        status: 'canonical-diagnostic-consumed', qualificationEligible: false, fullVisualVerified: false,
        runId, source: run.worktree, analyzerDigest: run.analyzerDigest,
        consumerDigest: createHash('sha256').update(sourceBytes).digest('hex'),
        dependencyDigests: Object.fromEntries([...loadedModules.bytes].map(([path, bytes]) =>
            [path, createHash('sha256').update(bytes).digest('hex')])),
        compositionIdentity: run.identity, fsusUIBaselineIdentity: baseline,
        parserIdentity: graph.sourceIdentity.parsers, parserSources, scene,
        parserClosureDigest: compositionDigest([...loadedModules.parsers.files].sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0).map(([path, bytes]) =>
            ({ path, digest: createHash('sha256').update(bytes).digest('hex') }))),
        declaredStateSelection: projected.selection, analyzerState: projected.state,
        exclusiveActionState: projected.exclusiveActionState,
        runtimeStateAdmission: 'not-observed', pendingStateBindings: run.contractStatus.pendingStateBindings,
        sourceGraphDigest: compositionDigest(graph), sourceErrors: graph.errors,
        unknownConditionalBindings: graph.nodes.filter((node) => node.conditional?.some((condition) => condition.expression))
            .map((node) => ({ file: node.file, sourceNode: node.id, reason: 'unknown-conditional-state-binding' })),
        observation: observed,
        pending: ['canonical-current-run-runtime-state-origin:#2099', 'qualified-static-dom-producer-admission:#2098',
            'public-surface-capability-admission:#1895', 'geometry-state:#2099', 'independent-visual-adjudication:#2100']
    };
}
