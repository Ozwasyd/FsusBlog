import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const {
    buildProductionDiskDemandPlan,
    defaultProductionDiskRoots,
    productionDiskDemandDigest,
    readProductionDiskDemandCatalog
} = await import(new URL('../test-matrix/production-disk-demand.mjs', import.meta.url));

const producerId = 'release-reliability-fresh';
const sourcePaths = Object.freeze([
    'tools/data-scale/seed.sh',
    'src/backend/Services/Fixtures/DataScale/ArticleScalePlan.cs',
    'src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs',
    'src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphModels.cs',
    'src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphVerifier.cs'
]);

function canonicalDirectory(value, field)
{
    if (typeof value !== 'string' || !path.isAbsolute(value)
    || path.resolve(value) !== value || fs.realpathSync(value) !== value
    || !fs.lstatSync(value).isDirectory())
    {
        throw new Error(`DataScale disk demand ${field} must be an existing canonical absolute directory`);
    }
    return value;
}

function sourceBinding(root)
{
    const sources = sourcePaths.map((relative) =>
    {
        const file = path.join(root, relative);
        if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)
        {
            throw new Error(`DataScale disk demand source is not a canonical file: ${relative}`);
        }
        const bytes = fs.readFileSync(file);
        return { path: relative, bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    });
    if (!/scale-m\)\s+articles=10000\s+comments=100000\s+;;/u.test(sources[0].bytes.toString('utf8'))
    || !/\["scale-m"\]\s*=\s*10_000/u.test(sources[1].bytes.toString('utf8')))
    {
        throw new Error('DataScale disk demand fixed scale-m source counts drifted; recalibration is required');
    }
    return sources.map(({ path: sourcePath, digest }) => ({ path: sourcePath, digest }));
}

// A demand plan is evidence consumed by the existing capacity reservation owner,
// never a reservation or permission to start Docker, schema materialization or seed.
export function createDataScaleDiskDemandPlan({ root, runId, buildRoot, resolveDockerRoot })
{
    const repositoryRoot = canonicalDirectory(root, 'root');
    const productionBuildRoot = canonicalDirectory(buildRoot, 'buildRoot');
    if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(runId))
    {
        throw new Error('DataScale disk demand runId must be a bounded run identifier');
    }
    if (typeof resolveDockerRoot !== 'function')
    {
        throw new Error('DataScale disk demand requires the actual Docker storage root resolver');
    }
    const outputRoot = path.join(repositoryRoot, '.tmp', 'data-scale-runtime');
    let ancestor = outputRoot;
    while (!fs.existsSync(ancestor))
    {
        if (fs.lstatSync(path.dirname(ancestor), { throwIfNoEntry: false })?.isSymbolicLink())
        {
            throw new Error('DataScale disk demand output root escapes its canonical repository');
        }
        ancestor = path.dirname(ancestor);
    }
    canonicalDirectory(ancestor, 'output ancestor');
    const catalog = readProductionDiskDemandCatalog(repositoryRoot);
    const declaration = catalog.producers.find((producer) => producer.producerId === producerId);
    if (!declaration || !['run-output', 'docker-storage', 'os-temp'].every((rootId) =>
        declaration.demands.some((demand) => demand.rootId === rootId)))
    {
        throw new Error('DataScale disk demand dedicated producer declarations are incomplete');
    }
    const sources = sourceBinding(repositoryRoot);
    const roots = defaultProductionDiskRoots(repositoryRoot, {
        outputRoot,
        buildRoot: productionBuildRoot,
        resolveDockerRoot: () => canonicalDirectory(resolveDockerRoot(), 'dockerStorageRoot')
    });
    return buildProductionDiskDemandPlan({
        root: repositoryRoot,
        roots,
        catalog,
        tiers: [{
            id: producerId,
            executionDependsOn: [],
            exclusiveResources: ['release-reliability'],
            capacityIdentity: productionDiskDemandDigest({
                runId,
                scaleTier: 'scale-m',
                articleCount: 10000,
                commentCount: 100000,
                calibration: 'source-derived-not-measured-pending',
                sources
            })
        }],
        maxParallel: 1
    });
}
