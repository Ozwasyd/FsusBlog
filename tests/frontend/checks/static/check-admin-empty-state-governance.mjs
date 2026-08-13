#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

const sourceRoot = path.join(repoRoot, 'src/frontend/src');
const adminAccountRoots = [
    'src/frontend/src/views/admin',
    'src/frontend/src/views/user',
    'src/frontend/src/components/admin',
    'src/frontend/src/components/user'
].map((dir) => path.join(repoRoot, dir));

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json');
const adminInlineEmptyStatePath = path.join(sourceRoot, 'components/admin/AdminInlineEmptyState.vue');
const adminWorkspacePath = path.join(sourceRoot, 'assets/admin-workspace.css');
const contractPath = path.join(repoRoot, 'tests/frontend/fixtures/admin-inline-empty-state-contract.json');
const browserCorrectnessPath = path.join(repoRoot, 'tests/frontend/e2e/admin-inline-empty-state.spec.ts');
const visualDiagnosticPath = path.join(repoRoot, 'tests/frontend/e2e/visual/admin-inline-empty-state.spec.ts');
const visualFixturePath = path.join(repoRoot, 'tests/frontend/fixtures/adminInlineEmptyStateVisual.ts');
const visualRunnerPath = path.join(repoRoot, 'tools/frontend/check-console-visual.sh');

const directElEmptyAllowlist = new Map();

const dashPlaceholderAllowlist = [
    {
        file: 'src/frontend/src/views/user/Profile.vue',
        needle: '<span v-else>-</span>',
        reason: 'Row-level missing session timestamp placeholder, not a panel empty state.'
    },
    {
        file: 'src/frontend/src/views/admin/moderation/ModerationReplay.vue',
        needle: '<span v-if="row.addedBlockedRegions.length + row.removedBlockedRegions.length === 0">-</span>',
        reason: 'Row-level no-change marker inside a populated replay table.'
    },
    {
        file: 'src/frontend/src/views/admin/moderation/ModerationReplay.vue',
        needle: '<span v-if="row.addedRiskLabels.length + row.removedRiskLabels.length === 0">-</span>',
        reason: 'Row-level no-change marker inside a populated replay table.'
    }
];

function fail(file, line, message)
{
    failures.push(`${rel(file)}:${line}: ${message}`);
}

function walk(dir, files = [])
{
    if (!fs.existsSync(dir))
    {
        return files;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory())
        {
            walk(fullPath, files);
            continue;
        }

        if (entry.isFile() && /\.(vue|ts)$/.test(entry.name))
        {
            files.push(fullPath);
        }
    }

    return files;
}

function tableTokens(line)
{
    const tokens = [];
    const pattern = /<el-table(?=[\s>])|<\/el-table>|<template\s+#empty\b/g;
    let match;
    while ((match = pattern.exec(line)) !== null)
    {
        tokens.push({ value: match[0], index: match.index });
    }
    return tokens.sort((left, right) => left.index - right.index);
}

function checkTables(file, content)
{
    const stack = [];
    const lines = content.split(/\r?\n/);
    const hasStandaloneInlineEmptyState = /<AdminInlineEmptyState\b/.test(content);

    const hasStandaloneEmptyFallback = (line) =>
        /\bv-(?:else-)?if\s*=\s*["'][^"']*(?:has[A-Za-z0-9_]*Rows|filteredList\.length\s*>\s*0|\.length\s*>\s*0)[^"']*["']/.test(line) &&
    hasStandaloneInlineEmptyState;

    lines.forEach((line, index) =>
    {
        for (const token of tableTokens(line))
        {
            if (token.value.startsWith('<el-table'))
            {
                stack.push({ line: index + 1, hasEmpty: false, hasStandaloneFallback: hasStandaloneEmptyFallback(line) });
                continue;
            }

            if (token.value.startsWith('<template'))
            {
                const current = stack.at(-1);
                if (current)
                {
                    current.hasEmpty = true;
                }
                continue;
            }

            const current = stack.pop();
            if (current && !current.hasEmpty && !current.hasStandaloneFallback)
            {
                fail(file, current.line, 'admin/account el-table must provide a localized compact #empty slot');
            }
        }
    });

    for (const unclosed of stack)
    {
        fail(file, unclosed.line, 'admin/account el-table appears unclosed; empty-state governance cannot verify it');
    }
}

function isDashPlaceholderAllowed(file, line)
{
    const relative = rel(file);
    return dashPlaceholderAllowlist.some((entry) =>
        entry.file === relative && line.includes(entry.needle)
    );
}

for (const file of walk(sourceRoot))
{
    const relative = rel(file);
    const content = read(file);
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) =>
    {
        if (/<el-empty\b/.test(line) && !directElEmptyAllowlist.has(relative))
        {
            fail(file, index + 1, 'direct el-empty is forbidden in FsusBlog admin/account scope; use a copy-owned inline state');
        }

        if (/\bNo Data\b/.test(line))
        {
            fail(file, index + 1, 'literal No Data must not appear in frontend source');
        }
    });
}

