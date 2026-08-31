#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '../..');
const defaultPolicyPath = 'config/development/frontend-style-policy.json';
const policySchema = 'fsusblog.frontend-style-policy.v1';
const registrySchema = 'fsusblog.frontend-style-rule-registry.v1';
const baselineSchema = 'fsusblog.frontend-style-baseline.v1';
const baselineCorrectionSchema = 'fsusblog.frontend-style-baseline-corrections.v1';
const reviewedBaselineAuthorityRef = 'refs/remotes/origin/master';
const validModes = new Set(['changed', 'full', 'strict-full']);

let root = defaultRoot;
let policy = null;
let policyFile = null;
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
            '--reviewed-baseline-correction'
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
    return {
        id: `${tool}:${rule}:${file}:${line}:${column}:${sha256(normalizedMessage).slice(0, 16)}`,
        tool,
        file,
        line,
        column,
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
        '--cache',
        '--cache-location', cache,
        '--cache-strategy', 'content',
        '--format', 'json',
        '--no-error-on-unmatched-pattern',
        '--no-warn-ignored'
    ];
    if (fix)
    {
        args.push('--fix');
    }
    args.push(...files);
    const result = command(args, {
        allowFailure: true,
        environment: { FSUSBLOG_STYLE_ROOT: root }
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
    return sha256(sources.join('\n'));
}

function sourceStateDigest()
{
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
            return sha256(files.map((file) =>
            {
                const indexedDigest = indexed.get(file);
                const digest = indexedDigest && !changed.has(file)
                    ? indexedDigest
                    : gitBlobDigest(fs.readFileSync(path.join(root, file)));
                return `${file}\n${digest}`;
            }).join('\n'));
        }
    }
    return sha256(files.map((file) => `${file}\nsha256:${sha256(fs.readFileSync(path.join(root, file)))}`).join('\n'));
}

function loadBaseline()
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
    if (document.configurationSha256 !== configurationDigest())
    {
        fail('frontend style baseline configuration digest is stale');
    }
    if (!Array.isArray(document.files))
    {
        fail('frontend style baseline files must be an array');
        return new Map();
    }
    const currentSourceStateSha256 = sourceStateDigest();
    if (document.sourceStateSha256 !== currentSourceStateSha256)
    {
        fail(`frontend style baseline source-state digest is stale: expected ${currentSourceStateSha256}`);
    }
    if (document.generatedFrom !== `source-state:${currentSourceStateSha256}`)
    {
        fail('frontend style baseline generatedFrom does not match the current source-state digest');
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
        if (!previousMatches || !correctedMatches || !exactMalformedAggregateRepair)
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
    const target = path.join(root, policy.baseline);
    const byFile = new Map();
    for (const violation of violations)
    {
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
        const identityRejections = [];
        for (const current of currentByPath.values())
        {
            const prior = previousByPath.get(current.path)
                ?? previousByPath.get(sourceByDestination.get(current.path));
            if (!prior)
            {
                if (!identityMigrationFiles.has(current.path) || current.violationCount > 0)
                {
                    fail(`refusing new frontend style baseline path ${current.path} with ${current.violationCount} violations`);
                }
                continue;
            }
            if (current.violationCount > prior.violationCount)
            {
                fail(`refusing frontend style baseline violation increase for ${current.path}: ${prior.violationCount} -> ${current.violationCount}`);
            }
            else if (current.violationCount === prior.violationCount
                && current.violationDigest !== prior.violationDigest
                && !identityMigrationFiles.has(current.path)
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
    validateSpecializedGovernance();
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
    if (args.updateBaseline && args.fix)
    {
        throw new Error('--update-baseline and --fix cannot be combined');
    }
    if ((args.migrateBaselineConfiguration || args.migrateBaselinePaths || args.pruneRemovedBaselinePaths || args.reviewedBaselineCorrection)
        && !args.updateBaseline)
    {
        throw new Error('baseline migration options require --update-baseline');
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

    if (args.updateBaseline)
    {
        if (failures.length > 0)
        {
            return null;
        }
        writeBaseline(violations, files, args);
        return { files: files.length, eslintFiles: eslintFiles.length, stylelintFiles: stylelintFiles.length, violations: violations.length, unexpected: 0 };
    }

    const baseline = loadBaseline();
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
