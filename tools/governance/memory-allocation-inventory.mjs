import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const catalogPath = 'config/development/memory-allocation-boundaries.json';
const producerPath = 'tools/governance/memory-allocation-inventory.mjs';
const sourceExtensions = /\.(?:cs|c|cc|cpp|h|hpp|ts|tsx|js|mjs|vue|py|sql)$/u;
const dependencyFiles = /(?:\.csproj|\.props|\.targets|packages\.lock\.json|package(?:-lock)?\.json|pnpm-lock\.yaml|global\.json|nuget\.config)$/iu;
const discoveryPatterns = [
    ['byte-array', 'byte\\s*\\['],
    ['to-array', '\\bToArray\\s*\\('],
    ['memory-stream', '\\bMemoryStream\\b'],
    ['array-pool', '\\bArrayPool\\b'],
    ['memory-pool', '\\bMemoryPool\\b'],
    ['native-memory', '\\bNativeMemory\\b'],
    ['gc-handle', '\\bGCHandle\\b'],
    ['read-all-bytes', '\\bReadAllBytes(?:Async)?\\s*\\('],
    ['get-memory', '\\bGetMemory\\s*\\('],
    ['get-span', '\\bGetSpan\\s*\\('],
    ['try-get-array', '\\bTryGetArray\\s*\\('],
    ['database-materialization', '\\bToListAsync\\s*\\('],
    ['encoding-bytes', '\\bGetBytes\\s*\\('],
    ['native-allocation', '\\b(?:malloc|calloc|realloc)\\s*\\('],
    ['browser-buffer', '\\bnew\\s+(?:ArrayBuffer|Uint8Array)\\s*\\(']
];
const unresolvedCoverage = [
    'Every lexical site requires an explicit family resolution, including declarations and non-byte ToArray matches.',
    'Source traces are observations, not asynchronous ownership or platform qualification.',
    'Product OS/architecture support and each offline installed dependency closure need authoritative release evidence.'
];

