import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    createBehaviorDocAdmissionFixture
} from './support/behavior-doc-admission-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const { buildExecutionDependencyContract } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/execution-dependency-contract.mjs')).href
);
const {
    buildReleaseFinalizerPlan,
    buildReleaseFinalEvidenceContract,
    loadCanonicalReleaseFinalEvidenceInputs,
    validateCanonicalReleaseFinalEvidenceInputs,
    validateReleaseFinalEvidenceBinding
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/release-final-evidence-contract.mjs')).href);
const contractFile = path.join(root, 'tests/fixtures/test-matrix/execution-dependency-contract.json');
const evidenceContractFile = path.join(root, 'tests/fixtures/test-matrix/release-final-evidence-contract.json');
const canonicalEvidenceInputDigest =
    'sha256:fd5f9d29e4665f03154e4b2dc812a564e957c2762470c834b8539f43b95f7eb5';

function evidenceInputDigest(inputs)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(inputs)).digest('hex')}`;
}

function replaceTierField(source, tierId, field, value)
{
    const lines = source.split('\n');
    const tierStart = lines.findIndex((line) => line === `    - id: ${tierId}`);
    assert.notEqual(tierStart, -1, `fixture matrix is missing tier ${tierId}`);
    const tierEndOffset = lines.slice(tierStart + 1).findIndex((line) => line.startsWith('    - id: '));
    const tierEnd = tierEndOffset === -1 ? lines.length : tierStart + 1 + tierEndOffset;
    const fieldIndex = lines.slice(tierStart, tierEnd).findIndex((line) => line.startsWith(`      ${field}:`));
    assert.notEqual(fieldIndex, -1, `${tierId} is missing field ${field}`);
    const absoluteFieldIndex = tierStart + fieldIndex;
    let nextFieldIndex = absoluteFieldIndex + 1;
    while (nextFieldIndex < tierEnd && !/^ {6}[A-Za-z][A-Za-z0-9]*:/u.test(lines[nextFieldIndex]))
    {
        nextFieldIndex += 1;
    }
    lines.splice(absoluteFieldIndex, nextFieldIndex - absoluteFieldIndex, `      ${field}: ${value}`);
    return lines.join('\n');
}

test('carried execution dependency contract seals every tier and command-group edge', () =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
    assert.equal(contract.schema, 'fsusblog.test-matrix-execution-dependency-contract.v1');
    assert.equal(contract.tierCount, matrix.tiers.length);
    assert.equal(
        contract.executionEdgeCount,
        matrix.tiers.reduce((count, tier) => count + tier.executionDependsOn.length, 0)
    );
    assert.deepEqual(contract, buildExecutionDependencyContract(matrix));
});

test('independent release-final evidence contract seals the canonical exact set', () =>
{
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    const contract = JSON.parse(readFileSync(evidenceContractFile, 'utf8'));
    const producerSource = readFileSync(
        path.join(root, 'tools/test-matrix/release-final-evidence-contract.mjs'),
        'utf8'
    );

    assert.deepEqual(validateCanonicalReleaseFinalEvidenceInputs(canonical), []);
    assert.equal(canonical.schema, 'fsusblog.release-final-evidence-inputs.v1');
    assert.equal(canonical.targetTier, 'release-final');
    assert.equal(canonical.inputs.length, 21);
    assert.deepEqual(canonical.inputs, [...canonical.inputs].sort());
    assert.equal(new Set(canonical.inputs).size, canonical.inputs.length);
    assert.deepEqual(contract, buildReleaseFinalEvidenceContract(canonical));
    assert.equal(contract.source, 'tests/fixtures/test-matrix/release-final-evidence-inputs.json');
    assert.equal(contract.inputCount, 21);
    assert.equal(contract.inputDigest, canonicalEvidenceInputDigest);
    assert.equal(evidenceInputDigest(canonical.inputs), canonicalEvidenceInputDigest);
    assert.doesNotMatch(producerSource, /parseMatrix|tests\/matrix\.yml/u);
    assert.match(producerSource, /const canonical = loadCanonicalReleaseFinalEvidenceInputs\(\)/u);

    const producerCheck = spawnSync(
        process.execPath,
        [path.join(root, 'tools/test-matrix/release-final-evidence-contract.mjs'), '--check'],
        {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                FSUSBLOG_MATRIX_FILE: path.join(root, 'tests/fixtures/test-matrix/does-not-exist.yml')
            }
        }
    );
    assert.equal(producerCheck.status, 0, `${producerCheck.stdout}\n${producerCheck.stderr}`);
});

test('fixed release-final evidence digest rejects every canonical exact-set mutation', async (context) =>
{
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    const mutations = [
        ['deletion', canonical.inputs.slice(1)],
        ['replacement', canonical.inputs.map((input, index) => index === 0 ? 'validate-matrix' : input)],
        ['duplication', canonical.inputs.map((input, index) => index === 1 ? canonical.inputs[0] : input)],
        ['addition', [...canonical.inputs, 'validate-matrix']]
    ];

    for (const [name, inputs] of mutations)
    {
        await context.test(name, () =>
        {
            assert.notEqual(
                evidenceInputDigest(inputs),
                canonicalEvidenceInputDigest,
                `${name} must not be blessable by changing the fixture, matrix, and generated contract together`
            );
        });
    }
});

test('release-final tier separates an empty execution graph from the canonical evidence inputs', () =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    const schema = JSON.parse(readFileSync(path.join(root, 'tests/matrix.schema.json'), 'utf8'));
    const tierSchema = schema.properties.tiers.items;
    const releaseFinalTier = matrix.tiers.find((tier) => tier.id === 'release-final');
    const generatedDocs = readFileSync(path.join(root, 'docs/testing.generated.md'), 'utf8');
    const releaseFinalRow = generatedDocs.split('\n').find((line) => line.startsWith('| `release-final` |'));

    assert.ok(releaseFinalTier, 'matrix must contain release-final tier');
    assert.equal(releaseFinalTier.executionMode, 'summary');
    assert.equal(releaseFinalTier.commandKind, 'finalizer');
    assert.equal(releaseFinalTier.summaryAuthority, 'release-final');
    assert.deepEqual(
        releaseFinalTier.summaryInputs,
        ['fsusblog.release-final-evidence-inputs.v1']
    );
    assert.equal(
        releaseFinalTier.outputReceiptSchema,
        'fsusblog.release-final-test-evidence-binding.v1'
    );
    assert.deepEqual(releaseFinalTier.services ?? [], []);
    assert.equal(releaseFinalTier.requiresBootstrap, 'none');
    assert.equal(releaseFinalTier.requiresDotnet, false);
    assert.equal(releaseFinalTier.requiresNode, true);
    assert.equal(releaseFinalTier.requiresPlaywright, 'none');
    assert.equal(releaseFinalTier.cacheProfile, 'none');
    assert.deepEqual(releaseFinalTier.executionDependsOn, []);
    assert.equal(tierSchema.required.includes('executionDependsOn'), true);
    assert.equal(tierSchema.required.includes('dependsOn'), false);
    assert.equal(Object.hasOwn(tierSchema.properties, 'executionDependsOn'), true);
    assert.equal(Object.hasOwn(tierSchema.properties, 'dependsOn'), false);
    assert.equal(Object.hasOwn(tierSchema.properties, 'requiresEvidenceFrom'), true);
    assert.deepEqual(validateReleaseFinalEvidenceBinding(matrix, canonical), []);
    assert.deepEqual(buildReleaseFinalizerPlan(matrix).errors, []);
    assert.deepEqual(releaseFinalTier.requiresEvidenceFrom, canonical.inputs);
    for (const producerTierId of canonical.inputs)
    {
        assert.ok(matrix.tiers.some((tier) => tier.id === producerTierId), `${producerTierId} must remain a tier`);
        assert.equal(
            releaseFinalTier.executionDependsOn.includes(producerTierId),
            false,
            `${producerTierId} must remain evidence-only`
        );
    }
    assert.match(generatedDocs, /\| Execution depends on \| Evidence inputs \|/u);
    assert.ok(
        releaseFinalRow.includes(canonical.inputs.map((id) => `\`${id}\``).join(', ')),
        'generated release-final row must publish the exact canonical evidence input sequence'
    );
});

