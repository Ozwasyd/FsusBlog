#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    changeContract,
    changedFilesBetween,
    parsePrBody,
    pullRequestActor,
    validateCommitRange,
    validateCommitMessage,
    validateFormatOnlyPullRequest,
    validatePerformancePullRequest,
    validatePrContract,
    validateRepositoryBlameIgnore,
    validateRepositorySources
} from './change-contract.mjs';

const policyRoot = resolve(import.meta.dirname, '../..');

function option(name)
{
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

const root = resolve(option('--root') ?? policyRoot);

function fail(errors)
{
    for (const error of [...new Set(errors)])
    {
        console.error(`[change-contract] ${error}`);
    }
    process.exitCode = 1;
}

function success(label)
{
    console.log(`[change-contract] ok ${label}`);
}

function validateEvent(eventPath)
{
    const event = JSON.parse(readFileSync(resolve(eventPath), 'utf8'));
    if (event.pull_request)
    {
        const base = event.pull_request.base.sha;
        const head = event.pull_request.head.sha;
        const changedFiles = changedFilesBetween(root, base, head);
        const labels = (event.pull_request.labels ?? []).map((entry) => entry.name);
        const actor = pullRequestActor(event);
        const errors = validatePrContract({
            title: event.pull_request.title,
            body: event.pull_request.body ?? '',
            labels,
            actor,
            changedFiles,
            root,
            base,
            head,
            authorityRoot: policyRoot
        });
        const parsedBody = parsePrBody(event.pull_request.body ?? '');
        if (parsedBody.classifications['Format-only'])
        {
            errors.push(...validateFormatOnlyPullRequest(
                root,
                base,
                head,
                parsedBody.blameIgnoreRevision,
                parsedBody.formatterIdempotence
            ));
        }
        else
        {
            errors.push(...validateRepositoryBlameIgnore(root));
        }
        if (event.pull_request.title.startsWith('perf('))
        {
            errors.push(...validatePerformancePullRequest(
                root,
                base,
                head,
                parsedBody.performanceEvidence
            ));
        }
        errors.push(...validateRepositorySources(root));
        if (errors.length > 0)
        {
            fail(errors);
        }
        else
        {
            success(`pull-request files=${changedFiles.length}`);
        }
        return;
    }

    if (event.before && event.after)
    {
        const range = `${event.before}..${event.after}`;
        const errors = [...validateCommitRange(root, range), ...validateRepositorySources(root)];
        if (errors.length > 0)
        {
            fail(errors);
        }
        else
        {
            success(`push range=${range}`);
        }
        return;
    }

    fail(['unsupported GitHub event payload']);
}

const messageFile = option('--message-file');
const title = option('--title');
const eventPath = option('--github-event');
const range = option('--range');
const printRegistry = process.argv.includes('--print-registry');
const repository = process.argv.includes('--repository');

if (printRegistry)
{
    console.log(JSON.stringify(changeContract, null, 4));
}
else if (messageFile)
{
    const errors = validateCommitMessage(readFileSync(resolve(messageFile), 'utf8'));
    if (errors.length > 0)
    {
        fail(errors);
    }
    else
    {
        success('commit-message');
    }
}
else if (title)
{
    const errors = validateCommitMessage(title, { titleOnly: true });
    if (errors.length > 0)
    {
        fail(errors);
    }
    else
    {
        success('title');
    }
}
else if (eventPath)
{
    await validateEvent(eventPath);
}
else if (range)
{
    const errors = validateCommitRange(root, range);
    if (errors.length > 0)
    {
        fail(errors);
    }
    else
    {
        success(`commit-range=${range}`);
    }
}
else if (repository)
{
    const errors = [...validateRepositorySources(root), ...validateRepositoryBlameIgnore(root)];
    if (errors.length > 0)
    {
        fail(errors);
    }
    else
    {
        success(`repository types=${changeContract.commitTypes.length} scopes=${changeContract.commitScopes.length}`);
    }
}
else
{
    fail(['usage: [--root <repository>] --message-file <path> | --title <title> | --range <base..head> | --github-event <path> | --repository | --print-registry']);
}
