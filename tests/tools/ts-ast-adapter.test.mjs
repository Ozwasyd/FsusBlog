import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
    readFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
);
const adapterEntry = path.join(
    repositoryRoot,
    "tools/test-inventory/ts-ast-adapter/index.mjs"
);
const temporaryRoots = [];

function write(root, relativePath, contents)
{
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
}

function runAdapter(root, files)
{
    const requestPath = path.join(root, ".adapter-request.json");
    writeFileSync(requestPath, JSON.stringify({ root, files }));
    const result = spawnSync(process.execPath, [adapterEntry, requestPath], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

test.after(() =>
{
    for (const root of temporaryRoots)
    {
        rmSync(root, { recursive: true, force: true });
    }
});

test("vitest adapter extracts named, aliased and namespace registrations with suite hierarchy", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-vitest-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "tests/frontend/unit/vitest-mixed.test.ts",
        `
import { describe, it, test, expect } from 'vitest'
import { test as aliasedTest } from 'vitest'
import * as v from 'vitest'
import { login } from '../../../src/backend/auth'
import { createTestHelper } from '../../../support/test-helper'

describe('outer', () => {
  beforeEach(() => {})
  it('works', () => { expect(1).toBe(1) })
  test.skip('skipped case', () => {})
  test.only('only case', () => {})
  test.todo('todo case')
  test.fails('failing expectation', () => { throw new Error('x') })
  test.each([[1, 2], [3, 4]])('add %d + %d', (a, b) => { expect(a + b).toBe(a + b) })
  const rows = [[5, 6]]
  test.each(rows)('dynamic rows', () => {})
  test('duplicate title', () => {})
  test('duplicate title', () => {})
})
v.test('namespace case', () => {})
aliasedTest('alias case', () => {})
test('classifies symbols', () => { login('user'); createTestHelper(); expect(login).toBeDefined() })
`
    );
    const report = runAdapter(root, [
        { path: "tests/frontend/unit/vitest-mixed.test.ts", adapter: "vitest" }
    ]);
    assert.equal(
        report.diagnostics.length,
        0,
        JSON.stringify(report.diagnostics)
    );
    const cases = report.testCases;
    const byName = new Map(cases.map((entry) => [entry.displayName, entry]));
    assert.equal(cases.length, 13);
    assert.ok(byName.has("works"));
    assert.ok(byName.has("skipped case"));
    assert.equal(byName.get("skipped case").skipReason, "skip");
    assert.ok(
        byName.get("only case").traits.some((trait) => trait.name === "Only")
    );
    assert.ok(
        byName.get("todo case").traits.some((trait) => trait.name === "Todo")
    );
    assert.ok(
        byName
            .get("failing expectation")
            .traits.some((trait) => trait.name === "Fails")
    );
    const rows = cases.filter((entry) => entry.displayName.startsWith("add "));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((entry) => entry.displayName),
        ["add 1 + 2", "add 3 + 4"]
    );
    assert.ok(rows.every((entry) => entry.kind === "theory"));
    const dynamic = cases.find((entry) => entry.displayName === "dynamic rows");
    assert.equal(dynamic.identity, "dynamic");
    assert.equal(
        dynamic.dynamicCaseInfo.generationLocation.startsWith(
            "tests/frontend/unit/vitest-mixed.test.ts:"
        ),
        true
    );
    const duplicates = cases.filter(
        (entry) => entry.displayName === "duplicate title"
    );
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0].id, duplicates[1].id);
    assert.ok(byName.get("namespace case").adapter === "vitest");
    assert.ok(byName.get("alias case").adapter === "vitest");
    const works = byName.get("works");
    assert.equal(works.ownerSuite, "outer");
    assert.ok(
        works.methodFacts.assertionCandidates.some(
            (entry) => entry.methodName === "toBe"
        )
    );
    const symbols = byName.get("classifies symbols");
    assert.ok(
        symbols.methodFacts.invocations.some(
            (entry) =>
                entry.methodName === "login" &&
                entry.assemblyKind === "production"
        )
    );
    assert.ok(
        symbols.methodFacts.invocations.some(
            (entry) =>
                entry.methodName === "createTestHelper" &&
                entry.assemblyKind === "test"
        )
    );
    const suites = report.suiteRecords.filter(
        (entry) => entry.suitePath === "outer"
    );
    assert.equal(suites.length, 1);
    assert.ok(suites[0].hooks.some((hook) => hook.name === "beforeEach"));
});

