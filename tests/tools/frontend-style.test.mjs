import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
    reviewedResidualAuthorityPath,
    reviewedResidualConsumptionRequired,
    validateReviewedResidualConsumption,
    validateReviewedResidualDocument
} = await import(pathToFileURL(path.join(root, 'tools/frontend/reviewed-residual-classification.mjs')).href);
const { validatePostRuntimeReaderFirewall } = await import(new URL('../../tools/test-matrix/post-runtime-producer-registry.mjs', import.meta.url));
const { validateJsonSchema } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/schema-validator/validate.mjs')).href
);
const checker = path.join(root, 'tools/frontend/check-frontend-style.mjs');
const toolchain = path.join(root, 'tools/frontend/style-toolchain');
const eslintConfig = path.join(toolchain, 'eslint.config.mjs');
const sourcePolicy = JSON.parse(readFileSync(path.join(root, 'config/development/frontend-style-policy.json'), 'utf8'));

function writeFixture(fixtureRoot, relativePath, content)
{
    const target = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
}

function createFixture()
{
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-frontend-style-'));
    writeFixture(fixtureRoot, '.editorconfig', readFileSync(path.join(root, '.editorconfig'), 'utf8'));
    writeFixture(
        fixtureRoot,
        'eslint.config.mjs',
        "export { default } from './tools/frontend/style-toolchain/eslint.config.mjs';\n"
    );
    writeFixture(
        fixtureRoot,
        'stylelint.config.mjs',
        "export { default } from './tools/frontend/style-toolchain/stylelint.config.mjs';\n"
    );
    writeFixture(
        fixtureRoot,
        'config/development/frontend-style-rule-registry.json',
        readFileSync(path.join(root, sourcePolicy.ruleRegistry), 'utf8')
    );
    const policy = {
        ...sourcePolicy,
        baseline: 'config/development/frontend-style-baseline.json',
        configurationSources: ['.editorconfig', 'eslint.config.mjs', 'stylelint.config.mjs']
    };
    writeFixture(
        fixtureRoot,
        'config/development/frontend-style-policy.json',
        `${JSON.stringify(policy, null, 4)}\n`
    );
    writeFixture(
        fixtureRoot,
        'src/frontend/package.json',
        readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8')
    );
    writeFixture(
        fixtureRoot,
        'src/frontend/tsconfig.json',
        `${JSON.stringify({
            compilerOptions: {
                target: 'ES2023',
                module: 'ESNext',
                moduleResolution: 'Bundler',
                strict: true,
                noEmit: true,
                lib: ['ES2023', 'DOM']
            },
            include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.vue']
        }, null, 4)}\n`
    );
    const linkedToolchain = path.join(fixtureRoot, 'tools/frontend/style-toolchain');
    mkdirSync(path.dirname(linkedToolchain), { recursive: true });
    cpSync(toolchain, linkedToolchain, { recursive: true, verbatimSymlinks: true });
    for (const relative of [
        'config/development/canonical-digest-edge.json',
        'src/frontend/eslint.config.mjs', 'src/frontend/stylelint.config.mjs',
        'tools/frontend/check-frontend-style.mjs',
        'tools/frontend/source-unit-style-diff.mjs',
        'tools/frontend/reviewed-residual-classification.mjs',
        'src/frontend/scripts/run-local-fsusui-typecheck.mjs',
        'src/frontend/scripts/fsusui-root.mjs',
        'src/frontend/tsconfig.node.json'
    ])
    {
        writeFixture(fixtureRoot, relative, readFileSync(path.join(root, relative), 'utf8'));
    }
    return fixtureRoot;
}

function runChecker(fixtureRoot, args, env = {})
{
    return spawnSync(process.execPath, [
        path.join(fixtureRoot, 'tools/frontend/check-frontend-style.mjs'),
        '--root', fixtureRoot,
        '--policy', path.join(fixtureRoot, 'config/development/frontend-style-policy.json'),
        ...args
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_USE_LOCAL_FSUSUI: '0', ...env },
        timeout: 90_000
    });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

function alignFixtureSpecializedGovernance(fixtureRoot)
{
    const packageDocument = JSON.parse(readFileSync(path.join(fixtureRoot, 'src/frontend/package.json'), 'utf8'));
    const entries = Object.entries(packageDocument.scripts ?? {})
        .filter(([id]) => id.startsWith('check:'))
        .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1);
    const policyPath = path.join(fixtureRoot, 'config/development/frontend-style-policy.json');
    const fixturePolicy = JSON.parse(readFileSync(policyPath, 'utf8'));
    fixturePolicy.specializedGovernance = {
        ...fixturePolicy.specializedGovernance,
        count: entries.length,
        idsSha256: createHash('sha256').update(entries.map(([id]) => id).join('\n')).digest('hex'),
        definitionsSha256: createHash('sha256').update(entries.map(([id, value]) => `${id}=${value}`).join('\n')).digest('hex')
    };
    writeFileSync(policyPath, `${JSON.stringify(fixturePolicy, null, 4)}\n`);
}

function withFixture(callback)
{
    const fixtureRoot = createFixture();
    try
    {
        callback(fixtureRoot);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

test('frontend style governance accepts C#-mapped TypeScript JavaScript Vue and CSS fixtures', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/frontend/src/GoodModule.ts',
            `export async function readValue(value: number): Promise<number>
{
    await Promise.resolve();
    return value;
}
`
        );
        writeFixture(
            fixtureRoot,
            'tools/sample/good-tool.mjs',
            `export function readValue(value)
{
    return value;
}
`
        );
        writeFixture(
            fixtureRoot,
            'src/frontend/src/GoodPanel.vue',
            `<template>
    <section
        aria-label="Good panel"
        data-kind="fixture"
    >
        {{ props.label }}
    </section>
</template>

<script setup lang="ts">
const props = { label: 'Good' };
</script>

<style scoped>
.good-panel
{
    color: red;
}
</style>
`
        );
        writeFixture(
            fixtureRoot,
            'src/frontend/src/good-panel.scss',
            `$panelColor: red;

.good-panel
{
    color: $panelColor;
}
`
        );
        const result = runChecker(fixtureRoot, [
            '--mode', 'strict-full',
            '--file', 'src/frontend/src/GoodModule.ts',
            '--file', 'tools/sample/good-tool.mjs',
            '--file', 'src/frontend/src/GoodPanel.vue',
            '--file', 'src/frontend/src/good-panel.scss'
        ]);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /\[frontend-style\] ok files=4 eslint=3 stylelint=2 violations=0 new=0/u);
    });
});

test('reviewed residual authority does not suppress strict-full parent-import diagnostics', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'tools/parent.mjs', 'export const parentValue = 1;\n');
        writeFixture(
            fixtureRoot,
            'tools/child/residual.mjs',
            `import { parentValue } from '../parent.mjs';

export const residualValue = parentValue;
`
        );
        const result = runChecker(fixtureRoot, [
            '--mode', 'strict-full',
            '--file', 'tools/child/residual.mjs'
        ]);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /eslint\/import-x\/no-relative-parent-imports/u);
    });
});

test('pure receipt parent import exception is limited to one file and one dependency', async (t) =>
{
    const pureFile = 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs';
    for (const vector of [
        { name: 'exact file and literal', file: pureFile, literal: '../fact-extractors/lib/canonicalize.mjs', accepted: true },
        { name: 'other file', file: 'tools/docs/other-contract.mjs', literal: '../fact-extractors/lib/canonicalize.mjs', accepted: false },
        { name: 'other literal', file: pureFile, literal: '../fact-extractors/identity.mjs', accepted: false },
        { name: 'path alias', file: pureFile, literal: '../fact-extractors/lib/../lib/canonicalize.mjs', accepted: false }
    ])
    {
        await t.test(vector.name, () =>
        {
            withFixture((fixtureRoot) =>
            {
                const canonicalSource = readFileSync(path.join(root, 'tools/fact-extractors/lib/canonicalize.mjs'), 'utf8');
                const callerSource = readFileSync(path.join(root, pureFile), 'utf8');
                writeFixture(fixtureRoot, 'tools/fact-extractors/lib/canonicalize.mjs', canonicalSource);
                writeFixture(fixtureRoot, 'tools/fact-extractors/identity.mjs', canonicalSource);
                writeFixture(fixtureRoot, vector.file,
                    callerSource.replace('../fact-extractors/lib/canonicalize.mjs', vector.literal));
                const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', vector.file]);
                if (vector.accepted)
                {
                    assert.equal(result.status, 0, output(result));
                    assert.match(result.stdout, /violations=0 new=0/u);
                }
                else
                {
                    assert.notEqual(result.status, 0, output(result));
                    assert.match(output(result), /eslint\/import-x\/no-relative-parent-imports/u);
                }
            });
        });
    }
});

test('pure receipt style mapping does not admit transitive I/O or execution', () =>
{
    withFixture((fixtureRoot) =>
    {
        const entry = 'tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs';
        const canonicalizer = 'tools/fact-extractors/lib/canonicalize.mjs';
        writeFixture(fixtureRoot, entry, readFileSync(path.join(root, entry), 'utf8'));
        writeFixture(fixtureRoot, canonicalizer, readFileSync(path.join(root, canonicalizer), 'utf8'));
        assert.deepEqual(validatePostRuntimeReaderFirewall(fixtureRoot, entry).modules, [entry, canonicalizer]);
        for (const moduleName of ['node:fs', 'node:child_process'])
        {
            writeFixture(fixtureRoot, canonicalizer,
                `import * as capability from ${JSON.stringify(moduleName)};\n\nexport const digestValue = capability;\n`);
            assert.throws(() => validatePostRuntimeReaderFirewall(fixtureRoot, entry),
                new RegExp(`forbidden I/O or execution module ${moduleName}`, 'u'));
        }
    });
});

test('reviewed residual consumption requires a canonical repository-wide baseline update', () =>
{
    withFixture((fixtureRoot) =>
    {
        const partial = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--reviewed-residual-classification', reviewedResidualAuthorityPath,
            '--file', 'tools/sample.mjs'
        ]);
        assert.notEqual(partial.status, 0);
        assert.match(output(partial), /requires a canonical full baseline update without --file/u);

        const changed = runChecker(fixtureRoot, [
            '--mode', 'changed',
            '--update-baseline',
            '--reviewed-residual-classification', reviewedResidualAuthorityPath
        ]);
        assert.notEqual(changed.status, 0);
        assert.match(output(changed), /requires a canonical full baseline update without --file/u);
    });
});

