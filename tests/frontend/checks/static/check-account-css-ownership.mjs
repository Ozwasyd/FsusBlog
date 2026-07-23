#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

function read(relativePath)
{
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function fail(file, message)
{
    failures.push(`${file}: ${message}`);
}

function expectIncludes(file, source, token, message)
{
    if (!source.includes(token))
    {
        fail(file, message);
    }
}

function expectMatches(file, source, pattern, message)
{
    if (!pattern.test(source))
    {
        fail(file, message);
    }
}

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function expectSelector(file, source, selector, message)
{
    expectMatches(file, source, new RegExp(`${escapeRegExp(selector)}\\s*\\{`, 'u'), message);
}

function expectNotMatches(file, source, pattern, message)
{
    if (pattern.test(source))
    {
        fail(file, message);
    }
}

const basePath = 'src/frontend/src/assets/account-shell-base.css';
const identityPath = 'src/frontend/src/assets/account-identity.css';
const adminPath = 'src/frontend/src/assets/admin-workspace.css';
const legacyPath = 'src/frontend/src/assets/account-shell.css';
const mainPath = 'src/frontend/src/assets/main.css';
const layoutPath = 'src/frontend/src/layouts/AccountLayout.vue';
const routeFramePath = 'src/frontend/src/layouts/AccountRouteFrame.vue';
const identityFramePath = 'src/frontend/src/layouts/AccountIdentityFrame.vue';
const adminFramePath = 'src/frontend/src/layouts/AdminWorkspaceFrame.vue';
const pageKindPath = 'src/frontend/src/layouts/accountPageKind.ts';
const userBanDialogPath = 'src/frontend/src/components/admin/users/UserBanDialog.vue';
const docsPath = 'docs/frontend/account-style-ownership.md';

const base = read(basePath);
const identity = read(identityPath);
const admin = read(adminPath);
const main = read(mainPath);
const layout = read(layoutPath);
const routeFrame = read(routeFramePath);
const identityFrame = read(identityFramePath);
const adminFrame = read(adminFramePath);
const pageKind = read(pageKindPath);
const userBanDialog = read(userBanDialogPath);
const docs = read(docsPath);

if (existsSync(path.join(repoRoot, legacyPath)))
{
    fail(legacyPath, 'monolithic account stylesheet must be removed');
}

for (const importToken of [
    "@import '@/assets/account-shell-base.css';",
    "@import '@/assets/account-identity.css';",
    "@import '@/assets/admin-workspace.css';"
])
{
    expectIncludes(mainPath, main, importToken, `missing production import ${importToken}`);
}
expectNotMatches(mainPath, main, /account-shell\.css/u, 'legacy stylesheet must have no production import');

expectNotMatches(basePath, base, /\.(?:admin-|dashboard-|workbench-|identity-page-shell)/u,
    'base layer must not own identity or admin page composition');
expectNotMatches(identityPath, identity, /\.(?:admin-|dashboard-|workbench-)/u,
    'identity layer must not own admin composition');
expectNotMatches(adminPath, admin, /\.identity-page-shell/u,
    'admin layer must not own identity composition');

for (const [file, source] of [[basePath, base], [identityPath, identity], [adminPath, admin]])
{
    expectNotMatches(file, source, /\.el-[a-z0-9_-]+/u,
        'account ownership files must not rewrite FsusUI internal selectors');
}

for (const token of [
    '.account-route-frame',
    '.account-route-frame__sidebar',
    '.account-frame-outlet',
    '.account-mobile-drawer',
    '.account-mobile-drawer-trigger'
])
{
    expectSelector(basePath, base, token, `shared base layer is missing ${token}`);
}
for (const token of [
    '.account-identity-frame .account-frame-outlet',
    '.account-identity-frame .account-frame-outlet--takeover',
    '.account-identity-frame .identity-page-shell--inbox'
])
{
    expectSelector(identityPath, identity, token, `identity layer is missing ${token}`);
}
for (const token of [
    '.admin-workspace-frame',
    '.admin-workspace-frame .account-frame-outlet',
    '.admin-workspace-frame .admin-data-surface',
    '.admin-workspace-frame .admin-page-shell--settings'
])
{
    expectSelector(adminPath, admin, token, `admin layer is missing ${token}`);
}

expectNotMatches(layoutPath, layout, /<style\b/u,
    'AccountLayout must not retain a fourth account CSS owner');
expectNotMatches(layoutPath, layout, /\.el-[a-z0-9_-]+/u,
    'AccountLayout must not rewrite FsusUI primitive internals');
expectMatches(routeFramePath, routeFrame, /class="account-route-frame"\s+:class="frameClass"/u,
    'shared frame must expose the explicit frame-root hook');
expectIncludes(routeFramePath, routeFrame, 'class="account-frame-outlet"',
    'shared frame must expose the outlet hook');
expectIncludes(identityFramePath, identityFrame, 'frame-class="account-identity-frame"',
    'identity frame root is missing');
expectIncludes(adminFramePath, adminFrame, 'frame-class="admin-workspace-frame"',
    'admin frame root is missing');
expectIncludes(pageKindPath, pageKind, "inbox: 'identity-page-shell identity-page-shell--inbox'",
    'identity inbox page-kind ownership is missing');
expectIncludes(userBanDialogPath, userBanDialog, 'modal-class="admin-workspace-frame"',
    'teleported admin dialog must retain the admin frame root');

for (const token of [
    'Account style ownership',
    '`account-shell-base.css`',
    '`account-identity.css`',
    '`admin-workspace.css`',
    'cannot reach into FsusUI component internals'
])
{
    expectIncludes(docsPath, docs, token, `ownership documentation is missing ${token}`);
}

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[account-css-ownership] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[account-css-ownership] ok');
