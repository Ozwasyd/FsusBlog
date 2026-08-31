#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
const executionTargetAuthorityFile = path.join(
    root,
    'tests/fixtures/test-matrix/release-final-execution-target-authority.json'
);
const releaseFinalizerDecisionSchema = 'fsusblog.release-finalizer-spawn-decision.v1';
const commandTargetInspectionCache = new Map();

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
    /^if \[\[ "\$NODE_BIN" != "\$NODE_REALPATH" \|\| "\$\(\$NODE_BIN --version\)" != "\$NODE_VERSION" \]\]; then$/u,
    /^echo "release-final Node toolchain identity drifted" >&2$/u,
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

// This source-owner invariant is intentionally independent of the generated execution-target
// snapshot. Removing or reordering the seal/control-flow cannot be re-admitted by regenerating
// the candidate-owned authority fixture.
const requiredReleaseFinalizerDigest =
    'sha256:78371f755dc64e9917c86b934ddada3c3657f3e5f038af0d7cecac67dad04f10';

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
        if (fs.realpathSync(current) !== current)
        {
            errors.push(`${normalized} path component ${segments.slice(0, index + 1).join('/')} has a nonliteral realpath`);
            return { errors, resolvedPath: null };
        }
    }
    return { errors, resolvedPath: current };
}

function resolveExistingDependency(repositoryRoot, ownerPath, reference)
{
    const normalizedReference = reference.replaceAll('\\', '/');
    const candidate = ['tools/', 'tests/', 'src/'].some((prefix) => normalizedReference.startsWith(prefix))
        ? normalizedReference
        : path.posix.join(path.posix.dirname(ownerPath), normalizedReference);
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

function nodeModuleDependencyReferences(repositoryRoot, ownerPath, source)
{
    const frontendRequire = createRequire(path.join(repositoryRoot, 'src/frontend/package.json'));
    let parse;
    try
    {
        ({ parse } = frontendRequire('@babel/parser'));
    }
    catch (error)
    {
        throw new Error(`@babel/parser is required for recursive Node module authority: ${error.message}`);
    }
    const ast = parse(source, {
        sourceType: 'unambiguous',
        createImportExpressions: true,
        errorRecovery: false,
        plugins: ['typescript', 'jsx', 'importAttributes', 'topLevelAwait']
    });
    const references = new Set();
    const literalValue = (node) => (
        node?.type === 'StringLiteral' || node?.type === 'Literal'
            ? node.value
            : null
    );
    const newUrlReference = (node) =>
    {
        if (node?.type !== 'NewExpression' || node.callee?.type !== 'Identifier' || node.callee.name !== 'URL')
        {
            return null;
        }
        const [reference, base] = node.arguments ?? [];
        const importMeta = base?.type === 'MemberExpression'
            && base.object?.type === 'MetaProperty'
            && base.object.meta?.name === 'import'
            && base.object.property?.name === 'meta'
            && base.property?.type === 'Identifier'
            && base.property.name === 'url';
        return importMeta ? literalValue(reference) : null;
    };
    const visit = (node) =>
    {
        if (!node || typeof node !== 'object')
        {
            return;
        }
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type))
        {
            const reference = literalValue(node.source);
            if (typeof reference === 'string')
            {
                references.add(reference);
            }
        }
        else if (node.type === 'ImportExpression')
        {
            const reference = literalValue(node.source) ?? newUrlReference(node.source);
            if (typeof reference === 'string')
            {
                references.add(reference);
            }
        }
        else if (
            node.type === 'CallExpression'
            && node.callee?.type === 'Identifier'
            && node.callee.name === 'require'
        )
        {
            const reference = literalValue(node.arguments?.[0]);
            if (typeof reference === 'string')
            {
                references.add(reference);
            }
        }
        for (const [key, value] of Object.entries(node))
        {
            if (key === 'loc' || key === 'start' || key === 'end')
            {
                continue;
            }
            if (Array.isArray(value))
            {
                value.forEach(visit);
            }
            else if (value && typeof value === 'object')
            {
                visit(value);
            }
        }
    };
    visit(ast);
    return [...references];
}

function localDependencyReferences(repositoryRoot, ownerPath, source)
{
    const references = new Set();
    const add = (reference) =>
    {
        const resolved = resolveExistingDependency(repositoryRoot, ownerPath, reference);
        if (resolved && resolved !== ownerPath)
        {
            references.add(resolved);
        }
    };
    if (/\.(?:mjs|js|cjs|ts|tsx)$/u.test(ownerPath))
    {
        let moduleReferences;
        try
        {
            moduleReferences = nodeModuleDependencyReferences(repositoryRoot, ownerPath, source);
        }
        catch (error)
        {
            // A syntax-invalid command target cannot execute any dependency. Its exact bytes
            // remain sealed by the target digest; any repair changes that digest and forces
            // a fresh semantic traversal before authority can be regenerated.
            if (error.code === 'BABEL_PARSER_SYNTAX_ERROR')
            {
                moduleReferences = [];
            }
            else
            {
                throw new Error(`${ownerPath}: Node module AST parse failed: ${error.message}`);
            }
        }
        for (const reference of moduleReferences)
        {
            if (reference.startsWith('.') || ['tools/', 'tests/', 'src/'].some((prefix) => reference.startsWith(prefix)))
            {
                add(reference);
            }
        }
    }
    else if (ownerPath.endsWith('.sh'))
    {
        const repositoryPaths = source.matchAll(
            /(?:^|[^A-Za-z0-9_.-])(?<path>(?:tools|tests|src)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|js|cjs|ts|tsx))/gmu
        );
        for (const match of repositoryPaths)
        {
            add(match.groups.path);
        }
        const localFiles = source.matchAll(
            /(?:^|[^A-Za-z0-9_./-])(?<path>[A-Za-z0-9_.-]+\.(?:sh|mjs|js|cjs))(?:$|[^A-Za-z0-9_./-])/gmu
        );
        for (const match of localFiles)
        {
            add(match.groups.path);
        }
    }
    return [...references].sort();
}

