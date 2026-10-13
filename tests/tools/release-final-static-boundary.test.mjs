import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    linkSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs';
import { runDag } from '../../tools/test-matrix/scheduler.mjs';
import { validateEvidenceExecutionDeclaration } from '../../tools/test-matrix/projection-declaration.mjs';
import { createReleaseFinalSpawnSeal } from '../../tools/test-matrix/release-final-spawn-seal.mjs';
import {
    applyReleaseFinalizerSpawnDecision,
    buildReleaseFinalizerSpawnDecision,
    inspectReleaseFinalCommandTarget,
    validateReleaseFinalStaticBoundary
} from '../../tools/test-matrix/release-final-static-boundary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptSource = readFileSync(path.join(root, 'tools/test/lanes/release-final.sh'), 'utf8');
const schedulerSource = readFileSync(path.join(root, 'tools/test-matrix/scheduler.mjs'), 'utf8');
const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const digest = (character) => `sha256:${character.repeat(64)}`;
const digestText = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const spawnSealAuthority = {
    schedulerNonce: 'a'.repeat(64),
    schedulerRunId: 'release-final-test-run',
    schedulerCandidateIdentityDigest: digest('b'),
    sourceState: { commit: 'c'.repeat(40), worktreeFingerprint: digest('d') },
    context: {
        contentDigest: digest('e'),
        attemptId: 'attempt-1',
        candidateIdentity: { id: 'candidate', digest: digest('f') },
        buildIdentity: { id: 'build', digest: digest('0') }
    },
    evidenceBindings: [
        {
            authorityId: 'manifest', bindingDigest: digest('1'), inputDigest: digest('2'),
            producerReceiptDigest: digest('3')
        },
        {
            authorityId: 'domain', bindingDigest: digest('4'), inputDigest: digest('5'),
            producerReceiptDigest: digest('6')
        }
    ]
};
const spawnSeal = createReleaseFinalSpawnSeal(spawnSealAuthority);

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
                shellToken: `fsusblog.release-finalizer-spawn-decision.v1|${sealState}|0`,
                failureReasons: [`release-final seal state is ${sealState}`]
            });
        });
    }
});

test('accepted seal exposes one spawn only while the static boundary remains valid', () =>
{
    const accepted = buildReleaseFinalizerSpawnDecision({
        sealState: 'accepted',
        authorityDigest: spawnSeal.contentDigest
    });
    assert.equal(accepted.eligible, true);
    assert.equal(accepted.spawnCount, 1);

    const rejected = buildReleaseFinalizerSpawnDecision({
        sealState: 'accepted',
        authorityDigest: spawnSeal.contentDigest,
        boundaryErrors: ['release-final contains a forbidden capability']
    });
    assert.equal(rejected.eligible, false);
    assert.equal(rejected.spawnCount, 0);
});

test('scheduler environment applies the reusable decision before the production shell path', () =>
{
    assert.match(
        schedulerSource,
        /tierEnvironment = applyReleaseFinalizerSpawnDecision\(tier, tierEnvironment,[\s\S]*?repositoryRoot: root,[\s\S]*?requireEligible: true/u
    );
    const fixture = path.join(root, 'tools/test/lanes/release-final.sh');
    const accepted = applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: fixture,
        FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION: 'caller-forged-token'
    }, {
        spawnSeal,
        spawnSealAuthority
    });
    assert.equal(
        accepted.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION,
        buildReleaseFinalizerSpawnDecision({
            sealState: 'accepted', authorityDigest: spawnSeal.contentDigest
        }).shellToken
    );

    const missing = applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
        FSUSBLOG_RELEASE_FINAL_SEAL_STATE: 'accepted',
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: `${fixture}.missing`,
        FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION: 'caller-forged-token'
    });
    assert.equal(missing.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION,
        'fsusblog.release-finalizer-spawn-decision.v1|missing|0');
    assert.throws(
        () => applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
            FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: `${fixture}.missing`,
            FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
            FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture
        }, { requireEligible: true }),
        /release-final spawn rejected before child creation/u
    );

    const nonaccepted = applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
        FSUSBLOG_RELEASE_FINAL_SEAL_STATE: 'accepted',
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: fixture,
        FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION:
            'fsusblog.release-finalizer-spawn-decision.v1|accepted|1'
    });
    assert.equal(
        nonaccepted.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION,
        'fsusblog.release-finalizer-spawn-decision.v1|missing|0'
    );
    assert.equal(nonaccepted.FSUSBLOG_RELEASE_FINAL_SEAL_STATE, undefined);

    const replayed = applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: fixture,
        FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture
    }, {
        spawnSeal,
        spawnSealAuthority: { ...spawnSealAuthority, schedulerNonce: '9'.repeat(64) }
    });
    assert.equal(
        replayed.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION,
        'fsusblog.release-finalizer-spawn-decision.v1|failed|0'
    );
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

