import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lifecyclePath = 'config/development/document-lifecycle.json';
const lifecycle = JSON.parse(Read(lifecyclePath));

const migrations = new Map([
    ['docs/issue-1016-public-shell-sticky-geometry-handoff.md', 'docs/frontend/public-shell-ownership.md'],
    ['docs/issue-1017-archive-sticky-offset-handoff.md', 'docs/frontend/public-shell-ownership.md'],
    ['docs/issue-1018-public-typography-handoff.md', 'docs/design/reading-typography.md'],
    ['docs/issue-1019-public-home-editorial-handoff.md', 'docs/public-layout-rules.md'],
    ['docs/issue-1020-content-cover-handoff.md', 'docs/public-layout-rules.md'],
    ['docs/issue-1021-public-chrome-handoff.md', 'docs/frontend/public-shell-ownership.md'],
    ['docs/issue-1285-touch-target-floor.md', 'docs/frontend/public-shell-ownership.md'],
    ['docs/issue-1287-article-title-authority.md', 'docs/design/page-title-scale.md'],
    ['docs/issue-1289-loaded-font-weight-acceptance.md', 'docs/design/reading-typography.md'],
    ['docs/issue-1294-document-markdown-layout.md', 'docs/design/reading-typography.md'],
    ['docs/issue-1306-public-shell-delegation-handoff.md', 'docs/frontend/public-shell-ownership.md'],
    ['docs/issue-1307-public-shell-css-ownership-handoff.md', 'docs/frontend/public-shell-ownership.md']
]);

const currentDocuments = [
    'docs/frontend/public-shell-ownership.md',
    'docs/public-layout-rules.md',
    'docs/design/reading-typography.md',
    'docs/design/page-title-scale.md',
    'docs/frontend/layout-visual-governance.md'
];

function Read(relative)
{
    return fs.readFileSync(path.join(root, relative), 'utf8');
}

function IssueFromPath(relative)
{
    const match = relative.match(/issue-(\d+)/u);
    assert.ok(match, `missing issue number in ${relative}`);
    return Number.parseInt(match[1], 10);
}

test('public and design handoff paths are absorbed without aliases', () =>
{
    for (const [source, target] of migrations)
    {
        assert.equal(fs.existsSync(path.join(root, source)), false, source);
        assert.equal(fs.existsSync(path.join(root, target)), true, target);
    }

    const recorded = new Map(lifecycle.pathMigrations.map((entry) => [entry.from, entry.to]));
    assert.deepEqual([...recorded.entries()].filter(([source]) => migrations.has(source)), [...migrations.entries()]);
    assert.equal(lifecycle.legacyNamingCompatibility.some((entry) => migrations.has(entry.path)), false);
});

test('each absorbed issue has one canonical current target with explicit metadata', () =>
{
    const documents = new Map(lifecycle.documents.map((entry) => [entry.path, entry]));
    for (const [source, target] of migrations)
    {
        const issue = IssueFromPath(source);
        const owners = currentDocuments.filter((document) => documents.get(document)?.relatedIssues?.includes(issue));
        assert.deepEqual(owners, [target], `issue #${issue} must have one canonical target`);
        assert.equal(documents.get(target)?.status, 'current');
        assert.ok(documents.get(target)?.relatedIssues?.includes(1428), `${target} must record #1428`);
    }
});

test('current public and design documents do not depend on retired handoff paths or session notes', () =>
{
    const combined = currentDocuments.map((document) => `${document}\n${Read(document)}`).join('\n');
    for (const source of migrations.keys())
    {
        assert.equal(combined.includes(source), false, source);
    }

    for (const sessionPhrase of [
        '没有执行测试',
        'No test, build',
        'shared workspace',
        'GitHub 写权限',
        '后续线程',
        'unified validation phase'
    ])
    {
        assert.equal(combined.includes(sessionPhrase), false, sessionPhrase);
    }

    assert.doesNotMatch(combined, /allowed to address\s+`el-public-shell/u);
});

test('shell, composition, reading typography and page title rules have distinct authorities', () =>
{
    const sources = new Map(currentDocuments.map((document) => [document, Read(document)]));
    const claims = [
        ['`--fsusblog-public-header-height-current`', 'docs/frontend/public-shell-ownership.md'],
        ['`selectHomeEditorialComposition`', 'docs/public-layout-rules.md'],
        ['`markdown-body--document`', 'docs/design/reading-typography.md'],
        ['唯一 page-title authority', 'docs/design/page-title-scale.md']
    ];

    for (const [claim, authority] of claims)
    {
        const owners = [...sources].filter(([, source]) => source.includes(claim)).map(([document]) => document);
        assert.deepEqual(owners, [authority], `${claim} must have one authority`);
    }
});