export function inspectReleaseFinalCommandTarget({ repositoryRoot = root, target })
{
    const cacheKey = `${path.resolve(repositoryRoot)}\0${target}`;
    const cached = commandTargetInspectionCache.get(cacheKey);
    if (cached && cached.files.every(({ file, signature }) =>
    {
        try
        {
            const stat = fs.lstatSync(file);
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` === signature;
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
        inspectedFiles.push({
            file: file.resolvedPath,
            signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        });
        inspected.set(relativePath, digestBytes(source));
        const sourceText = source.toString('utf8');
        if (
            relativePath !== releaseFinalizerCommand
            && relativePath.endsWith('.sh')
            && sourceText.includes(releaseFinalizerCommand)
        )
        {
            errors.push(`${relativePath} contains an indirect release-final wrapper reference`);
        }
        for (const dependency of localDependencyReferences(repositoryRoot, relativePath, sourceText))
        {
            visit(dependency);
        }
    };
    visit(target);
    const contentDigest = inspected.get(target) ?? null;
    const dependencyClosure = [...inspected.entries()]
        .filter(([dependency]) => dependency !== target)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dependency, dependencyDigest]) => ({
            path: dependency,
            contentDigest: dependencyDigest
        }));
    const result = { errors, target, contentDigest, dependencyClosure };
    commandTargetInspectionCache.set(cacheKey, { files: inspectedFiles, result });
    return structuredClone(result);
}

function buildExecutionTargetAuthority(tierExecutions, repositoryRoot = root)
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
            const inspection = inspectReleaseFinalCommandTarget({ repositoryRoot, target });
            errors.push(...inspection.errors);
            for (const dependency of inspection.dependencyClosure)
            {
                const existingDigest = closureFiles.get(dependency.path);
                if (existingDigest && existingDigest !== dependency.contentDigest)
                {
                    errors.push(`${dependency.path} produced conflicting dependency closure digests`);
                }
                closureFiles.set(dependency.path, dependency.contentDigest);
            }
            return {
                target,
                owners: declarations.map(({ owner }) => owner).sort(),
                declarations: declarations.sort((left, right) => left.owner.localeCompare(right.owner)),
                contentDigest: inspection.contentDigest,
                dependencyClosure: inspection.dependencyClosure.map((dependency) => dependency.path)
            };
        });
    const authority = {
        schema: 'fsusblog.release-final-execution-target-authority.v2',
        source: 'tests/matrix.yml',
        producer: 'node tools/test-matrix/release-final-static-boundary.mjs --write-authority',
        closureFiles: [...closureFiles.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([dependencyPath, contentDigest]) => ({
                path: dependencyPath,
                contentDigest
            })),
        targets
    };
    return {
        authority,
        digest: digestBytes(JSON.stringify(authority)),
        errors
    };
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

export function validateReleaseFinalStaticBoundary({ matrix, scriptSource, repositoryRoot = root })
{
    const errors = validateScriptSource(scriptSource);
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
    if (invalidTierExecutions.length === 0)
    {
        const targetAuthority = buildExecutionTargetAuthority(tierExecutions, repositoryRoot);
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
        if (
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
    if (String(sealedEnvironment.FSUSBLOG_NODE ?? '').trim())
    {
        boundaryErrors.push('ambient FSUSBLOG_NODE override is forbidden');
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
    const decision = buildReleaseFinalizerSpawnDecision({ sealState, boundaryErrors });
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_SPAWN_DECISION = decision.shellToken;
    delete sealedEnvironment.FSUSBLOG_NODE;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_BIN = nodeRealPath;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_REALPATH = nodeRealPath;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_SHA256 = nodeDigest;
    sealedEnvironment.FSUSBLOG_RELEASE_FINAL_NODE_VERSION = nodeVersion;
    return sealedEnvironment;
}

function main()
{
    const mode = process.argv[2] ?? '--check';
    if (!['--check', '--write-authority'].includes(mode) || process.argv.length > 3)
    {
        throw new Error(
            'usage: node tools/test-matrix/release-final-static-boundary.mjs '
            + '[--check|--write-authority]'
        );
    }
    const matrix = parseMatrix(fs.readFileSync(matrixFile, 'utf8'));
    if (mode === '--write-authority')
    {
        const tierExecutions = matrix.tiers.map((tier) => ({
            tier,
            execution: validateDeclarativeExecution(tier.command)
        }));
        const declarationErrors = tierExecutions
            .filter(({ execution }) => execution.error)
            .map(({ tier, execution }) => `${tier.id}: ${execution.error}`);
        const targetAuthority = buildExecutionTargetAuthority(tierExecutions);
        const errors = [...declarationErrors, ...targetAuthority.errors];
        if (errors.length > 0)
        {
            throw new Error(errors.join('\n'));
        }
        fs.mkdirSync(path.dirname(executionTargetAuthorityFile), { recursive: true });
        fs.writeFileSync(
            executionTargetAuthorityFile,
            `${JSON.stringify(targetAuthority.authority, null, 4)}\n`
        );
        console.log('[release-final-static-boundary] wrote execution target authority');
        return;
    }
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
