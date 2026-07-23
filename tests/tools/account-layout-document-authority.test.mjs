import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/development/document-lifecycle.json'), 'utf8'));

const migrations = new Map([
    ['docs/issue-1022-admin-dashboard-handoff.md', 'docs/frontend/admin-dashboard-workbench.md'],
    ['docs/issue-1023-admin-ia-handoff.md', 'docs/frontend/admin-information-architecture.md'],
    ['docs/issue-1291-account-page-title-hierarchy.md', 'docs/frontend/account-navigation.md'],
    ['docs/issue-1292-account-navigation-hierarchy.md', 'docs/frontend/account-navigation.md'],
    ['docs/issue-1293-account-integer-typography.md', 'docs/frontend/account-style-ownership.md'],
    ['docs/issue-1309-account-frame-handoff.md', 'docs/frontend/account-layout-ownership.md'],
    ['docs/issue-1310-account-css-ownership-handoff.md', 'docs/frontend/account-style-ownership.md'],
    ['docs/issue-1311-account-header-actions.md', 'docs/frontend/account-navigation.md'],
    ['docs/issue-1312-account-route-motion-handoff.md', 'docs/frontend/account-motion.md']
]);

const authorities = new Map([
    ['frontend-account-layout-ownership', 'docs/frontend/account-layout-ownership.md'],
    ['frontend-account-navigation', 'docs/frontend/account-navigation.md'],
    ['frontend-account-style-ownership', 'docs/frontend/account-style-ownership.md'],
    ['frontend-account-motion', 'docs/frontend/account-motion.md'],
    ['frontend-admin-dashboard-workbench', 'docs/frontend/admin-dashboard-workbench.md'],
    ['frontend-admin-information-architecture', 'docs/frontend/admin-information-architecture.md']
]);

function Read(relativePath)
{
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('account and admin implementation records are removed with explicit canonical migrations', () =>
{
    const registeredMigrations = new Map(policy.pathMigrations.map(({ from, to }) => [from, to]));

    for (const [from, to] of migrations)
    {
        assert.equal(fs.existsSync(path.join(root, from)), false, `${from} must be removed`);
        assert.equal(registeredMigrations.get(from), to, `${from} migration target`);
        assert.equal(fs.existsSync(path.join(root, to)), true, `${to} must exist`);
        assert.equal(policy.documents.some(({ path: documentPath }) => documentPath === from), false);
        assert.equal(policy.legacyNamingCompatibility.some(({ path: documentPath }) => documentPath === from), false);
    }
});

test('frame, navigation, CSS, motion and dashboard IA have one current authority each', () =>
{
    for (const [id, expectedPath] of authorities)
    {
        const claims = policy.authorityClaims.filter((claim) => claim.id === id);
        assert.deepEqual(claims, [{ id, path: expectedPath }]);

        const metadata = policy.documents.find(({ path: documentPath }) => documentPath === expectedPath);
        assert.equal(metadata?.status, 'current');
        assert.equal(metadata?.owner, 'frontend');
        assert.equal(metadata?.relatedIssues.includes(1429), true);
    }
});

test('current account authorities keep identity and admin responsibilities separate', () =>
{
    const layout = Read('docs/frontend/account-layout-ownership.md');
    const navigation = Read('docs/frontend/account-navigation.md');
    const style = Read('docs/frontend/account-style-ownership.md');
    const motion = Read('docs/frontend/account-motion.md');

    assert.match(layout, /AccountIdentityFrame\.vue[\s\S]*AdminWorkspaceFrame\.vue/u);
    assert.match(layout, /accountPageKind[\s\S]*accountContentMode/u);
    assert.match(navigation, /self-service surface[\s\S]*admin surface/u);
    assert.match(style, /account-shell-base\.css[\s\S]*account-identity\.css[\s\S]*admin-workspace\.css/u);
    assert.match(motion, /identity settings[\s\S]*every admin page kind[\s\S]*reduced motion/u);

    for (const source of [layout, navigation, style, motion])
    {
        assert.doesNotMatch(source, /No test, build|validation remains|shared file|concurrent|local Playwright fixture/u);
    }
});

test('broader frontend guides link to account authorities instead of duplicating their contracts', () =>
{
    const publicLayout = Read('docs/public-layout-rules.md');
    const taskGeometry = Read('docs/design/task-surface-geometry.md');
    const motionGuidelines = Read('docs/frontend/motion-guidelines.md');

    assert.match(publicLayout, /Account layout ownership[\s\S]*Account navigation[\s\S]*Account style ownership[\s\S]*Account motion/u);
    assert.doesNotMatch(publicLayout, /### Account route composition metadata|由 #1309 处理/u);
    assert.match(taskGeometry, /Account style ownership/u);
    assert.doesNotMatch(taskGeometry, /\| `account-shell-base\.css` \|/u);
    assert.match(motionGuidelines, /\[Account motion\]\(account-motion\.md\)/u);
    assert.doesNotMatch(motionGuidelines, /identity settings alone may use/u);
});

test('current documents do not depend on removed handoff paths', () =>
{
    const migrationRecord = 'docs/frontend/account-layout-ownership.md';
    const currentDocuments = policy.documents.filter(({ status }) => status === 'current');

    for (const { path: documentPath } of currentDocuments)
    {
        if (!documentPath.endsWith('.md') || documentPath === migrationRecord)
        {
            continue;
        }

        const source = Read(documentPath);
        for (const oldPath of migrations.keys())
        {
            assert.equal(source.includes(oldPath), false, `${documentPath} references ${oldPath}`);
        }
    }
});
