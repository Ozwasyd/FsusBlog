#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Module, { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from './parse-matrix.mjs';
import { sourceGovernanceExecutionTarget, sourceGovernanceExecutableEntries, sourceGovernanceDataInputs } from './pr-impact-plan.mjs';
import {
    buildReleaseFinalizerPlan,
    releaseFinalizerCommand
} from './release-final-evidence-contract.mjs';
import { verifyReleaseFinalSpawnSeal } from './release-final-spawn-seal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseFinalizerFile = path.join(root, releaseFinalizerCommand);
const matrixFile = path.join(root, 'tests/matrix.yml');
const executionAuthorityIndexPath = 'config/testing/release-final-execution-authority-index.json';
const releaseFinalizerDecisionSchema = 'fsusblog.release-finalizer-spawn-decision.v1';
const commandTargetInspectionCache = new Map();
const repositoryIndexFileCache = new Map();
const repositoryGitMetadataCache = new Map();
const builtinAcornSource = process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'];
if (typeof builtinAcornSource !== 'string' || builtinAcornSource.length === 0)
{
    throw new Error('Node builtin Acorn source is unavailable');
}
const builtinAcornModule = new Module(path.join(root, '.release-final-builtin-acorn.cjs'));
builtinAcornModule.filename = path.join(root, '.release-final-builtin-acorn.cjs');
builtinAcornModule.paths = [];
builtinAcornModule._compile(builtinAcornSource, builtinAcornModule.filename);
const builtinAcorn = builtinAcornModule.exports;
const builtinAmaroSource = process.binding('natives')['internal/deps/amaro/dist/index'];
if (typeof builtinAmaroSource !== 'string' || builtinAmaroSource.length === 0)
{
    throw new Error('Node builtin Amaro source is unavailable');
}
const nodeParserIdentity = Object.freeze({
    nodeVersion: process.version,
    acorn: {
        owner: 'node:internal/deps/acorn/acorn/dist/acorn',
        version: builtinAcorn.version,
        sourceDigest: digestBytes(builtinAcornSource)
    },
    amaro: {
        owner: 'node:internal/deps/amaro/dist/index',
        version: process.versions.amaro,
        sourceDigest: digestBytes(builtinAmaroSource)
    }
});

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
    /^if \[\[ -n "\$\{FSUSBLOG_NODE:-\}" \]\]; then$/u,
    /^echo "release-final rejects ambient FSUSBLOG_NODE overrides" >&2$/u,
    /^NODE_BIN="\$\{FSUSBLOG_RELEASE_FINAL_NODE_BIN:-\}"$/u,
    /^NODE_REALPATH="\$\{FSUSBLOG_RELEASE_FINAL_NODE_REALPATH:-\}"$/u,
    /^NODE_SHA256="\$\{FSUSBLOG_RELEASE_FINAL_NODE_SHA256:-\}"$/u,
    /^NODE_VERSION="\$\{FSUSBLOG_RELEASE_FINAL_NODE_VERSION:-\}"$/u,
    /^if \[\[ -z "\$NODE_BIN" \|\| -z "\$NODE_REALPATH" \|\| -z "\$NODE_SHA256" \|\| -z "\$NODE_VERSION" \|\| ! -f "\$NODE_BIN" \|\| ! -x "\$NODE_BIN" \|\| -L "\$NODE_BIN" \]\]; then$/u,
    /^echo "release-final requires sealed Node toolchain identity" >&2$/u,
    /^exec \{NODE_FD\}<"\$NODE_BIN"$/u,
    /^NODE_FD_PATH="\/proc\/\$\$\/fd\/\$NODE_FD"$/u,
    /^if \[\[ ! -e "\$NODE_FD_PATH" \]\]; then$/u,
    /^echo "release-final cannot pin the sealed Node executable" >&2$/u,
    /^mapfile -t actualNodeIdentity < <\($/u,
    /^"\$NODE_FD_PATH" -e '.+' "\$NODE_FD_PATH"$/u,
    /^if \[\[ "\$\{actualNodeIdentity\[0\]:-\}" != "\$NODE_REALPATH" \|\| "\$\{actualNodeIdentity\[1\]:-\}" != "\$NODE_SHA256" \|\| "\$\{actualNodeIdentity\[2\]:-\}" != "\$NODE_VERSION" \]\]; then$/u,
    /^echo "release-final Node toolchain identity drifted" >&2$/u,
    /^releaseFinalSpawnSealDigest="\$\{FSUSBLOG_RELEASE_FINAL_SPAWN_SEAL_DIGEST:-\}"$/u,
    /^releaseFinalDecision="\$\{FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION:-fsusblog\.release-finalizer-spawn-decision\.v1\|missing\|0\}"$/u,
    /^case "\$releaseFinalDecision" in$/u,
    /^fsusblog\.release-finalizer-spawn-decision\.v1\\\|accepted\\\|1\\\|"\$releaseFinalSpawnSealDigest"\)$/u,
    /^;;$/u,
    /^fsusblog\.release-finalizer-spawn-decision\.v1\\\|failed\\\|0\|fsusblog\.release-finalizer-spawn-decision\.v1\\\|missing\\\|0\|fsusblog\.release-finalizer-spawn-decision\.v1\\\|stale\\\|0\)$/u,
    /^echo "release-final seal rejected: \$releaseFinalDecision" >&2$/u,
    /^\*\)$/u,
    /^echo "release-final seal decision is invalid: \$releaseFinalDecision" >&2$/u,
    /^exit 1$/u,
    /^esac$/u,
    /^releaseFinalEvidencePaths=\($/u,
    /^"\$\{FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT:-\}"$/u,
    /^"\$\{FSUSBLOG_RELEASE_FINAL_BINDING_INPUTS_PATH:-\}"$/u,
    /^"\$\{FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH:-\}"$/u,
    /^"\$\{FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_HANDOFF_PATH:-\}"$/u,
    /^"\$\{FSUSBLOG_RELEASE_FINAL_COMMITTED_CHECKPOINT:-\}"$/u,
    /^\)$/u,
    /^for evidencePath in "\$\{releaseFinalEvidencePaths\[@\]\}"; do$/u,
    /^if \[\[ -z "\$evidencePath" \|\| ! -f "\$evidencePath" \|\| ! -s "\$evidencePath" \|\| -L "\$evidencePath" \]\]; then$/u,
    /^echo "release-final requires existing non-empty context and evidence files" >&2$/u,
    /^done$/u,
    /^releaseFinalArgs=\(\)$/u,
    /^fi$/u,
    /^releaseFinalArgs\+=\(--current-run-context "\$FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT"\)$/u,
    /^releaseFinalArgs\+=\(--inputs "\$FSUSBLOG_RELEASE_FINAL_BINDING_INPUTS_PATH"\)$/u,
    /^releaseFinalArgs\+=\(--inputs-digest "\$\{FSUSBLOG_RELEASE_FINAL_BINDING_INPUTS_DIGEST:-\}"\)$/u,
    /^releaseFinalArgs\+=\(--checkpoint "\$FSUSBLOG_RELEASE_FINAL_COMMITTED_CHECKPOINT"\)$/u,
    /^releaseFinalArgs\+=\(--committed-revision "\$\{FSUSBLOG_RELEASE_FINAL_COMMITTED_REVISION:-\}"\)$/u,
    /^releaseFinalArgs\+=\(--reference "\$FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH"\)$/u,
    /^releaseFinalArgs\+=\(--reference-digest "\$\{FSUSBLOG_RELEASE_FINAL_REFERENCE_DIGEST:-\}"\)$/u,
    /^releaseFinalArgs\+=\(--handoff "\$FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_HANDOFF_PATH"\)$/u,
    /^releaseFinalArgs\+=\(--handoff-digest "\$\{FSUSBLOG_RELEASE_FINAL_HANDOFF_DIGEST:-\}"\)$/u,
    /^exec "\$NODE_FD_PATH" "\$ROOT_DIR\/tools\/release\/check-release-final\.mjs" "\$\{releaseFinalArgs\[@\]\}"$/u
];

// This source-owner invariant is intentionally independent of the generated execution-target
// snapshot. Removing or reordering the seal/control-flow cannot be re-admitted by regenerating
// the candidate-owned authority fixture.
const requiredReleaseFinalizerDigest =
    'sha256:68decc8b05ac6589935e71be526854b503e3f3dbf1cc50c13b3c7fa375e145fc';

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
    if (/[\r\n\u2028\u2029]/u.test(command))
    {
        return { error: 'line separators are outside the single-command argv grammar', argv: [] };
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
        return {
            error: null,
            invokesReleaseFinalizer: false,
            target: null,
            executableKind: 'non-executing-data',
            argv: parsed.argv
        };
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
            invokesReleaseFinalizer: repositoryScript === releaseFinalizerCommand,
            target: repositoryScript,
            executableKind: 'shell-script',
            argv: parsed.argv
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
            invokesReleaseFinalizer: commandReferencesReleaseFinalizer(parsed.argv, entrypointIndex),
            target: canonicalNodeEntrypoint(parsed.argv[entrypointIndex]),
            executableKind: 'node-entrypoint',
            argv: parsed.argv
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
            || commandReferencesReleaseFinalizer(parsed.argv, executableIndex + 1),
        target: repositoryExecutable,
        executableKind: 'repository-executable',
        argv: parsed.argv
    };
}

