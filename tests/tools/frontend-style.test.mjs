import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    cpSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
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

function fsMode(file)
{
    return statSync(file).mode & 0o777;
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
    writeFixture(
        fixtureRoot,
        sourcePolicy.baselineClassificationSchema,
        readFileSync(path.join(root, sourcePolicy.baselineClassificationSchema), 'utf8')
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

test('frontend style governance accepts only exact residual classifications already present in the remote review authority', () =>
{
    withFixture((fixtureRoot) =>
    {
        const ownerPath = 'tools/legacy/reviewed-owner.mjs';
        const reviewedPath = 'tests/tools/reviewed-owner.test.mjs';
        const classificationPath = 'artifacts/frontend-style/reviewed-baseline-classification.json';
        const git = (args, options = {}) => spawnSync('git', args, {
            cwd: fixtureRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'Frontend Style Fixture',
                GIT_AUTHOR_EMAIL: 'frontend-style@example.invalid',
                GIT_COMMITTER_NAME: 'Frontend Style Fixture',
                GIT_COMMITTER_EMAIL: 'frontend-style@example.invalid'
            },
            ...options
        });
        const expectGit = (args, options = {}) =>
        {
            const result = git(args, options);
            assert.equal(result.status, 0, output(result));
            return result.stdout.trim();
        };
        writeFixture(fixtureRoot, ownerPath, `export function readValue(value)
{
    return value;
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        const baselinePath = path.join(fixtureRoot, sourcePolicy.baseline);
        const baselineBeforeReview = readFileSync(baselinePath, 'utf8');

        writeFixture(fixtureRoot, '.gitignore', '.tmp/\ntools/frontend/style-toolchain\n');
        expectGit(['init', '--initial-branch=master']);
        expectGit(['add', '.']);
        expectGit(['commit', '-m', 'test: establish frontend style fixture baseline']);
        const baselineOwnerCommit = expectGit(['rev-parse', 'HEAD']);
        expectGit(['update-ref', 'refs/remotes/origin/master', baselineOwnerCommit]);

        writeFixture(fixtureRoot, reviewedPath, `import { readValue } from '../../tools/legacy/reviewed-owner.mjs';

export function readOwnerValue(value)
{
    return readValue(value);
}
`);
        expectGit(['add', reviewedPath]);
        expectGit(['commit', '-m', 'test: add reviewed owner import fixture']);
        const sourceOwnerCommit = expectGit(['rev-parse', 'HEAD']);

        const rejected = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.notEqual(rejected.status, 0);
        assert.match(output(rejected), /refusing new frontend style baseline path tests\/tools\/reviewed-owner\.test\.mjs with 1 violations/u);
        const strict = runChecker(fixtureRoot, ['--mode', 'strict-full', '--file', reviewedPath]);
        const diagnosticPattern = new RegExp(`^\\[frontend-style\\] ${reviewedPath.replaceAll('.', '\\.')}:([0-9]+):([0-9]+) eslint/import-x/no-relative-parent-imports: (.+)$`, 'mu');
        const diagnostic = diagnosticPattern.exec(output(strict));
        assert.ok(diagnostic, output(strict));
        const normalizedMessage = diagnostic[3].replace(/\s+/gu, ' ').trim();
        const violationId = `eslint:import-x/no-relative-parent-imports:${reviewedPath}:${diagnostic[1]}:${diagnostic[2]}:${createHash('sha256').update(normalizedMessage).digest('hex').slice(0, 16)}`;
        const sourceSha256 = createHash('sha256')
            .update(readFileSync(path.join(fixtureRoot, reviewedPath)))
            .digest('hex');
        const classification = {
            schema: 'fsusblog.frontend-style-baseline-classification.v1',
            reviewIssue: 999999,
            entries: [{
                path: reviewedPath,
                rejectionKind: 'new-path',
                previousViolationCount: null,
                currentViolationCount: 1,
                currentSourceSha256: sourceSha256,
                currentViolationDigest: createHash('sha256').update(violationId).digest('hex'),
                currentRules: {
                    'eslint/import-x/no-relative-parent-imports': 1
                },
                category: 'owner-module-parent-import',
                sourceOwnerCommit,
                relatedIssues: [999999],
                reason: 'The contract test imports the repository owner that it executes.',
                terminalCondition: 'source-content-change'
            }]
        };
        const writeClassification = (document) => writeFixture(
            fixtureRoot,
            classificationPath,
            `${JSON.stringify(document, null, 4)}\n`
        );
        const runReviewedUpdate = () => runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--reviewed-baseline-classification', classificationPath
        ]);
        writeClassification(classification);
        expectGit(['add', classificationPath]);
        expectGit(['commit', '-m', 'test: self grant reviewed baseline classification']);
        const selfGranted = runReviewedUpdate();
        assert.notEqual(selfGranted.status, 0, output(selfGranted));
        assert.match(output(selfGranted), /classification must already exist unchanged at refs\/remotes\/origin\/master/u);

        expectGit(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
        const accepted = runReviewedUpdate();
        assert.equal(accepted.status, 0, output(accepted));

        const mutations = [
            {
                name: 'missing',
                mutate: (document) => ({ ...document, entries: [] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'extra',
                mutate: (document) => ({ ...document, entries: [...document.entries, { ...document.entries[0], path: ownerPath }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'source digest',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], currentSourceSha256: '0'.repeat(64) }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'violation digest',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], currentViolationDigest: '0'.repeat(64) }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'rules',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], currentRules: { 'eslint/import-x/no-relative-parent-imports': 2 } }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'owner does not touch path',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], sourceOwnerCommit: baselineOwnerCommit }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'wrong category',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], category: 'fixture-retained-symbol' }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'missing review issue',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], relatedIssues: [1] }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'expired terminal condition',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], terminalCondition: 'never' }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            },
            {
                name: 'wildcard path',
                mutate: (document) => ({ ...document, entries: [{ ...document.entries[0], path: 'tests/tools/*.mjs' }] }),
                expected: /classification must already exist unchanged|frontend style source identity/u
            }
        ];
        for (const mutation of mutations)
        {
            writeFileSync(baselinePath, baselineBeforeReview);
            writeClassification(mutation.mutate(structuredClone(classification)));
            const result = runReviewedUpdate();
            assert.notEqual(result.status, 0, `${mutation.name}\n${output(result)}`);
            assert.match(output(result), mutation.expected, mutation.name);
        }

        const tree = expectGit(['rev-parse', 'HEAD^{tree}']);
        const orphanOwner = expectGit(['commit-tree', tree], { input: 'orphan owner\n' });
        writeFileSync(baselinePath, baselineBeforeReview);
        writeClassification({
            ...classification,
            entries: [{ ...classification.entries[0], sourceOwnerCommit: orphanOwner }]
        });
        const reversedOwner = runReviewedUpdate();
        assert.notEqual(reversedOwner.status, 0);
        assert.match(output(reversedOwner), /classification must already exist unchanged|frontend style source identity/u);
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

test('frontend style governance binds installed executables and the plugin parser closure bytes', () =>
{
    withFixture((fixtureRoot) =>
    {
        const isolatedToolchain = path.join(fixtureRoot, 'tools/frontend/style-toolchain');
        rmSync(isolatedToolchain, { force: true });
        cpSync(toolchain, isolatedToolchain, { recursive: true });
        for (const [name, target] of [['eslint', '../eslint/bin/eslint.js'], ['stylelint', '../stylelint/bin/stylelint.mjs']])
        {
            const link = path.join(isolatedToolchain, 'node_modules/.bin', name);
            rmSync(link, { force: true });
            symlinkSync(target, link);
        }
        writeFixture(fixtureRoot, 'tools/sample/toolchain-consumer.mjs', `export function readValue(value)
{
    return value;
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));

        const pluginPath = path.join(isolatedToolchain, 'node_modules/eslint-plugin-import-x/lib/index.js');
        const pluginBefore = readFileSync(pluginPath);
        writeFileSync(pluginPath, Buffer.concat([pluginBefore, Buffer.from('\n// tampered plugin closure\n')]));
        const pluginTamper = runChecker(fixtureRoot, ['--mode', 'full']);
        assert.notEqual(pluginTamper.status, 0);
        assert.match(output(pluginTamper), /baseline configuration digest is stale/u);
        writeFileSync(pluginPath, pluginBefore);

        const eslintPackage = JSON.parse(readFileSync(path.join(isolatedToolchain, 'node_modules/eslint/package.json'), 'utf8'));
        const executablePath = path.join(isolatedToolchain, 'node_modules/eslint/bin/eslint.js');
        const executableMode = fsMode(executablePath);
        writeFileSync(executablePath, `#!/usr/bin/env node
if (process.argv.includes('--version'))
{
    console.log('${eslintPackage.version}');
}
else
{
    console.log('[]');
}
`);
        chmodSync(executablePath, executableMode);
        const emptyStub = runChecker(fixtureRoot, ['--mode', 'full']);
        assert.notEqual(emptyStub.status, 0);
        assert.match(output(emptyStub), /baseline configuration digest is stale/u);
    });
});

test('frontend style governance migrates reviewed semantic paths without admitting new debt', () =>
{
    withFixture((fixtureRoot) =>
    {
        const oldPath = 'tests/tools/issue-1234-path.test.mjs';
        const newPath = 'tests/tools/semantic-path.test.mjs';
        const inventoryPath = 'tests/test-asset-semantic-renames.json';
        writeFixture(fixtureRoot, oldPath, `export function retained_debt(value) {
  return value
}
`);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));

        renameSync(path.join(fixtureRoot, oldPath), path.join(fixtureRoot, newPath));
        writeFixture(fixtureRoot, inventoryPath, `${JSON.stringify({
            schema: 'fsusblog.test-asset-semantic-renames.v1',
            referenceFiles: [],
            renames: [{ from: oldPath, to: newPath }]
        }, null, 4)}\n`);
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
        const rejected = runChecker(fixtureRoot, [
            '--mode', 'full',
            '--update-baseline',
            '--migrate-baseline-paths', inventoryPath
        ]);
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

test('frontend style governance rejects Git flag type link and OID source identity splits', () =>
{
    withFixture((fixtureRoot) =>
    {
        const relativePath = 'tools/sample/git-identity-tool.mjs';
        const original = `export function readValue(value)
{
    return value;
}
`;
        const absolute = path.join(fixtureRoot, relativePath);
        const git = (args) => spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
        const expectGit = (args) =>
        {
            const result = git(args);
            assert.equal(result.status, 0, output(result));
            return result.stdout.trim();
        };
        writeFixture(fixtureRoot, '.gitignore', '.tmp/\ntools/frontend/style-toolchain\n');
        writeFixture(fixtureRoot, relativePath, original);
        const initial = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(initial.status, 0, output(initial));
        expectGit(['init', '--initial-branch=master']);
        expectGit(['add', '.']);
        expectGit(['-c', 'user.name=Frontend Style Fixture', '-c', 'user.email=frontend-style@example.invalid', 'commit', '-m', 'test: establish Git identity fixture']);
        const gitBound = runChecker(fixtureRoot, ['--mode', 'full', '--update-baseline']);
        assert.equal(gitBound.status, 0, output(gitBound));
        expectGit(['add', sourcePolicy.baseline]);
        expectGit(['-c', 'user.name=Frontend Style Fixture', '-c', 'user.email=frontend-style@example.invalid', 'commit', '-m', 'test: bind Git source state']);
        const clean = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath]);
        assert.equal(clean.status, 0, output(clean));

        const expectIdentityFailure = () =>
        {
            const result = runChecker(fixtureRoot, ['--mode', 'full', '--file', relativePath]);
            assert.notEqual(result.status, 0, output(result));
            assert.match(output(result), /frontend style source identity/u);
        };

        expectGit(['update-index', '--assume-unchanged', relativePath]);
        expectIdentityFailure();
        expectGit(['update-index', '--no-assume-unchanged', relativePath]);

        expectGit(['update-index', '--skip-worktree', relativePath]);
        expectIdentityFailure();
        expectGit(['update-index', '--no-skip-worktree', relativePath]);

        writeFileSync(absolute, original.replace('return value;', 'return String(value);'));
        expectIdentityFailure();
        writeFileSync(absolute, original);

        writeFileSync(absolute, original.replace('return value;', 'return Number(value);'));
        expectGit(['add', relativePath]);
        writeFileSync(absolute, original);
        expectIdentityFailure();
        expectGit(['add', relativePath]);

        rmSync(absolute);
        symlinkSync('/dev/null', absolute);
        expectIdentityFailure();
        rmSync(absolute);
        writeFileSync(absolute, original);

        const hardlinkRoot = mkdtempSync(path.join(tmpdir(), 'fsusblog-frontend-style-hardlink-'));
        const hardlinkSource = path.join(hardlinkRoot, 'source.mjs');
        writeFileSync(hardlinkSource, original);
        rmSync(absolute);
        linkSync(hardlinkSource, absolute);
        expectIdentityFailure();
        rmSync(absolute);
        rmSync(hardlinkRoot, { recursive: true, force: true });
        writeFileSync(absolute, original);

        expectGit(['config', 'core.sparseCheckout', 'true']);
        expectIdentityFailure();
        expectGit(['config', 'core.sparseCheckout', 'false']);
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
