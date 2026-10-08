#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadCompositionInputs } from '@fsusblog/layout-governance/composition-contracts';
import { createLayoutAggregationPlan } from '@fsusblog/layout-governance/layout-aggregation';

import { checkLayoutComposition } from './check-layout-composition.mjs';

const root = process.cwd();
const srcDir = join(root, 'src');
const viewsDir = join(srcDir, 'views');
const componentsDir = join(srcDir, 'components');
const componentFacingDirs = [
    componentsDir,
    join(srcDir, 'ui-tokens'),
    join(srcDir, 'ui-contracts'),
    join(srcDir, 'view-contracts')
];
const strictMode = process.env.FSUSBLOG_STRICT_VIEWS === '1';

function walkVueFiles(dir, output = [])
{
    for (const entry of readdirSync(dir))
    {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory())
        {
            walkVueFiles(full, output);
            continue;
        }
        if (full.endsWith('.vue'))
        {
            output.push(full);
        }
    }
    return output;
}

const vueFiles = walkVueFiles(srcDir);
function walkSourceFiles(dir, output = [])
{
    for (const entry of readdirSync(dir))
    {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory())
        {
            walkSourceFiles(full, output);
            continue;
        }
        if (/\.(vue|ts)$/.test(full))
        {
            output.push(full);
        }
    }
    return output;
}

const componentFacingFiles = Array.from(new Set(componentFacingDirs.flatMap((dir) => walkSourceFiles(dir))));
const hardViolations = [];
const softViolations = [];
try
{
    const composition = checkLayoutComposition(resolve(root, '../..'));
    hardViolations.push(...composition.errors.map((error) => `composition ${error.archetype ?? 'router'}: ${error.reason} ${error.file ?? error.path ?? ''}`));
}
catch (error)
{
    hardViolations.push(`composition: ${error.message}`);
}

const legacyComponentApiPatterns = [
    { pattern: /:contract\s*=/, label: 'legacy :contract component API' },
    { pattern: /\bextra-class\s*=/, label: 'legacy extra-class prop' },
    { pattern: /\bextraClass\b/, label: 'legacy extraClass prop' },
    { pattern: /\b(ButtonContract|TagContract|EmptyStateContract)\b/, label: 'legacy UI contract type' }
];

const forbiddenDesignPatterns = [
    { pattern: /\b(?:text|bg|border|hover:text|hover:bg|focus:ring|focus-visible:ring)-blue-\d+\b/, label: 'Tailwind blue token outside design.md palette' },
    { pattern: /\bprose-zinc\b/, label: 'prose-zinc bypasses Ink/Paper typography' },
    { pattern: /\bshadow-2xl\b/, label: 'shadow-2xl is too heavy for component surfaces' },
    { pattern: /\btracking-(?:widest|wider|wide|\[[^\]]+\])\b/, label: 'over-wide letter spacing' }
];

function relative(file)
{
    return file.replace(`${root}/`, '');
}

function lineNumber(source, index)
{
    return source.slice(0, index).split('\n').length;
}