test('declarative execution grammar rejects aliases and unsupported execution forms', async (context) =>
{
    const commandAliases = [
        './tools/test/lanes/release-final.sh',
        'tools/test/lanes/./release-final.sh',
        'bash tools/test/lanes/release-final.sh',
        "bash -c 'exec ./tools/test/lanes/release-final.sh'",
        'sh ./tools/test/lanes/release-final.sh',
        'env bash ./tools/test/lanes/release-final.sh',
        "bash -c '$PWD/tools/test/lanes/release-final.sh'",
        'true; ./tools/test/lanes/release-final.sh',
        '"tools/test/lanes/release-final.sh"',
        "bash   -c   ' exec   \"$PWD\"/tools/test/lanes/./release-final.sh '",
        'env   sh   "./tools/test/lanes/release-final.sh"',
        'true &&\n  "$PWD"/tools/test/lanes/release-final.sh',
        'finalizer=./tools/test/lanes/release-final.sh; exec "$finalizer"',
        'p=./tools/test/lanes/release-; exec "${p}final.sh"',
        'p=./tools/test/lanes/release-; s=final.sh; exec "$p$s"',
        './tools/test/lanes/release-final.s?',
        "bash -c 'p=./tools/test/lanes/release-; exec \"${p}final.sh\"'",
        'exec ./tools/test/lanes/release-$(printf final).sh',
        'exec ./tools/test/lanes/release-{final,preview}.sh',
        'exec "./tools/test/lanes/release-${x:-final}.sh"',
        'exec "$late"; late=./tools/test/lanes/release-final.sh',
        'cd tools/test/lanes && ./release-final.sh',
        "python -c 'import os; os.system(\"./tools/test/lanes/release-final.sh\")'",
        "bash -c './tools/test/lanes/release-final.s\"\"h'",
        "bash -c './tools/test/lanes/release-final.s\\h'",
        'printf tools/test/lanes/release-final.sh | bash',
        'run_finalizer() { tools/test/lanes/release-final.sh; }; run_finalizer',
        'command_argv=(tools/test/lanes/release-final.sh); "${command_argv[@]}"',
        'eval tools/test/lanes/release-final.sh',
        'source tools/test/lanes/release-final.sh',
        '. tools/test/lanes/release-final.sh',
        'time tools/test/lanes/release-final.sh',
        "find tools/test/lanes -name release-final.sh -exec tools/test/lanes/release-final.sh ';'",
        'printf tools/test/lanes/release-final.sh | xargs bash',
        'if test -f tools/test/lanes/release-final.sh; then tools/test/lanes/release-final.sh; fi',
        '"$dynamicExecutable" tools/test/lanes/release-final.sh',
        'node "$dynamicEntrypoint" tools/test/lanes/release-final.sh',
        'bash "$dynamicScript" tools/test/lanes/release-final.sh',
        'tools/test/lanes/_suite-support.sh',
        'echo data\ntools/test/lanes/release-final.sh',
        'printf data\r\ntools/test/lanes/release-final.sh',
        'test -f tools/test/lanes/release-final.sh\ntools/test/lanes/release-final.sh',
        'env true\ntools/test/lanes/release-final.sh',
        'bash tools/test/lanes/release-preview.sh\ntools/test/lanes/release-final.sh',
        'echo data\u2028tools/test/lanes/release-final.sh'
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
            assert.match(errors.join('\n'), new RegExp(aliasTier.id, 'u'));
            assert.equal(
                buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
                0
            );
        });
    }
});

