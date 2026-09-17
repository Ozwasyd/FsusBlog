#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const frontendRoot = path.join(repoRoot, 'src/frontend/src');
const failures = [];

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');

function collectSourceFiles(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            return collectSourceFiles(entryPath);
        }
        return entry.isFile() && /\.(?:ts|tsx|vue|js|jsx|mjs|cjs)$/.test(entry.name) ? [entryPath] : [];
    });
}

function requireToken(source, token, message)
{
    if (!source.includes(token))
    {
        failures.push(message);
    }
}

function forbidPattern(source, pattern, message)
{
    if (pattern.test(source))
    {
        failures.push(message);
    }
}

const themeContract = read('src/frontend/src/ui-contracts/theme.ts');
const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts');
const dashboardView = read('src/frontend/src/views/admin/Dashboard.vue');
const dashboardWorkbench = read('src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue');

forbidPattern(
    themeContract,
    /\bdashboard\s*:\s*Readonly\s*</,
    'ThemeTokenContract must not publish the retired Dashboard KPI-card contract'
);
forbidPattern(
    themeTokens,
    /\bdashboard\s*:\s*\{/,
    'themeTokens must not retain an unconsumed Dashboard KPI-card token group'
);

for (const file of collectSourceFiles(frontendRoot))
{
    const source = fs.readFileSync(file, 'utf8');
    if (/\bthemeTokens\.dashboard\b/.test(source))
    {
        failures.push(`${rel(file)} must not consume the retired themeTokens.dashboard contract`);
    }
}

requireToken(
    dashboardView,
    '<AdminDashboardTaskWorkbench',
    'ManageDashboard must keep delegating its current UI to AdminDashboardTaskWorkbench'
);
requireToken(
    dashboardWorkbench,
    'class="dashboard-task-list"',
    'Dashboard workbench must retain its task-first action list'
);
requireToken(
    dashboardWorkbench,
    '<dl class="dashboard-stat-ledger" aria-label="站点统计摘要">',
    'Dashboard workbench must retain its compact semantic summary ledger'
);
forbidPattern(
    dashboardWorkbench,
    /dashboard-stat-card|<el-icon\b/,
    'Dashboard workbench must not restore the retired icon KPI-card UI'
);

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[admin-dashboard-token-retirement] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[admin-dashboard-token-retirement] ok');