for (const file of adminAccountRoots.flatMap((dir) => walk(dir)))
{
    const content = read(file);
    const lines = content.split(/\r?\n/);

    checkTables(file, content);

    lines.forEach((line, index) =>
    {
        if (/>-<\/\w+>/.test(line) && !isDashPlaceholderAllowed(file, line))
        {
            fail(file, index + 1, 'standalone "-" must not be used as a panel empty state; use contextual copy');
        }
    });
}

const adminInlineEmptyState = read(adminInlineEmptyStatePath);
const adminWorkspace = read(adminWorkspacePath);
const contract = JSON.parse(read(contractPath));
const insetCustomProperty = contract.insetCustomProperty;
const consumerFiles = walk(sourceRoot).filter((file) => (
    file !== adminInlineEmptyStatePath && read(file).includes('<AdminInlineEmptyState')
));

if (contract.schema !== 'fsusblog.admin-inline-empty-state-contract.v1')
{
    fail(contractPath, 1, 'admin inline empty-state contract schema is invalid');
}
if (insetCustomProperty !== '--fsus-admin-inline-empty-state-inset')
{
    fail(contractPath, 1, 'admin inline empty-state inset custom property must have one canonical name');
}
if (!Array.isArray(contract.overrideExceptions))
{
    fail(contractPath, 1, 'admin inline empty-state override exceptions must be explicit');
}

const representativeIds = new Set();
for (const representative of contract.consumerRepresentatives ?? [])
{
    const representativePath = path.join(repoRoot, representative.source ?? '');
    if (representativeIds.has(representative.id))
    {
        fail(contractPath, 1, `duplicate consumer representative: ${representative.id}`);
    }
    representativeIds.add(representative.id);
    if (!fs.existsSync(representativePath) || !read(representativePath).includes('<AdminInlineEmptyState'))
    {
        fail(contractPath, 1, `consumer representative is not wired to AdminInlineEmptyState: ${representative.id}`);
    }
    if (!String(representative.distinction ?? '').trim())
    {
        fail(contractPath, 1, `consumer representative must describe its wiring difference: ${representative.id}`);
    }
}

const visualRepresentatives = (contract.consumerRepresentatives ?? [])
    .filter((entry) => entry.visualRepresentative)
    .map((entry) => entry.id);
if (visualRepresentatives.join(',') !== 'article,queue,anonymous')
{
    fail(contractPath, 1, 'visual diagnostics must use the article, queue and anonymous representatives');
}
if ((contract.visualDiagnostics?.viewports ?? []).map((entry) => entry.id).join(',') !== 'desktop,mobile')
{
    fail(contractPath, 1, 'visual diagnostics must register desktop and mobile viewports');
}
if ((contract.visualDiagnostics?.authorities ?? []).join(',') !== 'alignment,hierarchy,overflow')
{
    fail(contractPath, 1, 'visual diagnostics must own alignment, hierarchy and overflow');
}