test('unsupported execution forms fail declaration validation without a finalizer path', async (context) =>
{
    const unsupportedCommands = [
        'printf tools/test/lanes/release-preview.sh | bash',
        'run_preview() { tools/test/lanes/release-preview.sh; }; run_preview',
        'command_argv=(tools/test/lanes/release-preview.sh); "${command_argv[@]}"',
        'eval tools/test/lanes/release-preview.sh',
        'source tools/test/lanes/release-preview.sh',
        '. tools/test/lanes/release-preview.sh',
        'time tools/test/lanes/release-preview.sh',
        "find tools/test/lanes -name release-preview.sh -exec tools/test/lanes/release-preview.sh ';'",
        'printf tools/test/lanes/release-preview.sh | xargs bash',
        '"$dynamicExecutable" tools/test/lanes/release-preview.sh'
    ];
    for (const [index, command] of unsupportedCommands.entries())
    {
        await context.test(command, () =>
        {
            const mutated = structuredClone(matrix);
            const tierId = `unsupported-execution-shape-${index + 1}`;
            mutated.tiers.push({
                id: tierId,
                executionMode: 'execute',
                commandKind: 'producer',
                command
            });
            const errors = validateReleaseFinalStaticBoundary({ matrix: mutated, scriptSource });
            assert.match(errors.join('\n'), new RegExp(`execution declaration ${tierId}`, 'u'));
            assert.equal(
                buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
                0
            );
        });
    }
});

