#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(moduleDirectory, '../..');
const defaultIndex = 'docs/planning/dead-code-audit-index.json';
const expectedIssues = Array.from({ length: 17 }, (_, index) => 998 + index);
const validVerificationStatuses = new Set(['not-run', 'passed', 'failed']);

function text(value)
{
    return typeof value === 'string' ? value.trim() : '';
}

function isObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushRequiredString(errors, value, label)
{
    if (!text(value))
    {
        errors.push(`${label} must be a non-empty string`);
    }
}

function issueLabel(issue)
{
    return `child #${String(issue?.issue ?? 'missing')}`;
}

function expectedClassification(issueNumber)
{
    if (issueNumber >= 998 && issueNumber <= 1005)
    {
        return { sprint: 'sprint0', classification: 'immediate-delete' };
    }
    if (issueNumber >= 1006 && issueNumber <= 1012)
    {
        return { sprint: 'sprint1', classification: 'detour-convergence' };
    }
    return { sprint: 'sprint2Plus', classification: 'milestone-gated-delete' };
}

function resolveInsideRoot(root, relativePath, errors, label)
{
    const value = text(relativePath);
    if (!value)
    {
        errors.push(`${label} must be a non-empty repository-relative path`);
        return null;
    }
    if (path.isAbsolute(value))
    {
        errors.push(`${label} must be repository-relative`);
        return null;
    }
    const absolute = path.resolve(root, value);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
    {
        errors.push(`${label} escapes the repository root`);
        return null;
    }
    return absolute;
}

async function exists(file)
{
    try
    {
        await access(file);
        return true;
    }
    catch
    {
        return false;
    }
}

async function checkExistingPath(root, relativePath, errors, label)
{
    const absolute = resolveInsideRoot(root, relativePath, errors, label);
    if (absolute && !(await exists(absolute)))
    {
        errors.push(`${label} does not exist: ${relativePath}`);
    }
}

async function validateSourceReport(index, root, errors, notices, requireComplete)
{
    const report = index?.auditClaims?.sourceReport;
    if (!isObject(report))
    {
        errors.push('auditClaims.sourceReport must be an object');
        return false;
    }
    if (report.path !== 'artifacts/dead-code-audit-report.md')
    {
        errors.push('auditClaims.sourceReport.path must remain artifacts/dead-code-audit-report.md');
    }
    const absolute = resolveInsideRoot(root, report.path, errors, 'auditClaims.sourceReport.path');
    const reportExists = absolute ? await exists(absolute) : false;

    if (report.availability === 'missing-ignored')
    {
        if (reportExists)
        {
            errors.push('source report is marked missing-ignored but currently exists');
        }
        if (report.contentSha256 !== null)
        {
            errors.push('missing source report must not claim a contentSha256');
        }
        if (report.ignoredBy !== '.gitignore')
        {
            errors.push('missing source report must identify .gitignore as ignoredBy');
        }
        else
        {
            const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
            if (!gitignore.split(/\r?\n/u).some((line) => line.trim() === report.path))
            {
                errors.push('.gitignore no longer contains the declared source report path');
            }
        }
        if (report.githubCodeSearchCountObserved !== 0)
        {
            errors.push('missing source report snapshot must retain the observed GitHub code search count of zero');
        }
        pushRequiredString(errors, report.claimBoundary, 'auditClaims.sourceReport.claimBoundary');
        notices.push('The 85-row source report is unavailable and ignored; finding counts are issue-body claims only.');
        if (requireComplete)
        {
            errors.push('completion requires a checked-in complete source report with a verified sha256');
        }
        return false;
    }

    if (report.availability !== 'checked-in-complete')
    {
        errors.push(`unsupported source report availability: ${String(report.availability)}`);
        return false;
    }
    if (!reportExists || !absolute)
    {
        errors.push('checked-in-complete source report is missing');
        return false;
    }
    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
    if (gitignore.split(/\r?\n/u).some((line) => line.trim() === report.path))
    {
        errors.push('checked-in-complete source report must not remain ignored by .gitignore');
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(text(report.contentSha256)))
    {
        errors.push('checked-in-complete source report requires sha256:<64 lowercase hex>');
        return false;
    }
    const digest = createHash('sha256').update(await readFile(absolute)).digest('hex');
    if (report.contentSha256 !== `sha256:${digest}`)
    {
        errors.push('checked-in source report sha256 does not match its content');
        return false;
    }
    return true;
}