const browserCorrectness = read(browserCorrectnessPath);
const visualDiagnostic = read(visualDiagnosticPath);
const visualFixture = read(visualFixturePath);
const visualRunner = read(visualRunnerPath);
if (/toHaveCSS|expectedPadding|toHaveScreenshot|\.screenshot\(/.test(browserCorrectness))
{
    fail(browserCorrectnessPath, 1, 'browser correctness must not own fixed inset or screenshot assertions');
}
for (const token of ['pageerror', "getByRole('button'", 'aria-busy', 'scrollWidth - window.innerWidth'])
{
    if (!browserCorrectness.includes(token))
    {
        fail(browserCorrectnessPath, 1, `browser correctness is missing browser-only authority: ${token}`);
    }
}
for (const token of ['toHaveScreenshot', 'leftEdges', 'scrollWidth - window.innerWidth'])
{
    if (!visualDiagnostic.includes(token))
    {
        fail(visualDiagnosticPath, 1, `visual diagnostic is missing ${token}`);
    }
}
if (!visualFixture.includes('contract.consumerRepresentatives') || !visualFixture.includes('visualRepresentative'))
{
    fail(visualFixturePath, 1, 'visual fixture must project the registered consumer representatives');
}
if (!visualRunner.includes('visual/admin-inline-empty-state.spec.ts'))
{
    fail(visualRunnerPath, 1, 'console visual runner must execute the admin inline empty-state diagnostic');
}

if (!adminInlineEmptyState.includes('class="admin-inline-empty-state"'))
{
    fail(adminInlineEmptyStatePath, 1, 'AdminInlineEmptyState must own the admin empty-state inset contract');
}
if (!adminInlineEmptyState.includes('admin-inline-empty-state__actions'))
{
    fail(adminInlineEmptyStatePath, 1, 'AdminInlineEmptyState must own action spacing for compact empty states');
}
if (!adminInlineEmptyState.includes('props.description || props.content'))
{
    fail(adminInlineEmptyStatePath, 1, 'AdminInlineEmptyState must support content fallback for existing admin callers');
}
if (!new RegExp(`\\.admin-workspace-frame \\.admin-inline-empty-state\\s*\\{[^}]*${insetCustomProperty}:\\s*var\\(--fsus-space-5\\);[^}]*padding:\\s*var\\(${insetCustomProperty}\\);`, 's').test(adminWorkspace))
{
    fail(adminWorkspacePath, 1, 'admin workspace must consume the canonical desktop empty-state inset custom property');
}
if (!new RegExp(`@media\\s*\\(width <= 639px\\)\\s*\\{[\\s\\S]*?\\.admin-workspace-frame \\.admin-inline-empty-state\\s*\\{[^}]*${insetCustomProperty}:\\s*var\\(--fsus-space-4\\);`, 's').test(adminWorkspace))
{
    fail(adminWorkspacePath, 1, 'admin workspace must adapt the canonical empty-state inset property for mobile');
}

for (const file of consumerFiles)
{
    const content = read(file);
    const tags = [...content.matchAll(/<AdminInlineEmptyState\b[\s\S]*?>/g)].map((match) => match[0]);

    for (const tag of tags)
    {
        if (/\s(?:v-bind:|:)?style\s*=/.test(tag))
        {
            fail(file, 1, 'AdminInlineEmptyState consumers must not apply inline style overrides');
        }

        const classMatch = tag.match(/\sclass\s*=\s*["']([^"']+)["']/);
        const classNames = classMatch?.[1].split(/\s+/).filter(Boolean) ?? [];
        for (const className of classNames)
        {
            const selectorPattern = new RegExp(`\\.${className}\\b[^\\{]*\\{([^}]*)\\}`, 'gs');
            for (const rule of content.matchAll(selectorPattern))
            {
                const declarations = rule[1];
                if (/\bpadding(?:-[a-z]+)?\s*:/.test(declarations))
                {
                    fail(file, 1, `.${className} must inherit padding from AdminInlineEmptyState`);
                }
                if (/\bmargin(?:-[a-z]+)?\s*:\s*-[^;]+/.test(declarations))
                {
                    fail(file, 1, `.${className} must not offset the canonical inset with a negative margin`);
                }
                if (/!important\b/.test(declarations))
                {
                    fail(file, 1, `.${className} must not override the canonical inset with !important`);
                }
            }
        }
    }

    if (/:deep\([^)]*\.admin-inline-empty-state|\.admin-inline-empty-state\s*\{/.test(content))
    {
        fail(file, 1, 'consumer must not reach into the canonical admin inline empty-state contract');
    }
}

const packageJson = JSON.parse(read(packageJsonPath));
const scripts = packageJson.scripts ?? {};
const checkScript = 'node ../../tests/frontend/checks/static/check-admin-empty-state-governance.mjs';
if (scripts['check:admin-empty-state-governance'] !== checkScript)
{
    fail(packageJsonPath, 1, 'check:admin-empty-state-governance script is missing');
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:admin-empty-state-governance'))
{
    fail(packageJsonPath, 1, 'check:views-constraints must run check:admin-empty-state-governance');
}

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[admin-empty-state-governance] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[admin-empty-state-governance] ok');
