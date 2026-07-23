#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(`[page-title-scale] ${message}`);
    }
}

const componentFiles = [
    'src/frontend/src/components/filter/FilterHeader.vue',
    'src/frontend/src/components/public/pages/PublicArchivePageContent.vue',
    'src/frontend/src/components/public/pages/PublicAboutPageContent.vue',
    'src/frontend/src/views/auth/Login.vue',
    'src/frontend/src/views/auth/Register.vue',
    'src/frontend/src/views/auth/Recover.vue',
    'src/frontend/src/views/error/403.vue',
    'src/frontend/src/views/error/404.vue'
];

for (const file of componentFiles)
{
    const source = read(file);
    assert(!/\btext-(?:4xl|5xl|6xl|7xl|8xl|9xl)\b/u.test(source), `${file} contains an oversized display utility`);
    const headings = [...source.matchAll(/<h1\b[^>]*>/gs)];
    assert(headings.length === 1, `${file} must expose exactly one page H1`);
    const heading = headings[0][0];
    for (const token of ['text-2xl', 'sm:text-3xl', 'font-bold', 'leading-tight', 'tracking-normal'])
    {
        assert(heading.includes(token), `${file} H1 is missing ${token}`);
    }
    assert(!/gradient|glow|text-shadow/u.test(source), `${file} must not create a decorative title focus layer`);
}

const featuredHomePath = 'src/frontend/src/components/home/FeaturedArticlesSection.vue';
const featuredHome = read(featuredHomePath);
const featuredHomeHeadings = [...featuredHome.matchAll(/<h1\b[^>]*>/gs)];
assert(featuredHomeHeadings.length === 1, `${featuredHomePath} must expose exactly one page H1`);
for (const token of ['text-[28px]', 'font-bold', 'leading-[1.15]', 'tracking-normal'])
{
    assert(featuredHomeHeadings[0][0].includes(token), `${featuredHomePath} editorial H1 is missing ${token}`);
}
assert(!/\btext-(?:4xl|5xl|6xl|7xl|8xl|9xl)\b/u.test(featuredHome),
    `${featuredHomePath} contains an oversized display utility`);
assert(!/gradient|glow|text-shadow/u.test(featuredHome),
    `${featuredHomePath} must not create a decorative title focus layer`);

for (const file of ['src/frontend/src/views/auth/Login.vue', 'src/frontend/src/views/auth/Register.vue', 'src/frontend/src/views/auth/Recover.vue'])
{
    const source = read(file);
    assert(/<header class="mb-6">[\s\S]*?<h1[\s\S]*?<p[\s\S]*?class="mt-4[^"]*text-sm[^"]*font-normal/u.test(source),
        `${file} must keep the 16px title-description and 24px description-control rhythm`);
}

for (const file of ['src/frontend/src/views/error/403.vue', 'src/frontend/src/views/error/404.vue'])
{
    const source = read(file);
    assert(/<p class="mb-4 text-sm font-bold[^>]*aria-hidden="true">/u.test(source), `${file} error code must be an auxiliary label`);
    assert(/class="mt-6 flex flex-col gap-3 sm:flex-row"/u.test(source), `${file} first action must start 24px after the description`);
}

const account = read('src/frontend/src/assets/account-shell-base.css');
assert(/\.account-task-page-header\s*\{[^}]*margin-bottom:\s*var\(--fsus-space-6\);/s.test(account),
    'account pages must retain only the Blog-owned header-to-content margin handoff');
for (const selector of ['account-page-header', 'account-page-title', 'account-page-description'])
{
    assert(!account.includes(`.${selector}`), `account shell must not duplicate the canonical task header through .${selector}`);
}

const taskPageHeaderAdapter = read('src/frontend/src/fsusui/taskPageHeader.ts');
assert(/FsusTaskPageHeader\s+as\s+FsusUiTaskPageHeader/u.test(taskPageHeaderAdapter),
    'task page header adapter must be a type-preserving named re-export');

const canonicalTaskPageFiles = [
    'src/frontend/src/views/user/IdentityCenter.vue',
    'src/frontend/src/views/user/Profile.vue',
    'src/frontend/src/views/user/Comments.vue',
    'src/frontend/src/views/user/Messages.vue',
    'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue',
    'src/frontend/src/components/admin/AdminTaxonomyManageView.vue',
    'src/frontend/src/views/admin/Analytics.vue',
    'src/frontend/src/views/admin/Assets.vue',
    'src/frontend/src/views/admin/AuditLog.vue',
    'src/frontend/src/views/admin/CacheDiagnostics.vue',
    'src/frontend/src/views/admin/CommentModeration.vue',
    'src/frontend/src/views/admin/ContentTools.vue',
    'src/frontend/src/views/admin/Integrity.vue',
    'src/frontend/src/views/admin/IntegrityProofConsole.vue',
    'src/frontend/src/views/admin/MessageCenter.vue',
    'src/frontend/src/views/admin/OpsHealth.vue',
    'src/frontend/src/views/admin/Settings.vue',
    'src/frontend/src/views/admin/UserManage.vue',
    'src/frontend/src/views/admin/article/List.vue',
    'src/frontend/src/views/admin/article/Trash.vue',
    'src/frontend/src/views/admin/article/Write.vue',
    'src/frontend/src/views/admin/moderation/ModerationLayout.vue',
    'src/frontend/src/views/admin/security/SecurityLayout.vue'
];

for (const file of canonicalTaskPageFiles)
{
    const source = read(file);
    assert(source.includes('<FsusUiTaskPageHeader'), `${file} must use the canonical task page header`);
    assert(!/account-page-title|identity-section-header__copy|write-command-title/u.test(source),
        `${file} must not retain a local task-title visual implementation`);
}

const nestedTaskSection = read('src/frontend/src/views/admin/moderation/AnonymousGovernancePage.vue');
assert(/<FsusUiTaskPageHeader[\s\S]*?title-tag="h2"/u.test(nestedTaskSection),
    'nested anonymous governance routes must use the canonical header with an H2 title role');

const themeTokens = read('src/frontend/src/ui-tokens/themeTokens.ts');
assert(/articleDetail:\s*\{[\s\S]*?title: `text-2xl sm:text-3xl font-bold[^`]*leading-\[1\.25\] sm:leading-\[1\.2\][^`]*tracking-normal/u.test(themeTokens),
    'article detail H1 must use the responsive 24/30px page-title role');

console.log('[page-title-scale] public/auth/error geometry and canonical account task headers are governed');
