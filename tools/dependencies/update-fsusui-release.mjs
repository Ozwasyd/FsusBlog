#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
    RELEASE_TITLE_PREFIX,
    RELEASE_TRAIN_BRANCH,
    applyVerifiedReleaseTrain,
    compareStableVersions,
    currentPackageVersion,
    formatReleaseTrainBody,
    readFrontendFiles
} from './fsusui-release-package.mjs';
import {
    requireVerifiedFsusuiEvent,
    reverifyFsusuiEventReceipt
} from './verify-fsusui-release-event.mjs';

export {
    RELEASE_TRAIN_BRANCH,
    assertPublicNpmTarballUrl,
    parseStableVersion
} from './fsusui-release-package.mjs';

const defaultRoot = path.resolve(import.meta.dirname, '../..');

function releaseError(detail)
{
    return new Error(`FsusUI release train: ${detail}`);
}

function requireCondition(condition, detail)
{
    if (!condition)
    {
        throw releaseError(detail);
    }
}

function git(repository, args, { allowFailure = false } = {})
{
    try
    {
        return execFileSync('git', args, {
            cwd: repository,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 4 * 1024 * 1024
        }).trim();
    }
    catch
    {
        if (allowFailure)
        {
            return '';
        }
        throw releaseError(`git command failed: git ${args.join(' ')}`);
    }
}

function assertCleanWorktree(repository)
{
    requireCondition(git(repository, ['status', '--porcelain']) === '', 'worktree must be clean before release-train branch preparation');
}

export function prepareReleaseTrainBranch(repository, baseBranch = 'master')
{
    requireCondition(baseBranch !== RELEASE_TRAIN_BRANCH, 'release-train branch must not be the default branch');
    assertCleanWorktree(repository);
    git(repository, ['fetch', 'origin', baseBranch]);
    const remoteRef = `refs/heads/${RELEASE_TRAIN_BRANCH}`;
    const remoteBranch = git(repository, ['ls-remote', '--exit-code', 'origin', remoteRef], { allowFailure: true });
    const exists = remoteBranch.length > 0;
    if (exists)
    {
        git(repository, ['fetch', 'origin', `${remoteRef}:refs/remotes/origin/${RELEASE_TRAIN_BRANCH}`]);
        git(repository, ['checkout', '--force', '-B', RELEASE_TRAIN_BRANCH, `origin/${RELEASE_TRAIN_BRANCH}`]);
        git(repository, ['merge', '--no-edit', `origin/${baseBranch}`]);
    }
    else
    {
        git(repository, ['checkout', '-B', RELEASE_TRAIN_BRANCH, `origin/${baseBranch}`]);
    }
    return { branch: RELEASE_TRAIN_BRANCH, baseBranch, existed: exists };
}

function repositoryParts(repository)
{
    const match = /^(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+)$/u.exec(repository ?? '');
    requireCondition(match, 'GITHUB_REPOSITORY must be owner/name');
    return match.groups;
}

