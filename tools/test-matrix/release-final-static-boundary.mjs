#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from './parse-matrix.mjs';
import {
    buildReleaseFinalizerPlan,
    releaseFinalizerCommand
} from './release-final-evidence-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseFinalizerFile = path.join(root, releaseFinalizerCommand);
const matrixFile = path.join(root, 'tests/matrix.yml');
const releaseFinalizerDecisionSchema = 'fsusblog.release-finalizer-spawn-decision.v1';

export const releaseFinalSealStates = Object.freeze([
    'accepted',
    'failed',
    'missing',
    'stale'
]);

const allowedReleaseFinalizerLines = [
    /^#!\/usr\/bin\/env bash$/u,
    /^set -euo pipefail$/u,
    /^ROOT_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\.\/\.\.\/\.\." && pwd\)"$/u,
    /^NODE_BIN="\$\{FSUSBLOG_NODE:-node\}"$/u,
    /^releaseFinalDecision="\$\{FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION:-fsusblog\.release-finalizer-spawn-decision\.v1\|missing\|0\}"$/u,
    /^case "\$releaseFinalDecision" in$/u,
    /^fsusblog\.release-finalizer-spawn-decision\.v1\\\|accepted\\\|1\)$/u,
    /^;;$/u,
    /^fsusblog\.release-finalizer-spawn-decision\.v1\\\|failed\\\|0\|fsusblog\.release-finalizer-spawn-decision\.v1\\\|missing\\\|0\|fsusblog\.release-finalizer-spawn-decision\.v1\\\|stale\\\|0\)$/u,
    /^echo "release-final seal rejected: \$releaseFinalDecision" >&2$/u,
    /^\*\)$/u,
    /^echo "release-final seal decision is invalid: \$releaseFinalDecision" >&2$/u,
    /^exit 1$/u,
    /^esac$/u,
    /^releaseFinalEvidencePaths=\($/u,
    /^"\$\{FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT:-\}"$/u,
    /^"\$\{FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH:-\}"$/u,
    /^"\$\{FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH:-\}"$/u,
    /^\)$/u,
    /^for evidencePath in "\$\{releaseFinalEvidencePaths\[@\]\}"; do$/u,
    /^if \[\[ -z "\$evidencePath" \|\| ! -f "\$evidencePath" \|\| ! -s "\$evidencePath" \|\| -L "\$evidencePath" \]\]; then$/u,
    /^echo "release-final requires existing non-empty context and evidence files" >&2$/u,
    /^done$/u,
    /^releaseFinalArgs=\(\)$/u,
    /^if \[\[ -n "\$\{FSUSBLOG_LOCAL_PROFILE_CHECKPOINT:-\}" \]\]; then$/u,
    /^releaseFinalArgs\+=\(--local-profile-checkpoint "\$FSUSBLOG_LOCAL_PROFILE_CHECKPOINT"\)$/u,
    /^fi$/u,
    /^releaseFinalArgs\+=\(--current-run-context "\$FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT"\)$/u,
    /^releaseFinalArgs\+=\(--manifest-binding "\$FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH"\)$/u,
    /^releaseFinalArgs\+=\(--domain-binding "\$FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH"\)$/u,
    /^"\$NODE_BIN" "\$ROOT_DIR\/tools\/release\/check-release-final\.mjs" "\$\{releaseFinalArgs\[@\]\}"$/u
];

const forbiddenFinalizerCapability =
    /(?:create-correctness|publish-release-final-evidence-parent|run-matrix-governance-once|check-job-summaries|check-flaky-|repository-governance-authority|check-release-evidence-manifest|(?:^|[\s/_.-])(?:producer|repair|parser|mutation|governance)(?:[\s/_.-]|$))/u;

const allowedExecutionEnvironmentAssignments = Object.freeze({
    FSUSBLOG_SOAK_MODE: new Set(['short', '72h']),
    FSUSBLOG_SOAK_REQUIRE_IMPORTED_EVIDENCE: new Set(['1'])
});

const allowedNodeExecutionOptions = [
    /^--test$/u,
    /^--permission$/u,
    /^--allow-fs-(?:read|write)=.+$/u
];

