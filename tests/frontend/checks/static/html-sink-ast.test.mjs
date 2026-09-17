import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checkerPath = fileURLToPath(new URL('../../../../tools/security/html-sink-ast-cli.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('../../fixtures/html-sink-ast/cases.json', import.meta.url));
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));

function runChecker(source, filePath)
{
    const directory = mkdtempSync(join(tmpdir(), 'html-sink-ast-'));
    try
    {
        const absolute = join(directory, filePath);
        writeFileSync(absolute, source);
        return spawnSync(process.execPath, [checkerPath, '--file', absolute], {
            encoding: 'utf8'
        });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

function parseSinkReports(output)
{
    const reports = [];
    for (const line of output.split('\n'))
    {
        const match = line.match(/:(\d+):(\d+): forbidden HTML sink (\S+); replace with /u);
        if (match)
        {
            reports.push({
                sink: match[3],
                line: Number(match[1]),
                column: Number(match[2])
            });
        }
    }
    return reports;
}

for (const fixture of fixtures)
{
    test(`HTML sink AST fixture: ${fixture.id}`, () =>
    {
        const result = runChecker(fixture.source, fixture.filePath);
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        const reports = parseSinkReports(output);

        if (fixture.expected === null)
        {
            assert.equal(result.status, 0, output);
            assert.deepEqual(reports, []);
            return;
        }

        assert.notEqual(result.status, 0, output);
        assert.deepEqual(reports, [fixture.expected]);
    });
}