function collectClassTokens(source)
{
    const tokens = [];
    const classAttrRegex = /\bclass\s*=\s*(["'`])([\s\S]*?)\1/g;
    let match;
    while ((match = classAttrRegex.exec(source)) !== null)
    {
        const body = match[2] ?? '';
        const baseLine = lineNumber(source, match.index);
        for (const token of body.split(/\s+/).map((value) => value.trim()).filter(Boolean))
        {
            tokens.push({ token, line: baseLine });
        }
    }
    return tokens;
}

function tokenHasBreakpoint(token)
{
    return /^(xs|sm|md|lg|xl|2xl|3xl):/.test(token);
}

function parseArbitrarySize(token, prefix)
{
    const escapedPrefix = prefix.replace('-', '\\-');
    const match = token.match(new RegExp(`(?:^|:)${escapedPrefix}-\\[([0-9.]+)(px|rem)\\]`));
    if (!match)
    {
        return null;
    }
    return { value: Number(match[1]), unit: match[2] };
}

function checkComponentFacingSource(source, fileLabel)
{
    for (const { pattern, label } of legacyComponentApiPatterns)
    {
        const match = source.match(pattern);
        if (match?.index !== undefined)
        {
            hardViolations.push(`${fileLabel}:${lineNumber(source, match.index)}: ${label} is forbidden in component-facing files`);
        }
    }

    for (const { pattern, label } of forbiddenDesignPatterns)
    {
        const match = source.match(pattern);
        if (match?.index !== undefined)
        {
            hardViolations.push(`${fileLabel}:${lineNumber(source, match.index)}: ${label}`);
        }
    }
}

function collectWithDefaultsDefinePropsBlocks(source)
{
    const blocks = [];
    const needle = 'withDefaults';
    let searchIndex = 0;
    while (searchIndex < source.length)
    {
        const start = source.indexOf(needle, searchIndex);
        if (start === -1)
        {
            break;
        }

        const openParen = source.indexOf('(', start + needle.length);
        if (openParen === -1)
        {
            break;
        }

        const prefix = source.slice(start, openParen);
        if (!/withDefaults\s*$/.test(prefix))
        {
            searchIndex = start + needle.length;
            continue;
        }

        let depth = 0;
        let end = -1;
        for (let index = openParen; index < source.length; index += 1)
        {
            const char = source[index];
            if (char === '(')
            {
                depth += 1;
            }
            else if (char === ')')
            {
                depth -= 1;
                if (depth === 0)
                {
                    end = index + 1;
                    break;
                }
            }
        }

        if (end === -1)
        {
            break;
        }

        const block = source.slice(start, end);
        if (/withDefaults\s*\(\s*defineProps/.test(block))
        {
            blocks.push({ block, index: start });
        }
        searchIndex = end;
    }

    return blocks;
}

function checkScriptSetupHoistSafety(source, fileLabel)
{
    if (!source.includes('<script setup'))
    {
        return;
    }

    for (const { block, index } of collectWithDefaultsDefinePropsBlocks(source))
    {
        if (/\b(?:copy|[A-Za-z_$][\w$]*Copy)\s*\./.test(block))
        {
            hardViolations.push(`${fileLabel}:${lineNumber(source, index)}: withDefaults(defineProps(...)) cannot reference local copy aliases in <script setup> defaults`);
        }
    }
}

for (const file of vueFiles)
{
    const source = readFileSync(file, 'utf8');
    const fileLabel = relative(file);
    const isViewFile = file.startsWith(viewsDir);
    const isComponentFile = file.startsWith(componentsDir);

    checkScriptSetupHoistSafety(source, fileLabel);

    if (isViewFile)
    {
        const hasDirectWindowListener = source.includes('window.addEventListener(')
      || source.includes('window.removeEventListener(');
        if (hasDirectWindowListener)
        {
            hardViolations.push(`${fileLabel}: direct window event listener is forbidden in view (use composable/service)`);
        }

        const hasDirectAotListener = source.includes("window.addEventListener('fsus:aot:event'")
      || source.includes('window.addEventListener("fsus:aot:event"');
        if (hasDirectAotListener)
        {
            hardViolations.push(`${fileLabel}: direct fsus:aot:event listener is forbidden in view`);
        }

        const abortMatches = source.match(/\bnew\s+AbortController\s*\(/g) ?? [];
        if (abortMatches.length > 1)
        {
            softViolations.push(`${fileLabel}: multiple AbortController allocations detected (${abortMatches.length})`);
        }
    }

    if (isComponentFile)
    {
        checkComponentFacingSource(source, fileLabel);
    }

    for (const { token, line } of collectClassTokens(source))
    {
        const minWidth = parseArbitrarySize(token, 'min-w');
        if (minWidth && !tokenHasBreakpoint(token))
        {
            const tooWide = minWidth.unit === 'rem' ? minWidth.value >= 18 : minWidth.value >= 320;
            if (tooWide)
            {
                hardViolations.push(`${fileLabel}:${line}: unguarded ${token} can force mobile horizontal overflow`);
            }
        }

        const fixedWidth = parseArbitrarySize(token, 'w');
        if (fixedWidth && !tokenHasBreakpoint(token))
        {
            const tooWide = fixedWidth.unit === 'rem' ? fixedWidth.value >= 22.5 : fixedWidth.value >= 360;
            if (tooWide)
            {
                hardViolations.push(`${fileLabel}:${line}: unguarded ${token} can exceed narrow mobile viewport`);
            }
        }

        if (/^(gap-2[04]|space-y-20|px-1[24]|py-32|text-[89]xl|tracking-tighter)$/.test(token))
        {
            softViolations.push(`${fileLabel}:${line}: ${token} should be responsive or replaced by shared layout tokens`);
        }
    }
}

for (const file of componentFacingFiles)
{
    if (vueFiles.includes(file))
    {
        continue;
    }
    checkComponentFacingSource(readFileSync(file, 'utf8'), relative(file));
}

const accountLayoutPath = join(srcDir, 'layouts', 'AccountLayout.vue');
const accountLayoutSource = readFileSync(accountLayoutPath, 'utf8');
const accountRouteFrameSource = readFileSync(join(srcDir, 'layouts', 'AccountRouteFrame.vue'), 'utf8');
const accountMobileActionSource = readFileSync(join(srcDir, 'layouts', 'AccountFrameMobileAction.vue'), 'utf8');
if (!accountRouteFrameSource.includes('mobileDrawerVisible'))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: mobile account navigation must be carried by the account drawer state');
}
if (!accountRouteFrameSource.includes('id="account-mobile-drawer"'))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: mobile account navigation must use the account drawer surface');
}
if (!accountLayoutSource.includes('<RouterView name="accountMobileAction" />') || !accountMobileActionSource.includes('account-mobile-drawer-trigger'))
{
    hardViolations.push('src/layouts: the active frame mobile navigation trigger must render in the shared header actions outlet');
}
if (accountRouteFrameSource.includes('FsusUiSegmentedControl'))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: mobile account group navigation must not use the FsusUI segmented-control adapter');
}
if (accountRouteFrameSource.includes('openMobileGroupKey'))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: mobile account drawer must not keep a separate open group state');
}
if (accountRouteFrameSource.includes('class="account-mobile-tab-link"'))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: mobile account group navigation must not regress to the legacy hand-rolled tab buttons');
}
if (!accountRouteFrameSource.includes('accountViewRecord'))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: account route view key must be based on the direct frame child record');
}
if (/const\s+routeName\s*=\s*typeof\s+route\.name\s*===\s*'string'\s*\?\s*route\.name\s*:\s*route\.path/.test(accountRouteFrameSource))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: account route view key must not use the deepest route.name because nested admin tabs would remount their parent layout');
}
if (!/route\.matched\.findIndex\(\(record\)\s*=>\s*record\.path\s*===\s*'\/user'\)/.test(accountRouteFrameSource))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: account route view key must locate the /user root before choosing the direct frame child record');
}

