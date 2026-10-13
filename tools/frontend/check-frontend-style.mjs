#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    reviewedResidualAuthorityPath,
    reviewedResidualConsumptionRequired,
    validateReviewedResidualConsumption,
    validateReviewedResidualDocument
} from './reviewed-residual-classification.mjs';
import { compareSourceUnitFindings } from './source-unit-style-diff.mjs';

const { resolveLocalFsusUiApplicationProject } = await import(
    new URL('../../src/frontend/scripts/run-local-fsusui-typecheck.mjs', import.meta.url)
);
const { resolveLocalFsusUiRepositoryRoot } = await import(
    new URL('../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)
);

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '../..');
const defaultPolicyPath = 'config/development/frontend-style-policy.json';
const policySchema = 'fsusblog.frontend-style-policy.v1';
const registrySchema = 'fsusblog.frontend-style-rule-registry.v1';
const baselineSchema = 'fsusblog.frontend-style-baseline.v1';
const baselineCorrectionSchema = 'fsusblog.frontend-style-baseline-corrections.v1';
const reviewedBaselineAuthorityRef = 'refs/remotes/origin/master';
const validModes = new Set(['changed', 'full', 'strict-full', 'source-diff']);

let root = defaultRoot;
let policy = null;
let policyFile = null;
let typedLintContext = null;
let typedLintSourceSha256 = null;
const failures = [];

function fail(message)
{
    failures.push(`[frontend-style] ${message}`);
}

function parseArgs(argv)
{
    const parsed = { files: [] };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--update-baseline')
        {
            parsed.updateBaseline = true;
            continue;
        }
        if (argument === '--fix')
        {
            parsed.fix = true;
            continue;
        }
        if (argument === '--prune-removed-baseline-paths')
        {
            parsed.pruneRemovedBaselinePaths = true;
            continue;
        }
        if (![
            '--root',
            '--policy',
            '--mode',
            '--base',
            '--file',
            '--migrate-baseline-configuration',
            '--migrate-baseline-paths',
            '--reviewed-baseline-correction',
            '--reviewed-residual-classification'
        ].includes(argument))
        {
            throw new Error(`unknown argument ${argument}`);
        }
        const value = argv[index + 1];
        if (!value)
        {
            throw new Error(`${argument} requires a value`);
        }
        if (argument === '--file')
        {
            parsed.files.push(value);
        }
        else if (argument === '--migrate-baseline-configuration')
        {
            parsed.migrateBaselineConfiguration = value;
        }
        else if (argument === '--migrate-baseline-paths')
        {
            parsed.migrateBaselinePaths = value;
        }
        else if (argument === '--reviewed-baseline-correction')
        {
            parsed.reviewedBaselineCorrection = value;
        }
        else if (argument === '--reviewed-residual-classification')
        {
            parsed.reviewedResidualClassification = value;
        }
        else
        {
            parsed[argument.slice(2)] = value;
        }
        index += 1;
    }
    return parsed;
}

function toPosix(value)
{
    return value.replaceAll(path.sep, '/');
}

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function gitBlobDigest(value)
{
    return crypto.createHash('sha1')
        .update(`blob ${value.length}\0`)
        .update(value)
        .digest('hex');
}

function compareOrdinal(left, right)
{
    return left === right ? 0 : left < right ? -1 : 1;
}

function exactObjectKeys(value, expected)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    return JSON.stringify(Object.keys(value).sort(compareOrdinal))
        === JSON.stringify([...expected].sort(compareOrdinal));
}

function normalizedRules(value)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return null;
    }
    const entries = Object.entries(value).sort(([left], [right]) => compareOrdinal(left, right));
    if (entries.some(([rule, count]) => !rule || !Number.isInteger(count) || count <= 0))
    {
        return null;
    }
    return Object.fromEntries(entries);
}

function ruleCount(rules)
{
    return Object.values(rules).reduce((sum, count) => sum + count, 0);
}

function readJson(file, label)
{
    if (!fs.existsSync(file))
    {
        fail(`missing ${label}`);
        return null;
    }
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        fail(`invalid JSON ${label}: ${error.message}`);
        return null;
    }
}

function command(args, { allowFailure = false, environment = {} } = {})
{
    const result = spawnSync(args[0], args.slice(1), {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...environment },
        maxBuffer: 256 * 1024 * 1024
    });
    if (result.error)
    {
        throw result.error;
    }
    if (!allowFailure && result.status !== 0)
    {
        throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
}

function normalizeFile(value)
{
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    const relative = toPosix(path.relative(root, absolute));
    if (relative === '..' || relative.startsWith('../'))
    {
        throw new Error(`file is outside repository root: ${value}`);
    }
    return relative;
}

function globToRegExp(pattern)
{
    let source = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    source = source.replaceAll('**', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '.*');
    return new RegExp(`^${source}`, 'u');
}

function makeExclusionMatchers()
{
    return policy.excludedPaths.map((entry) => entry.includes('*')
        ? globToRegExp(entry)
        : { test: (file) => file.startsWith(entry) });
}

function isExcluded(file, matchers)
{
    return matchers.some((matcher) => matcher.test(file))
        || policy.excludedSuffixes.some((suffix) => file.endsWith(suffix));
}

function sourceSetMatches(file, sourceSet)
{
    const prefix = sourceSet.root.endsWith('/') ? sourceSet.root : `${sourceSet.root}/`;
    return file.startsWith(prefix) && sourceSet.extensions.includes(path.extname(file));
}

function toolKinds(file)
{
    const kinds = [];
    if (policy.eslintSourceSets.some((sourceSet) => sourceSetMatches(file, sourceSet)))
    {
        kinds.push('eslint');
    }
    if (policy.stylelintSourceSets.some((sourceSet) => sourceSetMatches(file, sourceSet)))
    {
        kinds.push('stylelint');
    }
    return kinds;
}

function walkFiles(directory, output = [])
{
    if (!fs.existsSync(directory))
    {
        return output;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            if (['.git', '.tmp', 'artifacts', 'coverage', 'dist', 'node_modules'].includes(entry.name))
            {
                continue;
            }
            walkFiles(absolute, output);
        }
        else if (entry.isFile())
        {
            output.push(toPosix(path.relative(root, absolute)));
        }
    }
    return output;
}

function allRepositoryFiles()
{
    const result = command(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { allowFailure: true });
    if (result.status === 0)
    {
        return result.stdout.split(/\r?\n/u).filter(Boolean).map(toPosix);
    }
    return walkFiles(root);
}

function changedFiles(base)
{
    const files = new Set();
    const diff = command(['git', 'diff', '--name-only', '--diff-filter=ACMR', base, '--'], { allowFailure: true });
    if (diff.status !== 0)
    {
        fail(`cannot resolve changed-file base ${base}: ${(diff.stderr || diff.stdout).trim()}`);
    }
    else
    {
        for (const file of diff.stdout.split(/\r?\n/u))
        {
            if (file)
            {
                files.add(toPosix(file));
            }
        }
    }
    const untracked = command(['git', 'ls-files', '--others', '--exclude-standard'], { allowFailure: true });
    if (untracked.status === 0)
    {
        for (const file of untracked.stdout.split(/\r?\n/u))
        {
            if (file)
            {
                files.add(toPosix(file));
            }
        }
    }
    return [...files];
}

function selectFiles(args)
{
    const exclusions = makeExclusionMatchers();
    let candidates;
    if (args.files.length > 0)
    {
        candidates = args.files.map(normalizeFile);
    }
    else if (args.mode === 'full' || args.mode === 'strict-full' || args.updateBaseline)
    {
        candidates = allRepositoryFiles();
    }
    else
    {
        candidates = changedFiles(args.base ?? policy.modes.changedDefaultBase);
    }
    return [...new Set(candidates)]
        .filter((file) => fs.existsSync(path.join(root, file)))
        .filter((file) => !isExcluded(file, exclusions) && toolKinds(file).length > 0)
        .sort();
}