test("node:test adapter supports default import, describe/it, options and skip/todo", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-nodetest-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "tests/tools/node-test-basic.test.mjs",
        `
import test from 'node:test'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('suite', () => {
  it('case one', () => { assert.equal(1, 1) })
  it('case two', { skip: true }, () => {})
  it('case three', { timeout: 500 }, () => {})
})
test('top level', () => { assert.ok(true) })
`
    );
    const report = runAdapter(root, [
        { path: "tests/tools/node-test-basic.test.mjs", adapter: "node-test" }
    ]);
    assert.equal(report.diagnostics.length, 0);
    const cases = report.testCases;
    assert.equal(cases.length, 4);
    const byName = new Map(cases.map((entry) => [entry.displayName, entry]));
    assert.ok(byName.get("case one").ownerSuite === "suite");
    assert.equal(byName.get("case two").skipReason, "skip");
    assert.equal(byName.get("case three").timeoutMs, 500);
    assert.ok(byName.get("top level").ownerSuite === undefined);
    assert.ok(
        byName
            .get("case one")
            .methodFacts.assertionCandidates.some(
                (entry) => entry.methodName === "equal"
            )
    );
    assert.ok(report.suiteRecords.some((entry) => entry.suitePath === "suite"));
});

test("vitest object rows preserve named identity and resolve aliased production imports", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-object-rows-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "src/frontend/src/utils/errors.ts",
        `
export function isAbortError(value: unknown): boolean {
    return Boolean(value);
}
`
    );
    write(
        root,
        "tests/frontend/unit/errors.test.ts",
        `
import { test, expect } from 'vitest';
import { isAbortError } from '@/utils/errors';

test.each([
    { caseName: 'abort-error', expected: true },
    { caseName: 'regular-error', expected: false }
])('$caseName', ({ expected }) => {
    expect(isAbortError(expected)).toBe(expected);
});
`
    );
    const report = runAdapter(root, [
        { path: "tests/frontend/unit/errors.test.ts", adapter: "vitest" }
    ]);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.testCases.length, 2);
    assert.deepEqual(
        report.testCases.map((entry) => entry.displayName),
        ["abort-error", "regular-error"]
    );
    assert.equal(new Set(report.testCases.map((entry) => entry.id)).size, 2);
    assert.ok(report.testCases.every((entry) => entry.identity === "static"));
    assert.deepEqual(
        report.testCases.map(
            (entry) =>
                entry.traits.find((trait) => trait.name === "DataRow")?.value
        ),
        ["abort-error", "regular-error"]
    );
    assert.ok(
        report.testCases.every((entry) =>
            entry.methodFacts.productionSymbolReferences.some(
                (reference) =>
                    reference.methodName === "isAbortError" &&
                    reference.assembly === "src/frontend/src/utils/errors.ts" &&
                    reference.assemblyKind === "production"
            )
        )
    );
});

test("vitest facts follow local helper calls to production owners", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-helper-closure-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "src/frontend/src/utils/errors.ts",
        `
export function isAbortError(value: unknown): boolean {
    return Boolean(value);
}
`
    );
    write(
        root,
        "tests/frontend/unit/errors-helper.test.ts",
        `
import { test, expect } from 'vitest';
import { isAbortError } from '@/utils/errors';

function invokeProduction(value: unknown): boolean {
    return isAbortError(value);
}

test('helper closure retains production ownership', () => {
    expect(invokeProduction(null)).toBe(false);
});
`
    );
    const report = runAdapter(root, [
        {
            path: "tests/frontend/unit/errors-helper.test.ts",
            adapter: "vitest"
        }
    ]);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.testCases.length, 1);
    const facts = report.testCases[0].methodFacts;
    assert.ok(
        facts.invocations.some(
            (invocation) => invocation.methodName === "invokeProduction"
        )
    );
    assert.ok(
        facts.productionSymbolReferences.some(
            (reference) =>
                reference.methodName === "isAbortError" &&
                reference.assembly === "src/frontend/src/utils/errors.ts" &&
                reference.assemblyKind === "production"
        )
    );
});