function digestBytes(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function inspectRegularRepositoryFile(repositoryRoot, relativePath)
{
    const errors = [];
    const repositoryPath = path.resolve(repositoryRoot);
    let repositoryRealPath;
    try
    {
        repositoryRealPath = fs.realpathSync(repositoryPath);
    }
    catch
    {
        return { errors: ['repository root cannot be resolved'], resolvedPath: null };
    }
    if (repositoryRealPath !== repositoryPath)
    {
        errors.push('repository root must not resolve through a symlink');
    }
    const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized))
    {
        return { errors: [`target ${relativePath} escapes the repository`], resolvedPath: null };
    }

    let current = repositoryPath;
    const segments = normalized.split('/');
    for (const [index, segment] of segments.entries())
    {
        current = path.join(current, segment);
        let stat;
        try
        {
            stat = fs.lstatSync(current);
        }
        catch
        {
            errors.push(`${normalized} path component ${segments.slice(0, index + 1).join('/')} is missing`);
            return { errors, resolvedPath: null };
        }
        if (stat.isSymbolicLink())
        {
            errors.push(`${normalized} path component ${segments.slice(0, index + 1).join('/')} is a symlink`);
            return { errors, resolvedPath: null };
        }
        const isTarget = index === segments.length - 1;
        if (isTarget ? !stat.isFile() : !stat.isDirectory())
        {
            errors.push(
                `${normalized} path component ${segments.slice(0, index + 1).join('/')} `
                + `must be a ${isTarget ? 'regular file' : 'directory'}`
            );
            return { errors, resolvedPath: null };
        }
        if (isTarget && stat.nlink !== 1)
        {
            errors.push(`${normalized} must have exactly one hard link`);
            return { errors, resolvedPath: null };
        }
        if (fs.realpathSync(current) !== current)
        {
            errors.push(`${normalized} path component ${segments.slice(0, index + 1).join('/')} has a nonliteral realpath`);
            return { errors, resolvedPath: null };
        }
    }
    return { errors, resolvedPath: current };
}

function repositoryIndexBytes(repositoryRoot, relativePath)
{
    const repositoryPath = fs.realpathSync(repositoryRoot);
    let metadata = repositoryGitMetadataCache.get(repositoryPath);
    if (!metadata)
    {
        try
        {
            const topLevel = execFileSync(
                'git',
                ['-C', repositoryRoot, 'rev-parse', '--show-toplevel'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
            ).trim();
            const indexPath = execFileSync(
                'git',
                ['-C', repositoryRoot, 'rev-parse', '--git-path', 'index'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
            ).trim();
            metadata = { topLevel, indexPath: path.resolve(repositoryRoot, indexPath) };
        }
        catch
        {
            metadata = { topLevel: null, indexPath: null };
        }
        repositoryGitMetadataCache.set(repositoryPath, metadata);
    }
    const { topLevel, indexPath } = metadata;
    if (!topLevel)
    {
        return { indexedRepository: false, bytes: null };
    }
    if (fs.realpathSync(topLevel) !== fs.realpathSync(repositoryRoot))
    {
        return { indexedRepository: false, bytes: null };
    }
    let indexSignature = null;
    try
    {
        const stat = fs.statSync(indexPath);
        indexSignature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
    catch
    {
        indexSignature = '<missing-index>';
    }
    const cacheKey = `${fs.realpathSync(repositoryRoot)}\0${relativePath}\0${indexSignature}`;
    if (repositoryIndexFileCache.has(cacheKey))
    {
        return { indexedRepository: true, bytes: repositoryIndexFileCache.get(cacheKey) };
    }
    try
    {
        const bytes = execFileSync(
                'git',
                ['-C', repositoryRoot, 'show', `:${relativePath}`],
                { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }
            );
        repositoryIndexFileCache.set(cacheKey, bytes);
        return { indexedRepository: true, bytes };
    }
    catch
    {
        repositoryIndexFileCache.set(cacheKey, null);
        return { indexedRepository: true, bytes: null };
    }
}

function existingDependencyVariant(repositoryRoot, candidate)
{
    const normalized = path.posix.normalize(candidate);
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized))
    {
        return null;
    }
    const variants = [normalized];
    if (!path.posix.extname(normalized))
    {
        variants.push(
            `${normalized}.mjs`,
            `${normalized}.js`,
            `${normalized}.cjs`,
            `${normalized}.ts`,
            `${normalized}.tsx`,
            `${normalized}.json`,
            path.posix.join(normalized, 'index.mjs'),
            path.posix.join(normalized, 'index.js')
        );
    }
    return variants.find((variant) =>
    {
        try
        {
            return fs.lstatSync(path.join(repositoryRoot, variant)).isFile()
                || fs.lstatSync(path.join(repositoryRoot, variant)).isSymbolicLink();
        }
        catch
        {
            return false;
        }
    }) ?? null;
}

function nearestPackageMetadata(repositoryRoot, ownerPath)
{
    let directory = path.posix.dirname(ownerPath);
    while (directory !== '.' && directory !== '')
    {
        const packagePath = path.posix.join(directory, 'package.json');
        try
        {
            const metadata = JSON.parse(fs.readFileSync(path.join(repositoryRoot, packagePath), 'utf8'));
            return { directory, packagePath, metadata };
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw new Error(`${packagePath} is invalid: ${error.message}`);
            }
        }
        const parent = path.posix.dirname(directory);
        if (parent === directory)
        {
            break;
        }
        directory = parent;
    }
    try
    {
        const metadata = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
        return { directory: '.', packagePath: 'package.json', metadata };
    }
    catch (error)
    {
        if (error.code !== 'ENOENT')
        {
            throw new Error(`package.json is invalid: ${error.message}`);
        }
        return null;
    }
}

function packageMapTarget(mapping, wildcard, conditions)
{
    if (typeof mapping === 'string')
    {
        return wildcard === null ? mapping : mapping.replaceAll('*', wildcard);
    }
    if (Array.isArray(mapping))
    {
        throw new Error('package mapping arrays are outside the execution closure grammar');
    }
    if (mapping && typeof mapping === 'object')
    {
        for (const [condition, target] of Object.entries(mapping))
        {
            if (condition === 'default' || conditions.has(condition))
            {
                return packageMapTarget(target, wildcard, conditions);
            }
        }
    }
    return null;
}

function mappedPackageTarget(map, request, conditions)
{
    if (typeof map === 'string' || Array.isArray(map))
    {
        return request === '.' ? packageMapTarget(map, null, conditions) : null;
    }
    if (!map || typeof map !== 'object')
    {
        return null;
    }
    const keys = Object.keys(map);
    if (request === '.' && keys.every((key) => !key.startsWith('.') && !key.startsWith('#')))
    {
        return packageMapTarget(map, null, conditions);
    }
    if (Object.hasOwn(map, request))
    {
        return packageMapTarget(map[request], null, conditions);
    }
    const match = keys
        .filter((key) => key.includes('*'))
        .map((key) =>
        {
            const [prefix, suffix] = key.split('*');
            if (!request.startsWith(prefix) || !request.endsWith(suffix))
            {
                return null;
            }
            const wildcard = request.slice(prefix.length, request.length - suffix.length);
            return { key, wildcard, specificity: prefix.length + suffix.length };
        })
        .filter(Boolean)
        .sort((left, right) => right.specificity - left.specificity || right.key.length - left.key.length)[0];
    return match ? packageMapTarget(map[match.key], match.wildcard, conditions) : null;
}