test('frontend style governance aggregates indentation brace semicolon naming promise any and import failures', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'src/frontend/src/aModule.ts', 'export const aValue = 1;\n');
        writeFixture(fixtureRoot, 'src/frontend/src/zModule.ts', 'export const zValue = 2;\n');
        writeFixture(
            fixtureRoot,
            'src/frontend/src/badModule.ts',
            `import { zValue } from './zModule';
import { aValue } from './aModule';

export async function bad_name(BadParameter: any) {
  Promise.resolve()
  return BadParameter + aValue + zValue
}
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/frontend/src/badModule.ts']);
        const combined = output(result);
        assert.notEqual(result.status, 0);
        for (const rule of [
            '@stylistic/brace-style',
            '@stylistic/indent',
            '@stylistic/semi',
            '@typescript-eslint/naming-convention',
            '@typescript-eslint/no-explicit-any',
            '@typescript-eslint/no-floating-promises',
            'import-x/order'
        ])
        {
            assert.match(combined, new RegExp(rule.replaceAll('/', '\\/'), 'u'), `missing ${rule} in ${combined}`);
        }
    });
});

test('frontend style governance checks Vue multiline attributes and CSS through AST parsers', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/frontend/src/BadPanel.vue',
            `<template>
  <section aria-label="Bad" data-kind="fixture">
  </section>
</template>

<style scoped>
.bad-panel {
  color: red; background: blue;
}
</style>
`
        );
        const result = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/frontend/src/BadPanel.vue']);
        const combined = output(result);
        assert.notEqual(result.status, 0);
        assert.match(combined, /eslint\/vue\/html-indent/u);
        assert.match(combined, /eslint\/vue\/max-attributes-per-line/u);
        assert.match(combined, /stylelint\/@stylistic\/block-opening-brace-newline-before/u);
        assert.match(combined, /stylelint\/@stylistic\/indentation/u);
        assert.match(combined, /stylelint\/@stylistic\/declaration-block-semicolon-newline-after/u);
    });
});

test('frontend style governance preserves JSON browser HTML and CSS contract spellings', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(
            fixtureRoot,
            'src/frontend/src/externalContract.ts',
            `export function readExternalContract(): string
{
    const payload = { 'user_id': 'stable' };
    window.dispatchEvent(new CustomEvent('fsus:event-name'));
    return payload.user_id;
}
`
        );
        writeFixture(
            fixtureRoot,
            'src/frontend/src/external-contract.css',
            `.external-contract__value
{
    --external-contract-color: red;

    color: var(--external-contract-color);
}
`
        );
        const result = runChecker(fixtureRoot, [
            '--mode', 'strict-full',
            '--file', 'src/frontend/src/externalContract.ts',
            '--file', 'src/frontend/src/external-contract.css'
        ]);
        assert.equal(result.status, 0, output(result));
    });
});

test('frontend style governance excludes generated and intentional fixture paths', () =>
{
    withFixture((fixtureRoot) =>
    {
        writeFixture(fixtureRoot, 'src/frontend/src/generated/Bad.ts', 'export function bad_name() {\r\n}\r\n');
        writeFixture(fixtureRoot, 'tests/tools/fixtures/bad-tool.mjs', 'export function bad_name() {\r\n}\r\n');
        const result = runChecker(fixtureRoot, [
            '--mode', 'changed',
            '--file', 'src/frontend/src/generated/Bad.ts',
            '--file', 'tests/tools/fixtures/bad-tool.mjs'
        ]);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /ok files=0 eslint=0 stylelint=0 violations=0 new=0/u);
    });
});

test('frontend style governance rejects reduced source coverage or specialized governance commands', () =>
{
    withFixture((fixtureRoot) =>
    {
        const policyPath = path.join(fixtureRoot, 'config/development/frontend-style-policy.json');
        const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
        policy.eslintSourceSets = policy.eslintSourceSets.filter((sourceSet) => sourceSet.root !== 'src/frontend/scripts');
        writeFileSync(policyPath, `${JSON.stringify(policy, null, 4)}\n`);
        const result = runChecker(fixtureRoot, ['--mode', 'changed']);
        assert.notEqual(result.status, 0);
        assert.match(output(result), /eslintSourceSets is missing required root src\/frontend\/scripts/u);
    });

    withFixture((fixtureRoot) =>
    {
        const packagePath = path.join(fixtureRoot, 'src/frontend/package.json');
        const packageDocument = JSON.parse(readFileSync(packagePath, 'utf8'));
        delete packageDocument.scripts['check:modern-standards'];
        writeFileSync(packagePath, `${JSON.stringify(packageDocument, null, 4)}\n`);
        const result = runChecker(fixtureRoot, ['--mode', 'changed']);
        const combined = output(result);
        assert.notEqual(result.status, 0);
        assert.match(combined, /specialized governance command count changed/u);
        assert.match(combined, /specialized governance command IDs changed/u);
        assert.match(combined, /specialized governance command definitions changed/u);
    });
});

test('frontend style governance migrates specialized governance authority after retiring the ZK benchmark command', () =>
{
    const currentCommandCount = sourcePolicy.specializedGovernance.count;
    assert.ok(currentCommandCount > 0);
    withFixture((fixtureRoot) =>
    {
        const current = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/frontend/package.json']);
        assert.equal(current.status, 0, output(current));

        const packagePath = path.join(fixtureRoot, 'src/frontend/package.json');
        const packageDocument = JSON.parse(readFileSync(packagePath, 'utf8'));
        assert.equal(packageDocument.scripts['check:privacy-zk-benchmark'], undefined);
        packageDocument.scripts['check:privacy-zk-benchmark'] = 'node retired-zk-benchmark.mjs';
        writeFileSync(packagePath, `${JSON.stringify(packageDocument, null, 4)}\n`);

        const resurrected = runChecker(fixtureRoot, ['--mode', 'changed', '--file', 'src/frontend/package.json']);
        const combined = output(resurrected);
        assert.notEqual(resurrected.status, 0);
        assert.match(
            combined,
            new RegExp(`specialized governance command count changed: expected ${currentCommandCount}, got ${currentCommandCount + 1}`, 'u')
        );
        assert.match(combined, /specialized governance command IDs changed/u);
        assert.match(combined, /specialized governance command definitions changed/u);
    });
});

test('frontend style governance full mode accepts only unchanged baseline debt and strict-full exposes it', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/legacy-tool.mjs';
        const legacy = `export function legacy_name(value) {
  return value
}
`;
        writeFixture(fixtureRoot, relativePath, legacy);
        const update = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(update.status, 0, output(update));
        assert.match(update.stdout, /baseline updated violations=/u);

        const full = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath]);
        assert.equal(full.status, 0, output(full));

        const strict = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', relativePath]);
        assert.notEqual(strict.status, 0);
        assert.match(output(strict), /eslint\/@stylistic\/brace-style/u);

        writeFixture(fixtureRoot, relativePath, legacy.replace('return value', 'return String(value)'));
        const changed = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath]);
        assert.notEqual(changed.status, 0);
        assert.match(output(changed), /eslint\/@stylistic\/semi/u);
    });
});

test('frontend style governance invalidates typed lint cache when an ambient source changes', () =>
{
    withFixture((fixtureRoot) =>
    {
        const declarationPath = 'src/frontend/src/runtime-flag.d.ts';
        const consumerPath = 'src/frontend/src/runtimeFlag.ts';
        writeFixture(fixtureRoot, declarationPath, 'declare const runtimeFlag: any;\n');
        writeFixture(
            fixtureRoot,
            consumerPath,
            `export const enabled: boolean = runtimeFlag.enabled;
`
        );

        const unsafe = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', consumerPath]);
        assert.notEqual(unsafe.status, 0);
        assert.match(output(unsafe), /@typescript-eslint\/no-unsafe-assignment/u);

        writeFixture(
            fixtureRoot,
            declarationPath,
            `declare const runtimeFlag: {
    readonly enabled: boolean;
};
`
        );
        const safe = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', consumerPath]);
        assert.equal(safe.status, 0, output(safe));
    });
});

test('frontend style governance baseline updates preserve paths and reject violation growth', () =>
{
    withFixture((fixtureRoot) =>
    {
        const existingPath = 'tools/legacy/existing-tool.mjs';
        const addedPath = 'tools/legacy/added-tool.mjs';
        writeFixture(fixtureRoot, existingPath, `export function existing_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const before = readFileSync(baselinePath, 'utf8');

        writeFixture(fixtureRoot, addedPath, `export function added_name(value) {
  return value
}
`);
        const added = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(added.status, 0);
        assert.match(output(added), /refusing new frontend style baseline path tools\/legacy\/added-tool\.mjs/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), before);
        rmSync(path.join(fixtureRoot, addedPath));

        writeFixture(fixtureRoot, existingPath, `export function existing_name(value) {
  const extra_value = value
  return extra_value
}
`);
        const increased = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(increased.status, 0);
        assert.match(output(increased), /refusing frontend style baseline violation increase for tools\/legacy\/existing-tool\.mjs/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), before);
    });
});