test('raw line separators block real Bash follow-on finalizer execution before spawn', async (context) =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-newline-'));
    const laneDirectory = path.join(fixtureRoot, 'tools/test/lanes');
    const marker = path.join(fixtureRoot, 'spawn.log');
    mkdirSync(laneDirectory, { recursive: true });
    writeFileSync(
        path.join(laneDirectory, 'release-final.sh'),
        '#!/usr/bin/env bash\nprintf "child\\n" >> "$SPAWN_MARKER"\n'
    );
    writeFileSync(path.join(laneDirectory, 'release-preview.sh'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(path.join(laneDirectory, 'release-final.sh'), 0o755);
    chmodSync(path.join(laneDirectory, 'release-preview.sh'), 0o755);
    const commands = [
        'echo data\ntools/test/lanes/release-final.sh',
        'printf data\r\ntools/test/lanes/release-final.sh',
        'test -f tools/test/lanes/release-final.sh\ntools/test/lanes/release-final.sh',
        'env true\ntools/test/lanes/release-final.sh',
        'bash tools/test/lanes/release-preview.sh\ntools/test/lanes/release-final.sh',
        'echo data # comment\ntools/test/lanes/release-final.sh'
    ];
    try
    {
        for (const [index, command] of commands.entries())
        {
            await context.test(`separator mutation ${index + 1}`, () =>
            {
                writeFileSync(marker, '');
                const mutated = structuredClone(matrix);
                mutated.tiers.push({
                    id: `raw-line-separator-${index + 1}`,
                    executionMode: 'execute',
                    commandKind: 'producer',
                    command
                });
                const errors = validateReleaseFinalStaticBoundary({ matrix: mutated, scriptSource });
                assert.match(errors.join('\n'), /line separators are outside the single-command argv grammar/u);
                assert.equal(
                    buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
                    0
                );

                const bash = spawnSync('bash', ['-c', command], {
                    cwd: fixtureRoot,
                    encoding: 'utf8',
                    env: { ...process.env, SPAWN_MARKER: marker }
                });
                assert.equal(bash.status, 0, bash.stderr);
                assert.equal(readFileSync(marker, 'utf8'), 'child\n');
            });
        }
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('production scheduler admission rejects a newline command before executeTier child spawn', async () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-scheduler-admission-'));
    let childSpawns = 0;
    try
    {
        mkdirSync(path.join(fixtureRoot, 'tests/fixtures/test-matrix'), { recursive: true });
        mkdirSync(path.join(fixtureRoot, 'tools/test/lanes'), { recursive: true });
        const mutatedMatrixSource = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8').replace(
            '      command: node tools/run-test-matrix.mjs aggregate ci-summary',
            '      command: "echo data\\ntools/test/lanes/release-final.sh"'
        );
        writeFileSync(path.join(fixtureRoot, 'tests/matrix.yml'), mutatedMatrixSource);
        copyFileSync(
            path.join(root, 'tools/test/lanes/release-final.sh'),
            path.join(fixtureRoot, 'tools/test/lanes/release-final.sh')
        );
        copyFileSync(
            path.join(root, 'tests/fixtures/test-matrix/release-final-execution-target-authority.json'),
            path.join(fixtureRoot, 'tests/fixtures/test-matrix/release-final-execution-target-authority.json')
        );
        await assert.rejects(
            () => runDag({
                root: fixtureRoot,
                runsRoot: path.join(fixtureRoot, 'runs'),
                runId: 'newline-admission',
                targetTierId: 'ci',
                tiers: [{ id: 'ci', command: 'echo data\ntools/test/lanes/release-final.sh' }],
                maxParallel: 1,
                snapshotWorktree: async () => ({ fingerprint: 'fixture-fingerprint' }),
                sourceState: { commit: 'fixture-commit', worktreeFingerprint: 'fixture-fingerprint' },
                executeTier: async () =>
                {
                    childSpawns += 1;
                    return { status: 'success', durationMs: 1 };
                }
            }),
            /production release-final static boundary rejected scheduler dispatch[\s\S]*line separators/u
        );
        assert.equal(childSpawns, 0);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('target inspection rejects file and parent symlinks plus indirect ordinary wrappers', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-target-'));
    const laneDirectory = path.join(fixtureRoot, 'tools/test/lanes');
    mkdirSync(laneDirectory, { recursive: true });
    writeFileSync(path.join(laneDirectory, 'release-final.sh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(path.join(laneDirectory, 'release-preview.sh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(
        path.join(laneDirectory, 'ordinary-wrapper.sh'),
        '#!/usr/bin/env bash\ntools/test/lanes/nested-wrapper.sh\n'
    );
    writeFileSync(
        path.join(laneDirectory, 'nested-wrapper.sh'),
        '#!/usr/bin/env bash\ntools/test/lanes/release-final.sh\n'
    );
    symlinkSync('release-preview.sh', path.join(laneDirectory, 'file-alias.sh'));
    symlinkSync('test', path.join(fixtureRoot, 'tools/linked'));
    try
    {
        const fileAlias = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/test/lanes/file-alias.sh'
        });
        assert.match(fileAlias.errors.join('\n'), /file-alias\.sh.*is a symlink/u);

        const parentAlias = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/linked/lanes/release-preview.sh'
        });
        assert.match(parentAlias.errors.join('\n'), /tools\/linked.*is a symlink/u);

        const ordinaryWrapper = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/test/lanes/ordinary-wrapper.sh'
        });
        assert.match(
            ordinaryWrapper.errors.join('\n'),
            /nested-wrapper\.sh contains an indirect release-final wrapper reference/u
        );
        assert.deepEqual(
            ordinaryWrapper.dependencyClosure.map((entry) => entry.path),
            ['tools/test/lanes/nested-wrapper.sh', 'tools/test/lanes/release-final.sh']
        );
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('target inspection rejects hardlinks and working-tree bytes that differ from the Git index', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-index-'));
    const target = 'tools/entry.sh';
    try
    {
        mkdirSync(path.join(fixtureRoot, 'tools'), { recursive: true });
        writeFileSync(path.join(fixtureRoot, target), '#!/usr/bin/env bash\nexit 0\n');
        linkSync(path.join(fixtureRoot, target), path.join(fixtureRoot, 'tools/entry-hardlink.sh'));
        const hardlink = inspectReleaseFinalCommandTarget({ repositoryRoot: fixtureRoot, target });
        assert.match(hardlink.errors.join('\n'), /must have exactly one hard link/u);

        rmSync(path.join(fixtureRoot, 'tools/entry-hardlink.sh'));
        for (const args of [
            ['init'],
            ['config', 'user.email', 'release-final@example.invalid'],
            ['config', 'user.name', 'Release Final Test'],
            ['add', target]
        ])
        {
            const result = spawnSync('git', ['-C', fixtureRoot, ...args], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
        writeFileSync(path.join(fixtureRoot, target), '#!/usr/bin/env bash\nexit 7\n');
        const indexDrift = inspectReleaseFinalCommandTarget({ repositoryRoot: fixtureRoot, target });
        assert.match(indexDrift.errors.join('\n'), /working-tree bytes differ from the repository index/u);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('shell execution closure distinguishes code-bearing argv from data and fails closed on dynamic source', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-shell-ast-'));
    try
    {
        mkdirSync(path.join(fixtureRoot, 'tools'), { recursive: true });
        writeFileSync(path.join(fixtureRoot, 'tools/source.sh'), '#!/usr/bin/env bash\ntrue\n');
        writeFileSync(path.join(fixtureRoot, 'tools/entry.mjs'), 'export const value = 1;\n');
        writeFileSync(path.join(fixtureRoot, 'tools/data.mjs'), 'export const data = 1;\n');
        writeFileSync(
            path.join(fixtureRoot, 'tools/main.sh'),
            '#!/usr/bin/env bash\n'
                + 'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'
                + 'source "$ROOT_DIR/tools/source.sh"\n'
                + 'node "$ROOT_DIR/tools/entry.mjs"\n'
                + 'printf "%s\\n" tools/data.mjs\n'
        );
        const inspected = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.sh'
        });
        assert.deepEqual(inspected.errors, []);
        assert.deepEqual(
            inspected.dependencyClosure.map(({ path: dependency }) => dependency),
            ['tools/entry.mjs', 'tools/source.sh']
        );

        writeFileSync(path.join(fixtureRoot, 'tools/main.sh'), '#!/usr/bin/env bash\nsource "$UNKNOWN"\n');
        const dynamicSource = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.sh'
        });
        assert.match(dynamicSource.errors.join('\n'), /unresolved source dependency/u);

        const authorizedSource = readFileSync(path.join(fixtureRoot, 'tools/main.sh'), 'utf8');
        mkdirSync(path.join(fixtureRoot, 'config/testing'), { recursive: true });
        writeFileSync(
            path.join(fixtureRoot, 'config/testing/release-final-execution-authority-index.json'),
            `${JSON.stringify({
                runtimeDynamicShellSources: [{
                    owner: 'tools/main.sh',
                    sourceDigest: digestText(authorizedSource),
                    expressionDigest: digestText('"$UNKNOWN"'),
                    kind: 'runtime-shell-source',
                    dependencies: []
                }]
            }, null, 4)}\n`
        );
        const explicitlyAuthorized = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.sh'
        });
        assert.deepEqual(explicitlyAuthorized.errors, []);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('format parser runtime require admits only the exact reviewed owner and sealed parser inputs', async (t) =>
{
    const owner = 'tools/governance/javascript-format-equivalence.mjs';
    const indexPath = 'config/testing/release-final-execution-authority-index.json';
    const parserInputs = [
        'tools/governance/javascript-format-parser/package.json',
        'tools/governance/javascript-format-parser/package-lock.json'
    ];
    const source = readFileSync(path.join(root, owner), 'utf8');
    const index = JSON.parse(readFileSync(path.join(root, indexPath), 'utf8'));
    const bindings = index.runtimeDynamicImports.filter((entry) => entry.owner === owner);
    assert.equal(bindings.length, 1);
    assert.deepEqual(bindings[0], {
        owner,
        sourceDigest: digestText(source),
        expressionDigest: digestText('requireParser(entry)'),
        kind: 'runtime-require-path',
        dependencies: parserInputs
    });

    for (const variant of [
        'exact', 'absent', 'wrong-owner', 'wrong-source', 'wrong-expression', 'wrong-kind',
        'foreign-owner', 'source-drift', 'unknown-load', 'symlink-owner', 'symlink-parser-input',
        'missing-parser-input'
    ])
    {
        await t.test(variant, (context) =>
        {
            const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-format-parser-'));
            context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
            const fixtureIndex = structuredClone(index);
            const binding = fixtureIndex.runtimeDynamicImports.find((entry) => entry.owner === owner);
            let target = owner;
            let fixtureSource = source;
            if (variant === 'absent')
            {
                fixtureIndex.runtimeDynamicImports = fixtureIndex.runtimeDynamicImports.filter((entry) => entry.owner !== owner);
            }
            else if (variant === 'wrong-owner')
            {
                binding.owner = 'tools/governance/foreign-format-equivalence.mjs';
            }
            else if (variant === 'wrong-source')
            {
                binding.sourceDigest = digest('0');
            }
            else if (variant === 'wrong-expression')
            {
                binding.expressionDigest = digest('0');
            }
            else if (variant === 'wrong-kind')
            {
                binding.kind = 'runtime-module-path';
            }
            else if (variant === 'foreign-owner')
            {
                target = 'tools/governance/foreign-format-equivalence.mjs';
            }
            else if (variant === 'source-drift')
            {
                fixtureSource += '\n// changed parser authority source\n';
            }
            else if (variant === 'unknown-load')
            {
                fixtureSource += '\nrequireParser(unknownParserEntry);\n';
                binding.sourceDigest = digestText(fixtureSource);
            }
            for (const input of parserInputs)
            {
                if (variant === 'missing-parser-input' && input === parserInputs[1])
                {
                    continue;
                }
                const destination = path.join(fixtureRoot, input);
                mkdirSync(path.dirname(destination), { recursive: true });
                if (variant === 'symlink-parser-input' && input === parserInputs[0])
                {
                    symlinkSync(path.join(root, input), destination);
                }
                else
                {
                    copyFileSync(path.join(root, input), destination);
                }
            }
            const fixtureOwner = path.join(fixtureRoot, target);
            mkdirSync(path.dirname(fixtureOwner), { recursive: true });
            if (variant === 'symlink-owner')
            {
                symlinkSync(path.join(root, owner), fixtureOwner);
            }
            else
            {
                writeFileSync(fixtureOwner, fixtureSource);
            }
            const fixtureIndexPath = path.join(fixtureRoot, indexPath);
            mkdirSync(path.dirname(fixtureIndexPath), { recursive: true });
            writeFileSync(fixtureIndexPath, `${JSON.stringify(fixtureIndex, null, 4)}\n`);
            const inspection = inspectReleaseFinalCommandTarget({
                repositoryRoot: fixtureRoot,
                target,
                additionalTargets: [indexPath]
            });
            if (variant === 'exact')
            {
                assert.deepEqual(inspection.errors, []);
                assert.deepEqual(inspection.dependencyClosure.map((entry) => entry.path),
                    [indexPath, ...parserInputs].sort());
                for (const input of [indexPath, ...parserInputs])
                {
                    const dependency = inspection.dependencyClosure.find((entry) => entry.path === input);
                    assert.equal(dependency.contentDigest, digestText(readFileSync(path.join(fixtureRoot, input))));
                }
            }
            else
            {
                assert.ok(inspection.errors.length > 0, `${variant} must not admit the parser load`);
                assert.match(inspection.errors.join('\n'),
                    /unresolved dynamic require|symlink|symbolic|not a regular|unresolved|canonical/u);
            }
        });
    }
});

test('Node closure resolves immutable aliases, package imports, and conditional self exports', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-node-resolution-'));
    try
    {
        mkdirSync(path.join(fixtureRoot, 'tools'), { recursive: true });
        writeFileSync(path.join(fixtureRoot, 'tools/dep.cjs'), 'module.exports = {};\n');
        writeFileSync(path.join(fixtureRoot, 'tools/self-import.mjs'), 'export const value = 1;\n');
        writeFileSync(path.join(fixtureRoot, 'tools/self-require.cjs'), 'module.exports = {};\n');
        writeFileSync(
            path.join(fixtureRoot, 'tools/package.json'),
            `${JSON.stringify({
                name: 'fixture-package',
                imports: { '#dep': { node: { require: './dep.cjs' }, default: './missing.cjs' } },
                exports: {
                    './self': { node: { import: './self-import.mjs', require: './self-require.cjs' } }
                }
            }, null, 4)}\n`
        );
        writeFileSync(
            path.join(fixtureRoot, 'tools/main.cjs'),
            "const load = require; const leaf = '#dep'; load(`${leaf}`); import('fixture-package/self');\n"
        );
        const inspected = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.cjs'
        });
        assert.deepEqual(inspected.errors, []);
        assert.deepEqual(
            inspected.dependencyClosure.map(({ path: dependency }) => dependency),
            ['tools/dep.cjs', 'tools/package.json', 'tools/self-import.mjs']
        );

        writeFileSync(
            path.join(fixtureRoot, 'tools/main.cjs'),
            "let target = './dep.cjs'; target = './hidden.cjs'; import(target);\n"
        );
        const reassigned = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.cjs'
        });
        assert.match(reassigned.errors.join('\n'), /unresolved dynamic import/u);

        writeFileSync(
            path.join(fixtureRoot, 'tools/main.cjs'),
            "const require = () => null; require('./dep.cjs');\n"
        );
        const shadowedRequire = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.cjs'
        });
        assert.match(shadowedRequire.errors.join('\n'), /shadows require/u);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('sealed Node parser transforms TypeScript and rejects TSX without an unbound parser', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-typescript-'));
    try
    {
        mkdirSync(path.join(fixtureRoot, 'tools'), { recursive: true });
        writeFileSync(path.join(fixtureRoot, 'tools/dep.mjs'), 'export const value = 1;\n');
        writeFileSync(
            path.join(fixtureRoot, 'tools/main.ts'),
            "enum Mode { Active }\nconst target: string = './dep.mjs';\nimport(target);\n"
        );
        const typescript = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.ts'
        });
        assert.deepEqual(typescript.errors, []);
        assert.deepEqual(
            typescript.dependencyClosure.map(({ path: dependency }) => dependency),
            ['tools/dep.mjs']
        );

        writeFileSync(path.join(fixtureRoot, 'tools/main.tsx'), 'export const view = <div />;\n');
        const tsx = inspectReleaseFinalCommandTarget({
            repositoryRoot: fixtureRoot,
            target: 'tools/main.tsx'
        });
        assert.match(tsx.errors.join('\n'), /TSX is outside the sealed Node parser grammar/u);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('only explicit non-executing argv data and noncanonical basenames remain admitted', async (context) =>
{
    const commands = [
        'printf "%s\\n" ./tools/test/lanes/release-final.sh',
        'echo ./tools/test/lanes/release-final.sh',
        'test -f ./tools/test/lanes/release-final.sh',
        'printf "%s\\n" release-final.sh',
        'echo release-final.sh',
        'test -f release-final.sh'
    ];
    for (const [index, command] of commands.entries())
    {
        await context.test(command, () =>
        {
            const mutated = structuredClone(matrix);
            mutated.tiers.push({
                id: `unrelated-shell-shape-${index + 1}`,
                executionMode: 'execute',
                commandKind: 'producer',
                command
            });
            assert.deepEqual(validateReleaseFinalStaticBoundary({ matrix: mutated, scriptSource }), []);
        });
    }
});