function resolveExistingDependencies(repositoryRoot, ownerPath, reference, referenceKind = 'import')
{
    let normalizedReference = reference.replaceAll('\\', '/');
    if (/^\.\/(?:tools|tests|src)\//u.test(normalizedReference))
    {
        normalizedReference = normalizedReference.slice(2);
    }
    if (normalizedReference.startsWith('.tmp/'))
    {
        return [];
    }
    if (normalizedReference.includes('/node_modules/'))
    {
        const metadata = nearestPackageMetadata(repositoryRoot, ownerPath);
        if (!metadata)
        {
            return [];
        }
        const lockPath = path.posix.join(metadata.directory, 'package-lock.json');
        const authority = [metadata.packagePath];
        if (fs.existsSync(path.join(repositoryRoot, lockPath)))
        {
            authority.push(lockPath);
        }
        return authority;
    }
    const repositoryRelativeTraversal = normalizedReference.match(/^(?:\.\.\/)+(tools|tests|src)\/(.+)$/u);
    if (repositoryRelativeTraversal)
    {
        normalizedReference = `${repositoryRelativeTraversal[1]}/${repositoryRelativeTraversal[2]}`;
    }
    const packageMetadata = nearestPackageMetadata(repositoryRoot, ownerPath);
    let candidates;
    let packageAuthority = [];
    if (normalizedReference.startsWith('#'))
    {
        if (!packageMetadata)
        {
            throw new Error(`${ownerPath} imports ${normalizedReference} without package imports authority`);
        }
        const target = mappedPackageTarget(
            packageMetadata.metadata.imports,
            normalizedReference,
            new Set(['node', referenceKind, 'default'])
        );
        if (!target)
        {
            throw new Error(`${ownerPath} package import ${normalizedReference} is unresolved`);
        }
        if (!target.startsWith('./'))
        {
            return [];
        }
        candidates = [path.posix.join(packageMetadata.directory, target)];
        packageAuthority = [packageMetadata.packagePath];
    }
    else if (
        packageMetadata?.metadata.name
        && (
            normalizedReference === packageMetadata.metadata.name
            || normalizedReference.startsWith(`${packageMetadata.metadata.name}/`)
        )
    )
    {
        const subpath = normalizedReference === packageMetadata.metadata.name
            ? '.'
            : `.${normalizedReference.slice(packageMetadata.metadata.name.length)}`;
        const target = mappedPackageTarget(
            packageMetadata.metadata.exports,
            subpath,
            new Set(['node', referenceKind, 'default'])
        );
        if (!target)
        {
            throw new Error(`${ownerPath} package self-reference ${normalizedReference} is unresolved`);
        }
        if (!target.startsWith('./'))
        {
            throw new Error(`${ownerPath} package self-reference ${normalizedReference} escapes its package`);
        }
        candidates = [path.posix.join(packageMetadata.directory, target)];
        packageAuthority = [packageMetadata.packagePath];
    }
    else if (
        normalizedReference.startsWith('.')
        || ['tools/', 'tests/', 'src/'].some((prefix) => normalizedReference.startsWith(prefix))
    )
    {
        candidates = [
            ['tools/', 'tests/', 'src/'].some((prefix) => normalizedReference.startsWith(prefix))
                ? normalizedReference
                : path.posix.join(path.posix.dirname(ownerPath), normalizedReference)
        ];
    }
    else
    {
        return [];
    }
    const packageRoot = packageMetadata ? path.posix.normalize(packageMetadata.directory) : null;
    if (
        packageAuthority.length > 0
        && candidates.some((candidate) =>
            packageRoot !== '.'
            && path.posix.normalize(candidate) !== packageRoot
            && !path.posix.normalize(candidate).startsWith(`${packageRoot}/`)
        )
    )
    {
        throw new Error(`${ownerPath} package mapping ${normalizedReference} escapes its package`);
    }
    const resolved = candidates.map((candidate) => existingDependencyVariant(
        repositoryRoot,
        candidate.replace(/[?#].*$/u, '')
    ));
    if (resolved.some((candidate) => candidate === null))
    {
        throw new Error(`${ownerPath} local dependency ${normalizedReference} is unresolved`);
    }
    return [...new Set([...packageAuthority, ...resolved])];
}

function nodeModuleDependencyReferences(repositoryRoot, ownerPath, source)
{
    if (ownerPath.endsWith('.tsx'))
    {
        throw new Error(`${ownerPath} TSX is outside the sealed Node parser grammar`);
    }
    const parseSource = /\.(?:ts|tsx)$/u.test(ownerPath)
        ? stripTypeScriptTypes(source, { mode: 'transform' })
        : source;
    const packageMetadata = nearestPackageMetadata(repositoryRoot, ownerPath);
    const sourceType = ownerPath.endsWith('.mjs') || packageMetadata?.metadata.type === 'module'
        ? 'module'
        : ownerPath.endsWith('.cjs') || packageMetadata?.metadata.type !== 'module'
            ? 'script'
            : 'module';
    const ast = builtinAcorn.parse(parseSource, {
        ecmaVersion: 'latest',
        sourceType,
        allowHashBang: true
    });
    const references = new Set();
    const bindings = new Map();
    const ambiguousBindings = new Set();
    const reassignedBindings = new Set();
    const callableBindings = new Map();
    let requireIsShadowed = ast.body.some((node) =>
        (
            node.type === 'VariableDeclaration'
            && node.declarations.some((declaration) =>
                declaration.id?.type === 'Identifier' && declaration.id.name === 'require'
            )
        )
        || (
            node.type === 'FunctionDeclaration'
            && node.id?.name === 'require'
        )
        || (
            node.type === 'ImportDeclaration'
            && node.specifiers.some((specifier) => specifier.local?.name === 'require')
        )
    );
    const authorizedRuntimeModuleLoad = (node, kind) =>
    {
        const sourceDigest = digestBytes(source);
        const expressionDigest = digestBytes(parseSource.slice(node.start, node.end));
        let sourceIndex;
        try
        {
            sourceIndex = JSON.parse(fs.readFileSync(
                path.join(repositoryRoot, executionAuthorityIndexPath),
                'utf8'
            ));
        }
        catch
        {
            return { authorized: false, sourceDigest, expressionDigest };
        }
        const entry = sourceIndex.runtimeDynamicImports?.find((candidate) =>
            candidate.owner === ownerPath
            && candidate.sourceDigest === sourceDigest
            && candidate.expressionDigest === expressionDigest
            && candidate.kind === kind
        ) ?? null;
        return { authorized: Boolean(entry), entry, sourceDigest, expressionDigest };
    };
    const literalValue = (node) => (
        node?.type === 'Literal'
            ? node.value
            : null
    );
    const isImportMetaUrl = (node) => (
        node?.type === 'MemberExpression'
        && node.computed === false
        && node.object?.type === 'MetaProperty'
        && node.object.meta?.name === 'import'
        && node.object.property?.name === 'meta'
        && node.property?.type === 'Identifier'
        && node.property.name === 'url'
    );
    const evaluate = (node, seen = new Set(), depth = 0) =>
    {
        if (depth > 128)
        {
            return null;
        }
        const literal = literalValue(node);
        if (typeof literal === 'string')
        {
            return literal;
        }
        if (node?.type === 'Identifier')
        {
            if (node.name === 'require' && !requireIsShadowed)
            {
                return { callable: 'require' };
            }
            if (callableBindings.has(node.name))
            {
                return { callable: callableBindings.get(node.name) };
            }
            if (
                seen.has(node.name)
                || !bindings.has(node.name)
                || ambiguousBindings.has(node.name)
                || reassignedBindings.has(node.name)
            )
            {
                return null;
            }
            return evaluate(bindings.get(node.name), new Set([...seen, node.name]), depth + 1);
        }
        if (node?.type === 'TemplateLiteral')
        {
            let result = '';
            for (const [index, quasi] of node.quasis.entries())
            {
                result += quasi.value.cooked ?? quasi.value.raw;
                if (index < node.expressions.length)
                {
                    const expression = evaluate(node.expressions[index], seen, depth + 1);
                    if (typeof expression !== 'string')
                    {
                        return null;
                    }
                    result += expression;
                }
            }
            return result;
        }
        if (node?.type === 'BinaryExpression' && node.operator === '+')
        {
            const left = evaluate(node.left, seen, depth + 1);
            const right = evaluate(node.right, seen, depth + 1);
            return typeof left === 'string' && typeof right === 'string' ? left + right : null;
        }
        if (
            node?.type === 'NewExpression'
            && node.callee?.type === 'Identifier'
            && node.callee.name === 'URL'
            && isImportMetaUrl(node.arguments?.[1])
        )
        {
            return evaluate(node.arguments[0], seen, depth + 1);
        }
        if (
            node?.type === 'MemberExpression'
            && node.computed === false
            && node.property?.name === 'href'
        )
        {
            return evaluate(node.object, seen, depth + 1);
        }
        if (node?.type === 'MemberExpression' && node.computed === false)
        {
            const object = evaluate(node.object, seen, depth + 1);
            if (object?.callable === 'namespace:path')
            {
                return { callable: node.property?.name };
            }
            if (object?.callable === 'require' && node.property?.name === 'resolve')
            {
                return { callable: 'require.resolve' };
            }
        }
        if (node?.type === 'CallExpression')
        {
            const callable = evaluate(node.callee, seen, depth + 1)?.callable;
            const values = node.arguments.map((argument) => evaluate(argument, seen, depth + 1));
            if (callable === 'pathToFileURL' && typeof values[0] === 'string')
            {
                return values[0];
            }
            if (callable === 'createRequire')
            {
                return { callable: 'require' };
            }
            if (callable === 'require.resolve' && typeof values[0] === 'string')
            {
                return values[0];
            }
            if (['join', 'resolve'].includes(callable) && values.every((value) => typeof value === 'string'))
            {
                return callable === 'join'
                    ? path.posix.join(...values)
                    : path.posix.normalize(path.posix.join(...values));
            }
            if (callable === 'dirname' && typeof values[0] === 'string')
            {
                return path.posix.dirname(values[0]);
            }
            if (callable === 'fileURLToPath' && isImportMetaUrl(node.arguments[0]))
            {
                return ownerPath;
            }
        }
        if (
            node?.type === 'CallExpression'
            && node.callee?.type === 'MemberExpression'
            && node.callee.computed === false
            && node.callee.property?.name === 'join'
            && node.callee.object?.type === 'ArrayExpression'
        )
        {
            const separator = evaluate(node.arguments?.[0], seen, depth + 1) ?? ',';
            const values = node.callee.object.elements.map((element) => evaluate(element, seen, depth + 1));
            return typeof separator === 'string' && values.every((value) => typeof value === 'string')
                ? values.join(separator)
                : null;
        }
        return null;
    };
    const bindingStack = [ast];
    while (bindingStack.length > 0)
    {
        const node = bindingStack.pop();
        if (!node || typeof node !== 'object')
        {
            continue;
        }
        if (node.type === 'VariableDeclaration')
        {
            for (const declaration of node.declarations)
            {
                if (declaration.id?.type !== 'Identifier')
                {
                    continue;
                }
                if (node.kind === 'const' && declaration.init)
                {
                    if (bindings.has(declaration.id.name))
                    {
                        ambiguousBindings.add(declaration.id.name);
                    }
                    else
                    {
                        bindings.set(declaration.id.name, declaration.init);
                    }
                }
            }
        }
        if (
            node.type === 'AssignmentExpression'
            && node.left?.type === 'Identifier'
        )
        {
            reassignedBindings.add(node.left.name);
        }
        if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier')
        {
            reassignedBindings.add(node.argument.name);
        }
        if (
            node.type === 'ImportDeclaration'
            && ['node:module', 'node:path', 'node:url'].includes(node.source?.value)
        )
        {
            for (const specifier of node.specifiers)
            {
                if (specifier.type === 'ImportSpecifier')
                {
                    callableBindings.set(specifier.local.name, specifier.imported.name);
                }
                else if (
                    node.source.value === 'node:path'
                    && ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(specifier.type)
                )
                {
                    callableBindings.set(specifier.local.name, 'namespace:path');
                }
            }
        }
        for (const value of Object.values(node))
        {
            if (Array.isArray(value))
            {
                bindingStack.push(...value);
            }
            else if (value && typeof value === 'object')
            {
                bindingStack.push(value);
            }
        }
    }
    if (bindings.has('require') && evaluate(bindings.get('require'))?.callable === 'require')
    {
        requireIsShadowed = false;
    }
    const visitStack = [ast];
    while (visitStack.length > 0)
    {
        const node = visitStack.pop();
        if (!node || typeof node !== 'object')
        {
            continue;
        }
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type))
        {
            const reference = literalValue(node.source);
            if (typeof reference === 'string')
            {
                references.add(JSON.stringify({ reference, kind: 'import' }));
            }
        }
        else if (node.type === 'ImportExpression')
        {
            const reference = evaluate(node.source);
            if (typeof reference === 'string')
            {
                references.add(JSON.stringify({ reference, kind: 'import' }));
            }
            else
            {
                const authority = authorizedRuntimeModuleLoad(node, 'runtime-module-path');
                if (!authority.authorized)
                {
                    throw new Error(
                        `${ownerPath} contains an unresolved dynamic import `
                        + `source=${authority.sourceDigest} expression=${authority.expressionDigest}`
                    );
                }
                for (const dependency of authority.entry.dependencies ?? [])
                {
                    if (typeof dependency !== 'string' || !dependency.trim())
                    {
                        throw new Error(`${ownerPath} has an invalid runtime import dependency authority`);
                    }
                    references.add(JSON.stringify({ reference: dependency, kind: 'import' }));
                }
            }
        }
        else if (
            node.type === 'CallExpression'
            && evaluate(node.callee)?.callable === 'require'
        )
        {
            const reference = evaluate(node.arguments?.[0]);
            if (typeof reference === 'string')
            {
                references.add(JSON.stringify({ reference, kind: 'require' }));
            }
            else
            {
                const authority = authorizedRuntimeModuleLoad(node, 'runtime-require-path');
                if (!authority.authorized)
                {
                    throw new Error(
                        `${ownerPath} contains an unresolved dynamic require `
                        + `source=${authority.sourceDigest} expression=${authority.expressionDigest}`
                    );
                }
                for (const dependency of authority.entry.dependencies ?? [])
                {
                    references.add(JSON.stringify({ reference: dependency, kind: 'require' }));
                }
            }
        }
        else if (
            node.type === 'CallExpression'
            && node.callee?.type === 'Identifier'
            && node.callee.name === 'require'
            && requireIsShadowed
        )
        {
            throw new Error(`${ownerPath} shadows require in a code-bearing call position`);
        }
        for (const [key, value] of Object.entries(node))
        {
            if (key === 'loc' || key === 'start' || key === 'end')
            {
                continue;
            }
            if (Array.isArray(value))
            {
                visitStack.push(...value);
            }
            else if (value && typeof value === 'object')
            {
                visitStack.push(value);
            }
        }
    }
    return [...references].map((reference) => JSON.parse(reference));
}

function shellSourceWithoutHeredocs(source)
{
    const output = [];
    let delimiter = null;
    let stripTabs = false;
    for (const line of source.split(/\r?\n/u))
    {
        if (delimiter !== null)
        {
            const candidate = stripTabs ? line.replace(/^\t+/u, '') : line;
            if (candidate === delimiter)
            {
                delimiter = null;
                stripTabs = false;
            }
            continue;
        }
        output.push(line);
        const match = line.match(/<<(?<strip>-)?\s*['"]?(?<delimiter>[A-Za-z_][A-Za-z0-9_]*)['"]?/u);
        if (match)
        {
            delimiter = match.groups.delimiter;
            stripTabs = Boolean(match.groups.strip);
        }
    }
    if (delimiter !== null)
    {
        throw new Error(`unterminated shell heredoc ${delimiter}`);
    }
    return output.join('\n').replaceAll('\\\n', ' ');
}

function shellCommands(source)
{
    const commands = [];
    let command = [];
    let word = '';
    const contexts = [{ kind: 'root', quote: null, parenDepth: 0, escaped: false }];
    const finishWord = () =>
    {
        if (word.length > 0)
        {
            command.push(word);
            word = '';
        }
    };
    const finishCommand = () =>
    {
        finishWord();
        if (command.length > 0)
        {
            commands.push(command);
            command = [];
        }
    };
    const input = shellSourceWithoutHeredocs(source);
    for (let index = 0; index < input.length; index += 1)
    {
        const character = input[index];
        const next = input[index + 1];
        const context = contexts.at(-1);
        if (context.escaped)
        {
            word += `\\${character}`;
            context.escaped = false;
            continue;
        }
        if (context.quote === "'")
        {
            word += character;
            if (character === "'")
            {
                context.quote = null;
            }
            continue;
        }
        if (context.quote === '"')
        {
            if (character === '\\')
            {
                context.escaped = true;
                continue;
            }
            if (character === '"')
            {
                context.quote = null;
                word += character;
                continue;
            }
            if (character === '$' && next === '(')
            {
                const arithmetic = input[index + 2] === '(';
                contexts.push({
                    kind: arithmetic ? 'arithmetic' : 'substitution',
                    quote: null,
                    parenDepth: arithmetic ? 2 : 1,
                    escaped: false
                });
                word += arithmetic ? '$((' : '$(';
                index += arithmetic ? 2 : 1;
                continue;
            }
            word += character;
            continue;
        }
        if (character === '\\')
        {
            context.escaped = true;
            continue;
        }
        if (character === '$' && next === '(')
        {
            const arithmetic = input[index + 2] === '(';
            contexts.push({
                kind: arithmetic ? 'arithmetic' : 'substitution',
                quote: null,
                parenDepth: arithmetic ? 2 : 1,
                escaped: false
            });
            word += arithmetic ? '$((' : '$(';
            index += arithmetic ? 2 : 1;
            continue;
        }
        if (character === "'" || character === '"')
        {
            context.quote = character;
            word += character;
            continue;
        }
        if (
            context.kind === 'root'
            && character === '('
            && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/u.test(word)
        )
        {
            contexts.push({ kind: 'array', quote: null, parenDepth: 1, escaped: false });
            word += character;
            continue;
        }
        if (context.kind !== 'root')
        {
            if (character === '(')
            {
                context.parenDepth += 1;
            }
            else if (character === ')')
            {
                context.parenDepth -= 1;
                if (context.parenDepth === 0)
                {
                    contexts.pop();
                }
            }
            word += character;
            continue;
        }
        if (character === '#' && word.length === 0)
        {
            while (index < input.length && input[index] !== '\n')
            {
                index += 1;
            }
            finishCommand();
            continue;
        }
        if (/\s/u.test(character))
        {
            finishWord();
            if (character === '\n')
            {
                finishCommand();
            }
            continue;
        }
        if (';|&{}'.includes(character))
        {
            finishCommand();
            if ((character === '&' || character === '|') && next === character)
            {
                index += 1;
            }
            continue;
        }
        if (character === '(' || character === ')')
        {
            finishCommand();
            continue;
        }
        word += character;
    }
    if (contexts.length !== 1 || contexts[0].quote)
    {
        const context = contexts.at(-1);
        throw new Error(`unterminated shell quote or command substitution kind=${context.kind}`);
    }
    finishCommand();
    return commands;
}

function shellCommandSubstitutions(word)
{
    const substitutions = [];
    for (let index = 0; index < word.length - 1; index += 1)
    {
        if (word[index] !== '$' || word[index + 1] !== '(')
        {
            continue;
        }
        const arithmetic = word[index + 2] === '(';
        let depth = 1;
        let quote = null;
        let body = '';
        if (arithmetic)
        {
            depth = 2;
        }
        index += arithmetic ? 3 : 2;
        for (; index < word.length && depth > 0; index += 1)
        {
            const character = word[index];
            if (quote)
            {
                body += character;
                if (character === quote)
                {
                    quote = null;
                }
                continue;
            }
            if (character === "'" || character === '"')
            {
                quote = character;
                body += character;
            }
            else if (character === '(')
            {
                depth += 1;
                body += character;
            }
            else if (character === ')')
            {
                depth -= 1;
                if (depth > 0)
                {
                    body += character;
                }
            }
            else
            {
                body += character;
            }
        }
        if (depth !== 0)
        {
            throw new Error('unterminated shell command substitution');
        }
        if (!arithmetic)
        {
            substitutions.push(body);
        }
        index -= 1;
    }
    return substitutions;
}

function shellKnownWord(rawWord, variables, ownerPath)
{
    let word = rawWord;
    if (word.startsWith("'") && word.endsWith("'") && word.length >= 2)
    {
        return word.slice(1, -1);
    }
    const defaultExpansion = word.match(/^['"]?\$\{[A-Za-z_][A-Za-z0-9_]*:-([\s\S]+)\}['"]?$/u);
    if (defaultExpansion)
    {
        return shellKnownWord(defaultExpansion[1], variables, ownerPath);
    }
    const canonicalCd = word.match(/^['"]?\$\(cd\s+(.+?)\s+&&\s+pwd\)['"]?$/su);
    if (canonicalCd)
    {
        return shellKnownWord(canonicalCd[1], variables, ownerPath);
    }
    const sourceDirectory = word.match(
        /^['"]?\$\(dirname\s+["']?\$\{BASH_SOURCE\[0\]\}["']?\)(?<suffix>\/[^"']+)?['"]?$/u
    );
    if (sourceDirectory)
    {
        return path.posix.normalize(path.posix.join(
            path.posix.dirname(ownerPath),
            sourceDirectory.groups.suffix ?? '.'
        ));
    }
    const directoryIdentity = word.match(
        /BASH_SOURCE\[0\]\}["']?\)(?<suffix>\/[^ "'&)]+)?["']?\s*&&\s*pwd/u
    );
    if (directoryIdentity && /pwd\)"?$/u.test(word))
    {
        return path.posix.normalize(path.posix.join(
            path.posix.dirname(ownerPath),
            directoryIdentity.groups.suffix ?? '.'
        ));
    }
    if (/\$\(.*BASH_SOURCE\[0\].*\).*/u.test(word))
    {
        const suffix = word.match(/\)(?<suffix>\/[A-Za-z0-9_./-]+\.(?:sh|mjs|js|cjs|ts|tsx))(?:["']?)$/u)?.groups.suffix;
        if (suffix)
        {
            return path.posix.join(path.posix.dirname(ownerPath), suffix);
        }
    }
    word = word.replace(/^(['"])(.*)\1$/su, '$2');
    word = word
        .replaceAll('${ROOT_DIR}/', '')
        .replaceAll('$ROOT_DIR/', '')
        .replaceAll('${ROOT_DIR}', '')
        .replaceAll('$ROOT_DIR', '');
    word = word.replaceAll('${FSUSBLOG_NODE:-node}', 'node');
    if (['$NODE_FD_PATH', '${NODE_FD_PATH}'].includes(word))
    {
        return 'node';
    }
    const exactExpansion = word.match(/^\$\{?(?<name>[A-Za-z_][A-Za-z0-9_]*)\}?$/u);
    if (exactExpansion)
    {
        return variables.get(exactExpansion.groups.name) ?? null;
    }
    word = word.replace(/\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}/gu, (match, name) =>
        typeof variables.get(name) === 'string' ? variables.get(name) : match
    );
    word = word.replace(/\$(?<name>[A-Za-z_][A-Za-z0-9_]*)/gu, (match, name) =>
        typeof variables.get(name) === 'string' ? variables.get(name) : match
    );
    word = word.replaceAll('"', '').replaceAll("'", '').replace(/\\(.)/gu, '$1');
    if (/[$`*?\[\]]/u.test(word))
    {
        return null;
    }
    return word;
}

function shellDependencyReferences(
    repositoryRoot,
    ownerPath,
    source,
    state = { visitedPackageScripts: new Set() }
)
{
    const references = new Set();
    const { visitedPackageScripts } = state;
    const arrays = new Map();
    for (const match of source.matchAll(
        /(?:^|\n)\s*(?:local\s+-a\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)=\(\s*\n(?<body>[\s\S]*?)\n\s*\)/gu
    ))
    {
        arrays.set(match.groups.name, shellCommands(match.groups.body).flat());
    }
    const iterators = new Map();
    for (const match of source.matchAll(
        /for\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+in\s+"?\$\{(?<array>[A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?/gu
    ))
    {
        iterators.set(match.groups.name, match.groups.array);
    }
    const forwardingFunctions = new Map([
        ['Run', 0],
        ['RunInClient', 0],
        ['RunInClientMeasurement', 2],
        ['RunSecurityStage', 1],
        ['RunIntegrationStage', 1]
    ]);
    let currentDirectory = path.posix.dirname(ownerPath);
    const variables = new Map([
        ['ROOT_DIR', ''],
        ['NODE_BIN', 'node'],
        ['NODE_FD_PATH', 'node']
    ]);
    const authorizedRuntimeShellSource = (rawWord, position) =>
    {
        if (position !== 'source dependency')
        {
            return { authorized: false };
        }
        const sourceDigest = digestBytes(source);
        const expressionDigest = digestBytes(rawWord);
        let sourceIndex;
        try
        {
            sourceIndex = JSON.parse(fs.readFileSync(
                path.join(repositoryRoot, executionAuthorityIndexPath),
                'utf8'
            ));
        }
        catch
        {
            return { authorized: false, sourceDigest, expressionDigest };
        }
        const entry = sourceIndex.runtimeDynamicShellSources?.find((candidate) =>
            candidate.owner === ownerPath
            && candidate.sourceDigest === sourceDigest
            && candidate.expressionDigest === expressionDigest
            && candidate.kind === 'runtime-shell-source'
        ) ?? null;
        return { authorized: Boolean(entry), entry, sourceDigest, expressionDigest };
    };
    const forwardsArguments = (relativePath) =>
    {
        if (!relativePath.endsWith('.sh'))
        {
            return false;
        }
        const wrapperSource = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        try
        {
            const isArguments = (word) =>
                ['$@', '"$@"', "'$@'", '${@}', '"${@}"'].includes(word);
            return shellCommands(wrapperSource).some((command) =>
                isArguments(command[0])
                || (command[0] === 'exec' && isArguments(command[1]))
                || (path.posix.basename(command[0] ?? '') === 'flock' && isArguments(command.at(-1)))
            );
        }
        catch (error)
        {
            throw new Error(`${relativePath} forwarding summary failed: ${error.message}`);
        }
    };
    const add = (rawWord, position) =>
    {
        const known = shellKnownWord(rawWord, variables, ownerPath);
        if (known === null)
        {
            const authority = authorizedRuntimeShellSource(rawWord, position);
            if (authority.authorized)
            {
                for (const dependency of authority.entry.dependencies ?? [])
                {
                    if (typeof dependency !== 'string' || !dependency.trim())
                    {
                        throw new Error(`${ownerPath} has an invalid runtime shell source authority`);
                    }
                    for (const resolved of resolveExistingDependencies(
                        repositoryRoot,
                        ownerPath,
                        dependency,
                        'require'
                    ))
                    {
                        references.add(resolved);
                    }
                }
                return rawWord;
            }
            throw new Error(`${ownerPath} contains unresolved ${position}: ${rawWord}`);
        }
        const resolutionOwner = known.startsWith('.')
            ? path.posix.join(currentDirectory, '.shell-execution')
            : ownerPath;
        const resolved = resolveExistingDependencies(repositoryRoot, resolutionOwner, known, 'require');
        for (const dependency of resolved)
        {
            if (dependency !== ownerPath)
            {
                references.add(dependency);
            }
        }
        return known;
    };
    const dispatch = (words, expandArrays = true) =>
    {
        const expandedWords = (expandArrays ? words : []).flatMap((word) =>
        {
            const arrayExpansion = word.match(/^"?\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\[@\]\}"?$/u);
            return arrayExpansion && arrays.has(arrayExpansion.groups.name)
                ? arrays.get(arrayExpansion.groups.name)
                : [word];
        });
        if (!expandArrays)
        {
            expandedWords.push(...words);
        }
        const filtered = expandedWords.filter((word) =>
            !['if', 'then', 'elif', 'else', 'do', 'done', 'fi'].includes(word)
        );
        if (['local', 'declare', 'readonly', 'export'].includes(filtered[0]))
        {
            filtered.shift();
            while (filtered[0]?.startsWith('-'))
            {
                filtered.shift();
            }
        }
        while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(filtered[0] ?? ''))
        {
            const assignment = filtered.shift();
            const separator = assignment.indexOf('=');
            const name = assignment.slice(0, separator);
            const value = shellKnownWord(assignment.slice(separator + 1), variables, ownerPath);
            if (value !== null)
            {
                variables.set(name, value);
            }
        }
        if (filtered.length === 0)
        {
            return;
        }
        const executable = shellKnownWord(filtered[0], variables, ownerPath);
        if (executable === null)
        {
            if (['exec', 'source', '.', 'bash', 'sh', 'node'].includes(filtered[0]))
            {
                throw new Error(`${ownerPath} contains unresolved executable ${filtered[0]}`);
            }
            return;
        }
        const basename = path.posix.basename(executable);
        if (basename === 'source' || filtered[0] === '.')
        {
            if (!filtered[1])
            {
                throw new Error(`${ownerPath} source command is missing its dependency: ${JSON.stringify(filtered)}`);
            }
            add(filtered[1], 'source dependency');
            return;
        }
        if (basename === 'exec')
        {
            const nested = filtered.slice(1).filter((word) => !/^\{[A-Za-z_][A-Za-z0-9_]*\}</u.test(word));
            if (nested.length > 0)
            {
                dispatch(nested, false);
            }
            return;
        }
        if (['env', 'command', 'timeout', 'nice', 'setsid'].includes(basename))
        {
            let index = 1;
            while (index < filtered.length && (/^-/u.test(filtered[index]) || /^\d+(?:\.\d+)?[smhd]?$/u.test(filtered[index])))
            {
                index += 1;
            }
            if (filtered[index])
            {
                dispatch(filtered.slice(index), false);
            }
            return;
        }
        if (basename === 'eval')
        {
            return;
        }
        if (basename === 'cd')
        {
            const directory = shellKnownWord(filtered[1] ?? '', variables, ownerPath);
            if (directory === null)
            {
                return;
            }
            currentDirectory = path.posix.normalize(
                ['tools/', 'tests/', 'src/'].some((prefix) => directory.startsWith(prefix))
                    ? directory
                    : path.posix.join(currentDirectory, directory)
            );
            return;
        }
        if (basename === 'find')
        {
            const execIndex = filtered.findIndex((word) => word === '-exec' || word === '-execdir');
            if (execIndex >= 0)
            {
                const end = filtered.findIndex((word, index) => index > execIndex && ['\\;', '+'].includes(word));
                dispatch(filtered.slice(execIndex + 1, end < 0 ? filtered.length : end), false);
            }
            return;
        }
        if (basename === 'xargs')
        {
            const nestedIndex = filtered.findIndex((word, index) => index > 0 && !word.startsWith('-'));
            if (nestedIndex < 0)
            {
                return;
            }
            dispatch(filtered.slice(nestedIndex), false);
            return;
        }
        if (basename === 'bash' || basename === 'sh')
        {
            const commandIndex = filtered.findIndex((word) => word === '-c');
            if (commandIndex >= 0)
            {
                const command = shellKnownWord(filtered[commandIndex + 1] ?? '', variables, ownerPath);
                if (command === null)
                {
                    throw new Error(`${ownerPath} contains a dynamic ${basename} -c payload`);
                }
                for (const commandWords of shellCommands(command))
                {
                    dispatch(commandWords, false);
                }
                return;
            }
            const script = filtered.slice(1).find((word) => !word.startsWith('-'));
            if (script && script !== '-')
            {
                add(script, `${basename} script`);
            }
            return;
        }
        if (basename === 'node')
        {
            let testMode = false;
            for (let index = 1; index < filtered.length; index += 1)
            {
                const argument = filtered[index];
                if (['-e', '--eval', '-p', '--print', '-'].includes(argument))
                {
                    return;
                }
                if (argument === '--test')
                {
                    testMode = true;
                    continue;
                }
                if (['--require', '--import', '--loader', '--experimental-loader'].includes(argument))
                {
                    add(filtered[index + 1] ?? '', `node ${argument} dependency`);
                    index += 1;
                    continue;
                }
                if (argument.startsWith('-'))
                {
                    continue;
                }
                if (/^(?:\d*)[<>]/u.test(argument))
                {
                    continue;
                }
                const iterator = [...iterators.entries()].find(([name]) =>
                    argument.includes(`$${name}`) || argument.includes(`\${${name}}`)
                );
                if (iterator && arrays.has(iterator[1]))
                {
                    for (const value of arrays.get(iterator[1]))
                    {
                        add(value, testMode ? 'node test entrypoint' : 'node entrypoint');
                    }
                    if (!testMode)
                    {
                        return;
                    }
                    continue;
                }
                add(argument, testMode ? 'node test entrypoint' : 'node entrypoint');
                if (!testMode)
                {
                    return;
                }
            }
            return;
        }
        if (basename === 'npm' || basename === 'pnpm')
        {
            let packageDirectory = currentDirectory;
            const prefixIndex = filtered.findIndex((word) => word === '--prefix' || word === '--dir');
            if (prefixIndex >= 0)
            {
                const prefix = shellKnownWord(filtered[prefixIndex + 1] ?? '', variables, ownerPath);
                if (prefix === null)
                {
                    throw new Error(`${ownerPath} contains a dynamic package-manager prefix`);
                }
                packageDirectory = path.posix.normalize(
                    prefix.startsWith('tools/') || prefix.startsWith('tests/') || prefix.startsWith('src/')
                        ? prefix
                        : path.posix.join(path.posix.dirname(ownerPath), prefix)
                );
            }
            const runIndex = filtered.findIndex((word) => word === 'run' || word === 'run-script');
            if (runIndex < 0 || !filtered[runIndex + 1])
            {
                return;
            }
            let packagePath = path.posix.join(packageDirectory, 'package.json');
            let packageFile = inspectRegularRepositoryFile(repositoryRoot, packagePath);
            if (!packageFile.resolvedPath && ownerPath.startsWith('tools/'))
            {
                packageDirectory = 'src/frontend';
                packagePath = 'src/frontend/package.json';
                packageFile = inspectRegularRepositoryFile(repositoryRoot, packagePath);
            }
            if (!packageFile.resolvedPath)
            {
                throw new Error(`${ownerPath} package-manager authority is invalid: ${packageFile.errors.join('; ')}`);
            }
            references.add(packagePath);
            const metadata = JSON.parse(fs.readFileSync(packageFile.resolvedPath, 'utf8'));
            const scriptName = shellKnownWord(filtered[runIndex + 1], variables, ownerPath);
            const scriptEntries = scriptName === null
                ? Object.entries(metadata.scripts ?? {})
                : [[scriptName, metadata.scripts?.[scriptName]]];
            if (scriptEntries.some(([, packageScript]) => typeof packageScript !== 'string'))
            {
                throw new Error(`${packagePath} does not define script ${scriptName}`);
            }
            for (const [resolvedScriptName, packageScript] of scriptEntries)
            {
                const scriptKey = `${packagePath}\0${resolvedScriptName}`;
                if (visitedPackageScripts.has(scriptKey))
                {
                    continue;
                }
                visitedPackageScripts.add(scriptKey);
                for (const dependency of shellDependencyReferences(
                    repositoryRoot,
                    packagePath,
                    packageScript,
                    state
                ))
                {
                    references.add(dependency);
                }
            }
            return;
        }
        if (['printf', 'echo', 'test', '[', '[[', 'true', 'false'].includes(basename))
        {
            return;
        }
        if (filtered[0] === '\\.')
        {
            return;
        }
        const direct = resolveExistingDependencies(repositoryRoot, ownerPath, executable, 'require');
        for (const dependency of direct)
        {
            if (dependency !== ownerPath)
            {
                references.add(dependency);
            }
        }
        const directTarget = direct.find((dependency) => dependency === executable || dependency.endsWith(executable));
        if (directTarget && forwardsArguments(directTarget) && filtered.length > 1)
        {
            dispatch(filtered.slice(1), false);
        }
        if (forwardingFunctions.has(executable) && filtered.length > 1)
        {
            dispatch(filtered.slice(1 + forwardingFunctions.get(executable)), false);
        }
    };
    for (const words of shellCommands(source))
    {
        for (const word of words)
        {
            let substitutions;
            try
            {
                substitutions = shellCommandSubstitutions(word);
            }
            catch (error)
            {
                throw new Error(`${ownerPath}: ${error.message}: ${word}`);
            }
            for (const substitution of substitutions)
            {
                if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/u.test(substitution))
                {
                    continue;
                }
                const parentDirectory = currentDirectory;
                for (const nested of shellCommands(substitution))
                {
                    dispatch(nested);
                }
                currentDirectory = parentDirectory;
            }
        }
        dispatch(words);
    }
    return [...references].sort();
}

function localDependencyReferences(repositoryRoot, ownerPath, source)
{
    const references = new Set();
    const add = (reference, referenceKind = 'import') =>
    {
        for (const resolved of resolveExistingDependencies(repositoryRoot, ownerPath, reference, referenceKind))
        {
            if (resolved !== ownerPath)
            {
                references.add(resolved);
            }
        }
    };
    if (/\.(?:mjs|js|cjs|ts|tsx)$/u.test(ownerPath))
    {
        const packageMetadata = nearestPackageMetadata(repositoryRoot, ownerPath);
        if (packageMetadata && packageMetadata.packagePath !== ownerPath)
        {
            references.add(packageMetadata.packagePath);
        }
        let moduleReferences;
        try
        {
            moduleReferences = nodeModuleDependencyReferences(repositoryRoot, ownerPath, source);
        }
        catch (error)
        {
            throw new Error(`${ownerPath}: Node module AST parse failed: ${error.message}`, { cause: error });
        }
        for (const { reference, kind } of moduleReferences)
        {
            add(reference, kind);
        }
    }
    else if (ownerPath.endsWith('.sh'))
    {
        let shellReferences;
        try
        {
            shellReferences = shellDependencyReferences(repositoryRoot, ownerPath, source);
        }
        catch (error)
        {
            throw new Error(`${ownerPath}: shell execution AST failed: ${error.message}`, { cause: error });
        }
        for (const dependency of shellReferences)
        {
            references.add(dependency);
        }
    }
    return [...references].sort();
}

export function inspectReleaseFinalCommandTarget({ repositoryRoot = root, target, additionalTargets = [] })
{
    const cacheKey = `${path.resolve(repositoryRoot)}\0${target}\0${JSON.stringify(additionalTargets)}`;
    const cached = commandTargetInspectionCache.get(cacheKey);
    if (cached && cached.files.every(({ file, relativePath, signature, indexDigest }) =>
    {
        try
        {
            const stat = fs.lstatSync(file);
            const index = repositoryIndexBytes(repositoryRoot, relativePath);
            const currentIndexDigest = index.bytes ? digestBytes(index.bytes) : null;
            return `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` === signature
                && currentIndexDigest === indexDigest;
        }
        catch
        {
            return false;
        }
    }))
    {
        return structuredClone(cached.result);
    }
    const errors = [];
    const inspected = new Map();
    const inspectedFiles = [];
    const visit = (relativePath) =>
    {
        if (inspected.has(relativePath))
        {
            return;
        }
        const file = inspectRegularRepositoryFile(repositoryRoot, relativePath);
        errors.push(...file.errors.map((error) => `${relativePath}: ${error}`));
        if (!file.resolvedPath)
        {
            return;
        }
        const source = fs.readFileSync(file.resolvedPath);
        const stat = fs.lstatSync(file.resolvedPath);
        const index = repositoryIndexBytes(repositoryRoot, relativePath);
        const contentDigest = digestBytes(source);
        const indexDigest = index.bytes ? digestBytes(index.bytes) : null;
        if (index.indexedRepository && !index.bytes)
        {
            errors.push(`${relativePath} is absent from the repository index`);
        }
        else if (index.indexedRepository && indexDigest !== contentDigest)
        {
            errors.push(`${relativePath} working-tree bytes differ from the repository index`);
        }
        inspectedFiles.push({
            file: file.resolvedPath,
            relativePath,
            signature: `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
            indexDigest
        });
        inspected.set(relativePath, { contentDigest, indexDigest });
        const sourceText = source.toString('utf8');
        if (
            relativePath !== releaseFinalizerCommand
            && relativePath.endsWith('.sh')
            && sourceText.includes(releaseFinalizerCommand)
        )
        {
            errors.push(`${relativePath} contains an indirect release-final wrapper reference`);
        }
        let dependencies;
        try
        {
            dependencies = localDependencyReferences(repositoryRoot, relativePath, sourceText);
        }
        catch (error)
        {
            errors.push(`${relativePath}: ${error.message}`);
            return;
        }
        for (const dependency of dependencies)
        {
            visit(dependency);
        }
    };
    visit(target);
    for (const child of additionalTargets)
    {
        visit(child);
    }
    const targetIdentity = inspected.get(target) ?? null;
    const contentDigest = targetIdentity?.contentDigest ?? null;
    const indexDigest = targetIdentity?.indexDigest ?? null;
    const dependencyClosure = [...inspected.entries()]
        .filter(([dependency]) => dependency !== target)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dependency, dependencyIdentity]) => ({
            path: dependency,
            contentDigest: dependencyIdentity.contentDigest,
            indexDigest: dependencyIdentity.indexDigest
        }));
    const result = { errors, target, contentDigest, indexDigest, dependencyClosure };
    if (errors.length === 0 && inspectedFiles.length > 0)
    {
        commandTargetInspectionCache.set(cacheKey, { files: inspectedFiles, result });
    }
    else
    {
        commandTargetInspectionCache.delete(cacheKey);
    }
    return structuredClone(result);
}

// This is a source declaration projection, not execution or an authority grant.
export function executionAuthorityDeclarationProjection(matrix)
{
    const byTarget = new Map();
    for (const tier of matrix.tiers ?? [])
    {
        const execution = validateDeclarativeExecution(tier.command);
        if (execution.error)
        {
            throw new Error(`${tier.id}: ${execution.error}`);
        }
        if (!execution.target)
        {
            continue;
        }
        const declarations = byTarget.get(execution.target) ?? [];
        declarations.push({ owner: tier.id, commandKind: tier.commandKind ?? null,
            executionMode: tier.executionMode ?? null, executableKind: execution.executableKind, argv: execution.argv });
        byTarget.set(execution.target, declarations);
    }
    return [...byTarget].sort(([left], [right]) => left.localeCompare(right))
        .map(([target, declarations]) => ({ target, declarations: declarations.sort((left, right) => left.owner.localeCompare(right.owner)) }));
}

function buildExecutionTargetAuthority(tierExecutions, repositoryRoot = root, { complete = true } = {})
{
    const targetDeclarations = new Map();
    for (const { tier, execution } of tierExecutions)
    {
        if (execution.error || !execution.target)
        {
            continue;
        }
        if (!targetDeclarations.has(execution.target))
        {
            targetDeclarations.set(execution.target, []);
        }
        targetDeclarations.get(execution.target).push({
            owner: tier?.id ?? '<missing-id>',
            commandKind: tier?.commandKind ?? null,
            executionMode: tier?.executionMode ?? null,
            executableKind: execution.executableKind,
            argv: execution.argv
        });
    }
    const errors = [];
    const closureFiles = new Map();
    const targets = [...targetDeclarations.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, declarations]) =>
        {
            const isSourceGovernance = target === sourceGovernanceExecutionTarget;
            if (isSourceGovernance && (declarations.length !== 1 || declarations[0].owner !== 'source-governance'))
            {
                throw new Error('source governance child execution requires its sole declared owner');
            }
            const inspection = inspectReleaseFinalCommandTarget({ repositoryRoot, target,
                additionalTargets: isSourceGovernance ? [...sourceGovernanceExecutableEntries(), ...sourceGovernanceDataInputs] : [] });
            errors.push(...inspection.errors);
            for (const dependency of inspection.dependencyClosure)
            {
                const existingIdentity = closureFiles.get(dependency.path);
                if (
                    existingIdentity
                    && (
                        existingIdentity.contentDigest !== dependency.contentDigest
                        || existingIdentity.indexDigest !== dependency.indexDigest
                    )
                )
                {
                    errors.push(`${dependency.path} produced conflicting dependency closure digests`);
                }
                closureFiles.set(dependency.path, {
                    contentDigest: dependency.contentDigest,
                    indexDigest: dependency.indexDigest
                });
            }
            return {
                target,
                owners: declarations.map(({ owner }) => owner).sort(),
                declarations: declarations.sort((left, right) => left.owner.localeCompare(right.owner)),
                contentDigest: inspection.contentDigest,
                indexDigest: inspection.indexDigest,
                dependencyClosure: inspection.dependencyClosure.map((dependency) => dependency.path)
            };
        });
    let sourceIndex = null;
    let sourceIndexBytes = null;
    try
    {
        sourceIndexBytes = fs.readFileSync(path.join(repositoryRoot, executionAuthorityIndexPath));
        sourceIndex = JSON.parse(sourceIndexBytes.toString('utf8'));
    }
    catch
    {
        errors.push('independent release-final execution authority index is missing or invalid');
    }
    const declarationProjection = targets.map(({ target, declarations }) => ({ target, declarations }));
    if (sourceIndex)
    {
        if (
            sourceIndex.schema !== 'fsusblog.release-final-execution-authority-index.v1'
            || sourceIndex.matrix !== 'tests/matrix.yml'
            || sourceIndex.authoritySchema !== 'fsusblog.release-final-execution-target-authority.v2'
            || sourceIndex.producer
                !== 'node tools/test-matrix/generate-release-final-execution-authority.mjs'
        )
        {
            errors.push('independent release-final execution authority index metadata is invalid');
        }
        if (JSON.stringify(sourceIndex.nodeParserIdentity) !== JSON.stringify(nodeParserIdentity))
        {
            errors.push('independent release-final Node parser identity drifted');
        }
        const declarationsDigest = digestBytes(JSON.stringify(declarationProjection));
        if (complete && sourceIndex.declarationsDigest !== declarationsDigest)
        {
            errors.push(
                'independent release-final execution declaration index drifted: '
                + `expected=${sourceIndex.declarationsDigest} actual=${declarationsDigest}`
            );
        }
        const targetPathsDigest = digestBytes(JSON.stringify(
            targets.map(({ target }) => target)
        ));
        if (complete && sourceIndex.targetPathsDigest !== targetPathsDigest)
        {
            errors.push(
                'independent release-final execution target-path index drifted: '
                + `expected=${sourceIndex.targetPathsDigest} actual=${targetPathsDigest}`
            );
        }
    }
    const authority = {
        schema: 'fsusblog.release-final-execution-target-authority.v2',
        source: 'tests/matrix.yml',
        sourceIndex: executionAuthorityIndexPath,
        sourceIndexDigest: sourceIndexBytes ? digestBytes(sourceIndexBytes) : null,
        producer: 'node tools/test-matrix/generate-release-final-execution-authority.mjs',
        nodeParserIdentity,
        closureFiles: [...closureFiles.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([dependencyPath, identity]) => ({
                path: dependencyPath,
                contentDigest: identity.contentDigest,
                indexDigest: identity.indexDigest
            })),
        targets
    };
    return {
        authority,
        digest: digestBytes(JSON.stringify(authority)),
        errors
    };
}

export function writeReleaseFinalExecutionAuthority(repositoryRoot = root)
{
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const tierExecutions = matrix.tiers.map((tier) => ({
        tier,
        execution: validateDeclarativeExecution(tier.command)
    }));
    const declarationErrors = tierExecutions
        .filter(({ execution }) => execution.error)
        .map(({ tier, execution }) => `${tier.id}: ${execution.error}`);
    const targetAuthority = buildExecutionTargetAuthority(tierExecutions, repositoryRoot);
    const errors = [...declarationErrors, ...targetAuthority.errors];
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    const output = path.join(
        repositoryRoot,
        'tests/fixtures/test-matrix/release-final-execution-target-authority.json'
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(targetAuthority.authority, null, 4)}\n`);
}

function executionTargetAuthorityDifferences(expected, actual)
{
    const errors = [];
    const expectedTargets = new Map(
        (expected?.targets ?? []).map((entry) => [entry.target, entry])
    );
    const actualTargets = new Map(
        (actual?.targets ?? []).map((entry) => [entry.target, entry])
    );
    for (const [target, actualEntry] of actualTargets)
    {
        const expectedEntry = expectedTargets.get(target);
        if (!expectedEntry)
        {
            errors.push(
                `execution target ${target} is outside the finite authority for owners ${actualEntry.owners.join(', ')}`
            );
        }
        else if (JSON.stringify(actualEntry.owners) !== JSON.stringify(expectedEntry.owners))
        {
            errors.push(
                `execution target ${target} owner drift: expected ${expectedEntry.owners.join(', ')}; `
                + `got ${actualEntry.owners.join(', ')}`
            );
        }
        else if (JSON.stringify(actualEntry.declarations) !== JSON.stringify(expectedEntry.declarations))
        {
            errors.push(
                `execution target ${target} exact command argv, command kind, or execution mode drifted`
            );
        }
    }
    for (const target of expectedTargets.keys())
    {
        if (!actualTargets.has(target))
        {
            errors.push(`finite execution target ${target} is missing`);
        }
    }
    return errors;
}

function validateScriptSource(scriptSource)
{
    const errors = [];
    if (typeof scriptSource !== 'string' || scriptSource.length === 0)
    {
        return ['release-final script source must be a non-empty string'];
    }

    if (digestBytes(scriptSource) !== requiredReleaseFinalizerDigest)
    {
        errors.push(
            'release-final exact required control-flow owner digest drifted: '
            + `expected ${requiredReleaseFinalizerDigest}; got ${digestBytes(scriptSource)}`
        );
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
        line.trim() === 'exec "$NODE_FD_PATH" "$ROOT_DIR/tools/release/check-release-final.mjs" "${releaseFinalArgs[@]}"'
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

export function validateApplicableExecutionAuthority(actual, expected, selectedOwnerIds, requiredTargetOwners)
{
    const errors = [];
    if (!(selectedOwnerIds instanceof Set))
    {
        return ['applicable execution requires independently selected tier owners'];
    }
    if (!Array.isArray(requiredTargetOwners))
    {
        return ['applicable execution requires the independently declared target/owner roster'];
    }
    const requiredTargets = (expected.targets ?? []).filter(target => target.owners.some(owner => selectedOwnerIds.has(owner)));
    const expectedRoster = requiredTargets.map(target => ({ target: target.target, owners: target.owners.filter(owner => selectedOwnerIds.has(owner)).sort() }));
    const actualRoster = (actual.targets ?? []).map(target => ({ target: target.target, owners: [...target.owners].sort() }));
    if (JSON.stringify(actualRoster) !== JSON.stringify(requiredTargetOwners)
        || JSON.stringify(expectedRoster) !== JSON.stringify(requiredTargetOwners))
    {
        errors.push('applicable execution target and selected owner roster is incomplete or changed');
    }
    for (const [label, rows, key] of [['expected targets', expected.targets ?? [], 'target'], ['actual targets', actual.targets ?? [], 'target'], ['expected files', expected.closureFiles ?? [], 'path'], ['actual files', actual.closureFiles ?? [], 'path']])
    {
        if (new Set(rows.map(row => row[key])).size !== rows.length)
        {
            errors.push(`duplicate ${label} in execution authority`);
        }
    }
    const header = value => Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['targets', 'closureFiles'].includes(key)));
    if (JSON.stringify(header(actual)) !== JSON.stringify(header(expected)))
    {
        errors.push('applicable execution authority schema, source index or parser identity drifted');
    }
    const expectedTargets = new Map((expected.targets ?? [])
        .map(target => [target.target, target]));
    const expectedFiles = new Map((expected.closureFiles ?? [])
        .map(file => [file.path, file]));
    const actualFiles = new Set((actual.closureFiles ?? []).map(file => file.path));
    for (const target of actual.targets)
    {
        for (const dependency of target.dependencyClosure ?? [])
        {
            if (!actualFiles.has(dependency))
            {
                errors.push(`missing applicable execution dependency: ${dependency}`);
            }
        }
        const expected = expectedTargets.get(target.target);
        const owners = selectedOwnerIds;
        const applicableExpected = expected && { ...expected,
            owners: expected.owners.filter(owner => owners.has(owner)),
            declarations: expected.declarations.filter(declaration => owners.has(declaration.owner)) };
        if (JSON.stringify(target) !== JSON.stringify(applicableExpected))
        {
            errors.push(`applicable execution target authority drifted: ${target.target}`);
        }
    }
    for (const file of actual.closureFiles)
    {
        if (JSON.stringify(file) !== JSON.stringify(expectedFiles.get(file.path)))
        {
            errors.push(`applicable execution dependency authority drifted: ${file.path}`);
        }
    }
    return errors;
}

export function validateReleaseFinalStaticBoundary({ matrix, scriptSource, repositoryRoot = root,
    declarationsOnly = false, selectedTierIds = null })
{
    const errors = validateScriptSource(scriptSource);
    if (selectedTierIds !== null)
    {
        const declaredIds = new Set((matrix?.tiers ?? []).map(tier => tier.id));
        if (!(selectedTierIds instanceof Set) || declarationsOnly)
        {
            return [...errors, 'applicable execution requires an explicit tier set after declaration validation'];
        }
        for (const id of selectedTierIds)
        {
            if (!declaredIds.has(id))
            {
                errors.push(`unknown applicable execution tier: ${id}`);
            }
        }
    }
    const plan = buildReleaseFinalizerPlan(matrix);
    errors.push(...plan.errors.map((error) => `execution graph: ${error}`));

    const tierExecutions = (matrix?.tiers ?? []).map((tier) => ({
        tier,
        execution: validateDeclarativeExecution(tier?.command)
    }));
    const invalidTierExecutions = tierExecutions.filter(({ execution }) => execution.error);
    for (const { tier, execution } of invalidTierExecutions)
    {
        errors.push(
            `execution declaration ${tier?.id ?? '<missing-id>'} is outside the sealed argv grammar: ${execution.error}`
        );
    }
    if (invalidTierExecutions.length === 0 && !declarationsOnly)
    {
        const applicableExecutions = selectedTierIds === null ? tierExecutions
            : tierExecutions.filter(({ tier }) => selectedTierIds.has(tier.id));
        const targetAuthority = buildExecutionTargetAuthority(applicableExecutions, repositoryRoot,
            { complete: selectedTierIds === null });
        errors.push(...targetAuthority.errors.map((error) => `execution target authority: ${error}`));
        let expectedTargetAuthority;
        try
        {
            expectedTargetAuthority = JSON.parse(fs.readFileSync(
                path.join(
                    repositoryRoot,
                    'tests/fixtures/test-matrix/release-final-execution-target-authority.json'
                ),
                'utf8'
            ));
        }
        catch
        {
            errors.push('execution target authority fixture is missing or invalid');
        }
        if (selectedTierIds !== null && expectedTargetAuthority)
        {
            const targetOwners = new Map();
            for (const { tier, execution } of applicableExecutions)
            {
                if (execution.target)
                {
                    const owners = targetOwners.get(execution.target) ?? [];
                    owners.push(tier.id);
                    targetOwners.set(execution.target, owners);
                }
            }
            const requiredTargetOwners = [...targetOwners].sort(([left], [right]) => left.localeCompare(right))
                .map(([target, owners]) => ({ target, owners: owners.sort() }));
            errors.push(...validateApplicableExecutionAuthority(targetAuthority.authority, expectedTargetAuthority, selectedTierIds, requiredTargetOwners));
        }
        else if (
            expectedTargetAuthority
            && JSON.stringify(targetAuthority.authority) !== JSON.stringify(expectedTargetAuthority)
        )
        {
            errors.push(...executionTargetAuthorityDifferences(
                expectedTargetAuthority,
                targetAuthority.authority
            ));
            errors.push(
                'execution target authority owner, content, or dependency closure drifted: '
                + `expected ${digestBytes(JSON.stringify(expectedTargetAuthority))}; got ${targetAuthority.digest}`
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

export function validateRepositoryReleaseFinalStaticBoundary(repositoryRoot = root)
{
    const repositoryMatrixFile = path.join(repositoryRoot, 'tests/matrix.yml');
    const repositoryFinalizerFile = path.join(repositoryRoot, releaseFinalizerCommand);
    const requiredFiles = [
        repositoryMatrixFile,
        repositoryFinalizerFile,
        path.join(
            repositoryRoot,
            'tests/fixtures/test-matrix/release-final-execution-target-authority.json'
        )
    ];
    const isCanonicalRepository = fs.existsSync(path.join(repositoryRoot, 'AGENTS.md'));
    if (!isCanonicalRepository && !requiredFiles.every((file) => fs.existsSync(file)))
    {
        return [];
    }
    const missing = requiredFiles.filter((file) => !fs.existsSync(file));
    if (missing.length > 0)
    {
        return missing.map((file) => (
            `production release-final static boundary file is missing: ${path.relative(repositoryRoot, file)}`
        ));
    }
    try
    {
        return validateReleaseFinalStaticBoundary({
            matrix: parseMatrix(fs.readFileSync(repositoryMatrixFile, 'utf8')),
            scriptSource: fs.readFileSync(repositoryFinalizerFile, 'utf8'),
            repositoryRoot
        });
    }
    catch (error)
    {
        return [`production release-final static boundary could not be evaluated: ${error.message}`];
    }
}

export function buildReleaseFinalizerSpawnDecision({
    sealState,
    boundaryErrors = [],
    authorityDigest = null
})
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
    if (sealState === 'accepted' && !/^sha256:[0-9a-f]{64}$/u.test(authorityDigest ?? ''))
    {
        failureReasons.push('release-final accepted seal authority digest is missing or invalid');
    }
    const eligible = sealState === 'accepted' && failureReasons.length === 0;
    const schema = releaseFinalizerDecisionSchema;
    const spawnCount = eligible ? 1 : 0;
    return {
        schema,
        sealState,
        eligible,
        spawnCount,
        shellToken: eligible
            ? `${schema}|${sealState}|${spawnCount}|${authorityDigest}`
            : `${schema}|${sealState}|${spawnCount}`,
        failureReasons
    };
}

export function applyReleaseFinalizerSpawnDecision(
    tier,
    environment,
    {
        repositoryRoot = root,
        spawnSeal = null,
        spawnSealAuthority = null,
        requireEligible = false
    } = {}
)
{
    const sealedEnvironment = { ...environment };
    if (tier?.id !== 'release-final')
    {
        return sealedEnvironment;
    }
    let sealState = 'missing';
    const pathBindings = [
        ['current-run context', sealedEnvironment.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT],
        ['authority binding inputs', sealedEnvironment.FSUSBLOG_RELEASE_FINAL_BINDING_INPUTS_PATH],
        ['final output reference', sealedEnvironment.FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH],
        ['final output handoff', sealedEnvironment.FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_HANDOFF_PATH],
        ['committed checkpoint', sealedEnvironment.FSUSBLOG_RELEASE_FINAL_COMMITTED_CHECKPOINT]
    ];
    const boundaryErrors = [];
    if (String(sealedEnvironment.FSUSBLOG_RELEASE_FINAL_SEAL_STATE ?? '').trim())
    {
        boundaryErrors.push('ambient release-final seal state is forbidden');
    }
    if (String(sealedEnvironment.FSUSBLOG_NODE ?? '').trim())
    {
        boundaryErrors.push('ambient FSUSBLOG_NODE override is forbidden');
    }
    let authorityDigest = null;
    if (spawnSeal || spawnSealAuthority)
    {
        try
        {
            verifyReleaseFinalSpawnSeal(spawnSeal, spawnSealAuthority);
            authorityDigest = spawnSeal.contentDigest;
            sealState = 'accepted';
        }
        catch (error)
        {
            sealState = 'failed';
            boundaryErrors.push(`release-final spawn seal verification failed: ${error.message}`);
        }
    }
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
    const nodeRealPath = fs.realpathSync(process.execPath);
    const nodeStat = fs.lstatSync(nodeRealPath);
    const nodeVersion = execFileSync(nodeRealPath, ['--version'], { encoding: 'utf8' }).trim();
    if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || nodeVersion !== process.version)
    {
        boundaryErrors.push('scheduler Node toolchain identity is not a regular exact-version executable');
    }
    const nodeDigest = digestBytes(fs.readFileSync(nodeRealPath));
    const decision = buildReleaseFinalizerSpawnDecision({
        sealState,
        boundaryErrors,
        authorityDigest
    });
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION = decision.shellToken;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_SPAWN_SEAL_DIGEST = authorityDigest ?? '';
    delete sealedEnvironment.FSUSBLOG_RELEASE_FINAL_SEAL_STATE;
    delete sealedEnvironment.FSUSBLOG_NODE;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_BIN = nodeRealPath;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_REALPATH = nodeRealPath;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_SHA256 = nodeDigest;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_VERSION = nodeVersion;
    if (requireEligible && !decision.eligible)
    {
        throw new Error(
            `release-final spawn rejected before child creation: ${decision.failureReasons.join('; ')}`
        );
    }
    return sealedEnvironment;
}

function main()
{
    const mode = process.argv[2] ?? '--check';
    if (mode !== '--check' || process.argv.length > 3)
    {
        throw new Error('usage: node tools/test-matrix/release-final-static-boundary.mjs --check');
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

export function validateSourceGovernanceChildExecution(inspection, authority, entry)
{
    const errors = [...(inspection.errors ?? [])];
    if (!sourceGovernanceExecutableEntries().includes(entry) || inspection.target !== entry)
    {
        return [...errors, 'unknown source governance child execution'];
    }
    const owners = (authority.targets ?? []).filter(target => target.target === sourceGovernanceExecutionTarget);
    if (owners.length !== 1 || JSON.stringify(owners[0].owners) !== JSON.stringify(['source-governance']))
    {
        return [...errors, 'source governance child execution has no sole current owner'];
    }
    const owner = owners[0];
    for (const child of [...sourceGovernanceExecutableEntries(), ...sourceGovernanceDataInputs])
    {
        if (!owner.dependencyClosure.includes(child))
        {
            errors.push(`source governance execution closure omits child ${child}`);
        }
    }
    const records = [{ path: inspection.target, contentDigest: inspection.contentDigest, indexDigest: inspection.indexDigest },
        ...(inspection.dependencyClosure ?? [])];
    for (const input of sourceGovernanceDataInputs)
    {
        if (records.filter(record => record.path === input).length !== 1)
        {
            errors.push(`source governance child current data input omitted: ${input}`);
        }
    }
    for (const record of records)
    {
        const expected = (authority.closureFiles ?? []).filter(file => file.path === record.path);
        if (!record.contentDigest || !record.indexDigest
            || !owner.dependencyClosure.includes(record.path) || expected.length !== 1
            || expected[0].contentDigest !== record.contentDigest || expected[0].indexDigest !== record.indexDigest)
        {
            errors.push(`source governance child current source/index closure drifted: ${record.path}`);
        }
    }
    return errors;
}