test("native helper and nested callback returns do not hide actual test callback exits", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-return-owner-")
    );
    temporaryRoots.push(root);
    const file = "tests/tools/return-owner.test.mjs";
    write(
        root,
        file,
        `
import test from 'node:test';
import assert from 'node:assert/strict';

function fixture() {
    const values = [1].map(value => { return value; });
    return { values };
}

test('helper return continues in its caller', () => {
    const result = fixture();
    assert.equal(result.values[0], 1);
});

test('nested callback return continues in its caller', () => {
    const values = [1].map(value => { return value; });
    assert.equal(values[0], 1);
});

test('real callback early return remains visible', () => {
    const result = fixture();
    if (result.values.length === 0) { return; }
    assert.equal(result.values[0], 1);
});
`
    );
    const report = runAdapter(root, [{ path: file, adapter: "node-test" }]);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.testCases.length, 3);
    const cases = new Map(
        report.testCases.map((entry) => [entry.displayName, entry.methodFacts])
    );
    assert.deepEqual(
        cases.get("helper return continues in its caller").returnStatements,
        []
    );
    assert.deepEqual(
        cases.get("nested callback return continues in its caller")
            .returnStatements,
        []
    );
    assert.deepEqual(
        cases.get("real callback early return remains visible")
            .returnStatements,
        ["return;"]
    );
    assert.ok(
        cases
            .get("helper return continues in its caller")
            .invocations.some((call) => call.methodName === "fixture")
    );
    assert.ok(
        [...cases.values()].every((facts) =>
            facts.assertionCandidates.some(
                (assertion) => assertion.methodName === "equal"
            )
        )
    );
});

const nativeClosedTableFixture = `
import test from 'node:test';
import assert from 'node:assert/strict';
for (const row of Object.freeze([
    Object.freeze({ caseName: 'input-tree', authorityId: 'input', expectedErrors: Object.freeze(['stale']), unexpectedReasons: Object.freeze(['unknown']) }),
    Object.freeze({ caseName: 'checker-source', authorityId: 'checker', expectedErrors: Object.freeze(['stale']), unexpectedReasons: Object.freeze([]) }),
    Object.freeze({ caseName: 'parser-toolchain', authorityId: 'parser', expectedErrors: Object.freeze(['stale']), unexpectedReasons: Object.freeze([]) })
])) {
    test(\`invalidation \${row.caseName} / \${row.authorityId}\`, () => {
        assert.ok(row.caseName);
        assert.ok(row.authorityId);
        for (const reason of row.expectedErrors) assert.equal(reason, 'stale');
        for (const reason of row.unexpectedReasons) assert.notEqual(reason, 'stale');
    });
}
`;