test('frontend style governance baseline updates reject equal-count violation identity replacement', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/identity-tool.mjs';
        writeFixture(fixtureRoot, relativePath, `export function first_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const before = readFileSync(baselinePath, 'utf8');

        writeFixture(fixtureRoot, relativePath, `export function second_name(value) {
  return value
}
`);
        const replacement = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(replacement.status, 0);
        assert.match(output(replacement), /violation identity change without count decrease/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), before);
    });
});

test('frontend style correction authority binds the malformed repository entry to the canonical rescan', () =>
{
    const relativePath = 'tests/frontend/checks/public/check-public-header-material.mjs';
    const source = readFileSync(path.join(root, relativePath));
    const baseline = JSON.parse(readFileSync(path.join(root, sourcePolicy.baseline), 'utf8'));
    const authority = JSON.parse(readFileSync(
        path.join(root, 'config/development/frontend-style-baseline-corrections.json'),
        'utf8'
    ));
    const authoritySchema = JSON.parse(readFileSync(
        path.join(root, 'config/schemas/frontend-style-baseline-corrections.schema.json'),
        'utf8'
    ));
    const malformed = baseline.files.find(({ path: file }) => file === relativePath);
    const correction = authority.corrections.find(({ path: file }) => file === relativePath);

    assert.ok(malformed);
    assert.ok(correction);
    assert.equal(authoritySchema.properties.schema.const, authority.schema);
    assert.deepEqual(authoritySchema.required, ['schema', 'reviewIssue', 'corrections']);
    assert.deepEqual(authoritySchema.properties.corrections.items.required, Object.keys(correction));
    assert.equal(authority.reviewIssue, 3126);
    assert.equal(authority.corrections.length, 1);
    assert.equal(createHash('sha256').update(source).digest('hex'), correction.sourceSha256);
    assert.deepEqual({
        sourceSha256: malformed.sourceSha256,
        violationCount: malformed.violationCount,
        violationDigest: malformed.violationDigest,
        rules: malformed.rules
    }, {
        sourceSha256: correction.sourceSha256,
        violationCount: correction.previousViolationCount,
        violationDigest: correction.previousViolationDigest,
        rules: correction.previousRules
    });
    assert.equal(malformed.violationCount, 75);
    assert.equal(Object.values(malformed.rules).reduce((sum, count) => sum + count, 0), 785);

    const rescanned = runChecker(root, [
        '--mode', 'strict-full',
        '--file', relativePath
    ]);
    const diagnosticPrefix = `[frontend-style] ${relativePath}:`;
    const diagnostics = output(rescanned).split(/\r?\n/u)
        .filter((line) => line.startsWith(diagnosticPrefix))
        .map((line) =>
        {
            const match = line.slice(diagnosticPrefix.length).match(/^(\d+):(\d+) ([^/]+)\/([^:]+): (.+)$/u);
            assert.ok(match, line);
            const [, lineNumber, column, tool, rule, message] = match;
            return {
                id: `${tool}:${rule}:${relativePath}:${lineNumber}:${column}:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`,
                rule: `${tool}/${rule}`
            };
        });
    const correctedRules = {};
    for (const diagnostic of diagnostics)
    {
        correctedRules[diagnostic.rule] = (correctedRules[diagnostic.rule] ?? 0) + 1;
    }
    assert.deepEqual({
        violationCount: diagnostics.length,
        violationDigest: createHash('sha256').update(diagnostics.map(({ id }) => id).sort().join('\n')).digest('hex'),
        rules: Object.fromEntries(Object.entries(correctedRules).sort(([left], [right]) => left.localeCompare(right)))
    }, {
        violationCount: correction.correctedViolationCount,
        violationDigest: correction.correctedViolationDigest,
        rules: correction.correctedRules
    });
    assert.equal(correction.correctedViolationCount, 75);
    assert.equal(Object.values(correction.correctedRules).reduce((sum, count) => sum + count, 0), 75);
});

test('frontend style governance accepts only an exact pre-existing malformed baseline correction', () =>
{
    withFixture((fixtureRoot) =>
    {
        alignFixtureSpecializedGovernance(fixtureRoot);
        const relativePath = 'tools/legacy/malformed-aggregate-tool.mjs';
        const correctionPath = 'config/development/frontend-style-baseline-corrections.json';
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const git = (args) => spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
        const expectGit = (args) =>
        {
            const result = git(args);
            assert.equal(result.status, 0, `${args.join(' ')}\n${output(result)}`);
        };
        writeFixture(fixtureRoot, relativePath, `export function malformed_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const canonicalBaseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
        const corrected = canonicalBaseline.files.find(({ path: file }) => file === relativePath);
        assert.ok(corrected);
        const previousRules = {
            ...corrected.rules,
            'eslint/malformed-historical-aggregate': 1
        };
        const previousViolationDigest = '0'.repeat(64);
        const malformedBaseline = structuredClone(canonicalBaseline);
        const malformedEntry = malformedBaseline.files.find(({ path: file }) => file === relativePath);
        malformedEntry.violationDigest = previousViolationDigest;
        malformedEntry.rules = previousRules;
        const malformedBytes = `${JSON.stringify(malformedBaseline, null, 4)}\n`;
        const correction = {
            schema: 'fsusblog.frontend-style-baseline-corrections.v1',
            reviewIssue: 3126,
            corrections: [{
                path: relativePath,
                sourceSha256: corrected.sourceSha256,
                previousViolationCount: corrected.violationCount,
                previousViolationDigest,
                previousRules,
                correctedViolationCount: corrected.violationCount,
                correctedViolationDigest: corrected.violationDigest,
                correctedRules: corrected.rules,
                reason: 'Repair the exact malformed historical aggregate without changing source bytes or accepting new debt.',
                terminalCondition: 'baseline-entry-replaced-once'
            }]
        };
        const writeCorrection = (document) => writeFixture(
            fixtureRoot,
            correctionPath,
            `${JSON.stringify(document, null, 4)}\n`
        );
        const authorize = (document, message) =>
        {
            writeCorrection(document);
            expectGit(['add', correctionPath]);
            expectGit(['commit', '-qm', message]);
            expectGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
        };
        const authorizeBytes = (bytes, message) =>
        {
            writeFixture(fixtureRoot, correctionPath, bytes);
            expectGit(['add', correctionPath]);
            expectGit(['commit', '-qm', message]);
            expectGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
        };
        writeFileSync(baselinePath, malformedBytes);
        writeCorrection(correction);
        expectGit(['init', '-q']);
        expectGit(['config', 'user.email', 'fixture@example.invalid']);
        expectGit(['config', 'user.name', 'Fixture']);
        expectGit(['add', '.']);
        expectGit(['commit', '-qm', 'test: establish reviewed malformed baseline correction']);
        expectGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
        const reviewedAuthorityCommit = git(['rev-parse', 'HEAD']).stdout.trim();

        const unreviewed = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(unreviewed.status, 0);
        assert.match(output(unreviewed), /violation identity change without count decrease/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), malformedBytes);

        const reviewedArgs = [
            '--mode', 'full',
            '--update-baseline',
            '--reviewed-baseline-correction', correctionPath
        ];
        rmSync(baselinePath);
        const initialBaselineMisuse = runChecker(fixtureRoot, reviewedArgs);
        assert.notEqual(initialBaselineMisuse.status, 0);
        assert.match(output(initialBaselineMisuse), /must exactly match rejected paths/u);
        assert.equal(existsSync(baselinePath), false);
        writeFileSync(baselinePath, malformedBytes);

        const reviewed = runChecker(fixtureRoot, reviewedArgs);
        assert.equal(reviewed.status, 0, output(reviewed));
        const repaired = JSON.parse(readFileSync(baselinePath, 'utf8'));
        assert.deepEqual(repaired.files.find(({ path: file }) => file === relativePath), corrected);
        const reused = runChecker(fixtureRoot, reviewedArgs);
        assert.notEqual(reused.status, 0);
        assert.match(output(reused), /must exactly match rejected paths/u);

        expectGit(['add', sourcePolicy.baseline]);
        expectGit(['commit', '-qm', 'test: consume reviewed malformed baseline correction']);
        expectGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
        writeFileSync(baselinePath, malformedBytes);
        const revertedAfterConsumption = runChecker(fixtureRoot, reviewedArgs);
        assert.notEqual(revertedAfterConsumption.status, 0);
        assert.match(output(revertedAfterConsumption), /stale or not an exact malformed-aggregate repair/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), malformedBytes);
        expectGit(['update-ref', 'refs/remotes/origin/master', reviewedAuthorityCommit]);

        writeFileSync(baselinePath, malformedBytes);
        writeCorrection({ ...correction, reviewIssue: 3127 });
        const candidateAuthored = runChecker(fixtureRoot, reviewedArgs);
        assert.notEqual(candidateAuthored.status, 0);
        assert.match(output(candidateAuthored), /must already exist unchanged/u);

        writeFileSync(baselinePath, malformedBytes);
        writeCorrection(null);
        const candidateAuthoredNull = runChecker(fixtureRoot, reviewedArgs);
        assert.notEqual(candidateAuthoredNull.status, 0);
        assert.match(output(candidateAuthoredNull), /must already exist unchanged/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), malformedBytes);

        for (const [name, document] of [
            ['null scalar', null],
            ['false scalar', false],
            ['array', []],
            ['extra top-level field', { ...correction, unexpected: true }]
        ])
        {
            writeFileSync(baselinePath, malformedBytes);
            authorize(document, `test: pre-exist invalid ${name}`);
            const rejected = runChecker(fixtureRoot, reviewedArgs);
            assert.notEqual(rejected.status, 0, `${name} unexpectedly passed`);
            assert.match(output(rejected), /is not a closed fsusblog\.frontend-style-baseline-corrections\.v1 document/u);
            assert.equal(readFileSync(baselinePath, 'utf8'), malformedBytes);
        }

        writeFileSync(baselinePath, malformedBytes);
        authorizeBytes('{ malformed correction\n', 'test: pre-exist malformed correction JSON');
        const malformedCorrection = runChecker(fixtureRoot, reviewedArgs);
        assert.notEqual(malformedCorrection.status, 0);
        assert.match(output(malformedCorrection), /invalid JSON/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), malformedBytes);

        writeFileSync(baselinePath, malformedBytes);
        rmSync(path.join(fixtureRoot, correctionPath));
        const missingCorrection = runChecker(fixtureRoot, reviewedArgs);
        assert.notEqual(missingCorrection.status, 0);
        assert.match(output(missingCorrection), /missing config\/development\/frontend-style-baseline-corrections\.json/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), malformedBytes);

        const mutations = [
            ['source digest', (document) =>
            {
                document.corrections[0].sourceSha256 = '1'.repeat(64);
            }],
            ['previous count', (document) =>
            {
                document.corrections[0].previousViolationCount += 1;
            }],
            ['previous digest', (document) =>
            {
                document.corrections[0].previousViolationDigest = '2'.repeat(64);
            }],
            ['previous rule sum', (document) =>
            {
                document.corrections[0].previousRules['eslint/malformed-historical-aggregate'] = 2;
            }],
            ['corrected count', (document) =>
            {
                document.corrections[0].correctedViolationCount += 1;
            }],
            ['corrected digest', (document) =>
            {
                document.corrections[0].correctedViolationDigest = '3'.repeat(64);
            }],
            ['corrected rules', (document) =>
            {
                document.corrections[0].correctedRules['eslint/unexpected-rule'] = 1;
            }],
            ['path', (document) =>
            {
                document.corrections[0].path = 'tools/legacy/other-tool.mjs';
            }],
            ['extra entry', (document) =>
            {
                document.corrections.push({ ...document.corrections[0], path: 'tools/legacy/extra-tool.mjs' });
            }],
            ['duplicate entry', (document) =>
            {
                document.corrections.push(structuredClone(document.corrections[0]));
            }],
            ['missing entry', (document) =>
            {
                document.corrections = [];
            }],
            ['terminal condition', (document) =>
            {
                document.corrections[0].terminalCondition = 'source-content-change';
            }]
        ];
        for (const [name, mutate] of mutations)
        {
            writeFileSync(baselinePath, malformedBytes);
            const document = structuredClone(correction);
            mutate(document);
            authorize(document, `test: mutate ${name}`);
            const rejected = runChecker(fixtureRoot, reviewedArgs);
            assert.notEqual(rejected.status, 0, `${name} unexpectedly passed`);
            assert.equal(readFileSync(baselinePath, 'utf8'), malformedBytes);
        }
    });
});

