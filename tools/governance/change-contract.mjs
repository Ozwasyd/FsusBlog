import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { changeContract } from './change-contract-registry.mjs';
import { csharpFormatFingerprint } from './csharp-format-equivalence.mjs';
import { createGeneratedOutputDigestRepairRepository } from './generated-output-digest-repair-repository.mjs';
import { verifyGeneratedOutputDigestRepairV2 } from './generated-output-digest-repair-v2.mjs';
import { verifyGeneratedOutputHistoryRepairV3 } from './generated-output-history-repair-v3.mjs';
import { javascriptFormatFingerprint } from './javascript-format-equivalence.mjs';

const { default: commitlintConfig } = await import(new URL('../../commitlint.config.mjs', import.meta.url));

export { javascriptFormatFingerprint };
export { csharpFormatFingerprint };

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
const repositoryPathPattern = /^(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[A-Za-z0-9._/-]+$/u;
const revisionBlobMaximumBytes = 16 * 1024 * 1024;
const generatedOutputRepairDagMaximumRevisions = 128;
const generatedOutputRepairDagMaximumExecutions = 1536;

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

function sameStringSequence(left, right)
{
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactRevisionGitOptions(root, options = {})
{
    return {
        ...options,
        cwd: root,
        env: {
            ...process.env,
            ...options.env,
            GIT_NO_REPLACE_OBJECTS: '1'
        }
    };
}

function resolveRevisionBlob(root, revision, path)
{
    if (typeof revision !== 'string' || revision.length === 0 || revision.includes('\x00'))
    {
        throw new Error(`invalid repository revision: ${String(revision)}`);
    }
    if (typeof path !== 'string' || !repositoryPathPattern.test(path))
    {
        throw new Error(`invalid repository path: ${String(path)}`);
    }

    let commit;
    try
    {
        commit = execFileSync(
            'git',
            ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
            exactRevisionGitOptions(root, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        ).trim();
    }
    catch
    {
        throw new Error(`repository revision does not resolve to one commit: ${revision}`);
    }
    if (!fullShaPattern.test(commit))
    {
        throw new Error(`repository revision did not resolve to one commit: ${revision}`);
    }

    const treeOutput = execFileSync(
        'git',
        ['ls-tree', '-z', '--full-tree', commit, '--', path],
        exactRevisionGitOptions(root)
    );
    const treeRecords = treeOutput.toString('utf8').split('\0');
    const treeEntry = treeRecords[0].match(
        /^(?<mode>\d{6}) (?<type>[a-z]+) (?<object>[0-9a-f]{40})\t(?<path>[\s\S]+)$/u
    )?.groups;
    if (treeRecords.length !== 2 || treeRecords[1] !== '' || !treeEntry || treeEntry.path !== path)
    {
        throw new Error(`repository path does not resolve to one exact Git object at ${commit}: ${path}`);
    }
    if (!['100644', '100755'].includes(treeEntry.mode) || treeEntry.type !== 'blob')
    {
        throw new Error(`repository path is not a regular Git blob at ${commit}: ${path} (${treeEntry.mode} ${treeEntry.type})`);
    }

    const sizeText = execFileSync(
        'git',
        ['cat-file', '-s', treeEntry.object],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim();
    if (!/^(?:0|[1-9]\d*)$/u.test(sizeText) || !Number.isSafeInteger(Number(sizeText)))
    {
        throw new Error(`Git blob reported an invalid size at ${commit}: ${path}`);
    }
    return { commit, mode: treeEntry.mode, object: treeEntry.object, size: Number(sizeText) };
}

export function readFileAtRevision(root, revision, path, {
    maximumBytes = revisionBlobMaximumBytes
} = {})
{
    if (
        !Number.isSafeInteger(maximumBytes)
        || maximumBytes < 0
        || maximumBytes > revisionBlobMaximumBytes
    )
    {
        throw new Error(`revision blob maximum must be between 0 and ${revisionBlobMaximumBytes} bytes`);
    }
    const blob = resolveRevisionBlob(root, revision, path);
    if (blob.size > maximumBytes)
    {
        throw new Error(
            `Git blob exceeds the ${maximumBytes}-byte revision read limit at ${blob.commit}: ${path} (${blob.size} bytes)`
        );
    }
    const content = execFileSync(
        'git',
        ['cat-file', 'blob', blob.object],
        exactRevisionGitOptions(root, { maxBuffer: maximumBytes + 1 })
    );
    if (content.length !== blob.size)
    {
        throw new Error(
            `Git blob read was truncated at ${blob.commit}: ${path} (expected ${blob.size} bytes, received ${content.length})`
        );
    }
    return content;
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
            exactRevisionGitOptions(root, { stdio: 'ignore' })
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
        exactRevisionGitOptions(root, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    ).trim();
    return line === '' ? [] : line.split(/\s+/u).slice(1);
}

function gitChangedPaths(root, base, head)
{
    return execFileSync(
        'git',
        ['diff', '--name-only', '-z', base, head, '--'],
        exactRevisionGitOptions(root)
    ).toString('utf8').split('\x00').filter(Boolean);
}

function gitRevisionIsAncestor(root, ancestor, descendant)
{
    try
    {
        execFileSync(
            'git',
            ['merge-base', '--is-ancestor', ancestor, descendant],
            exactRevisionGitOptions(root, { stdio: 'ignore' })
        );
        return true;
    }
    catch
    {
        return false;
    }
}

function gitMergeBase(root, left, right)
{
    return execFileSync(
        'git',
        ['merge-base', left, right],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim();
}

function gitFirstParentChainIncludes(root, revision, descendant)
{
    return execFileSync(
        'git',
        ['rev-list', '--first-parent', descendant],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim().split('\n').includes(revision);
}

function gitBoundedFirstParentChainIncludes(root, revision, descendant, maximum = 128)
{
    let current = descendant;
    for (let distance = 0; distance <= maximum; distance += 1)
    {
        if (current === revision)
        {
            return true;
        }
        const parents = gitRevisionParents(root, current);
        if (parents.length === 0)
        {
            return false;
        }
        current = parents[0];
    }
    return false;
}

function gitLastRevisionForPath(root, revision, path)
{
    return execFileSync(
        'git',
        ['log', '-1', '--format=%H', revision, '--', path],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim();
}

function gitFirstParentRevisionsForPath(root, base, head, path)
{
    return execFileSync(
        'git',
        ['log', '--first-parent', '--format=%H', `${base}..${head}`, '--', path],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim().split('\n').filter(Boolean);
}

function gitFullHistoryRevisionsForPath(root, base, head, path)
{
    return execFileSync(
        'git',
        ['log', '--full-history', '--format=%H', `${base}..${head}`, '--', path],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim().split('\n').filter(Boolean);
}

function mergeCommitNamesPullRequest(root, revision, pullRequest)
{
    const subject = execFileSync(
        'git',
        ['show', '-s', '--format=%s', revision],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim();
    return new RegExp(`^Merge pull request #${pullRequest}\\b`, 'u').test(subject)
        || new RegExp(`\\(#${pullRequest}\\)$`, 'u').test(subject);
}

function removeReplayWorktree(root, worktree, temporaryRoot)
{
    let cleanupError = null;
    if (existsSync(worktree))
    {
        try
        {
            execFileSync(
                'git',
                ['worktree', 'remove', '--force', worktree],
                exactRevisionGitOptions(root, { stdio: 'ignore' })
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

function replayGeneratedOutput(root, revision, producer)
{
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-generated-output-repair-'));
    const worktree = join(temporaryRoot, 'worktree');
    try
    {
        execFileSync(
            'git',
            ['worktree', 'add', '--detach', worktree, revision],
            exactRevisionGitOptions(root, { stdio: 'ignore' })
        );
        execFileSync(producer.executable, producer.arguments, {
            cwd: worktree,
            env: {
                ...process.env,
                FSUSBLOG_DOCS_EVIDENCE_DIR: join(temporaryRoot, 'evidence'),
                GIT_NO_REPLACE_OBJECTS: '1'
            },
            stdio: 'pipe'
        });
        const modified = execFileSync(
            'git',
            ['diff', '--name-only', '-z', '--'],
            exactRevisionGitOptions(worktree)
        ).toString('utf8').split('\x00').filter(Boolean);
        const untracked = execFileSync(
            'git',
            ['ls-files', '--others', '--exclude-standard', '-z'],
            exactRevisionGitOptions(worktree)
        ).toString('utf8').split('\x00').filter(Boolean);
        const ignored = execFileSync(
            'git',
            ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
            exactRevisionGitOptions(worktree)
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
        removeReplayWorktree(root, worktree, temporaryRoot);
    }
}

function trackedInputTreeDigest(root, revision, excludedPaths)
{
    const excluded = new Set(excludedPaths);
    const entries = execFileSync(
        'git',
        ['ls-tree', '-r', '-z', '--full-tree', revision],
        exactRevisionGitOptions(root)
    ).toString('utf8').split('\x00').filter(Boolean);
    const hash = createHash('sha256');
    for (const entry of entries)
    {
        const parsed = entry.match(/^(?<mode>\d{6}) (?<type>[a-z]+) (?<object>[0-9a-f]{40})\t(?<path>.+)$/u)?.groups;
        if (!parsed || !repositoryPathPattern.test(parsed.path))
        {
            throw new Error(`tracked input tree contains an invalid Git entry: ${entry}`);
        }
        if (excluded.has(parsed.path))
        {
            continue;
        }
        hash.update(parsed.mode);
        hash.update('\x00');
        hash.update(parsed.type);
        hash.update('\x00');
        hash.update(parsed.object);
        hash.update('\x00');
        hash.update(parsed.path);
        hash.update('\x00');
    }
    return hash.digest('hex');
}

function worktreeChangedPaths(worktree)
{
    const modified = execFileSync(
        'git',
        ['diff', '--name-only', '-z', '--'],
        exactRevisionGitOptions(worktree)
    ).toString('utf8').split('\x00').filter(Boolean);
    const staged = execFileSync(
        'git',
        ['diff', '--cached', '--name-only', '-z', '--'],
        exactRevisionGitOptions(worktree)
    ).toString('utf8').split('\x00').filter(Boolean);
    const untracked = execFileSync(
        'git',
        ['ls-files', '--others', '--exclude-standard', '-z'],
        exactRevisionGitOptions(worktree)
    ).toString('utf8').split('\x00').filter(Boolean);
    const ignored = execFileSync(
        'git',
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        exactRevisionGitOptions(worktree)
    ).toString('utf8').split('\x00').filter(Boolean);
    return [...new Set([...modified, ...staged, ...untracked, ...ignored])];
}

function createDagReplayGuard()
{
    return {
        executions: 0,
        revisions: new Set(),
        verifiedReplays: new Map()
    };
}

function admitDagRevision(guard, revision)
{
    guard.revisions.add(revision);
    if (guard.revisions.size > generatedOutputRepairDagMaximumRevisions)
    {
        throw new Error(
            `producer DAG exceeds ${generatedOutputRepairDagMaximumRevisions} unique replay revisions`
        );
    }
}

function executeDagProducer(guard, executable, arguments_, options)
{
    guard.executions += 1;
    if (guard.executions > generatedOutputRepairDagMaximumExecutions)
    {
        throw new Error(
            `producer DAG exceeds ${generatedOutputRepairDagMaximumExecutions} producer executions`
        );
    }
    return execFileSync(executable, arguments_, {
        ...options,
        env: {
            ...options.env,
            FSUSBLOG_GENERATED_OUTPUT_REPAIR_REPLAY: '1'
        }
    });
}

function worktreeOutputState(worktree, path)
{
    const lexicalRoot = resolve(worktree);
    const lexicalPath = resolve(worktree, path);
    if (lexicalPath !== lexicalRoot && !lexicalPath.startsWith(`${lexicalRoot}/`))
    {
        throw new Error(`producer DAG output escapes its worktree: ${path}`);
    }
    if (!existsSync(lexicalPath))
    {
        return { exists: false };
    }
    const physicalRoot = realpathSync(lexicalRoot);
    const physicalPath = realpathSync(lexicalPath);
    const stat = lstatSync(lexicalPath);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`producer DAG output is not one canonical regular file: ${path}`);
    }
    if (physicalPath !== physicalRoot && !physicalPath.startsWith(`${physicalRoot}/`))
    {
        throw new Error(`producer DAG output resolves outside its worktree: ${path}`);
    }
    return {
        exists: true,
        mode: stat.mode & 0o777,
        sha256: createHash('sha256').update(readFileSync(lexicalPath)).digest('hex')
    };
}

function replayGeneratedOutputDag(root, revision, graph, guard)
{
    admitDagRevision(guard, revision);
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-generated-output-repair-dag-'));
    const worktree = join(temporaryRoot, 'worktree');
    const graphOutputs = graph.steps.flatMap((step) => step.outputs);
    try
    {
        execFileSync(
            'git',
            ['worktree', 'add', '--detach', worktree, revision],
            exactRevisionGitOptions(root, { stdio: 'ignore' })
        );
        const inputEntries = execFileSync('git', ['ls-tree', '-r', '-z', revision],
            exactRevisionGitOptions(root)).toString('utf8').split('\x00').filter(Boolean);
        const lexicalRoot = resolve(worktree);
        const physicalRoot = realpathSync(worktree);
        for (const entry of inputEntries)
        {
            const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
            if (!match)
            {
                throw new Error('producer DAG input is not one canonical regular file');
            }
            const inputPath = resolve(lexicalRoot, match[3]);
            if (!inputPath.startsWith(`${lexicalRoot}/`))
            {
                throw new Error(`producer DAG input resolves outside its original tree: ${match[3]}`);
            }
            const physicalPath = realpathSync(inputPath);
            if (physicalPath !== physicalRoot && !physicalPath.startsWith(`${physicalRoot}/`))
            {
                throw new Error(`producer DAG input resolves outside its original tree: ${match[3]}`);
            }
            const stat = lstatSync(inputPath);
            if (!stat.isFile() || stat.isSymbolicLink()
                || ((stat.mode & 0o111) !== 0) !== (match[1] === '100755'))
            {
                throw new Error(`producer DAG input mode differs from its Git entry: ${match[3]}`);
            }
        }
        const runPass = () =>
        {
            for (const step of graph.steps)
            {
                const before = new Map(graphOutputs.map((path) => [
                    path,
                    worktreeOutputState(worktree, path)
                ]));
                executeDagProducer(guard, step.executable, step.arguments, {
                    cwd: worktree,
                    env: {
                        ...process.env,
                        FSUSBLOG_DOCS_EVIDENCE_DIR: join(temporaryRoot, 'evidence'),
                        GIT_NO_REPLACE_OBJECTS: '1',
                        LANG: 'C.UTF-8',
                        LC_ALL: 'C.UTF-8',
                        TZ: 'UTC'
                    },
                    stdio: 'pipe',
                    timeout: 120_000,
                    maxBuffer: revisionBlobMaximumBytes
                });
                const outputDelta = graphOutputs.filter((path) => (
                    JSON.stringify(before.get(path)) !== JSON.stringify(worktreeOutputState(worktree, path))
                ));
                const unexpectedOutputDelta = outputDelta.filter((path) => !step.outputs.includes(path));
                if (unexpectedOutputDelta.length > 0)
                {
                    throw new Error(`producer step wrote another step's output: ${step.id}: ${unexpectedOutputDelta.join(', ')}`);
                }
                const unexpected = worktreeChangedPaths(worktree)
                    .filter((path) => !graphOutputs.includes(path));
                if (unexpected.length > 0)
                {
                    throw new Error(`producer DAG wrote unregistered outputs: ${unexpected.join(', ')}`);
                }
            }
        };
        runPass();
        const firstPassStates = new Map(graphOutputs.map((path) => [
            path,
            worktreeOutputState(worktree, path)
        ]));
        runPass();
        for (const [path, state] of firstPassStates)
        {
            if (JSON.stringify(worktreeOutputState(worktree, path)) !== JSON.stringify(state))
            {
                throw new Error(`producer DAG is not fixed-point after one ordered pass: ${path}`);
            }
        }
        const projectionDocument = JSON.parse(readFileSync(
            resolve(worktree, graph.semanticProjection.output),
            'utf8'
        ));
        const projectionDigest = projectionDocument[graph.semanticProjection.digestField];
        const projectionEntries = projectionDocument[graph.semanticProjection.entriesField];
        if (!/^sha256:[0-9a-f]{64}$/u.test(projectionDigest ?? '') || !Array.isArray(projectionEntries))
        {
            throw new Error('producer DAG semantic projection is malformed');
        }
        return {
            changedPaths: worktreeChangedPaths(worktree),
            outputs: new Map([...firstPassStates].map(([path, state]) => [path, state.sha256])),
            outputStates: firstPassStates,
            projection: {
                findingCount: projectionEntries.length,
                sha256: projectionDigest.slice('sha256:'.length)
            }
        };
    }
    finally
    {
        removeReplayWorktree(root, worktree, temporaryRoot);
    }
}

function replayVector(replay)
{
    return JSON.stringify({
        outputs: [...replay.outputs],
        outputStates: [...replay.outputStates],
        projection: replay.projection
    });
}

function verifiedDagReplay(root, revision, graph, guard)
{
    const cached = guard.verifiedReplays.get(revision);
    if (cached)
    {
        return cached;
    }
    const first = replayGeneratedOutputDag(root, revision, graph, guard);
    const second = replayGeneratedOutputDag(root, revision, graph, guard);
    if (replayVector(first) !== replayVector(second) || !sameStrings(first.changedPaths, second.changedPaths))
    {
        throw new Error(`producer DAG replay is not deterministic at ${revision}`);
    }
    guard.verifiedReplays.set(revision, first);
    return first;
}

function verifyDagStepConsumption(root, revision, graph, guard)
{
    admitDagRevision(guard, revision);
    for (const [stepIndex, step] of graph.steps.entries())
    {
        for (const consumedPath of step.consumes)
        {
            const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-generated-output-consumption-'));
            const worktree = join(temporaryRoot, 'worktree');
            try
            {
                execFileSync(
                    'git',
                    ['worktree', 'add', '--detach', worktree, revision],
                    exactRevisionGitOptions(root, { stdio: 'ignore' })
                );
                for (const dependencyStep of graph.steps.slice(0, stepIndex))
                {
                    executeDagProducer(guard, dependencyStep.executable, dependencyStep.arguments, {
                        cwd: worktree,
                        env: {
                            ...process.env,
                            FSUSBLOG_DOCS_EVIDENCE_DIR: join(temporaryRoot, 'evidence'),
                            GIT_NO_REPLACE_OBJECTS: '1',
                            LANG: 'C.UTF-8',
                            LC_ALL: 'C.UTF-8',
                            TZ: 'UTC'
                        },
                        stdio: 'pipe',
                        timeout: 120_000,
                        maxBuffer: revisionBlobMaximumBytes
                    });
                }
                executeDagProducer(guard, step.executable, step.arguments, {
                    cwd: worktree,
                    env: {
                        ...process.env,
                        FSUSBLOG_DOCS_EVIDENCE_DIR: join(temporaryRoot, 'evidence'),
                        GIT_NO_REPLACE_OBJECTS: '1',
                        LANG: 'C.UTF-8',
                        LC_ALL: 'C.UTF-8',
                        TZ: 'UTC'
                    },
                    stdio: 'pipe',
                    timeout: 120_000,
                    maxBuffer: revisionBlobMaximumBytes
                });
                const baseline = new Map(step.outputs.map((path) => [
                    path,
                    worktreeOutputState(worktree, path)
                ]));
                appendFileSync(resolve(worktree, consumedPath), '\n');
                let rejected = false;
                try
                {
                    executeDagProducer(guard, step.executable, step.arguments, {
                        cwd: worktree,
                        env: {
                            ...process.env,
                            FSUSBLOG_DOCS_EVIDENCE_DIR: join(temporaryRoot, 'evidence'),
                            GIT_NO_REPLACE_OBJECTS: '1',
                            LANG: 'C.UTF-8',
                            LC_ALL: 'C.UTF-8',
                            TZ: 'UTC'
                        },
                        stdio: 'pipe',
                        timeout: 120_000,
                        maxBuffer: revisionBlobMaximumBytes
                    });
                }
                catch
                {
                    rejected = true;
                }
                const outputChanged = step.outputs.some((path) => (
                    JSON.stringify(baseline.get(path)) !== JSON.stringify(worktreeOutputState(worktree, path))
                ));
                if (!rejected && !outputChanged)
                {
                    throw new Error(`producer step does not consume its declared dependency output: ${step.id}: ${consumedPath}`);
                }
            }
            finally
            {
                removeReplayWorktree(root, worktree, temporaryRoot);
            }
        }
    }
}

function gitFirstParentRange(root, base, head, maximum = 128)
{
    const revisions = execFileSync(
        'git',
        ['rev-list', '--first-parent', '--reverse', `${base}..${head}`],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim().split('\n').filter(Boolean);
    if (revisions.length > maximum)
    {
        throw new Error(`first-parent range exceeds ${maximum} revisions`);
    }
    return revisions;
}

function gitPullRequestBranchFirstParentRange(root, mergeBase, mergeHead, maximum = 128)
{
    const revisions = [];
    let current = mergeHead;
    while (!gitRevisionIsAncestor(root, current, mergeBase))
    {
        revisions.push(current);
        if (revisions.length > maximum)
        {
            throw new Error(`pull request first-parent range exceeds ${maximum} revisions`);
        }
        const parents = gitRevisionParents(root, current);
        if (parents.length === 0)
        {
            throw new Error('pull request first-parent chain does not join its outer base');
        }
        current = parents[0];
    }
    return revisions.reverse();
}

function outputVectorChanged(left, right)
{
    return JSON.stringify([...left.outputs]) !== JSON.stringify([...right.outputs])
        || left.projection.findingCount !== right.projection.findingCount
        || left.projection.sha256 !== right.projection.sha256;
}

function dagEvidenceExceedsBounds(evidence, errors)
{
    let exceeded = false;
    for (const [label, value, maximum] of [
        ['sourceEvents', evidence.sourceEvents, 64],
        ['synchronizedOutputOwners', evidence.synchronizedOutputOwners, 128],
        ['steps', evidence.steps, 16],
        ['outputs', evidence.outputs, 128]
    ])
    {
        if (Array.isArray(value) && value.length > maximum)
        {
            errors.push(`Post-merge generated repair DAG ${label} exceeds ${maximum} entries`);
            exceeded = true;
        }
    }
    if (!Array.isArray(evidence.steps))
    {
        return exceeded;
    }
    for (const [index, step] of evidence.steps.entries())
    {
        for (const [label, value, maximum] of [
            ['arguments', step?.arguments, 128],
            ['dependsOn', step?.dependsOn, 16],
            ['consumes', step?.consumes, 128],
            ['generatorClosure', step?.generatorClosure, 128],
            ['outputs', step?.outputs, 128]
        ])
        {
            if (Array.isArray(value) && value.length > maximum)
            {
                errors.push(`Post-merge generated repair DAG step ${index} ${label} exceeds ${maximum} entries`);
                exceeded = true;
            }
        }
    }
    return exceeded;
}

function revisionPathIdentity(root, revision, path)
{
    const blob = resolveRevisionBlob(root, revision, path);
    return `${blob.mode}:${blob.object}`;
}

// Historical repair admission records Git objects, never an overlaid worktree.
// The returned seal is review data; it is not itself permission to run a producer.
export function inspectGeneratedRepairDagHistory(root, graph, synchronizedMerge, reviewedRevision, synchronizedRevision)
{
    if (!fullShaPattern.test(synchronizedMerge ?? '') || !fullShaPattern.test(reviewedRevision ?? '')
        || !fullShaPattern.test(synchronizedRevision ?? '')
        || !gitFirstParentChainIncludes(root, synchronizedMerge, reviewedRevision))
    {
        throw new Error('reviewed DAG history requires exact first-parent boundaries');
    }
    const protectedPaths = [...new Set([
        ...graph.steps.flatMap((step) => step.outputs),
        ...graph.steps.flatMap((step) => step.generatorClosure),
        ...changeContract.trustedPolicyFiles
    ])].sort();
    const synchronizedParents = gitRevisionParents(root, synchronizedMerge);
    if (synchronizedParents.length !== 2
        || !gitFirstParentChainIncludes(root, synchronizedRevision, synchronizedParents[1])
        || gitRevisionIsAncestor(root, synchronizedRevision, synchronizedParents[0]))
    {
        throw new Error('reviewed DAG synchronized source must belong only to its merge head');
    }
    const revisions = new Set([synchronizedMerge, synchronizedRevision]);
    const branches = [];
    const include = (revision) =>
    {
        revisions.add(revision);
        for (const parent of gitRevisionParents(root, revision))
        {
            revisions.add(parent);
        }
        if (revisions.size > generatedOutputRepairDagMaximumRevisions)
        {
            throw new Error('reviewed DAG history exceeds the revision bound');
        }
    };
    const outerRevisions = gitFirstParentRange(root, synchronizedMerge, reviewedRevision);
    for (const outerRevision of outerRevisions)
    {
        include(outerRevision);
        const parents = gitRevisionParents(root, outerRevision);
        if (parents.length !== 2)
        {
            continue;
        }
        const branchRevisions = gitPullRequestBranchFirstParentRange(root, parents[0], parents[1]);
        for (const revision of branchRevisions)
        {
            include(revision);
        }
        branches.push({
            outerRevision,
            parents,
            mergeBase: gitMergeBase(root, parents[0], parents[1]),
            branchRevisions
        });
    }
    const nodes = [...revisions].sort().map((revision) => ({
        revision,
        parents: gitRevisionParents(root, revision),
        entries: protectedPaths.map((path) =>
        {
            const line = execFileSync('git', ['ls-tree', revision, '--', path],
                exactRevisionGitOptions(root, { encoding: 'utf8' })).trim();
            if (line === '')
            {
                return { path, mode: null, object: null };
            }
            const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
            if (!match || match[3] !== path)
            {
                throw new Error(`reviewed DAG history contains a nonregular protected entry: ${revision}: ${path}`);
            }
            return { path, mode: match[1], object: match[2] };
        })
    }));
    const history = { synchronizedMerge, synchronizedRevision, reviewedRevision, protectedPaths, outerRevisions, branches, nodes };
    return {
        ...history,
        sha256: createHash('sha256').update(JSON.stringify(history)).digest('hex')
    };
}

export function validateReviewedGeneratedRepairDagEvents(registration, observedBranches, sourceEvents)
{
    const expectedBranches = registration.sourceBranches;
    if (!Array.isArray(observedBranches) || !Array.isArray(sourceEvents)
        || JSON.stringify(observedBranches) !== JSON.stringify(expectedBranches))
    {
        return ['reviewed DAG outer branches and replayed transitions must match the complete registered order'];
    }
    if (new Set(observedBranches.map((branch) => branch.mergeCommit)).size !== observedBranches.length)
    {
        return ['reviewed DAG outer merge identities must be unique'];
    }
    const expectedEvents = expectedBranches.flatMap((branch) => branch.transitions.map((sourceRevision) => ({
        sourceRevision,
        mergedPullRequest: branch.mergedPullRequest,
        mergeCommit: branch.mergeCommit
    })));
    if (sourceEvents.length !== expectedEvents.length || sourceEvents.some((event, index) => (
        !event || !sameStrings(Object.keys(event), ['sourceRevision', 'mergedPullRequest', 'mergeCommit'])
        || event.sourceRevision !== expectedEvents[index].sourceRevision
        || event.mergedPullRequest !== expectedEvents[index].mergedPullRequest
        || event.mergeCommit !== expectedEvents[index].mergeCommit
    )))
    {
        return ['reviewed DAG source events must match every replayed transition exactly once and in order'];
    }
    return [];
}

export function validateGeneratedRepairDagEventOrder(sourceEvents, expectedEvents)
{
    if (!Array.isArray(sourceEvents) || sourceEvents.length !== expectedEvents.length
        || sourceEvents.some((event, index) => (
            !event || !sameStrings(Object.keys(event), ['sourceRevision', 'mergedPullRequest', 'mergeCommit'])
            || event.sourceRevision !== expectedEvents[index].sourceRevision
            || event.mergedPullRequest !== expectedEvents[index].mergedPullRequest
            || event.mergeCommit !== expectedEvents[index].mergeCommit
        )))
    {
        return ['Post-merge generated repair DAG sourceEvents must match the complete global replay order'];
    }
    return [];
}

export function reviewedDagHistoryAdmission(root, graph, synchronizedMerge, synchronizedRevision, base)
{
    const registration = changeContract.generatedOutputRepairDagReviewedHistories.find((entry) => (
        entry.producerId === graph.id && entry.synchronizedMerge === synchronizedMerge
        && entry.synchronizedRevision === synchronizedRevision
    ));
    if (!registration || !gitFirstParentChainIncludes(root, registration.reviewedRevision, base))
    {
        return null;
    }
    const history = inspectGeneratedRepairDagHistory(root, graph, synchronizedMerge,
        registration.reviewedRevision, synchronizedRevision);
    if (history.sha256 !== registration.historySha256)
    {
        throw new Error('reviewed DAG history object, mode, topology, or boundary seal changed');
    }
    const nodes = new Map(history.nodes.map((node) => [node.revision, node]));
    for (const registeredBranch of registration.sourceBranches)
    {
        const branch = history.branches.find((entry) => entry.outerRevision === registeredBranch.mergeCommit);
        if (!branch || !mergeCommitNamesPullRequest(root, registeredBranch.mergeCommit, registeredBranch.mergedPullRequest)
            || new Set(registeredBranch.transitions).size !== registeredBranch.transitions.length
            || registeredBranch.transitions.some((revision) => (
                !branch.branchRevisions.includes(revision) || gitRevisionIsAncestor(root, revision, branch.parents[0])
            )))
        {
            throw new Error('reviewed DAG transition registration does not match its exact merge provenance');
        }
    }
    const entryAt = (revision, path) =>
    {
        const node = nodes.get(revision);
        if (node)
        {
            return node.entries.find((entry) => entry.path === path);
        }
        const line = execFileSync('git', ['ls-tree', revision, '--', path],
            exactRevisionGitOptions(root, { encoding: 'utf8' })).trim();
        if (!line)
        {
            return { path, mode: null, object: null };
        }
        const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
        if (!match || match[3] !== path)
        {
            throw new Error('reviewed DAG import contains a nonregular entry');
        }
        return { path, mode: match[1], object: match[2] };
    };
    const policyPathIdentity = (revision, path) =>
    {
        const entry = entryAt(revision, path);
        return entry.mode === null ? null : `${entry.mode}:${entry.object}`;
    };
    for (const branch of history.branches)
    {
        for (const revision of branch.branchRevisions)
        {
            const node = nodes.get(revision);
            const changed = history.protectedPaths.filter((path) => (
                JSON.stringify(entryAt(revision, path)) !== JSON.stringify(entryAt(node.parents[0], path))
            ));
            if (!changed.length)
            {
                continue;
            }
            const imported = node.parents.length === 2
                && gitRevisionIsAncestor(root, node.parents[1], branch.parents[0])
                && changed.every((path) => JSON.stringify(entryAt(revision, path))
                    === JSON.stringify(entryAt(node.parents[1], path)));
            const reviewedPolicyTransition = registration.sourceBranches.some((entry) => (
                entry.mergeCommit === branch.outerRevision && entry.transitions.includes(revision)
            )) && changed.every((path) => changeContract.trustedPolicyFiles.includes(path));
            if (!imported && !reviewedPolicyTransition)
            {
                throw new Error(`reviewed DAG historical change is neither exact authoritative import nor reviewed policy: ${revision}`);
            }
        }
    }
    const admittedPolicyRevisions = new Set();
    const admittedPolicyOuter = new Set();
    const initialPolicy = new Map(changeContract.trustedPolicyFiles.map((path) => [
        path, policyPathIdentity(registration.reviewedRevision, path)
    ]));
    const currentPolicy = new Map(changeContract.trustedPolicyFiles.map((path) => [
        path, policyPathIdentity(base, path)
    ]));
    const graphPaths = new Set(graph.steps.flatMap((step) => [...step.outputs, ...step.generatorClosure]));
    const suffixRevisions = new Set(nodes.keys());
    const inspectPolicyRevision = (revision) =>
    {
        if (nodes.has(revision))
        {
            return;
        }
        const parents = gitRevisionParents(root, revision);
        for (const value of [revision, ...parents])
        {
            suffixRevisions.add(value);
        }
        if (suffixRevisions.size > generatedOutputRepairDagMaximumRevisions)
        {
            throw new Error('current policy epoch exceeds the aggregate revision bound');
        }
        if (![1, 2].includes(parents.length))
        {
            throw new Error('current policy epoch has invalid parent topology');
        }
        const changed = gitChangedPaths(root, parents[0], revision);
        const policyChanges = changed.filter((path) => currentPolicy.has(path));
        for (const [path, currentIdentity] of currentPolicy)
        {
            const actualIdentity = policyPathIdentity(revision, path);
            const parentIdentity = policyPathIdentity(parents[0], path);
            const initialIdentity = initialPolicy.get(path);
            if (![initialIdentity, currentIdentity].includes(actualIdentity)
                || (![initialIdentity, currentIdentity].includes(parentIdentity) && !nodes.has(parents[0])))
            {
                throw new Error(`current policy epoch contains an unregistered intermediate identity: ${revision}: ${path}`);
            }
            if (parentIdentity === currentIdentity && actualIdentity !== currentIdentity)
            {
                throw new Error(`current policy epoch rolled back after reaching trusted base: ${revision}: ${path}`);
            }
        }
        if (policyChanges.length === 0)
        {
            return;
        }
        if (changed.some((path) => graphPaths.has(path)))
        {
            throw new Error(`current policy transition changed generator closure or outputs: ${revision}`);
        }
        if (parents.length === 2 && policyChanges.some((path) => (
            policyPathIdentity(revision, path) !== policyPathIdentity(parents[1], path)
        )))
        {
            throw new Error(`current policy merge does not preserve its authoritative second parent: ${revision}`);
        }
        admittedPolicyRevisions.add(revision);
    };
    for (const outer of gitFirstParentRange(root, registration.reviewedRevision, base))
    {
        const parents = gitRevisionParents(root, outer);
        if (parents.length === 2)
        {
            for (const revision of gitPullRequestBranchFirstParentRange(root, parents[0], parents[1]))
            {
                inspectPolicyRevision(revision);
            }
        }
        inspectPolicyRevision(outer);
        if (admittedPolicyRevisions.has(outer))
        {
            admittedPolicyOuter.add(outer);
        }
    }
    return { registration, history, nodes, coveredOuter: new Set(history.outerRevisions), admittedPolicyRevisions, admittedPolicyOuter };
}

function gitBoundedAncestryGraph(root, descendant, boundaries, maximum = 128)
{
    if (!Array.isArray(boundaries) || boundaries.length === 0 || new Set(boundaries).size !== boundaries.length)
    {
        throw new Error('registered history boundaries must be a non-empty unique list');
    }
    const boundarySet = new Set(boundaries);
    const reachedBoundaries = new Set();
    const graph = new Map();
    const pending = [descendant];
    let edgeCount = 0;
    while (pending.length > 0)
    {
        const revision = pending.pop();
        if (boundarySet.has(revision))
        {
            reachedBoundaries.add(revision);
            continue;
        }
        if (graph.has(revision))
        {
            continue;
        }
        const parents = gitRevisionParents(root, revision);
        if (parents.length === 0)
        {
            throw new Error(`registered history does not terminate at a boundary: ${revision}`);
        }
        edgeCount += parents.length;
        if (edgeCount > maximum)
        {
            throw new Error(`registered history exceeds ${maximum} parent edges`);
        }
        graph.set(revision, parents);
        pending.push(...parents);
    }
    if (reachedBoundaries.size !== boundarySet.size)
    {
        throw new Error('registered history does not reach every boundary');
    }
    return graph;
}

function boundedGraphIncludesAncestor(graph, ancestor, descendant)
{
    const pending = [descendant];
    const visited = new Set();
    while (pending.length > 0)
    {
        const revision = pending.pop();
        if (revision === ancestor)
        {
            return true;
        }
        if (visited.has(revision))
        {
            continue;
        }
        visited.add(revision);
        pending.push(...(graph.get(revision) ?? []));
    }
    return false;
}

function generatedRepairPassThroughExceptionErrors(
    root,
    producer,
    evidence,
    base,
    head,
    exception
)
{
    const errors = [];
    const fail = (message) => errors.push(`Registered generated repair pass-through is invalid: ${message}`);
    if (
        exception?.producerId !== producer.id
        || exception?.repairBase !== base
        || exception?.repairHead !== head
        || exception?.sourceCommit !== evidence.sourceCommit
        || exception?.mergedPullRequest !== evidence.mergedPullRequest
        || exception?.mergeCommit !== evidence.mergeCommit
    )
    {
        fail('repair identity does not match the immutable registry tuple');
        return errors;
    }

    const passThroughParents = gitRevisionParents(root, exception.passThroughCommit);
    const outerMergeParents = gitRevisionParents(root, exception.outerMergeCommit);
    if (!sameStringSequence(passThroughParents, exception.passThroughParents))
    {
        fail('pass-through parents do not match the immutable registry tuple');
    }
    if (!sameStringSequence(outerMergeParents, exception.outerMergeParents))
    {
        fail('outer merge parents do not match the immutable registry tuple');
    }
    if (!mergeCommitNamesPullRequest(root, exception.outerMergeCommit, exception.outerPullRequest))
    {
        fail('outer merge does not name the registered pull request');
    }

    const [passThroughFirstParent, passThroughSecondParent] = exception.passThroughParents;
    const [outerFirstParent, outerSecondParent] = exception.outerMergeParents;
    const divergenceBoundary = exception.historyBoundaries?.[1];
    if (
        !sameStringSequence(exception.historyBoundaries, [exception.mergeCommit, divergenceBoundary])
        || !fullShaPattern.test(divergenceBoundary ?? '')
        || !sameStringSequence(gitRevisionParents(root, passThroughFirstParent), [divergenceBoundary])
        || !gitBoundedFirstParentChainIncludes(root, divergenceBoundary, exception.mergeCommit)
    )
    {
        fail('history boundaries do not match the exact source divergence frontier');
    }
    const historyGraph = gitBoundedAncestryGraph(
        root,
        base,
        exception.historyBoundaries,
        generatedOutputRepairDagMaximumRevisions
    );
    const historyRevisions = new Set([
        ...historyGraph.keys(),
        ...exception.historyBoundaries
    ]);
    for (const revision of [
        passThroughFirstParent,
        passThroughSecondParent,
        exception.passThroughCommit,
        outerFirstParent,
        outerSecondParent,
        exception.outerMergeCommit
    ])
    {
        if (!historyRevisions.has(revision))
        {
            fail(`registered history omits required revision: ${revision}`);
        }
    }
    if (!gitBoundedFirstParentChainIncludes(root, exception.mergeCommit, passThroughSecondParent))
    {
        fail('authoritative second parent does not descend from the registered source merge on its first-parent chain');
    }
    if (!gitBoundedFirstParentChainIncludes(root, exception.passThroughCommit, outerSecondParent))
    {
        fail('pass-through commit is not on the outer pull request head first-parent chain');
    }
    if (boundedGraphIncludesAncestor(historyGraph, exception.passThroughCommit, outerFirstParent))
    {
        fail('pass-through commit is also reachable from the outer merge first parent');
    }
    if (!gitBoundedFirstParentChainIncludes(root, passThroughSecondParent, outerFirstParent))
    {
        fail('authoritative second parent is not on the outer merge first-parent lineage');
    }
    if (!gitBoundedFirstParentChainIncludes(root, exception.outerMergeCommit, base))
    {
        fail('outer merge is not on the repair base first-parent chain');
    }

    if (gitLastRevisionForPath(root, base, producer.source) !== exception.sourceCommit)
    {
        fail('registered source commit is not the exact current semantic path owner');
    }

    const stableSourceRevisions = new Set([
        exception.sourceCommit,
        head,
        ...historyRevisions
    ]);
    const sourceDivergenceRevisions = new Set(exception.sourceDivergenceRevisions);
    if (
        sourceDivergenceRevisions.size !== exception.sourceDivergenceRevisions.length
        || [...sourceDivergenceRevisions].some((revision) => !historyRevisions.has(revision))
        || !sourceDivergenceRevisions.has(passThroughFirstParent)
        || exception.sourceDivergenceIdentity === exception.sourceIdentity
    )
    {
        fail('registered source divergence set is malformed');
    }
    for (const revision of stableSourceRevisions)
    {
        const expectedIdentity = sourceDivergenceRevisions.has(revision)
            ? exception.sourceDivergenceIdentity
            : exception.sourceIdentity;
        if (revisionPathIdentity(root, revision, producer.source) !== expectedIdentity)
        {
            fail(`trusted source identity changed at ${revision}`);
        }
    }

    const protectedBindings = [
        { path: producer.generator, identity: exception.generatorIdentity },
        ...exception.outputs
    ];
    if (!sameStrings(exception.outputs.map((entry) => entry.path), producer.outputs))
    {
        fail('protected output roster does not exactly match the trusted producer');
    }
    const stableClosureRevisions = new Set([
        exception.sourceCommit,
        ...historyRevisions
    ]);
    for (const binding of protectedBindings)
    {
        if (!repositoryPathPattern.test(binding?.path ?? '') || !/^\d{6}:[0-9a-f]{40}$/u.test(binding?.identity ?? ''))
        {
            fail(`protected binding is malformed: ${binding?.path ?? 'missing'}`);
            continue;
        }
        for (const revision of stableClosureRevisions)
        {
            if (revisionPathIdentity(root, revision, binding.path) !== binding.identity)
            {
                fail(`protected path identity changed at ${revision}: ${binding.path}`);
            }
        }
    }

    const firstParentChanges = gitChangedPaths(root, passThroughFirstParent, exception.passThroughCommit);
    if (!firstParentChanges.includes(producer.source))
    {
        fail('pass-through result does not restore the trusted source from its first parent');
    }
    if (protectedBindings.some((binding) => firstParentChanges.includes(binding.path)))
    {
        fail('pass-through result changes the trusted generator or an output from its first parent');
    }
    const secondParentChanges = gitChangedPaths(root, passThroughSecondParent, exception.passThroughCommit);
    if (secondParentChanges.includes(producer.source))
    {
        fail('pass-through result changes the authoritative second-parent source');
    }
    if (protectedBindings.some((binding) => secondParentChanges.includes(binding.path)))
    {
        fail('pass-through result changes the trusted generator or an output from its second parent');
    }
    return errors;
}

export function validateGeneratedRepairPassThroughException(
    root,
    producer,
    evidence,
    base,
    head,
    exception
)
{
    try
    {
        return generatedRepairPassThroughExceptionErrors(root, producer, evidence, base, head, exception);
    }
    catch (error)
    {
        return [
            `Registered generated repair pass-through is invalid: cannot verify registered history: ${error instanceof Error ? error.message : String(error)}`
        ];
    }
}

function acceptedGeneratedRepairPassThrough(root, producer, evidence, base, head)
{
    const exception = changeContract.generatedOutputRepairPassThroughExceptions.find(
        (entry) => entry.producerId === producer.id
            && entry.repairBase === base
            && entry.repairHead === head
            && entry.sourceCommit === evidence.sourceCommit
            && entry.mergedPullRequest === evidence.mergedPullRequest
            && entry.mergeCommit === evidence.mergeCommit
    );
    if (!exception)
    {
        return false;
    }
    return validateGeneratedRepairPassThroughException(
        root,
        producer,
        evidence,
        base,
        head,
        exception
    ).length === 0;
}

function preflightDagReplayHistory(
    root,
    {
        base,
        head,
        synchronizedRevision,
        synchronizedMergeCommit,
        sourceEvents,
        graph,
        changedFiles,
        externalExceptionManifest
    },
    guard
)
{
    const graphOutputs = graph.steps.flatMap((step) => step.outputs);
    const closurePaths = [...new Set(graph.steps.flatMap((step) => step.generatorClosure))];
    const protectedPaths = new Set([
        ...graphOutputs,
        ...closurePaths,
        ...changeContract.trustedPolicyFiles
    ]);
    const candidateCodeChanges = changedFiles.filter((path) => (
        closurePaths.includes(path) || changeContract.trustedPolicyFiles.includes(path)
    ));
    if (candidateCodeChanges.length > 0)
    {
        throw new Error(`candidate changed executable or trusted policy before replay: ${candidateCodeChanges.join(', ')}`);
    }
    const permittedCandidateSuperset = new Set([
        ...graphOutputs,
        graph.manifest,
        externalExceptionManifest
    ].filter((path) => repositoryPathPattern.test(path ?? '')));
    const unexpectedCandidatePaths = changedFiles.filter((path) => !permittedCandidateSuperset.has(path));
    if (unexpectedCandidatePaths.length > 0)
    {
        throw new Error(`candidate changed unrelated paths before replay: ${unexpectedCandidatePaths.join(', ')}`);
    }
    const reviewed = reviewedDagHistoryAdmission(root, graph, synchronizedMergeCommit, synchronizedRevision, base);
    guard.reviewedHistory = reviewed;

    const revisions = new Set();
    const trackRevision = (revision) =>
    {
        if (!fullShaPattern.test(revision ?? ''))
        {
            return;
        }
        revisions.add(revision);
        admitDagRevision(guard, revision);
    };
    for (const revision of [
        synchronizedRevision,
        synchronizedMergeCommit,
        base,
        head,
        ...sourceEvents.map((event) => event?.sourceRevision).filter((revision) => fullShaPattern.test(revision ?? ''))
    ])
    {
        trackRevision(revision);
    }
    const outerRevisions = gitFirstParentRange(
        root,
        synchronizedMergeCommit,
        base,
        generatedOutputRepairDagMaximumRevisions
    );
    for (const revision of outerRevisions)
    {
        trackRevision(revision);
        const parents = gitRevisionParents(root, revision);
        for (const parent of parents)
        {
            trackRevision(parent);
        }
        if (parents.length > 0)
        {
            const protectedChanges = gitChangedPaths(root, parents[0], revision)
                .filter((path) => protectedPaths.has(path));
            if (protectedChanges.length > 0 && !reviewed?.coveredOuter.has(revision)
                && !reviewed?.admittedPolicyOuter.has(revision))
            {
                throw new Error(
                    `outer history changed outputs or policy closure before replay: ${revision}: ${protectedChanges.join(', ')}`
                );
            }
        }
        if (parents.length !== 2)
        {
            continue;
        }
        const branchBase = gitMergeBase(root, parents[0], parents[1]);
        const branchRevisions = gitPullRequestBranchFirstParentRange(
            root,
            parents[0],
            parents[1],
            generatedOutputRepairDagMaximumRevisions
        );
        for (const branchRevision of branchRevisions)
        {
            trackRevision(branchRevision);
            for (const parent of gitRevisionParents(root, branchRevision))
            {
                trackRevision(parent);
            }
        }
        for (const path of protectedPaths)
        {
            const pathHistory = gitFullHistoryRevisionsForPath(root, branchBase, parents[1], path);
            if (pathHistory.some((sourceRevision) => (
                !reviewed?.coveredOuter.has(revision)
                && !(changeContract.trustedPolicyFiles.includes(path)
                    && (reviewed?.nodes.has(sourceRevision) || reviewed?.admittedPolicyRevisions.has(sourceRevision)))
            )))
            {
                throw new Error(
                    `source branch changed outputs or policy closure before replay: ${revision}: ${path}`
                );
            }
        }
    }
    const trustedClosure = new Map(closurePaths.map((path) => [
        path,
        revisionPathIdentity(root, base, path)
    ]));
    for (const revision of revisions)
    {
        const historicalNode = reviewed?.nodes.get(revision);
        const legacyEpoch = historicalNode && reviewed.registration.legacyClosure.every((entry) => (
            JSON.stringify(historicalNode.entries.find((actual) => actual.path === entry.path)) === JSON.stringify(entry)
        ));
        for (const [path, identity] of trustedClosure)
        {
            if (revisionPathIdentity(root, revision, path) !== identity && !legacyEpoch)
            {
                throw new Error(`generator closure is not trusted before replay: ${revision}: ${path}`);
            }
        }
    }
    return outerRevisions;
}

function validatePostMergeGeneratedOutputRepairDag(
    parsedBody,
    evidence,
    { root, base, head, changedFiles },
    errors
)
{
    if (dagEvidenceExceedsBounds(evidence, errors))
    {
        return;
    }
    const topLevelFields = [
        'schema',
        'producerId',
        'synchronizedRevision',
        'synchronizedPullRequest',
        'synchronizedMergeCommit',
        'synchronizedOutputOwners',
        'baseCommit',
        'inputTree',
        'sourceProjection',
        'sourceEvents',
        'steps',
        'outputs'
    ];
    if (!sameStrings(Object.keys(evidence), topLevelFields))
    {
        errors.push('Post-merge generated repair DAG manifest contains unsupported fields');
    }
    const graph = changeContract.generatedOutputRepairDags.find((entry) => entry.id === evidence.producerId);
    if (!graph)
    {
        errors.push(`Post-merge generated repair DAG is not trusted: ${evidence.producerId ?? 'missing'}`);
        return;
    }
    if (parsedBody.generatedDigest !== graph.manifest)
    {
        errors.push('Post-merge generated repair DAG must use the trusted canonical manifest path');
    }
    const declaredExternalNamingManifest = parsedBody.classifications['External naming exception']
        ? parsedBody.externalExceptionManifest
        : null;
    if (declaredExternalNamingManifest && declaredExternalNamingManifest !== graph.externalNamingManifest)
    {
        errors.push('Post-merge generated repair DAG must use the trusted canonical external naming manifest path');
    }
    const graphOutputs = graph.steps.flatMap((step) => step.outputs);
    const generatorSources = [...new Set(graph.steps.map((step) => step.generator))];
    const closurePaths = [...new Set(graph.steps.flatMap((step) => step.generatorClosure))];
    const steps = Array.isArray(evidence.steps) ? evidence.steps : [];
    const outputs = Array.isArray(evidence.outputs) ? evidence.outputs : [];
    const sourceEvents = Array.isArray(evidence.sourceEvents) ? evidence.sourceEvents : [];
    const synchronizedOutputOwners = Array.isArray(evidence.synchronizedOutputOwners)
        ? evidence.synchronizedOutputOwners
        : [];
    if (sourceEvents.length === 0 || sourceEvents.length > 64)
    {
        errors.push('Post-merge generated repair DAG sourceEvents must contain 1 to 64 entries');
    }
    if (!sameStrings(repositoryPaths(parsedBody.generatorSource), generatorSources))
    {
        errors.push('Post-merge generated repair DAG generators must match Generator source');
    }
    const changedOutputPaths = outputs.filter((entry) => entry?.changed === true).map((entry) => entry?.path);
    if (!sameStrings(repositoryPaths(parsedBody.generatedOutputs), changedOutputPaths))
    {
        errors.push('Post-merge generated repair DAG changed outputs must match Generated outputs');
    }
    if (steps.length !== graph.steps.length)
    {
        errors.push('Post-merge generated repair DAG steps must exactly match the trusted graph');
    }
    const completedOutputs = new Map();
    for (const [index, trustedStep] of graph.steps.entries())
    {
        const step = steps[index];
        if (!step || typeof step !== 'object' || Array.isArray(step))
        {
            continue;
        }
        if (!sameStrings(Object.keys(step), [
            'id', 'command', 'executable', 'arguments', 'dependsOn', 'consumes', 'generatorClosure', 'outputs'
        ]))
        {
            errors.push(`Post-merge generated repair DAG step contains unsupported fields: ${trustedStep.id}`);
        }
        for (const [field, expected] of [
            ['arguments', trustedStep.arguments],
            ['dependsOn', trustedStep.dependsOn],
            ['consumes', trustedStep.consumes],
            ['outputs', trustedStep.outputs]
        ])
        {
            if (!Array.isArray(step[field]) || !sameStringSequence(step[field], expected))
            {
                errors.push(`Post-merge generated repair DAG step ${field} must match trusted step ${trustedStep.id}`);
            }
        }
        if (step.id !== trustedStep.id || step.command !== trustedStep.command || step.executable !== trustedStep.executable)
        {
            errors.push(`Post-merge generated repair DAG step identity must match trusted step ${trustedStep.id}`);
        }
        for (const dependency of trustedStep.dependsOn)
        {
            if (!completedOutputs.has(dependency))
            {
                errors.push(`Post-merge generated repair DAG dependency must precede consumer: ${trustedStep.id}: ${dependency}`);
            }
        }
        const consumable = trustedStep.dependsOn.flatMap((dependency) => completedOutputs.get(dependency) ?? []);
        if (!trustedStep.consumes.every((path) => consumable.includes(path)))
        {
            errors.push(`Post-merge generated repair DAG step consumes undeclared dependency output: ${trustedStep.id}`);
        }
        completedOutputs.set(trustedStep.id, trustedStep.outputs);
        const closure = Array.isArray(step.generatorClosure) ? step.generatorClosure : [];
        if (!sameStringSequence(closure.map((entry) => entry?.path), trustedStep.generatorClosure))
        {
            errors.push(`Post-merge generated repair DAG generatorClosure must match trusted step ${trustedStep.id}`);
        }
        for (const entry of closure)
        {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)
                || !sameStrings(Object.keys(entry), ['path', 'baseSha256', 'currentSha256'])
                || !repositoryPathPattern.test(entry.path ?? '')
                || !sha256Pattern.test(entry.baseSha256 ?? '')
                || !sha256Pattern.test(entry.currentSha256 ?? ''))
            {
                errors.push(`Post-merge generated repair DAG closure binding is malformed: ${trustedStep.id}`);
            }
        }
    }
    if (!sameStringSequence(outputs.map((entry) => entry?.path), graphOutputs)
        || new Set(graphOutputs).size !== graphOutputs.length)
    {
        errors.push('Post-merge generated repair DAG outputs must exactly match the trusted graph');
    }
    for (const output of outputs)
    {
        if (!output || typeof output !== 'object' || Array.isArray(output)
            || !sameStrings(Object.keys(output), [
                'path', 'repairRequired', 'changed', 'baseSha256', 'expectedSha256', 'currentSha256'
            ])
            || !repositoryPathPattern.test(output.path ?? '')
            || typeof output.repairRequired !== 'boolean'
            || typeof output.changed !== 'boolean'
            || !sha256Pattern.test(output.baseSha256 ?? '')
            || !sha256Pattern.test(output.expectedSha256 ?? '')
            || !sha256Pattern.test(output.currentSha256 ?? ''))
        {
            errors.push(`Post-merge generated repair DAG output binding is malformed: ${output?.path ?? 'missing'}`);
        }
    }
    if (!root || !fullShaPattern.test(base ?? '') || !fullShaPattern.test(head ?? ''))
    {
        errors.push('Post-merge generated repair DAG requires exact pull request base and head revisions');
        return;
    }
    if (!fullShaPattern.test(evidence.baseCommit ?? '') || evidence.baseCommit !== base)
    {
        errors.push('Post-merge generated repair DAG baseCommit must exactly match the pull request base');
    }
    if (![evidence.synchronizedRevision, evidence.synchronizedMergeCommit]
        .every((revision) => fullShaPattern.test(revision ?? ''))
        || !Number.isInteger(evidence.synchronizedPullRequest)
        || evidence.synchronizedPullRequest < 1)
    {
        errors.push('Post-merge generated repair DAG synchronized identity is malformed');
        return;
    }

    try
    {
        const synchronizedMergeParents = gitRevisionParents(root, evidence.synchronizedMergeCommit);
        if (synchronizedMergeParents.length !== 2
            || !mergeCommitNamesPullRequest(root, evidence.synchronizedMergeCommit, evidence.synchronizedPullRequest))
        {
            errors.push('Post-merge generated repair DAG synchronized outer merge identity is invalid');
            return;
        }
        const [synchronizedBase, synchronizedHead] = synchronizedMergeParents;
        if (!gitRevisionIsAncestor(root, evidence.synchronizedMergeCommit, base)
            || !gitFirstParentChainIncludes(root, evidence.synchronizedMergeCommit, base))
        {
            errors.push('Post-merge generated repair DAG synchronized merge must be on the base first-parent chain');
        }
        if (!gitRevisionIsAncestor(root, evidence.synchronizedRevision, synchronizedHead)
            || gitRevisionIsAncestor(root, evidence.synchronizedRevision, synchronizedBase)
            || !gitFirstParentChainIncludes(root, evidence.synchronizedRevision, synchronizedHead))
        {
            errors.push('Post-merge generated repair DAG synchronizedRevision must belong to the named merge head first-parent chain');
        }
        const replayGuard = createDagReplayGuard();
        const outerRevisions = preflightDagReplayHistory(root, {
            base,
            head,
            synchronizedRevision: evidence.synchronizedRevision,
            synchronizedMergeCommit: evidence.synchronizedMergeCommit,
            sourceEvents,
            graph,
            changedFiles,
            externalExceptionManifest: declaredExternalNamingManifest === graph.externalNamingManifest
                ? graph.externalNamingManifest
                : null
        }, replayGuard);
        const synchronizedReplay = verifiedDagReplay(root, evidence.synchronizedRevision, graph, replayGuard);
        const synchronizedOuterReplay = verifiedDagReplay(root, evidence.synchronizedMergeCommit, graph, replayGuard);
        if (synchronizedReplay.changedPaths.length !== 0 || synchronizedOuterReplay.changedPaths.length !== 0)
        {
            errors.push('Post-merge generated repair DAG synchronized revision must be a canonical fixed point');
        }
        if (!sameStringSequence(
            synchronizedOutputOwners.map((entry) => entry?.path),
            graphOutputs
        ))
        {
            errors.push('Post-merge generated repair DAG synchronized output owners must exactly match graph outputs');
        }
        const exactOutputOwners = [];
        for (const path of graphOutputs)
        {
            const owner = gitLastRevisionForPath(root, synchronizedHead, path);
            exactOutputOwners.push(owner);
            const declaredOwner = synchronizedOutputOwners.find((entry) => entry?.path === path);
            if (!declaredOwner || !sameStrings(Object.keys(declaredOwner), ['path', 'revision'])
                || declaredOwner.revision !== owner)
            {
                errors.push(`Post-merge generated repair DAG synchronized output owner is stale: ${path}`);
            }
            const historicalChanges = gitFullHistoryRevisionsForPath(root, evidence.synchronizedMergeCommit, base, path);
            if (gitFullHistoryRevisionsForPath(root, evidence.synchronizedRevision, synchronizedHead, path).length > 0
                || historicalChanges.some((revision) => !replayGuard.reviewedHistory?.nodes.has(revision)))
            {
                errors.push(`Post-merge generated repair DAG synchronized revision is not the last output owner: ${path}`);
            }
        }
        if (!exactOutputOwners.includes(evidence.synchronizedRevision))
        {
            errors.push('Post-merge generated repair DAG synchronized revision must own at least one graph output');
        }

        const baseReplay = verifiedDagReplay(root, base, graph, replayGuard);
        const candidateReplay = verifiedDagReplay(root, head, graph, replayGuard);
        verifyDagStepConsumption(root, base, graph, replayGuard);
        if (candidateReplay.changedPaths.length !== 0)
        {
            errors.push('Post-merge generated repair DAG candidate must be a canonical fixed point');
        }
        const excludedInputPaths = [
            ...graphOutputs,
            parsedBody.generatedDigest,
            parsedBody.classifications['External naming exception'] ? parsedBody.externalExceptionManifest : null
        ].filter((path) => repositoryPathPattern.test(path ?? ''));
        const synchronizedInputTree = trackedInputTreeDigest(root, evidence.synchronizedRevision, excludedInputPaths);
        const baseInputTree = trackedInputTreeDigest(root, base, excludedInputPaths);
        const currentInputTree = trackedInputTreeDigest(root, head, excludedInputPaths);
        if (!evidence.inputTree || !sameStrings(Object.keys(evidence.inputTree), [
            'synchronizedSha256', 'baseSha256', 'currentSha256'
        ]) || evidence.inputTree.synchronizedSha256 !== synchronizedInputTree
            || evidence.inputTree.baseSha256 !== baseInputTree
            || evidence.inputTree.currentSha256 !== currentInputTree)
        {
            errors.push('Post-merge generated repair DAG tracked input tree binding is stale');
        }
        if (baseInputTree !== currentInputTree)
        {
            errors.push('Post-merge generated repair DAG candidate changed tracked inputs or policy');
        }
        const expectedProjection = {
            projectionId: graph.semanticProjection.id,
            synchronized: synchronizedReplay.projection,
            base: baseReplay.projection,
            current: candidateReplay.projection
        };
        if (JSON.stringify(evidence.sourceProjection) !== JSON.stringify(expectedProjection))
        {
            errors.push('Post-merge generated repair DAG semantic source projection binding is stale');
        }

        for (const [index, trustedStep] of graph.steps.entries())
        {
            const step = steps[index];
            if (!step)
            {
                continue;
            }
            for (const entry of step.generatorClosure ?? [])
            {
                const synchronizedDigest = blobSha256(root, evidence.synchronizedRevision, entry.path);
                const baseDigest = blobSha256(root, base, entry.path);
                const currentDigest = blobSha256(root, head, entry.path);
                if (synchronizedDigest !== baseDigest
                    || entry.baseSha256 !== baseDigest
                    || entry.currentSha256 !== currentDigest
                    || baseDigest !== currentDigest
                    || changedFiles.includes(entry.path))
                {
                    errors.push(`Post-merge generated repair DAG generator closure changed or is stale: ${trustedStep.id}: ${entry.path}`);
                }
            }
        }

        const repairPaths = [];
        for (const output of outputs)
        {
            const baseDigest = blobSha256(root, base, output.path);
            const currentDigest = blobSha256(root, head, output.path);
            const expectedDigest = baseReplay.outputs.get(output.path);
            const repairRequired = baseDigest !== expectedDigest;
            if (repairRequired)
            {
                repairPaths.push(output.path);
            }
            if (output.baseSha256 !== baseDigest
                || output.expectedSha256 !== expectedDigest
                || output.currentSha256 !== currentDigest)
            {
                errors.push(`Post-merge generated repair DAG output digest is stale: ${output.path}`);
            }
            if (output.repairRequired !== repairRequired || output.changed !== repairRequired)
            {
                errors.push(`Post-merge generated repair DAG output repair/change flags are wrong: ${output.path}`);
            }
            if (currentDigest !== expectedDigest)
            {
                errors.push(`Post-merge generated repair DAG output is not canonical: ${output.path}`);
            }
            if (changedFiles.includes(output.path) !== repairRequired)
            {
                errors.push(`Post-merge generated repair DAG candidate changed set is wrong: ${output.path}`);
            }
        }
        if (!sameStrings(baseReplay.changedPaths, repairPaths))
        {
            errors.push('Post-merge generated repair DAG base drift must exactly equal repair-required outputs');
        }

        const permittedCandidatePaths = new Set([
            ...repairPaths,
            parsedBody.generatedDigest,
            parsedBody.classifications['External naming exception'] ? parsedBody.externalExceptionManifest : null
        ].filter((path) => repositoryPathPattern.test(path ?? '')));
        const unexpectedCandidatePaths = changedFiles.filter((path) => !permittedCandidatePaths.has(path));
        if (unexpectedCandidatePaths.length > 0)
        {
            errors.push(`Post-merge generated repair DAG candidate contains unrelated changes: ${unexpectedCandidatePaths.join(', ')}`);
        }

        const discoveredEvents = [];
        let previousOuterReplay = synchronizedOuterReplay;
        let previousOuter = evidence.synchronizedMergeCommit;
        for (const outerRevision of outerRevisions)
        {
            const outerReplay = verifiedDagReplay(root, outerRevision, graph, replayGuard);
            if (outputVectorChanged(previousOuterReplay, outerReplay))
            {
                const parents = gitRevisionParents(root, outerRevision);
                if (parents.length !== 2 || parents[0] !== previousOuter)
                {
                    throw new Error(`canonical graph transition is not one exact outer merge: ${outerRevision}`);
                }
                discoveredEvents.push({ mergeCommit: outerRevision, parents, replay: outerReplay });
            }
            previousOuter = outerRevision;
            previousOuterReplay = outerReplay;
        }
        const reviewed = replayGuard.reviewedHistory;
        const replayedEventsByOuter = new Map();
        const reviewedMergeIds = new Set(reviewed?.registration.sourceBranches.map((branch) => branch.mergeCommit) ?? []);
        if (reviewed)
        {
            const observedBranches = [];
            for (const outer of discoveredEvents.filter((event) => reviewedMergeIds.has(event.mergeCommit)))
            {
                const registeredBranch = reviewed.registration.sourceBranches.find((branch) => branch.mergeCommit === outer.mergeCommit);
                const transitions = [];
                for (const revision of gitPullRequestBranchFirstParentRange(root, ...outer.parents))
                {
                    const parents = gitRevisionParents(root, revision);
                    if (outputVectorChanged(verifiedDagReplay(root, parents[0], graph, replayGuard),
                        verifiedDagReplay(root, revision, graph, replayGuard)))
                    {
                        transitions.push(revision);
                    }
                }
                observedBranches.push({
                    mergeCommit: outer.mergeCommit,
                    mergedPullRequest: registeredBranch.mergedPullRequest,
                    transitions
                });
                replayedEventsByOuter.set(outer.mergeCommit, transitions.map((sourceRevision) => ({
                    sourceRevision,
                    mergedPullRequest: registeredBranch.mergedPullRequest,
                    mergeCommit: outer.mergeCommit
                })));
            }
            errors.push(...validateReviewedGeneratedRepairDagEvents(reviewed.registration, observedBranches,
                sourceEvents.filter((event) => reviewedMergeIds.has(event?.mergeCommit))));
        }
        const genericSourceEvents = sourceEvents.filter((event) => !reviewedMergeIds.has(event?.mergeCommit));
        const genericDiscoveredEvents = discoveredEvents.filter((event) => !reviewedMergeIds.has(event.mergeCommit));
        if (!sameStringSequence(
            genericSourceEvents.map((event) => event?.mergeCommit),
            genericDiscoveredEvents.map((event) => event.mergeCommit)
        ))
        {
            errors.push('Post-merge generated repair DAG sourceEvents omit, duplicate, or reorder canonical transitions');
        }
        for (const [index, event] of genericSourceEvents.entries())
        {
            const discovered = genericDiscoveredEvents[index];
            if (!discovered || !event || typeof event !== 'object' || Array.isArray(event)
                || !sameStrings(Object.keys(event), ['sourceRevision', 'mergedPullRequest', 'mergeCommit'])
                || !fullShaPattern.test(event.sourceRevision ?? '')
                || !Number.isInteger(event.mergedPullRequest)
                || event.mergedPullRequest < 1
                || !mergeCommitNamesPullRequest(root, event.mergeCommit, event.mergedPullRequest))
            {
                errors.push(`Post-merge generated repair DAG source event identity is invalid: ${index}`);
                continue;
            }
            const [mergeBase, mergeHead] = discovered.parents;
            if (!gitRevisionIsAncestor(root, event.sourceRevision, mergeHead)
                || gitRevisionIsAncestor(root, event.sourceRevision, mergeBase)
                || !gitFirstParentChainIncludes(root, event.sourceRevision, mergeHead))
            {
                errors.push(`Post-merge generated repair DAG source revision is outside its named merge head: ${event.sourceRevision}`);
                continue;
            }
            const branchRevisions = gitPullRequestBranchFirstParentRange(root, mergeBase, mergeHead);
            const semanticTransitions = [];
            const protectedPaths = new Set([
                ...graphOutputs,
                ...closurePaths,
                ...changeContract.trustedPolicyFiles
            ]);
            const branchBase = gitMergeBase(root, mergeBase, mergeHead);
            for (const path of protectedPaths)
            {
                if (gitFullHistoryRevisionsForPath(root, branchBase, mergeHead, path).some((revision) => (
                    !(changeContract.trustedPolicyFiles.includes(path) && reviewed?.admittedPolicyRevisions.has(revision))
                )))
                {
                    errors.push(`Post-merge generated repair DAG source event full history changed outputs or policy closure: ${path}`);
                }
            }
            for (const revision of branchRevisions)
            {
                const parents = gitRevisionParents(root, revision);
                const protectedChanges = gitChangedPaths(root, parents[0], revision)
                    .filter((path) => protectedPaths.has(path)
                        && !(changeContract.trustedPolicyFiles.includes(path) && reviewed?.admittedPolicyRevisions.has(revision)));
                if (protectedChanges.length > 0)
                {
                    errors.push(`Post-merge generated repair DAG source event history changed outputs or policy closure: ${protectedChanges.join(', ')}`);
                }
                const before = verifiedDagReplay(root, parents[0], graph, replayGuard);
                const after = verifiedDagReplay(root, revision, graph, replayGuard);
                if (outputVectorChanged(before, after))
                {
                    semanticTransitions.push({ revision, parents });
                }
            }
            if (semanticTransitions.length !== 1 || semanticTransitions[0]?.revision !== event.sourceRevision)
            {
                errors.push(`Post-merge generated repair DAG source event must contain one exact canonical transition: ${event.sourceRevision}`);
            }
            replayedEventsByOuter.set(discovered.mergeCommit, semanticTransitions.map(({ revision }) => ({
                sourceRevision: revision,
                mergedPullRequest: event.mergedPullRequest,
                mergeCommit: discovered.mergeCommit
            })));
            const sourceParents = gitRevisionParents(root, event.sourceRevision);
            if (![1, 2].includes(sourceParents.length)
                || (sourceParents.length === 2 && sourceParents[1] !== mergeBase))
            {
                errors.push(`Post-merge generated repair DAG source revision has invalid parent topology: ${event.sourceRevision}`);
            }
            const sourceChanges = gitChangedPaths(root, sourceParents[0], event.sourceRevision);
            const protectedChanges = sourceChanges.filter((path) => protectedPaths.has(path))
                .filter((path) => !(changeContract.trustedPolicyFiles.includes(path)
                    && reviewed?.admittedPolicyRevisions.has(event.sourceRevision)));
            if (protectedChanges.length > 0)
            {
                errors.push(`Post-merge generated repair DAG source event changed outputs or policy closure: ${protectedChanges.join(', ')}`);
            }
        }
        const expectedGlobalEvents = discoveredEvents.flatMap((event) => replayedEventsByOuter.get(event.mergeCommit) ?? []);
        errors.push(...validateGeneratedRepairDagEventOrder(sourceEvents, expectedGlobalEvents));
    }
    catch (error)
    {
        errors.push(`Post-merge generated repair DAG cannot verify sealed history and isolated replays: ${error instanceof Error ? error.message : String(error)}`);
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

function authorityCheckoutForGeneratedDigestRepair(root, base, authorityRoot)
{
    if (authorityRoot)
    {
        try
        {
            const revision = execFileSync(
                'git',
                ['rev-parse', '--verify', 'HEAD'],
                exactRevisionGitOptions(authorityRoot, { encoding: 'utf8' })
            ).trim();
            if (revision === base)
            {
                return { path: authorityRoot, cleanup: null };
            }
        }
        catch
        {
            // Fall through to a fresh detached checkout of the exact base.
        }
    }
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'fsusblog-generated-digest-authority-'));
    try
    {
        execFileSync(
            'git',
            ['worktree', 'add', '--detach', temporaryRoot, base],
            exactRevisionGitOptions(root, { stdio: 'ignore' })
        );
    }
    catch (error)
    {
        rmSync(temporaryRoot, { recursive: true, force: true });
        throw error;
    }
    return {
        path: temporaryRoot,
        cleanup: () =>
        {
            try
            {
                execFileSync('git', ['worktree', 'remove', '--force', temporaryRoot],
                    exactRevisionGitOptions(root, { stdio: 'ignore' }));
            }
            finally
            {
                rmSync(temporaryRoot, { recursive: true, force: true });
            }
        }
    };
}

export function validatePostMergeGeneratedOutputDigestRepair(
    parsedBody,
    evidence,
    { root, base, head, changedFiles, authorityRoot, repository = null },
    errors
)
{
    const producer = changeContract.generatedOutputDigestRepairProducers.find(
        (entry) => entry.id === evidence.producerId
    );
    if (!producer)
    {
        errors.push(`Post-merge generated digest repair producer is not trusted: ${evidence.producerId ?? 'missing'}`);
        return;
    }
    if (parsedBody.generatedDigest !== producer.manifest)
    {
        errors.push('Post-merge generated digest repair must use the trusted canonical manifest path');
    }
    if (!sameStrings(repositoryPaths(parsedBody.generatorSource), producer.closure))
    {
        errors.push('Post-merge generated digest repair Generator source must match the complete trusted closure');
    }
    if (!sameStrings(repositoryPaths(parsedBody.generatedOutputs), [producer.output]))
    {
        errors.push('Post-merge generated digest repair Generated outputs must match the trusted output');
    }
    if (!root || !fullShaPattern.test(base ?? '') || !fullShaPattern.test(head ?? ''))
    {
        return;
    }

    let authority = null;
    try
    {
        authority = repository
            ? { path: null, cleanup: null }
            : authorityCheckoutForGeneratedDigestRepair(root, base, authorityRoot);
        const trustedRepository = repository ?? createGeneratedOutputDigestRepairRepository({
            root,
            authorityRoot: authority.path,
            base,
            producer
        });
        verifyGeneratedOutputDigestRepairV2({
            evidence,
            producer,
            repository: trustedRepository,
            base,
            head,
            changedFiles
        });
    }
    catch (error)
    {
        errors.push(`Post-merge generated digest repair cannot verify canonical closure and isolated replays: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally
    {
        authority?.cleanup?.();
    }
}

export function validatePostMergeGeneratedOutputHistoryRepair(
    parsedBody,
    evidence,
    { root, base, head, changedFiles, authorityRoot, repository = null },
    errors
)
{
    const producer = changeContract.generatedOutputHistoryRepairProducers.find((entry) => entry.id === evidence.producerId);
    if (!producer)
    {
        errors.push('Post-merge generated history repair producer is not trusted');
        return;
    }
    if (parsedBody.generatedDigest !== producer.manifest
        || !sameStrings(repositoryPaths(parsedBody.generatorSource), producer.closure)
        || !sameStrings(repositoryPaths(parsedBody.generatedOutputs), [producer.output]))
    {
        errors.push('Post-merge generated history repair metadata must match the exact trusted manifest, closure and output');
        return;
    }
    if (!root || !fullShaPattern.test(base ?? '') || !fullShaPattern.test(head ?? ''))
    {
        errors.push('Post-merge generated history repair requires exact candidate and base identities');
        return;
    }
    let authority = null;
    try
    {
        authority = repository ? { path: null, cleanup: null } : authorityCheckoutForGeneratedDigestRepair(root, base, authorityRoot);
        const trustedRepository = repository ?? createGeneratedOutputDigestRepairRepository({
            root, authorityRoot: authority.path, base, producer
        });
        verifyGeneratedOutputHistoryRepairV3({ evidence, producer, repository: trustedRepository, base, head, changedFiles });
    }
    catch (error)
    {
        errors.push(`Post-merge generated history repair cannot verify sealed history and isolated replays: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally
    {
        authority?.cleanup?.();
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
        if (![1, 2].includes(sourceParents.length))
        {
            errors.push('Post-merge generated repair sourceCommit must have one parent or an exact two-parent in-PR merge');
            return;
        }
        const [sourceParent, sourceBaseParent] = sourceParents;
        const mergeParents = gitRevisionParents(root, evidence.mergeCommit);
        if (mergeParents.length !== 2)
        {
            errors.push('Post-merge generated repair mergeCommit must have exactly two parents');
            return;
        }
        const [mergeBaseParent, mergeHeadParent] = mergeParents;
        const mergedSourceRevision = sourceParents.length === 2;
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
        if (!mergeCommitNamesPullRequest(root, evidence.mergeCommit, evidence.mergedPullRequest))
        {
            errors.push('Post-merge generated repair mergedPullRequest must match the exact merge commit message');
        }

        if (mergedSourceRevision && sourceBaseParent !== mergeBaseParent)
        {
            errors.push('Post-merge generated repair two-parent sourceCommit second parent must exactly match the merged pull request base');
        }
        if (
            mergedSourceRevision
            && !gitFirstParentChainIncludes(root, evidence.sourceCommit, mergeHeadParent)
        )
        {
            errors.push('Post-merge generated repair two-parent sourceCommit must be on the exact first-parent chain of the merged pull request head');
        }
        if (
            mergedSourceRevision
            && (!gitRevisionIsAncestor(root, sourceParent, mergeHeadParent)
                || gitRevisionIsAncestor(root, sourceParent, mergeBaseParent))
        )
        {
            errors.push('Post-merge generated repair two-parent sourceCommit first parent must be the pull request replay parent');
        }

        const sourceChanges = gitChangedPaths(root, sourceParent, evidence.sourceCommit);
        if (!mergedSourceRevision && !sameStrings(sourceChanges, [producer.source]))
        {
            errors.push('Post-merge generated repair sourceCommit must change only the trusted producer source');
        }
        if (mergedSourceRevision && !sourceChanges.includes(producer.source))
        {
            errors.push('Post-merge generated repair two-parent sourceCommit must change the trusted producer source from its replay parent');
        }
        if (
            mergedSourceRevision
            && [producer.generator, ...producer.outputs].some((path) => sourceChanges.includes(path))
        )
        {
            errors.push('Post-merge generated repair two-parent sourceCommit must not change the trusted generator or outputs');
        }
        if (
            mergedSourceRevision
            && [producer.generator, ...producer.outputs].some(
                (path) => gitFirstParentRevisionsForPath(root, evidence.sourceCommit, mergeHeadParent, path).length > 0
            )
        )
        {
            errors.push('Post-merge generated repair outer pull request must not change the trusted generator or outputs after sourceCommit');
        }
        const acceptedPassThrough = acceptedGeneratedRepairPassThrough(
            root,
            producer,
            evidence,
            base,
            head
        );
        const sourceHeadRevisions = mergedSourceRevision
            ? gitFullHistoryRevisionsForPath(
                root,
                evidence.sourceCommit,
                mergeHeadParent,
                producer.source
            )
            : [];
        const postMergeSourceRevisions = mergedSourceRevision
            ? gitFullHistoryRevisionsForPath(
                root,
                evidence.mergeCommit,
                base,
                producer.source
            )
            : [];
        if (
            mergedSourceRevision
            && (
                sourceHeadRevisions.length > 0
                || (postMergeSourceRevisions.length > 0 && !acceptedPassThrough)
            )
        )
        {
            errors.push('Post-merge generated repair sourceCommit must be the unique current last trusted source revision');
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
            if (
                mergedSourceRevision
                && blobSha256(root, sourceBaseParent, output.path) !== blobSha256(root, evidence.sourceCommit, output.path)
            )
            {
                errors.push(`Post-merge generated repair two-parent sourceCommit changed an output from the pull request base: ${output.path}`);
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
        const sourceParentGenerator = blobSha256(root, sourceParent, producer.generator);
        const sourceRevisionGenerator = blobSha256(root, evidence.sourceCommit, producer.generator);
        const mergeBaseGenerator = blobSha256(root, mergeBaseParent, producer.generator);
        if (
            evidence.generator.sha256 !== currentGeneratorAtBase
            || evidence.generator.sha256 !== currentGeneratorAtHead
            || sourceParentGenerator !== sourceRevisionGenerator
            || (mergedSourceRevision && mergeBaseGenerator !== sourceRevisionGenerator)
            || changedFiles.includes(producer.generator)
        )
        {
            errors.push('Post-merge generated repair generator changed or its current digest is stale');
        }

        const sourceParentReplay = replayGeneratedOutput(root, sourceParent, producer);
        const sourceRevisionReplay = replayGeneratedOutput(root, evidence.sourceCommit, producer);
        const candidateReplay = replayGeneratedOutput(root, head, producer);
        if (!mergedSourceRevision && sourceParentReplay.changedPaths.length !== 0)
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

function validateGeneratedEvidence(parsedBody, { root, base, head, changedFiles, authorityRoot, repository }, errors)
{
    const declaredSources = repositoryPaths(parsedBody.generatorSource);
    const declaredOutputs = repositoryPaths(parsedBody.generatedOutputs);
    const evidenceSchema = generatedEvidenceSchema(root, head, parsedBody.generatedDigest);
    const repairSchemas = new Set([
        changeContract.evidenceSchemas.postMergeGeneratedOutputRepair,
        changeContract.evidenceSchemas.postMergeGeneratedOutputRepairDag,
        changeContract.evidenceSchemas.postMergeGeneratedOutputDigestRepair,
        changeContract.evidenceSchemas.postMergeGeneratedOutputHistoryRepair
    ]);
    const expectedSchema = repairSchemas.has(evidenceSchema)
        ? evidenceSchema
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
    if (evidence.schema === changeContract.evidenceSchemas.postMergeGeneratedOutputRepairDag)
    {
        validatePostMergeGeneratedOutputRepairDag(
            parsedBody,
            evidence,
            { root, base, head, changedFiles },
            errors
        );
        return;
    }
    if (evidence.schema === changeContract.evidenceSchemas.postMergeGeneratedOutputDigestRepair)
    {
        validatePostMergeGeneratedOutputDigestRepair(
            parsedBody,
            evidence,
            { root, base, head, changedFiles, authorityRoot, repository },
            errors
        );
        return;
    }
    if (evidence.schema === changeContract.evidenceSchemas.postMergeGeneratedOutputHistoryRepair)
    {
        validatePostMergeGeneratedOutputHistoryRepair(
            parsedBody,
            evidence,
            { root, base, head, changedFiles, authorityRoot, repository },
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
            exactRevisionGitOptions(root, { encoding: 'utf8' })
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
        const evidenceSchema = generatedEvidenceSchema(
            context.root,
            context.head,
            parsedBody.generatedDigest
        );
        const repair = [
            changeContract.evidenceSchemas.postMergeGeneratedOutputRepair,
            changeContract.evidenceSchemas.postMergeGeneratedOutputRepairDag,
            changeContract.evidenceSchemas.postMergeGeneratedOutputDigestRepair,
            changeContract.evidenceSchemas.postMergeGeneratedOutputHistoryRepair
        ].includes(evidenceSchema);
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
    const policyChanges = [...changeContract.trustedPolicyFiles, ...changeContract.generatedOutputHistoryRepairPolicyFiles,
        ...changeContract.csharpFormatPolicyFiles]
        .filter((path) => changedFiles.includes(path));
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
    const linkedIssueLines = (parsedBody.sections.get('Linked Issue') ?? '')
        .split('\n')
        .filter((line) => /^(?:Closes|Refs)\b/iu.test(line.replace(/^[ \t>*+-]+/u, '')));
    if (
        linkedIssueLines.length !== 1
        || !/^(?:Closes|Refs)[ \t]+#[1-9][0-9]*[ \t]*$/u.test(linkedIssueLines[0])
    )
    {
        errors.push('PR body Linked Issue requires exactly one Closes #1234 or Refs #1234 line');
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
    return execFileSync(
        'git',
        ['merge-base', base, head],
        exactRevisionGitOptions(root, { encoding: 'utf8' })
    ).trim();
}

export function changedFilesBetween(root, base, head)
{
    const diffBase = mergeBaseBetween(root, base, head);
    const fields = execFileSync(
        'git',
        ['diff', '--name-status', '-z', '--diff-filter=ACDMRT', diffBase, head],
        exactRevisionGitOptions(root)
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
            const before = readFileAtRevision(root, base, path);
            const after = readFileAtRevision(root, head, path);
            if (before.includes(0) || after.includes(0)
                || (/\.cs$/u.test(path) && (!isUtf8(before) || !isUtf8(after))))
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
    if (/\.cs$/u.test(path))
    {
        return csharpFormatFingerprint(source);
    }
    if (/\.(?:mjs|cjs|js)$/u.test(path))
    {
        return javascriptFormatFingerprint(source, path);
    }
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
        ...changeContract.generatedOutputHistoryRepairPolicyFiles,
        '.git-blame-ignore-revs',
        'config/development/authoritative-development-docs.json',
        'config/schemas/external-naming-exceptions.schema.json',
        'config/schemas/post-merge-external-naming-evidence-repair.schema.json',
        'config/schemas/post-merge-generated-output-digest-repair.schema.json',
        'config/schemas/post-merge-generated-output-repair-dag.schema.json',
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
        ...changeContract.generatedOutputHistoryRepairPolicyFiles,
        ...Object.values(changeContract.evidenceSchemas),
        ...changeContract.generatedOutputRepairProducers.flatMap((entry) => [
            entry.id,
            entry.source,
            entry.generator,
            entry.command,
            ...entry.outputs
        ]),
        ...changeContract.generatedOutputRepairDags.flatMap((graph) => [
            graph.id,
            graph.manifest,
            graph.externalNamingManifest,
            graph.semanticProjection.id,
            graph.semanticProjection.output,
            ...graph.steps.flatMap((step) => [
                step.id,
                step.generator,
                step.command,
                step.executable,
                ...step.arguments,
                ...step.dependsOn,
                ...step.consumes,
                ...step.generatorClosure,
                ...step.outputs
            ])
        ]),
        ...changeContract.generatedOutputDigestRepairProducers.flatMap((producer) => [
            producer.id,
            producer.repairClass,
            producer.manifest,
            producer.command.executable,
            ...producer.command.arguments,
            ...producer.closure,
            ...producer.digestInputs,
            producer.output,
            producer.outputSchema,
            ...producer.protectedPolicyPaths,
            ...Object.values(producer.qualification).filter((value) => typeof value === 'string')
        ]),
        ...changeContract.generatedOutputHistoryRepairProducers.flatMap((producer) => [
            producer.id,
            producer.repairClass,
            producer.manifest,
            producer.command.executable,
            ...producer.command.arguments,
            ...producer.closure,
            producer.output,
            producer.outputSchema,
            ...producer.historicalPolicyPaths,
            ...producer.protectedPolicyPaths,
            ...Object.values(producer.qualification).flatMap((value) => Array.isArray(value) ? value : [value])
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
