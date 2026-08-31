import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import commitlintConfig from '../../commitlint.config.mjs';

import { changeContract } from './change-contract-registry.mjs';

const genericSummaries = new Set([
    'apply fixes',
    'changes',
    'cleanup',
    'fix bug',
    'misc changes',
    'update stuff',
    'wip',
    'work in progress'
]);

const securityDetailPattern = /\b(?:CVE-\d{4}-\d+|authentication bypass|credential bypass|exploit chain|proof[- ]of[- ]concept|remote code execution|SQL injection|zero[- ]day)\b/iu;
const refactorClaimPattern = /\b(?:faster|latency|performance|throughput|speedup|behaviou?r change|bug fix)\b/iu;
const fullShaPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const repositoryPathPattern = /^(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[A-Za-z0-9._/\-]+$/u;

const userReleaseCategories = new Set(
    changeContract.releaseNoteCategories
        .filter((entry) => entry.audience === 'user-facing')
        .map((entry) => entry.category)
);

const allowedReleaseCategoriesByType = Object.freeze({
    feat: new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Internal/Tooling']),
    fix: new Set(['Fixed', 'Internal/Tooling']),
    perf: new Set(['Changed', 'Internal/Tooling']),
    refactor: new Set(['Internal/Tooling', 'none']),
    style: new Set(['Internal/Tooling', 'none']),
    test: new Set(['Internal/Tooling', 'none']),
    docs: new Set(['Changed', 'Internal/Tooling', 'none']),
    build: new Set(['Internal/Tooling', 'none']),
    ci: new Set(['Internal/Tooling', 'none']),
    chore: new Set(['Internal/Tooling', 'none']),
    security: new Set(['Security', 'Internal/Tooling']),
    revert: new Set(['Added', 'Changed', 'Fixed', 'Removed', 'Internal/Tooling'])
});

function commitTrailers(message)
{
    const lines = String(message ?? '').replace(/\r\n/gu, '\n').trimEnd().split('\n');
    const trailers = [];
    for (let index = lines.length - 1; index >= 0; index -= 1)
    {
        const match = lines[index].match(/^(?<key>[A-Za-z][A-Za-z0-9 -]*):\s*(?<value>\S.*?)\s*$/u);
        if (!match?.groups)
        {
            break;
        }
        trailers.unshift({ key: match.groups.key, value: match.groups.value });
    }
    return trailers;
}

function footerValue(message, key)
{
    const matches = commitTrailers(message).filter((entry) => entry.key === key);
    return matches.length === 1 ? matches[0].value : null;
}

function hasFooter(message, key)
{
    return footerValue(message, key) !== null;
}

export function parseCommitHeader(header)
{
    const match = header.match(/^(?<type>[a-z]+)\((?<scope>[a-z0-9-]+)\)(?<breaking>!)?: (?<summary>.+)$/u);
    if (!match?.groups)
    {
        return null;
    }
    return {
        type: match.groups.type,
        scope: match.groups.scope,
        breaking: match.groups.breaking === '!',
        summary: match.groups.summary
    };
}

export function pullRequestActor(event)
{
    return event?.pull_request?.user?.login ?? '';
}

export function validateCommitMessage(message, { titleOnly = false } = {})
{
    const errors = [];
    const normalized = String(message ?? '').replace(/\r\n/gu, '\n').trimEnd();
    const lines = normalized.split('\n');
    const parsed = parseCommitHeader(lines[0] ?? '');

    if (!parsed)
    {
        return ['header must use type(scope): imperative summary'];
    }

    if (!changeContract.commitTypes.includes(parsed.type))
    {
        errors.push(`type must be one of: ${changeContract.commitTypes.join(', ')}`);
    }
    if (!changeContract.commitScopes.includes(parsed.scope))
    {
        errors.push(`scope must be one of: ${changeContract.commitScopes.join(', ')}`);
    }

    const summary = parsed.summary.trim();
    if (summary.length < changeContract.summaryMinimumLength)
    {
        errors.push(`summary must contain at least ${changeContract.summaryMinimumLength} characters`);
    }
    if (lines[0].length > changeContract.summaryMaximumLength)
    {
        errors.push(`header must not exceed ${changeContract.summaryMaximumLength} characters`);
    }
    if (genericSummaries.has(summary.toLocaleLowerCase('en-US')))
    {
        errors.push('summary is generic and must describe the concrete change');
    }
    if (/\.$/u.test(summary))
    {
        errors.push('summary must not end with a period');
    }
    if (/^[A-Z]/u.test(summary))
    {
        errors.push('English summary must start with a lowercase imperative verb');
    }

    if (parsed.type === 'security' && securityDetailPattern.test(normalized))
    {
        errors.push('security commit message contains public vulnerability detail');
    }
    if (parsed.type === 'refactor' && refactorClaimPattern.test(normalized))
    {
        errors.push('refactor commit must not claim performance or behavior improvement');
    }

    if (titleOnly)
    {
        return errors;
    }

    const hasBreakingFooter = hasFooter(normalized, 'BREAKING CHANGE');
    if (parsed.breaking !== hasBreakingFooter)
    {
        errors.push('breaking changes require both ! in the header and one BREAKING CHANGE footer');
    }

    if (lines.length > 1 && lines[1] !== '')
    {
        errors.push('body must be separated from the header by a blank line');
    }
    if (!/^#\d+(?:[ ,]+#\d+)*$/u.test(footerValue(normalized, 'Refs') ?? ''))
    {
        errors.push('commit message must contain a Refs: #1234 footer');
    }

    if (parsed.type === 'perf')
    {
        const claim = footerValue(normalized, 'Performance-Claim');
        const evidence = footerValue(normalized, 'Evidence');
        if (!['S', 'M', 'R', 'C'].includes(claim))
        {
            errors.push('perf commit requires Performance-Claim: S, M, R, or C');
        }
        if (!evidence || !repositoryPathPattern.test(evidence))
        {
            errors.push('perf commit requires one repository-relative Evidence path');
        }
    }

    if (parsed.type === 'style')
    {
        const classification = footerValue(normalized, 'Change-Class');
        if (!['format-only', 'naming-only'].includes(classification))
        {
            errors.push('style commit requires Change-Class: format-only or naming-only');
        }
        if (classification === 'format-only')
        {
            const formatter = footerValue(normalized, 'Formatter');
            if (!formatter || !/^[^@\s]+@[^\s]+\s+::\s+.+$/u.test(formatter))
            {
                errors.push('format-only commit requires Formatter: identity@version :: command');
            }
            const evidence = footerValue(normalized, 'Idempotence-Evidence');
            if (!evidence || !repositoryPathPattern.test(evidence) || !evidence.endsWith('.json'))
            {
                errors.push('format-only commit requires Idempotence-Evidence: <repository-relative.json>');
            }
        }
        if (classification === 'naming-only' && footerValue(normalized, 'External-Contracts') !== 'preserved')
        {
            errors.push('naming-only commit requires External-Contracts: preserved');
        }
    }

    if (parsed.type === 'security')
    {
        if (!['private', 'not-applicable'].includes(footerValue(normalized, 'Security-Disclosure')))
        {
            errors.push('security commit requires Security-Disclosure: private or not-applicable');
        }
    }

    if (parsed.type === 'revert' && !/^[0-9a-f]{7,40}$/u.test(footerValue(normalized, 'Reverts') ?? ''))
    {
        errors.push('revert commit requires a Reverts: <commit-sha> footer');
    }

    if (parsed.type === 'refactor')
    {
        if (hasFooter(normalized, 'Performance-Claim'))
        {
            errors.push('refactor commit must not claim performance or behavior improvement');
        }
    }

    return errors;
}

function escapePattern(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseMarkdownSections(body)
{
    const sections = new Map();
    const errors = [];
    let current = null;
    let fence = null;
    let htmlComment = false;

    function visibleMarkdown(line)
    {
        let visible = '';
        let cursor = 0;
        while (cursor < line.length)
        {
            if (htmlComment)
            {
                const end = line.indexOf('-->', cursor);
                if (end < 0)
                {
                    return visible;
                }
                htmlComment = false;
                cursor = end + 3;
                continue;
            }
            const start = line.indexOf('<!--', cursor);
            if (start < 0)
            {
                return visible + line.slice(cursor);
            }
            visible += line.slice(cursor, start);
            htmlComment = true;
            cursor = start + 4;
        }
        return visible;
    }

    for (const rawLine of body.split('\n'))
    {
        if (fence !== null)
        {
            const closePattern = new RegExp(`^ {0,3}${escapePattern(fence.character)}{${fence.length},}[ \\t]*$`, 'u');
            if (closePattern.test(rawLine))
            {
                fence = null;
            }
            continue;
        }

        const line = visibleMarkdown(rawLine);
        const fenceMatch = line.match(/^ {0,3}(?<marker>`{3,}|~{3,})(?:[^\r\n]*)$/u);
        if (fenceMatch?.groups?.marker)
        {
            fence = {
                character: fenceMatch.groups.marker[0],
                length: fenceMatch.groups.marker.length
            };
            continue;
        }

        const heading = line.match(/^##\s+(?<name>[^#].*?)\s*$/u)?.groups?.name;
        if (heading)
        {
            if (sections.has(heading))
            {
                errors.push(`PR body contains duplicate section: ## ${heading}`);
            }
            else
            {
                sections.set(heading, []);
            }
            current = heading;
            continue;
        }
        if (current !== null && sections.has(current))
        {
            sections.get(current).push(line);
        }
    }
    return {
        sections: new Map([...sections].map(([name, lines]) => [name, lines.join('\n')])),
        errors
    };
}

function checkboxValue(section, label, errors)
{
    const matches = [...section.matchAll(
        new RegExp(`^-\\s*\\[(?<state>[ xX])\\]\\s*${escapePattern(label)}\\s*$`, 'gmu')
    )];
    if (matches.length > 1)
    {
        errors.push(`PR body contains duplicate checkbox: ${label}`);
    }
    if (matches.length !== 1)
    {
        return null;
    }
    return matches[0].groups.state.toLocaleLowerCase('en-US') === 'x';
}

function fieldValue(section, label, errors)
{
    const matches = [...section.matchAll(
        new RegExp(`^-\\s*${escapePattern(label)}:\\s*(?<value>.*?)\\s*$`, 'gmu')
    )];
    if (matches.length > 1)
    {
        errors.push(`PR body contains duplicate field: ${label}`);
    }
    return matches.length === 1 ? matches[0].groups.value.trim() : null;
}

function checkedChecklistCount(section)
{
    return [...section.matchAll(/^-\s*\[[xX]\]\s+\S.*$/gmu)].length;
}

function substantiveMarkdownSection(section)
{
    return section
        .split('\n')
        .map((line) => line.replace(/^\s*[-*+]\s*/u, '').trim())
        .some((line) => substantiveField(line));
}

function substantiveField(value)
{
    if (value === null || value === '')
    {
        return false;
    }
    return !/^(?:n\/?a|tbd|todo|placeholder|<.+>|.+\s+\/\s+.+)$/iu.test(value);
}

function repositoryPaths(value)
{
    if (!substantiveField(value))
    {
        return [];
    }
    const paths = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    return paths.every((path) => repositoryPathPattern.test(path)) ? paths : [];
}

function sameStrings(left, right)
{
    return left.length === right.length
        && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function readFileAtRevision(root, revision, path)
{
    if (!repositoryPathPattern.test(path))
    {
        throw new Error(`invalid repository path: ${path}`);
    }
    return execFileSync('git', ['show', `${revision}:${path}`], { cwd: root });
}

function readJsonAtRevision(root, revision, path)
{
    return JSON.parse(readFileAtRevision(root, revision, path).toString('utf8'));
}

function blobSha256(root, revision, path)
{
    return createHash('sha256').update(readFileAtRevision(root, revision, path)).digest('hex');
}

function gitPathExists(root, revision, path)
{
    try
    {
        execFileSync(
            'git',
            ['cat-file', '-e', `${revision}:${path}`],
            { cwd: root, stdio: 'ignore' }
        );
        return true;
    }
    catch
    {
        return false;
    }
}

function gitRevisionParents(root, revision)
{
    const line = execFileSync(
        'git',
        ['rev-list', '--parents', '--max-count=1', revision],
        { cwd: root, encoding: 'utf8' }
    ).trim();
    return line === '' ? [] : line.split(/\s+/u).slice(1);
}

function gitChangedPaths(root, base, head)
{
    return execFileSync(
        'git',
        ['diff', '--name-only', '-z', base, head, '--'],
        { cwd: root }
    ).toString('utf8').split('\x00').filter(Boolean);
}

function gitRevisionIsAncestor(root, ancestor, descendant)
{
    try
    {
        execFileSync(
            'git',
            ['merge-base', '--is-ancestor', ancestor, descendant],
            { cwd: root, stdio: 'ignore' }
        );
        return true;
    }
    catch
    {
        return false;
    }
}

function gitLastRevisionForPath(root, revision, path)
{
    return execFileSync(
        'git',
        ['log', '-1', '--format=%H', revision, '--', path],
        { cwd: root, encoding: 'utf8' }
    ).trim();
}

function replayGeneratedOutput(root, revision, producer)
{
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-generated-output-repair-'));
    const worktree = join(temporaryRoot, 'worktree');
    try
    {
        execFileSync(
            'git',
            ['worktree', 'add', '--detach', worktree, revision],
            { cwd: root, stdio: 'ignore' }
        );
        execFileSync(producer.executable, producer.arguments, {
            cwd: worktree,
            env: {
                ...process.env,
                FSUSBLOG_DOCS_EVIDENCE_DIR: join(temporaryRoot, 'evidence')
            },
            stdio: 'pipe'
        });
        const modified = execFileSync(
            'git',
            ['diff', '--name-only', '-z', '--'],
            { cwd: worktree }
        ).toString('utf8').split('\x00').filter(Boolean);
        const untracked = execFileSync(
            'git',
            ['ls-files', '--others', '--exclude-standard', '-z'],
            { cwd: worktree }
        ).toString('utf8').split('\x00').filter(Boolean);
        const ignored = execFileSync(
            'git',
            ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
            { cwd: worktree }
        ).toString('utf8').split('\x00').filter(Boolean);
        const changedPaths = [...new Set([...modified, ...untracked, ...ignored])];
        const unexpected = changedPaths
            .filter((path) => !producer.outputs.includes(path));
        if (unexpected.length > 0)
        {
            throw new Error(`producer wrote unregistered outputs: ${unexpected.join(', ')}`);
        }
        return {
            changedPaths,
            outputs: new Map(producer.outputs.map((path) => [
                path,
                createHash('sha256').update(readFileSync(resolve(worktree, path))).digest('hex')
            ]))
        };
    }
    finally
    {
        let cleanupError = null;
        if (existsSync(worktree))
        {
            try
            {
                execFileSync(
                    'git',
                    ['worktree', 'remove', '--force', worktree],
                    { cwd: root, stdio: 'ignore' }
                );
            }
            catch (error)
            {
                cleanupError = error;
            }
        }
        rmSync(temporaryRoot, { recursive: true, force: true });
        if (cleanupError)
        {
            throw cleanupError;
        }
    }
}

function treeDigest(root, revision, paths)
{
    const hash = createHash('sha256');
    for (const path of [...paths].sort())
    {
        hash.update(path);
        hash.update('\x00');
        hash.update(readFileAtRevision(root, revision, path));
        hash.update('\x00');
    }
    return hash.digest('hex');
}

function loadEvidence({ root, head, path, changedFiles, schema, label, errors })
{
    if (!repositoryPathPattern.test(path ?? '') || !path.endsWith('.json'))
    {
        errors.push(`${label} must be one repository-relative .json path`);
        return null;
    }
    if (!changedFiles.includes(path))
    {
        errors.push(`${label} must be changed in this PR: ${path}`);
    }
    if (!root)
    {
        errors.push(`${label} requires repository object context`);
        return null;
    }
    try
    {
        const evidence = readJsonAtRevision(root, head, path);
        if (evidence?.schema !== schema)
        {
            errors.push(`${label} schema must be ${schema}`);
        }
        return evidence;
    }
    catch (error)
    {
        errors.push(`${label} cannot be read from candidate head: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function validateFormatEvidence(parsedBody, { root, head, changedFiles }, errors)
{
    const evidence = loadEvidence({
        root,
        head,
        path: parsedBody.formatterIdempotence,
        changedFiles,
        schema: changeContract.evidenceSchemas.formatIdempotence,
        label: 'Formatter idempotence evidence',
        errors
    });
    if (!evidence)
    {
        return;
    }
    const paths = Array.isArray(evidence.paths) ? evidence.paths : [];
    if (paths.length === 0 || !paths.every((path) => repositoryPathPattern.test(path)))
    {
        errors.push('Formatter idempotence evidence requires repository-relative paths');
        return;
    }
    if (new Set(paths).size !== paths.length)
    {
        errors.push('Formatter idempotence evidence paths must be unique');
    }
    if (!paths.every((path) => changedFiles.includes(path)))
    {
        errors.push('Formatter idempotence evidence paths must all be changed in this PR');
    }
    if (
        evidence.formatter?.identity !== parsedBody.formatterIdentity
        || evidence.formatter?.version !== parsedBody.formatterVersion
        || evidence.formatter?.command !== parsedBody.formatterCommand
    )
    {
        errors.push('Formatter idempotence evidence must match the declared formatter identity, version, and command');
    }
    if (evidence.revision !== parsedBody.blameIgnoreRevision)
    {
        errors.push('Formatter idempotence evidence revision must match Blame-ignore revision');
    }
    if (evidence.idempotent !== true)
    {
        errors.push('Formatter idempotence evidence must declare idempotent: true');
    }
    try
    {
        const digest = treeDigest(root, head, paths);
        if (evidence.firstPassTreeSha256 !== digest || evidence.secondPassTreeSha256 !== digest)
        {
            errors.push('Formatter idempotence first/second pass digests must both match candidate head content');
        }
    }
    catch (error)
    {
        errors.push(`Formatter idempotence paths cannot be read from candidate head: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function formatterFooter(value)
{
    const match = value?.match(/^(?<identity>[^@\s]+)@(?<version>[^\s]+)\s+::\s+(?<command>.+)$/u);
    return match?.groups ?? null;
}

function validateFormatCommitEvidence(root, head, revision, message, changedFiles, errors)
{
    const formatter = formatterFooter(footerValue(message, 'Formatter'));
    if (!formatter)
    {
        return;
    }
    validateFormatEvidence({
        formatterIdentity: formatter.identity,
        formatterVersion: formatter.version,
        formatterCommand: formatter.command,
        formatterIdempotence: footerValue(message, 'Idempotence-Evidence'),
        blameIgnoreRevision: revision
    }, { root, head, changedFiles }, errors);
}

function validatePerformanceCommitEvidence(root, head, revision, message, changedFiles, errors)
{
    const evidencePath = footerValue(message, 'Evidence');
    if (!evidencePath || !repositoryPathPattern.test(evidencePath) || !evidencePath.endsWith('.json'))
    {
        return;
    }
    const claimLevel = footerValue(message, 'Performance-Claim');
    validatePerformanceEvidence({
        performanceEvidence: evidencePath,
        performanceClaim: claimLevel
    }, { root, head, changedFiles, expectedRevision: revision }, errors);
}

function validatePerformanceEvidence(parsedBody, { root, head, changedFiles, expectedRevision = null }, errors)
{
    const evidence = loadEvidence({
        root,
        head,
        path: parsedBody.performanceEvidence,
        changedFiles,
        schema: changeContract.evidenceSchemas.performanceClaim,
        label: 'Performance evidence',
        errors
    });
    if (!evidence)
    {
        return;
    }
    if (evidence.claimLevel !== parsedBody.performanceClaim)
    {
        errors.push('Performance evidence claimLevel must match the PR claim level');
    }
    if (!fullShaPattern.test(evidence.changeRevision ?? ''))
    {
        errors.push('Performance evidence changeRevision must be one full commit SHA');
    }
    else if (expectedRevision && evidence.changeRevision !== expectedRevision)
    {
        errors.push('Performance evidence changeRevision must match the perf commit in this change');
    }
    const expectedStatus = parsedBody.performanceClaim === 'S' ? 'structural-only' : 'measured';
    if (evidence.status !== expectedStatus)
    {
        errors.push(`Performance evidence status must be ${expectedStatus} for claim ${parsedBody.performanceClaim}`);
    }
    const evidenceFiles = Array.isArray(evidence.evidence) ? evidence.evidence : [];
    const evidencePaths = evidenceFiles.map((entry) => entry?.path);
    if (
        evidenceFiles.length === 0
        || !evidencePaths.every((path) => repositoryPathPattern.test(path ?? ''))
        || !evidenceFiles.every((entry) => sha256Pattern.test(entry?.sha256 ?? ''))
    )
    {
        errors.push('Performance evidence requires repository-relative evidence paths with SHA-256 digests');
        return;
    }
    if (new Set(evidencePaths).size !== evidencePaths.length)
    {
        errors.push('Performance evidence paths must be unique');
    }
    if (!evidencePaths.every((path) => changedFiles.includes(path)))
    {
        errors.push('Performance evidence paths must be changed in this PR');
    }
    for (const entry of evidenceFiles)
    {
        try
        {
            const digest = blobSha256(root, head, entry.path);
            if (entry.sha256 !== digest)
            {
                errors.push(`Performance evidence digest mismatch: ${entry.path}`);
            }
        }
        catch (error)
        {
            errors.push(`Performance evidence path cannot be read from candidate head: ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

function generatedEvidenceSchema(root, head, evidencePath)
{
    if (!root || !repositoryPathPattern.test(evidencePath ?? ''))
    {
        return null;
    }
    try
    {
        return readJsonAtRevision(root, head, evidencePath)?.schema ?? null;
    }
    catch
    {
        return null;
    }
}

export function validatePostMergeGeneratedOutputRepair(
    parsedBody,
    evidence,
    { root, base, head, changedFiles },
    errors
)
{
    const topLevelFields = [
        'schema',
        'producerId',
        'sourceCommit',
        'mergedPullRequest',
        'mergeCommit',
        'source',
        'generator',
        'command',
        'outputs'
    ];
    if (!sameStrings(Object.keys(evidence), topLevelFields))
    {
        errors.push('Post-merge generated repair manifest contains unsupported fields');
    }
    const producer = changeContract.generatedOutputRepairProducers.find(
        (entry) => entry.id === evidence.producerId
    );
    if (!producer)
    {
        errors.push(`Post-merge generated repair producer is not trusted: ${evidence.producerId ?? 'missing'}`);
        return;
    }
    if (!fullShaPattern.test(evidence.sourceCommit ?? ''))
    {
        errors.push('Post-merge generated repair sourceCommit must be one full commit SHA');
    }
    if (!Number.isInteger(evidence.mergedPullRequest) || evidence.mergedPullRequest < 1)
    {
        errors.push('Post-merge generated repair mergedPullRequest must be a positive integer');
    }
    if (!fullShaPattern.test(evidence.mergeCommit ?? ''))
    {
        errors.push('Post-merge generated repair mergeCommit must be one full commit SHA');
    }
    for (const [label, blob] of [['source', evidence.source], ['generator', evidence.generator]])
    {
        if (!blob || typeof blob !== 'object' || Array.isArray(blob))
        {
            errors.push(`Post-merge generated repair ${label} must bind one path and digest`);
            continue;
        }
        if (!sameStrings(Object.keys(blob), ['path', 'sha256']))
        {
            errors.push(`Post-merge generated repair ${label} contains unsupported fields`);
        }
        if (!repositoryPathPattern.test(blob.path ?? '') || !sha256Pattern.test(blob.sha256 ?? ''))
        {
            errors.push(`Post-merge generated repair ${label} requires a repository path and SHA-256 digest`);
        }
    }
    const outputs = Array.isArray(evidence.outputs) ? evidence.outputs : [];
    const outputPaths = outputs.map((entry) => entry?.path);
    if (outputs.length === 0)
    {
        errors.push('Post-merge generated repair requires at least one output');
    }
    for (const output of outputs)
    {
        if (!output || typeof output !== 'object' || Array.isArray(output))
        {
            errors.push('Post-merge generated repair outputs must be objects');
            continue;
        }
        if (!sameStrings(Object.keys(output), ['path', 'baseSha256', 'expectedSha256', 'currentSha256']))
        {
            errors.push(`Post-merge generated repair output contains unsupported fields: ${output.path ?? 'missing'}`);
        }
        if (
            !repositoryPathPattern.test(output.path ?? '')
            || !sha256Pattern.test(output.baseSha256 ?? '')
            || !sha256Pattern.test(output.expectedSha256 ?? '')
            || !sha256Pattern.test(output.currentSha256 ?? '')
        )
        {
            errors.push(`Post-merge generated repair output requires a path and base/expected/current SHA-256 digests: ${output.path ?? 'missing'}`);
        }
    }
    if (new Set(outputPaths).size !== outputPaths.length)
    {
        errors.push('Post-merge generated repair output paths must be unique');
    }
    if (evidence.source?.path !== producer.source)
    {
        errors.push(`Post-merge generated repair source must match trusted producer ${producer.id}`);
    }
    if (evidence.generator?.path !== producer.generator)
    {
        errors.push(`Post-merge generated repair generator must match trusted producer ${producer.id}`);
    }
    if (evidence.command !== producer.command)
    {
        errors.push(`Post-merge generated repair command must match trusted producer ${producer.id}`);
    }
    if (!sameStrings(outputPaths, producer.outputs))
    {
        errors.push(`Post-merge generated repair outputs must exactly match trusted producer ${producer.id}`);
    }
    if (!sameStrings(repositoryPaths(parsedBody.generatorSource), [producer.source]))
    {
        errors.push('Post-merge generated repair manifest source must match Generator source');
    }
    if (!sameStrings(repositoryPaths(parsedBody.generatedOutputs), producer.outputs))
    {
        errors.push('Post-merge generated repair manifest outputs must match Generated outputs');
    }
    if (!root || !fullShaPattern.test(base ?? '') || !fullShaPattern.test(head ?? ''))
    {
        errors.push('Post-merge generated repair requires exact pull request base and head revisions');
        return;
    }
    if (
        !fullShaPattern.test(evidence.sourceCommit ?? '')
        || !fullShaPattern.test(evidence.mergeCommit ?? '')
        || !evidence.source
        || !evidence.generator
        || outputs.length === 0
        || !sameStrings(outputPaths, producer.outputs)
    )
    {
        return;
    }

    try
    {
        const sourceParents = gitRevisionParents(root, evidence.sourceCommit);
        if (sourceParents.length !== 1)
        {
            errors.push('Post-merge generated repair sourceCommit must have exactly one parent');
            return;
        }
        const [sourceParent] = sourceParents;
        const mergeParents = gitRevisionParents(root, evidence.mergeCommit);
        if (mergeParents.length !== 2)
        {
            errors.push('Post-merge generated repair mergeCommit must have exactly two parents');
            return;
        }
        const [mergeBaseParent, mergeHeadParent] = mergeParents;
        if (!gitRevisionIsAncestor(root, evidence.sourceCommit, base))
        {
            errors.push('Post-merge generated repair sourceCommit must be an ancestor of the pull request base');
        }
        if (!gitRevisionIsAncestor(root, evidence.mergeCommit, base))
        {
            errors.push('Post-merge generated repair mergeCommit must be an ancestor of the pull request base');
        }
        if (
            !gitRevisionIsAncestor(root, evidence.sourceCommit, mergeHeadParent)
            || gitRevisionIsAncestor(root, evidence.sourceCommit, mergeBaseParent)
        )
        {
            errors.push('Post-merge generated repair sourceCommit must belong to the merged pull request head only');
        }
        const mergeMessage = execFileSync(
            'git',
            ['show', '-s', '--format=%B', evidence.mergeCommit],
            { cwd: root, encoding: 'utf8' }
        );
        if (!new RegExp(`^Merge pull request #${evidence.mergedPullRequest}\\b`, 'mu').test(mergeMessage))
        {
            errors.push('Post-merge generated repair mergedPullRequest must match the exact merge commit message');
        }

        const sourceChanges = gitChangedPaths(root, sourceParent, evidence.sourceCommit);
        if (!sameStrings(sourceChanges, [producer.source]))
        {
            errors.push('Post-merge generated repair sourceCommit must change only the trusted producer source');
        }
        const mergedChanges = gitChangedPaths(root, mergeBaseParent, evidence.mergeCommit);
        if (!mergedChanges.includes(producer.source))
        {
            errors.push('Post-merge generated repair merged pull request did not change the trusted producer source');
        }
        const mergedOutputs = producer.outputs.filter((path) => mergedChanges.includes(path));
        if (mergedOutputs.length > 0)
        {
            errors.push(`Post-merge generated repair merged pull request did not omit outputs: ${mergedOutputs.join(', ')}`);
        }
        for (const output of outputs)
        {
            if (blobSha256(root, sourceParent, output.path) !== blobSha256(root, evidence.sourceCommit, output.path))
            {
                errors.push(`Post-merge generated repair sourceCommit changed an output instead of omitting it: ${output.path}`);
            }
            if (blobSha256(root, mergeBaseParent, output.path) !== blobSha256(root, evidence.mergeCommit, output.path))
            {
                errors.push(`Post-merge generated repair mergeCommit changed an allegedly omitted output: ${output.path}`);
            }
        }

        const currentSourceAtBase = blobSha256(root, base, producer.source);
        const currentSourceAtHead = blobSha256(root, head, producer.source);
        if (gitLastRevisionForPath(root, base, producer.source) !== evidence.sourceCommit)
        {
            errors.push('Post-merge generated repair sourceCommit must remain the current base owner of the trusted producer source');
        }
        if (
            evidence.source.sha256 !== currentSourceAtBase
            || evidence.source.sha256 !== currentSourceAtHead
            || changedFiles.includes(producer.source)
        )
        {
            errors.push('Post-merge generated repair source changed or its current digest is stale');
        }
        const currentGeneratorAtBase = blobSha256(root, base, producer.generator);
        const currentGeneratorAtHead = blobSha256(root, head, producer.generator);
        if (
            evidence.generator.sha256 !== currentGeneratorAtBase
            || evidence.generator.sha256 !== currentGeneratorAtHead
            || changedFiles.includes(producer.generator)
        )
        {
            errors.push('Post-merge generated repair generator changed or its current digest is stale');
        }

        const sourceParentReplay = replayGeneratedOutput(root, sourceParent, producer);
        const sourceRevisionReplay = replayGeneratedOutput(root, evidence.sourceCommit, producer);
        const candidateReplay = replayGeneratedOutput(root, head, producer);
        if (sourceParentReplay.changedPaths.length !== 0)
        {
            errors.push('Post-merge generated repair source parent was already out of sync with the canonical producer');
        }
        if (!sameStrings(sourceRevisionReplay.changedPaths, producer.outputs))
        {
            errors.push('Post-merge generated repair sourceCommit must create drift in exactly the trusted producer outputs');
        }
        for (const output of outputs)
        {
            const baseDigest = blobSha256(root, base, output.path);
            const currentDigest = blobSha256(root, head, output.path);
            if (output.baseSha256 !== baseDigest)
            {
                errors.push(`Post-merge generated repair base output digest is stale: ${output.path}`);
            }
            if (output.expectedSha256 !== sourceRevisionReplay.outputs.get(output.path))
            {
                errors.push(`Post-merge generated repair expected output digest is stale: ${output.path}`);
            }
            if (output.currentSha256 !== currentDigest)
            {
                errors.push(`Post-merge generated repair current output digest is stale: ${output.path}`);
            }
            if (currentDigest !== candidateReplay.outputs.get(output.path))
            {
                errors.push(`Post-merge generated repair output bytes are not canonical: ${output.path}`);
            }
            if (sourceParentReplay.outputs.get(output.path) === sourceRevisionReplay.outputs.get(output.path))
            {
                errors.push(`Post-merge generated repair sourceCommit does not change canonical output: ${output.path}`);
            }
            if (!changedFiles.includes(output.path) || baseDigest === currentDigest)
            {
                errors.push(`Post-merge generated repair output must be changed by the candidate: ${output.path}`);
            }
        }
    }
    catch (error)
    {
        errors.push(`Post-merge generated repair cannot verify history and isolated replays: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function validateGeneratedEvidence(parsedBody, { root, base, head, changedFiles }, errors)
{
    const declaredSources = repositoryPaths(parsedBody.generatorSource);
    const declaredOutputs = repositoryPaths(parsedBody.generatedOutputs);
    const evidenceSchema = generatedEvidenceSchema(root, head, parsedBody.generatedDigest);
    const expectedSchema = evidenceSchema === changeContract.evidenceSchemas.postMergeGeneratedOutputRepair
        ? changeContract.evidenceSchemas.postMergeGeneratedOutputRepair
        : changeContract.evidenceSchemas.generatedOutput;
    const evidence = loadEvidence({
        root,
        head,
        path: parsedBody.generatedDigest,
        changedFiles,
        schema: expectedSchema,
        label: 'Generated Digest/evidence',
        errors
    });
    if (!evidence)
    {
        return;
    }
    if (evidence.schema === changeContract.evidenceSchemas.postMergeGeneratedOutputRepair)
    {
        validatePostMergeGeneratedOutputRepair(
            parsedBody,
            evidence,
            { root, base, head, changedFiles },
            errors
        );
        return;
    }
    const sources = Array.isArray(evidence.sources) ? evidence.sources : [];
    const outputs = Array.isArray(evidence.outputs) ? evidence.outputs : [];
    const outputPaths = outputs.map((entry) => entry?.path);
    if (!sameStrings(sources, declaredSources))
    {
        errors.push('Generated manifest sources must match Generator source');
    }
    if (!sameStrings(outputPaths, declaredOutputs))
    {
        errors.push('Generated manifest outputs must match Generated outputs');
    }
    if (new Set(sources).size !== sources.length || new Set(outputPaths).size !== outputPaths.length)
    {
        errors.push('Generated manifest source and output paths must be unique');
    }
    if (![...sources, ...outputPaths].every((path) => repositoryPathPattern.test(path ?? '')))
    {
        errors.push('Generated manifest contains an invalid repository path');
        return;
    }
    if (!outputs.every((entry) => sha256Pattern.test(entry?.sha256 ?? '')))
    {
        errors.push('Generated manifest outputs require lowercase SHA-256 digests');
        return;
    }
    if (![...sources, ...outputPaths].every((path) => changedFiles.includes(path)))
    {
        errors.push('Generated source and output paths must all be changed in this PR');
    }
    for (const output of outputs)
    {
        try
        {
            const digest = blobSha256(root, head, output.path);
            if (output.sha256 !== digest)
            {
                errors.push(`Generated output digest mismatch: ${output.path}`);
            }
        }
        catch (error)
        {
            errors.push(`Generated output cannot be read from candidate head: ${output.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

export function parsePrBody(body)
{
    const normalized = String(body ?? '').replace(/\r\n/gu, '\n');
    const parsedSections = parseMarkdownSections(normalized);
    const errors = [...parsedSections.errors];
    const section = (name) => parsedSections.sections.get(name) ?? '';
    const classificationSection = section('Change Classification');
    const coding = section('Coding Convention');
    const performance = section('Performance Claim');
    const release = section('Release Note');
    const generated = section('Generated Output');
    const externalNaming = section('External Naming Exception');
    const rollout = section('Rollout / Rollback');
    const classifications = Object.fromEntries(
        changeContract.changeClassifications.map((label) => [label, checkboxValue(classificationSection, label, errors)])
    );
    return {
        body: normalized,
        sections: parsedSections.sections,
        errors,
        classifications,
        audience: fieldValue(release, 'Audience', errors),
        releaseCategory: fieldValue(release, 'Category', errors),
        releaseSummary: fieldValue(release, 'Summary', errors),
        performanceClaim: fieldValue(performance, 'Claim level', errors),
        performanceEvidence: fieldValue(performance, 'Evidence path', errors),
        performanceNonGoals: fieldValue(performance, 'Non-goals', errors),
        formatterIdentity: fieldValue(coding, 'Formatter identity', errors),
        formatterVersion: fieldValue(coding, 'Formatter version', errors),
        formatterCommand: fieldValue(coding, 'Formatter command', errors),
        formatterIdempotence: fieldValue(coding, 'Formatter idempotence evidence', errors),
        blameIgnoreRevision: fieldValue(coding, 'Blame-ignore revision', errors),
        generatorSource: fieldValue(generated, 'Generator source', errors),
        generatedOutputs: fieldValue(generated, 'Generated outputs', errors),
        generatedDigest: fieldValue(generated, 'Digest/evidence', errors),
        automationIdentity: fieldValue(generated, 'Automation identity', errors),
        externalExceptionManifest: fieldValue(externalNaming, 'Exceptions manifest', errors),
        externalExceptionId: fieldValue(externalNaming, 'Exception ID', errors),
        externalExceptionPaths: fieldValue(externalNaming, 'Affected paths', errors),
        externalExceptionReason: fieldValue(externalNaming, 'Reason', errors),
        rollout: fieldValue(rollout, 'Rollout', errors),
        rollback: fieldValue(rollout, 'Rollback', errors),
        deferredWork: fieldValue(rollout, 'Deferred work', errors),
        knownLimitations: fieldValue(rollout, 'Known limitations', errors),
        contractImpact: fieldValue(classificationSection, 'Contract impact', errors)
    };
}

function validateReleaseNote(parsedTitle, parsedBody, labels, errors)
{
    const registryEntry = changeContract.releaseNoteCategories.find(
        (entry) => entry.category === parsedBody.releaseCategory
    );
    if (!registryEntry)
    {
        errors.push(`release note Category must be one of: ${changeContract.releaseNoteCategories.map((entry) => entry.category).join(', ')}`);
        return;
    }
    if (parsedBody.audience !== registryEntry.audience)
    {
        errors.push(`release note Audience must be ${registryEntry.audience} for ${registryEntry.category}`);
    }
    if (!allowedReleaseCategoriesByType[parsedTitle.type]?.has(registryEntry.category))
    {
        errors.push(`${parsedTitle.type} cannot use release note category ${registryEntry.category}`);
    }
    if (registryEntry.category === 'none')
    {
        if (parsedBody.releaseSummary !== 'none')
        {
            errors.push('release note Summary must be none when Category is none');
        }
    }
    else
    {
        if (!substantiveField(parsedBody.releaseSummary))
        {
            errors.push('release note Summary is required unless Category is none');
        }
        else if (parsedBody.releaseSummary !== parsedTitle.summary)
        {
            errors.push('release note Summary must exactly match the PR title summary used by GitHub release notes');
        }
        if (securityDetailPattern.test(parsedBody.releaseSummary ?? ''))
        {
            errors.push('release note Summary contains public vulnerability detail');
        }
    }

    const releaseLabels = labels.filter((label) => label.startsWith('release-note:'));
    if (releaseLabels.length !== 1 || releaseLabels[0] !== registryEntry.label)
    {
        errors.push(`PR must have exactly the release note label ${registryEntry.label}`);
    }

    if (
        (parsedBody.classifications['Format-only'] || parsedBody.classifications['Naming-only'] || parsedTitle.type === 'ci')
        && userReleaseCategories.has(registryEntry.category)
    )
    {
        errors.push('format-only, naming-only, and CI changes cannot enter user-facing release notes');
    }
}

function globMatches(path, glob)
{
    let pattern = '^';
    for (let index = 0; index < glob.length; index += 1)
    {
        const character = glob[index];
        if (character === '*' && glob[index + 1] === '*')
        {
            pattern += '.*';
            index += 1;
        }
        else if (character === '*')
        {
            pattern += '[^/]*';
        }
        else if (character === '?')
        {
            pattern += '[^/]';
        }
        else
        {
            pattern += escapePattern(character);
        }
    }
    return new RegExp(`${pattern}$`, 'u').test(path);
}

export function validatePostMergeExternalNamingEvidenceRepair(
    evidence,
    { root, base, head, changedFiles, manifestPath },
    exceptions,
    errors
)
{
    const fields = [
        'schema',
        'repository',
        'originalPullRequest',
        'originalBase',
        'originalHead',
        'mergeCommit',
        'source',
        'namingSurface',
        'missingArtifact',
        'currentExceptions'
    ];
    if (!sameStrings(Object.keys(evidence), fields))
    {
        errors.push('Post-merge external naming repair manifest contains unsupported fields');
    }
    if (evidence.repository !== changeContract.repository)
    {
        errors.push(`Post-merge external naming repair repository must be ${changeContract.repository}`);
    }
    if (!Number.isInteger(evidence.originalPullRequest) || evidence.originalPullRequest < 1)
    {
        errors.push('Post-merge external naming repair originalPullRequest must be a positive integer');
    }
    for (const field of ['originalBase', 'originalHead', 'mergeCommit'])
    {
        if (!fullShaPattern.test(evidence[field] ?? ''))
        {
            errors.push(`Post-merge external naming repair ${field} must be one full commit SHA`);
        }
    }
    const source = evidence.source;
    if (!source || typeof source !== 'object' || Array.isArray(source))
    {
        errors.push('Post-merge external naming repair source must bind one path and two digests');
    }
    else
    {
        if (!sameStrings(Object.keys(source), ['path', 'candidateSha256', 'currentSha256']))
        {
            errors.push('Post-merge external naming repair source contains unsupported fields');
        }
        if (
            !repositoryPathPattern.test(source.path ?? '')
            || !sha256Pattern.test(source.candidateSha256 ?? '')
            || !sha256Pattern.test(source.currentSha256 ?? '')
        )
        {
            errors.push('Post-merge external naming repair source requires a repository path and candidate/current SHA-256 digests');
        }
    }
    const namingSurface = evidence.namingSurface;
    if (!namingSurface || typeof namingSurface !== 'object' || Array.isArray(namingSurface))
    {
        errors.push('Post-merge external naming repair namingSurface must bind one ID and reason');
    }
    else
    {
        if (!sameStrings(Object.keys(namingSurface), ['id', 'reason']))
        {
            errors.push('Post-merge external naming repair namingSurface contains unsupported fields');
        }
        if (
            !substantiveField(namingSurface.id)
            || !substantiveField(namingSurface.reason)
            || namingSurface.reason === 'none'
            || namingSurface.reason.trim().length < 12
        )
        {
            errors.push('Post-merge external naming repair namingSurface requires an ID and substantive reason');
        }
    }
    const missingArtifact = evidence.missingArtifact;
    if (!missingArtifact || typeof missingArtifact !== 'object' || Array.isArray(missingArtifact))
    {
        errors.push('Post-merge external naming repair missingArtifact must bind one path and digest');
    }
    else
    {
        if (!sameStrings(Object.keys(missingArtifact), ['path', 'sha256']))
        {
            errors.push('Post-merge external naming repair missingArtifact contains unsupported fields');
        }
        if (
            !repositoryPathPattern.test(missingArtifact.path ?? '')
            || !missingArtifact.path?.endsWith('.json')
            || !sha256Pattern.test(missingArtifact.sha256 ?? '')
        )
        {
            errors.push('Post-merge external naming repair missingArtifact requires one repository-relative JSON path and SHA-256 digest');
        }
    }
    const currentExceptions = Array.isArray(evidence.currentExceptions)
        ? evidence.currentExceptions
        : [];
    if (!Array.isArray(evidence.currentExceptions))
    {
        errors.push('Post-merge external naming repair currentExceptions must be an array');
    }
    const currentExceptionIds = [];
    const currentExceptionPaths = [];
    for (const declaration of currentExceptions)
    {
        if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration))
        {
            errors.push('Post-merge external naming repair currentExceptions must be objects');
            continue;
        }
        if (!sameStrings(Object.keys(declaration), ['id', 'paths', 'reason']))
        {
            errors.push('Post-merge external naming repair current exception contains unsupported fields');
        }
        const entry = exceptions.find((candidate) => candidate.id === declaration.id);
        if (!entry)
        {
            errors.push(`Post-merge external naming repair current exception is not registered: ${declaration.id ?? 'missing'}`);
        }
        if (currentExceptionIds.includes(declaration.id))
        {
            errors.push(`Post-merge external naming repair current exception ID is duplicated: ${declaration.id}`);
        }
        currentExceptionIds.push(declaration.id);
        const paths = Array.isArray(declaration.paths) ? declaration.paths : [];
        if (
            paths.length === 0
            || !paths.every((path) => repositoryPathPattern.test(path ?? ''))
            || new Set(paths).size !== paths.length
        )
        {
            errors.push(`Post-merge external naming repair current exception ${declaration.id ?? 'missing'} requires unique repository paths`);
        }
        if (
            !substantiveField(declaration.reason)
            || declaration.reason === 'none'
            || declaration.reason.trim().length < 12
        )
        {
            errors.push(`Post-merge external naming repair current exception ${declaration.id ?? 'missing'} requires a substantive reason`);
        }
        for (const path of paths)
        {
            if (currentExceptionPaths.includes(path))
            {
                errors.push(`Post-merge external naming repair current exception path is duplicated: ${path}`);
            }
            currentExceptionPaths.push(path);
            if (!changedFiles.includes(path))
            {
                errors.push(`Post-merge external naming repair current exception path is not changed: ${path}`);
            }
            if (entry && !entry.paths.some((glob) => globMatches(path, glob)))
            {
                errors.push(`Post-merge external naming repair current exception path is outside registered surface ${entry.id}: ${path}`);
            }
        }
    }
    const surface = exceptions.find((entry) => entry.id === namingSurface?.id);
    if (!surface)
    {
        errors.push(`Post-merge external naming repair surface is not registered: ${namingSurface?.id ?? 'missing'}`);
    }
    if (
        surface
        && repositoryPathPattern.test(source?.path ?? '')
        && !surface.paths.some((glob) => globMatches(source.path, glob))
    )
    {
        errors.push(`Post-merge external naming repair source is outside registered surface ${surface.id}`);
    }
    if (!root || !fullShaPattern.test(base ?? '') || !fullShaPattern.test(head ?? ''))
    {
        errors.push('Post-merge external naming repair requires exact pull request base and head revisions');
        return;
    }
    if (
        !fullShaPattern.test(evidence.originalBase ?? '')
        || !fullShaPattern.test(evidence.originalHead ?? '')
        || !fullShaPattern.test(evidence.mergeCommit ?? '')
        || !repositoryPathPattern.test(source?.path ?? '')
        || !repositoryPathPattern.test(missingArtifact?.path ?? '')
        || !surface
    )
    {
        return;
    }

    try
    {
        const mergeParents = gitRevisionParents(root, evidence.mergeCommit);
        if (!sameStrings(mergeParents, [evidence.originalBase, evidence.originalHead]))
        {
            errors.push('Post-merge external naming repair mergeCommit parents must exactly match originalBase and originalHead');
        }
        if (!gitRevisionIsAncestor(root, evidence.originalBase, evidence.originalHead))
        {
            errors.push('Post-merge external naming repair originalBase must be an ancestor of originalHead');
        }
        if (!gitRevisionIsAncestor(root, evidence.originalHead, base))
        {
            errors.push('Post-merge external naming repair originalHead must be an ancestor of the current pull request base');
        }
        if (!gitRevisionIsAncestor(root, evidence.mergeCommit, base))
        {
            errors.push('Post-merge external naming repair mergeCommit must be an ancestor of the current pull request base');
        }
        const mergeMessage = execFileSync(
            'git',
            ['show', '-s', '--format=%B', evidence.mergeCommit],
            { cwd: root, encoding: 'utf8' }
        );
        if (!new RegExp(`^Merge pull request #${evidence.originalPullRequest}\\b`, 'mu').test(mergeMessage))
        {
            errors.push('Post-merge external naming repair originalPullRequest must match the exact merge commit message');
        }

        const originalChanges = gitChangedPaths(root, evidence.originalBase, evidence.originalHead);
        const originalGovernedChanges = originalChanges.filter((path) => exceptions.some(
            (entry) => entry.paths?.some((glob) => globMatches(path, glob))
        ));
        if (!sameStrings(originalGovernedChanges, [source.path]))
        {
            errors.push('Post-merge external naming repair source must exactly match the original pull request registered naming changes');
        }
        if (blobSha256(root, evidence.originalBase, source.path) === blobSha256(root, evidence.originalHead, source.path))
        {
            errors.push('Post-merge external naming repair original pull request did not change the source blob');
        }
        const candidateSourceDigest = blobSha256(root, evidence.originalHead, source.path);
        const currentBaseSourceDigest = blobSha256(root, base, source.path);
        const currentHeadSourceDigest = blobSha256(root, head, source.path);
        if (
            source.candidateSha256 !== candidateSourceDigest
            || source.currentSha256 !== currentBaseSourceDigest
            || source.currentSha256 !== currentHeadSourceDigest
            || source.candidateSha256 !== source.currentSha256
            || changedFiles.includes(source.path)
        )
        {
            errors.push('Post-merge external naming repair source blob identity drifted or source changed in the repair');
        }
        if (
            gitLastRevisionForPath(root, evidence.originalHead, source.path)
            !== gitLastRevisionForPath(root, base, source.path)
        )
        {
            errors.push('Post-merge external naming repair source revision changed after the original pull request');
        }

        for (const [label, revision] of [
            ['original head', evidence.originalHead],
            ['merge commit', evidence.mergeCommit],
            ['current base', base]
        ])
        {
            if (gitPathExists(root, revision, missingArtifact.path))
            {
                errors.push(`Post-merge external naming repair missingArtifact was already present at ${label}`);
            }
        }
        if (missingArtifact.path === manifestPath)
        {
            errors.push('Post-merge external naming repair evidence and missingArtifact paths must be distinct');
        }
        if (!changedFiles.includes(missingArtifact.path))
        {
            errors.push('Post-merge external naming repair missingArtifact must be changed by the candidate');
        }
        if (blobSha256(root, head, missingArtifact.path) !== missingArtifact.sha256)
        {
            errors.push('Post-merge external naming repair missingArtifact digest is stale');
        }
        const currentGovernedChanges = changedFiles.filter((path) => exceptions.some(
            (entry) => entry.paths?.some((glob) => globMatches(path, glob))
        ));
        if (!sameStrings(currentExceptionPaths, currentGovernedChanges))
        {
            errors.push('Post-merge external naming repair current exceptions must exactly match changed registered naming surfaces');
        }

        const repairedArtifact = readJsonAtRevision(root, head, missingArtifact.path);
        if (!sameStrings(Object.keys(repairedArtifact), ['schema', 'exceptions']))
        {
            errors.push('Post-merge external naming repair artifact contains unsupported fields');
        }
        if (repairedArtifact.schema !== changeContract.evidenceSchemas.externalNamingExceptions)
        {
            errors.push(`Post-merge external naming repair artifact schema must be ${changeContract.evidenceSchemas.externalNamingExceptions}`);
        }
        const declarations = Array.isArray(repairedArtifact.exceptions)
            ? repairedArtifact.exceptions
            : [];
        if (declarations.length !== 1)
        {
            errors.push('Post-merge external naming repair artifact must contain exactly one exception');
        }
        else
        {
            const [declaration] = declarations;
            if (!sameStrings(Object.keys(declaration ?? {}), ['id', 'paths', 'reason']))
            {
                errors.push('Post-merge external naming repair artifact exception contains unsupported fields');
            }
            if (
                declaration?.id !== namingSurface.id
                || !sameStrings(declaration?.paths ?? [], [source.path])
                || declaration?.reason !== namingSurface.reason
            )
            {
                errors.push('Post-merge external naming repair artifact must exactly match the bound surface, source, and reason');
            }
        }
    }
    catch (error)
    {
        errors.push(`Post-merge external naming repair cannot verify history and blobs: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function validateExternalNaming(parsedBody, { root, base, head, changedFiles, authorityRoot }, errors)
{
    if (!authorityRoot)
    {
        if (parsedBody.classifications['External naming exception'])
        {
            errors.push('External naming exception requires trusted repository context');
        }
        return;
    }
    let exceptions = [];
    try
    {
        const registry = JSON.parse(readFileSync(
            resolve(authorityRoot, 'config/development/native-tooling-style-exceptions.json'),
            'utf8'
        ));
        exceptions = Array.isArray(registry.exceptions) ? registry.exceptions : [];
    }
    catch (error)
    {
        errors.push(`cannot read trusted external naming exception registry: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    const governedChanges = changedFiles.filter((path) => exceptions.some(
        (entry) => entry.paths?.some((glob) => globMatches(path, glob))
    ));
    const declared = parsedBody.classifications['External naming exception'] === true;
    if (!declared)
    {
        if (governedChanges.length > 0)
        {
            errors.push(`changes to registered external naming surfaces require External naming exception classification: ${governedChanges.join(', ')}`);
        }
        return;
    }

    const manifestPath = parsedBody.externalExceptionManifest;
    const usesManifest = substantiveField(manifestPath) && manifestPath !== 'none';
    if (usesManifest)
    {
        for (const [field, value] of [
            ['Exception ID', parsedBody.externalExceptionId],
            ['Affected paths', parsedBody.externalExceptionPaths],
            ['Reason', parsedBody.externalExceptionReason]
        ])
        {
            if (value !== null && value !== 'none')
            {
                errors.push(`External naming ${field} cannot be combined with Exceptions manifest`);
            }
        }
        const evidenceSchema = generatedEvidenceSchema(root, head, manifestPath);
        const repair = evidenceSchema === changeContract.evidenceSchemas.postMergeExternalNamingEvidenceRepair;
        const manifest = loadEvidence({
            root,
            head,
            path: manifestPath,
            changedFiles,
            schema: repair
                ? changeContract.evidenceSchemas.postMergeExternalNamingEvidenceRepair
                : changeContract.evidenceSchemas.externalNamingExceptions,
            label: 'External naming Exceptions manifest',
            errors
        });
        if (!manifest)
        {
            return;
        }
        if (repair)
        {
            validatePostMergeExternalNamingEvidenceRepair(
                manifest,
                { root, base, head, changedFiles, manifestPath },
                exceptions,
                errors
            );
            return;
        }
        if (!sameStrings(Object.keys(manifest), ['schema', 'exceptions']))
        {
            errors.push('External naming Exceptions manifest contains unsupported fields');
        }
        const declarations = Array.isArray(manifest.exceptions) ? manifest.exceptions : [];
        if (declarations.length === 0)
        {
            errors.push('External naming Exceptions manifest requires at least one exception');
            return;
        }
        const declaredIds = [];
        const declaredPaths = [];
        for (const declaration of declarations)
        {
            if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration))
            {
                errors.push('External naming manifest exceptions must be objects');
                continue;
            }
            if (!sameStrings(Object.keys(declaration), ['id', 'paths', 'reason']))
            {
                errors.push('External naming manifest exception contains unsupported fields');
            }
            const id = declaration?.id;
            const entry = exceptions.find((candidate) => candidate.id === id);
            if (typeof id !== 'string' || id.trim().length === 0)
            {
                errors.push('External naming manifest exception requires an ID');
            }
            else if (!entry)
            {
                errors.push(`External naming Exception ID is not registered: ${id}`);
            }
            if (declaredIds.includes(id))
            {
                errors.push(`External naming Exception ID is declared more than once: ${id}`);
            }
            declaredIds.push(id);

            const paths = Array.isArray(declaration?.paths) ? declaration.paths : [];
            if (
                paths.length === 0
                || !paths.every((path) => typeof path === 'string' && repositoryPathPattern.test(path))
            )
            {
                errors.push(`External naming exception ${id ?? 'missing'} requires repository-relative paths`);
            }
            if (new Set(paths).size !== paths.length)
            {
                errors.push(`External naming exception ${id ?? 'missing'} paths must be unique`);
            }
            if (
                typeof declaration?.reason !== 'string'
                || !substantiveField(declaration.reason)
                || declaration.reason === 'none'
                || declaration.reason.trim().length < 12
            )
            {
                errors.push(`External naming exception ${id ?? 'missing'} requires a substantive Reason`);
            }
            for (const path of paths)
            {
                if (declaredPaths.includes(path))
                {
                    errors.push(`External naming path is assigned to more than one exception: ${path}`);
                }
                declaredPaths.push(path);
                if (!changedFiles.includes(path))
                {
                    errors.push(`External naming affected path is not changed in this PR: ${path}`);
                }
                if (entry && !entry.paths.some((glob) => globMatches(path, glob)))
                {
                    errors.push(`External naming path is outside registered exception ${entry.id}: ${path}`);
                }
            }
        }
        if (!sameStrings(declaredPaths, governedChanges))
        {
            errors.push('External naming manifest paths must exactly match all changed registered naming surfaces');
        }
        return;
    }

    const entry = exceptions.find((candidate) => candidate.id === parsedBody.externalExceptionId);
    if (!entry)
    {
        errors.push(`External naming Exception ID is not registered: ${parsedBody.externalExceptionId ?? 'missing'}`);
    }
    const paths = repositoryPaths(parsedBody.externalExceptionPaths);
    if (paths.length === 0)
    {
        errors.push('External naming Affected paths must list repository-relative paths');
    }
    if (paths.length > 0 && !sameStrings(paths, governedChanges))
    {
        errors.push('External naming Affected paths must exactly match all changed registered naming surfaces');
    }
    if (!substantiveField(parsedBody.externalExceptionReason) || parsedBody.externalExceptionReason === 'none')
    {
        errors.push('External naming exception requires a substantive Reason');
    }
    if (entry && governedChanges.some((path) => !entry.paths.some((glob) => globMatches(path, glob))))
    {
        errors.push(`registered naming changes span paths outside exception ${entry.id}; split the change by exception boundary`);
    }
    for (const path of paths)
    {
        if (!changedFiles.includes(path))
        {
            errors.push(`External naming affected path is not changed in this PR: ${path}`);
        }
        if (entry && !entry.paths.some((glob) => globMatches(path, glob)))
        {
            errors.push(`External naming path is outside registered exception ${entry.id}: ${path}`);
        }
    }
}

function validateChangedPaths(parsedTitle, parsedBody, changedFiles, context, errors)
{
    const runtimePath = /^(?:src|ops|tools)\//u;
    const docsPath = /^(?:docs\/|README\.md$|CONTRIBUTING\.md$|SECURITY\.md$|SUPPORT\.md$|\.github\/(?:PULL_REQUEST_TEMPLATE\.md|ISSUE_TEMPLATE\/))/u;
    const testPath = /^(?:tests\/|src\/frontend\/(?:tests|vitest\.)|tools\/(?:test|testing)\/)/u;
    const externalContractPath = /(?:Migration|Migrations\/|docs\/api\/|Contracts\/Validation\/|\.openapi\.json$|aeds-protocol\.json$)/u;

    if (parsedTitle.type === 'docs' && changedFiles.some((path) => runtimePath.test(path) && !docsPath.test(path)))
    {
        errors.push('docs commit/PR must not modify runtime logic');
    }
    if (parsedTitle.type === 'test' && changedFiles.some((path) => runtimePath.test(path) && !testPath.test(path)))
    {
        errors.push('test commit/PR must not modify product runtime logic');
    }
    if (parsedBody.classifications['Naming-only'] && changedFiles.some((path) => externalContractPath.test(path)))
    {
        errors.push('naming-only change cannot rename database, API, or generated contract surfaces');
    }
    if (parsedBody.classifications['Public contract change'] && !['compatible', 'breaking'].includes(parsedBody.contractImpact))
    {
        errors.push('Public contract change requires Contract impact: compatible or breaking');
    }
    if (!parsedBody.classifications['Public contract change'] && parsedBody.contractImpact !== 'none')
    {
        errors.push('Contract impact must be none unless Public contract change is checked');
    }
    if (parsedBody.contractImpact === 'breaking' && !parsedTitle.breaking)
    {
        errors.push('breaking Contract impact requires ! in the PR title');
    }
    if (parsedTitle.breaking && parsedBody.contractImpact !== 'breaking')
    {
        errors.push('PR title ! requires Public contract change and Contract impact: breaking');
    }

    const generatedPathPatterns = changeContract.generatedPathPatterns.map((pattern) => new RegExp(pattern, 'u'));
    const generatedChanges = changedFiles.filter((path) => generatedPathPatterns.some((pattern) => pattern.test(path)));
    if (generatedChanges.length > 0 && !parsedBody.classifications['Generated output'])
    {
        errors.push(`generated owner paths require Generated output classification: ${generatedChanges.join(', ')}`);
    }

    if (parsedBody.classifications['Generated output'])
    {
        const sources = repositoryPaths(parsedBody.generatorSource);
        const outputs = repositoryPaths(parsedBody.generatedOutputs);
        const repair = generatedEvidenceSchema(
            context.root,
            context.head,
            parsedBody.generatedDigest
        ) === changeContract.evidenceSchemas.postMergeGeneratedOutputRepair;
        if (sources.length === 0)
        {
            errors.push('Generator source must list repository-relative paths');
        }
        if (outputs.length === 0)
        {
            errors.push('Generated outputs must list repository-relative changed paths');
        }
        for (const path of repair ? outputs : [...sources, ...outputs])
        {
            if (!changedFiles.includes(path))
            {
                errors.push(`generated binding path is not changed in this PR: ${path}`);
            }
        }
        if (repair)
        {
            for (const path of sources)
            {
                if (changedFiles.includes(path))
                {
                    errors.push(`post-merge generated repair source must not be changed in this PR: ${path}`);
                }
            }
        }
        if (sources.some((source) => outputs.includes(source)))
        {
            errors.push('generator source and generated output paths must be distinct');
        }
        const declaredBindings = new Set([...sources, ...outputs]);
        // The evidence manifest is metadata about the generation edge, not one
        // of its inputs or outputs. Requiring it to bind itself would create an
        // impossible recursive digest contract whenever it lives under a
        // generated-owner directory.
        const unboundGeneratedChanges = generatedChanges.filter(
            (path) => path !== parsedBody.generatedDigest && !declaredBindings.has(path)
        );
        if (unboundGeneratedChanges.length > 0)
        {
            errors.push(`generated owner paths are missing from source/output bindings: ${unboundGeneratedChanges.join(', ')}`);
        }
        validateGeneratedEvidence(parsedBody, context, errors);
    }

    validateExternalNaming(parsedBody, context, errors);
}

function validateTrustedPolicyFiles({ root, head, authorityRoot, changedFiles }, errors)
{
    if (!root || !authorityRoot || resolve(root) === resolve(authorityRoot))
    {
        return;
    }
    const policyChanges = changeContract.trustedPolicyFiles.filter((path) => changedFiles.includes(path));
    for (const path of policyChanges)
    {
        try
        {
            const candidate = readFileAtRevision(root, head, path);
            const trusted = readFileSync(resolve(authorityRoot, path));
            if (!candidate.equals(trusted))
            {
                errors.push(`pull request cannot replace trusted change-contract policy source: ${path}`);
            }
        }
        catch (error)
        {
            errors.push(`pull request cannot read trusted policy source ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

export function validatePrContract({
    title,
    body,
    labels = [],
    actor = '',
    changedFiles = [],
    root = null,
    base = null,
    head = 'HEAD',
    authorityRoot = root
})
{
    const parsedTitle = parseCommitHeader(title);
    const parsedBody = parsePrBody(body);
    const errors = [...validateCommitMessage(title, { titleOnly: true }), ...parsedBody.errors];
    const context = { root, base, head, changedFiles, authorityRoot };

    validateTrustedPolicyFiles(context, errors);

    if (!parsedTitle)
    {
        return errors;
    }

    const requiredHeadings = [
        '## Linked Issue',
        '## Scope Summary',
        '## Change Classification',
        '## Tests Run',
        '## UI Evidence',
        '## Coding Convention',
        '## Documentation / Intent',
        '## Compatibility And Risk',
        '## Performance Claim',
        '## Release Note',
        '## Generated Output',
        '## External Naming Exception',
        '## Rollout / Rollback',
        '## Notes For Reviewers'
    ];
    for (const heading of requiredHeadings)
    {
        if (!parsedBody.sections.has(heading.slice(3)))
        {
            errors.push(`PR body is missing ${heading}`);
        }
    }
    const closingLines = (parsedBody.sections.get('Linked Issue') ?? '').match(/^Closes\s+#\d+\s*$/gmu) ?? [];
    if (closingLines.length !== 1)
    {
        errors.push('PR body requires one explicit Closes #1234 line');
    }
    if (!substantiveMarkdownSection(parsedBody.sections.get('Scope Summary') ?? ''))
    {
        errors.push('PR body requires a substantive Scope Summary');
    }
    if (checkedChecklistCount(parsedBody.sections.get('Tests Run') ?? '') === 0)
    {
        errors.push('PR body requires at least one checked Tests Run entry');
    }

    for (const [label, checked] of Object.entries(parsedBody.classifications))
    {
        if (checked === null)
        {
            errors.push(`PR body is missing classification checkbox: ${label}`);
        }
    }
    for (const [sectionName, checklistLabels] of [
        ['Coding Convention', [
            'C# mother-style mapping checked',
            'Formatter/linter run',
            'No tool default overrides repository style',
            'Mechanical formatting separated from logic',
            '`.git-blame-ignore-revs` updated when applicable'
        ]],
        ['Documentation / Intent', [
            'Public API docs updated',
            'Ownership/security/performance intent updated',
            'Historical handoff archived or source-of-truth updated',
            'TODO/FIXME references valid issues'
        ]],
        ['Compatibility And Risk', [
            '[Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed',
            'External wire / ABI / database / third-party names preserved or explicitly adapted',
            'Public API impact reviewed',
            'AEDS frame / binary contract impact reviewed',
            'Database migration impact reviewed',
            'Security, auth, moderation, PoW, or privacy impact reviewed',
            'Docs updated or a reason is recorded below',
            'Known limitations updated if applicable'
        ]]
    ])
    {
        const section = parsedBody.sections.get(sectionName) ?? '';
        for (const checklistLabel of checklistLabels)
        {
            if (checkboxValue(section, checklistLabel, errors) !== true)
            {
                errors.push(`PR body requires checked checklist field: ${checklistLabel}`);
            }
        }
    }

    const behavior = parsedBody.classifications['Behavior change'] === true;
    const formatOnly = parsedBody.classifications['Format-only'] === true;
    const namingOnly = parsedBody.classifications['Naming-only'] === true;
    if (formatOnly && namingOnly)
    {
        errors.push('Format-only and Naming-only are mutually exclusive');
    }
    if ((formatOnly || namingOnly) && behavior)
    {
        errors.push('mechanical style changes cannot also claim behavior change');
    }
    if (parsedTitle.type === 'style' && Number(formatOnly) + Number(namingOnly) !== 1)
    {
        errors.push('style title requires exactly one of Format-only or Naming-only');
    }
    if (parsedTitle.type !== 'style' && (formatOnly || namingOnly))
    {
        errors.push('Format-only and Naming-only require a style title');
    }
    if (['feat', 'fix', 'perf', 'security', 'revert'].includes(parsedTitle.type) && !behavior)
    {
        errors.push(`${parsedTitle.type} title requires Behavior change classification`);
    }
    if (['refactor', 'docs', 'build', 'ci', 'chore', 'test', 'style'].includes(parsedTitle.type) && behavior)
    {
        errors.push(`${parsedTitle.type} title cannot claim Behavior change`);
    }

    if (formatOnly)
    {
        for (const [field, value] of [
            ['Formatter identity', parsedBody.formatterIdentity],
            ['Formatter version', parsedBody.formatterVersion],
            ['Formatter command', parsedBody.formatterCommand],
            ['Formatter idempotence evidence', parsedBody.formatterIdempotence]
        ])
        {
            if (!substantiveField(value) || value === 'none')
            {
                errors.push(`format-only PR requires ${field}`);
            }
        }
        if (!fullShaPattern.test(parsedBody.blameIgnoreRevision ?? ''))
        {
            errors.push('format-only PR requires one full Blame-ignore revision SHA');
        }
        validateFormatEvidence(parsedBody, context, errors);
    }
    else
    {
        for (const [field, value] of [
            ['Formatter identity', parsedBody.formatterIdentity],
            ['Formatter version', parsedBody.formatterVersion],
            ['Formatter command', parsedBody.formatterCommand],
            ['Formatter idempotence evidence', parsedBody.formatterIdempotence],
            ['Blame-ignore revision', parsedBody.blameIgnoreRevision]
        ])
        {
            if (value !== 'none')
            {
                errors.push(`${field} must be none unless Format-only is checked`);
            }
        }
    }

    if (parsedBody.classifications['Generated output'])
    {
        for (const [field, value] of [
            ['Generator source', parsedBody.generatorSource],
            ['Generated outputs', parsedBody.generatedOutputs],
            ['Digest/evidence', parsedBody.generatedDigest]
        ])
        {
            if (!substantiveField(value) || value === 'none')
            {
                errors.push(`generated change requires ${field}`);
            }
        }
    }
    else
    {
        for (const [field, value] of [
            ['Generator source', parsedBody.generatorSource],
            ['Generated outputs', parsedBody.generatedOutputs],
            ['Digest/evidence', parsedBody.generatedDigest],
            ['Automation identity', parsedBody.automationIdentity]
        ])
        {
            if (value !== 'none')
            {
                errors.push(`${field} must be none unless Generated output is checked`);
            }
        }
    }

    if (!parsedBody.classifications['External naming exception'])
    {
        for (const [field, value] of [
            ['External naming Exceptions manifest', parsedBody.externalExceptionManifest],
            ['External naming Exception ID', parsedBody.externalExceptionId],
            ['External naming Affected paths', parsedBody.externalExceptionPaths],
            ['External naming Reason', parsedBody.externalExceptionReason]
        ])
        {
            if (value !== null && value !== 'none')
            {
                errors.push(`${field} must be none unless External naming exception is checked`);
            }
        }
    }

    const botActor = /\[bot\]$/u.test(actor);
    if (botActor)
    {
        if (!parsedBody.classifications['Generated output'])
        {
            errors.push('bot PR must check Generated output');
        }
        if (parsedBody.automationIdentity !== actor)
        {
            errors.push('bot PR Automation identity must match the GitHub actor');
        }
    }
    else if (substantiveField(parsedBody.automationIdentity) && parsedBody.automationIdentity !== 'none')
    {
        errors.push('Automation identity is only allowed for an authenticated bot actor');
    }

    const performanceClaim = parsedBody.performanceClaim;
    if (!changeContract.performanceClaimLevels.includes(performanceClaim))
    {
        errors.push(`Claim level must be one of: ${changeContract.performanceClaimLevels.join(', ')}`);
    }
    if (parsedTitle.type === 'perf' && !['S', 'M', 'R', 'C'].includes(performanceClaim))
    {
        errors.push('perf PR requires Claim level S, M, R, or C');
    }
    if (parsedTitle.type !== 'perf' && performanceClaim !== 'none')
    {
        errors.push('non-none performance claims require a perf PR title');
    }
    if (parsedTitle.type === 'refactor' && performanceClaim !== 'none')
    {
        errors.push('refactor PR cannot claim performance improvement');
    }
    if (performanceClaim !== 'none' && !repositoryPathPattern.test(parsedBody.performanceEvidence ?? ''))
    {
        errors.push('non-none performance claim requires Evidence path');
    }
    if (performanceClaim === 'none' && parsedBody.performanceEvidence !== 'none')
    {
        errors.push('Performance Evidence path must be none when Claim level is none');
    }
    if (performanceClaim !== 'none')
    {
        validatePerformanceEvidence(parsedBody, context, errors);
    }
    if (!substantiveField(parsedBody.performanceNonGoals))
    {
        errors.push('Performance Claim requires Non-goals');
    }

    for (const [field, value] of [
        ['Rollout', parsedBody.rollout],
        ['Rollback', parsedBody.rollback],
        ['Deferred work', parsedBody.deferredWork],
        ['Known limitations', parsedBody.knownLimitations]
    ])
    {
        if (!substantiveField(value))
        {
            errors.push(`PR body requires ${field}`);
        }
    }

    validateReleaseNote(parsedTitle, parsedBody, labels, errors);
    validateChangedPaths(parsedTitle, parsedBody, changedFiles, context, errors);
    return errors;
}

export function parseBlameIgnoreRevisions(text)
{
    return String(text ?? '')
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
}

export function validateBlameIgnoreRevisions(text, {
    requiredRevisions = [],
    inspectRevision = () => ({ exists: true, reachable: true, parents: 1, subject: 'style(governance): preserve reviewed format history' })
} = {})
{
    const errors = [];
    const revisions = parseBlameIgnoreRevisions(text);
    if (new Set(revisions).size !== revisions.length)
    {
        errors.push('.git-blame-ignore-revs contains duplicate revisions');
    }

    for (const revision of revisions)
    {
        if (!fullShaPattern.test(revision))
        {
            errors.push(`blame-ignore revision must be a full lowercase SHA: ${revision}`);
            continue;
        }
        const inspected = inspectRevision(revision);
        if (!inspected.exists)
        {
            errors.push(`blame-ignore revision does not exist: ${revision}`);
        }
        if (!inspected.reachable)
        {
            errors.push(`blame-ignore revision is not reachable from HEAD: ${revision}`);
        }
        if (inspected.parents !== 1)
        {
            errors.push(`blame-ignore revision must not be a merge or root commit: ${revision}`);
        }
        const header = parseCommitHeader(inspected.subject);
        if (header?.type !== 'style')
        {
            errors.push(`blame-ignore revision must point to a style commit: ${revision}`);
        }
    }
    for (const required of requiredRevisions)
    {
        if (!revisions.includes(required))
        {
            errors.push(`missing blame-ignore entry: ${required}`);
        }
    }
    return errors;
}

export function inspectGitRevision(root, revision)
{
    try
    {
        const subject = execFileSync('git', ['show', '-s', '--format=%s', revision], { cwd: root, encoding: 'utf8' }).trim();
        const message = execFileSync('git', ['show', '-s', '--format=%B', revision], { cwd: root, encoding: 'utf8' }).trim();
        const parentsLine = execFileSync('git', ['show', '-s', '--format=%P', revision], { cwd: root, encoding: 'utf8' }).trim();
        const parents = parentsLine === '' ? [] : parentsLine.split(/\s+/u);
        let reachable = true;
        try
        {
            execFileSync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], { cwd: root, stdio: 'ignore' });
        }
        catch
        {
            reachable = false;
        }
        return {
            exists: true,
            reachable,
            parents: parents.length,
            parent: parents.length === 1 ? parents[0] : null,
            subject,
            message
        };
    }
    catch
    {
        return { exists: false, reachable: false, parents: 0, parent: null, subject: '', message: '' };
    }
}

export function validateRepositoryBlameIgnore(root, requiredRevisions = [])
{
    const path = resolve(root, '.git-blame-ignore-revs');
    if (!existsSync(path))
    {
        return ['missing .git-blame-ignore-revs'];
    }
    const text = readFileSync(path, 'utf8');
    const revisions = parseBlameIgnoreRevisions(text);
    const repositoryLegacy = existsSync(resolve(root, 'docs/development/native-tooling-style-enforcement.md'))
        ? changeContract.reviewedLegacyFormatRevisions
        : [];
    const errors = validateBlameIgnoreRevisions(text, {
        requiredRevisions: [...repositoryLegacy, ...requiredRevisions],
        inspectRevision: (revision) => inspectGitRevision(root, revision)
    });
    const legacy = new Set(changeContract.reviewedLegacyFormatRevisions);
    for (const revision of revisions)
    {
        if (legacy.has(revision) || !fullShaPattern.test(revision))
        {
            continue;
        }
        const inspected = inspectGitRevision(root, revision);
        if (!inspected.exists || inspected.parents !== 1 || inspected.parent === null)
        {
            continue;
        }
        const header = parseCommitHeader(inspected.subject);
        if (header?.type !== 'style' || footerValue(inspected.message, 'Change-Class') !== 'format-only')
        {
            errors.push(`blame-ignore revision lacks a format-only commit contract: ${revision}`);
            continue;
        }
        for (const error of validateCommitMessage(inspected.message))
        {
            errors.push(`${revision}: ${error}`);
        }
        for (const error of validateFormatOnlyDiff(root, inspected.parent, revision))
        {
            errors.push(`${revision}: ${error}`);
        }
    }
    return errors;
}

export function mergeBaseBetween(root, base, head)
{
    return execFileSync('git', ['merge-base', base, head], { cwd: root, encoding: 'utf8' }).trim();
}

export function changedFilesBetween(root, base, head)
{
    const diffBase = mergeBaseBetween(root, base, head);
    const fields = execFileSync(
        'git',
        ['diff', '--name-status', '-z', '--diff-filter=ACDMRT', diffBase, head],
        { cwd: root }
    ).toString('utf8').split('\x00').filter(Boolean);
    const paths = [];
    for (let index = 0; index < fields.length;)
    {
        const status = fields[index];
        index += 1;
        const pathCount = /^[RC]/u.test(status) ? 2 : 1;
        for (let offset = 0; offset < pathCount && index < fields.length; offset += 1, index += 1)
        {
            paths.push(fields[index]);
        }
    }
    return [...new Set(paths)];
}

export function validateFormatOnlyDiff(root, base, head, { ignoredPaths = [] } = {})
{
    const ignored = new Set(ignoredPaths);
    try
    {
        const structuralChanges = execFileSync(
            'git',
            ['diff', '--name-only', '-z', '--diff-filter=ACDRT', base, head, '--'],
            { cwd: root }
        ).toString('utf8').split('\x00').filter((path) => path !== '' && !ignored.has(path));
        if (structuralChanges.length > 0)
        {
            return [`Format-only diff adds, copies, deletes, or renames files: ${structuralChanges.join(', ')}`];
        }

        const modifiedFiles = execFileSync(
            'git',
            ['diff', '--name-only', '-z', '--diff-filter=M', base, head, '--'],
            { cwd: root }
        ).toString('utf8').split('\x00').filter((path) => path !== '' && !ignored.has(path));
        const changedTokens = [];
        for (const path of modifiedFiles)
        {
            const before = execFileSync('git', ['show', `${base}:${path}`], { cwd: root });
            const after = execFileSync('git', ['show', `${head}:${path}`], { cwd: root });
            if (before.includes(0) || after.includes(0))
            {
                changedTokens.push(path);
                continue;
            }
            const beforeText = before.toString('utf8');
            const afterText = after.toString('utf8');
            const equivalent = formatFingerprint(beforeText, path) === formatFingerprint(afterText, path);
            if (!equivalent)
            {
                changedTokens.push(path);
            }
        }
        if (changedTokens.length > 0)
        {
            return [`Format-only diff changes non-whitespace or quoted-value tokens: ${changedTokens.join(', ')}`];
        }
        return [];
    }
    catch (error)
    {
        return [`cannot inspect Format-only diff: ${error instanceof Error ? error.message : String(error)}`];
    }
}

function lexicalTokens(source)
{
    const output = [];
    const operators = [
        '>>>=', '===', '!==', '>>>', '<<=', '>>=', '<=>', '...', '??=', '&&=', '||=',
        '==', '!=', '<=', '>=', '=>', '->', '::', '++', '--', '&&', '||', '??', '?.',
        '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '##'
    ];
    const wordCharacter = (character) => /[\p{L}\p{N}_$]/u.test(character);
    for (let index = 0; index < source.length; index += 1)
    {
        const character = source[index];
        const next = source[index + 1] ?? '';
        if (/\s/u.test(character))
        {
            continue;
        }
        if (character === '/' && next === '/')
        {
            const end = source.indexOf('\n', index + 2);
            const commentEnd = end < 0 ? source.length : end;
            const content = source.slice(index + 2, commentEnd).trim().replace(/\s+/gu, ' ');
            output.push(`line-comment:${content}`);
            index = commentEnd - 1;
            continue;
        }
        if (character === '/' && next === '*')
        {
            const end = source.indexOf('*/', index + 2);
            if (end < 0)
            {
                output.push(`unterminated-comment:${source.slice(index + 2)}`);
                break;
            }
            const content = source.slice(index + 2, end).trim().replace(/\s+/gu, ' ');
            output.push(`block-comment:${content}`);
            index = end + 1;
            continue;
        }
        if (character === '"' || character === "'" || character === '`')
        {
            let token = character;
            const quote = character;
            while (index + 1 < source.length)
            {
                index += 1;
                token += source[index];
                if (source[index] === '\\' && index + 1 < source.length)
                {
                    index += 1;
                    token += source[index];
                }
                else if (source[index] === quote)
                {
                    break;
                }
            }
            output.push(`quoted:${token}`);
            continue;
        }
        if (wordCharacter(character))
        {
            let token = character;
            while (index + 1 < source.length && wordCharacter(source[index + 1]))
            {
                index += 1;
                token += source[index];
            }
            output.push(`word:${token}`);
            continue;
        }
        const operator = operators.find((candidate) => source.startsWith(candidate, index));
        if (operator)
        {
            output.push(`operator:${operator}`);
            index += operator.length - 1;
            continue;
        }
        output.push(`punctuation:${character}`);
    }
    return output;
}

function indentationFingerprint(source)
{
    const levels = [0];
    const output = [];
    let fence = null;
    for (const line of source.split(/\r?\n/u))
    {
        const fenceMatch = line.match(/^\s*(```+|~~~+)/u);
        if (fenceMatch)
        {
            fence = fence === null ? fenceMatch[1][0] : null;
            output.push(`fence:${line.trim()}`);
            continue;
        }
        if (fence !== null)
        {
            output.push(`fenced-content:${line}`);
            continue;
        }
        if (line.trim() === '')
        {
            continue;
        }
        const indent = line.match(/^ */u)?.[0].length ?? 0;
        while (levels.length > 1 && indent < levels.at(-1))
        {
            levels.pop();
        }
        if (indent > levels.at(-1))
        {
            levels.push(indent);
        }
        const depth = indent === levels.at(-1) ? levels.length - 1 : `unaligned-${indent}`;
        output.push(`depth:${depth}`, ...lexicalTokens(line.trim()));
    }
    return output;
}

function preprocessorFingerprint(source)
{
    const output = [];
    let continuation = false;
    for (const line of source.split(/\r?\n/u))
    {
        const trimmed = line.trim();
        if (!continuation && !trimmed.startsWith('#'))
        {
            continue;
        }
        const continues = /\\\s*$/u.test(line);
        output.push(
            `directive-continuation:${continues}`,
            ...lexicalTokens(trimmed.replace(/\\\s*$/u, '\\'))
        );
        continuation = continues;
    }
    return output;
}

function formatFingerprint(source, path)
{
    const normalized = source.replace(/\r\n/gu, '\n');
    if (/\.ya?ml$/u.test(path) && /^\s*[^#\r\n][^\r\n]*:\s*[|>][-+0-9]*\s*(?:#.*)?$/mu.test(normalized))
    {
        return normalized;
    }
    const lineSensitive = /(?:\.ya?ml|\.md|\.sh|\.pyi?|\.m?[jt]sx?|\.c[jt]sx?|\.vue|(?:^|\/)Makefile|\.mk)$/u.test(path);
    const tokens = lineSensitive ? indentationFingerprint(normalized) : lexicalTokens(normalized);
    if (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/u.test(path))
    {
        tokens.push(...preprocessorFingerprint(normalized));
    }
    return tokens.join('\n');
}

export function commitsInRange(root, range)
{
    const output = execFileSync(
        'git',
        ['log', '--reverse', '--format=%H%x00%B%x00%x1e', range],
        { cwd: root, encoding: 'utf8' }
    );
    return output
        .split('\x1e')
        .map((record) => record.replace(/^\s+|\s+$/gu, ''))
        .filter(Boolean)
        .map((record) =>
        {
            const [revision, message] = record.split('\x00');
            return { revision: revision.trim(), message: message.trim() };
        });
}

export function validateCommitRange(root, range)
{
    const errors = [];
    const requiredBlameRevisions = [];
    const formatCommits = [];
    const performanceCommits = [];
    let commits;
    try
    {
        commits = commitsInRange(root, range);
    }
    catch (error)
    {
        return [`cannot read commit range ${range}: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (commits.length === 0)
    {
        return [`commit range is empty: ${range}`];
    }

    for (const { revision, message } of commits)
    {
        for (const error of validateCommitMessage(message))
        {
            errors.push(`${revision}: ${error}`);
        }
        const header = parseCommitHeader(message.split(/\r?\n/u, 1)[0]);
        if (header?.type === 'style' && footerValue(message, 'Change-Class') === 'format-only')
        {
            requiredBlameRevisions.push(revision);
            formatCommits.push({ revision, message });
            for (const error of validateFormatOnlyDiff(root, `${revision}^`, revision))
            {
                errors.push(`${revision}: ${error}`);
            }
        }
        if (header?.type === 'perf')
        {
            performanceCommits.push({ revision, message });
        }
    }
    errors.push(...validateRepositoryBlameIgnore(root, requiredBlameRevisions));
    const separator = range.lastIndexOf('..');
    if (separator >= 0)
    {
        const base = range.slice(0, separator);
        const head = range.slice(separator + 2);
        try
        {
            const changedFiles = changedFilesBetween(root, base, head);
            for (const { revision, message } of formatCommits)
            {
                validateFormatCommitEvidence(root, head, revision, message, changedFiles, errors);
            }
            for (const { revision, message } of performanceCommits)
            {
                validatePerformanceCommitEvidence(root, head, revision, message, changedFiles, errors);
            }
        }
        catch (error)
        {
            errors.push(`cannot bind range evidence ${range}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return errors;
}

export function validateFormatOnlyPullRequest(root, base, head, declaredRevision, evidencePath = null)
{
    const diffBase = mergeBaseBetween(root, base, head);
    const range = `${diffBase}..${head}`;
    const errors = validateCommitRange(root, range);
    let commits;
    try
    {
        commits = commitsInRange(root, range);
    }
    catch (error)
    {
        return [...errors, `cannot read format-only PR range ${range}: ${error instanceof Error ? error.message : String(error)}`];
    }

    const formatCommits = commits
        .filter(({ message }) =>
        {
            const header = parseCommitHeader(message.split(/\r?\n/u, 1)[0]);
            return header?.type === 'style' && footerValue(message, 'Change-Class') === 'format-only';
        });
    const formatRevisions = formatCommits.map(({ revision }) => revision);

    if (!fullShaPattern.test(declaredRevision ?? ''))
    {
        errors.push('format-only PR requires one full declared Blame-ignore revision SHA');
    }
    else if (formatRevisions.length !== 1 || formatRevisions[0] !== declaredRevision)
    {
        errors.push(`format-only PR declared revision must exactly match its one format-only commit: ${formatRevisions.join(', ') || 'none'}`);
    }
    if (formatCommits.length === 1 && footerValue(formatCommits[0].message, 'Idempotence-Evidence') !== evidencePath)
    {
        errors.push('format-only PR evidence path must match its format commit Idempotence-Evidence footer');
    }

    errors.push(...validateFormatOnlyDiff(root, diffBase, head, {
        ignoredPaths: [
            '.git-blame-ignore-revs',
            ...(repositoryPathPattern.test(evidencePath ?? '') ? [evidencePath] : [])
        ]
    }));
    return errors;
}

export function validatePerformancePullRequest(root, base, head, evidencePath)
{
    const diffBase = mergeBaseBetween(root, base, head);
    const range = `${diffBase}..${head}`;
    let commits;
    try
    {
        commits = commitsInRange(root, range);
    }
    catch (error)
    {
        return [`cannot read performance PR range ${range}: ${error instanceof Error ? error.message : String(error)}`];
    }
    const performanceCommits = commits.filter(({ message }) => (
        parseCommitHeader(message.split(/\r?\n/u, 1)[0])?.type === 'perf'
    ));
    if (performanceCommits.length !== 1)
    {
        return [`performance PR requires exactly one perf commit, found ${performanceCommits.length}`];
    }
    const [{ revision, message }] = performanceCommits;
    const errors = validateCommitMessage(message).map((error) => `${revision}: ${error}`);
    if (footerValue(message, 'Evidence') !== evidencePath)
    {
        errors.push('performance PR Evidence path must match its perf commit footer');
    }
    try
    {
        const changedFiles = changedFilesBetween(root, diffBase, head);
        validatePerformanceCommitEvidence(root, head, revision, message, changedFiles, errors);
    }
    catch (error)
    {
        errors.push(`cannot bind performance PR evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
    return errors;
}

export function validateRepositorySources(root)
{
    const errors = [];
    const requiredFiles = [...new Set([
        ...changeContract.trustedPolicyFiles,
        '.git-blame-ignore-revs',
        'config/development/authoritative-development-docs.json',
        'config/schemas/external-naming-exceptions.schema.json',
        'config/schemas/post-merge-external-naming-evidence-repair.schema.json',
        'config/schemas/post-merge-generated-output-repair.schema.json',
        'docs/development/change-contract.md',
        'docs/development/native-tooling-style-enforcement.md',
        'docs/repository-governance.md',
        'docs/repository-labels.md'
    ])];
    for (const path of requiredFiles)
    {
        if (!existsSync(resolve(root, path)))
        {
            errors.push(`missing ${path}`);
        }
    }
    if (errors.length > 0)
    {
        return errors;
    }

    const blameIgnore = parseBlameIgnoreRevisions(readFileSync(resolve(root, '.git-blame-ignore-revs'), 'utf8'));
    for (const revision of changeContract.reviewedLegacyFormatRevisions)
    {
        if (!blameIgnore.includes(revision))
        {
            errors.push(`repository sources missing reviewed legacy blame-ignore revision: ${revision}`);
        }
    }

    if (!sameStrings(commitlintConfig.rules?.['type-enum']?.[2] ?? [], changeContract.commitTypes))
    {
        errors.push('commitlint type adapter must consume the registry type list');
    }
    if (!sameStrings(commitlintConfig.rules?.['scope-enum']?.[2] ?? [], changeContract.commitScopes))
    {
        errors.push('commitlint scope adapter must consume the registry scope list');
    }
    const commitlintSource = readFileSync(resolve(root, 'commitlint.config.mjs'), 'utf8');
    for (const token of [
        "import { changeContract } from './tools/governance/change-contract-registry.mjs'",
        "'type-enum': [2, 'always', changeContract.commitTypes]",
        "'scope-enum': [2, 'always', changeContract.commitScopes]"
    ])
    {
        if (!commitlintSource.includes(token))
        {
            errors.push(`candidate commitlint adapter missing ${token}`);
        }
    }

    const registrySource = readFileSync(resolve(root, 'tools/governance/change-contract-registry.mjs'), 'utf8');
    for (const value of [
        ...changeContract.commitTypes,
        ...changeContract.commitScopes,
        ...changeContract.releaseNoteCategories.map((entry) => entry.label),
        ...changeContract.reviewedLegacyFormatRevisions,
        ...changeContract.trustedPolicyFiles,
        ...Object.values(changeContract.evidenceSchemas),
        ...changeContract.generatedOutputRepairProducers.flatMap((entry) => [
            entry.id,
            entry.source,
            entry.generator,
            entry.command,
            ...entry.outputs
        ])
    ])
    {
        if (!registrySource.includes(`'${value}'`))
        {
            errors.push(`candidate registry missing trusted value ${value}`);
        }
    }

    const template = readFileSync(resolve(root, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');
    for (const classification of changeContract.changeClassifications)
    {
        if (!template.includes(`- [ ] ${classification}`))
        {
            errors.push(`PR template missing classification: ${classification}`);
        }
    }
    for (const token of [
        'C# mother-style mapping checked',
        'Formatter/linter run',
        'No tool default overrides repository style',
        'Mechanical formatting separated from logic',
        '`.git-blame-ignore-revs` updated when applicable',
        'Public API docs updated',
        'Ownership/security/performance intent updated',
        'Historical handoff archived or source-of-truth updated',
        'TODO/FIXME references valid issues',
        '- Claim level:',
        '- Evidence path:',
        '- Non-goals:',
        '- Rollout:',
        '- Rollback:',
        '- Deferred work:',
        '- Known limitations:',
        '- Exceptions manifest:',
        'fsusblog.external-naming-exceptions.v1',
        'fsusblog.post-merge-external-naming-evidence-repair.v1',
        'fsusblog.performance-claim-evidence.v1',
        'Category: none',
        'owner-controlled direct push'
    ])
    {
        if (!template.includes(token))
        {
            errors.push(`PR template missing required token: ${token}`);
        }
    }

    const releaseConfig = readFileSync(resolve(root, '.github/release.yml'), 'utf8');
    for (const entry of changeContract.releaseNoteCategories)
    {
        if (!releaseConfig.includes(entry.label))
        {
            errors.push(`release configuration missing ${entry.label}`);
        }
        if (entry.category !== 'none' && !releaseConfig.includes(`title: ${entry.category}`))
        {
            errors.push(`release configuration missing category ${entry.category}`);
        }
    }

    const docs = readFileSync(resolve(root, 'docs/development/change-contract.md'), 'utf8');
    for (const value of [...changeContract.commitTypes, ...changeContract.commitScopes])
    {
        if (!docs.includes(`\`${value}\``))
        {
            errors.push(`change contract documentation missing registry value ${value}`);
        }
    }
    for (const exception of changeContract.machineIdentifierExceptions)
    {
        if (!docs.includes(`\`${exception.kind}\``))
        {
            errors.push(`change contract documentation missing machine identifier exception ${exception.kind}`);
        }
    }
    try
    {
        const developmentAuthority = JSON.parse(readFileSync(
            resolve(root, 'config/development/authoritative-development-docs.json'),
            'utf8'
        ));
        if (developmentAuthority?.authority?.changeContract !== 'docs/development/change-contract.md')
        {
            errors.push('authoritative development docs must register the change contract');
        }
    }
    catch (error)
    {
        errors.push(`cannot parse authoritative development docs registry: ${error instanceof Error ? error.message : String(error)}`);
    }
    const labelDocs = readFileSync(resolve(root, 'docs/repository-labels.md'), 'utf8');
    for (const entry of changeContract.releaseNoteCategories)
    {
        if (!labelDocs.includes(`\`${entry.label}\``))
        {
            errors.push(`repository label documentation missing ${entry.label}`);
        }
    }

    const workflow = readFileSync(resolve(root, '.github/workflows/change-contract.yml'), 'utf8');
    for (const token of [
        'pull_request:',
        'push:',
        'workflow_dispatch:',
        'contents: read',
        'fetch-depth: 0',
        'path: candidate',
        'path: trusted',
        'github.event.pull_request.base.sha',
        'github.event.before',
        'trusted pre-push',
        'node --test tests/tools/change-contract.test.mjs',
        '--root "$GITHUB_WORKSPACE/candidate"',
        '--github-event "$GITHUB_EVENT_PATH"'
    ])
    {
        if (!workflow.includes(token))
        {
            errors.push(`change contract workflow missing ${token}`);
        }
    }
    return errors;
}

export { changeContract };