test("native immutable closed table has exact runtime and static row identities", () =>
{
    const root = mkdtempSync(path.join(tmpdir(), "fsusblog-native-table-"));
    temporaryRoots.push(root);
    const file = "native-table.test.mjs";
    write(root, file, nativeClosedTableFixture);
    const report = runAdapter(root, [{ path: file, adapter: "node-test" }]);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.testCases.length, 3);
    assert.equal(new Set(report.testCases.map((entry) => entry.id)).size, 3);
    assert.ok(
        report.testCases.every(
            (entry) =>
                entry.identity === "static" &&
                entry.bodySource.includes("row.authorityId")
        )
    );
    const ordered = [...report.testCases].sort(
        (a, b) =>
            Number(a.traits.find((t) => t.name === "DataRow").value) -
            Number(b.traits.find((t) => t.name === "DataRow").value)
    );
    assert.deepEqual(
        ordered.map((entry) => entry.displayName),
        [
            "invalidation input-tree / input",
            "invalidation checker-source / checker",
            "invalidation parser-toolchain / parser"
        ]
    );
    const runtimeEnvironment = { ...process.env };
    delete runtimeEnvironment.NODE_TEST_CONTEXT;
    const runtime = spawnSync(
        process.execPath,
        ["--test", "--test-reporter=tap", file],
        { cwd: root, encoding: "utf8", env: runtimeEnvironment }
    );
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
    const executed = [...runtime.stdout.matchAll(/^# Subtest: (.+)$/gmu)].map(
        (match) => match[1]
    );
    assert.deepEqual(
        executed,
        ordered.map((entry) => entry.displayName)
    );
    assert.match(runtime.stdout, /# tests 3\b/u);
    assert.deepEqual(
        runAdapter(root, [{ path: file, adapter: "node-test" }]),
        report
    );
    write(
        root,
        file,
        nativeClosedTableFixture.replace(
            "caseName: 'checker-source', authorityId: 'checker'",
            "caseName: 'input-tree', authorityId: 'input'"
        )
    );
    const duplicate = runAdapter(root, [{ path: file, adapter: "node-test" }]);
    assert.ok(
        duplicate.diagnostics.some(
            (entry) => entry.code === "native-table-not-closed"
        )
    );
    assert.ok(
        duplicate.testCases.every((entry) => entry.identity === "dynamic")
    );
});

test("native tables fail closed for unknown mutable escaped shadowed and unsupported registration", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-native-table-negative-")
    );
    temporaryRoots.push(root);
    const variants = [
        nativeClosedTableFixture.replace("for (const row", "for (let row"),
        nativeClosedTableFixture.replace("Object.freeze([", "Object.freeze([,"),
        nativeClosedTableFixture.replace(
            "caseName: 'input-tree'",
            "caseName: unknown"
        ),
        nativeClosedTableFixture.replace("caseName: 'input-tree',", ""),
        nativeClosedTableFixture.replace("Object.freeze([", "Array.from(["),
        nativeClosedTableFixture.replace(
            "Object.freeze(['stale'])",
            "['stale']"
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            'row.caseName = "changed";'
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            "row = {};"
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            '(row.caseName) = "changed";'
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            'row.expectedErrors.push("changed");'
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            "escape(row);"
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            "escape(row.expectedErrors);"
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            "const row = {};"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; const Object = custom;"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; Object.freeze = custom;"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; globalThis.Object.freeze = custom;"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; Array.prototype[Symbol.iterator] = custom;"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; escape(Array.prototype);"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; escape([].__proto__);"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; escape([]['constructor']);"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; Object.hasOwn = custom;"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; escape(Object.hasOwn);"
        ),
        nativeClosedTableFixture.replace(
            "import assert from 'node:assert/strict';",
            "import assert from 'node:assert/strict'; assert.deepEqual = custom;"
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            "const test = custom;"
        ),
        nativeClosedTableFixture.replace(
            "for (const row",
            "function register() { for (const row"
        ) + "\n}",
        nativeClosedTableFixture.replace(
            "test(`invalidation ${row.caseName} / ${row.authorityId}`, () => {",
            'test("constant", () => {'
        ),
        nativeClosedTableFixture.replace(
            "assert.ok(row.caseName);",
            'test("nested", () => {});'
        )
    ];
    for (const [index, source] of variants.entries())
    {
        const file = `negative-${index}.mjs`;
        write(root, file, source);
        const report = runAdapter(root, [{ path: file, adapter: "node-test" }]);
        assert.ok(
            report.diagnostics.some(
                (entry) => entry.code === "native-table-not-closed"
            ),
            `variant ${index}`
        );
        assert.ok(
            report.testCases.length > 0 &&
                report.testCases.every((entry) => entry.identity === "dynamic"),
            `variant ${index}`
        );
    }
    write(
        root,
        "unrelated.mjs",
        "import test from 'node:test'; for (const item of [1, 2]) { console.log(item); } test('ordinary', () => {});"
    );
    const unrelated = runAdapter(root, [
        { path: "unrelated.mjs", adapter: "node-test" }
    ]);
    assert.deepEqual(unrelated.diagnostics, []);
    assert.deepEqual(
        unrelated.testCases.map((entry) => entry.displayName),
        ["ordinary"]
    );
});