test('reviewed residual authority is exact, canonical and closed against structural mutation', () =>
{
    const authorityPath = path.join(root, reviewedResidualAuthorityPath);
    const bytes = readFileSync(authorityPath, 'utf8');
    const authority = JSON.parse(bytes);
    const schema = JSON.parse(readFileSync(
        path.join(root, 'config/schemas/frontend-style-reviewed-residual.schema.json'),
        'utf8'
    ));
    assert.deepEqual(validateJsonSchema(authority, schema), []);
    assert.deepEqual(validateReviewedResidualDocument(authority, bytes, { root }), []);
    assert.deepEqual(schema.required, Object.keys(authority));
    assert.deepEqual(schema.$defs.entry.required, Object.keys(authority.entries[0]));
    assert.deepEqual(schema.$defs.diagnostic.required, Object.keys(authority.entries[0].diagnostics[0]));
    assert.equal(authority.pathCount, 149);
    assert.equal(authority.entries.length, 149);
    assert.equal(authority.diagnosticCount, 329);
    assert.equal(authority.otherDiagnosticCount, 0);
    assert.deepEqual(authority.ruleCounts, {
        'eslint/import-x/no-relative-parent-imports': 329
    });
    assert.equal(
        authority.entries.reduce((sum, entry) => sum + entry.diagnosticCount, 0),
        329
    );
    assert.equal(
        authority.entries.find(({ path: file }) => file === 'tests/tools/production-build-bootstrap.test.mjs')?.priorOwnerCommit,
        '784cf6d589054e435eaec8129c86bab3d7f94d39'
    );
    assert.equal(
        authority.entries.find(({ path: file }) => file === 'tools/test/run-deterministic-command.mjs')?.priorOwnerCommit,
        'f13f7fc3944ee65ceae41b13eb30628f919e864d'
    );

    const canonical = (document) => `${JSON.stringify(document, null, 4)}\n`;
    const mutations = [
        ['extra field', true, (document) =>
        {
            document.unreviewed = true;
        }],
        ['missing entry', true, (document) =>
        {
            document.entries.pop();
        }],
        ['extra entry', true, (document) =>
        {
            document.entries.push(structuredClone(document.entries.at(-1)));
        }],
        ['duplicate path', false, (document) =>
        {
            document.entries[1].path = document.entries[0].path;
        }],
        ['renamed path', false, (document) =>
        {
            document.entries[0].path = 'tests/browser-contract/renamed-fixture-provider.mjs';
        }],
        ['reordered paths', false, (document) =>
        {
            [document.entries[0], document.entries[1]] = [document.entries[1], document.entries[0]];
        }],
        ['rule', true, (document) =>
        {
            document.entries[0].ruleCounts['eslint/other'] = 1;
        }],
        ['diagnostic identity', false, (document) =>
        {
            document.entries[0].diagnostics[0].identity = document.entries[0].diagnostics[1].identity;
        }],
        ['diagnostic order', false, (document) =>
        {
            [document.entries[0].diagnostics[0], document.entries[0].diagnostics[1]] = [
                document.entries[0].diagnostics[1],
                document.entries[0].diagnostics[0]
            ];
        }],
        ['diagnostic digest', false, (document) =>
        {
            document.entries[0].diagnosticDigest = '0'.repeat(64);
        }],
        ['owner', false, (document) =>
        {
            document.entries[0].priorOwnerCommit = '0'.repeat(40);
        }],
        ['terminal condition', true, (document) =>
        {
            document.entries[0].terminalCondition = 'reusable';
        }]
    ];
    for (const [name, schemaMustReject, mutate] of mutations)
    {
        const document = structuredClone(authority);
        mutate(document);
        const schemaFailures = validateJsonSchema(document, schema);
        const semanticFailures = validateReviewedResidualDocument(document, canonical(document), { root });
        if (schemaMustReject)
        {
            assert.notDeepEqual(schemaFailures, [], `${name} unexpectedly passed JSON Schema`);
        }
        assert.notDeepEqual(
            [...schemaFailures, ...semanticFailures],
            [],
            `${name} unexpectedly passed`
        );
    }
    assert.match(
        validateReviewedResidualDocument(authority, `${bytes}\n`, { root }).join('\n'),
        /not canonical/u
    );
});

