#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const assert = (condition, message) =>
{
    if (!condition)
    {
        throw new Error(message);
    }
};

const routerIndex = read('src/frontend/src/router/index.ts');
const appRoutes = read('src/frontend/src/router/appRouteRecords.ts');
const publicRoutes = read('src/frontend/src/public-renderers/publicRouteRegistry.ts');
const policy = read('src/frontend/src/security/privateNavigationPolicy.ts');
const inbox = read('src/frontend/src/composables/useAccountMessagesInbox.ts');
const users = read('src/frontend/src/composables/useAdminUserManage.ts');
const articles = read('src/frontend/src/composables/useAdminArticleList.ts');
const matrix = read('tests/frontend/unit/router/index.test.ts');

for (const routeState of [
    'public-shareable',
    'private-recoverable',
    'session-sensitive',
    'memory-only'
])
{
    assert(appRoutes.includes(routeState) || publicRoutes.includes(routeState),
        `route metadata is missing ${routeState}`);
}

assert(publicRoutes.includes("routeState: 'public-shareable'"),
    'public route registry must declare shareable URL state');
assert(appRoutes.includes('allowLoginRedirect: routeState ==='),
    'private login recovery must be an explicit route metadata gate');
assert(routerIndex.includes('privateQueryNeedsSanitizing(to.name, to.query)')
  && routerIndex.includes('routeQueryNeedsSanitizing || Boolean(to.hash)'),
'private query and fragments must be sanitized before history commit');
assert(policy.includes("route.meta.routeState !== 'private-recoverable'"),
    'login recovery must fail closed outside private-recoverable routes');
assert(policy.includes('typeof route.name !=='),
    'login recovery must require a named route allowlist entry');
assert(policy.includes('sanitizePrivateRouteQuery(route.name, route.query)'),
    'login recovery must validate the declared per-route query fields');

const policyTable = policy.slice(
    policy.indexOf('const PRIVATE_ROUTE_QUERY_POLICIES'),
    policy.indexOf('export const PRIVATE_NAVIGATION_ALLOWED_FIELDS')
);
for (const forbiddenField of ['keyword:', 'conversation:', 'token:', 'proof:', 'challenge:', 'recovery:', 'mfa:'])
{
    assert(!policyTable.includes(forbiddenField),
        `private URL allowlist must not include ${forbiddenField}`);
}

for (const [source, forbiddenFragments] of [
    [inbox, ['route.query.conversation', 'query.conversation']],
    [users, ['route.query.keyword', 'query.keyword']],
    [articles, ['route.query.keyword', 'query.keyword']]
])
{
    for (const fragment of forbiddenFragments)
    {
        assert(!source.includes(fragment), `memory-only private state leaked through ${fragment}`);
    }
}

for (const expectation of [
    'static URL-state gate',
    'private fragment even when every query field is allowlisted',
    'back and forward history',
    'anonymous memory-only object route'
])
{
    assert(matrix.includes(expectation), `Memory History matrix is missing ${expectation}`);
}

console.log('[check-private-navigation-policy] ok');