function validateFindingCounts(index, errors)
{
    const counts = index?.auditClaims?.findingCounts;
    if (!isObject(counts))
    {
        errors.push('auditClaims.findingCounts must be an object');
        return;
    }
    if (counts.total !== 85 || counts.confirmed !== 44 || counts.plausible !== 41)
    {
        errors.push('finding counts must preserve the issue-body claim 85 total / 44 confirmed / 41 plausible');
    }
    if (Number(counts.confirmed) + Number(counts.plausible) !== Number(counts.total))
    {
        errors.push('confirmed + plausible must equal total findings');
    }
    if (counts.provenance !== 'github-issue-1015-body')
    {
        errors.push('finding count provenance must be github-issue-1015-body');
    }
    if (counts.currentRecountStatus !== 'not-run')
    {
        errors.push('finding count currentRecountStatus must remain not-run until the missing source report is reconstructed and reviewed');
    }
}

function validateIssueSplit(index, children, errors, notices)
{
    const split = index?.auditClaims?.issueSplit;
    if (!isObject(split))
    {
        errors.push('auditClaims.issueSplit must be an object');
        return;
    }
    const actual = {
        sprint0: children.filter((entry) => entry?.sprint === 'sprint0').length,
        sprint1: children.filter((entry) => entry?.sprint === 'sprint1').length,
        sprint2Plus: children.filter((entry) => entry?.sprint === 'sprint2Plus').length,
        total: children.length
    };
    for (const [key, expected] of Object.entries({ sprint0: 8, sprint1: 7, sprint2Plus: 2, total: 17 }))
    {
        if (actual[key] !== expected || split?.actualIndexedCounts?.[key] !== expected)
        {
            errors.push(`actual issue split ${key} must be ${expected}`);
        }
    }
    if (split?.declaredHeadingCounts?.sprint0 !== 9
    || split?.declaredHeadingCounts?.sprint1 !== 5
    || split?.declaredHeadingCounts?.sprint2Plus !== 2)
    {
        errors.push('declared heading counts must preserve the live #1015 body values 9/5/2');
    }
    pushRequiredString(errors, split.discrepancy, 'auditClaims.issueSplit.discrepancy');
    notices.push('Issue #1015 heading counts (9/5/2) differ from its actual table counts (8/7/2).');
}

function validateCurrentValidation(index, errors, notices, requireComplete)
{
    const validation = index?.currentWorktreeValidation;
    if (!isObject(validation))
    {
        errors.push('currentWorktreeValidation must be an object');
        return false;
    }
    if (!validVerificationStatuses.has(validation.status))
    {
        errors.push('currentWorktreeValidation.status must be not-run, passed, or failed');
    }
    if (!Array.isArray(validation.executedCommands))
    {
        errors.push('currentWorktreeValidation.executedCommands must be an array');
    }
    if (validation.status === 'passed')
    {
        if (!Array.isArray(validation.executedCommands) || validation.executedCommands.length === 0)
        {
            errors.push('passed current worktree validation requires at least one executed command');
        }
        if (!text(validation.validatedAtUtc))
        {
            errors.push('passed current worktree validation requires validatedAtUtc');
        }
    }
    else
    {
        if (validation.validatedAtUtc !== null)
        {
            errors.push('non-passed current worktree validation must not claim validatedAtUtc');
        }
        if (validation.status === 'not-run')
        {
            notices.push('Current worktree validation is explicitly not-run; historical issue comments are not current proof.');
        }
    }
    if (requireComplete && validation.status !== 'passed')
    {
        errors.push('completion requires currentWorktreeValidation.status=passed with executed command evidence');
    }
    return validation.status === 'passed';
}