test('release-final exact-set binding rejects deletion, replacement, duplication, and addition', async (context) =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    const mutations = [
        {
            name: 'deletion',
            mutate(tier)
            {
                tier.requiresEvidenceFrom.splice(tier.requiresEvidenceFrom.indexOf('browser-contract'), 1);
            },
            diagnostics: [
                /exactly 21 canonical evidence inputs/u,
                /missing canonical evidence inputs: browser-contract/u
            ]
        },
        {
            name: 'replacement',
            mutate(tier)
            {
                tier.requiresEvidenceFrom[tier.requiresEvidenceFrom.indexOf('browser-contract')] =
                    'validate-matrix';
            },
            diagnostics: [
                /missing canonical evidence inputs: browser-contract/u,
                /unexpected evidence inputs: validate-matrix/u
            ]
        },
        {
            name: 'duplication',
            mutate(tier)
            {
                tier.requiresEvidenceFrom[tier.requiresEvidenceFrom.indexOf('coverage-gate-strict')] =
                    'browser-contract';
            },
            diagnostics: [
                /duplicates: browser-contract/u,
                /missing canonical evidence inputs: coverage-gate-strict/u
            ]
        },
        {
            name: 'addition',
            mutate(tier)
            {
                tier.requiresEvidenceFrom.push('validate-matrix');
            },
            diagnostics: [/exactly 21 canonical evidence inputs/u, /unexpected evidence inputs: validate-matrix/u]
        }
    ];

    for (const mutation of mutations)
    {
        await context.test(mutation.name, () =>
        {
            const mutated = structuredClone(matrix);
            const releaseFinalTier = mutated.tiers.find((tier) => tier.id === canonical.targetTier);
            mutation.mutate(releaseFinalTier);
            const errors = validateReleaseFinalEvidenceBinding(mutated, canonical);
            assert.notDeepEqual(errors, []);
            const diagnostics = errors.join('\n');
            for (const expected of mutation.diagnostics)
            {
                assert.match(diagnostics, expected);
            }
        });
    }
});