function digest(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const loadedProducerDigest = digest(fs.readFileSync(fileURLToPath(import.meta.url)));

function git(root, args)
{
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readRegular(root, relative)
{
    if (path.isAbsolute(relative) || relative.split('/').some((part) => part === '..' || part === ''))
    {
        throw new Error(`unsafe inventory path: ${relative}`);
    }
    let cursor = root;
    for (const part of relative.split('/'))
    {
        cursor = path.join(cursor, part);
        if (fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`symbolic inventory input: ${relative}`);
        }
    }
    if (!fs.lstatSync(cursor).isFile())
    {
        throw new Error(`nonregular inventory input: ${relative}`);
    }
    return fs.readFileSync(cursor);
}

export function captureMemoryCandidate(root)
{
    root = fs.realpathSync(root);
    if (digest(readRegular(root, producerPath)) !== loadedProducerDigest)
    {
        throw new Error('candidate producer bytes differ from the loaded inventory producer');
    }
    const files = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0').filter(Boolean))].sort();
    const catalog = JSON.parse(readRegular(root, catalogPath));
    const boundaryInputs = new Set([
        ...catalog.authorities.map((entry) => entry.path),
        ...catalog.traces.flatMap((trace) => [trace.testOwner, ...trace.evidence.map((entry) => entry.path)]),
        ...(catalog.families ?? []).flatMap((family) => [family.testOwner, ...family.evidence.map((entry) => entry.path)]),
        ...(catalog.reuseOwners ?? []).map((entry) => entry.path),
        ...(catalog.supportInventory?.rows ?? []).flatMap((row) => [row.source, ...row.offlineClosure]),
        ...(catalog.supportInventory?.targetFrameworks ?? []).map((entry) => entry.project),
        ...(catalog.syntaxObserver ? [catalog.syntaxObserver.project, catalog.syntaxObserver.source] : [])
    ]);
    const selected = files.filter((file) => (file.startsWith('src/') && sourceExtensions.test(file))
        || dependencyFiles.test(file) || boundaryInputs.has(file) || file === catalogPath || file === producerPath);
    for (const input of boundaryInputs)
    {
        if (!selected.includes(input))
        {
            throw new Error(`ownership input absent from candidate roster: ${input}`);
        }
    }
    const sources = selected.map((file) => ({ path: file, sha256: digest(readRegular(root, file)) }));
    const identity = {
        commit: git(root, ['rev-parse', 'HEAD']).trim(),
        indexDigest: digest(git(root, ['ls-files', '--stage', '-z'])),
        trackedChangesDigest: digest(git(root, ['diff', '--binary', 'HEAD', '--'])),
        sources
    };
    return { ...identity, worktreeFingerprint: digest(JSON.stringify(identity)) };
}

function surface(file)
{
    if (/(?:^|\/)(?:vendor|third_party|third-party)(?:\/|$)/u.test(file))
    {
        return 'vendor-path-candidate';
    }
    if (/(?:\.generated\.|\.g\.cs$|(?:^|\/)generated\/)/iu.test(file))
    {
        return 'generated-path-candidate';
    }
    return 'owner-resolution-required';
}

export function discoverMemorySites(root, candidate)
{
    return candidate.sources.filter((file) => file.path.startsWith('src/') && sourceExtensions.test(file.path))
        .flatMap((file) => readRegular(root, file.path).toString('utf8').split(/\r?\n/u).flatMap((line, index) =>
            discoveryPatterns.filter(([, pattern]) => new RegExp(pattern, 'u').test(line)).map(([kind]) => ({
                id: `${file.path}:${index + 1}:${kind}`,
                path: file.path,
                line: index + 1,
                kind,
                sourceDigest: file.sha256,
                lineDigest: digest(line),
                surface: surface(file.path)
            }))));
}

// The reader uses ripgrep's independent matcher on the held source roster. Lexical
// matches include comments and declarations; semantic resolution must account for them.
export function independentlyDiscoverMemorySites(root, candidate)
{
    const files = candidate.sources.filter((file) => file.path.startsWith('src/') && sourceExtensions.test(file.path))
        .map((file) => file.path);
    const sites = [];
    for (const [kind, pattern] of discoveryPatterns)
    {
        for (let offset = 0; offset < files.length; offset += 128)
        {
            let output;
            try
            {
                output = execFileSync('rg', ['--json', '--no-ignore', '--no-config', '-e', pattern, '--', ...files.slice(offset, offset + 128)],
                    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            }
            catch (error)
            {
                if (error.status !== 1)
                {
                    throw error;
                }
                output = error.stdout;
            }
            for (const line of output.trim().split('\n').filter(Boolean))
            {
                const item = JSON.parse(line);
                if (item.type === 'match')
                {
                    sites.push(`${item.data.path.text}:${item.data.line_number}:${kind}`);
                }
            }
        }
    }
    return sites.sort();
}

export function validateMemoryBoundaries(catalog, root)
{
    if (catalog.schema !== 'fsusblog.memory-allocation-boundaries.v1'
        || catalog.scope !== 'inventory-only' || catalog.policy.default !== 'Auto'
        || catalog.policy.disabled !== 'stop-new-probes-and-use-then-drain'
        || catalog.policy.required !== 'never-override-safety-qualification-or-budgets'
        || Object.keys(catalog.policy).sort().join(',') !== 'default,disabled,required')
    {
        throw new Error('invalid inventory scope or default capability policy');
    }
    const responsibilities = ['publication', 'revocation', 'queue-delivery', 'configuration', 'test-topology'];
    if (catalog.authorities.length !== responsibilities.length
        || responsibilities.some((name) => catalog.authorities.filter((entry) => entry.responsibility === name).length !== 1))
    {
        throw new Error('inventory must reuse exactly one authority per responsibility');
    }
    for (const authority of catalog.authorities)
    {
        readRegular(root, authority.path);
        if (authority.disposition !== 'reuse-do-not-replace')
        {
            throw new Error('memory inventory cannot replace a product authority');
        }
    }
    for (const reuse of catalog.reuseOwners ?? [])
    {
        readRegular(root, reuse.path);
        if (reuse.disposition !== 'reuse-do-not-replace')
        {
            throw new Error('inventory cannot replace an existing admission or scheduling owner');
        }
    }
    if (catalog.supportInventory)
    {
        if (!catalog.supportInventory.rows.length)
        {
            throw new Error('missing support inventory');
        }
        const targets = new Set();
        for (const row of catalog.supportInventory.rows)
        {
            if (!row.os || !row.architecture || !row.rid || targets.has(row.rid)
                || row.status !== 'NotVerified' || !row.offlineClosure.length || !row.installedClosure)
            {
                throw new Error('inventory cannot certify a platform or conceal its offline closure');
            }
            targets.add(row.rid);
            readRegular(root, row.source);
            for (const input of row.offlineClosure)
            {
                readRegular(root, input);
            }
        }
        for (const target of catalog.supportInventory.targetFrameworks)
        {
            if (!readRegular(root, target.project).toString('utf8').includes(`<TargetFramework>${target.framework}</TargetFramework>`))
            {
                throw new Error(`target framework differs from owning project: ${target.project}`);
            }
        }
    }
    if (new Set(catalog.traces.map((trace) => trace.id)).size !== catalog.traces.length)
    {
        throw new Error('duplicate ownership trace');
    }
    for (const trace of [...catalog.traces, ...(catalog.families ?? [])])
    {
        for (const key of ['producer', 'owner', 'consumers', 'releaseEvent', 'capacityModel', 'frequency', 'asyncEscape', 'classification', 'migrationDisposition', 'observationHeadroom', 'testOwner'])
        {
            if (typeof trace[key] !== 'string' || !trace[key].trim())
            {
                throw new Error(`missing ${key}: ${trace.id}`);
            }
        }
        if (!['baseline-reported', 'owner-resolution-required'].includes(trace.pathStatus) || !trace.evidence.length)
        {
            throw new Error(`unbound ownership trace: ${trace.id}`);
        }
        for (const evidence of trace.evidence)
        {
            if (!readRegular(root, evidence.path).toString('utf8').includes(evidence.anchor))
            {
                throw new Error(`ownership anchor missing: ${trace.id}: ${evidence.path}`);
            }
        }
        readRegular(root, trace.testOwner);
        const allowed = ['public-immutable', 'private-sensitive', 'reconstructible', 'durable-authoritative', 'ephemeral-scratch', 'unclassified'];
        if (!allowed.includes(trace.classification))
        {
            throw new Error(`unknown classification: ${trace.id}`);
        }
        if (!trace.eligibilityOwner?.trim())
        {
            throw new Error(`eligibility owner missing: ${trace.id}`);
        }
        if (Object.keys(trace.permissions).sort().join(',') !== 'crossGenerationReuse,deduplication,device,disk,sharing,staleServing'
            || Object.values(trace.permissions).some((value) => value !== false))
        {
            throw new Error(`inventory alone cannot authorize migration: ${trace.id}`);
        }
    }
}

function projectFamilies(catalog, sites)
{
    if (!catalog.families)
    {
        return undefined;
    }
    const owners = new Map();
    const ids = new Set();
    for (const family of catalog.families)
    {
        if (ids.has(family.id) || !family.sourcePaths?.length || !family.exclusionReason?.trim())
        {
            throw new Error(`invalid family identity or exclusion boundary: ${family.id}`);
        }
        ids.add(family.id);
        for (const source of family.sourcePaths)
        {
            if (owners.has(source))
            {
                throw new Error(`duplicate source family: ${source}`);
            }
            owners.set(source, family.id);
        }
    }
    const observedPaths = new Set(sites.map((site) => site.path));
    for (const source of owners.keys())
    {
        if (!observedPaths.has(source))
        {
            throw new Error(`extra family source outside discovery: ${source}`);
        }
    }
    return sites.map((site) =>
    {
        const familyId = owners.get(site.path);
        if (!familyId)
        {
            throw new Error(`unexplained family source: ${site.path}`);
        }
        return { siteId: site.id, familyId, semanticLifetime: 'NotVerified' };
    });
}

function observeSyntax(root, catalog, sites)
{
    if (!catalog.syntaxObserver)
    {
        return undefined;
    }
    const executable = process.env.FSUS_MEMORY_SYNTAX_OBSERVER;
    if (!executable || !path.isAbsolute(executable) || fs.lstatSync(executable).isSymbolicLink())
    {
        throw new Error('explicit regular absolute FSUS_MEMORY_SYNTAX_OBSERVER DLL required');
    }
    const artifacts = fs.readdirSync(path.dirname(executable)).sort()
        .filter((name) => /\.(?:dll|deps\.json|runtimeconfig\.json)$/u.test(name))
        .map((name) => ({ name, digest: digest(fs.readFileSync(path.join(path.dirname(executable), name))) }));
    const grouped = new Map();
    for (const site of sites.filter((item) => item.path.endsWith('.cs')))
    {
        if (!grouped.has(site.path))
        {
            grouped.set(site.path, { path: site.path, source: readRegular(root, site.path).toString('utf8'), sites: [] });
        }
        grouped.get(site.path).sites.push({ id: site.id, line: site.line,
            pattern: discoveryPatterns.find(([kind]) => kind === site.kind)[1] });
    }
    const result = JSON.parse(execFileSync('dotnet', [executable],
        { input: JSON.stringify([...grouped.values()]), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const expected = sites.filter((item) => item.path.endsWith('.cs'));
    if (result.schema !== 'fsusblog.memory-syntax-observation.v1' || result.evidenceLevel !== 'csharp-syntax-only'
        || result.observations.length !== expected.length
        || result.observations.some((item, index) => item.id !== expected[index].id
            || item.sourceDigest !== expected[index].sourceDigest || !item.facts.length))
    {
        throw new Error('syntax observer coverage or identity mismatch');
    }
    return { dotnetSdk: execFileSync('dotnet', ['--version'], { encoding: 'utf8' }).trim(), artifacts, ...result };
}

export function produceMemoryInventory(root, runId)
{
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/u.test(runId))
    {
        throw new Error('bounded run identity required');
    }
    const candidate = captureMemoryCandidate(root);
    const catalog = JSON.parse(readRegular(root, catalogPath));
    validateMemoryBoundaries(catalog, root);
    const sites = discoverMemorySites(root, candidate);
    const families = projectFamilies(catalog, sites);
    const syntax = observeSyntax(root, catalog, sites);
    const inventory = {
        schema: 'fsusblog.memory-allocation-inventory.v1',
        runId,
        evidenceLevel: 'lexical-discovery-and-source-traces',
        acceptance: 'NotVerified',
        candidate,
        toolchain: {
            node: process.version,
            nodeExecutableDigest: digest(fs.readFileSync(process.execPath)),
            ripgrep: execFileSync('rg', ['--version'], { encoding: 'utf8' }).trim()
        },
        coverage: { discoveredSites: sites.length, resolvedSites: 0, unresolvedSites: sites.length },
        sites,
        traces: catalog.traces,
        ...(families ? { families: catalog.families, familyMapping: families, syntax, supportInventory: catalog.supportInventory, reuseOwners: catalog.reuseOwners } : {}),
        unresolved: unresolvedCoverage
    };
    if (captureMemoryCandidate(root).worktreeFingerprint !== candidate.worktreeFingerprint)
    {
        throw new Error('candidate mutated during discovery');
    }
    return inventory;
}

export function verifyMemoryInventory(root, inventory, { requireComplete = false } = {})
{
    if (inventory.schema !== 'fsusblog.memory-allocation-inventory.v1'
        || inventory.evidenceLevel !== 'lexical-discovery-and-source-traces' || inventory.acceptance !== 'NotVerified'
        || typeof inventory.runId !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/u.test(inventory.runId))
    {
        throw new Error('invalid inventory evidence envelope');
    }
    let candidate;
    try
    {
        candidate = captureMemoryCandidate(root);
    }
    catch (error)
    {
        throw new Error('stale inventory: candidate inputs cannot be read', { cause: error });
    }
    if (JSON.stringify(inventory.candidate) !== JSON.stringify(candidate))
    {
        throw new Error('stale inventory: commit, index or worktree source identity changed');
    }
    const catalog = JSON.parse(readRegular(root, catalogPath));
    validateMemoryBoundaries(catalog, root);
    const currentToolchain = {
        node: process.version,
        nodeExecutableDigest: digest(fs.readFileSync(process.execPath)),
        ripgrep: execFileSync('rg', ['--version'], { encoding: 'utf8' }).trim()
    };
    if (JSON.stringify(inventory.toolchain) !== JSON.stringify(currentToolchain))
    {
        throw new Error('inventory toolchain identity changed');
    }
    if (JSON.stringify(inventory.traces) !== JSON.stringify(catalog.traces))
    {
        throw new Error('ownership trace differs from bound catalog');
    }
    const expectedSites = discoverMemorySites(root, candidate);
    const independentlyFound = independentlyDiscoverMemorySites(root, candidate);
    if (JSON.stringify(inventory.sites) !== JSON.stringify(expectedSites)
        || JSON.stringify(inventory.sites.map((site) => site.id).sort()) !== JSON.stringify(independentlyFound))
    {
        throw new Error('discovery-to-inventory mismatch: missing, extra, duplicate or changed site');
    }
    const familyMapping = projectFamilies(catalog, expectedSites);
    if (familyMapping && (JSON.stringify(inventory.families) !== JSON.stringify(catalog.families)
        || JSON.stringify(inventory.familyMapping) !== JSON.stringify(familyMapping)
        || JSON.stringify(inventory.supportInventory) !== JSON.stringify(catalog.supportInventory)
        || JSON.stringify(inventory.reuseOwners) !== JSON.stringify(catalog.reuseOwners)
        || JSON.stringify(inventory.syntax) !== JSON.stringify(observeSyntax(root, catalog, expectedSites))))
    {
        throw new Error('family, support boundary or syntax observation changed');
    }
    const expectedCoverage = { discoveredSites: expectedSites.length, resolvedSites: 0, unresolvedSites: expectedSites.length };
    if (JSON.stringify(inventory.coverage) !== JSON.stringify(expectedCoverage)
        || JSON.stringify(inventory.unresolved) !== JSON.stringify(unresolvedCoverage))
    {
        throw new Error('inventory cannot conceal unresolved coverage');
    }
    if (captureMemoryCandidate(root).worktreeFingerprint !== candidate.worktreeFingerprint)
    {
        throw new Error('candidate mutated during independent verification');
    }
    if (requireComplete)
    {
        throw new Error(`MEM-P00 acceptance blocked: ${expectedSites.length} unresolved lexical sites; platform/dependency closure NotVerified`);
    }
    return { identityVerified: true, independentDiscoveryVerified: true, coverage: expectedCoverage, acceptance: 'NotVerified' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
{
    try
    {
        const [mode, file, runId, ...extra] = process.argv.slice(2);
        if (!['produce', 'verify'].includes(mode) || !file
            || (mode === 'produce' && (!runId || extra.length))
            || (mode === 'verify' && (extra.length || (runId !== undefined && runId !== '--require-complete'))))
        {
            throw new Error('usage: node tools/governance/memory-allocation-inventory.mjs produce <file> <run-id> | verify <file> [--require-complete]');
        }
        if (mode === 'produce')
        {
            const inventory = produceMemoryInventory(process.cwd(), runId);
            fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
            fs.writeFileSync(file, `${JSON.stringify(inventory, null, 4)}\n`, { flag: 'wx', mode: 0o600 });
            process.stdout.write(`${JSON.stringify({ runId, candidate: inventory.candidate.commit, coverage: inventory.coverage, acceptance: inventory.acceptance })}\n`);
        }
        else
        {
            process.stdout.write(`${JSON.stringify(verifyMemoryInventory(process.cwd(), JSON.parse(fs.readFileSync(file, 'utf8')),
                { requireComplete: runId === '--require-complete' }))}\n`);
        }
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