function parseDeclarativeArgv(command)
{
    if (typeof command !== 'string' || command.trim().length === 0)
    {
        return { error: 'command must be a non-empty string', argv: [] };
    }
    if (/\$\(|`/u.test(command))
    {
        return { error: 'command substitution is outside the declarative argv grammar', argv: [] };
    }

    const argv = [];
    let word = '';
    let quote = null;
    let escaped = false;
    const flushWord = () =>
    {
        if (word.length > 0)
        {
            argv.push(word);
            word = '';
        }
    };
    for (const character of command)
    {
        if (escaped)
        {
            word += character;
            escaped = false;
            continue;
        }
        if (character === '\\' && quote !== "'")
        {
            escaped = true;
            continue;
        }
        if (quote)
        {
            if (character === quote)
            {
                quote = null;
            }
            else
            {
                word += character;
            }
            continue;
        }
        if (character === "'" || character === '"')
        {
            quote = character;
            continue;
        }
        if (/\s/u.test(character))
        {
            flushWord();
            continue;
        }
        if (';|&<>(){}'.includes(character))
        {
            return {
                error: `shell control syntax ${JSON.stringify(character)} is outside the declarative argv grammar`,
                argv: []
            };
        }
        word += character;
    }
    if (escaped || quote)
    {
        return { error: 'unterminated quote or escape is outside the declarative argv grammar', argv: [] };
    }
    flushWord();
    return argv.length > 0
        ? { error: null, argv }
        : { error: 'command must contain an executable argv', argv: [] };
}

function canonicalRepositoryCommand(value)
{
    if (typeof value !== 'string' || /[$?*\[]/u.test(value))
    {
        return null;
    }
    const normalized = path.posix.normalize(value.replace(/^\.\//u, '').replaceAll('\\', '/'));
    if (normalized === '..' || normalized.startsWith('../') || !normalized.startsWith('tools/'))
    {
        return null;
    }
    return normalized;
}

function canonicalNodeEntrypoint(value)
{
    if (typeof value !== 'string' || /[$?*\[]/u.test(value))
    {
        return null;
    }
    const normalized = path.posix.normalize(value.replace(/^\.\//u, '').replaceAll('\\', '/'));
    if (normalized === '..' || normalized.startsWith('../'))
    {
        return null;
    }
    return normalized.startsWith('tools/') || normalized.startsWith('tests/')
        ? normalized
        : null;
}

function commandReferencesReleaseFinalizer(argv, startIndex)
{
    return argv.slice(startIndex).some((argument) => (
        canonicalRepositoryCommand(argument) === releaseFinalizerCommand
    ));
}

function validateDeclarativeExecution(command)
{
    const parsed = parseDeclarativeArgv(command);
    if (parsed.error)
    {
        return { error: parsed.error, invokesReleaseFinalizer: false };
    }
    let executableIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(parsed.argv[executableIndex] ?? ''))
    {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(parsed.argv[executableIndex]);
        const allowedValues = allowedExecutionEnvironmentAssignments[assignment[1]];
        if (!allowedValues?.has(assignment[2]))
        {
            return {
                error: `environment assignment ${assignment[1]} is outside the declarative argv allowlist`,
                invokesReleaseFinalizer: false
            };
        }
        executableIndex += 1;
    }
    const executable = parsed.argv[executableIndex];
    if (!executable)
    {
        return {
            error: 'assignment-only commands are outside the declarative argv grammar',
            invokesReleaseFinalizer: false
        };
    }
    if (/[$?*\[]/u.test(executable))
    {
        return {
            error: 'dynamic executable argv is outside the declarative argv grammar',
            invokesReleaseFinalizer: false
        };
    }

    if (['printf', 'echo', 'test'].includes(executable))
    {
        return { error: null, invokesReleaseFinalizer: false };
    }
    if (executable === 'bash' || executable === 'sh')
    {
        const script = parsed.argv[executableIndex + 1];
        const repositoryScript = canonicalRepositoryCommand(script);
        if (!repositoryScript || !repositoryScript.endsWith('.sh'))
        {
            return {
                error: `${executable} is allowed only as a fixed wrapper for one repo-relative shell script`,
                invokesReleaseFinalizer: false
            };
        }
        return {
            error: null,
            invokesReleaseFinalizer: repositoryScript === releaseFinalizerCommand
        };
    }
    if (executable === 'node')
    {
        const entrypointIndex = parsed.argv.findIndex((argument, index) => (
            index > executableIndex && !argument.startsWith('-')
        ));
        if (entrypointIndex < 0 || !canonicalNodeEntrypoint(parsed.argv[entrypointIndex]))
        {
            return {
                error: 'node is allowed only with one static repo-relative tools or tests entrypoint',
                invokesReleaseFinalizer: false
            };
        }
        const options = parsed.argv.slice(executableIndex + 1, entrypointIndex);
        if (options.some((option) => (
            !allowedNodeExecutionOptions.some((pattern) => pattern.test(option))
        )))
        {
            return {
                error: 'node option is outside the declarative argv allowlist',
                invokesReleaseFinalizer: false
            };
        }
        return {
            error: null,
            invokesReleaseFinalizer: commandReferencesReleaseFinalizer(parsed.argv, entrypointIndex)
        };
    }

    const repositoryExecutable = canonicalRepositoryCommand(executable);
    if (!repositoryExecutable)
    {
        return {
            error: `executable ${JSON.stringify(executable)} is outside the declarative argv allowlist`,
            invokesReleaseFinalizer: false
        };
    }
    return {
        error: null,
        invokesReleaseFinalizer: repositoryExecutable === releaseFinalizerCommand
            || commandReferencesReleaseFinalizer(parsed.argv, executableIndex + 1)
    };
}

function validateScriptSource(scriptSource)
{
    const errors = [];
    if (typeof scriptSource !== 'string' || scriptSource.length === 0)
    {
        return ['release-final script source must be a non-empty string'];
    }

    const lines = scriptSource.split('\n');
    for (const [index, sourceLine] of lines.entries())
    {
        const line = sourceLine.trim();
        if (line.length === 0 || line.startsWith('#') && index !== 0)
        {
            continue;
        }
        if (!allowedReleaseFinalizerLines.some((pattern) => pattern.test(line)))
        {
            errors.push(`release-final line ${index + 1} is outside the sealed finalizer allowlist: ${line}`);
        }
    }

    const finalizerInvocations = lines.filter((line) => (
        line.trim() === '"$NODE_BIN" "$ROOT_DIR/tools/release/check-release-final.mjs" "${releaseFinalArgs[@]}"'
    ));
    if (finalizerInvocations.length !== 1)
    {
        errors.push(
            `release-final must invoke the canonical finalizer exactly once; got ${finalizerInvocations.length}`
        );
    }
    if (forbiddenFinalizerCapability.test(scriptSource))
    {
        errors.push('release-final contains a forbidden producer, repair, parser, mutation, or governance capability');
    }
    return errors;
}

export function validateReleaseFinalStaticBoundary({ matrix, scriptSource })
{
    const errors = validateScriptSource(scriptSource);
    const plan = buildReleaseFinalizerPlan(matrix);
    errors.push(...plan.errors.map((error) => `execution graph: ${error}`));

    const tierExecutions = (matrix?.tiers ?? []).map((tier) => ({
        tier,
        execution: validateDeclarativeExecution(tier?.command)
    }));
    for (const { tier, execution } of tierExecutions)
    {
        if (execution.error)
        {
            errors.push(
                `execution declaration ${tier?.id ?? '<missing-id>'} is outside the sealed argv grammar: ${execution.error}`
            );
        }
    }

    const releaseFinalizerTiers = tierExecutions.filter(({ tier, execution }) => (
        tier?.id === 'release-final'
        || execution.invokesReleaseFinalizer
        || tier?.summaryAuthority === 'release-final'
    )).map(({ tier }) => tier);
    if (releaseFinalizerTiers.length !== 1 || releaseFinalizerTiers[0]?.id !== 'release-final')
    {
        const tierIds = releaseFinalizerTiers.map((tier) => tier?.id ?? '<missing-id>').join(', ');
        errors.push(
            'execution graph must expose exactly one release-final tier by id, command, and summary authority; '
            + `got: ${tierIds || 'none'}`
        );
    }

    const authorityExecutions = Object.entries(matrix?.finalizerAuthorities ?? {}).map(
        ([key, authority]) => ({
            key,
            authority,
            execution: validateDeclarativeExecution(authority?.command)
        })
    );
    for (const { key, execution } of authorityExecutions)
    {
        if (execution.error)
        {
            errors.push(
                `finalizer authority ${key} is outside the sealed argv grammar: ${execution.error}`
            );
        }
    }
    const releaseFinalizerAuthorities = authorityExecutions
        .filter(({ key, authority, execution }) => (
            key === 'release-final'
            || authority?.id === 'release-final'
            || execution.invokesReleaseFinalizer
            || authority?.summaryTierIds?.includes('release-final')
        ))
        .map(({ key, authority }) => [key, authority]);
    if (
        releaseFinalizerAuthorities.length !== 1
        || releaseFinalizerAuthorities[0]?.[0] !== 'release-final'
        || releaseFinalizerAuthorities[0]?.[1]?.id !== 'release-final'
    )
    {
        const authorityKeys = releaseFinalizerAuthorities.map(([key]) => key).join(', ');
        errors.push(
            'execution graph must expose exactly one release-final finalizer authority by key, id, command, '
            + `and summary tier; got: ${authorityKeys || 'none'}`
        );
    }
    if (plan.executesTestCommands !== false)
    {
        errors.push('execution graph must declare zero test command execution');
    }
    return errors;
}

export function buildReleaseFinalizerSpawnDecision({ sealState, boundaryErrors = [] })
{
    if (!releaseFinalSealStates.includes(sealState))
    {
        throw new Error(`unknown release-final seal state: ${String(sealState)}`);
    }
    if (!Array.isArray(boundaryErrors) || boundaryErrors.some((error) => typeof error !== 'string'))
    {
        throw new Error('release-final boundaryErrors must be an array of strings');
    }
    const failureReasons = [...boundaryErrors];
    if (sealState !== 'accepted')
    {
        failureReasons.unshift(`release-final seal state is ${sealState}`);
    }
    const eligible = sealState === 'accepted' && failureReasons.length === 0;
    const schema = releaseFinalizerDecisionSchema;
    const spawnCount = eligible ? 1 : 0;
    return {
        schema,
        sealState,
        eligible,
        spawnCount,
        shellToken: `${schema}|${sealState}|${spawnCount}`,
        failureReasons
    };
}

export function applyReleaseFinalizerSpawnDecision(
    tier,
    environment,
    { repositoryRoot = root } = {}
)
{
    const sealedEnvironment = { ...environment };
    if (tier?.id !== 'release-final')
    {
        return sealedEnvironment;
    }
    const sealState = String(
        sealedEnvironment.FSUSBLOG_RELEASE_FINAL_SEAL_STATE ?? ''
    ).trim() || 'missing';
    const pathBindings = [
        ['current-run context', sealedEnvironment.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT],
        ['manifest binding', sealedEnvironment.FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH],
        ['domain binding', sealedEnvironment.FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH]
    ];
    const boundaryErrors = [];
    for (const [name, value] of pathBindings)
    {
        const declaredPath = String(value ?? '').trim();
        if (!declaredPath)
        {
            boundaryErrors.push(`${name} path is missing`);
            continue;
        }
        const resolvedPath = path.resolve(repositoryRoot, declaredPath);
        let stat;
        try
        {
            stat = fs.lstatSync(resolvedPath);
        }
        catch
        {
            boundaryErrors.push(`${name} file does not exist`);
            continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
        {
            boundaryErrors.push(`${name} must be a nonempty regular file`);
        }
    }
    const decision = buildReleaseFinalizerSpawnDecision({ sealState, boundaryErrors });
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION = decision.shellToken;
    return sealedEnvironment;
}

function main()
{
    if (process.argv.length !== 2)
    {
        throw new Error('usage: node tools/test-matrix/release-final-static-boundary.mjs');
    }
    const matrix = parseMatrix(fs.readFileSync(matrixFile, 'utf8'));
    const scriptSource = fs.readFileSync(releaseFinalizerFile, 'utf8');
    const errors = validateReleaseFinalStaticBoundary({ matrix, scriptSource });
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    console.log('[release-final-static-boundary] ok: finalizer-only graph and sealed command allowlist');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