test('default and CI plans contain one finalizer plus the exact evidence-only producer inputs', () =>
{
    const canonical = loadCanonicalReleaseFinalEvidenceInputs();
    for (const [command, args] of [
        ['./tools/test.sh', ['release-final', '--plan-only']],
        [process.execPath, ['tools/run-test-matrix.mjs', 'ci-release-final', '--plan-only']]
    ])
    {
        const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, output);
        const planLines = output.match(/^\d+\. [^\n]+/gmu) ?? [];
        assert.equal(planLines.length, 1, output);
        assert.match(planLines[0], /^1\. release-final\b/u);
        const evidenceInputs = output.match(/\bevidenceInputs=([^\s]+)/u);
        assert.ok(evidenceInputs, output);
        assert.deepEqual(evidenceInputs[1].split(','), canonical.inputs);
        assert.doesNotMatch(output, /executionDeps=/u);
    }
});

test('default and CI execution commands spawn only the finalizer', () =>
{
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-final-graph-'));
    const bin = path.join(fixture, 'bin');
    const log = path.join(fixture, 'spawn.log');
    const forbidden = [
        'dotnet', 'npm', 'pnpm', 'yarn', 'vitest', 'playwright', 'bootstrap-acceptance',
        'docker', 'postgres', 'postgresql', 'redis-server', 'backend', 'frontend',
        'load', 'soak', 'scale', 'benchmark', 'mutation', 'fuzz'
    ];
    try
    {
        mkdirSync(bin);
        writeFileSync(log, '');
        for (const name of forbidden)
        {
            const command = path.join(bin, name);
            writeFileSync(
                command,
                `#!/usr/bin/env bash\nprintf '%s\\n' "${name}:$*" >> "$FSUSBLOG_SPAWN_LOG"\nexit 97\n`
            );
            chmodSync(command, 0o755);
        }
        const admission = createBehaviorDocAdmissionFixture({
            sourceRepositoryRoot: root,
            repositoryRoot: root,
            runId: 'release-final-execution-graph',
            receiptFile: path.join(fixture, 'behavior-doc-admission.json')
        });
        const environment = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FSUSBLOG_SPAWN_LOG: log,
            FSUSBLOG_NODE: process.execPath,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT: admission.receiptFile,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST: admission.contentDigest,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID: admission.runId
        };
        const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
        const producerTierIds = matrix.tiers.find((tier) => tier.id === 'release-final').requiresEvidenceFrom;
        let isolatedMatrix = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
        isolatedMatrix = replaceTierField(isolatedMatrix, 'release-final', 'command', '/bin/true');
        isolatedMatrix = replaceTierField(isolatedMatrix, 'release-final', 'artifacts', '[]');
        isolatedMatrix = replaceTierField(isolatedMatrix, 'release-final', 'evidence', '[]');
        const isolatedMatrixFile = path.join(fixture, 'matrix.yml');
        writeFileSync(isolatedMatrixFile, isolatedMatrix);

        for (const [command, args] of [
            ['./tools/test.sh', ['release-final']],
            ['./tools/test.sh', ['ci-tier', 'release-final']],
            [process.execPath, ['tools/run-test-matrix.mjs', 'ci-release-final']]
        ])
        {
            const result = spawnSync(command, args, {
                cwd: root,
                detached: process.platform !== 'win32',
                encoding: 'utf8',
                env: { ...environment, FSUSBLOG_MATRIX_FILE: isolatedMatrixFile }
            });
            const output = `${result.stdout}\n${result.stderr}`;
            assert.equal(
                result.status,
                0,
                `${command} ${args.join(' ')} isolated execution graph must succeed\n${output}`
            );
            for (const producerTierId of producerTierIds)
            {
                assert.equal(
                    output.includes(`[matrix:${producerTierId}]`),
                    false,
                    `${command} ${args.join(' ')} must not schedule producer tier ${producerTierId}`
                );
            }
        }
        assert.equal(readFileSync(log, 'utf8'), '', 'release-final must not execute any blocked producer command');

        const marker = path.join(fixture, 'producer-marker');
        writeFileSync(marker, '#!/usr/bin/env bash\nprintf "production-correctness\\n" >> "$FSUSBLOG_SPAWN_LOG"\n');
        chmodSync(marker, 0o755);
        let injectedMatrix = isolatedMatrix;
        injectedMatrix = replaceTierField(
            injectedMatrix,
            'release-final',
            'executionDependsOn',
            '[production-correctness]'
        );
        injectedMatrix = replaceTierField(injectedMatrix, 'production-correctness', 'executionDependsOn', '[]');
        injectedMatrix = replaceTierField(injectedMatrix, 'production-correctness', 'command', marker);
        injectedMatrix = replaceTierField(injectedMatrix, 'production-correctness', 'artifacts', '[]');
        injectedMatrix = replaceTierField(injectedMatrix, 'production-correctness', 'evidence', '[]');
        const injectedMatrixFile = path.join(fixture, 'mutated-matrix.yml');
        writeFileSync(injectedMatrixFile, injectedMatrix);
        const mutationResult = spawnSync('./tools/test.sh', ['release-final'], {
            cwd: root,
            detached: process.platform !== 'win32',
            encoding: 'utf8',
            env: { ...environment, FSUSBLOG_MATRIX_FILE: injectedMatrixFile }
        });
        assert.equal(mutationResult.status, 0, 'mutated fixture must reach and execute the injected producer');
        assert.match(
            `${mutationResult.stdout}\n${mutationResult.stderr}`,
            /\[matrix:production-correctness\]/u,
            'fixture must directly observe the injected producer tier entering the scheduler'
        );
        assert.match(
            readFileSync(log, 'utf8'),
            /^production-correctness$/mu,
            'fixture must fail only after the injected producer process was actually spawned'
        );
    }
    finally
    {
        rmSync(fixture, { recursive: true, force: true });
    }
});
