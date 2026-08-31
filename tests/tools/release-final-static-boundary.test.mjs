import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
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
import { validateEvidenceExecutionDeclaration } from '../../tools/test-matrix/projection-declaration.mjs';
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

test('scheduler environment applies the reusable decision before the production shell path', () =>
{
    assert.match(
        schedulerSource,
        /tierEnvironment = applyReleaseFinalizerSpawnDecision\(tier, tierEnvironment,[\s\S]*?repositoryRoot: root/u
    );
    const fixture = path.join(root, 'tools/test/lanes/release-final.sh');
    const accepted = applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
        FSUSBLOG_RELEASE_FINAL_SEAL_STATE: 'accepted',
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: fixture,
        FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION: 'caller-forged-token'
    });
    assert.equal(
        accepted.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION,
        buildReleaseFinalizerSpawnDecision({ sealState: 'accepted' }).shellToken
    );

    const missing = applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
        FSUSBLOG_RELEASE_FINAL_SEAL_STATE: 'accepted',
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: `${fixture}.missing`,
        FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION: 'caller-forged-token'
    });
    assert.equal(
        missing.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION,
        'fsusblog.release-finalizer-spawn-decision.v1|accepted|0'
    );

    const nonaccepted = applyReleaseFinalizerSpawnDecision({ id: 'release-final' }, {
        FSUSBLOG_RELEASE_FINAL_SEAL_STATE: 'stale',
        FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: fixture,
        FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH: fixture,
        FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION:
            'fsusblog.release-finalizer-spawn-decision.v1|accepted|1'
    });
    assert.equal(
        nonaccepted.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION,
        'fsusblog.release-finalizer-spawn-decision.v1|stale|0'
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
