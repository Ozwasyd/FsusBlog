import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
const checker = path.join(root, 'tools/frontend/check-frontend-style.mjs');
const toolchain = path.join(root, 'tools/frontend/style-toolchain');
const eslintConfig = path.join(toolchain, 'eslint.config.mjs');
const stylelintConfig = path.join(toolchain, 'stylelint.config.mjs');
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
        `export { default } from '${pathToFileURL(eslintConfig).href}';\n`
    );
    writeFixture(
        fixtureRoot,
        'stylelint.config.mjs',
        `export { default } from '${pathToFileURL(stylelintConfig).href}';\n`
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
    symlinkSync(toolchain, linkedToolchain, 'dir');
    return fixtureRoot;
}

function runChecker(fixtureRoot, args, env = {})
{
    return spawnSync(process.execPath, [
        checker,
        '--root', fixtureRoot,
        '--policy', path.join(fixtureRoot, 'config/development/frontend-style-policy.json'),
        ...args
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 90_000
    });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
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

test('issue 1159 accepts C#-mapped TypeScript JavaScript Vue and CSS fixtures', () =>
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

test('issue 1159 aggregates indentation brace semicolon naming promise any and import failures', () =>
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

test('issue 1159 checks Vue multiline attributes and CSS through AST parsers', () =>
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

test('issue 1159 preserves JSON browser HTML and CSS contract spellings', () =>
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

test('issue 1159 excludes generated and intentional fixture paths', () =>
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

test('issue 1159 rejects reduced source coverage or specialized governance commands', () =>
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

test('issue 1159 full mode accepts only unchanged baseline debt and strict-full exposes it', () =>
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

test('issue 1159 baseline updates preserve paths and reject violation growth', () =>
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

test('issue 1159 baseline updates reject equal-count violation identity replacement', () =>
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

test('issue 1159 baseline configuration migration requires explicit old-digest authorization', () =>
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

test('issue 1159 baseline records real zero state and candidate source identity', () =>
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

test('issue 1159 baseline removes deleted paths only through reviewed pruning', () =>
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

test('issue 1159 AST fixes are idempotent and diagnostics are locale and CI stable', () =>
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
