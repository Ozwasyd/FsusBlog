import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { parseWorkflow } = await import(new URL('../../tools/check-workflow-matrix-sync.mjs', import.meta.url));
const { parseYamlDocument } = await import(new URL('../../tools/yaml/parse-document.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
const indicators = ['|', '|-', '|+', '>', '>-', '>+'];

function replaceOnce(text, original, replacement)
{
    assert.equal(text.split(original).length, 2, `fixture must bind one original source: ${original}`);
    return text.replace(original, replacement);
}

function planScalar(text, indicator)
{
    return replaceOnce(text, '              run: >-\n', `              run: ${indicator}\n`);
}

function controlledWorkflow(plan)
{
    const original = parseYamlDocument(workflow);
    const expected = structuredClone(original);
    let text = workflow;
    for (const jobId of ['source-governance', 'validate-matrix'])
    {
        const budget = plan.jobs.find((job) => job.id === jobId)?.timeoutMinutes;
        assert.ok(Number.isInteger(budget) && budget > 0, `original ci-plan must declare ${jobId} budget`);
        const start = text.indexOf(`\n    ${jobId}:\n`);
        assert.ok(start >= 0);
        const remainder = text.slice(start + 1);
        const next = remainder.match(/\n {4}[a-z0-9-]+:\n/u);
        const end = next ? start + 1 + next.index : text.length;
        const jobText = text.slice(start, end);
        const replacement = replaceOnce(jobText, `        timeout-minutes: ${original.jobs[jobId]['timeout-minutes']}\n`,
            `        timeout-minutes: ${budget}\n`);
        text = text.slice(0, start) + replacement + text.slice(end);
        expected.jobs[jobId]['timeout-minutes'] = budget;
    }
    assert.deepEqual(parseYamlDocument(text), expected, 'controlled fixture changes only two job budgets from the original ci-plan');
    return text;
}

function diagnostics(result)
{
    return result.stderr.split(/\r?\n/u).filter((line) => line.startsWith('[workflow-matrix-sync] '));
}

test('workflow run scalars reuse structured YAML folding and preserve adjacent steps', () =>
{
    for (const indicator of indicators)
    {
        const jobs = parseWorkflow(`jobs:
    plan:
        steps:
            - run: ${indicator}
                  node tools/run-test-matrix.mjs
                  ci-pr-plan
            - run: echo adjacent
`);
        const expected = indicator.startsWith('>')
            ? ['node tools/run-test-matrix.mjs ci-pr-plan', 'echo adjacent']
            : ['node tools/run-test-matrix.mjs', 'ci-pr-plan', 'echo adjacent'];
        assert.deepEqual(jobs.get('plan').runs, expected, indicator);
    }
});

test('workflow run parser refuses malformed, unsupported and non-string scalar commands', () =>
{
    for (const indicator of ['>2', '|2-', '>--'])
    {
        assert.throws(() => parseWorkflow(`jobs:\n    plan:\n        steps:\n            - run: ${indicator}\n                  echo command\n`), /YAML/u, indicator);
    }
    assert.throws(() => parseWorkflow('jobs:\n    plan:\n        steps:\n            - run: >-\n                  echo command\n                echo misaligned\n'), /indentation/u);
    assert.throws(() => parseWorkflow('jobs:\n    plan:\n        steps:\n            - run: [echo, command]\n'), /run must be a YAML string/u);
    assert.throws(() => parseWorkflow('jobs:\n    plan:\n        steps: {run: echo}\n'), /steps must be a YAML sequence/u);
});

test('empty scalar headers do not absorb adjacent action metadata as commands', () =>
{
    for (const indicator of indicators)
    {
        const jobs = parseWorkflow(`jobs:
    plan:
        steps:
            - run: ${indicator}
            - uses: vendor/action@v1
              with:
                  command: node tools/run-test-matrix.mjs ci-pr-plan
            - run: echo adjacent
`);
        assert.deepEqual(jobs.get('plan').runs, ['echo adjacent'], indicator);
    }
});

test('original workflow sync CLI preserves refusals while consuming actual run scalars', async (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-workflow-run-scalars-'));
    try
    {
        const plan = path.join(directory, 'ci-plan.json');
        const planArguments = ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions', '--out', plan];
        const produced = spawnSync(process.execPath, planArguments, { cwd: root, encoding: 'utf8' });
        t.diagnostic(JSON.stringify({ command: [process.execPath, ...planArguments], exitCode: produced.status }));
        assert.equal(produced.status, 0, produced.stderr || produced.stdout);
        const controlled = controlledWorkflow(JSON.parse(fs.readFileSync(plan, 'utf8')));
        const cases = indicators.map((indicator) => ({ name: `controlled plan ${indicator}`, text: planScalar(controlled, indicator), errors: [] }));
        cases.push({
            name: 'wrong plan command',
            text: replaceOnce(controlled, 'node tools/run-test-matrix.mjs ci-pr-plan\n', 'node tools/run-test-matrix.mjs ci-pr-plan-unrelated\n'),
            errors: ['[workflow-matrix-sync] workflow job plan-pr-risk does not run matrix tier: pr-smart-gate-plan']
        });
        const commandBody = '                  node tools/run-test-matrix.mjs ci-pr-plan\n'
            + '                  --event-name "$FSUSBLOG_PR_EVENT_NAME" --base-ref "$FSUSBLOG_PR_BASE_REF"\n'
            + '                  --out .tmp/pr-plan.json --github-output "$GITHUB_OUTPUT"\n';
        cases.push({
            name: 'header only plan scalar',
            text: replaceOnce(controlled, commandBody, ''),
            errors: ['[workflow-matrix-sync] workflow job plan-pr-risk does not run matrix tier: pr-smart-gate-plan']
        });
        cases.push({
            name: 'adjacent action input is not a plan command',
            text: replaceOnce(replaceOnce(controlled, commandBody, ''),
                '                  path: .tmp/pr-plan.json\n',
                '                  path: .tmp/pr-plan.json\n                  command: node tools/run-test-matrix.mjs ci-pr-plan\n'),
            errors: ['[workflow-matrix-sync] workflow job plan-pr-risk does not run matrix tier: pr-smart-gate-plan']
        });
        cases.push({
            name: 'unsupported scalar header',
            text: planScalar(controlled, '>2'),
            pattern: /unsupported YAML block scalar >2/u
        });
        cases.push({
            name: 'source hidden upload missing',
            text: replaceOnce(controlled, '                  name: source-governance\n                  path: .tmp/source-governance/result.json\n                  include-hidden-files: true\n',
                '                  name: source-governance\n                  path: .tmp/source-governance/result.json\n'),
            errors: ['[workflow-matrix-sync] workflow job source-governance uploads .tmp evidence but not every upload-artifact step sets include-hidden-files: true']
        });
        for (const indicator of indicators)
        {
            for (const command of ['dotnet build', 'docker run candidate'])
            {
                cases.push({
                    name: `source hidden ${command} ${indicator}`,
                    text: replaceOnce(controlled, '            - run: node tools/test-matrix/source-governance.mjs\n',
                        `            - run: ${indicator}\n                  node tools/test-matrix/source-governance.mjs\n                  ${command}\n`),
                    errors: ['[workflow-matrix-sync] pure source stage source-governance must not build or start candidate runtime']
                });
            }
        }
        for (const fixture of cases)
        {
            await t.test(fixture.name, () =>
            {
                const fixturePath = path.join(directory, 'workflow.yml');
                fs.writeFileSync(fixturePath, fixture.text);
                const argumentsList = ['tools/check-workflow-matrix-sync.mjs', plan, fixturePath];
                const result = spawnSync(process.execPath, argumentsList, { cwd: root, encoding: 'utf8' });
                const errors = diagnostics(result);
                t.diagnostic(JSON.stringify({ fixture: fixture.name, command: [process.execPath, ...argumentsList], exitCode: result.status, errors }));
                assert.equal(result.status, fixture.errors?.length === 0 ? 0 : 1, result.stderr || result.stdout);
                if (fixture.pattern)
                {
                    assert.equal(errors.length, 1);
                    assert.match(errors[0], fixture.pattern);
                }
                else
                {
                    assert.deepEqual(errors.toSorted(), fixture.errors.toSorted());
                }
            });
        }
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
        assert.equal(fs.existsSync(directory), false);
    }
});