test('reviewed residual consumption rejects candidate authority, drift, partial use and reuse', () =>
{
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-reviewed-residual-'));
    try
    {
        const sourceAuthority = JSON.parse(readFileSync(path.join(root, reviewedResidualAuthorityPath), 'utf8'));
        const git = (args) => spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
        const expectGit = (args) =>
        {
            const result = git(args);
            assert.equal(result.status, 0, `${args.join(' ')}\n${output(result)}`);
        };
        expectGit(['init', '-q']);
        expectGit(['config', 'user.email', 'fixture@example.invalid']);
        expectGit(['config', 'user.name', 'Fixture']);
        for (const [index, entry] of sourceAuthority.entries.entries())
        {
            writeFixture(fixtureRoot, entry.path, `export const source${index} = ${index};\n`);
        }
        writeFixture(
            fixtureRoot,
            'config/development/frontend-style-baseline.json',
            `${JSON.stringify({
                schema: 'fsusblog.frontend-style-baseline.v1',
                files: sourceAuthority.entries
                    .map(({ reviewBaseBaseline }) => reviewBaseBaseline)
                    .filter(Boolean)
            }, null, 4)}\n`
        );
        expectGit(['add', '.']);
        expectGit(['commit', '-qm', 'test: establish prior source owners']);
        const sourceCommit = git(['rev-parse', 'HEAD']).stdout.trim();
        const authority = structuredClone(sourceAuthority);
        authority.reviewBaseCommit = sourceCommit;
        for (const entry of authority.entries)
        {
            entry.priorOwnerCommit = sourceCommit;
            entry.priorConsumerBaseline = {
                path: entry.path,
                sourceSha256: '0'.repeat(64),
                violationCount: 0,
                violationDigest: createHash('sha256').update('').digest('hex'),
                rules: {}
            };
        }
        authority.priorConsumerProjectionSha256 = createHash('sha256')
            .update(authority.entries.map((entry) =>
                `${entry.path}\n${JSON.stringify(entry.priorConsumerBaseline)}`).join('\n'))
            .digest('hex');
        const authorityBytes = `${JSON.stringify(authority, null, 4)}\n`;
        writeFixture(fixtureRoot, reviewedResidualAuthorityPath, authorityBytes);
        expectGit(['add', reviewedResidualAuthorityPath]);
        expectGit(['commit', '-qm', 'test: publish reviewed residual authority']);
        expectGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
        writeFixture(fixtureRoot, 'consumer-marker.txt', 'consumer\n');
        expectGit(['add', 'consumer-marker.txt']);
        expectGit(['commit', '-qm', 'test: create downstream consumer']);

        const emptyDigest = createHash('sha256').update('').digest('hex');
        const currentByPath = new Map();
        const previousByPath = new Map();
        const violationsByPath = new Map();
        for (const entry of authority.entries)
        {
            currentByPath.set(entry.path, {
                path: entry.path,
                sourceSha256: entry.sourceSha256,
                violationCount: entry.diagnosticCount,
                violationDigest: entry.diagnosticDigest,
                rules: entry.ruleCounts
            });
            previousByPath.set(entry.path, {
                path: entry.path,
                sourceSha256: '0'.repeat(64),
                violationCount: 0,
                violationDigest: emptyDigest,
                rules: {}
            });
            violationsByPath.set(entry.path, entry.diagnostics.map((diagnostic) => ({
                id: diagnostic.identity,
                tool: 'eslint',
                rule: 'import-x/no-relative-parent-imports',
                line: diagnostic.line,
                column: diagnostic.column,
                endLine: diagnostic.endLine,
                endColumn: diagnostic.endColumn,
                messageSha256: diagnostic.messageSha256
            })));
        }
        const validate = (overrides = {}) => validateReviewedResidualConsumption({
            root: fixtureRoot,
            authorityPath: reviewedResidualAuthorityPath,
            expectedReviewBaseCommit: sourceCommit,
            currentByPath,
            previousByPath,
            violationsByPath,
            ...overrides
        });
        assert.equal(reviewedResidualConsumptionRequired(authority, currentByPath, previousByPath), true);
        assert.deepEqual(validate(), []);

        const sourceDrift = new Map(currentByPath);
        sourceDrift.set(authority.entries[0].path, {
            ...sourceDrift.get(authority.entries[0].path),
            sourceSha256: '1'.repeat(64)
        });
        assert.match(validate({ currentByPath: sourceDrift }).join('\n'), /source, rule, or diagnostic identity is stale/u);

        const ruleDrift = new Map(violationsByPath);
        ruleDrift.set(authority.entries[0].path, ruleDrift.get(authority.entries[0].path).map((entry, index) => index === 0
            ? { ...entry, rule: 'no-unused-vars' }
            : entry));
        assert.match(validate({ violationsByPath: ruleDrift }).join('\n'), /diagnostic identity is stale/u);

        const diagnosticDrift = new Map(violationsByPath);
        diagnosticDrift.set(authority.entries[0].path, diagnosticDrift.get(authority.entries[0].path).slice(1));
        assert.match(validate({ violationsByPath: diagnosticDrift }).join('\n'), /missing|complete/u);

        const extraDiagnostic = new Map(violationsByPath);
        extraDiagnostic.set(authority.entries[0].path, [
            ...extraDiagnostic.get(authority.entries[0].path),
            {
                id: 'eslint:no-unused-vars:tools/extra.mjs:1:1:0000000000000000',
                tool: 'eslint',
                rule: 'no-unused-vars',
                line: 1,
                column: 1,
                endLine: 1,
                endColumn: 2,
                messageSha256: '0'.repeat(64)
            }
        ]);
        assert.match(validate({ violationsByPath: extraDiagnostic }).join('\n'), /extra or missing diagnostics/u);

        const partialCurrent = new Map(currentByPath);
        partialCurrent.delete(authority.entries.at(-1).path);
        assert.match(validate({ currentByPath: partialCurrent }).join('\n'), /partially consumed/u);

        const consumedBaseline = new Map(currentByPath);
        assert.equal(reviewedResidualConsumptionRequired(authority, currentByPath, consumedBaseline), false);
        assert.match(validate({ previousByPath: consumedBaseline }).join('\n'), /already consumed/u);

        writeFixture(
            fixtureRoot,
            'config/development/frontend-style-baseline.json',
            `${JSON.stringify({
                schema: 'fsusblog.frontend-style-baseline.v1',
                files: [...currentByPath.values()]
            }, null, 4)}\n`
        );
        expectGit(['add', 'config/development/frontend-style-baseline.json']);
        expectGit(['commit', '-qm', 'test: consume reviewed residual baseline']);
        expectGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
        assert.match(validate().join('\n'), /was consumed|remote baseline projection drifted/u);

        const candidateAuthority = structuredClone(authority);
        candidateAuthority.entries[0].sourceSha256 = '2'.repeat(64);
        writeFileSync(
            path.join(fixtureRoot, reviewedResidualAuthorityPath),
            `${JSON.stringify(candidateAuthority, null, 4)}\n`
        );
        assert.match(validate().join('\n'), /must already exist unchanged/u);

        rmSync(path.join(fixtureRoot, reviewedResidualAuthorityPath));
        assert.match(validate().join('\n'), /missing or invalid reviewed residual authority/u);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('frontend style governance baseline configuration migration requires explicit old-digest authorization', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/config-tool.mjs';
        writeFixture(fixtureRoot, relativePath, `export function config_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const before = readFileSync(baselinePath, 'utf8');
        const previous = JSON.parse(before);
        const editorConfigPath = path.join(fixtureRoot, '.editorconfig');
        writeFileSync(editorConfigPath, `${readFileSync(editorConfigPath, 'utf8')}\n`);

        const rejected = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(rejected.status, 0);
        assert.match(output(rejected), /baseline configuration digest changed/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), before);

        const migrated = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--migrate-baseline-configuration', previous.configurationSha256
        ]);
        assert.equal(migrated.status, 0, output(migrated));
        assert.notEqual(JSON.parse(readFileSync(baselinePath, 'utf8')).configurationSha256, previous.configurationSha256);
    });
});

test('frontend style governance configuration identity binds the Node runtime boundary', () =>
{
    const checkerSource = readFileSync(path.join(root, 'tools/frontend/check-frontend-style.mjs'), 'utf8');
    assert.match(checkerSource, /runtime\\nnode=\$\{process\.version\}\\nplatform=\$\{process\.platform\}\\narch=\$\{process\.arch\}/u);
});

test('frontend style governance migrates reviewed semantic paths without admitting new debt', () =>
{
    withFixture((fixtureRoot) =>
    {
        alignFixtureSpecializedGovernance(fixtureRoot);
        const oldPath = 'tests/tools/issue-1234-path.test.mjs';
        const newPath = 'tests/tools/semantic-path.test.mjs';
        const reusedPath = 'tests/tools/already-baselined-path.test.mjs';
        const inventoryPath = 'tests/test-asset-semantic-renames.json';
        const retainedContent = `export function retained_debt(value) {
  return value
}
`;
        writeFixture(fixtureRoot, oldPath, retainedContent);
        writeFixture(fixtureRoot, reusedPath, `export function existing_destination(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));

        const referenceOnlyInventory = 'tests/reference-only-semantic-paths.json';
        writeFixture(fixtureRoot, referenceOnlyInventory, `${JSON.stringify({
            schema: 'fsusblog.test-asset-semantic-renames.v1',
            referenceFiles: [oldPath],
            renames: []
        }, null, 4)}\n`);
        const referenceOnly = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--migrate-baseline-paths', referenceOnlyInventory
        ]);
        assert.notEqual(referenceOnly.status, 0);
        assert.match(output(referenceOnly), /path migration inventory is invalid/u);

        const nonRenameInventory = 'tests/non-rename-semantic-paths.json';
        writeFixture(fixtureRoot, nonRenameInventory, `${JSON.stringify({
            schema: 'fsusblog.test-asset-semantic-renames.v1',
            referenceFiles: [],
            renames: [{ from: oldPath, to: oldPath }]
        }, null, 4)}\n`);
        const nonRename = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--migrate-baseline-paths', nonRenameInventory
        ]);
        assert.notEqual(nonRename.status, 0);
        assert.match(output(nonRename), /not an exact one-to-one live rename/u);

        rmSync(path.join(fixtureRoot, oldPath));
        writeFixture(fixtureRoot, inventoryPath, `${JSON.stringify({
            schema: 'fsusblog.test-asset-semantic-renames.v1',
            referenceFiles: [],
            renames: [{ from: oldPath, to: reusedPath }]
        }, null, 4)}\n`);
        const reusedDestination = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--migrate-baseline-paths', inventoryPath
        ]);
        assert.notEqual(reusedDestination.status, 0);
        assert.match(output(reusedDestination), /does not preserve exact source and baseline identity/u);

        writeFixture(fixtureRoot, newPath, `export function unrelated_replacement(value) {
  return value
}
`);
        for (const [name, renames] of [
            ['duplicate', [{ from: oldPath, to: newPath }, { from: oldPath, to: newPath }]],
            ['cycle', [{ from: oldPath, to: newPath }, { from: newPath, to: oldPath }]]
        ])
        {
            writeFixture(fixtureRoot, inventoryPath, `${JSON.stringify({
                schema: 'fsusblog.test-asset-semantic-renames.v1',
                referenceFiles: [],
                renames
            }, null, 4)}\n`);
            const invalidInventory = runChecker(fixtureRoot, [
                '--mode', 'full',
                '--update-baseline',
                '--migrate-baseline-paths', inventoryPath
            ]);
            assert.notEqual(invalidInventory.status, 0, `${name} rename inventory unexpectedly passed`);
            assert.match(output(invalidInventory), /not an exact one-to-one live rename|cycles, chains, or path reuse/u);
        }
        writeFixture(fixtureRoot, inventoryPath, `${JSON.stringify({
            schema: 'fsusblog.test-asset-semantic-renames.v1',
            referenceFiles: [],
            renames: [{ from: oldPath, to: newPath }]
        }, null, 4)}\n`);
        const contentReplacement = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--prune-removed-baseline-paths',
            '--migrate-baseline-paths', inventoryPath
        ]);
        assert.notEqual(contentReplacement.status, 0);
        assert.match(output(contentReplacement), /does not preserve exact source and baseline identity/u);

        writeFixture(fixtureRoot, newPath, retainedContent);
        const migrated = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--prune-removed-baseline-paths',
            '--migrate-baseline-paths', inventoryPath
        ]);
        assert.equal(migrated.status, 0, output(migrated));
        const baseline = JSON.parse(readFileSync(path.join(fixtureRoot, sourcePolicy.baseline), 'utf8'));
        assert.equal(baseline.files.some(({ path: file }) => file === oldPath), false);
        assert.equal(baseline.files.some(({ path: file }) => file === newPath), true);

        const debtPath = 'tests/tools/unreviewed-debt.test.mjs';
        writeFixture(fixtureRoot, debtPath, `export function bad_name(value) {
  return value
}
`);
        const reusedMigration = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--migrate-baseline-paths', inventoryPath
        ]);
        assert.notEqual(reusedMigration.status, 0);
        assert.match(output(reusedMigration), /does not preserve exact source and baseline identity/u);

        const rejected = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(rejected.status, 0);
        assert.match(output(rejected), /refusing new frontend style baseline path/u);
    });
});

test('frontend style governance baseline records real zero state and candidate source identity', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/zero-tool.mjs';
        writeFixture(fixtureRoot, relativePath, `export function zero_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));

        writeFixture(fixtureRoot, relativePath, `export function readValue(value)
{
    return value;
}
`);
        const updated = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(updated.status, 0, output(updated));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const first = readFileSync(baselinePath, 'utf8');
        const document = JSON.parse(first);
        const entry = document.files.find((candidate) => candidate.path === relativePath);
        assert.deepEqual(entry, {
            path: relativePath,
            sourceSha256: createHash('sha256').update(readFileSync(path.join(fixtureRoot, relativePath))).digest('hex'),
            violationCount: 0,
            violationDigest: createHash('sha256').update('').digest('hex'),
            rules: {}
        });
        assert.equal(document.generatedFrom, `source-state:${document.sourceStateSha256}`);
        assert.match(document.sourceStateSha256, /^[0-9a-f]{64}$/u);

        const repeated = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(repeated.status, 0, output(repeated));
        assert.equal(readFileSync(baselinePath, 'utf8'), first);
    });
});

test('frontend style governance full check rejects a tampered baseline source-state digest', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/digest-binding-tool.mjs';
        writeFixture(fixtureRoot, relativePath, `export function digest_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const document = JSON.parse(readFileSync(baselinePath, 'utf8'));
        document.sourceStateSha256 = '0'.repeat(64);
        writeFileSync(baselinePath, `${JSON.stringify(document, null, 4)}\n`);

        const checked = runChecker(fixtureRoot, ['--mode', 'full']);
        assert.notEqual(checked.status, 0);
        assert.match(output(checked), /baseline source-state digest is stale/u);
    });
});

test('frontend style governance full check rejects a tampered baseline generatedFrom binding', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/generated-from-binding-tool.mjs';
        writeFixture(fixtureRoot, relativePath, `export function generated_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const document = JSON.parse(readFileSync(baselinePath, 'utf8'));
        document.generatedFrom = `source-state:${'0'.repeat(64)}`;
        writeFileSync(baselinePath, `${JSON.stringify(document, null, 4)}\n`);

        const checked = runChecker(fixtureRoot, ['--mode', 'full']);
        assert.notEqual(checked.status, 0);
        assert.match(output(checked), /baseline generatedFrom does not match/u);
    });
});

test('frontend style governance full check rejects source drift without a per-file baseline entry', () =>
{
    withFixture((fixtureRoot) =>
    {
        const debtPath = 'tools/legacy/source-binding-tool.mjs';
        writeFixture(fixtureRoot, debtPath, `export function source_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));

        writeFixture(fixtureRoot, 'tools/sample/new-clean-source.mjs', `export function readValue(value)
{
    return value;
}
`);
        const checked = runChecker(fixtureRoot, ['--mode', 'full']);
        assert.notEqual(checked.status, 0);
        assert.match(output(checked), /baseline source-state digest is stale/u);
    });
});

test('frontend style governance unchanged zero-debt bindings pass every scan mode', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/sample/clean-binding.mjs';
        writeFixture(fixtureRoot, relativePath, 'export const value = 1;\n');
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        for (const mode of ['changed', 'full', 'strict-full'])
        {
            const checked = runChecker(fixtureRoot, ['--mode', mode, '--file', relativePath]);
            assert.equal(checked.status, 0, output(checked));
            assert.match(output(checked), /violations=0 new=0/u);
        }
    });
});

