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
        if (!['--root', '--policy', '--mode', '--base', '--file'].includes(argument))
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

function compareOrdinal(left, right)
{
    return left === right ? 0 : left < right ? -1 : 1;
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
    fs.mkdirSync(path.dirname(cache), { recursive: true });
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
    return sha256(paths.map((file) => `${toPosix(path.relative(root, file))}\n${sha256(fs.readFileSync(file))}`).join('\n'));
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
    return new Map(document.files.map((entry) => [entry.path, entry]));
}

function writeBaseline(violations)
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
    const files = [...byFile.entries()].map(([file, entry]) => ({
        path: file,
        sourceSha256: sha256(fs.readFileSync(path.join(root, file))),
        violationCount: entry.ids.length,
        violationDigest: sha256(entry.ids.sort().join('\n')),
        rules: Object.fromEntries(Object.entries(entry.rules).sort(([left], [right]) => compareOrdinal(left, right)))
    })).sort((left, right) => compareOrdinal(left.path, right.path));
    const commit = command(['git', 'rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim() || 'uncommitted';
    const document = {
        schema: baselineSchema,
        generatedFrom: commit,
        configurationSha256: configurationDigest(),
        violationCount: violations.length,
        fileCount: files.length,
        files
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(document, null, 4)}\n`);
    console.log(`[frontend-style] baseline updated violations=${violations.length} path=${policy.baseline}`);
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
        writeBaseline(violations);
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
