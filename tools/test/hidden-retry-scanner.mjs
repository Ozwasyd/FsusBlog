import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, digestCanonical, sha256 } from './attempt-provenance.mjs';

export const hiddenRetryScannerVersion = 'fsusblog-hidden-retry-scanner-v1';
export const retryDispositionRegistrySchema = 'fsusblog.retry-disposition-registry.v1';

const sourceExtensions = new Set([
    '.cs',
    '.js',
    '.mjs',
    '.ps1',
    '.sh',
    '.ts',
    '.tsx',
    '.yaml',
    '.yml'
]);
const excludedDirectories = new Set([
    '.git',
    '.tmp',
    'artifacts',
    'bin',
    'coverage',
    'dist',
    'node_modules',
    'obj',
    'vendor'
]);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function portable(value)
{
    return value.replaceAll(path.sep, '/');
}

function filesUnder(root)
{
    const files = [];
    const visit = (directory) =>
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name)))
        {
            if (entry.isDirectory() && excludedDirectories.has(entry.name))
            {
                continue;
            }
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                visit(absolute);
            }
            else if (entry.isFile())
            {
                const basename = path.basename(entry.name).toLowerCase();
                if (sourceExtensions.has(path.extname(entry.name).toLowerCase())
                    || basename === 'dockerfile'
                    || basename.startsWith('dockerfile.')
                    || basename.endsWith('.dockerfile'))
                {
                    const relative = portable(path.relative(root, absolute));
                    const scannerSource = relative === 'tools/test/hidden-retry-scanner.mjs'
                        || relative === 'tools/test/check-hidden-retries.mjs';
                    const testFixtureOrAssertion = relative.startsWith('tests/tools/')
                        || /(?:^|\/)fixtures?(?:\/|$)/u.test(relative)
                        || /\.test\.[cm]?[jt]sx?$/u.test(relative);
                    if (!scannerSource && !testFixtureOrAssertion)
                    {
                        files.push(absolute);
                    }
                }
            }
        }
    };
    visit(root);
    return files;
}

function lineNumberAt(source, offset)
{
    return source.slice(0, offset).split('\n').length;
}

function positionAt(source, offset)
{
    const line = lineNumberAt(source, offset);
    const previousNewline = source.lastIndexOf('\n', Math.max(0, offset - 1));
    return { line, column: offset - previousNewline };
}

function sourceLine(source, line)
{
    return source.split(/\r?\n/u)[line - 1]?.trim() ?? '';
}

function finding({ root, file, source, offset, ruleId, producerId, evidence })
{
    const relative = portable(path.relative(root, file));
    const line = lineNumberAt(source, offset);
    const normalizedEvidence = String(evidence ?? sourceLine(source, line)).trim().replace(/\s+/gu, ' ');
    const syntaxDigest = sha256(normalizedEvidence);
    const location = {
        path: relative,
        start: positionAt(source, offset),
        end: positionAt(source, offset + String(evidence ?? '').length)
    };
    return {
        producerId,
        findingId: digestCanonical({ ruleId, location, producerId, syntaxDigest }),
        location,
        ruleId,
        syntaxDigest
    };
}

function pushMatches(findings, input, pattern, describe)
{
    for (const match of input.source.matchAll(pattern))
    {
        findings.push(finding({
            ...input,
            offset: match.index,
            evidence: match[0],
            ...describe(match, input)
        }));
    }
}

function dockerProducer(command, source, offset)
{
    if (command === 'restore')
    {
        return 'container-backend-restore';
    }
    if (command === 'build')
    {
        return 'container-backend-build';
    }
    const prior = source.slice(Math.max(0, offset - 800), offset);
    return /FROM\s+build\s+AS\s+publish-debug/iu.test(prior)
        ? 'container-backend-debug-publish'
        : 'container-backend-publish';
}

function scanDocker(input, findings)
{
    pushMatches(
        findings,
        input,
        /RUN\s+(?:sh|bash)\s+-lc\s+'for\s+[^']{0,1200}?\bdotnet\s+(restore|build|publish)\b[^']{0,2400}?\bdone(?:;[^']*)?'/gisu,
        (match) => ({
            ruleId: 'retry.docker-command-loop',
            producerId: dockerProducer(match[1].toLowerCase(), input.source, match.index)
        })
    );
}