test('frontend style governance rejects each clean full-scan binding drift without blocking other modes', () =>
{
    for (const [field, diagnostic] of [
        ['configurationSha256', 'baseline configuration digest is stale'],
        ['sourceStateSha256', 'baseline source-state digest is stale'],
        ['generatedFrom', 'baseline generatedFrom does not match']
    ])
    {
        withFixture((fixtureRoot) =>
        {
            const relativePath = 'tools/sample/clean-binding.mjs';
            writeFixture(fixtureRoot, relativePath, 'export const value = 1;\n');
            const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
            assert.equal(initial.status, 0, output(initial));
            const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
            const document = JSON.parse(readFileSync(baselinePath, 'utf8'));
            document[field] = field === 'generatedFrom' ? `source-state:${'0'.repeat(64)}` : '0'.repeat(64);
            const staleBytes = `${JSON.stringify(document, null, 4)}\n`;
            writeFileSync(baselinePath, staleBytes);
            for (const mode of ['changed', 'full', 'strict-full'])
            {
                const checked = runChecker(fixtureRoot, ['--mode', mode, '--file', relativePath]);
                assert.equal(checked.status, mode === 'full' ? 1 : 0, output(checked));
                if (mode === 'full')
                {
                    assert.ok(output(checked).includes(diagnostic), output(checked));
                }
                else
                {
                    assert.doesNotMatch(output(checked), /baseline (?:configuration|source-state|generatedFrom)/u);
                }
                assert.equal(readFileSync(baselinePath, 'utf8'), staleBytes);
            }
        });
    }
});

test('frontend style governance aggregates combined binding drift and every selected file finding', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/combined-binding.mjs';
        writeFixture(fixtureRoot, relativePath, 'export function readValue(value) {\n  return value\n}\n');
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const document = JSON.parse(readFileSync(baselinePath, 'utf8'));
        document.configurationSha256 = '0'.repeat(64);
        document.sourceStateSha256 = '0'.repeat(64);
        document.generatedFrom = `source-state:${'0'.repeat(64)}`;
        writeFileSync(baselinePath, `${JSON.stringify(document, null, 4)}\n`);
        for (const mode of ['changed', 'full', 'strict-full'])
        {
            const checked = runChecker(fixtureRoot, ['--mode', mode, '--file', relativePath]);
            assert.equal(checked.status, 1, output(checked));
            for (const rule of ['brace-style', 'indent', 'semi'])
            {
                assert.ok(output(checked).includes(`eslint/@stylistic/${rule}:`), output(checked));
            }
            if (mode === 'full')
            {
                assert.match(output(checked), /baseline configuration digest is stale/u);
                assert.match(output(checked), /baseline source-state digest is stale/u);
                assert.match(output(checked), /baseline generatedFrom does not match/u);
            }
            else
            {
                assert.doesNotMatch(output(checked), /baseline (?:configuration|source-state|generatedFrom)/u);
            }
        }
    });
});

test('frontend style governance clean source and real configuration drift preserve scan mode boundaries', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/sample/clean-binding.mjs';
        writeFixture(fixtureRoot, relativePath, 'export const value = 1;\n');
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        writeFixture(fixtureRoot, 'tools/sample/new-clean-binding.mjs', 'export const addedValue = 2;\n');
        writeFixture(fixtureRoot, '.editorconfig', `${readFileSync(path.join(fixtureRoot, '.editorconfig'), 'utf8')}\n# binding drift\n`);
        for (const mode of ['changed', 'full', 'strict-full'])
        {
            const checked = runChecker(fixtureRoot, ['--mode', mode, '--file', relativePath]);
            assert.equal(checked.status, mode === 'full' ? 1 : 0, output(checked));
            if (mode === 'full')
            {
                assert.match(output(checked), /baseline configuration digest is stale/u);
                assert.match(output(checked), /baseline source-state digest is stale/u);
                assert.match(output(checked), /baseline generatedFrom does not match/u);
            }
        }
    });
});

test('frontend style governance updater refreshes source bindings only after original debt checks', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/update-binding.mjs';
        writeFixture(fixtureRoot, relativePath, 'export function readValue(value) {\n  return value\n}\n');
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const previous = JSON.parse(readFileSync(baselinePath, 'utf8'));
        previous.sourceStateSha256 = '0'.repeat(64);
        previous.generatedFrom = `source-state:${'0'.repeat(64)}`;
        writeFileSync(baselinePath, `${JSON.stringify(previous, null, 4)}\n`);
        writeFixture(fixtureRoot, 'tools/sample/clean-update-binding.mjs', 'export const value = 1;\n');
        const updated = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(updated.status, 0, output(updated));
        const current = JSON.parse(readFileSync(baselinePath, 'utf8'));
        assert.notEqual(current.sourceStateSha256, previous.sourceStateSha256);
        assert.equal(current.generatedFrom, `source-state:${current.sourceStateSha256}`);
        assert.deepEqual(current.files.find((entry) => entry.path === relativePath), previous.files.find((entry) => entry.path === relativePath));
        const acceptedBytes = readFileSync(baselinePath, 'utf8');
        writeFixture(fixtureRoot, 'tools/legacy/new-update-debt.mjs', 'export function readValue(value) {\n  return value\n}\n');
        const rejected = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(rejected.status, 1, output(rejected));
        assert.match(output(rejected), /refusing new frontend style baseline path/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), acceptedBytes);
    });
});