export function createGithubApi({ token, repository, fetchImpl = fetch })
{
    requireCondition(typeof token === 'string' && token.length > 0, 'GitHub write token is required');
    repositoryParts(repository);
    const apiRoot = `https://api.github.com/repos/${repository}`;
    const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28'
    };
    async function request(url, options = {})
    {
        let response;
        try
        {
            response = await fetchImpl(url, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
        }
        catch
        {
            throw releaseError('GitHub API network request failed');
        }
        let body;
        try
        {
            body = await response.json();
        }
        catch
        {
            body = null;
        }
        if (!response.ok)
        {
            throw releaseError(`GitHub API request failed (${response.status})`);
        }
        return body;
    }
    return {
        async getRepository()
        {
            return request(apiRoot);
        },
        async listOpenPullRequests(baseBranch)
        {
            const url = new URL(`${apiRoot}/pulls`);
            url.searchParams.set('state', 'open');
            url.searchParams.set('base', baseBranch);
            url.searchParams.set('per_page', '100');
            return request(url.href);
        },
        async createPullRequest(payload)
        {
            return request(`${apiRoot}/pulls`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        async updatePullRequest(number, payload)
        {
            return request(`${apiRoot}/pulls/${number}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        async enableAutoMerge(nodeId)
        {
            const body = await request('https://api.github.com/graphql', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: 'mutation($pullRequestId: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) { pullRequest { number } } }',
                    variables: { pullRequestId: nodeId }
                })
            });
            if (body?.errors?.length)
            {
                throw releaseError('GitHub platform auto-merge could not be enabled');
            }
            return body?.data?.enablePullRequestAutoMerge?.pullRequest;
        }
    };
}

export function selectReleaseTrainPullRequest(pullRequests, baseBranch)
{
    const relevant = (pullRequests ?? []).filter((pullRequest) =>
    {
        const sameBranch = pullRequest.head?.ref === RELEASE_TRAIN_BRANCH;
        const samePackage = typeof pullRequest.title === 'string' && pullRequest.title.startsWith(RELEASE_TITLE_PREFIX);
        return pullRequest.base?.ref === baseBranch && (sameBranch || samePackage);
    });
    requireCondition(relevant.length <= 1, 'multiple open FsusUI release-train PRs exist');
    const selected = relevant[0];
    if (selected && selected.head?.ref !== RELEASE_TRAIN_BRANCH)
    {
        throw releaseError('another open PR owns the FsusUI release-train package');
    }
    return selected ?? null;
}

export async function ensureSingleReleaseTrainPullRequest({ api, payload, receipt, baseBranch, firstPublicNpmMigration = false })
{
    const verifiedPayload = requireVerifiedFsusuiEvent(receipt);
    requireCondition(payload === undefined || payload === verifiedPayload, 'PR payload must be the sealed verified event payload');
    const eventPayload = verifiedPayload;
    const desired = {
        title: `${RELEASE_TITLE_PREFIX}${eventPayload.version}`,
        head: RELEASE_TRAIN_BRANCH,
        base: baseBranch,
        body: formatReleaseTrainBody(eventPayload, receipt, { firstPublicNpmMigration }),
        draft: false
    };
    const existing = selectReleaseTrainPullRequest(await api.listOpenPullRequests(baseBranch), baseBranch);
    const pullRequest = existing
        ? await api.updatePullRequest(existing.number, { title: desired.title, body: desired.body, draft: false })
        : await api.createPullRequest(desired);
    requireCondition(pullRequest?.draft !== true, 'release-train PR must not be draft');
    requireCondition(pullRequest?.title === desired.title, 'release-train PR title is not exact');
    requireCondition(pullRequest?.head?.ref === undefined || pullRequest.head.ref === RELEASE_TRAIN_BRANCH, 'release-train PR head is not fixed');
    requireCondition(pullRequest?.base?.ref === undefined || pullRequest.base.ref === baseBranch, 'release-train PR base is not the default branch');
    requireCondition(typeof pullRequest?.node_id === 'string', 'release-train PR node identity is missing');
    await api.enableAutoMerge(pullRequest.node_id);
    return pullRequest;
}

function equalPathLists(left, right)
{
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function stageAndCommit(repository, plan)
{
    const files = [...new Set(plan.changedFiles ?? [])].sort();
    requireCondition(files.length > 0, 'release-train plan has no files to commit');
    git(repository, ['add', '--', ...files]);
    const staged = git(repository, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    requireCondition(equalPathLists(staged, files), 'release-train commit scope is not exact');
    git(repository, ['commit', '-m', plan.title]);
}

function parseArguments(args)
{
    const options = { repository: defaultRoot, receipt: null, apply: false };
    for (let index = 0; index < args.length; index += 1)
    {
        const argument = args[index];
        if (argument === '--receipt')
        {
            options.receipt = path.resolve(args[++index] ?? '');
        }
        else if (argument === '--root')
        {
            options.repository = path.resolve(args[++index] ?? '');
        }
        else if (argument === '--apply')
        {
            options.apply = true;
        }
        else
        {
            throw releaseError('usage: --receipt FILE [--root DIR] [--apply]');
        }
    }
    requireCondition(options.receipt, 'usage: --receipt FILE [--root DIR] [--apply]');
    return options;
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const rawReceipt = fs.readFileSync(options.receipt, 'utf8');
    const receipt = await reverifyFsusuiEventReceipt(rawReceipt);
    const payload = requireVerifiedFsusuiEvent(receipt);
    if (!options.apply)
    {
        const files = readFrontendFiles(options.repository);
        const currentVersion = currentPackageVersion(files.manifest, files.lockfile);
        const ordering = compareStableVersions(payload.version, currentVersion);
        if (ordering < 0)
        {
            throw releaseError(`verified version ${payload.version} is older than current ${currentVersion}`);
        }
        process.stdout.write(`${JSON.stringify({ action: ordering === 0 ? 'idempotent' : 'upgrade', currentVersion, targetVersion: payload.version })}\n`);
        return;
    }

    const repositoryName = process.env.GITHUB_REPOSITORY;
    const api = createGithubApi({
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
        repository: repositoryName
    });
    const repositoryInfo = await api.getRepository();
    const baseBranch = repositoryInfo?.default_branch;
    requireCondition(typeof baseBranch === 'string' && baseBranch.length > 0, 'GitHub default branch is missing');
    selectReleaseTrainPullRequest(await api.listOpenPullRequests(baseBranch), baseBranch);
    prepareReleaseTrainBranch(options.repository, baseBranch);

    const release = await applyVerifiedReleaseTrain({ repository: options.repository, receipt });
    const { plan, firstPublicNpmMigration } = release;

    if (plan.action === 'idempotent' || plan.action === 'not-required')
    {
        process.stdout.write(`${JSON.stringify({ action: plan.action, version: plan.version })}\n`);
        return;
    }
    stageAndCommit(options.repository, plan);
    git(options.repository, ['push', 'origin', `HEAD:refs/heads/${RELEASE_TRAIN_BRANCH}`]);
    const pullRequest = await ensureSingleReleaseTrainPullRequest({
        api,
        payload,
        receipt,
        baseBranch,
        firstPublicNpmMigration
    });
    process.stdout.write(`${JSON.stringify({ action: plan.action, version: plan.version, branch: RELEASE_TRAIN_BRANCH, pullRequest: pullRequest.html_url ?? pullRequest.number })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
{
    try
    {
        await main();
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