test('exact command argv authority rejects same-target subcommand and executable-path argument drift', async (context) =>
{
    const mutations = [
        ['matrix subcommand', 'ci', 'node tools/run-test-matrix.mjs ci-release-final'],
        [
            'release reliability executable arguments',
            'release-reliability-fresh',
            'tools/test/run-release-reliability-qualified-local.sh '
                + '--test-workflow /tmp/runner /tmp/verifier /tmp/receipt /tmp/resource'
        ]
    ];
    for (const [name, tierId, command] of mutations)
    {
        await context.test(name, () =>
        {
            const mutated = structuredClone(matrix);
            mutated.tiers.find((tier) => tier.id === tierId).command = command;
            const errors = validateReleaseFinalStaticBoundary({ matrix: mutated, scriptSource });
            assert.match(
                errors.join('\n'),
                /exact command argv, command kind, or execution mode drifted|authority owner, content, or dependency closure drifted/u
            );
            assert.equal(
                buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
                0
            );
        });
    }
});

test('removing the required seal control-flow cannot be re-admitted by unchanged allowed lines', () =>
{
    const withoutSeal = scriptSource.replace(
        /case "\$releaseFinalDecision" in[\s\S]*?^esac\n/mu,
        ''
    );
    assert.notEqual(withoutSeal, scriptSource);
    const errors = validateReleaseFinalStaticBoundary({ matrix, scriptSource: withoutSeal });
    assert.match(errors.join('\n'), /exact required control-flow owner digest drifted/u);
    assert.equal(
        buildReleaseFinalizerSpawnDecision({ sealState: 'accepted', boundaryErrors: errors }).spawnCount,
        0
    );
});

