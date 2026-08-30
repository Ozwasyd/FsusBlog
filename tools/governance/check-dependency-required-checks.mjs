#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    catalogRelative,
    clone,
    discoverWorkflowChecks,
    evaluateRequiredChecks,
    readJson,
    report,
    resolveGroupChecks,
    schemaRelative
} from './dependency-required-checks.mjs';
import { validateRequiredChecksCatalog } from './validate-dependency-required-checks.mjs';

const toolFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(toolFile), '../..');

export {
    discoverWorkflowChecks,
    evaluateRequiredChecks,
    resolveGroupChecks,
    validateRequiredChecksCatalog
};

export function applyCatalogMutation(catalog, mutation)
{
    const next = clone(catalog);
    if (mutation === 'missing-workflow-check')
    {
        next.checks['Does Not Exist / Phantom'] = {
            workflow: 'Does Not Exist',
            jobName: 'Phantom',
            classes: ['build'],
            triggers: ['pull_request'],
            lintOnly: false
        };
        next.branchProtection.contexts.push('Does Not Exist / Phantom');
        next.checkSets['frontend-patch'].push('Does Not Exist / Phantom');
    }
    else if (mutation === 'major-lint-only')
    {
        next.checkSets['full-pr'] = ['Quality Gate / Fast Static Governance', 'Change Contract / Change Contract'];
    }
    else if (mutation === 'group-unregistered')
    {
        next.groups = next.groups.filter((group) => group.id !== 'github-actions');
    }
    else if (mutation === 'lockfile-checks-empty')
    {
        next.checkSets.lockfile = [];
    }
    else if (mutation === 'toolchain-lint-only')
    {
        next.checkSets['frontend-patch'] = ['Quality Gate / Fast Static Governance'];
        next.checkSets['backend-patch'] = ['Quality Gate / Fast Static Governance'];
        next.checkSets['actions-patch'] = ['Quality Gate / Fast Static Governance'];
        next.checkSets['container-patch'] = ['Quality Gate / Fast Static Governance'];
    }
    return next;
}

export function runRequiredChecksFixtures(catalog, fixtures, context)
{
    const failures = [];
    for (const fixtureCase of fixtures.policyCases ?? [])
    {
        const mutated = applyCatalogMutation(catalog, fixtureCase.mutation);
        const actual = validateRequiredChecksCatalog(mutated, {
            ...context,
            branchProtection: fixtureCase.branchProtection ?? {
                strict: true,
                contexts: mutated.branchProtection.contexts
            }
        }).map((error) => error.code);
        if (!actual.includes(fixtureCase.expectedCode))
        {
            failures.push({ id: fixtureCase.id, expected: fixtureCase.expectedCode, actual });
        }
    }
    for (const fixtureCase of fixtures.selectionCases ?? [])
    {
        const actual = resolveGroupChecks(catalog, fixtureCase.group, fixtureCase.updateType);
        if (JSON.stringify(actual) !== JSON.stringify(fixtureCase.expectedChecks))
        {
            failures.push({ id: fixtureCase.id, expected: fixtureCase.expectedChecks, actual });
        }
    }
    for (const fixtureCase of fixtures.evaluationCases ?? [])
    {
        const actual = evaluateRequiredChecks(fixtureCase.required, fixtureCase.checkRuns).map((error) => error.code);
        if (JSON.stringify(actual) !== JSON.stringify(fixtureCase.expectedCodes))
        {
            failures.push({ id: fixtureCase.id, expected: fixtureCase.expectedCodes, actual });
        }
    }
    return failures;
}

function parseArguments(argv)
{
    const options = { root: defaultRoot, fixtures: null, forbidAutomerge: true };
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
        else if (argument === '--allow-automerge')
        {
            options.forbidAutomerge = false;
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    return options;
}

export function auditRequiredChecks(root, options = {})
{
    const catalog = readJson(root, catalogRelative);
    const schema = readJson(root, schemaRelative);
    const errors = [];
    if (schema?.$id !== 'https://fsusblog.dev/schemas/dependency-required-checks.schema.json')
    {
        report(errors, 'schema-id', schema?.$id ?? '<missing>');
    }
    errors.push(...validateRequiredChecksCatalog(catalog, {
        root,
        workflowChecks: discoverWorkflowChecks(root),
        branchProtection: catalog.branchProtection,
        forbidAutomerge: options.forbidAutomerge !== false
    }));
    return { catalog, errors };
}

function main()
{
    const options = parseArguments(process.argv.slice(2));
    const { catalog, errors } = auditRequiredChecks(options.root, options);
    if (options.fixtures)
    {
        const fixtures = JSON.parse(fs.readFileSync(options.fixtures, 'utf8'));
        if (fixtures.schema !== 'fsusblog.dependency-required-checks-fixtures.v1')
        {
            throw new Error(`unsupported fixture schema: ${fixtures.schema ?? '<missing>'}`);
        }
        const failures = runRequiredChecksFixtures(catalog, fixtures, {
            root: options.root,
            workflowChecks: discoverWorkflowChecks(options.root),
            forbidAutomerge: options.forbidAutomerge !== false
        });
        if (failures.length > 0)
        {
            console.error(JSON.stringify({ status: 'failed', failures }, null, 2));
            process.exitCode = 1;
            return;
        }
        const total = (fixtures.policyCases?.length ?? 0)
            + (fixtures.selectionCases?.length ?? 0)
            + (fixtures.evaluationCases?.length ?? 0);
        console.log(`dependency-required-checks fixtures ok: ${total} cases`);
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
        groups: catalog.groups.length,
        checks: Object.keys(catalog.checks).length,
        branchProtection: catalog.branchProtection.contexts.length
    }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolFile)
{
    main();
}
