#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { evaluatePlatformAutomerge, validateRenovateAutomerge } from './dependency-automerge.mjs';
import {
    catalogRelative,
    clone,
    discoverWorkflowChecks,
    readJson
} from './dependency-required-checks.mjs';
import { validateRequiredChecksCatalog } from './validate-dependency-required-checks.mjs';

const toolFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(toolFile), '../..');
const renovateRelative = 'renovate.json5';

export { evaluatePlatformAutomerge, validateRenovateAutomerge };

export function auditDependencyAutomerge(root)
{
    const catalog = readJson(root, catalogRelative);
    const renovate = readJson(root, renovateRelative);
    const errors = [
        ...validateRequiredChecksCatalog(catalog, {
            root,
            workflowChecks: discoverWorkflowChecks(root),
            branchProtection: catalog.branchProtection,
            forbidAutomerge: false
        }),
        ...validateRenovateAutomerge(renovate)
    ];
    return { catalog, renovate, errors };
}

export function applyAutomergeMutation(renovate, mutation)
{
    const next = clone(renovate);
    if (mutation === 'disable-major')
    {
        next.packageRules[0].matchUpdateTypes = ['minor', 'patch', 'digest', 'lockFileMaintenance'];
    }
    else if (mutation === 'branch-automerge')
    {
        next.packageRules[0].automergeType = 'branch';
    }
    else if (mutation === 'copy-required-checks')
    {
        next.packageRules[0].statusCheckNames = ['Quality Gate / Production Summary'];
    }
    else if (mutation === 'merge-window')
    {
        next.automergeSchedule = ['after 10pm'];
    }
    else if (mutation === 'manual-approval')
    {
        next.dependencyDashboardApproval = true;
    }
    return next;
}

export function runAutomergeFixtures(catalog, renovate, fixtures)
{
    const failures = [];
    for (const fixtureCase of fixtures.policyCases ?? [])
    {
        const actual = validateRenovateAutomerge(applyAutomergeMutation(renovate, fixtureCase.mutation)).map((error) => error.code);
        if (!actual.includes(fixtureCase.expectedCode))
        {
            failures.push({ id: fixtureCase.id, expected: fixtureCase.expectedCode, actual });
        }
    }
    for (const fixtureCase of fixtures.decisionCases ?? [])
    {
        const result = evaluatePlatformAutomerge({
            catalog,
            pullRequest: fixtureCase.pullRequest,
            defaultHeadSha: fixtureCase.defaultHeadSha,
            latestStable: fixtureCase.latestStable
        });
        const codes = result.errors.map((error) => error.code);
        if (result.decision !== fixtureCase.expectedDecision
            || JSON.stringify(codes) !== JSON.stringify(fixtureCase.expectedCodes)
            || Boolean(result.close) !== Boolean(fixtureCase.expectedClose)
            || (fixtureCase.expectedLabel && result.label !== fixtureCase.expectedLabel))
        {
            failures.push({
                id: fixtureCase.id,
                expected: {
                    decision: fixtureCase.expectedDecision,
                    codes: fixtureCase.expectedCodes,
                    close: fixtureCase.expectedClose ?? false,
                    label: fixtureCase.expectedLabel
                },
                actual: { decision: result.decision, codes, close: result.close, label: result.label }
            });
        }
    }
    return failures;
}

function parseArguments(argv)
{
    const options = { root: defaultRoot, fixtures: null };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--root')
        {
            options.root = path.resolve(argv[++index]);
        }
        else if (argument === '--fixtures')
        {
            options.fixtures = path.resolve(argv[++index]);
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

function main()
{
    const options = parseArguments(process.argv.slice(2));
    const { catalog, renovate, errors } = auditDependencyAutomerge(options.root);
    if (options.fixtures)
    {
        const fixtures = JSON.parse(fs.readFileSync(options.fixtures, 'utf8'));
        if (fixtures.schema !== 'fsusblog.dependency-automerge-fixtures.v1')
        {
            throw new Error(`unsupported fixture schema: ${fixtures.schema ?? '<missing>'}`);
        }
        const failures = runAutomergeFixtures(catalog, renovate, fixtures);
        if (failures.length > 0)
        {
            console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
            process.exitCode = 1;
            return;
        }
        const total = (fixtures.policyCases?.length ?? 0) + (fixtures.decisionCases?.length ?? 0);
        console.log(`dependency-automerge fixtures ok: ${total} cases`);
        return;
    }
    if (errors.length > 0)
    {
        console.error(JSON.stringify({ status: 'failed', errors }, null, 2));
        process.exitCode = 1;
        return;
    }
    console.log(JSON.stringify({
        status: 'ok',
        automergeType: 'pr',
        platformAutomerge: true,
        updateTypes: ['major', 'minor', 'patch', 'digest', 'lockFileMaintenance']
    }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile)
{
    main();
}