test('frontend style governance baseline removes deleted paths only through reviewed pruning', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/legacy/removed-tool.mjs';
        writeFixture(fixtureRoot, relativePath, `export function removed_name(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const before = readFileSync(baselinePath, 'utf8');
        rmSync(path.join(fixtureRoot, relativePath));

        const rejected = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(rejected.status, 0);
        assert.match(output(rejected), /refusing missing frontend style baseline path/u);
        assert.equal(readFileSync(baselinePath, 'utf8'), before);

        const pruned = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--prune-removed-baseline-paths'
        ]);
        assert.equal(pruned.status, 0, output(pruned));
        const document = JSON.parse(readFileSync(baselinePath, 'utf8'));
        assert.equal(document.files.some((entry) => entry.path === relativePath), false);
    });
});

test('frontend style governance AST fixes are idempotent and diagnostics are locale and CI stable', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/sample/fixable-tool.mjs';
        writeFixture(
            fixtureRoot,
            relativePath,
            'export function readValue(value) {\r\n  return value\r\n}\r\n'
        );
        const first = runChecker(fixtureRoot, ['--mode', 'changed', '--fix', '--file', relativePath]);
        assert.equal(first.status, 0, output(first));
        const firstContent = readFileSync(path.join(fixtureRoot, relativePath), 'utf8');
        const second = runChecker(fixtureRoot, ['--mode', 'changed', '--fix', '--file', relativePath]);
        assert.equal(second.status, 0, output(second));
        assert.equal(readFileSync(path.join(fixtureRoot, relativePath), 'utf8'), firstContent);
        assert.match(firstContent, /readValue\(value\);?\n\{/u);
        assert.doesNotMatch(firstContent, /\r/u);

        writeFixture(fixtureRoot, relativePath, 'export function bad_name(value) {\r\n  return value\r\n}\r\n');
        const local = runChecker(fixtureRoot, ['--mode', 'changed', '--file', relativePath], {
            CI: '',
            LANG: 'C',
            LC_ALL: 'C'
        });
        const ci = runChecker(fixtureRoot, ['--mode', 'changed', '--file', relativePath], {
            CI: 'true',
            LANG: 'zh_CN.UTF-8',
            LC_ALL: 'zh_CN.UTF-8'
        });
        assert.notEqual(local.status, 0);
        assert.notEqual(ci.status, 0);
        const diagnostics = (result) => output(result)
            .split(/\r?\n/u)
            .filter((line) => line.includes(relativePath))
            .sort();
        assert.deepEqual(diagnostics(ci), diagnostics(local));
    });
});
function actualAppProgramProbe(localMode)
{
    const probe = `
        import fs from 'node:fs';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        const root = ${JSON.stringify(root)};
        const { ESLint } = await import(pathToFileURL(path.join(root, 'tools/frontend/style-toolchain/node_modules/eslint/lib/api.js')));
        const { default: ts } = await import(pathToFileURL(path.join(root, 'tools/frontend/style-toolchain/node_modules/typescript/lib/typescript.js')));
        const file = path.join(root, 'src/frontend/src/fsusui/overlay.ts');
        const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.mjs') });
        const config = await eslint.calculateConfigForFile(file);
        const parsed = config.languageOptions.parser.parseForESLint(fs.readFileSync(file, 'utf8'), {
            ...config.languageOptions.parserOptions, filePath: file
        });
        const program = parsed.services.program;
        const options = program.getCompilerOptions();
        const typeLibraries = options.types.map((name) => ({
            name,
            file: ts.resolveTypeReferenceDirective(name, options.configFilePath, options, ts.sys)
                .resolvedTypeReferenceDirective?.resolvedFileName ?? null
        }));
        const ui = ts.resolveModuleName('@ozwasyd/element-plus', file, options, ts.sys).resolvedModule?.resolvedFileName ?? null;
        const runtime = ts.resolveModuleName('@ozwasyd/element-plus/markdown-runtime', file, options, ts.sys).resolvedModule?.resolvedFileName ?? null;
        const resolve = (specifier, importer) => {
            const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule?.resolvedFileName;
            return resolved ? fs.realpathSync(resolved) : null;
        };
        const app = path.join(root, 'src/frontend/tsconfig.app.json');
        const original = ts.parseJsonConfigFileContent(ts.readConfigFile(app, ts.sys.readFile).config,
            ts.sys, path.dirname(app), {}, app, undefined,
            [{ extension: '.vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }]);
        console.log(JSON.stringify({
            project: options.configFilePath, parserOptions: config.languageOptions.parserOptions,
            optionDiagnostics: program.getOptionsDiagnostics().map((diagnostic) => diagnostic.code),
            typeLibraries, originalTypes: original.options.types,
            roots: program.getRootFileNames(), originalRoots: original.fileNames,
            strict: options.strict, originalStrict: original.options.strict,
            noUnusedLocals: options.noUnusedLocals, originalNoUnusedLocals: original.options.noUnusedLocals,
            noUnusedParameters: options.noUnusedParameters, originalNoUnusedParameters: original.options.noUnusedParameters,
            erasableSyntaxOnly: options.erasableSyntaxOnly, originalErasableSyntaxOnly: original.options.erasableSyntaxOnly,
            ui, runtime, paths: options.paths,
            vue: [resolve('vue', file), ui ? resolve('vue', ui) : null],
            vueCore: [resolve('@vue/runtime-core', file), ui ? resolve('@vue/runtime-core', ui) : null],
            unsafeArgument: config.rules['@typescript-eslint/no-unsafe-argument'],
            unsafeAssignment: config.rules['@typescript-eslint/no-unsafe-assignment']
        }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        cwd: root,
        encoding: 'utf8',
        timeout: 90_000,
        env: { ...process.env, FSUSBLOG_STYLE_ROOT: root, FSUSBLOG_USE_LOCAL_FSUSUI: localMode }
    });
    assert.equal(result.status, 0, output(result));
    return JSON.parse(result.stdout);
}

test('canonical local app program includes every original app, Wasm and SFC root with one Vue identity', () =>
{
    const program = actualAppProgramProbe('1');
    assert.match(program.project, /tsconfig\.fsusui-local\.app\.generated\.json$/u);
    assert.deepEqual(program.optionDiagnostics, []);
    assert.deepEqual(program.typeLibraries.map((library) => library.name), program.originalTypes);
    assert.ok(program.typeLibraries.every((library) => library.file));
    const roots = new Set(program.roots.map((file) => path.normalize(file)));
    assert.ok(program.originalRoots.length > 100);
    for (const file of program.originalRoots)
    {
        assert.ok(roots.has(path.normalize(file)), `canonical app program omitted ${file}`);
    }
    assert.ok([...roots].some((file) => file.endsWith('.vue')));
    assert.ok([...roots].some((file) => file.includes(`${path.sep}wasm${path.sep}web${path.sep}`)));
    assert.equal(program.strict, program.originalStrict);
    assert.equal(program.noUnusedLocals, program.originalNoUnusedLocals);
    assert.equal(program.noUnusedParameters, program.originalNoUnusedParameters);
    assert.equal(program.erasableSyntaxOnly, program.originalErasableSyntaxOnly);
    assert.ok(program.ui?.endsWith('/vue/packages/element-plus/index.ts'));
    assert.ok(program.runtime?.endsWith('/vue/packages/element-plus/markdown-runtime.ts'));
    assert.ok(program.vue[0]);
    assert.equal(program.vue[0], program.vue[1]);
    assert.ok(program.vueCore[0]);
    assert.equal(program.vueCore[0], program.vueCore[1]);
    assert.deepEqual(program.unsafeArgument, [2]);
    assert.deepEqual(program.unsafeAssignment, [2]);
});

async function localFsusUiTypecheckProbe()
{
    const { prepareLocalFsusUiTypecheckProject } = await import(
        new URL('../../src/frontend/scripts/run-local-fsusui-typecheck.mjs', import.meta.url)
    );
    const { resolveLocalFsusUiRepositoryRoot } = await import(
        new URL('../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)
    );
    const { default: ts } = await import(pathToFileURL(
        path.join(root, 'src/frontend/node_modules/typescript/lib/typescript.js')
    ));
    const localRoot = resolveLocalFsusUiRepositoryRoot({
        repositoryRoot: root,
        override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
    });
    assert.ok(localRoot, 'the canonical source checks require a real local FsusUI checkout');
    return { prepareLocalFsusUiTypecheckProject, localRoot, ts };
}

test('canonical local complete tests project inherits every original root and compiler option', async () =>
{
    const { prepareLocalFsusUiTypecheckProject, localRoot, ts } = await localFsusUiTypecheckProbe();
    const originalPath = path.join(root, 'src/frontend/tsconfig.playwright.json');
    const project = prepareLocalFsusUiTypecheckProject({ repositoryRoot: root, localRoot, fullTests: true });
    assert.match(project, /tsconfig\.fsusui-local\.tests\.generated\.json$/u);
    const read = (file) => ts.parseJsonConfigFileContent(ts.readConfigFile(file, ts.sys.readFile).config,
        ts.sys, path.dirname(file), {}, file);
    const original = read(originalPath);
    const generated = read(project);
    assert.deepEqual(original.errors, []);
    assert.deepEqual(generated.errors, []);
    const configuration = JSON.parse(readFileSync(project, 'utf8'));
    assert.equal(path.resolve(path.dirname(project), configuration.extends), originalPath);
    assert.equal(configuration.include, undefined);
    assert.equal(configuration.exclude, undefined);
    assert.deepEqual(Object.keys(configuration.compilerOptions), ['paths']);
    const inheritedOptions = (configuration) =>
    {
        const options = { ...configuration };
        for (const key of ['paths', 'pathsBasePath', 'configFilePath'])
        {
            delete options[key];
        }
        return options;
    };
    assert.deepEqual(inheritedOptions(generated.options), inheritedOptions(original.options));
    for (const [specifier, targets] of Object.entries(original.options.paths))
    {
        assert.deepEqual(generated.options.paths[specifier], targets);
    }
    const roots = new Set(generated.fileNames);
    for (const file of original.fileNames)
    {
        assert.ok(roots.has(file), `canonical tests project omitted ${file}`);
    }
    for (const file of [
        'tests/frontend/fixtures/fsusui-boundary-violation/src/frontend/src/components/DeepImportViolation.ts',
        'tests/frontend/unit/view-contracts/adminStatus.test.ts'
    ])
    {
        assert.ok(roots.has(path.join(root, file)), `canonical tests project omitted ${file}`);
    }
    assert.throws(() => prepareLocalFsusUiTypecheckProject({
        repositoryRoot: root, localRoot, fullApplication: true, fullTests: true
    }), /application and tests projects are mutually exclusive/u);
});

test('canonical local ES deep imports resolve to genuine FsusUI source in app and complete tests projects', async () =>
{
    const { prepareLocalFsusUiTypecheckProject, localRoot, ts } = await localFsusUiTypecheckProbe();
    for (const mode of [{ fullApplication: true }, { fullTests: true }])
    {
        const project = prepareLocalFsusUiTypecheckProject({ repositoryRoot: root, localRoot, ...mode });
        const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(project, ts.sys.readFile).config,
            ts.sys, path.dirname(project), {}, project);
        for (const [importer, specifier, target] of [
            ['tests/frontend/fixtures/fsusui-boundary-violation/src/frontend/src/components/DeepImportViolation.ts',
                '@ozwasyd/element-plus/es/components/button/src/button', 'components/button/src/button.ts'],
            ['tests/frontend/unit/view-contracts/adminStatus.test.ts',
                '@ozwasyd/element-plus/es/components/metric-primitives/src/shared', 'components/metric-primitives/src/shared.ts']
        ])
        {
            const resolved = ts.resolveModuleName(specifier, path.join(root, importer),
                parsed.options, ts.sys).resolvedModule;
            assert.equal(resolved?.resolvedFileName, path.join(localRoot, 'vue/packages', target));
            assert.equal(resolved.isExternalLibraryImport, false);
        }
    }
});

test('canonical local complete projects retain JSONC inherited files and path origins', async () =>
{
    const { prepareLocalFsusUiTypecheckProject, localRoot, ts } = await localFsusUiTypecheckProbe();
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-local-ui-project-'));
    try
    {
        const frontend = path.join(fixtureRoot, 'src/frontend');
        const parentDirectory = path.join(frontend, 'configuration');
        const alternateBase = path.join(parentDirectory, 'module-base');
        mkdirSync(alternateBase, { recursive: true });
        symlinkSync(path.join(root, 'src/frontend/node_modules'), path.join(frontend, 'node_modules'), 'dir');
        const inheritedFile = path.join(root, 'tests/frontend/unit/view-contracts/adminStatus.test.ts');
        const ownFile = path.join(root,
            'tests/frontend/fixtures/fsusui-boundary-violation/src/frontend/src/components/DeepImportViolation.ts');
        const target = path.join(root, 'src/frontend/src/view-contracts/adminStatus.ts');
        const read = (file) => ts.getParsedCommandLineOfConfigFile(file, {}, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic(diagnostic)
            {
                assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            }
        });
        for (const baseUrl of [undefined, './module-base'])
        {
            const pathsBase = baseUrl ? alternateBase : parentDirectory;
            const parent = {
                files: [path.relative(parentDirectory, inheritedFile)],
                compilerOptions: {
                    module: 'ESNext', moduleResolution: 'bundler', strict: true, baseUrl,
                    paths: { 'original/client': [path.relative(pathsBase, target)] }
                }
            };
            writeFileSync(path.join(parentDirectory, 'base.json'),
                `// The official TypeScript parser owns JSONC and extends semantics.\n${JSON.stringify(parent, null, 2)}\n`);
            for (const ownFiles of [undefined, [path.relative(frontend, ownFile)]])
            {
                const child = { extends: './configuration/base.json', files: ownFiles };
                for (const mode of [{ fullApplication: true }, { fullTests: true }])
                {
                    const originalPath = path.join(frontend, mode.fullTests ? 'tsconfig.playwright.json' : 'tsconfig.app.json');
                    writeFileSync(originalPath, `${JSON.stringify(child, null, 2)}\n`);
                    const original = read(originalPath);
                    assert.deepEqual(original.errors, []);
                    const project = prepareLocalFsusUiTypecheckProject({ repositoryRoot: fixtureRoot, localRoot, ...mode });
                    const generated = read(project);
                    assert.deepEqual(generated.errors, []);
                    for (const file of original.fileNames)
                    {
                        assert.ok(generated.fileNames.includes(file), `canonical project omitted explicit file ${file}`);
                    }
                    assert.ok(generated.fileNames.includes(ownFiles ? ownFile : inheritedFile));
                    if (ownFiles)
                    {
                        assert.equal(generated.fileNames.includes(inheritedFile), false,
                            'an explicit child files list must replace the inherited files list');
                    }
                    const resolve = (specifier, options) => ts.resolveModuleName(specifier, ownFile,
                        options, ts.sys).resolvedModule?.resolvedFileName;
                    assert.equal(resolve('original/client', original.options), target);
                    assert.equal(resolve('original/client', generated.options), target);
                    assert.equal(resolve('@ozwasyd/element-plus/es/components/button/src/button', generated.options),
                        path.join(localRoot, 'vue/packages/components/button/src/button.ts'));
                }
            }
        }
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('canonical local-off mode retains the original application project service', () =>
{
    const program = actualAppProgramProbe('0');
    assert.equal(path.normalize(program.project), path.join(root, 'src/frontend/tsconfig.app.json'));
    assert.equal(program.parserOptions.projectService, true);
    assert.equal(program.parserOptions.project, undefined);
    assert.equal(program.paths['@ozwasyd/element-plus'], undefined);
    assert.deepEqual(program.unsafeArgument, [2]);
    assert.deepEqual(program.unsafeAssignment, [2]);
});

test('canonical local source and standard style commands accept public app consumers without rule overrides', () =>
{
    const files = ['src/frontend/src/fsusui/overlay.ts', 'src/frontend/src/security/trustedTypesRuntime.ts'];
    const env = { ...process.env, FSUSBLOG_STYLE_ROOT: root, FSUSBLOG_USE_LOCAL_FSUSUI: '1' };
    const source = spawnSync(process.execPath, [path.join(toolchain, 'node_modules/eslint/bin/eslint.js'),
        '--config', path.join(root, 'eslint.config.mjs'), '--no-cache', '--max-warnings', '0', ...files],
    { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
    assert.equal(source.status, 0, output(source));
    const standard = spawnSync(process.execPath, [checker, '--root', root, '--mode', 'changed',
        '--base', 'HEAD', ...files.flatMap((file) => ['--file', file])],
    { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
    assert.equal(standard.status, 0, output(standard));
    assert.match(standard.stdout, /files=2 eslint=2 stylelint=0 violations=0 new=0/u);
});

test('canonical local project rejects an invalid explicit source root and local-off ignores it', async () =>
{
    const { resolveLocalFsusUiApplicationProject } = await import(new URL('../../src/frontend/scripts/run-local-fsusui-typecheck.mjs', import.meta.url));
    const env = { FSUSBLOG_USE_LOCAL_FSUSUI: '1', FSUSBLOG_LOCAL_FSUSUI_ROOT: path.join(root, '.tmp/not-an-fsusui-source') };
    assert.throws(() => resolveLocalFsusUiApplicationProject({ repositoryRoot: root, env }), /does not contain the FsusUI source contract/u);
    assert.equal(resolveLocalFsusUiApplicationProject({ repositoryRoot: root, env: { ...env, FSUSBLOG_USE_LOCAL_FSUSUI: '0' } }), null);
});

function withNodeDeclarationFixture(callback)
{
    withFixture(fixtureRoot =>
    {
        const project = 'src/frontend/tsconfig.node.json';
        writeFixture(fixtureRoot, project, readFileSync(path.join(root, project), 'utf8'));
        const policyPath = path.join(fixtureRoot, 'config/development/frontend-style-policy.json');
        const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
        policy.configurationSources.push(project);
        writeFileSync(policyPath, JSON.stringify(policy, null, 4) + '\n');
        symlinkSync(path.join(root, 'src/frontend/node_modules'), path.join(fixtureRoot, 'src/frontend/node_modules'), 'dir');
        writeFixture(fixtureRoot, 'src/frontend/scripts/esm-policy.mjs', 'export const patterns = Object.freeze(["**/coverage/**"]);\n');
        writeFixture(fixtureRoot, 'src/frontend/scripts/cjs-policy.cjs', 'module.exports = Object.freeze(["**/coverage/**"]);\n');
        const esm = 'src/frontend/scripts/esm-policy.d.mts';
        const cjs = 'src/frontend/scripts/cjs-policy.d.cts';
        writeFixture(fixtureRoot, esm, 'export declare const patterns: readonly string[];\n');
        writeFixture(fixtureRoot, cjs, 'declare const patterns: readonly string[];\nexport = patterns;\n');
        writeFixture(fixtureRoot, 'src/frontend/vite.config.ts',
            'import { patterns as esmPatterns } from "./scripts/esm-policy.mjs";\n'
            + 'import cjsPatterns from "./scripts/cjs-policy.cjs";\n'
            + 'export const ignored = [...esmPatterns, ...cjsPatterns];\n');
        callback({ fixtureRoot, esm, cjs, policyPath, project });
    });
}

test('script declaration owner inspects real ESM and CJS declarations with the unchanged original Node project', () =>
{
    withNodeDeclarationFixture(({ fixtureRoot, esm, cjs, project }) =>
    {
        const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', esm, '--file', cjs]);
        assert.equal(result.status, 0, output(result));
        assert.match(result.stdout, /files=2 eslint=2 stylelint=0 violations=0 new=0/u);
        const probe = `
            import fs from 'node:fs';
            import path from 'node:path';
            import { pathToFileURL } from 'node:url';
            const toolchain = ${JSON.stringify(toolchain)};
            const root = ${JSON.stringify(fixtureRoot)};
            const { ESLint } = await import(pathToFileURL(path.join(toolchain, 'node_modules/eslint/lib/api.js')));
            const { default: ts } = await import(pathToFileURL(path.join(toolchain, 'node_modules/typescript/lib/typescript.js')));
            const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.mjs') });
            const file = path.join(root, ${JSON.stringify(esm)});
            const config = await eslint.calculateConfigForFile(file);
            const program = config.languageOptions.parser.parseForESLint(fs.readFileSync(file, 'utf8'), {
                ...config.languageOptions.parserOptions, filePath: file
            }).services.program;
            const project = path.join(root, ${JSON.stringify(project)});
            const original = ts.parseJsonConfigFileContent(ts.readConfigFile(project, ts.sys.readFile).config,
                ts.sys, path.dirname(project), {}, project);
            console.log(JSON.stringify({ project: program.getCompilerOptions().configFilePath,
                roots: program.getRootFileNames(), originalRoots: original.fileNames,
                options: program.getCompilerOptions(), originalOptions: original.options,
                declaration: program.getSourceFile(file).isDeclarationFile,
                esmFormat: program.getSourceFile(file).impliedNodeFormat,
                cjsFormat: program.getSourceFile(path.join(root, ${JSON.stringify(cjs)})).impliedNodeFormat,
                esmExpected: ts.ModuleKind.ESNext, cjsExpected: ts.ModuleKind.CommonJS,
                noAny: config.rules['@typescript-eslint/no-explicit-any'],
                noUnsafe: config.rules['@typescript-eslint/no-unsafe-assignment'] }));
        `;
        const observed = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
            { cwd: fixtureRoot, encoding: 'utf8', timeout: 90_000,
                env: { ...process.env, FSUSBLOG_STYLE_ROOT: fixtureRoot, FSUSBLOG_USE_LOCAL_FSUSUI: '0' } });
        assert.equal(observed.status, 0, output(observed));
        const actual = JSON.parse(observed.stdout);
        assert.equal(actual.project, path.join(fixtureRoot, project));
        assert.deepEqual(actual.roots, actual.originalRoots);
        for (const option of ['strict', 'noUnusedLocals', 'noUnusedParameters', 'erasableSyntaxOnly',
            'skipLibCheck', 'noEmit', 'module', 'moduleResolution', 'types'])
        {
            assert.deepEqual(actual.options[option], actual.originalOptions[option], option);
        }
        assert.equal(actual.declaration, true);
        assert.equal(actual.esmFormat, actual.esmExpected);
        assert.equal(actual.cjsFormat, actual.cjsExpected);
        assert.deepEqual(actual.noAny, [2]);
        assert.deepEqual(actual.noUnsafe, [2]);
    });
});

test('script declaration owner rejects actual syntax and explicit-any violations', () =>
{
    for (const source of ['export declare const patterns: ;\n', 'export declare const patterns: any;\n'])
    {
        withNodeDeclarationFixture(({ fixtureRoot, esm }) =>
        {
            writeFixture(fixtureRoot, esm, source);
            const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', esm]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /Parsing error|@typescript-eslint\/no-explicit-any/u);
        });
    }
});

test('script declaration owner refuses a real ignored ESLint input without an actual report', () =>
{
    for (const ignoredPhase of ['configuration', 'report'])
    {
        withNodeDeclarationFixture(({ fixtureRoot, esm }) =>
        {
            // Both controls use real ESLint. The second keeps print-config valid
            // and ignores only its actual JSON lint invocation, proving report coverage.
            const ignore = ignoredPhase === 'report' ? 'process.argv.includes("--format")' : 'true';
            writeFixture(fixtureRoot, 'eslint.config.mjs',
                `import original from '${pathToFileURL(eslintConfig).href}';\n`
                + `const ignored = ${ignore} ? [{ ignores: ["src/frontend/scripts/**/*.d.mts"] }] : [];\n`
                + 'export default [...ignored, ...original];\n');
            const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', esm]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /coverage|report/u);
            if (ignoredPhase === 'report')
            {
                assert.match(output(result), /exactly one actual ESLint report/u);
            }
        });
    }
});

test('script declaration owner refuses policy omission and an unbound Node configuration', () =>
{
    for (const omission of ['suffix', 'configuration', 'missing-configuration'])
    {
        withNodeDeclarationFixture(({ fixtureRoot, esm, policyPath, project }) =>
        {
            const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
            if (omission === 'suffix')
            {
                for (const sourceSet of policy.eslintSourceSets)
                {
                    sourceSet.extensions = sourceSet.extensions.filter(extension => extension !== '.d.mts');
                }
            }
            else if (omission === 'configuration')
            {
                policy.configurationSources = policy.configurationSources.filter(file => file !== project);
            }
            else
            {
                rmSync(path.join(fixtureRoot, project));
            }
            writeFileSync(policyPath, JSON.stringify(policy, null, 4) + '\n');
            const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', esm]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /declaration.*(?:governed|configuration)|Node configuration/u);
        });
    }
});

test('script declaration owner refuses a real default parser even for an empty declaration', () =>
{
    withNodeDeclarationFixture(({ fixtureRoot, esm }) =>
    {
        writeFixture(fixtureRoot, esm, '');
        writeFixture(fixtureRoot, 'eslint.config.mjs',
            `import original from '${pathToFileURL(eslintConfig).href}';\n`
            + 'export default original.filter(config => config.name !== "fsusblog/type-aware-node-declarations");\n');
        const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', esm]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), /declaration.*(?:parser|project)|coverage/u);
    });
});

test('script declaration owner refuses missing linked and outside-owner inputs', () =>
{
    for (const refusal of ['missing', 'linked', 'outside-owner'])
    {
        withNodeDeclarationFixture(({ fixtureRoot, esm }) =>
        {
            let file = esm;
            if (refusal === 'outside-owner')
            {
                file = 'tools/unowned.d.mts';
                writeFixture(fixtureRoot, file, 'export declare const patterns: readonly string[];\n');
            }
            else
            {
                rmSync(path.join(fixtureRoot, esm));
                if (refusal === 'linked')
                {
                    writeFixture(fixtureRoot, 'src/frontend/scripts/linked.d.mts', 'export declare const patterns: readonly string[];\n');
                    symlinkSync('linked.d.mts', path.join(fixtureRoot, esm));
                }
            }
            const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', file]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /declaration|ENOENT|regular|governed/u);
        });
    }
});

test('script declaration owner refuses a declaration absent from the original complete Node program', () =>
{
    withNodeDeclarationFixture(({ fixtureRoot }) =>
    {
        const orphan = 'src/frontend/scripts/orphan.d.mts';
        writeFixture(fixtureRoot, orphan, 'export declare const value: string;\n');
        const result = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', orphan]);
        assert.notEqual(result.status, 0, output(result));
        assert.match(output(result), /not found|does not include|not included|Parsing error/u);
    });
});
