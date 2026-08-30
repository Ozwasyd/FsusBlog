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
    /^releaseFinalArgs=\(\)$/u,
    /^if \[\[ -n "\$\{FSUSBLOG_LOCAL_PROFILE_CHECKPOINT:-\}" \]\]; then$/u,
    /^releaseFinalArgs\+=\(--local-profile-checkpoint "\$FSUSBLOG_LOCAL_PROFILE_CHECKPOINT"\)$/u,
    /^fi$/u,
    /^if \[\[ -z "\$\{FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT:-\}" \\$/u,
    /^\|\| -z "\$\{FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH:-\}" \\$/u,
    /^\|\| -z "\$\{FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH:-\}" \]\]; then$/u,
    /^echo "release-final requires explicit current-run context, manifest binding, and domain binding" >&2$/u,
    /^exit 1$/u,
    /^releaseFinalArgs\+=\(--current-run-context "\$FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT"\)$/u,
    /^releaseFinalArgs\+=\(--manifest-binding "\$FSUSBLOG_RELEASE_CHECK_RELEASE_FINAL_EVIDENCE_PATH"\)$/u,
    /^releaseFinalArgs\+=\(--domain-binding "\$FSUSBLOG_RELEASE_RELEASE_FINAL_DOMAIN_EVIDENCE_EVIDENCE_PATH"\)$/u,
    /^"\$NODE_BIN" "\$ROOT_DIR\/tools\/release\/check-release-final\.mjs" "\$\{releaseFinalArgs\[@\]\}"$/u
];

const forbiddenFinalizerCapability =
    /(?:create-correctness|publish-release-final-evidence-parent|run-matrix-governance-once|check-job-summaries|check-flaky-|repository-governance-authority|check-release-evidence-manifest|(?:^|[\s/_.-])(?:producer|repair|parser|mutation|governance)(?:[\s/_.-]|$))/u;

function parseCommandArgv(command)
{
    if (typeof command !== 'string' || command.trim().length === 0)
    {
        return [];
    }
    const argv = [];
    let token = '';
    let quote = null;
    let escaped = false;
    for (const character of command.trim())
    {
        if (escaped)
        {
            token += character;
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
                token += character;
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
            if (token.length > 0)
            {
                argv.push(token);
                token = '';
            }
            continue;
        }
        token += character;
    }
    if (escaped || quote)
    {
        return [];
    }
    if (token.length > 0)
    {
        argv.push(token);
    }
    return argv;
}

function isReleaseFinalizerPath(value)
{
    if (typeof value !== 'string' || path.posix.isAbsolute(value))
    {
        return false;
    }
    return path.posix.normalize(value.replaceAll('\\', '/')) === releaseFinalizerCommand;
}

function commandInvokesReleaseFinalizer(command)
{
    const argv = parseCommandArgv(command);
    if (isReleaseFinalizerPath(argv[0]))
    {
        return true;
    }
    const executable = path.posix.basename(argv[0] ?? '');
    if (executable !== 'bash')
    {
        return false;
    }
    const script = argv.slice(1).find((argument) => !argument.startsWith('-'));
    return isReleaseFinalizerPath(script);
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

    const releaseFinalizerTiers = (matrix?.tiers ?? []).filter((tier) => (
        tier?.id === 'release-final'
        || commandInvokesReleaseFinalizer(tier?.command)
        || tier?.summaryAuthority === 'release-final'
    ));
    if (releaseFinalizerTiers.length !== 1 || releaseFinalizerTiers[0]?.id !== 'release-final')
    {
        const tierIds = releaseFinalizerTiers.map((tier) => tier?.id ?? '<missing-id>').join(', ');
        errors.push(
            'execution graph must expose exactly one release-final tier by id, command, and summary authority; '
            + `got: ${tierIds || 'none'}`
        );
    }

    const releaseFinalizerAuthorities = Object.entries(matrix?.finalizerAuthorities ?? {})
        .filter(([key, authority]) => (
            key === 'release-final'
            || authority?.id === 'release-final'
            || commandInvokesReleaseFinalizer(authority?.command)
            || authority?.summaryTierIds?.includes('release-final')
        ));
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
    return {
        schema: 'fsusblog.release-finalizer-spawn-decision.v1',
        sealState,
        eligible,
        spawnCount: eligible ? 1 : 0,
        failureReasons
    };
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
