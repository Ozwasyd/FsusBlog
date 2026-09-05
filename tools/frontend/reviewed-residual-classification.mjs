#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const reviewedResidualSchema = 'fsusblog.frontend-style-reviewed-residual.v1';
export const reviewedResidualAuthorityPath = 'config/development/frontend-style-reviewed-residual.json';
export const reviewedResidualAuthorityRef = 'refs/remotes/origin/master';
export const reviewedResidualRule = 'eslint/import-x/no-relative-parent-imports';

const expectedTopLevelKeys = [
    'schema',
    'status',
    'reviewIssue',
    'consumerIssue',
    'reviewBaseCommit',
    'reviewBaseProjectionSha256',
    'priorConsumerProjectionSha256',
    'pathCount',
    'diagnosticCount',
    'otherDiagnosticCount',
    'ruleCounts',
    'diagnosticSetSha256',
    'reason',
    'terminalCondition',
    'entries'
];
const expectedEntryKeys = [
    'path',
    'sourceSha256',
    'diagnosticCount',
    'ruleCounts',
    'diagnosticDigest',
    'priorOwnerCommit',
    'reviewIssue',
    'consumerIssue',
    'reviewBaseBaseline',
    'priorConsumerBaseline',
    'reason',
    'terminalCondition',
    'diagnostics'
];
const expectedDiagnosticKeys = [
    'line',
    'column',
    'endLine',
    'endColumn',
    'identity',
    'messageSha256'
];

function sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function compareOrdinal(left, right)
{
    return left === right ? 0 : left < right ? -1 : 1;
}

function exactOrderedKeys(value, expected)
{
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
}

function validRelativePath(value)
{
    return typeof value === 'string'
        && value.length > 0
        && !path.isAbsolute(value)
        && !value.includes('\\')
        && !value.includes('*')
        && !value.split('/').includes('..')
        && /^(tests|tools)\//u.test(value);
}

