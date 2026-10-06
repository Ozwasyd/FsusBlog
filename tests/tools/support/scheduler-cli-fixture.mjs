import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { buildCorrectnessAttemptProducerInventory } = await import(new URL('../../../tools/test/correctness-attempt-producers.mjs', import.meta.url));
const { parseMatrix } = await import(new URL('../../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const { validateRepositoryReleaseFinalStaticBoundary, writeReleaseFinalExecutionAuthority } = await import(new URL('../../../tools/test-matrix/release-final-static-boundary.mjs', import.meta.url));

function digest(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function flowValue(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(flowValue).join(', ')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.entries(value).map(([key, entry]) =>
        {
            assert.match(key, /^[A-Za-z_][A-Za-z0-9_.-]*$/u);
            return `${key}: ${flowValue(entry)}`;
        }).join(', ')}}`;
    }
    return JSON.stringify(value);
}

function evidenceClass(tier)
{
    return tier.evidenceClass ?? (tier.ciJob === 'browser-diagnostics' ? 'diagnostic' : 'correctness');
}

// The CLI admits a complete repository, even when a test executes only one tier.
// Keep canonical membership and the real finalizer; unselected fixture commands
// are inert and never represent production execution or release evidence.
export function prepareSchedulerCliMatrixFixture(sourceRepositoryRoot, repositoryRoot, matrixFile, { beforeSeal } = {})
{
    assert.notEqual(path.resolve(sourceRepositoryRoot), path.resolve(repositoryRoot));
    const readSource = (relative) => fs.readFileSync(path.join(sourceRepositoryRoot, relative), 'utf8');
    const canonical = parseMatrix(readSource('tests/matrix.yml'));
    const selected = parseMatrix(fs.readFileSync(matrixFile, 'utf8')).tiers;
    const canonicalById = new Map(canonical.tiers.map((tier) => [tier.id, tier]));
    const selectedById = new Map();
    for (const tier of selected)
    {
        assert.ok(canonicalById.has(tier.id), `fixture tier must use a canonical producer id: ${tier.id}`);
        assert.notEqual(tier.id, 'release-final', 'fixture cannot replace the finalizer');
        assert.equal(selectedById.has(tier.id), false, `duplicate fixture tier: ${tier.id}`);
        assert.equal(evidenceClass(tier), evidenceClass(canonicalById.get(tier.id)));
        assert.match(tier.command, /^node tools\/fixtures\/[A-Za-z0-9_-]+\.mjs$/u);
        selectedById.set(tier.id, tier);
    }
    const authority = JSON.parse(readSource('tests/fixtures/test-matrix/release-final-execution-target-authority.json'));
    const finalTarget = authority.targets.find((target) => target.target === 'tools/test/lanes/release-final.sh');
    assert.ok(finalTarget);
    const closureByPath = new Map(authority.closureFiles.map((entry) => [entry.path, entry]));
    for (const relative of [finalTarget.target, ...finalTarget.dependencyClosure])
    {
        const bytes = fs.readFileSync(path.join(sourceRepositoryRoot, relative));
        const expected = relative === finalTarget.target ? finalTarget : closureByPath.get(relative);
        assert.equal(digest(bytes), expected?.contentDigest, `stale finalizer closure: ${relative}`);
        const target = path.join(repositoryRoot, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(sourceRepositoryRoot, relative), target);
    }
    const inputsRelative = 'tests/fixtures/test-matrix/release-final-evidence-inputs.json';
    fs.mkdirSync(path.dirname(path.join(repositoryRoot, inputsRelative)), { recursive: true });
    fs.copyFileSync(path.join(sourceRepositoryRoot, inputsRelative), path.join(repositoryRoot, inputsRelative));
    const tiers = canonical.tiers.map((tier) => selectedById.get(tier.id)
        ?? (tier.id === 'release-final' ? tier : {
            ...tier,
            command: tier.command ? 'echo fixture-unselected' : tier.command,
            executionDependsOn: [],
            localOnly: true,
            smartGateMode: 'full-only'
        }));
    const matrixSource = [
        `version: ${canonical.version}`,
        'finalizerAuthorities:',
        '    release-final:',
        ...Object.entries(canonical.finalizerAuthorities['release-final'])
            .map(([key, value]) => `        ${key}: ${flowValue(value)}`),
        'tiers:',
        ...tiers.flatMap((tier) => Object.entries(tier).map(([key, value], index) => (
            `${index === 0 ? '  - ' : '    '}${key}: ${flowValue(value)}`
        )))
    ].join('\n') + '\n';
    fs.writeFileSync(matrixFile, matrixSource);
    fs.writeFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), matrixSource);

    // Seal the explicit controlled entrypoints independently, then let the
    // production generator inspect their bytes and complete dependency closure.
    const declarationsByTarget = new Map([[finalTarget.target, structuredClone(finalTarget.declarations)]]);
    for (const tier of selected)
    {
        const argv = tier.command.split(' ');
        const declarations = declarationsByTarget.get(argv[1]) ?? [];
        declarations.push({
            owner: tier.id,
            commandKind: tier.commandKind ?? null,
            executionMode: tier.executionMode ?? null,
            executableKind: 'node-entrypoint',
            argv
        });
        declarationsByTarget.set(argv[1], declarations);
    }
    const projection = [...declarationsByTarget.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, declarations]) => ({
            target,
            declarations: declarations.sort((left, right) => left.owner.localeCompare(right.owner))
        }));
    const indexRelative = 'config/testing/release-final-execution-authority-index.json';
    const sourceIndex = JSON.parse(readSource(indexRelative));
    sourceIndex.declarationsDigest = digest(JSON.stringify(projection));
    sourceIndex.targetPathsDigest = digest(JSON.stringify(projection.map(({ target }) => target)));
    fs.writeFileSync(path.join(repositoryRoot, indexRelative), JSON.stringify(sourceIndex, null, 4) + '\n');
    const inventory = buildCorrectnessAttemptProducerInventory(repositoryRoot);
    const canonicalInventory = buildCorrectnessAttemptProducerInventory(sourceRepositoryRoot);
    assert.deepEqual(
        inventory.entries.map(({ producerId }) => producerId),
        canonicalInventory.entries.map(({ producerId }) => producerId),
        'controlled commands must not remove or invent canonical correctness producers'
    );
    fs.writeFileSync(path.join(repositoryRoot, 'config/testing/correctness-attempt-producers.json'),
        JSON.stringify(inventory, null, 4) + '\n');
    // Intentional fixture fault injection belongs before the source/index seal;
    // edits made after this point must still fail production admission.
    beforeSeal?.();
    execFileSync('git', ['add', '--all', '--', 'config', 'tools', 'tests'], { cwd: repositoryRoot });
    writeReleaseFinalExecutionAuthority(repositoryRoot);
    assert.deepEqual(validateRepositoryReleaseFinalStaticBoundary(repositoryRoot), []);
}