test("native table preserves actual governance receipt surrounding oracles and ten runtime cases", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-native-governance-")
    );
    temporaryRoots.push(root);
    const current = readFileSync(
        path.join(
            repositoryRoot,
            "tests/tools/repository-governance-authority.test.mjs"
        ),
        "utf8"
    );
    const start = current.indexOf("for (const mutationCase of Object.freeze([");
    const end = current.indexOf(
        "test('tampered rule IDs or command-output digests"
    );
    assert.ok(start > 0 && end > start);
    const table = String.raw`
for (const mutationCase of Object.freeze([
    Object.freeze({
        caseName: 'input-tree', authorityId: 'test-asset-governance',
        targetPath: 'inputs/authority-1.txt', replacementContent: 'changed test asset\n',
        expectedReason: 'input tree digest mismatch',
        expectedErrors: Object.freeze(['input tree digest mismatch', 'source worktree fingerprint mismatch']),
        unexpectedReasons: Object.freeze(['checker source digest mismatch', 'parser/toolchain identity mismatch'])
    }),
    Object.freeze({
        caseName: 'checker-source', authorityId: 'community-governance',
        targetPath: 'checkers/authority-4.mjs', replacementContent: 'console.log("changed checker")\n',
        expectedReason: 'checker source digest mismatch',
        expectedErrors: Object.freeze(['input tree digest mismatch', 'checker source digest mismatch', 'source worktree fingerprint mismatch']),
        unexpectedReasons: Object.freeze(['parser/toolchain identity mismatch'])
    }),
    Object.freeze({
        caseName: 'parser-toolchain', authorityId: 'document-governance',
        targetPath: 'toolchains/authority-3.json', replacementContent: '{"parser":99}\n',
        expectedReason: 'parser/toolchain identity mismatch',
        expectedErrors: Object.freeze(['input tree digest mismatch', 'parser/toolchain identity mismatch', 'source worktree fingerprint mismatch']),
        unexpectedReasons: Object.freeze(['checker source digest mismatch'])
    })
])) {
    test(\`governance receipt identity invalidation \${mutationCase.caseName}:\${mutationCase.authorityId}\`, async (context) => {
        const { root, manifest } = fixture();
        assert.equal(receiptInvalidationFixtureRoots.has(root), false);
        receiptInvalidationFixtureRoots.add(root);
        context.after(() => {
            fs.rmSync(root, { recursive: true, force: true });
            assert.equal(fs.existsSync(root), false);
        });
        const receipt = await createGovernanceReceipt({ root, manifest, authorityId: mutationCase.authorityId, write: false });
        const beforeMutation = await verifyGovernanceReceipt({ root, manifest, authorityId: mutationCase.authorityId, receipt });
        assert.deepEqual(beforeMutation, { valid: true, errors: [] });
        write(root, mutationCase.targetPath, mutationCase.replacementContent);
        const afterMutation = await verifyGovernanceReceipt({ root, manifest, authorityId: mutationCase.authorityId, receipt });
        assert.equal(afterMutation.valid, false);
        assert.ok(afterMutation.errors.includes(mutationCase.expectedReason),
            \`\${mutationCase.caseName} did not report \${mutationCase.expectedReason}: \${afterMutation.errors.join('; ')}\`);
        assert.deepEqual(afterMutation.errors, mutationCase.expectedErrors);
        for (const unexpectedReason of mutationCase.unexpectedReasons) {
            assert.equal(afterMutation.errors.includes(unexpectedReason), false);
        }
    });
}
`
        .replaceAll("\\`", "`")
        .replaceAll("\\${", "${");
    const source = (
        current.slice(0, start) +
        table +
        current.slice(end)
    ).replace(
        "const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');",
        `const repositoryRoot = ${JSON.stringify(repositoryRoot)};`
    );
    assert.ok(
        source.includes("manifest.authorities[1].commands[0].checkerSources")
    );
    assert.ok(source.includes("outputTamper.outputs[0].stdoutDigest"));
    assert.equal([...source.matchAll(/Object\.hasOwn\(receipt,/gu)].length, 3);
    assert.ok(
        source.endsWith(current.slice(end)),
        "all later governance oracles remain byte-identical"
    );
    const file = "governance-native.test.mjs";
    write(root, file, source);
    const report = runAdapter(root, [{ path: file, adapter: "node-test" }]);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.testCases.length, 10);
    assert.ok(report.testCases.every((entry) => entry.identity === "static"));
    const environment = { ...process.env, TMPDIR: root };
    delete environment.NODE_TEST_CONTEXT;
    const runtime = spawnSync(
        process.execPath,
        ["--test", "--test-reporter=tap", file],
        {
            cwd: root,
            env: environment,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        }
    );
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
    const titles = [...runtime.stdout.matchAll(/^# Subtest: (.+)$/gmu)].map(
        (match) => match[1]
    );
    assert.deepEqual(
        titles.toSorted(),
        report.testCases.map((entry) => entry.displayName).toSorted()
    );
    assert.match(runtime.stdout, /# tests 10\b/u);
});