test('Node AST closure binds actual build.mjs dynamic import(new URL(...)) dependencies', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'release-final-node-ast-'));
    const buildPath = 'tools/frontend/build.mjs';
    const fsusuiRootPath = 'src/frontend/scripts/fsusui-root.mjs';
    try
    {
        const actualClosure = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: buildPath });
        assert.deepEqual(actualClosure.errors, []);
        for (const dependency of [buildPath, ...actualClosure.dependencyClosure.map(({ path: file }) => file)])
        {
            mkdirSync(path.dirname(path.join(fixtureRoot, dependency)), { recursive: true });
            copyFileSync(path.join(root, dependency), path.join(fixtureRoot, dependency));
        }
        const before = inspectReleaseFinalCommandTarget({ repositoryRoot: fixtureRoot, target: buildPath });
        assert.deepEqual(before.errors, []);
        const beforeDependency = before.dependencyClosure.find(({ path: dependency }) => (
            dependency === fsusuiRootPath
        ));
        assert.ok(beforeDependency, 'actual build.mjs dynamic import dependency must enter closure');

        writeFileSync(
            path.join(fixtureRoot, fsusuiRootPath),
            `${readFileSync(path.join(fixtureRoot, fsusuiRootPath), 'utf8')}\n// authority mutation\n`
        );
        const after = inspectReleaseFinalCommandTarget({ repositoryRoot: fixtureRoot, target: buildPath });
        const afterDependency = after.dependencyClosure.find(({ path: dependency }) => (
            dependency === fsusuiRootPath
        ));
        assert.notEqual(afterDependency.contentDigest, beforeDependency.contentDigest);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
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
