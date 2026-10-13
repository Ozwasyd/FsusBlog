import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { checkFixtureMutationRecoveryGovernance } = await import(new URL('../../tools/governance/check-fixture-mutation-recovery-governance.mjs', import.meta.url));

const authorityFiles = [
    'tools/test-fixtures/mutation-recovery/mutation-adapters.mjs',
    'tools/test-fixtures/mutation-recovery/runner.mjs',
    'tools/test-fixtures/mutation-recovery/semantic-snapshot.mjs'
];

function checkMutant(source)
{
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-recovery-import-governance-'));
    try
    {
        for (const relativePath of authorityFiles)
        {
            const destination = path.join(fixtureRoot, relativePath);
            mkdirSync(path.dirname(destination), { recursive: true });
            cpSync(relativePath, destination);
        }
        const mutant = path.join(fixtureRoot, authorityFiles[1]);
        writeFileSync(mutant, `${readFileSync(mutant, 'utf8')}\n${source}\n`);
        return checkFixtureMutationRecoveryGovernance(fixtureRoot);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

test('current canonical recovery authorities pass import governance', () =>
{
    assert.deepEqual(checkFixtureMutationRecoveryGovernance(), []);
});

for (const [name, source] of [
    ['compact import', "import{fork as renamedFork}from'node:child_process';"],
    ['multiline import', "import { fork as renamedFork }\nfrom\n'node:child_process';"],
    ['bare builtin import', "import 'child_process';"],
    ['dynamic import', "await import('node:child_process');"],
    ['dynamic template import', 'await import(`node:child_process`);'],
    ['concatenated module name', "await import('node:' + 'child_process');"],
    ['escaped module name', String.raw`await import('node:child\u005fprocess');`],
    ['CommonJS require', "require('child_process');"],
    ['module require', "module.require('node:child_process');"],
    ['computed module require', "module['require']('node:child_process');"],
    ['builtin module loader', "process.getBuiltinModule('child_process');"],
    ['renamed reexport', "export { fork as benignName } from 'node:child_process';"],
    ['wildcard reexport', "export * from 'node:child_process';"]
])
{
    test(`recovery process governance kills ${name}`, () =>
    {
        const errors = checkMutant(source);
        assert.ok(errors.some((error) => error.includes('forbids process execution')
            && error.includes(`${authorityFiles[1]}:`)), errors.join('\n'));
        assert.equal(errors.some((error) => error.includes('syntax unavailable')), false);
    });
}

test('comments and ordinary strings mentioning imports remain legal', () =>
{
    assert.deepEqual(checkMutant([
        "// import { fork } from 'node:child_process';",
        "/* await import('node:child_process'); */",
        'const historicalExample = "require(\'child_process\')";',
        'const historicalTemplate = `import("node:child_process")`;'
    ].join('\n')), []);
});

for (const [name, source] of [
    ['dynamic import variable', "const moduleName = 'node:child_process'; await import(moduleName);"],
    ['require variable', "const moduleName = 'child_process'; require(moduleName);"],
    ['module require variable', "const moduleName = 'child_process'; module.require(moduleName);"],
    ['builtin loader variable', "const moduleName = 'child_process'; process.getBuiltinModule(moduleName);"],
    ['dynamic URL variable', "const moduleName = 'child_process'; await import(new URL(moduleName, import.meta.url));"]
])
{
    test(`recovery process governance refuses unresolved ${name}`, () =>
    {
        assert.ok(checkMutant(source).some((error) => error.includes('forbids unresolved module loading')));
    });
}

test('literal relative URL imports remain statically inspectable', () =>
{
    assert.deepEqual(checkMutant("await import(new URL('./local-recovery.mjs', import.meta.url));"), []);
    assert.ok(checkMutant("await import(new URL('node:child_process', import.meta.url));")
        .some((error) => error.includes('forbids process execution')));
});

test('invalid authority syntax cannot pass governance', () =>
{
    const errors = checkMutant("await import('node:child_process'");
    assert.ok(errors.some((error) => error.includes('syntax unavailable')));
});
