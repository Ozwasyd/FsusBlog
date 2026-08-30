import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs';
import { validateEvidenceExecutionDeclaration } from '../../tools/test-matrix/projection-declaration.mjs';
import {
    buildReleaseFinalizerSpawnDecision,
    validateReleaseFinalStaticBoundary
} from '../../tools/test-matrix/release-final-static-boundary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptSource = readFileSync(path.join(root, 'tools/test/lanes/release-final.sh'), 'utf8');
const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));

test('release-final script and execution graph expose only the finalizer consumer', () =>
{
    assert.deepEqual(validateReleaseFinalStaticBoundary({ matrix, scriptSource }), []);
    assert.doesNotMatch(
        scriptSource,
        /create-correctness|publish-release-final-evidence-parent|governance|repair|mutation/u
    );
});

test('missing, failed, and stale seals keep finalizer spawn count at zero', async (context) =>
{
    for (const sealState of ['missing', 'failed', 'stale'])
    {
        await context.test(sealState, () =>
        {
            assert.deepEqual(buildReleaseFinalizerSpawnDecision({ sealState }), {
                schema: 'fsusblog.release-finalizer-spawn-decision.v1',
                sealState,
                eligible: false,
                spawnCount: 0,
                failureReasons: [`release-final seal state is ${sealState}`]
            });
        });
    }
});

test('accepted seal exposes one spawn only while the static boundary remains valid', () =>
{
    const accepted = buildReleaseFinalizerSpawnDecision({ sealState: 'accepted' });
    assert.equal(accepted.eligible, true);
    assert.equal(accepted.spawnCount, 1);

    const rejected = buildReleaseFinalizerSpawnDecision({
        sealState: 'accepted',
        boundaryErrors: ['release-final contains a forbidden capability']
    });
    assert.equal(rejected.eligible, false);
    assert.equal(rejected.spawnCount, 0);
});

test('static boundary kills direct and hidden forbidden command mutations', async (context) =>
{
    const mutations = [
        ['producer', `${scriptSource}\n"$NODE_BIN" "$ROOT_DIR/tools/example-producer.mjs"\n`],
        ['repair', `${scriptSource}\nrepair_command="$ROOT_DIR/tools/example.mjs"\n"$NODE_BIN" "$repair_command"\n`],
        ['parser', `${scriptSource}\nsource "$ROOT_DIR/tools/example-parser.sh"\n`],
        ['mutation', `${scriptSource}\nbash -c 'node tools/example-mutation.mjs'\n`],
        ['governance', `${scriptSource}\n"$NODE_BIN" "$ROOT_DIR/tools/governance/example.mjs"\n`],
        ['create-correctness', `${scriptSource}\n"$NODE_BIN" "$ROOT_DIR/tools/release/test-evidence-receipts-cli.mjs" create-correctness\n`],
        ['publish-parent', `${scriptSource}\n"$NODE_BIN" "$ROOT_DIR/tools/test/publish-release-final-evidence-parent.mjs"\n`]
    ];
    for (const [name, mutatedSource] of mutations)
    {
        await context.test(name, () =>
        {
            const errors = validateReleaseFinalStaticBoundary({ matrix, scriptSource: mutatedSource });
            assert.notDeepEqual(errors, []);
            assert.equal(
                buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
                0
            );
        });
    }
});

test('execution graph mutation is rejected before finalizer or producer spawn', () =>
{
    const mutated = structuredClone(matrix);
    const tier = mutated.tiers.find((entry) => entry.id === 'release-final');
    tier.executionDependsOn = ['production-correctness'];

    const errors = validateReleaseFinalStaticBoundary({ matrix: mutated, scriptSource });
    assert.match(errors.join('\n'), /execution graph: release-final\.executionDependsOn must be empty/u);
    assert.equal(
        buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
        0
    );
});

test('duplicate finalizer command, authority alias, and shadow tier fail closed', async (context) =>
{
    const canonicalTier = matrix.tiers.find((entry) => entry.id === 'release-final');
    const canonicalAuthority = matrix.finalizerAuthorities['release-final'];
    const mutations = [
        ['shadow tier', (mutated) =>
        {
            mutated.tiers.push({ ...structuredClone(canonicalTier), id: 'release-final-shadow' });
        }, /exactly one release-final tier[\s\S]*release-final-shadow/u],
        ['command alias', (mutated) =>
        {
            const alias = structuredClone(canonicalTier);
            alias.id = 'release-final-command-alias';
            alias.summaryAuthority = 'release-final-command-alias';
            mutated.tiers.push(alias);
        }, /exactly one release-final tier[\s\S]*release-final-command-alias/u],
        ['authority alias', (mutated) =>
        {
            mutated.finalizerAuthorities['release-final-authority-alias'] = {
                ...structuredClone(canonicalAuthority),
                id: 'release-final-authority-alias',
                summaryTierIds: ['release-final-authority-alias']
            };
        }, /exactly one release-final finalizer authority[\s\S]*release-final-authority-alias/u]
    ];

    for (const [name, mutate, diagnostic] of mutations)
    {
        await context.test(name, () =>
        {
            const mutated = structuredClone(matrix);
            mutate(mutated);
            const errors = validateReleaseFinalStaticBoundary({ matrix: mutated, scriptSource });
            assert.match(errors.join('\n'), diagnostic);
            assert.equal(
                buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
                0
            );
        });
    }
});

test('generic execute tiers cannot hide finalizer path aliases', async (context) =>
{
    const commandAliases = [
        './tools/test/lanes/release-final.sh',
        'tools/test/lanes/./release-final.sh',
        'bash tools/test/lanes/release-final.sh'
    ];

    for (const [index, command] of commandAliases.entries())
    {
        await context.test(command, () =>
        {
            const mutated = structuredClone(matrix);
            const aliasTier = {
                id: `release-final-path-alias-${index + 1}`,
                executionMode: 'execute',
                commandKind: 'producer',
                command
            };
            assert.deepEqual(validateEvidenceExecutionDeclaration(aliasTier, mutated), []);
            mutated.tiers.push(aliasTier);

            const errors = validateReleaseFinalStaticBoundary({ matrix: mutated, scriptSource });
            assert.match(
                errors.join('\n'),
                new RegExp(`exactly one release-final tier[\\s\\S]*${aliasTier.id}`, 'u')
            );
            assert.equal(
                buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
                0
            );
        });
    }
});

test('unknown seal states and malformed boundary diagnostics fail closed', () =>
{
    assert.throws(
        () => buildReleaseFinalizerSpawnDecision({ sealState: 'recovered' }),
        /unknown release-final seal state/u
    );
    assert.throws(
        () => buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: [null] }),
        /boundaryErrors must be an array of strings/u
    );
});