test("playwright adapter extracts fixtures, describe, use annotations and skip", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-playwright-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "tests/frontend/e2e/playwright.spec.ts",
        `
import { test, expect } from '@playwright/test'
test.use({ baseURL: 'http://localhost' })
test.describe('browser suite', () => {
  test('has title', async ({ page }) => { await expect(page).toHaveTitle(/x/) })
  test.skip('skipped browser', async ({ page }) => {})
})
`
    );
    const report = runAdapter(root, [
        {
            path: "tests/frontend/e2e/playwright.spec.ts",
            adapter: "playwright"
        }
    ]);
    assert.equal(report.diagnostics.length, 0);
    const cases = report.testCases;
    assert.equal(cases.length, 2);
    const byName = new Map(cases.map((entry) => [entry.displayName, entry]));
    assert.equal(byName.get("has title").fixture, "page");
    assert.ok(
        byName.get("has title").traits.some((trait) => trait.name === "Async")
    );
    assert.equal(byName.get("skipped browser").skipReason, "skip");
    assert.equal(byName.get("has title").ownerSuite, "browser suite");
    assert.ok(
        report.suiteRecords.some((entry) => entry.suitePath === "<root>")
    );
    assert.ok(
        report.suiteRecords
            .find((entry) => entry.suitePath === "<root>")
            .traits.some((trait) => trait.name === "ProjectAnnotation")
    );
    assert.ok(
        report.suiteRecords.some(
            (entry) => entry.suitePath === "browser suite"
        )
    );
});

test("behaviorTest registration is extracted with behavior identity traits", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-behavior-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "tests/tools/behavior-binding.test.mjs",
        `
import test from 'node:test'
import { behaviorTest } from '../../tools/contracts/behavior-test.mjs'
behaviorTest('behavior-1', 'positive', 'behavior title', () => {})
`
    );
    const report = runAdapter(root, [
        { path: "tests/tools/behavior-binding.test.mjs", adapter: "node-test" }
    ]);
    assert.equal(report.diagnostics.length, 0);
    assert.equal(report.testCases.length, 1);
    const entry = report.testCases[0];
    assert.equal(entry.kind, "behavior-test");
    assert.equal(entry.displayName, "behavior title");
    assert.ok(
        entry.traits.some(
            (trait) =>
                trait.name === "BehaviorId" && trait.value === "behavior-1"
        )
    );
    assert.ok(
        entry.traits.some(
            (trait) =>
                trait.name === "BehaviorKind" && trait.value === "positive"
        )
    );
});

test("local same-name non-test function is not misdetected as a test", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-shadow-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "tests/tools/local-test-fn.test.mjs",
        `
function test() { return 1 }
function it() { return 2 }
test()
it()
`
    );
    const report = runAdapter(root, [
        { path: "tests/tools/local-test-fn.test.mjs", adapter: "vitest" }
    ]);
    assert.equal(report.testCases.length, 0);
    assert.equal(report.diagnostics.length, 0);
});

test("syntax errors fail closed with a precise file location", () =>
{
    const root = mkdtempSync(path.join(tmpdir(), "fsusblog-ts-adapter-parse-"));
    temporaryRoots.push(root);
    write(root, "tests/tools/broken.test.ts", "test('unclosed', () => {\n");
    const report = runAdapter(root, [
        { path: "tests/tools/broken.test.ts", adapter: "vitest" }
    ]);
    assert.equal(report.testCases.length, 0);
    assert.ok(
        report.diagnostics.some(
            (entry) =>
                entry.severity === "error" &&
                entry.code === "ts-parse-error" &&
                entry.file === "tests/tools/broken.test.ts"
        )
    );
});

test("identical inputs produce byte-stable adapter reports", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-determinism-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "tests/frontend/unit/stable.test.ts",
        `
import { test, expect } from 'vitest'
test('stable case', () => { expect(1).toBe(1) })
`
    );
    const files = [
        { path: "tests/frontend/unit/stable.test.ts", adapter: "vitest" }
    ];
    const first = runAdapter(root, files);
    const second = runAdapter(root, files);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.testCases.length, 1);
    assert.ok(
        first.testCases[0].id.startsWith(
            "vitest:tests/frontend/unit/stable.test.ts#"
        )
    );
});

test("raw string and template titles never create false cases", () =>
{
    const root = mkdtempSync(
        path.join(tmpdir(), "fsusblog-ts-adapter-template-")
    );
    temporaryRoots.push(root);
    write(
        root,
        "tests/tools/template.test.mjs",
        `
import test from 'node:test'
const prefix = 'dynamic'
test(\`literal \${prefix} title\`, () => {})
`
    );
    const report = runAdapter(root, [
        { path: "tests/tools/template.test.mjs", adapter: "node-test" }
    ]);
    assert.equal(report.testCases.length, 1);
    const entry = report.testCases[0];
    assert.equal(entry.displayName, "literal ${prefix} title");
    assert.equal(entry.identity, "dynamic");
    assert.ok(entry.dynamicCaseInfo);
    assert.equal(
        entry.dynamicCaseInfo.generationLocation.startsWith(
            "tests/tools/template.test.mjs:"
        ),
        true
    );
});
