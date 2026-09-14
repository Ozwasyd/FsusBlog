import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const summarizer = path.join(repoRoot, 'tools/coverage/summarize-cobertura.mjs');

function coberturaXml({ firstHits, secondHits })
{
    const firstCovered = firstHits > 0 ? 2 : 0;
    const secondCovered = secondHits > 0 ? 2 : 0;
    const linesCovered = Number(firstHits > 0) + Number(secondHits > 0);
    const branchesCovered = firstCovered + secondCovered;

    return `<?xml version="1.0" encoding="utf-8"?>
<coverage lines-covered="${linesCovered}" lines-valid="2" branches-covered="${branchesCovered}" branches-valid="4">
  <packages>
    <package name="Example">
      <classes>
        <class name="Example.Subject" filename="Example/Subject.cs">
          <methods>
            <method name="Run" signature="()" line-rate="${linesCovered / 2}" branch-rate="${branchesCovered / 4}">
              <lines>
                <line number="1" hits="${firstHits}" branch="True" condition-coverage="${firstCovered * 50}% (${firstCovered}/2)" />
                <line number="2" hits="${secondHits}" branch="True" condition-coverage="${secondCovered * 50}% (${secondCovered}/2)" />
              </lines>
            </method>
          </methods>
          <lines>
            <line number="1" hits="${firstHits}" branch="True" condition-coverage="${firstCovered * 50}% (${firstCovered}/2)">
              <conditions><condition number="0" type="jump" coverage="${firstCovered * 50}%" /></conditions>
            </line>
            <line number="2" hits="${secondHits}" branch="True" condition-coverage="${secondCovered * 50}% (${secondCovered}/2)">
              <conditions><condition number="1" type="jump" coverage="${secondCovered * 50}%" /></conditions>
            </line>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`;
}

function coverletJson({ firstHits, secondHits, firstBranchHits = null, secondBranchHits = null })
{
    const branchHits = (line, hits, explicit) => (explicit ?? [hits, hits]).map((branchHitsValue, index) => ({
        Line: line,
        Offset: line * 10,
        EndOffset: line * 10 + 5 + index,
        Path: index,
        Ordinal: (line - 1) * 2 + index,
        Hits: branchHitsValue
    }));
    return `${JSON.stringify({
        'Example.dll': {
            'Example/Subject.cs': {
                'Example.Subject': {
                    'System.Void Example.Subject::Run()': {
                        Lines: { '1': firstHits, '2': secondHits },
                        Branches: [
                            ...branchHits(1, firstHits, firstBranchHits),
                            ...branchHits(2, secondHits, secondBranchHits)
                        ]
                    }
                }
            }
        }
    }, null, 2)}\n`;
}

async function writeReportPair(root, name, options)
{
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'coverage.cobertura.xml'), coberturaXml(options));
    await writeFile(path.join(directory, 'coverage.json'), coverletJson(options));
}

async function summarize(inputPath, outputPath)
{
    const result = spawnSync(process.execPath, [summarizer, inputPath, outputPath, 'backend-cobertura'], {
        cwd: repoRoot,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(await readFile(outputPath, 'utf8'));
}

test('duplicate reports do not expand coverage totals or source counts', async () =>
{
    const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-cobertura-duplicate-'));
    const reports = path.join(root, 'reports');
    await mkdir(reports);
    const options = { firstHits: 1, secondHits: 0 };
    const xml = coberturaXml(options);
    const singleReport = path.join(root, 'single.cobertura.xml');
    await writeFile(singleReport, xml);
    await writeReportPair(reports, 'ordinary', options);
    await writeReportPair(reports, 'special', options);

    const single = await summarize(singleReport, path.join(root, 'single-summary.json'));
    const duplicate = await summarize(reports, path.join(root, 'duplicate-summary.json'));

    assert.deepEqual(single.totals, {
        lines: { covered: 1, total: 2 },
        branches: { covered: 2, total: 4 },
        methods: { covered: 1, total: 1 }
    });
    assert.deepEqual(single.summary, {
        linecoverage: 50,
        branchcoverage: 50,
        methodcoverage: 100,
        assemblies: 1,
        classes: 1,
        files: 1
    });
    assert.deepEqual(duplicate.totals, single.totals);
    assert.deepEqual(duplicate.summary, single.summary);
    assert.equal(duplicate.reportPaths.length, 2);
});

test('complementary line and branch coverage is unioned by source position', async () =>
{
    const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-cobertura-union-'));
    const reports = path.join(root, 'reports');
    await mkdir(reports);
    await writeReportPair(reports, 'ordinary', { firstHits: 1, secondHits: 0 });
    await writeReportPair(reports, 'special', { firstHits: 0, secondHits: 1 });

    const summary = await summarize(reports, path.join(root, 'summary.json'));

    assert.deepEqual(summary.totals.lines, { covered: 2, total: 2 });
    assert.deepEqual(summary.totals.branches, { covered: 4, total: 4 });
    assert.equal(summary.summary.linecoverage, 100);
    assert.equal(summary.summary.branchcoverage, 100);
    assert.deepEqual(summary.totals.methods, { covered: 1, total: 1 });
});

test('opposite branches on the same source line are unioned by Coverlet branch identity', async () =>
{
    const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-coverlet-branch-union-'));
    const reports = path.join(root, 'reports');
    await mkdir(reports);
    await writeReportPair(reports, 'ordinary', {
        firstHits: 1,
        secondHits: 0,
        firstBranchHits: [1, 0]
    });
    await writeReportPair(reports, 'special', {
        firstHits: 1,
        secondHits: 0,
        firstBranchHits: [0, 1]
    });

    const summary = await summarize(reports, path.join(root, 'summary.json'));

    assert.deepEqual(summary.totals.lines, { covered: 1, total: 2 });
    assert.deepEqual(summary.totals.branches, { covered: 2, total: 4 });
    assert.equal(summary.summary.branchcoverage, 50);
});