async function validateChild(child, index, root, errors, notices)
{
    const label = issueLabel(child);
    const issueNumber = child?.issue;
    if (!Number.isInteger(issueNumber))
    {
        errors.push(`${label} issue must be an integer`);
    }
    pushRequiredString(errors, child?.title, `${label}.title`);
    pushRequiredString(errors, child?.scope, `${label}.scope`);
    if (!Array.isArray(child?.auditSections) || child.auditSections.length === 0
    || child.auditSections.some((section) => !text(section)))
    {
        errors.push(`${label}.auditSections must contain non-empty section ids`);
    }
    const expected = expectedClassification(issueNumber);
    if (child?.sprint !== expected.sprint)
    {
        errors.push(`${label}.sprint must be ${expected.sprint}`);
    }
    if (child?.classification !== expected.classification)
    {
        errors.push(`${label}.classification must be ${expected.classification}`);
    }

    const github = child?.githubHistoricalEvidence;
    if (!isObject(github))
    {
        errors.push(`${label}.githubHistoricalEvidence must be an object`);
    }
    else
    {
        if (github.commentsRead !== true)
        {
            errors.push(`${label} must record commentsRead=true`);
        }
        if (!text(github.observedAtUtc))
        {
            errors.push(`${label} must record GitHub observedAtUtc`);
        }
        if (!Array.isArray(github.reportedCommits))
        {
            errors.push(`${label}.reportedCommits must be an array`);
        }
        const stageIssue = issueNumber === 1013 || issueNumber === 1014;
        if (stageIssue)
        {
            if (github.stateObserved === 'open')
            {
                if (github.completionCommentUrl !== null)
                {
                    errors.push(`${label} open staged issue must not claim a completion comment`);
                }
                if ((github.reportedCommits ?? []).length !== 0)
                {
                    errors.push(`${label} open staged issue must not claim completion commits`);
                }
                if (github.evidenceKind !== 'live-state-snapshot-not-completion-evidence')
                {
                    errors.push(`${label} open staged issue evidence kind must remain non-completion evidence`);
                }
            }
            else if (github.stateObserved === 'closed')
            {
                if (github.evidenceKind !== 'historical-author-comment-not-current-validation')
                {
                    errors.push(`${label} closed staged issue must distinguish historical comments from current validation`);
                }
                if (!new RegExp(`^https://github\\.com/Ozwasyd/FsusBlog/issues/${issueNumber}#issuecomment-[0-9]+$`, 'u')
                    .test(text(github.completionCommentUrl)))
                {
                    errors.push(`${label} closed staged issue must record its completion comment URL`);
                }
                if (!Array.isArray(github.reportedCommits) || github.reportedCommits.length === 0
          || github.reportedCommits.some((commit) => !/^[0-9a-f]{8,40}$/u.test(text(commit))))
                {
                    errors.push(`${label} closed staged issue must list reported completion commits`);
                }
            }
            else
            {
                errors.push(`${label} staged issue stateObserved must be open or closed`);
            }
        }
        else
        {
            if (github.stateObserved !== 'closed')
            {
                errors.push(`${label} must preserve the observed closed GitHub state`);
            }
            if (github.evidenceKind !== 'historical-author-comment-not-current-validation')
            {
                errors.push(`${label} must distinguish historical comments from current validation`);
            }
            if (!new RegExp(`^https://github\\.com/Ozwasyd/FsusBlog/issues/${issueNumber}#issuecomment-[0-9]+$`, 'u')
                .test(text(github.completionCommentUrl)))
            {
                errors.push(`${label} completionCommentUrl must point to its own GitHub issue comment`);
            }
            if (!Array.isArray(github.reportedCommits) || github.reportedCommits.length === 0
        || github.reportedCommits.some((commit) => !/^[0-9a-f]{8,40}$/u.test(text(commit))))
            {
                errors.push(`${label} historical completion must list reported commit ids`);
            }
        }
    }

    const worktree = child?.currentWorktreeEvidence;
    if (!isObject(worktree))
    {
        errors.push(`${label}.currentWorktreeEvidence must be an object`);
    }
    else
    {
        if (!validVerificationStatuses.has(worktree.verificationStatus))
        {
            errors.push(`${label}.currentWorktreeEvidence.verificationStatus is invalid`);
        }
        if (index?.currentWorktreeValidation?.status === 'not-run' && worktree.verificationStatus !== 'not-run')
        {
            errors.push(`${label} cannot claim current verification while the index says validation was not run`);
        }
        if (!Array.isArray(worktree.paths))
        {
            errors.push(`${label}.currentWorktreeEvidence.paths must be an array`);
        }
        else
        {
            if (issueNumber <= 1012 && worktree.paths.length === 0)
            {
                errors.push(`${label} closed historical issue must list current inspectable paths`);
            }
            for (let pathIndex = 0; pathIndex < worktree.paths.length; pathIndex += 1)
            {
                await checkExistingPath(root, worktree.paths[pathIndex], errors, `${label}.currentWorktreeEvidence.paths[${pathIndex}]`);
            }
        }
    }

    const stageIssue = issueNumber === 1013 || issueNumber === 1014;
    if (!stageIssue && child?.stageGate !== null)
    {
        errors.push(`${label} immediate/detour issue must have stageGate=null`);
        return { stageComplete: true };
    }
    if (!stageIssue)
    {
        return { stageComplete: true };
    }

    const gate = child?.stageGate;
    if (!isObject(gate))
    {
        errors.push(`${label}.stageGate must be an object`);
        return { stageComplete: false };
    }
    if (gate.failClosed !== true)
    {
        errors.push(`${label}.stageGate.failClosed must be true`);
    }
    if (!['blocked', 'ready', 'complete'].includes(gate.status))
    {
        errors.push(`${label}.stageGate.status must be blocked, ready, or complete`);
    }
    pushRequiredString(errors, gate.completionPolicy, `${label}.stageGate.completionPolicy`);
    if (!Array.isArray(gate.triggers) || gate.triggers.length === 0)
    {
        errors.push(`${label}.stageGate.triggers must be non-empty`);
        return { stageComplete: false };
    }

    const triggerIds = new Set();
    let allRequiredSatisfied = true;
    for (let triggerIndex = 0; triggerIndex < gate.triggers.length; triggerIndex += 1)
    {
        const trigger = gate.triggers[triggerIndex];
        const triggerLabel = `${label}.stageGate.triggers[${triggerIndex}]`;
        pushRequiredString(errors, trigger?.id, `${triggerLabel}.id`);
        if (triggerIds.has(trigger?.id))
        {
            errors.push(`${triggerLabel}.id is duplicated`);
        }
        triggerIds.add(trigger?.id);
        if (trigger?.required !== true)
        {
            errors.push(`${triggerLabel}.required must be true`);
        }
        if (typeof trigger?.satisfied !== 'boolean')
        {
            errors.push(`${triggerLabel}.satisfied must be boolean`);
        }
        if (!Array.isArray(trigger?.evidencePaths))
        {
            errors.push(`${triggerLabel}.evidencePaths must be an array`);
            allRequiredSatisfied = false;
            continue;
        }
        if (!trigger.satisfied)
        {
            allRequiredSatisfied = false;
        }
        if (trigger.satisfied && trigger.evidencePaths.length === 0)
        {
            errors.push(`${triggerLabel} is satisfied without evidence paths`);
        }
        for (let evidenceIndex = 0; evidenceIndex < trigger.evidencePaths.length; evidenceIndex += 1)
        {
            await checkExistingPath(root, trigger.evidencePaths[evidenceIndex], errors, `${triggerLabel}.evidencePaths[${evidenceIndex}]`);
        }
    }
    if ((gate.status === 'ready' || gate.status === 'complete') && !allRequiredSatisfied)
    {
        errors.push(`${label} stage gate cannot be ${gate.status} until every required trigger has evidence`);
    }
    if (gate.status === 'complete' && github?.stateObserved !== 'closed')
    {
        errors.push(`${label} stage gate cannot be complete while GitHub state is observed open`);
    }
    if (gate.status !== 'complete')
    {
        notices.push(`${label} stage gate is ${gate.status} and remains fail-closed.`);
    }
    return { stageComplete: gate.status === 'complete' && allRequiredSatisfied };
}