const accountNavPath = join(srcDir, 'layouts', 'accountNav.ts');
const accountNavSource = readFileSync(accountNavPath, 'utf8');
if (!accountNavSource.includes("match: (path) => path === '/user/manage'"))
{
    hardViolations.push('src/layouts/accountNav.ts: /user/manage dashboard route must use exact matching so nested admin routes do not read as dashboard');
}
if (!accountNavSource.includes('ACCOUNT_GLOBAL_MODULE_LIMIT = 7'))
{
    hardViolations.push('src/layouts/accountNav.ts: account/admin persistent navigation must cap first-level modules at seven');
}
const accountNavigationPanelPath = join(srcDir, 'components', 'account', 'AccountNavigationPanel.vue');
const accountNavigationPanelSource = readFileSync(accountNavigationPanelPath, 'utf8');
if (!accountRouteFrameSource.includes('AccountNavigationPanel'))
{
    hardViolations.push('src/layouts/AccountRouteFrame.vue: account/admin frames must use the shared module and local navigation panel');
}
if (!accountNavigationPanelSource.includes('account-global-module-nav') || !accountNavigationPanelSource.includes('account-local-navigation'))
{
    hardViolations.push('src/components/account/AccountNavigationPanel.vue: navigation panel must separate global modules from current-module leaves');
}
if (!/label:\s*'身份中心'[\s\S]*?to:\s*'\/user\/identity'[\s\S]*?groupKey:\s*'self'[\s\S]*?match:\s*\(path\)\s*=>\s*path\s*===\s*'\/user\/identity'/.test(accountNavSource))
{
    hardViolations.push('src/layouts/accountNav.ts: 身份中心 must be the single /user/identity entry in the account group');
}
if (/label:\s*'身份总览'[\s\S]*?to:\s*'\/user\/identity'/.test(accountNavSource))
{
    hardViolations.push('src/layouts/accountNav.ts: /user/identity must not appear as both 身份中心 and 身份总览 in the navigation');
}