function scanShell(input, findings)
{
    const testProducerSource = input.relative.startsWith('.github/workflows/')
        || input.relative.startsWith('tools/')
        || input.relative.startsWith('tests/');
    if (!testProducerSource)
    {
        return;
    }
    for (const match of input.source.matchAll(/(?:for\s+[^\n;]+|while\s+[^\n;]+|until\s+[^\n;]+)[^\n]*;?\s*do[\s\S]{0,2600}?\bdone/giu))
    {
        const candidate = match[0];
        if (!/(?:retry|attempt_(?:count|number)|attempt\s*(?:in\b|\+\+|\+=|=)|&&\s*exit\s+0|probe-release-reliability)/iu.test(candidate)
            || !/\b(?:node|npm|npx|pnpm|dotnet|docker|playwright|vitest|bash|sh)\b/iu.test(candidate))
        {
            continue;
        }
        findings.push(finding({
            ...input,
            offset: match.index,
            evidence: candidate,
            ruleId: 'retry.shell-command-loop',
            producerId: input.relative === 'tools/test/run-release-reliability-qualified-local.sh'
                ? 'release-reliability-runtime-smoke'
                : `shell-${createHash('sha256').update(candidate).digest('hex').slice(0, 12)}`
        }));
    }
    pushMatches(
        findings,
        input,
        /\b(node|npm|npx|pnpm|dotnet|docker|playwright|vitest|bash|sh)\b([^\n]{0,240})\|\|\s*(?:\1\b|(?:retry|rerun|run_again)\b)/giu,
        (match) => ({
            ruleId: 'retry.shell-or-reinvoke',
            producerId: `shell-${createHash('sha256').update(match[0]).digest('hex').slice(0, 12)}`
        })
    );
    pushMatches(
        findings,
        input,
        /(?:function\s+)?(?<functionName>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?\s*\{[^{}]{0,500}?if\s*!\s*(?:node|npm|npx|pnpm|dotnet|docker|playwright|vitest)\b[^;\n]{0,500};?\s*then[^{}]{0,500}?\b\k<functionName>\b/gu,
        (match) => ({
            ruleId: 'retry.shell-self-reentry',
            producerId: `shell-${match.groups.functionName.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
}

function scanNode(input, findings)
{
    const testProducerSource = input.relative.startsWith('.github/workflows/')
        || input.relative.startsWith('tools/')
        || input.relative.startsWith('tests/');
    if (!testProducerSource)
    {
        return;
    }
    pushMatches(
        findings,
        input,
        /for\s*\([^)]*attempt(?:Number)?[^)]*allowedRetries[^)]*\)[\s\S]{0,1600}?\b(?:spawn|spawnSync|execFile|execa|runCommand)\s*\(/giu,
        () => ({
            ruleId: 'retry.node-attempt-loop',
            producerId: input.relative === 'tools/ci/run-flaky-governed.mjs'
                ? 'flaky-diagnostic-runner'
                : `node-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
    pushMatches(
        findings,
        input,
        /(?:async\s+)?function\s+(?<functionName>[A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{(?=[\s\S]{0,1400}?\b(?:spawn|execFile|fetch|page\.goto)\s*\()[\s\S]{0,1400}?catch[\s\S]{0,500}?\breturn\s+(?:await\s+)?\k<functionName>\s*\(/gu,
        (match) => ({
            ruleId: 'retry.node-self-reentry',
            producerId: `node-${match.groups.functionName.replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
    pushMatches(
        findings,
        input,
        /try\s*\{[\s\S]{0,900}?\b(?<producerCall>spawn|spawnSync|execFile|execa|run[A-Z][A-Za-z0-9]*|warm)\s*\([^}]{0,1500}\}\s*catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,1500}?\b\k<producerCall>\s*\(/gu,
        (match) => ({
            ruleId: 'retry.node-catch-reinvoke',
            producerId: `node-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}-${match.groups.producerCall.toLowerCase()}`
        })
    );
    pushMatches(
        findings,
        input,
        /\b(?:for|while)\s*\([^)]*(?:attempt|retry)[^)]*\)[\s\S]{0,1200}?\b(?:fetch|page\.reload|page\.goto|evaluate|spawn|execFile|cleanup[A-Z][A-Za-z0-9]*)\s*\(/giu,
        () => ({
            ruleId: 'retry.node-producer-loop',
            producerId: `node-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
    pushMatches(
        findings,
        input,
        /while\s*\(true\)\s*\{(?=[\s\S]{0,2400}?\b(?:consecutiveTransportRetries|retryDelayMs))(?=[\s\S]{0,2400}?\bnavigate\s*\()[\s\S]{0,2400}?\}/giu,
        () => ({
            ruleId: 'retry.http-wrapper-loop',
            producerId: `http-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
    if (/(?:--resume-failed|resumeFrom|resume-from)[\s\S]{0,8000}?(?:status\s*!==?\s*['"](?:success|passed|ok)['"]|failed)[\s\S]{0,8000}?(?:spawn|execFile|run[A-Z])/u.test(input.source))
    {
        const offset = Math.max(0, input.source.search(/(?:--resume-failed|resumeFrom|resume-from)/u));
        findings.push(finding({
            ...input,
            offset,
            ruleId: 'retry.resume-failed-reexecution',
            producerId: `resume-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`,
            evidence: sourceLine(input.source, lineNumberAt(input.source, offset))
        }));
    }
    for (const [anchor, required, producerId] of [
        ['checkpoint.resumeCandidates', "previousTier?.status !== 'success'", 'resume-test-matrix-tier'],
        ["options['resume-from']", 'readResumeRuns', 'resume-runtime-publish-profile'],
        ["readBooleanFlag('FSUSBLOG_UX_VIEWPORT_RESUME')", 'status', 'resume-ux-viewport-group'],
        ["readBooleanFlag('FSUSBLOG_PUBLIC_REFRESH_RESUME')", 'status', 'resume-public-refresh-group']
    ])
    {
        const offset = input.source.indexOf(anchor);
        if (offset >= 0 && input.source.includes(required)
            && !findings.some((item) => item.producerId === producerId))
        {
            findings.push(finding({
                ...input,
                offset,
                ruleId: 'retry.resume-failed-reexecution',
                producerId,
                evidence: sourceLine(input.source, lineNumberAt(input.source, offset))
            }));
        }
    }
}

function scanCsharp(input, findings)
{
    if (!input.relative.startsWith('tools/') && !input.relative.startsWith('tests/'))
    {
        return;
    }
    pushMatches(
        findings,
        input,
        /(?:for|while)\s*\([^)]*(?:attempt|retry)[^)]*\)\s*\{[\s\S]{0,1800}?\b(?:Process\.Start|RunAsync|ExecuteAsync)\s*\(/giu,
        () => ({
            ruleId: 'retry.csharp-attempt-loop',
            producerId: `csharp-${path.basename(input.file, '.cs').replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
    pushMatches(
        findings,
        input,
        /try\s*\{[\s\S]{0,1000}?\b(?<producerCall>RunAsync|ExecuteAsync|StartAsync)\s*\([^}]{0,1000}\}\s*catch(?:\s*\([^)]*\))?\s*\{[\s\S]{0,1000}?\b\k<producerCall>\s*\(/gu,
        (match) => ({
            ruleId: 'retry.csharp-catch-reinvoke',
            producerId: `csharp-${path.basename(input.file, '.cs').replace(/[^a-z0-9]+/giu, '-').toLowerCase()}-${match.groups.producerCall.toLowerCase()}`
        })
    );
}

function scanFrameworkConfig(input, findings)
{
    if (!/(?:playwright|vitest|test|spec|config)/iu.test(input.relative))
    {
        return;
    }
    pushMatches(
        findings,
        input,
        /\bretries\s*[:=]\s*(?:[1-9][0-9]*|[^\n,;}]*\?\s*[1-9][0-9]*\s*:)/giu,
        () => ({
            ruleId: 'retry.framework-config',
            producerId: `framework-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
}

function scanDependencyClientRetry(input, findings)
{
    pushMatches(
        findings,
        input,
        /\b(?:npm\s+ci[\s\S]{0,1200}?--fetch-retries[= ](?:[1-9][0-9]*)|curl\b[\s\S]{0,500}?--retry\s+(?:[1-9][0-9]*))/giu,
        () => ({
            ruleId: 'retry.dependency-client-option',
            producerId: `transfer-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
}

function scanWorkflow(input, findings)
{
    if (!input.relative.startsWith('.github/workflows/'))
    {
        return;
    }
    pushMatches(
        findings,
        input,
        /continue-on-error:\s*true[\s\S]{0,1600}?\brun:\s*[^\n]*(?:test|build|publish|playwright|vitest)/giu,
        () => ({
            ruleId: 'retry.ci-continue-second-run',
            producerId: `workflow-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
}

function scanTimeoutRerun(input, findings)
{
    pushMatches(
        findings,
        input,
        /\btimeout\b[^\n]{0,300}\b(node|npm|npx|pnpm|dotnet|playwright|vitest)\b[\s\S]{0,700}?\b\1\b/giu,
        () => ({
            ruleId: 'retry.timeout-rerun',
            producerId: `timeout-${path.basename(input.file, path.extname(input.file)).replace(/[^a-z0-9]+/giu, '-').toLowerCase()}`
        })
    );
}

function scanSource(root, file, sourceBytes = null)
{
    const source = sourceBytes === null ? fs.readFileSync(file, 'utf8') : sourceBytes.toString('utf8');
    const relative = portable(path.relative(root, file));
    const input = { root, file, relative, source };
    const findings = [];
    const basename = path.basename(file).toLowerCase();
    if (basename === 'dockerfile' || basename.startsWith('dockerfile.') || basename.endsWith('.dockerfile'))
    {
        scanDocker(input, findings);
    }
    const extension = path.extname(file).toLowerCase();
    if (extension === '.sh' || extension === '.ps1')
    {
        scanShell(input, findings);
    }
    if (['.js', '.mjs', '.ts', '.tsx'].includes(extension))
    {
        scanNode(input, findings);
    }
    if (extension === '.cs')
    {
        scanCsharp(input, findings);
    }
    scanFrameworkConfig(input, findings);
    scanDependencyClientRetry(input, findings);
    scanWorkflow(input, findings);
    scanTimeoutRerun(input, findings);
    return findings;
}

export function scanHiddenRetries(root, { files = null } = {})
{
    const normalizedRoot = fs.realpathSync(root);
    const candidates = files === null
        ? filesUnder(normalizedRoot)
        : files.map((file) => path.resolve(normalizedRoot, file));
    const findings = candidates.flatMap((file) => scanSource(normalizedRoot, file));
    findings.sort((left, right) => (
        left.location.path.localeCompare(right.location.path)
        || left.location.start.line - right.location.start.line
        || left.location.start.column - right.location.start.column
        || left.ruleId.localeCompare(right.ruleId)
        || left.producerId.localeCompare(right.producerId)
        || left.findingId.localeCompare(right.findingId)
    ));
    return Object.freeze({
        schema: 'fsusblog.hidden-retry-scan.v1',
        scannerVersion: hiddenRetryScannerVersion,
        findings: Object.freeze(findings),
        contentDigest: digestCanonical(findings)
    });
}

function readLiteralRetrySource(root, relative)
{
    if (typeof relative !== 'string' || !relative || path.posix.isAbsolute(relative)
        || /[\\*?\0]/u.test(relative) || path.posix.normalize(relative) !== relative
        || relative === '..' || relative.startsWith('../'))
    {
        throw new Error('retry disposition source requires a literal repository-relative path');
    }
    const repository = fs.realpathSync(root);
    const file = path.resolve(repository, relative);
    if (!file.startsWith(repository + path.sep) || portable(path.relative(repository, file)) !== relative)
    {
        throw new Error('retry disposition source requires a literal repository-relative path');
    }
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || fs.realpathSync(file) !== file)
    {
        throw new Error(`retry disposition source must be a literal regular file: ${relative}`);
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try
    {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        const current = fs.lstatSync(file, { bigint: true });
        const sameEpoch = (stat) => stat.isFile()
            && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((field) => stat[field] === before[field]);
        if (![opened, after, current].every(sameEpoch) || fs.realpathSync(file) !== file)
        {
            throw new Error(`retry disposition source changed during literal read: ${relative}`);
        }
        return { repository, file, bytes };
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

const reviewedSourceFields = [
    'producerId', 'path', 'ruleId', 'classification', 'policyId',
    'action', 'owner', 'sourceText', 'syntaxText'
];
const reviewedSemanticFields = ['producerId', 'ruleId', 'classification', 'policyId', 'action', 'owner'];

export function assertUniquePriorRetryDispositionOwners(entries)
{
    if (!Array.isArray(entries))
    {
        throw new Error('independent prior retry disposition entries are required');
    }
    const identities = new Set();
    for (const entry of entries)
    {
        const key = [entry.producerId, entry.location.path, entry.ruleId, entry.syntaxDigest].join('\0');
        if (identities.has(key))
        {
            throw new Error(`duplicate prior retry semantic owner: ${entry.location.path}`);
        }
        identities.add(key);
    }
}

// Reviewed source is an input to ordinary validation, not permission to approve a new disposition.
export function resolveReviewedRetryDispositions(root, findings, {
    reviewedSources = [],
    priorEntries = []
} = {})
{
    if (!Array.isArray(reviewedSources) || !Array.isArray(findings) || !Array.isArray(priorEntries))
    {
        throw new Error('reviewed retry sources, scanner findings and prior entries must be arrays');
    }
    const identities = new Set();
    return reviewedSources.map((review) =>
    {
        if (!review || Object.keys(review).sort().join(',') !== [...reviewedSourceFields].sort().join(',')
            || !/^[a-z][a-z0-9-]*$/u.test(review.producerId)
            || !/^retry\.[a-z0-9.-]+$/u.test(review.ruleId)
            || review.ruleId === 'retry.shell-command-loop'
            || typeof review.path !== 'string' || !review.path.startsWith('tests/')
            || /[\\*?\0]/u.test(review.path) || path.posix.normalize(review.path) !== review.path
            || review.classification !== 'non-retry' || review.policyId !== null
            || review.action !== 'restore-only' || typeof review.owner !== 'string' || !review.owner.trim()
            || typeof review.sourceText !== 'string' || !review.sourceText
            || typeof review.syntaxText !== 'string' || !review.syntaxText.trim())
        {
            throw new Error('reviewed retry sources require exact raw source and explicit non-retry semantics');
        }
        const identity = [review.producerId, review.path, review.ruleId].join('\0');
        if (identities.has(identity))
        {
            throw new Error(`duplicate reviewed retry source: ${review.path}`);
        }
        identities.add(identity);
        if (!fs.existsSync(path.resolve(root, review.path)))
        {
            throw new Error(`missing reviewed retry source: ${review.path}`);
        }
        const source = readLiteralRetrySource(root, review.path);
        if (!source.bytes.equals(Buffer.from(review.sourceText, 'utf8')))
        {
            throw new Error(`reviewed retry source drift: ${review.path}`);
        }
        const syntaxDigest = sha256(review.syntaxText.trim().replace(/\s+/gu, ' '));
        const matches = findings.filter((item) => item.producerId === review.producerId
            && item.location.path === review.path && item.ruleId === review.ruleId
            && item.syntaxDigest === syntaxDigest);
        const actual = scanSource(source.repository, source.file, source.bytes).filter((item) => (
            item.producerId === review.producerId && item.ruleId === review.ruleId
            && item.syntaxDigest === syntaxDigest
        ));
        if (matches.length !== 1 || actual.length !== 1
            || canonicalJson(matches[0]) !== canonicalJson(actual[0]))
        {
            throw new Error(`reviewed retry source requires exactly one original scanner finding: ${review.path}`);
        }
        const finding = actual[0];
        const prior = priorEntries.filter((entry) => entry.producerId === finding.producerId
            && entry.location.path === finding.location.path && entry.ruleId === finding.ruleId
            && entry.syntaxDigest === finding.syntaxDigest);
        if (prior.length > 1)
        {
            throw new Error(`duplicate prior reviewed retry disposition: ${review.path}`);
        }
        if (prior.length === 1 && reviewedSemanticFields.some((field) => prior[0][field] !== review[field]))
        {
            throw new Error(`conflicting prior reviewed retry disposition: ${review.path}`);
        }
        return Object.freeze({
            finding: Object.freeze(finding),
            disposition: Object.freeze(Object.fromEntries(reviewedSemanticFields.map((field) => [field, review[field]])))
        });
    });
}

function validateDispositionEntry(root, entry, policies)
{
    const allowed = [
        'producerId',
        'findingId',
        'location',
        'ruleId',
        'classification',
        'policyId',
        'action',
        'owner',
        'sourceDigest',
        'syntaxDigest'
    ];
    const unknown = Object.keys(entry ?? {}).filter((key) => !allowed.includes(key));
    if (unknown.length > 0)
    {
        throw new Error(`disposition contains unknown fields: ${unknown.join(', ')}`);
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(entry?.producerId ?? ''))
    {
        throw new Error('disposition producerId is invalid');
    }
    const location = entry.location;
    if (!location || typeof location !== 'object' || Array.isArray(location)
        || Object.keys(location).sort().join(',') !== 'end,path,start'
        || typeof location.path !== 'string' || !location.path
        || /[*?]/u.test(location.path)
        || !location.start || !location.end
        || !Number.isInteger(location.start.line) || location.start.line < 1
        || !Number.isInteger(location.start.column) || location.start.column < 1
        || !Number.isInteger(location.end.line) || location.end.line < location.start.line
        || !Number.isInteger(location.end.column) || location.end.column < 1)
    {
        throw new Error(`${entry.producerId} disposition must use an exact file:line location`);
    }
    if (!digestPattern.test(entry.findingId ?? '') || !digestPattern.test(entry.syntaxDigest ?? ''))
    {
        throw new Error(`${entry.producerId} disposition finding identity is invalid`);
    }
    if (!/^retry\.[a-z0-9.-]+$/u.test(entry.ruleId ?? ''))
    {
        throw new Error(`${entry.producerId} disposition ruleId is invalid`);
    }
    if (!['correctness', 'diagnostic', 'restore-transfer', 'non-retry'].includes(entry.classification))
    {
        throw new Error(`${entry.producerId} disposition classification is invalid`);
    }
    if (!['diagnostic-only', 'instrument', 'remove', 'restore-only'].includes(entry.action))
    {
        throw new Error(`${entry.producerId} disposition action is invalid`);
    }
    if (entry.classification === 'non-retry')
    {
        if (entry.policyId !== null)
        {
            throw new Error(`${entry.producerId} non-retry disposition cannot bind a retry policy`);
        }
        if (entry.ruleId === 'retry.shell-command-loop')
        {
            throw new Error(`${entry.producerId} shell command loop cannot be classified as non-retry`);
        }
    }
    else if (!policies.has(entry.policyId))
    {
        throw new Error(`${entry.producerId} disposition references an unknown policy`);
    }
    if (typeof entry.owner !== 'string' || !entry.owner.trim())
    {
        throw new Error(`${entry.producerId} disposition owner is required`);
    }
    if (!digestPattern.test(entry.sourceDigest ?? ''))
    {
        throw new Error(`${entry.producerId} disposition sourceDigest is invalid`);
    }
    if (!fs.existsSync(path.resolve(root, location.path)))
    {
        throw new Error(`${entry.producerId} disposition source digest is stale`);
    }
    if (sha256(readLiteralRetrySource(root, location.path).bytes) !== entry.sourceDigest)
    {
        throw new Error(`${entry.producerId} disposition source digest is stale`);
    }
    return entry.findingId;
}

export function validateRetryDispositionRegistry(root, document, scan, policyRegistry, {
    reviewedSources = [],
    priorEntries = null
} = {})
{
    if (document?.schema !== retryDispositionRegistrySchema
        || document.scannerVersion !== hiddenRetryScannerVersion
        || document.sourceDigestAlgorithm !== 'sha256'
        || !Array.isArray(document.entries))
    {
        throw new Error('retry disposition registry header is invalid');
    }
    const policyMap = policyRegistry?.policies instanceof Map
        ? policyRegistry.policies
        : new Map();
    const keys = document.entries.map((entry) => validateDispositionEntry(root, entry, policyMap));
    if (new Set(keys).size !== keys.length)
    {
        throw new Error('retry disposition registry contains duplicate exact locations');
    }
    const sorted = [...document.entries].sort((left, right) => (
        left.location.path.localeCompare(right.location.path)
        || left.location.start.line - right.location.start.line
        || left.location.start.column - right.location.start.column
        || left.ruleId.localeCompare(right.ruleId)
        || left.findingId.localeCompare(right.findingId)
    ));
    if (canonicalJson(sorted) !== canonicalJson(document.entries))
    {
        throw new Error('retry disposition registry entries must use stable location/rule ordering');
    }
    const unsigned = { ...document };
    delete unsigned.contentDigest;
    if (document.contentDigest !== digestCanonical(unsigned))
    {
        throw new Error('retry disposition registry content digest mismatch');
    }
    const dispositions = new Map(document.entries.map((entry) => [
        entry.findingId,
        entry
    ]));
    const unregistered = scan.findings.filter((item) => !dispositions.has(item.findingId));
    const stale = document.entries.filter((item) => !scan.findings.some((findingItem) => (
        findingItem.findingId === item.findingId
        && canonicalJson(findingItem.location) === canonicalJson(item.location)
        && findingItem.ruleId === item.ruleId
        && findingItem.syntaxDigest === item.syntaxDigest
    )));
    if (unregistered.length > 0 || stale.length > 0)
    {
        const summary = [
            ...unregistered.map((item) => `unregistered ${item.ruleId} at ${item.location.path}:${item.location.start.line}:${item.location.start.column}`),
            ...stale.map((item) => `stale ${item.ruleId} at ${item.location.path}:${item.location.start.line}:${item.location.start.column}`)
        ];
        throw new Error(summary.join('\n'));
    }
    assertUniquePriorRetryDispositionOwners(priorEntries);
    if (priorEntries === document.entries)
    {
        throw new Error('candidate retry disposition entries cannot serve as their own independent prior');
    }
    const reviews = resolveReviewedRetryDispositions(root, scan.findings, { reviewedSources, priorEntries });
    const reviewedFindingIds = new Set(reviews.map((review) => review.finding.findingId));
    for (const entry of document.entries)
    {
        const exact = priorEntries.filter((prior) => prior.findingId === entry.findingId);
        const semantic = priorEntries.filter((prior) => prior.producerId === entry.producerId
            && prior.location.path === entry.location.path && prior.ruleId === entry.ruleId
            && prior.syntaxDigest === entry.syntaxDigest);
        const candidates = exact.length === 1 ? exact : semantic;
        if (candidates.length !== 1)
        {
            throw new Error(`retry disposition requires a unique existing prior owner: ${entry.location.path}`);
        }
        const prior = candidates[0];
        if (reviewedSemanticFields.some((field) => prior[field] !== entry[field]))
        {
            throw new Error(`conflicting prior reviewed retry disposition: ${entry.location.path}`);
        }
        const exactBinding = ['findingId', 'producerId', 'ruleId', 'syntaxDigest', 'sourceDigest']
            .every((field) => prior[field] === entry[field])
            && canonicalJson(prior.location) === canonicalJson(entry.location);
        if (!exactBinding && !reviewedFindingIds.has(entry.findingId))
        {
            throw new Error(`changed retry source or finding requires an exact raw source review: ${entry.location.path}`);
        }
    }
    return Object.freeze({
        document, scan, warnings: Object.freeze([]),
        qualificationEligible: false,
        status: 'source-validation-only'
    });
}

export function sourceDigest(file)
{
    return sha256(fs.readFileSync(file));
}
