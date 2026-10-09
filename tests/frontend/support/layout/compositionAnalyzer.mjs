import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { compositionDigest, createCompositionIdentity, loadCompositionInputs, validateCompositionContracts } from './compositionContracts.mjs';
import { resolveCompositionRoutes, bindCompositionArchetypes } from './compositionRoutes.mjs';
import { createCompositionSource } from './compositionSource.mjs';

export const compositionAnalyzerSources = [
    'tests/frontend/support/layout/compositionAnalyzer.mjs',
    'tests/frontend/support/layout/compositionSource.mjs',
    'tests/frontend/support/layout/compositionRoutes.mjs',
    'tests/frontend/support/layout/compositionDom.mjs',
    'tests/frontend/support/layout/compositionGeometry.mjs',
    'tests/frontend/support/layout/compositionOrderGeometry.mjs',
    'tests/frontend/support/layout/compositionOverflowGeometry.mjs',
    'tests/frontend/support/layout/compositionContracts.mjs',
    'tools/frontend/control-legality/source.mjs'
];

function git(root, args)
{
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0)
    {
        throw new Error(`[composition-analyzer] git identity unavailable ${args[0]}`);
    }
    return result.stdout.trim();
}

export function compositionWorktreeIdentity(root)
{
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
    return { commit: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']),
        worktreeDigest: compositionDigest({ diff: git(root, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']),
            untracked: untracked.map((path) => ({ path, digest: compositionDigest(readFileSync(resolve(root, path)).toString('base64')) })) }) };
}

/** Actual local development identity; it is not an acceptance or publication receipt. */
export function createLocalCompositionBaseline(fsusUIRoot)
{
    const skill = '.agents/skills/fsusui-design-conformance';
    const files = git(fsusUIRoot, ['ls-files', '-z', '--', skill]).split('\0').filter(Boolean).sort();
    if (!files.length)
    {
        throw new Error('[composition-analyzer] FsusUI skill closure unavailable');
    }
    const baseline = {
        schema: 'fsusblog-design-conformance.fsusui-baseline-identity.v1',
        sourceKind: 'local-source', repository: 'Ozwasyd/FsusUI', absolutePath: resolve(fsusUIRoot),
        gitHead: git(fsusUIRoot, ['rev-parse', 'HEAD']),
        packageVersion: JSON.parse(readFileSync(resolve(fsusUIRoot, 'vue/packages/element-plus/package.json'), 'utf8')).version,
        dirty: Boolean(git(fsusUIRoot, ['status', '--porcelain'])),
        dirtyFingerprint: compositionWorktreeIdentity(fsusUIRoot).worktreeDigest,
        skillDigest: compositionDigest(files.map((path) => ({ path, digest: compositionDigest(readFileSync(resolve(fsusUIRoot, path), 'utf8')) }))),
        contractDigests: Object.fromEntries(Object.entries({ stagePolicy: 'ui-stage-policy.json', classification: 'ui-ux-classification-receipt.schema.json',
            adjudication: 'ui-system-adjudication-receipt.schema.json', uxAcceptance: 'ux-acceptance-receipt.schema.json' }).map(([name, file]) =>
            [name, compositionDigest(readFileSync(resolve(fsusUIRoot, skill, 'contracts', file), 'utf8'))]))
    };
    return { ...baseline, baselineDigest: compositionDigest(baseline) };
}

export function createCompositionRun({ repositoryRoot, fsusUIRoot, fsusUIBaselineIdentity, parserRoot = repositoryRoot, runId })
{
    if (!runId)
    {
        throw new Error('[composition-analyzer] run identity required');
    }
    if (compositionDigest(fsusUIBaselineIdentity) !== compositionDigest(createLocalCompositionBaseline(fsusUIRoot)))
    {
        throw new Error('[composition-analyzer] effective FsusUI baseline mismatch');
    }
    const inputs = loadCompositionInputs({ repositoryRoot, fsusUIRoot });
    const contractStatus = validateCompositionContracts(inputs);
    const worktree = compositionWorktreeIdentity(repositoryRoot);
    const identity = createCompositionIdentity(inputs, { sourceCommit: worktree.commit, fsusUIBaselineIdentity });
    const analyzerDigest = compositionDigest(compositionAnalyzerSources.map((path) => ({ path,
        digest: compositionDigest(readFileSync(resolve(repositoryRoot, path), 'utf8')) })));
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot });
    return { inputs, source, identity, contractStatus, worktree, analyzerDigest, runId,
        verifyCurrent()
        {
            if (compositionDigest(compositionWorktreeIdentity(repositoryRoot)) !== compositionDigest(worktree))
            {
                throw new Error('[composition-analyzer] source/worktree drift during run');
            }
            if (compositionDigest(createLocalCompositionBaseline(fsusUIRoot)) !== compositionDigest(fsusUIBaselineIdentity))
            {
                throw new Error('[composition-analyzer] FsusUI baseline/skill drift during run');
            }
            const current = loadCompositionInputs({ repositoryRoot, fsusUIRoot });
            const renewed = createCompositionIdentity(current, { sourceCommit: worktree.commit, fsusUIBaselineIdentity });
            if (compositionDigest(renewed) !== compositionDigest(identity))
            {
                throw new Error('[composition-analyzer] contract/design/fixture drift during run');
            }
            const bindings = source.resolver.sourceBindings();
            if (bindings.errors.length)
            {
                throw new Error('[composition-analyzer] parsed source or FsusUI baseline drift during run');
            }
            return true;
        } };
}

export function scanCompositionArchetypes({ repositoryRoot, fsusUIRoot, parserRoot = repositoryRoot })
{
    const inputs = loadCompositionInputs({ repositoryRoot, fsusUIRoot });
    const contractStatus = validateCompositionContracts(inputs);
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot });
    let routes;
    try
    {
        routes = resolveCompositionRoutes(source, resolve(repositoryRoot, 'src/frontend/src/router/index.ts'));
    }
    catch (error)
    {
        return { schema: 'fsusblog.composition-static.v1', contractStatus,
            errors: [{ reason: 'unknown-router-ast', message: error.message }], archetypes: [], qualified: false, fullVisualVerified: false };
    }
    const archetypes = bindCompositionArchetypes(inputs.matrix, routes).map((binding) =>
    {
        // A separate graph prevents sibling routes from contaminating per-archetype source errors.
        const source = createCompositionSource({ repositoryRoot, fsusUIRoot, parserRoot });
        const graph = source.graph(binding.entryFiles);
        return { archetype: `${binding.archetype.surface}/${binding.archetype.kind}`, path: binding.archetype.path,
            contractDigest: compositionDigest(binding.archetype.compositionContract), graph,
            errors: [...binding.errors, ...graph.errors], renderedDom: 'not-run', qualified: false, fullVisualVerified: false };
    });
    return { schema: 'fsusblog.composition-static.v1', contractStatus, routes, archetypes,
        worktree: compositionWorktreeIdentity(repositoryRoot), analyzerDigest: compositionDigest(compositionAnalyzerSources.map((path) => ({ path,
            digest: compositionDigest(readFileSync(resolve(repositoryRoot, path), 'utf8')) }))),
        errors: archetypes.flatMap((item) => item.errors.map((error) => ({ archetype: item.archetype, ...error }))),
        qualified: false, fullVisualVerified: false };
}