const routerPath = join(srcDir, 'router', 'index.ts');
const routerSource = readFileSync(routerPath, 'utf8');
if (!routerSource.includes('isSameAccountShellChildSwitch'))
{
    hardViolations.push('src/router/index.ts: route progress must skip nested account shell tab switches');
}
if (!/router\.beforeEach\(async\s*\(\s*to\s*,\s*from\s*\)/.test(routerSource))
{
    hardViolations.push('src/router/index.ts: route progress guard must inspect both to and from routes');
}
if (!routerSource.includes('!isSameAccountShellChildSwitch(to, from)'))
{
    hardViolations.push('src/router/index.ts: nested admin tabs must not start global nprogress');
}
const fixtureGateIndex = routerSource.indexOf('const fixtureQueryEnabled = isLocalFixtureQueryEnabled');
const bootstrapIndex = routerSource.indexOf('sessionBootstrap.ensureBootstrap()');
const accountSessionIndex = routerSource.indexOf('sessionBootstrap.ensureAccountSession({ reason: \'route\' })');
if (fixtureGateIndex < 0)
{
    hardViolations.push('src/router/index.ts: local fixture cookie gate must be explicit in the route guard');
}
if (fixtureGateIndex >= 0 && bootstrapIndex >= 0 && fixtureGateIndex > bootstrapIndex)
{
    hardViolations.push('src/router/index.ts: local fixture cookie gate must run before app bootstrap to avoid pre-cookie authenticated-route 401s');
}
if (fixtureGateIndex >= 0 && accountSessionIndex >= 0 && fixtureGateIndex > accountSessionIndex)
{
    hardViolations.push('src/router/index.ts: local fixture cookie gate must run before account session checks to avoid negative auth cache pollution');
}
if (!routerSource.includes('const fixtureRouteNeedsCookies = forceLocalFixtureSession && (accountRoute || manageRoute || identityRootRoute)'))
{
    hardViolations.push('src/router/index.ts: local fixture cookie gate must cover account, admin, and confirmed-identity root routes');
}
if (routerSource.includes('if (manageRoute && forceLocalFixtureSession)'))
{
    hardViolations.push('src/router/index.ts: local fixture cookie gate must not be scoped only to manageRoute');
}
if (!routerSource.includes('window.location.replace(buildLocalFixtureAdminUrl(to.fullPath))'))
{
    hardViolations.push('src/router/index.ts: local fixture admin cookie redirect must be explicit in the route guard');
}
if (!routerSource.includes('isLocalFixtureAdminSessionActive'))
{
    hardViolations.push('src/router/index.ts: local fixture admin principal must remain gated by the admin fixture flag');
}

const localFixtureSessionPath = join(srcDir, 'services', 'localFixtureSession.ts');
const localFixtureSessionSource = readFileSync(localFixtureSessionPath, 'utf8');
const ensureFixtureBlock = localFixtureSessionSource.match(/export\s+async\s+function\s+ensureLocalFixtureSessionCookies[\s\S]*?^}/m)?.[0] ?? '';
if (/window\.location\.(?:assign|replace|href)\b/.test(ensureFixtureBlock))
{
    hardViolations.push('src/services/localFixtureSession.ts: ensureLocalFixtureSessionCookies must not hide full-page navigation inside a helper');
}
if (!localFixtureSessionSource.includes('export function buildLocalFixtureAdminUrl'))
{
    hardViolations.push('src/services/localFixtureSession.ts: local fixture admin endpoint builder must stay explicit for route guard redirects');
}
if (!localFixtureSessionSource.includes('new URLSearchParams(window.location.search)') || !localFixtureSessionSource.includes('get(LOCAL_FIXTURE_LOGIN_QUERY)'))
{
    hardViolations.push('src/services/localFixtureSession.ts: local fixture activation must read the URL flag before persisting and removing it');
}