export async function validateDeadCodeAuditIndex(index, options = {})
{
    const root = path.resolve(options.root ?? defaultRoot);
    const requireComplete = options.requireComplete === true;
    const errors = [];
    const warnings = [];
    const notices = [];

    if (!isObject(index))
    {
        return {
            schemaVersion: 'fsus.dead-code-audit-index-check.v1',
            passed: false,
            completionReady: false,
            errors: ['index must be a JSON object'],
            warnings: [],
            notices: []
        };
    }
    if (index.schemaVersion !== 'fsus.dead-code-audit-index.v1')
    {
        errors.push('schemaVersion must be fsus.dead-code-audit-index.v1');
    }
    if (index?.parentIssue?.number !== 1015)
    {
        errors.push('parentIssue.number must be 1015');
    }
    if (index?.parentIssue?.stateObserved !== 'open')
    {
        errors.push('parentIssue.stateObserved must preserve the observed open state');
    }
    if (index?.parentIssue?.commentsRead !== true || index?.parentIssue?.commentCount !== 0)
    {
        errors.push('parentIssue must record commentsRead=true and commentCount=0');
    }

    validateFindingCounts(index, errors);
    const sourceReportComplete = await validateSourceReport(index, root, errors, notices, requireComplete);
    const currentValidationPassed = validateCurrentValidation(index, errors, notices, requireComplete);
    const children = Array.isArray(index.children) ? index.children : [];
    if (!Array.isArray(index.children))
    {
        errors.push('children must be an array');
    }
    validateIssueSplit(index, children, errors, notices);

    const numbers = children.map((entry) => entry?.issue);
    const duplicateNumbers = numbers.filter((value, position) => numbers.indexOf(value) !== position);
    for (const duplicate of [...new Set(duplicateNumbers)])
    {
        errors.push(`duplicate child issue: ${String(duplicate)}`);
    }
    if (numbers.length !== expectedIssues.length || expectedIssues.some((issue, indexPosition) => numbers[indexPosition] !== issue))
    {
        errors.push('children must contain exactly the ordered contiguous issue range #998-#1014');
    }

    const stageResults = [];
    for (let indexPosition = 0; indexPosition < children.length; indexPosition += 1)
    {
        const child = children[indexPosition];
        if (child?.order !== indexPosition + 1)
        {
            errors.push(`${issueLabel(child)}.order must be ${indexPosition + 1}`);
        }
        stageResults.push(await validateChild(child, index, root, errors, notices));
    }
    const stagesComplete = stageResults.every((result) => result.stageComplete);
    const historicalChildrenClosed = children
        .filter((child) => child?.issue <= 1012)
        .every((child) => child?.githubHistoricalEvidence?.stateObserved === 'closed');
    const completionReady = sourceReportComplete && currentValidationPassed && historicalChildrenClosed && stagesComplete;
    if (requireComplete && !stagesComplete)
    {
        errors.push('completion requires #1013 and #1014 stage gates to be complete');
    }
    if (requireComplete && !historicalChildrenClosed)
    {
        errors.push('completion requires every immediate/detour child to retain closed historical state');
    }

    return {
        schemaVersion: 'fsus.dead-code-audit-index-check.v1',
        indexSchemaVersion: index.schemaVersion ?? null,
        parentIssue: 1015,
        childIssueCount: children.length,
        findingCountClaim: index?.auditClaims?.findingCounts ?? null,
        sourceReportComplete,
        currentValidationPassed,
        stagesComplete,
        completionReady,
        requireComplete,
        passed: errors.length === 0,
        errors,
        warnings,
        notices: [...new Set(notices)]
    };
}

function parseArguments(argv)
{
    const options = {
        root: defaultRoot,
        index: defaultIndex,
        requireComplete: false
    };
    while (argv.length > 0)
    {
        const argument = argv.shift();
        if (argument === '--require-complete')
        {
            options.requireComplete = true;
            continue;
        }
        const value = argv.shift();
        if (value === undefined)
        {
            throw new Error(`${argument} requires a value`);
        }
        if (argument === '--root')
        {
            options.root = path.resolve(value);
        }
        else if (argument === '--index')
        {
            options.index = value;
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const indexPath = path.isAbsolute(options.index)
        ? options.index
        : path.join(options.root, options.index);
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    const report = await validateDeadCodeAuditIndex(index, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed)
    {
        process.exitCode = 1;
    }
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url)
{
    main().catch((error) =>
    {
        process.stdout.write(`${JSON.stringify({
            schemaVersion: 'fsus.dead-code-audit-index-check.v1',
            passed: false,
            completionReady: false,
            errors: [error instanceof Error ? error.message : String(error)],
            warnings: [],
            notices: []
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}