function makeViolation(tool, file, message)
{
    const normalizedMessage = String(message.message ?? message.text ?? '').replace(/\s+/gu, ' ').trim();
    const rule = message.ruleId ?? message.rule ?? 'parse-error';
    const line = Number(message.line ?? 1);
    const column = Number(message.column ?? 1);
    const endLine = Number(message.endLine ?? line);
    const endColumn = Number(message.endColumn ?? column);
    return {
        id: `${tool}:${rule}:${file}:${line}:${column}:${sha256(normalizedMessage).slice(0, 16)}`,
        tool,
        file,
        line,
        column,
        endLine,
        endColumn,
        rule,
        message: normalizedMessage,
        fixable: Boolean(message.fix || message.replacements?.length)
    };
}

function parseToolJson(result, tool)
{
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    const payload = stdout || (/^[{[]/u.test(stderr) ? stderr : '');
    if (!payload)
    {
        fail(`${tool} did not return JSON: ${(stderr || `exit ${result.status}`).slice(0, 2000)}`);
        return [];
    }
    try
    {
        return JSON.parse(payload);
    }
    catch (error)
    {
        fail(`${tool} returned invalid JSON: ${error.message}; ${stderr.slice(0, 2000)}`);
        return [];
    }
}

function runEslint(files, fix)
{
    if (files.length === 0)
    {
        return [];
    }
    const executable = path.join(root, policy.toolchain.eslint);
    // External source types can change without a Blog source edit. Recheck the local program;
    // registry-installed mode retains its existing content cache.
    const localApplicationProject = typedLintContext
        ? typedLintContext.project
        : resolveLocalFsusUiApplicationProject({ repositoryRoot: root });
    const cache = path.join(root, '.tmp/frontend-style/eslint.cache');
    const cacheKeyFile = path.join(root, '.tmp/frontend-style/eslint.cache-key');
    const cacheKey = sha256(`${configurationDigest()}\n${sourceStateDigest()}`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const previousCacheKey = fs.existsSync(cacheKeyFile)
        ? fs.readFileSync(cacheKeyFile, 'utf8').trim()
        : '';
    if (previousCacheKey !== cacheKey)
    {
        fs.rmSync(cache, { force: true });
        fs.writeFileSync(cacheKeyFile, `${cacheKey}\n`);
    }
    const args = [
        executable,
        '--config', path.join(root, policy.eslintConfig),
        '--format', 'json',
        '--no-error-on-unmatched-pattern',
        '--no-warn-ignored'
    ];
    if (!localApplicationProject)
    {
        args.push('--cache', '--cache-location', cache, '--cache-strategy', 'content');
    }
    if (fix)
    {
        args.push('--fix');
    }
    args.push(...files);
    const result = command(args, {
        allowFailure: true,
        environment: {
            FSUSBLOG_STYLE_ROOT: root,
            ...(typedLintContext ? {
                FSUSBLOG_USE_LOCAL_FSUSUI: localApplicationProject ? '1' : '0',
                FSUSBLOG_LOCAL_FSUSUI_ROOT: typedLintContext.localRoot ?? '',
                FSUSBLOG_STYLE_APPLICATION_PROJECT: localApplicationProject ?? ''
            } : {})
        }
    });
    if (![0, 1].includes(result.status))
    {
        fail(`eslint execution failed with exit ${result.status}: ${(result.stderr || result.stdout).trim()}`);
        return [];
    }
    const reports = parseToolJson(result, 'eslint');
    const violations = [];
    for (const report of reports)
    {
        const file = normalizeFile(report.filePath);
        for (const message of report.messages ?? [])
        {
            violations.push(makeViolation('eslint', file, message));
        }
    }
    return violations;
}

function runStylelint(files, fix)
{
    if (files.length === 0)
    {
        return [];
    }
    const executable = path.join(root, policy.toolchain.stylelint);
    const args = [
        executable,
        '--config', path.join(root, policy.stylelintConfig),
        '--formatter', 'json',
        '--allow-empty-input'
    ];
    if (fix)
    {
        args.push('--fix');
    }
    args.push(...files);
    const result = command(args, { allowFailure: true });
    if (![0, 2].includes(result.status))
    {
        fail(`stylelint execution failed with exit ${result.status}: ${(result.stderr || result.stdout).trim()}`);
        return [];
    }
    const reports = parseToolJson(result, 'stylelint');
    const violations = [];
    for (const report of reports)
    {
        const file = normalizeFile(report.source);
        for (const warning of report.warnings ?? [])
        {
            violations.push(makeViolation('stylelint', file, warning));
        }
        for (const warning of report.invalidOptionWarnings ?? [])
        {
            violations.push(makeViolation('stylelint', file, {
                rule: 'invalid-option',
                text: warning.text ?? String(warning)
            }));
        }
        for (const parseError of report.parseErrors ?? [])
        {
            violations.push(makeViolation('stylelint', file, {
                rule: 'parse-error',
                line: parseError.line,
                column: parseError.column,
                text: parseError.text ?? String(parseError)
            }));
        }
    }
    return violations;
}

function resolveTypedLintContext()
{
    const project = resolveLocalFsusUiApplicationProject({ repositoryRoot: root });
    if (!project)
    {
        return { project: null, localRoot: null, selection: 'registry' };
    }
    const localRoot = fs.realpathSync(resolveLocalFsusUiRepositoryRoot({
        repositoryRoot: root, override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
    }));
    // Anchor selection to the primary checkout, so worktree and machine prefixes
    // are not baseline identities. Only the selected source root participates.
    const common = command(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFailure: true });
    const anchor = common.status === 0 ? path.dirname(common.stdout.trim()) : root;
    return { project, localRoot, selection: `local:${toPosix(path.relative(fs.realpathSync(anchor), localRoot))}` };
}

function typedLintSourceDigest(context = typedLintContext)
{
    if (!context?.localRoot)
    {
        return sha256('registry');
    }
    const inputs = [];
    const scope = policy.typedLintInputs;
    function visit(directory, ancestors = new Set())
    {
        const realDirectory = fs.realpathSync(directory);
        if (ancestors.has(realDirectory))
        {
            throw new Error('local typed lint source contains a directory cycle');
        }
        const nextAncestors = new Set([...ancestors, realDirectory]);
        for (const name of fs.readdirSync(directory).sort(compareOrdinal))
        {
            if (scope.excludedDirectories.includes(name))
            {
                continue;
            }
            const file = path.join(directory, name);
            const stat = fs.statSync(file);
            if (stat.isDirectory())
            {
                visit(file, nextAncestors);
            }
            else if (stat.isFile() && scope.extensions.includes(path.extname(file)))
            {
                inputs.push(`${toPosix(path.relative(context.localRoot, file))}\n${sha256(fs.readFileSync(file))}`);
            }
        }
    }
    visit(path.join(context.localRoot, scope.localFsusUiRoot));
    const packageFile = path.join(context.localRoot, 'package.json');
    inputs.push(`package.json\n${fs.existsSync(packageFile) ? sha256(fs.readFileSync(packageFile)) : 'absent'}`);
    return sha256(inputs.sort(compareOrdinal).join('\n'));
}

function requireCurrentTypedLintInputs()
{
    const current = resolveTypedLintContext();
    if (current.selection !== typedLintContext.selection
        || typedLintSourceDigest(current) !== typedLintSourceSha256)
    {
        throw new Error('typed lint inputs changed during the scan; refusing baseline consumption or update');
    }
}

function configurationDigest()
{
    const paths = [
        policyFile,
        path.join(root, policy.ruleRegistry),
        path.join(root, policy.toolchain.package),
        path.join(root, policy.toolchain.lock),
        ...policy.configurationSources.map((file) => path.join(root, file))
    ];
    const sources = paths.map((file) => `${toPosix(path.relative(root, file))}\n${sha256(fs.readFileSync(file))}`);
    sources.push(`runtime\nnode=${process.version}\nplatform=${process.platform}\narch=${process.arch}`);
    if (typedLintContext)
    {
        sources.push(`typed-lint-selection\n${typedLintContext.selection}`);
    }
    return sha256(sources.join('\n'));
}

function sourceStateDigest()
{
    const typedInputs = typedLintContext ? `typed-lint-source\n${typedLintSourceDigest()}\n` : '';
    const files = allRepositoryFiles()
        .filter((file) => file !== policy.baseline)
        .filter((file) => fs.existsSync(path.join(root, file)))
        .sort();
    const repositoryRoot = command(['git', 'rev-parse', '--show-toplevel'], { allowFailure: true }).stdout.trim();
    if (repositoryRoot && path.resolve(repositoryRoot) === root)
    {
        const indexed = new Map();
        const index = command(['git', 'ls-files', '--stage'], { allowFailure: true });
        if (index.status === 0)
        {
            for (const line of index.stdout.split(/\r?\n/u))
            {
                const match = /^\d+ ([0-9a-f]+) 0\t(.+)$/u.exec(line);
                if (match)
                {
                    indexed.set(toPosix(match[2]), match[1]);
                }
            }
            const changed = new Set(changedFiles('HEAD'));
            return sha256(typedInputs + files.map((file) =>
            {
                const indexedDigest = indexed.get(file);
                const digest = indexedDigest && !changed.has(file)
                    ? indexedDigest
                    : gitBlobDigest(fs.readFileSync(path.join(root, file)));
                return `${file}\n${digest}`;
            }).join('\n'));
        }
    }
    return sha256(typedInputs + files.map((file) => `${file}\nsha256:${sha256(fs.readFileSync(path.join(root, file)))}`).join('\n'));
}

function loadBaseline(mode)
{
    const baselinePath = path.join(root, policy.baseline);
    if (!fs.existsSync(baselinePath))
    {
        return new Map();
    }
    const document = readJson(baselinePath, policy.baseline);
    if (!document)
    {
        return new Map();
    }
    if (document.schema !== baselineSchema)
    {
        fail(`baseline schema must be ${baselineSchema}`);
    }
    if (!Array.isArray(document.files))
    {
        fail('frontend style baseline files must be an array');
        return new Map();
    }
    const currentSourceStateSha256 = sourceStateDigest();
    const bindingFailures = [];
    if (document.configurationSha256 !== configurationDigest())
    {
        bindingFailures.push('baseline configuration digest is stale');
    }
    if (document.sourceStateSha256 !== currentSourceStateSha256)
    {
        bindingFailures.push('baseline source-state digest is stale');
    }
    if (document.generatedFrom !== `source-state:${currentSourceStateSha256}`)
    {
        bindingFailures.push('baseline generatedFrom does not match the current source-state digest');
    }
    // Every drift invalidates all exemptions. Only the baseline-aware full mode
    // additionally rejects the binding itself, alongside all file-level findings.
    // Changed and strict-full checks must not become global historical blockers.
    if (bindingFailures.length > 0)
    {
        if (mode === 'full')
        {
            for (const failure of bindingFailures)
            {
                fail(failure);
            }
        }
        return new Map();
    }
    return new Map(document.files.map((entry) => [entry.path, entry]));
}

function validateReviewedBaselineCorrections(correctionPath, rejections)
{
    if (!correctionPath)
    {
        for (const rejection of rejections)
        {
            fail(rejection.message);
        }
        return;
    }
    const relative = normalizeFile(correctionPath);
    const absolute = path.join(root, relative);
    const document = readJson(absolute, relative);
    const candidateBytes = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
    const authority = command(['git', 'show', `${reviewedBaselineAuthorityRef}:${relative}`], { allowFailure: true });
    const baselineAuthority = command(
        ['git', 'show', `${reviewedBaselineAuthorityRef}:${policy.baseline}`],
        { allowFailure: true }
    );
    if (candidateBytes === null || authority.status !== 0 || authority.stdout !== candidateBytes)
    {
        fail(`reviewed frontend style baseline correction must already exist unchanged at ${reviewedBaselineAuthorityRef}: ${relative}`);
    }
    if (!exactObjectKeys(document, ['schema', 'reviewIssue', 'corrections'])
        || document.schema !== baselineCorrectionSchema
        || !Number.isInteger(document.reviewIssue)
        || document.reviewIssue <= 0
        || !Array.isArray(document.corrections)
        || document.corrections.length === 0)
    {
        fail(`reviewed frontend style baseline correction is not a closed ${baselineCorrectionSchema} document`);
        return;
    }
    let baselineAuthorityDocument;
    try
    {
        baselineAuthorityDocument = baselineAuthority.status === 0
            ? JSON.parse(baselineAuthority.stdout)
            : null;
    }
    catch
    {
        baselineAuthorityDocument = null;
    }
    if (baselineAuthorityDocument?.schema !== baselineSchema
        || !Array.isArray(baselineAuthorityDocument.files))
    {
        fail(`reviewed frontend style baseline correction requires a valid baseline at ${reviewedBaselineAuthorityRef}`);
        return;
    }
    const authorityBaselineByPath = new Map(baselineAuthorityDocument.files.map((entry) => [entry.path, entry]));
    if (authorityBaselineByPath.size !== baselineAuthorityDocument.files.length)
    {
        fail(`reviewed frontend style baseline correction requires unique baseline paths at ${reviewedBaselineAuthorityRef}`);
        return;
    }
    const corrections = new Map();
    for (const entry of document.corrections)
    {
        if (!exactObjectKeys(entry, [
            'path',
            'sourceSha256',
            'previousViolationCount',
            'previousViolationDigest',
            'previousRules',
            'correctedViolationCount',
            'correctedViolationDigest',
            'correctedRules',
            'reason',
            'terminalCondition'
        ])
            || typeof entry.path !== 'string'
            || entry.path.length === 0
            || path.isAbsolute(entry.path)
            || entry.path.includes('\\')
            || entry.path.includes('*')
            || entry.path.split('/').includes('..')
            || corrections.has(entry.path))
        {
            fail(`reviewed frontend style baseline correction has invalid, duplicate, or open entry ${entry?.path ?? '<unknown>'}`);
            continue;
        }
        corrections.set(entry.path, entry);
    }
    const expectedPaths = rejections.map(({ path: file }) => file).sort(compareOrdinal);
    const actualPaths = [...corrections.keys()].sort(compareOrdinal);
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    {
        fail(`reviewed frontend style baseline correction must exactly match rejected paths: expected=${expectedPaths.join(',') || '<none>'} actual=${actualPaths.join(',') || '<none>'}`);
    }
    for (const rejection of rejections)
    {
        const entry = corrections.get(rejection.path);
        if (!entry)
        {
            continue;
        }
        const previousRules = normalizedRules(entry.previousRules);
        const correctedRules = normalizedRules(entry.correctedRules);
        const authorityPrior = authorityBaselineByPath.get(entry.path);
        const authorityRules = normalizedRules(authorityPrior?.rules);
        const authorityPriorMatches = exactObjectKeys(authorityPrior, [
            'path',
            'sourceSha256',
            'violationCount',
            'violationDigest',
            'rules'
        ])
            && authorityPrior.sourceSha256 === rejection.prior.sourceSha256
            && authorityPrior.violationCount === rejection.prior.violationCount
            && authorityPrior.violationDigest === rejection.prior.violationDigest
            && authorityRules
            && JSON.stringify(authorityRules) === JSON.stringify(normalizedRules(rejection.prior.rules));
        const previousMatches = previousRules
            && entry.sourceSha256 === rejection.prior.sourceSha256
            && entry.previousViolationCount === rejection.prior.violationCount
            && entry.previousViolationDigest === rejection.prior.violationDigest
            && JSON.stringify(previousRules) === JSON.stringify(normalizedRules(rejection.prior.rules));
        const correctedMatches = correctedRules
            && entry.sourceSha256 === rejection.current.sourceSha256
            && entry.correctedViolationCount === rejection.current.violationCount
            && entry.correctedViolationDigest === rejection.current.violationDigest
            && JSON.stringify(correctedRules) === JSON.stringify(normalizedRules(rejection.current.rules));
        const exactMalformedAggregateRepair = previousRules
            && correctedRules
            && entry.previousViolationCount === entry.correctedViolationCount
            && entry.previousViolationDigest !== entry.correctedViolationDigest
            && ruleCount(previousRules) !== entry.previousViolationCount
            && ruleCount(correctedRules) === entry.correctedViolationCount;
        if (!authorityPriorMatches || !previousMatches || !correctedMatches || !exactMalformedAggregateRepair)
        {
            fail(`reviewed frontend style baseline correction is stale or not an exact malformed-aggregate repair for ${entry.path}`);
        }
        if (typeof entry.reason !== 'string' || entry.reason.trim().length < 24)
        {
            fail(`reviewed frontend style baseline correction reason is incomplete for ${entry.path}`);
        }
        if (entry.terminalCondition !== 'baseline-entry-replaced-once')
        {
            fail(`reviewed frontend style baseline correction terminal condition is invalid for ${entry.path}`);
        }
    }
}

function writeBaseline(violations, selectedFiles, args)
{
    const violationsByPath = new Map();
    const target = path.join(root, policy.baseline);
    const byFile = new Map();
    for (const violation of violations)
    {
        const pathViolations = violationsByPath.get(violation.file) ?? [];
        pathViolations.push(violation);
        violationsByPath.set(violation.file, pathViolations);
        const entry = byFile.get(violation.file) ?? { rules: {}, ids: [] };
        const rule = `${violation.tool}/${violation.rule}`;
        entry.rules[rule] = (entry.rules[rule] ?? 0) + 1;
        entry.ids.push(violation.id);
        byFile.set(violation.file, entry);
    }
    const currentByPath = new Map([...byFile.entries()].map(([file, entry]) => [file, {
        path: file,
        sourceSha256: sha256(fs.readFileSync(path.join(root, file))),
        violationCount: entry.ids.length,
        violationDigest: sha256(entry.ids.sort().join('\n')),
        rules: Object.fromEntries(Object.entries(entry.rules).sort(([left], [right]) => compareOrdinal(left, right)))
    }]));
    const selected = new Set(selectedFiles);
    const pathMigration = args.migrateBaselinePaths
        ? readJson(path.join(root, args.migrateBaselinePaths), args.migrateBaselinePaths)
        : null;
    const validMigrationPath = (file) => typeof file === 'string'
        && file.length > 0
        && !path.isAbsolute(file)
        && !file.includes('\\')
        && !file.includes('*')
        && !file.split('/').includes('..');
    if (args.migrateBaselinePaths && (!exactObjectKeys(pathMigration, ['schema', 'referenceFiles', 'renames'])
        || pathMigration.schema !== 'fsusblog.test-asset-semantic-renames.v1'
        || !Array.isArray(pathMigration.renames)
        || pathMigration.renames.length === 0
        || !Array.isArray(pathMigration.referenceFiles)
        || pathMigration.referenceFiles.some((file) => !validMigrationPath(file))
        || new Set(pathMigration.referenceFiles).size !== pathMigration.referenceFiles.length))
    {
        fail('frontend style baseline path migration inventory is invalid');
        return;
    }
    const migrationSources = new Set();
    const migrationDestinations = new Set();
    for (const entry of pathMigration?.renames ?? [])
    {
        if (!exactObjectKeys(entry, ['from', 'to'])
            || !validMigrationPath(entry.from)
            || !validMigrationPath(entry.to)
            || entry.from === entry.to
            || migrationSources.has(entry.from)
            || migrationDestinations.has(entry.to)
            || fs.existsSync(path.join(root, entry.from))
            || !fs.existsSync(path.join(root, entry.to)))
        {
            fail(`frontend style baseline path migration is not an exact one-to-one live rename: ${entry?.from ?? '<unknown>'} -> ${entry?.to ?? '<unknown>'}`);
            return;
        }
        migrationSources.add(entry.from);
        migrationDestinations.add(entry.to);
    }
    if ([...migrationSources].some((file) => migrationDestinations.has(file)))
    {
        fail('frontend style baseline path migration cannot contain cycles, chains, or path reuse');
        return;
    }
    const destinationBySource = new Map((pathMigration?.renames ?? []).map(({ from, to }) => [from, to]));
    const sourceByDestination = new Map((pathMigration?.renames ?? []).map(({ from, to }) => [to, from]));
    const identityMigrationFiles = new Set();
    let files = [...currentByPath.values()].sort((left, right) => compareOrdinal(left.path, right.path));
    if (!fs.existsSync(target) && args.reviewedBaselineCorrection)
    {
        validateReviewedBaselineCorrections(args.reviewedBaselineCorrection, []);
        return;
    }
    if (fs.existsSync(target))
    {
        const previous = readJson(target, policy.baseline);
        if (!previous || previous.schema !== baselineSchema || !Array.isArray(previous.files))
        {
            fail('cannot update an invalid frontend style baseline');
            return;
        }
        const previousByPath = new Map(previous.files.map((entry) => [entry.path, entry]));
        if (previousByPath.size !== previous.files.length)
        {
            fail('frontend style baseline contains duplicate paths');
            return;
        }
        for (const { from, to } of pathMigration?.renames ?? [])
        {
            const prior = previousByPath.get(from);
            const current = currentByPath.get(to) ?? (selected.has(to) ? {
                path: to,
                sourceSha256: sha256(fs.readFileSync(path.join(root, to))),
                violationCount: 0,
                violationDigest: sha256(''),
                rules: {}
            } : null);
            const previousRules = normalizedRules(prior?.rules);
            const currentRules = normalizedRules(current?.rules);
            const destinationMarker = `:${to}:`;
            const sourceMarker = `:${from}:`;
            const currentViolationIds = byFile.get(to)?.ids ?? [];
            const projectedPreviousIds = currentViolationIds.map((id) =>
                id.includes(destinationMarker) ? id.replace(destinationMarker, sourceMarker) : null);
            const projectedViolationIdentityMatches = projectedPreviousIds.every(Boolean)
                && projectedPreviousIds.length === current?.violationCount
                && sha256(projectedPreviousIds.sort().join('\n')) === prior?.violationDigest;
            const baselineIdentityMatches = prior
                && current
                && !previousByPath.has(to)
                && current.sourceSha256 === prior.sourceSha256
                && current.violationCount === prior.violationCount
                && previousRules
                && currentRules
                && JSON.stringify(currentRules) === JSON.stringify(previousRules)
                && projectedViolationIdentityMatches;
            if (!baselineIdentityMatches)
            {
                fail(`frontend style baseline path migration does not preserve exact source and baseline identity: ${from} -> ${to}`);
                return;
            }
            identityMigrationFiles.add(to);
        }
        const currentConfigurationSha256 = configurationDigest();
        if (previous.configurationSha256 !== currentConfigurationSha256)
        {
            if (args.migrateBaselineConfiguration !== previous.configurationSha256)
            {
                fail(`frontend style baseline configuration digest changed from ${previous.configurationSha256} to ${currentConfigurationSha256}; rerun with --migrate-baseline-configuration ${previous.configurationSha256}`);
            }
        }
        else if (args.migrateBaselineConfiguration)
        {
            fail('refusing unnecessary frontend style baseline configuration migration authorization');
        }
        const residualAuthorityFile = path.join(root, reviewedResidualAuthorityPath);
        const residualAuthority = fs.existsSync(residualAuthorityFile)
            ? readJson(residualAuthorityFile, reviewedResidualAuthorityPath)
            : null;
        const residualRequired = residualAuthority
            ? reviewedResidualConsumptionRequired(residualAuthority, currentByPath, previousByPath)
            : false;
        let residualAuthorized = false;
        if (args.reviewedResidualClassification)
        {
            const residualFailures = validateReviewedResidualConsumption({
                root,
                authorityPath: args.reviewedResidualClassification,
                currentByPath,
                previousByPath,
                violationsByPath
            });
            for (const residualFailure of residualFailures)
            {
                fail(residualFailure);
            }
            residualAuthorized = residualFailures.length === 0;
        }
        else if (residualRequired)
        {
            fail(`frontend style baseline update requires --reviewed-residual-classification ${reviewedResidualAuthorityPath}`);
        }
        const residualPaths = residualAuthorized
            ? new Set(residualAuthority.entries.map(({ path: file }) => file))
            : new Set();
        const identityRejections = [];
        for (const current of currentByPath.values())
        {
            const prior = previousByPath.get(current.path)
                ?? previousByPath.get(sourceByDestination.get(current.path));
            if (!prior)
            {
                if ((!identityMigrationFiles.has(current.path) || current.violationCount > 0)
                    && !residualPaths.has(current.path))
                {
                    fail(`refusing new frontend style baseline path ${current.path} with ${current.violationCount} violations`);
                }
                continue;
            }
            if (current.violationCount > prior.violationCount)
            {
                if (!residualPaths.has(current.path))
                {
                    fail(`refusing frontend style baseline violation increase for ${current.path}: ${prior.violationCount} -> ${current.violationCount}`);
                }
            }
            else if (current.violationCount === prior.violationCount
                && current.violationDigest !== prior.violationDigest
                && !identityMigrationFiles.has(current.path)
                && !residualPaths.has(current.path)
                && !(args.migrateBaselineConfiguration
                    && current.sourceSha256 === prior.sourceSha256
                    && JSON.stringify(current.rules) === JSON.stringify(prior.rules)))
            {
                identityRejections.push({
                    path: current.path,
                    prior,
                    current,
                    message: `refusing frontend style baseline violation identity change without count decrease for ${current.path}`
                });
            }
        }
        validateReviewedBaselineCorrections(args.reviewedBaselineCorrection, identityRejections);
        const emptyViolationDigest = sha256('');
        const nextFiles = [];
        for (const prior of previous.files)
        {
            const destination = destinationBySource.get(prior.path) ?? prior.path;
            const current = currentByPath.get(destination);
            if (current)
            {
                nextFiles.push(current);
                continue;
            }
            const absolute = path.join(root, destination);
            if (selected.has(destination) && fs.existsSync(absolute))
            {
                nextFiles.push({
                    path: destination,
                    sourceSha256: sha256(fs.readFileSync(absolute)),
                    violationCount: 0,
                    violationDigest: emptyViolationDigest,
                    rules: {}
                });
                continue;
            }
            if (!fs.existsSync(absolute) && args.pruneRemovedBaselinePaths)
            {
                continue;
            }
            fail(`refusing missing frontend style baseline path ${prior.path}; use --prune-removed-baseline-paths only after reviewing its deletion`);
        }
        const retainedPaths = new Set(nextFiles.map(({ path: file }) => file));
        for (const current of currentByPath.values())
        {
            if (!retainedPaths.has(current.path))
            {
                nextFiles.push(current);
            }
        }
        nextFiles.sort((left, right) => compareOrdinal(left.path, right.path));
        if (failures.length > 0)
        {
            return;
        }
        files = nextFiles;
    }
    const violationCount = files.reduce((sum, entry) => sum + entry.violationCount, 0);
    const sourceStateSha256 = sourceStateDigest();
    const document = {
        schema: baselineSchema,
        generatedFrom: `source-state:${sourceStateSha256}`,
        sourceStateSha256,
        configurationSha256: configurationDigest(),
        violationCount,
        fileCount: files.length,
        files
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    requireCurrentTypedLintInputs();
    fs.writeFileSync(target, `${JSON.stringify(document, null, 4)}\n`);
    console.log(`[frontend-style] baseline updated violations=${violationCount} path=${policy.baseline}`);
}

function validateSpecializedGovernance()
{
    const contract = policy.specializedGovernance;
    const packageDocument = readJson(path.join(root, contract.package), contract.package);
    if (!packageDocument)
    {
        return;
    }
    const entries = Object.entries(packageDocument.scripts ?? {})
        .filter(([id]) => id.startsWith(contract.scriptPrefix))
        .sort(([left], [right]) => compareOrdinal(left, right));
    const idsDigest = sha256(entries.map(([id]) => id).join('\n'));
    const definitionsDigest = sha256(entries.map(([id, value]) => `${id}=${value}`).join('\n'));
    if (entries.length !== contract.count)
    {
        fail(`specialized governance command count changed: expected ${contract.count}, got ${entries.length}`);
    }
    if (idsDigest !== contract.idsSha256)
    {
        fail('specialized governance command IDs changed');
    }
    if (definitionsDigest !== contract.definitionsSha256)
    {
        fail('specialized governance command definitions changed');
    }
}

function validateConfiguration()
{
    const expectedTypedInputs = {
        localFsusUiRoot: 'vue',
        extensions: ['.ts', '.tsx', '.mts', '.cts', '.vue', '.js', '.jsx', '.mjs', '.cjs', '.json'],
        excludedDirectories: ['.git', '.tmp', 'artifacts', 'coverage', 'dist', 'node_modules']
    };
    if (JSON.stringify(policy.typedLintInputs) !== JSON.stringify(expectedTypedInputs))
    {
        fail('typedLintInputs must retain the canonical local FsusUI source coverage');
    }
    if (policy.schema !== policySchema)
    {
        fail(`policy schema must be ${policySchema}`);
    }
    for (const field of ['baseline', 'ruleRegistry', 'eslintConfig', 'stylelintConfig'])
    {
        if (typeof policy[field] !== 'string' || !policy[field])
        {
            fail(`policy is missing ${field}`);
        }
    }
    for (const file of [
        policy.ruleRegistry,
        policy.eslintConfig,
        policy.stylelintConfig,
        policy.toolchain?.package,
        policy.toolchain?.lock,
        policy.toolchain?.eslint,
        policy.toolchain?.stylelint
    ])
    {
        if (!file || !fs.existsSync(path.join(root, file)))
        {
            fail(`missing configured frontend style path ${file ?? '<undefined>'}`);
        }
    }
    if (!Array.isArray(policy.eslintSourceSets))
    {
        fail('eslintSourceSets must be an array');
    }
    else
    {
        for (const requiredRoot of [
            'src/frontend/src',
            'src/frontend/wasm/web',
            'src/frontend/scripts',
            'src/frontend/public',
            'tools',
            'tests'
        ])
        {
            if (!policy.eslintSourceSets.some((sourceSet) => sourceSet.root === requiredRoot))
            {
                fail(`eslintSourceSets is missing required root ${requiredRoot}`);
            }
        }
    }
    if (!Array.isArray(policy.stylelintSourceSets) || policy.stylelintSourceSets.length === 0)
    {
        fail('stylelintSourceSets must be non-empty');
    }
    if (policy.authority?.indentSize !== 4 || policy.authority?.braceStyle !== 'allman' || policy.authority?.semicolons !== 'always')
    {
        fail('frontend authority must enforce 4 spaces, Allman braces and semicolons');
    }
    if (policy.authority?.formatter !== 'eslint-stylelint-ast')
    {
        fail('AST-aware ESLint/Stylelint must be the authoritative formatter');
    }
    const registry = readJson(path.join(root, policy.ruleRegistry), policy.ruleRegistry);
    if (registry)
    {
        if (registry.schema !== registrySchema)
        {
            fail(`rule registry schema must be ${registrySchema}`);
        }
        const ruleIds = (registry.rules ?? []).map((entry) => entry.id);
        if (new Set(ruleIds).size !== ruleIds.length)
        {
            fail('frontend style rule registry contains duplicate IDs');
        }
        for (const entry of registry.rules ?? [])
        {
            if (!entry.id || !entry.owner || !Array.isArray(entry.sourceScopes) || !entry.fixability)
            {
                fail(`frontend style rule registry entry is incomplete: ${entry.id ?? '<unknown>'}`);
            }
        }
        for (const required of [
            'vue-composable-function',
            'typescript-structural-interface',
            'json-browser-wasm-contract',
            'html-aria-data-contract',
            'css-selector-custom-property'
        ])
        {
            if (!(registry.registeredExceptions ?? []).some((entry) => entry.id === required))
            {
                fail(`frontend style rule registry is missing exception ${required}`);
            }
        }
        if (registry.cssPropertyOrder?.mode !== policy.authority.cssPropertyOrder)
        {
            fail('CSS property-order decision is inconsistent');
        }
    }
    for (const packagePath of [policy.toolchain.package, 'src/frontend/package.json'])
    {
        const packageDocument = readJson(path.join(root, packagePath), packagePath);
        if (!packageDocument)
        {
            continue;
        }
        const dependencies = { ...packageDocument.dependencies, ...packageDocument.devDependencies };
        for (const forbidden of policy.authority.forbiddenAuthoritativePackages ?? [])
        {
            if (dependencies[forbidden])
            {
                fail(`${packagePath} cannot make ${forbidden} an authoritative formatter`);
            }
        }
    }
    const residualAuthority = path.join(root, reviewedResidualAuthorityPath);
    if (fs.existsSync(residualAuthority))
    {
        const bytes = fs.readFileSync(residualAuthority, 'utf8');
        const document = readJson(residualAuthority, reviewedResidualAuthorityPath);
        if (document)
        {
            for (const residualFailure of validateReviewedResidualDocument(document, bytes, { root }))
            {
                fail(residualFailure);
            }
        }
    }
    validateSpecializedGovernance();
}

export function materializeSourceDiffBase({ repositoryRoot, baseCommit, scratch, files })
{
    if (!/^[0-9a-f]{40}$/u.test(baseCommit))
    {
        throw new Error('source-diff base materialization requires an exact Git commit');
    }
    function git(args)
    {
        const result = spawnSync('git', args, { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
        if (result.error || result.status !== 0)
        {
            throw new Error(`source-diff base Git read failed: ${result.error?.message ?? result.stderr}`);
        }
        return result.stdout;
    }
    const tree = new Map(git(['ls-tree', '-r', '-l', '-z', baseCommit]).toString('utf8').split('\0')
        .filter(Boolean).map((record) =>
        {
            const separator = record.indexOf('\t');
            const identity = record.slice(0, separator);
            const file = record.slice(separator + 1);
            const [mode, kind, blob, size] = identity.trim().split(/\s+/u);
            return [file, { mode, kind, blob, size: Number(size) }];
        }));
    const read = (file) =>
    {
        const identity = tree.get(file);
        if (!identity || identity.kind !== 'blob' || !['100644', '100755'].includes(identity.mode))
        {
            throw new Error(`source-diff base resolver input is not a tracked regular file: ${file}`);
        }
        if (!Number.isSafeInteger(identity.size) || identity.size < 0 || identity.size > 64 * 1024 * 1024)
        {
            throw new Error(`source-diff base resolver input exceeds task scratch budget: ${file}`);
        }
        const bytes = git(['cat-file', 'blob', identity.blob]);
        if (bytes.length !== identity.size || gitBlobDigest(bytes) !== identity.blob)
        {
            throw new Error(`source-diff base blob identity mismatch: ${file}`);
        }
        return bytes;
    };
    const utf8 = (file, bytes) =>
    {
        const source = bytes.toString('utf8');
        if (!Buffer.from(source).equals(bytes))
        {
            throw new Error(`source-diff base resolver input is not exact UTF-8: ${file}`);
        }
        return source;
    };
    const contained = (file) =>
    {
        if (path.posix.isAbsolute(file) || file === '..' || file.startsWith('../') || file.includes('\\'))
        {
            throw new Error(`source-diff base resolver path escapes repository: ${file}`);
        }
        return file;
    };
    const pending = [...files];
    const inspected = new Set();
    const records = [];
    const dependencies = [];
    const unresolved = [];
    let totalBytes = 0;
    const parser = createRequire(path.join(repositoryRoot, 'tools/frontend/style-toolchain/package.json'))('espree');
    function resolveReference(owner, reference)
    {
        const relative = contained(path.posix.normalize(path.posix.join(path.posix.dirname(owner), reference)));
        for (const file of [relative, ...['.js', '.mjs', '.cjs', '.json', '.node'].map((extension) => relative + extension)])
        {
            if (tree.has(file))
            {
                return file;
            }
        }
        const packageFile = `${relative}/package.json`;
        if (tree.has(packageFile))
        {
            pending.push(packageFile);
            const metadata = JSON.parse(utf8(packageFile, read(packageFile)));
            if (typeof metadata.main === 'string' && metadata.main)
            {
                const entry = contained(path.posix.normalize(path.posix.join(relative, metadata.main)));
                for (const file of [entry, `${entry}.js`, `${entry}.json`, `${entry}/index.js`])
                {
                    if (tree.has(file))
                    {
                        return file;
                    }
                }
            }
        }
        return ['index.js', 'index.mjs', 'index.cjs', 'index.json', 'index.node']
            .map((file) => `${relative}/${file}`).find((file) => tree.has(file)) ?? null;
    }
    while (pending.length > 0)
    {
        const file = contained(pending.shift());
        if (inspected.has(file))
        {
            continue;
        }
        inspected.add(file);
        const bytes = read(file);
        totalBytes += bytes.length;
        if (totalBytes > 64 * 1024 * 1024 || inspected.size > 4096)
        {
            throw new Error('source-diff base resolver materialization exceeds task scratch budget');
        }
        const destination = path.join(scratch, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes);
        records.push({ file, ...tree.get(file), sha256: sha256(bytes), bytes: bytes.length });
        for (let directory = path.posix.dirname(file);; directory = path.posix.dirname(directory))
        {
            const packageFile = directory === '.' ? 'package.json' : `${directory}/package.json`;
            if (tree.has(packageFile))
            {
                pending.push(packageFile);
                break;
            }
            if (directory === '.')
            {
                break;
            }
        }
        if (!/\.(?:mjs|cjs|js|jsx)$/u.test(file))
        {
            continue;
        }
        const ast = parser.parse(utf8(file, bytes), { ecmaVersion: 'latest', sourceType: file.endsWith('.cjs') ? 'script' : 'module',
            ecmaFeatures: { jsx: true, globalReturn: file.endsWith('.cjs') } });
        function visit(node)
        {
            if (!node || typeof node !== 'object')
            {
                return;
            }
            const source = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)
                ? node.source
                : node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require'
                    ? node.arguments[0] : null;
            if (source?.type === 'Literal' && typeof source.value === 'string' && /^\.{1,2}(?:\/|$)/u.test(source.value))
            {
                const dependency = resolveReference(file, source.value);
                if (dependency)
                {
                    dependencies.push({ owner: file, specifier: source.value, path: dependency });
                    pending.push(dependency);
                }
                else
                {
                    unresolved.push({ owner: file, reference: source.value });
                }
            }
            for (const value of Object.values(node))
            {
                if (Array.isArray(value))
                {
                    value.forEach(visit);
                }
                else if (value && typeof value === 'object')
                {
                    visit(value);
                }
            }
        }
        visit(ast);
    }
    const identities = new Map(records.map((record) => [record.file, record]));
    return { baseCommit, files: records.sort((left, right) => left.file.localeCompare(right.file)),
        dependencies: dependencies.map((dependency) => ({ ...dependency,
            blob: identities.get(dependency.path).blob, sha256: identities.get(dependency.path).sha256 })),
        unresolved, totalBytes, purpose: 'static ESLint resolver inputs; no imported module execution', qualification: false };
}

function sourceDiffImportContext({ file, baseSource, candidateSource, baseInputs, identities })
{
    const parser = createRequire(path.join(root, 'tools/frontend/style-toolchain/package.json'))('espree');
    const imports = (source) => parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .filter((node) => node.type === 'ImportDeclaration').map((node) => node.source.value);
    const prior = baseInputs.dependencies.filter((dependency) => dependency.owner === file);
    const resolveCandidate = createRequire(path.join(root, file));
    function witness(specifiers, isBase)
    {
        const dependencies = specifiers.map((specifier) =>
        {
            if (specifier.startsWith('node:'))
            {
                return { owner: file, specifier, kind: 'builtin', nodeVersion: process.version };
            }
            if (!/^\.{1,2}(?:\/|$)/u.test(specifier))
            {
                throw new Error('external installed modules have no repository source witness');
            }
            if (isBase)
            {
                const matches = prior.filter((dependency) => dependency.specifier === specifier);
                if (matches.length !== 1)
                {
                    throw new Error('base import has no unique tracked source witness');
                }
                const { path: dependencyPath, blob, sha256: digest } = matches[0];
                return { owner: file, specifier, kind: 'repository', path: dependencyPath, blob, sha256: digest };
            }
            const target = resolveCandidate.resolve(specifier);
            const dependencyPath = toPosix(path.relative(root, target));
            if (dependencyPath.startsWith('../') || path.isAbsolute(dependencyPath))
            {
                throw new Error('candidate import escapes repository');
            }
            const identity = command(['git', 'ls-tree', 'HEAD', '--', dependencyPath]).stdout.trim().split(/\s+/u);
            const stat = fs.lstatSync(target);
            if (!stat.isFile() || stat.nlink !== 1 || !['100644', '100755'].includes(identity[0])
                || identity[1] !== 'blob' || fs.realpathSync(path.join(root, dependencyPath)) !== target)
            {
                throw new Error('candidate import is not a tracked regular source');
            }
            const bytes = fs.readFileSync(target);
            if (gitBlobDigest(bytes) !== identity[2])
            {
                throw new Error('candidate import does not match actual HEAD');
            }
            return { owner: file, specifier, kind: 'repository', path: dependencyPath, blob: identity[2], sha256: sha256(bytes) };
        }).sort((left, right) => left.specifier.localeCompare(right.specifier));
        return { sourcePath: file, configurationIdentities: [...identities].sort((left, right) => left.file.localeCompare(right.file)),
            dependencies };
    }
    try
    {
        return { base: witness(imports(baseSource), true), candidate: witness(imports(candidateSource), false) };
    }
    catch
    {
        // Missing, changed, ambiguous or external inputs keep import-order diagnostics strict.
        return null;
    }
}

function checkSourceDiff(args, files)
{
    if (!args.base || args.fix || args.updateBaseline || args.policy)
    {
        throw new Error('source-diff requires explicit --base and the original policy; fixes/baseline writes are forbidden');
    }
    const base = command(['git', 'rev-parse', '--verify', `${args.base}^{commit}`]).stdout.trim();
    command(['git', 'merge-base', '--is-ancestor', base, 'HEAD']);
    const identities = [...new Set([
        defaultPolicyPath, policy.ruleRegistry, policy.toolchain.package, policy.toolchain.lock,
        ...policy.configurationSources.filter((file) => file !== 'tools/frontend/check-frontend-style.mjs')
    ])].map((file) =>
    {
        const prior = command(['git', 'show', `${base}:${file}`]).stdout;
        const current = fs.readFileSync(path.join(root, file), 'utf8');
        if (prior !== current)
        {
            throw new Error(`source-diff configuration changed: ${file}`);
        }
        return { file, sha256: sha256(current) };
    });
    const report = { schema: 'fsusblog.frontend-style-source-diff.v1', baseCommit: base,
        candidateCommit: command(['git', 'rev-parse', 'HEAD']).stdout.trim(),
        configurationIdentities: identities, qualification: false, files: [], failures: [] };
    report.toolVersions = Object.fromEntries(['eslint', 'espree', 'eslint-scope'].map((name) =>
    {
        const installed = readJson(path.join(root, `tools/frontend/style-toolchain/node_modules/${name}/package.json`), name);
        const locked = readJson(path.join(root, policy.toolchain.lock), policy.toolchain.lock)?.packages?.[`node_modules/${name}`];
        if (!installed || !locked || installed.version !== locked.version)
        {
            throw new Error(`source-diff installed tool does not match original lock: ${name}`);
        }
        return [name, installed.version];
    }));
    const scratch = fs.mkdtempSync(path.join(root, '.tmp/frontend-style/source-diff-base-'));
    try
    {
        // The original ESLint CLI loads identical original configuration in a separate base root.
        for (const file of [policy.eslintConfig, 'tools/frontend/style-toolchain/eslint.config.mjs', policy.toolchain.package,
            'src/frontend/scripts/run-local-fsusui-typecheck.mjs', 'src/frontend/scripts/fsusui-root.mjs'])
        {
            const destination = path.join(scratch, file);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, command(['git', 'show', `${base}:${file}`]).stdout);
        }
        fs.symlinkSync(fs.realpathSync(path.join(root, 'tools/frontend/style-toolchain/node_modules')),
            path.join(scratch, 'tools/frontend/style-toolchain/node_modules'), 'dir');
        report.baseResolverInputs = materializeSourceDiffBase({ repositoryRoot: root, baseCommit: base, scratch,
            files: files.filter((file) => command(['git', 'ls-tree', base, '--', file]).stdout.length > 0) });
        for (const file of files)
        {
            const candidateSource = fs.readFileSync(path.join(root, file), 'utf8');
            const existsInBase = command(['git', 'ls-tree', base, '--', file]).stdout.length > 0;
            const baseSource = existsInBase ? command(['git', 'show', `${base}:${file}`]).stdout : null;
            if (!Buffer.from(candidateSource).equals(fs.readFileSync(path.join(root, file)))
                || (baseSource !== null && gitBlobDigest(Buffer.from(baseSource)) !== command(['git', 'rev-parse', `${base}:${file}`]).stdout.trim()))
            {
                throw new Error(`source-diff requires exact UTF-8 source bytes: ${file}`);
            }
            const destination = path.join(scratch, file);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            if (baseSource !== null)
            {
                fs.writeFileSync(destination, baseSource);
            }
            function lint(workingRoot)
            {
                const result = spawnSync(process.execPath, ['--max-old-space-size=512', path.join(root, policy.toolchain.eslint),
                    '--config', path.join(workingRoot, policy.eslintConfig), '--format', 'json', file],
                { cwd: workingRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
                    env: { ...process.env, FSUSBLOG_STYLE_ROOT: workingRoot } });
                if (result.error || ![0, 1].includes(result.status))
                {
                    throw new Error(`source-diff eslint failed: ${result.error?.message ?? result.stderr}`);
                }
                const rows = JSON.parse(result.stdout);
                if (rows.length !== 1 || rows[0].filePath !== path.join(workingRoot, file))
                {
                    throw new Error(`source-diff eslint did not inspect exactly ${file}`);
                }
                return { exitCode: result.status, reports: rows,
                    findings: rows[0].messages.map((message) => ({ ...makeViolation('eslint', file, message), message: String(message.message),
                        severity: Number(message.severity), fatal: Boolean(message.fatal) })) };
            }
            const rawBase = baseSource === null ? { exitCode: null, reports: [], findings: [] } : lint(scratch);
            const rawCandidate = lint(root);
            const importContext = baseSource === null ? null : sourceDiffImportContext({ file, baseSource, candidateSource,
                baseInputs: report.baseResolverInputs, identities });
            const comparison = /\.(?:mjs|cjs|js)$/u.test(file) && toolKinds(file).join(',') === 'eslint'
                ? compareSourceUnitFindings({ baseSource, candidateSource,
                    baseFindings: rawBase.findings, candidateFindings: rawCandidate.findings, importContext })
                : { existing: [], unexpected: rawCandidate.findings, failure: null };
            if (!Buffer.from(candidateSource).equals(fs.readFileSync(path.join(root, file))))
            {
                throw new Error(`source-diff candidate changed during inspection: ${file}`);
            }
            report.files.push({ file, baseSourceSha256: baseSource === null ? null : sha256(baseSource),
                candidateSourceSha256: sha256(candidateSource), rawBase, rawCandidate, importContext, ...comparison });
            if (comparison.failure)
            {
                fail(`${file}: ${comparison.failure}`);
            }
            for (const finding of comparison.unexpected)
            {
                fail(`${file}:${finding.line}:${finding.column} ${finding.rule}: ${finding.message}`);
            }
        }
    }
    catch (error)
    {
        fail(error instanceof Error ? error.message : String(error));
    }
    finally
    {
        fs.rmSync(scratch, { recursive: true, force: true });
        for (const identity of identities)
        {
            if (sha256(fs.readFileSync(path.join(root, identity.file))) !== identity.sha256)
            {
                fail(`source-diff configuration changed during inspection: ${identity.file}`);
            }
        }
        report.failures = [...failures];
        report.sourceCheckPassed = failures.length === 0;
        fs.writeFileSync(path.join(root, '.tmp/frontend-style/source-diff.json'), `${JSON.stringify(report, null, 4)}\n`);
    }
    const violations = report.files.reduce((count, row) => count + row.rawCandidate.findings.length, 0);
    const unexpected = report.files.reduce((count, row) => count + row.unexpected.length, 0);
    return { files: files.length, eslintFiles: files.length, stylelintFiles: 0, violations, unexpected };
}

function main()
{
    const args = parseArgs(process.argv.slice(2));
    root = path.resolve(args.root ?? defaultRoot);
    args.mode ??= 'changed';
    if (!validModes.has(args.mode))
    {
        throw new Error(`invalid mode ${args.mode}`);
    }
    if (args.mode === 'source-diff')
    {
        fs.mkdirSync(path.join(root, '.tmp/frontend-style'), { recursive: true });
        fs.rmSync(path.join(root, '.tmp/frontend-style/source-diff.json'), { force: true });
    }
    if (args.updateBaseline && args.fix)
    {
        throw new Error('--update-baseline and --fix cannot be combined');
    }
    if ((args.migrateBaselineConfiguration
        || args.migrateBaselinePaths
        || args.pruneRemovedBaselinePaths
        || args.reviewedBaselineCorrection
        || args.reviewedResidualClassification)
        && !args.updateBaseline)
    {
        throw new Error('baseline migration options require --update-baseline');
    }
    if (args.reviewedResidualClassification
        && (args.mode !== 'full' || args.files.length > 0))
    {
        throw new Error('reviewed residual classification requires a canonical full baseline update without --file');
    }
    if (args.fix && args.mode === 'full' && args.files.length === 0)
    {
        throw new Error('refusing full-repository --fix; mechanical formatting requires a separate reviewed commit');
    }
    policyFile = path.resolve(args.policy ?? path.join(root, defaultPolicyPath));
    policy = readJson(policyFile, args.policy ?? defaultPolicyPath);
    if (!policy)
    {
        return null;
    }
    validateConfiguration();
    if (failures.length > 0)
    {
        return null;
    }

    const files = selectFiles(args);
    if (args.mode === 'source-diff')
    {
        fs.mkdirSync(path.join(root, '.tmp/frontend-style'), { recursive: true });
        if (args.files.length > 0 && files.length !== new Set(args.files.map(normalizeFile)).size)
        {
            throw new Error('source-diff requires every explicit file to exist and match the configured source sets');
        }
        if (files.some((file) => toolKinds(file).join(',') !== 'eslint' || !/\.(?:mjs|cjs|js)$/u.test(file)))
        {
            throw new Error('source-diff currently accepts JavaScript ESLint source files only; other source kinds require strict checks');
        }
        return checkSourceDiff(args, files);
    }
    typedLintContext = resolveTypedLintContext();
    typedLintSourceSha256 = typedLintSourceDigest();
    const eslintFiles = files.filter((file) => toolKinds(file).includes('eslint'));
    const stylelintFiles = files.filter((file) => toolKinds(file).includes('stylelint'));
    const violations = [
        ...runEslint(eslintFiles, Boolean(args.fix)),
        ...runStylelint(stylelintFiles, Boolean(args.fix))
    ].sort((left, right) => compareOrdinal(left.file, right.file)
        || left.line - right.line
        || left.column - right.column
        || compareOrdinal(left.tool, right.tool)
        || compareOrdinal(left.rule, right.rule)
        || compareOrdinal(left.message, right.message));

    requireCurrentTypedLintInputs();
    if (args.updateBaseline)
    {
        if (failures.length > 0)
        {
            return null;
        }
        writeBaseline(violations, files, args);
        return { files: files.length, eslintFiles: eslintFiles.length, stylelintFiles: stylelintFiles.length, violations: violations.length, unexpected: 0 };
    }

    const baseline = loadBaseline(args.mode);
    const sourceDigests = new Map(files.map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]));
    const unexpected = args.mode === 'strict-full'
        ? violations
        : violations.filter((violation) =>
{
            const entry = baseline.get(violation.file);
            return !entry || entry.sourceSha256 !== sourceDigests.get(violation.file);
        });
    for (const violation of unexpected)
    {
        fail(`${violation.file}:${violation.line}:${violation.column} ${violation.tool}/${violation.rule}: ${violation.message}`);
    }
    return { files: files.length, eslintFiles: eslintFiles.length, stylelintFiles: stylelintFiles.length, violations: violations.length, unexpected: unexpected.length };
}

let summary = null;
try
{
    summary = main();
}
catch (error)
{
    fail(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0)
{
    for (const failure of failures)
    {
        console.error(failure);
    }
    process.exitCode = 1;
}
else if (summary)
{
    console.log(`[frontend-style] ok files=${summary.files} eslint=${summary.eslintFiles} stylelint=${summary.stylelintFiles} violations=${summary.violations} new=${summary.unexpected}`);
}