const sessionBootstrapPath = join(srcDir, 'composables', 'useSessionBootstrap.ts');
const sessionBootstrapSource = readFileSync(sessionBootstrapPath, 'utf8');
if (!sessionBootstrapSource.includes('isLocalFixtureSessionActive()'))
{
    hardViolations.push('src/composables/useSessionBootstrap.ts: local fixture mode must short-circuit account/admin session refreshes');
}
const fixtureSessionIndex = sessionBootstrapSource.indexOf('isLocalFixtureSessionActive()');
const userFetchIndex = sessionBootstrapSource.indexOf('userStore.fetchUserInfo');
const adminFetchIndex = sessionBootstrapSource.indexOf('adminStore.ensureAdminSessionFresh');
if (fixtureSessionIndex >= 0 && userFetchIndex >= 0 && fixtureSessionIndex > userFetchIndex)
{
    hardViolations.push('src/composables/useSessionBootstrap.ts: fixture account short-circuit must run before auth/me refresh');
}
if (fixtureSessionIndex >= 0 && adminFetchIndex >= 0 && fixtureSessionIndex > adminFetchIndex)
{
    hardViolations.push('src/composables/useSessionBootstrap.ts: fixture admin short-circuit must run before admin/me refresh');
}

for (const line of hardViolations)
{
    console.error(`[views-constraints] hard: ${line}`);
}
for (const line of softViolations)
{
    console.warn(`[views-constraints] soft: ${line}`);
}

// The existing canonical command owns this bounded preflight. It never emits a
// verified receipt, even when the static phase passes or CI reports job success.
if (process.env.FSUSBLOG_LAYOUT_AGGREGATION_PREFLIGHT === '1')
{
    const inputs = loadCompositionInputs({ repositoryRoot: resolve(root, '../..') });
    const plan = createLayoutAggregationPlan(inputs);
    console.log(JSON.stringify({
        schema: 'fsusblog.layout-aggregation-preflight.v1', status: 'not-executed',
        qualificationEligible: false, command: plan.command, planDigest: plan.planDigest,
        requiredArchetypes: inputs.matrix.archetypes.length,
        criticalArchetypes: inputs.matrix.archetypes.filter((entry) => entry.critical).length,
        declaredCoverageDemands: plan.requirements.length,
        unresolvedStateBindings: plan.pendingStateBindings.length,
        missingProducerCapabilities: [2098, 2099, 2100, 2101],
        mutationObservationStatus: 'not-executed',
        staticPhase: { hard: hardViolations.length, soft: softViolations.length }
    }));
    process.exit(1);
}

if (hardViolations.length > 0)
{
    process.exit(1);
}

if (strictMode && softViolations.length > 0)
{
    process.exit(1);
}

console.log(`[views-constraints] ok vue=${vueFiles.length} components=${vueFiles.filter((file) => file.startsWith(componentsDir)).length} componentFacing=${componentFacingFiles.length} hard=${hardViolations.length} soft=${softViolations.length} strict=${strictMode ? 1 : 0}`);