function validSha256(value)
{
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validCommit(value)
{
    return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function command(root, args)
{
    return spawnSync(args[0], args.slice(1), {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
}

function commitExists(root, commit)
{
    return command(root, ['git', 'cat-file', '-e', `${commit}^{commit}`]).status === 0;
}

function commitIsAncestor(root, commit, descendant)
{
    return command(root, ['git', 'merge-base', '--is-ancestor', commit, descendant]).status === 0;
}

function commitTouchesPath(root, commit, relativePath)
{
    const result = command(root, [
        'git',
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '-r',
        commit,
        '--',
        relativePath
    ]);
    return result.status === 0 && result.stdout.split(/\r?\n/u).includes(relativePath);
}

function latestOwnerCommit(root, reviewBaseCommit, relativePath)
{
    const result = command(root, [
        'git',
        'log',
        '-1',
        '--no-merges',
        '--format=%H',
        reviewBaseCommit,
        '--',
        relativePath
    ]);
    return result.status === 0 ? result.stdout.trim() : '';
}

function baselineAt(root, revision)
{
    const result = command(root, [
        'git',
        'show',
        `${revision}:config/development/frontend-style-baseline.json`
    ]);
    try
    {
        const document = result.status === 0 ? JSON.parse(result.stdout) : null;
        if (document?.schema !== 'fsusblog.frontend-style-baseline.v1'
            || !Array.isArray(document.files))
        {
            return null;
        }
        const byPath = new Map(document.files.map((entry) => [entry.path, entry]));
        return byPath.size === document.files.length ? byPath : null;
    }
    catch
    {
        return null;
    }
}

function canonicalDiagnosticOrder(left, right)
{
    return compareOrdinal(left.identity, right.identity);
}

function canonicalRuleCounts(count)
{
    return { [reviewedResidualRule]: count };
}

function validBaselineEntry(value, entryPath)
{
    return value === null || (exactOrderedKeys(value, [
        'path',
        'sourceSha256',
        'violationCount',
        'violationDigest',
        'rules'
    ])
        && value.path === entryPath
        && validSha256(value.sourceSha256)
        && Number.isInteger(value.violationCount)
        && value.violationCount >= 0
        && validSha256(value.violationDigest)
        && value.rules !== null
        && typeof value.rules === 'object'
        && !Array.isArray(value.rules)
        && Object.entries(value.rules).every(([rule, count]) => rule.length > 0
            && Number.isInteger(count)
            && count > 0)
        && Object.keys(value.rules).every((rule, index, rules) => index === 0
            || compareOrdinal(rules[index - 1], rule) < 0)
        && Object.values(value.rules).reduce((sum, count) => sum + count, 0) === value.violationCount);
}

function projectionDigest(entries, field)
{
    return sha256(entries.map((entry) => `${entry.path}\n${JSON.stringify(entry[field])}`).join('\n'));
}

function sameJson(left, right)
{
    return JSON.stringify(left) === JSON.stringify(right);
}

export function validateReviewedResidualDocument(document, bytes, {
    root,
    expectedReviewBaseCommit = 'e53f69945508205dd605bd85787f58f63e5f902c'
})
{
    const failures = [];
    const reject = (message) => failures.push(message);
    if (!exactOrderedKeys(document, expectedTopLevelKeys)
        || document.schema !== reviewedResidualSchema
        || document.status !== 'closed-reviewed'
        || document.reviewIssue !== 3191
        || document.consumerIssue !== 3075
        || document.reviewBaseCommit !== expectedReviewBaseCommit
        || !validSha256(document.reviewBaseProjectionSha256)
        || !validSha256(document.priorConsumerProjectionSha256)
        || document.pathCount !== 149
        || document.diagnosticCount !== 329
        || document.otherDiagnosticCount !== 0
        || !sameJson(document.ruleCounts, canonicalRuleCounts(329))
        || !validSha256(document.diagnosticSetSha256)
        || typeof document.reason !== 'string'
        || document.reason.trim().length < 24
        || document.terminalCondition !== 'complete-baseline-consumption-once'
        || !Array.isArray(document.entries)
        || document.entries.length !== 149)
    {
        reject(`authority is not a closed ${reviewedResidualSchema} document`);
        return failures;
    }
    const canonicalBytes = `${JSON.stringify(document, null, 4)}\n`;
    if (bytes !== canonicalBytes)
    {
        reject('authority bytes are not canonical four-space JSON with one terminal newline');
    }
    if (!commitExists(root, document.reviewBaseCommit))
    {
        reject('authority source commits are missing from the repository');
    }
    const reviewBaselineByPath = baselineAt(root, document.reviewBaseCommit);
    if (!reviewBaselineByPath)
    {
        reject('authority review base baseline is missing or invalid');
    }
    const paths = new Set();
    const identities = new Set();
    let diagnosticCount = 0;
    for (let index = 0; index < document.entries.length; index += 1)
    {
        const entry = document.entries[index];
        if (!exactOrderedKeys(entry, expectedEntryKeys))
        {
            reject(`entry ${index} has missing, extra, or reordered fields`);
            continue;
        }
        if (!validRelativePath(entry.path) || paths.has(entry.path))
        {
            reject(`entry ${index} has invalid or duplicate path ${entry.path ?? '<unknown>'}`);
            continue;
        }
        paths.add(entry.path);
        if (index > 0 && compareOrdinal(document.entries[index - 1].path, entry.path) >= 0)
        {
            reject(`authority paths are not in canonical order at ${entry.path}`);
        }
        if (!validSha256(entry.sourceSha256)
            || !Number.isInteger(entry.diagnosticCount)
            || entry.diagnosticCount <= 0
            || !sameJson(entry.ruleCounts, canonicalRuleCounts(entry.diagnosticCount))
            || !validSha256(entry.diagnosticDigest)
            || !validCommit(entry.priorOwnerCommit)
            || entry.reviewIssue !== document.reviewIssue
            || entry.consumerIssue !== document.consumerIssue
            || !validBaselineEntry(entry.reviewBaseBaseline, entry.path)
            || !validBaselineEntry(entry.priorConsumerBaseline, entry.path)
            || typeof entry.reason !== 'string'
            || entry.reason.trim().length < 24
            || entry.terminalCondition !== 'source-content-change-or-complete-consumption'
            || !Array.isArray(entry.diagnostics)
            || entry.diagnostics.length !== entry.diagnosticCount)
        {
            reject(`entry ${entry.path} has an invalid closed classification`);
            continue;
        }
        const expectedReviewBaseline = reviewBaselineByPath?.get(entry.path) ?? null;
        if (!sameJson(entry.reviewBaseBaseline, expectedReviewBaseline))
        {
            reject(`entry ${entry.path} review-base baseline projection is stale`);
        }
        const entryIdentities = [];
        for (let diagnosticIndex = 0; diagnosticIndex < entry.diagnostics.length; diagnosticIndex += 1)
        {
            const diagnostic = entry.diagnostics[diagnosticIndex];
            if (!exactOrderedKeys(diagnostic, expectedDiagnosticKeys)
                || !Number.isInteger(diagnostic.line)
                || diagnostic.line <= 0
                || !Number.isInteger(diagnostic.column)
                || diagnostic.column <= 0
                || !Number.isInteger(diagnostic.endLine)
                || diagnostic.endLine < diagnostic.line
                || !Number.isInteger(diagnostic.endColumn)
                || diagnostic.endColumn <= 0
                || !validSha256(diagnostic.messageSha256))
            {
                reject(`entry ${entry.path} has invalid diagnostic ${diagnosticIndex}`);
                continue;
            }
            const expectedIdentity = `eslint:import-x/no-relative-parent-imports:${entry.path}:${diagnostic.line}:${diagnostic.column}:${diagnostic.messageSha256.slice(0, 16)}`;
            if (diagnostic.identity !== expectedIdentity || identities.has(diagnostic.identity))
            {
                reject(`entry ${entry.path} has stale or duplicate diagnostic identity ${diagnostic.identity ?? '<unknown>'}`);
            }
            identities.add(diagnostic.identity);
            entryIdentities.push(diagnostic.identity);
            if (diagnosticIndex > 0
                && canonicalDiagnosticOrder(entry.diagnostics[diagnosticIndex - 1], diagnostic) >= 0)
            {
                reject(`entry ${entry.path} diagnostics are not in canonical order`);
            }
        }
        if (sha256([...entryIdentities].sort(compareOrdinal).join('\n')) !== entry.diagnosticDigest)
        {
            reject(`entry ${entry.path} diagnostic digest is stale`);
        }
        if (!commitIsAncestor(root, entry.priorOwnerCommit, document.reviewBaseCommit)
            || !commitTouchesPath(root, entry.priorOwnerCommit, entry.path)
            || latestOwnerCommit(root, document.reviewBaseCommit, entry.path) !== entry.priorOwnerCommit)
        {
            reject(`entry ${entry.path} prior owner commit is not an ancestor that touches the path`);
        }
        diagnosticCount += entry.diagnosticCount;
    }
    if (paths.size !== document.pathCount
        || diagnosticCount !== document.diagnosticCount
        || identities.size !== document.diagnosticCount)
    {
        reject('authority aggregate path or diagnostic count is stale');
    }
    if (sha256([...identities].sort(compareOrdinal).join('\n')) !== document.diagnosticSetSha256)
    {
        reject('authority aggregate diagnostic digest is stale');
    }
    if (projectionDigest(document.entries, 'reviewBaseBaseline') !== document.reviewBaseProjectionSha256
        || projectionDigest(document.entries, 'priorConsumerBaseline') !== document.priorConsumerProjectionSha256)
    {
        reject('authority aggregate baseline projection digest is stale');
    }
    return failures;
}

export function reviewedResidualConsumptionRequired(document, currentByPath, previousByPath)
{
    return document.entries.some((entry) =>
    {
        const current = currentByPath.get(entry.path);
        const previous = previousByPath.get(entry.path) ?? null;
        return current?.sourceSha256 === entry.sourceSha256
            && (!previous
                || previous.sourceSha256 !== entry.sourceSha256
                || previous.violationCount !== current.violationCount
                || previous.violationDigest !== current.violationDigest
                || !sameJson(previous.rules, current.rules));
    });
}

export function validateReviewedResidualConsumption({
    root,
    authorityPath,
    authorityRef = reviewedResidualAuthorityRef,
    expectedReviewBaseCommit = 'e53f69945508205dd605bd85787f58f63e5f902c',
    currentByPath,
    previousByPath,
    violationsByPath
})
{
    const failures = [];
    const relative = path.relative(root, path.resolve(root, authorityPath)).split(path.sep).join('/');
    const absolute = path.join(root, relative);
    if (relative !== reviewedResidualAuthorityPath)
    {
        failures.push(`reviewed residual authority path must be ${reviewedResidualAuthorityPath}`);
        return failures;
    }
    let bytes;
    let document;
    try
    {
        bytes = fs.readFileSync(absolute, 'utf8');
        document = JSON.parse(bytes);
    }
    catch (error)
    {
        failures.push(`missing or invalid reviewed residual authority ${relative}: ${error.message}`);
        return failures;
    }
    failures.push(...validateReviewedResidualDocument(document, bytes, { root, expectedReviewBaseCommit }));
    const authority = command(root, ['git', 'show', `${authorityRef}:${relative}`]);
    const authorityCommit = command(root, ['git', 'rev-parse', '--verify', authorityRef]);
    if (authority.status !== 0
        || authorityCommit.status !== 0
        || authority.stdout !== bytes
        || !commitIsAncestor(root, authorityCommit.stdout.trim(), 'HEAD'))
    {
        failures.push(`reviewed residual authority must already exist unchanged on an ancestor at ${authorityRef}`);
    }
    if (!commitIsAncestor(root, document.reviewBaseCommit, authorityRef))
    {
        failures.push('reviewed residual source authority is not in the required consumer ancestry');
    }
    const remoteBaselineByPath = baselineAt(root, authorityRef);
    if (!remoteBaselineByPath)
    {
        failures.push(`reviewed residual requires a valid pre-consumption baseline at ${authorityRef}`);
    }
    else if (document.entries.some((entry) => !sameJson(
        remoteBaselineByPath.get(entry.path) ?? null,
        entry.reviewBaseBaseline
    )))
    {
        failures.push(`reviewed residual authority was consumed or its remote baseline projection drifted at ${authorityRef}`);
    }
    const consumedIdentities = new Set();
    for (const entry of document.entries)
    {
        const current = currentByPath.get(entry.path);
        const previous = previousByPath.get(entry.path) ?? null;
        const actualViolations = violationsByPath.get(entry.path) ?? [];
        if (!current
            || current.sourceSha256 !== entry.sourceSha256
            || current.violationCount !== entry.diagnosticCount
            || current.violationDigest !== entry.diagnosticDigest
            || !sameJson(current.rules, entry.ruleCounts))
        {
            failures.push(`reviewed residual source, rule, or diagnostic identity is stale or partially consumed for ${entry.path}`);
            continue;
        }
        if (!sameJson(previous, entry.priorConsumerBaseline))
        {
            failures.push(`reviewed residual prior baseline projection is stale or already consumed for ${entry.path}`);
            continue;
        }
        const actualByIdentity = new Map(actualViolations.map((violation) => [violation.id, violation]));
        if (actualByIdentity.size !== actualViolations.length)
        {
            failures.push(`current frontend diagnostics contain duplicate identities for ${entry.path}`);
            continue;
        }
        if (actualViolations.length !== entry.diagnosticCount)
        {
            failures.push(`reviewed residual contains extra or missing diagnostics for ${entry.path}`);
            continue;
        }
        let entryExact = true;
        for (const classified of entry.diagnostics)
        {
            const actual = actualByIdentity.get(classified.identity);
            const actualMessageSha256 = actual
                ? actual.messageSha256 ?? sha256(actual.message)
                : null;
            if (!actual
                || `${actual.tool}/${actual.rule}` !== reviewedResidualRule
                || actual.line !== classified.line
                || actual.column !== classified.column
                || actual.endLine !== classified.endLine
                || actual.endColumn !== classified.endColumn
                || actualMessageSha256 !== classified.messageSha256
                || consumedIdentities.has(classified.identity))
            {
                failures.push(`reviewed residual diagnostic identity is stale, missing, or duplicate for ${classified.identity}`);
                entryExact = false;
                continue;
            }
            consumedIdentities.add(classified.identity);
        }
        if (!entryExact)
        {
            continue;
        }
    }
    if (consumedIdentities.size !== document.diagnosticCount)
    {
        failures.push(`reviewed residual consumption must be complete: expected ${document.diagnosticCount}, got ${consumedIdentities.size}`);
    }
    return failures;
}

function parseCli(argv)
{
    const parsed = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        const value = argv[index + 1];
        if (!['--root', '--authority'].includes(key) || !value)
        {
            throw new Error(`invalid reviewed residual argument ${key ?? '<missing>'}`);
        }
        parsed[key.slice(2)] = value;
    }
    return parsed;
}

function main()
{
    const args = parseCli(process.argv.slice(2));
    const root = path.resolve(args.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    const authorityPath = args.authority ?? reviewedResidualAuthorityPath;
    const absolute = path.resolve(root, authorityPath);
    const bytes = fs.readFileSync(absolute, 'utf8');
    const document = JSON.parse(bytes);
    const failures = validateReviewedResidualDocument(document, bytes, { root });
    if (failures.length > 0)
    {
        for (const failure of failures)
        {
            console.error(`[frontend-style-reviewed-residual] ${failure}`);
        }
        process.exitCode = 1;
        return;
    }
    console.log(`[frontend-style-reviewed-residual] ok paths=${document.pathCount} diagnostics=${document.diagnosticCount} other=${document.otherDiagnosticCount}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(`[frontend-style-reviewed-residual] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
