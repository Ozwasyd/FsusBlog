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

function parseShellTokens(command)
{
    if (typeof command !== 'string' || command.trim().length === 0)
    {
        return [];
    }
    const tokens = [];
    let token = '';
    let quote = null;
    let escaped = false;
    const flushToken = () =>
    {
        if (token.length > 0)
        {
            tokens.push({ type: 'word', value: token });
            token = '';
        }
    };
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
        if (character === '\n')
        {
            flushToken();
            tokens.push({ type: 'operator', value: character });
            continue;
        }
        if (/\s/u.test(character))
        {
            flushToken();
            continue;
        }
        if (character === ';' || character === '|' || character === '&')
        {
            flushToken();
            const previous = tokens.at(-1);
            if (previous?.type === 'operator' && previous.value === character && character !== ';')
            {
                previous.value += character;
            }
            else
            {
                tokens.push({ type: 'operator', value: character });
            }
            continue;
        }
        token += character;
    }
    if (escaped || quote)
    {
        return [];
    }
    flushToken();
    return tokens;
}

function isReleaseFinalizerPath(value)
{
    if (typeof value !== 'string')
    {
        return false;
    }
    let candidate = value.replaceAll('\\', '/');
    candidate = candidate.replace(/^\$\{PWD\}\//u, '');
    candidate = candidate.replace(/^\$PWD\//u, '');
    candidate = candidate.replace(/^\$\(pwd\)\//u, '');
    if (path.posix.isAbsolute(candidate))
    {
        candidate = path.relative(root, candidate).replaceAll('\\', '/');
    }
    return path.posix.normalize(candidate) === releaseFinalizerCommand;
}

function containsReleaseFinalizerScriptReference(value)
{
    if (typeof value !== 'string')
    {
        return false;
    }
    return /(?:^|[^A-Za-z0-9_.-])release-final\.sh(?:$|[^A-Za-z0-9_.-])/u.test(
        value.replace(/[\\'"]/gu, '')
    );
}

function expandKnownShellVariables(value, variables, depth = 0)
{
    if (depth > 8 || typeof value !== 'string')
    {
        return value;
    }
    let changed = false;
    const expanded = value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
        (reference, bracedName, plainName) =>
        {
            const name = bracedName ?? plainName;
            if (!variables.has(name))
            {
                return reference;
            }
            changed = true;
            return variables.get(name);
        }
    );
    return changed ? expandKnownShellVariables(expanded, variables, depth + 1) : expanded;
}

function releaseFinalizerGlobMatch(value)
{
    if (typeof value !== 'string' || !/[?*[]/u.test(value))
    {
        return false;
    }
    let pattern = value.replaceAll('\\', '/');
    pattern = pattern.replace(/^\$\{PWD\}\//u, '');
    pattern = pattern.replace(/^\$PWD\//u, '');
    pattern = pattern.replace(/^\$\(pwd\)\//u, '');
    if (path.posix.isAbsolute(pattern))
    {
        pattern = path.relative(root, pattern).replaceAll('\\', '/');
    }
    pattern = path.posix.normalize(pattern);
    let source = '';
    for (let index = 0; index < pattern.length; index += 1)
    {
        const character = pattern[index];
        if (character === '*')
        {
            source += '[^/]*';
        }
        else if (character === '?')
        {
            source += '[^/]';
        }
        else if (character === '[')
        {
            const close = pattern.indexOf(']', index + 1);
            if (close < 0)
            {
                return false;
            }
            const range = pattern.slice(index + 1, close);
            if (!/^[!^A-Za-z0-9._-]+$/u.test(range))
            {
                return false;
            }
            source += `[${range.startsWith('!') ? `^${range.slice(1)}` : range}]`;
            index = close;
        }
        else
        {
            source += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
        }
    }
    const matcher = new RegExp(`^${source}$`, 'u');
    return matcher.test(releaseFinalizerCommand)
        || matcher.test(path.posix.basename(releaseFinalizerCommand));
}

function commandInvokesReleaseFinalizer(command, depth = 0)
{
    if (depth > 8)
    {
        return false;
    }
    if (containsReleaseFinalizerScriptReference(command))
    {
        return true;
    }
    const tokens = parseShellTokens(command);
    const variables = new Map();
    for (const token of tokens)
    {
        if (token.type !== 'word')
        {
            continue;
        }
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(token.value);
        if (assignment && !/[\s;&|]/u.test(token.value))
        {
            variables.set(assignment[1], expandKnownShellVariables(assignment[2], variables));
        }
    }
    const words = tokens
        .filter((token) => token.type === 'word')
        .map((token) => expandKnownShellVariables(token.value, variables));
    return words.some((word) => (
        isReleaseFinalizerPath(word)
        || releaseFinalizerGlobMatch(word)
        || containsReleaseFinalizerScriptReference(word)
        || /[\s;&|]/u.test(word) && commandInvokesReleaseFinalizer(word, depth + 1)
    ));
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
