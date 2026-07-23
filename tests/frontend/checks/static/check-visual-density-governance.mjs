#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const failures = [];

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

const adminAccountRoots = [
    'src/frontend/src/views/admin',
    'src/frontend/src/views/user',
    'src/frontend/src/components/account',
    'src/frontend/src/components/admin',
    'src/frontend/src/components/user'
].map((dir) => path.join(repoRoot, dir));

const publicEditorialRoots = [
    'src/frontend/src/components/public',
    'src/frontend/src/components/filter',
    'src/frontend/src/components/home',
    'src/frontend/src/components/article'
].map((dir) => path.join(repoRoot, dir));

const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json');
const accountShellBasePath = path.join(repoRoot, 'src/frontend/src/assets/account-shell-base.css');
const adminWorkspaceCssPath = path.join(repoRoot, 'src/frontend/src/assets/admin-workspace.css');
const taskPageHeaderAdapterPath = path.join(repoRoot, 'src/frontend/src/fsusui/taskPageHeader.ts');
const accountLayoutPath = path.join(repoRoot, 'src/frontend/src/layouts/AccountLayout.vue');
const accountRouteFramePath = path.join(repoRoot, 'src/frontend/src/layouts/AccountRouteFrame.vue');
const accountMobileActionPath = path.join(repoRoot, 'src/frontend/src/layouts/AccountFrameMobileAction.vue');
const accountNavigationPanelPath = path.join(repoRoot, 'src/frontend/src/components/account/AccountNavigationPanel.vue');
const accountHeaderMenuPath = path.join(repoRoot, 'src/frontend/src/components/account/AccountHeaderMenu.vue');
const siteChromeHeaderAdapterPath = path.join(repoRoot, 'src/frontend/src/components/layout/SiteChromeHeaderAdapter.vue');
const registerPath = path.join(repoRoot, 'src/frontend/src/views/auth/Register.vue');
const adminDashboardPath = path.join(repoRoot, 'src/frontend/src/views/admin/Dashboard.vue');
const adminDashboardWorkbenchPath = path.join(repoRoot, 'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue');
const adminAnalyticsPath = path.join(repoRoot, 'src/frontend/src/views/admin/Analytics.vue');
const homeTextFirstRecommendationsPath = path.join(repoRoot, 'src/frontend/src/components/home/HomeTextFirstRecommendations.vue');
const themeTokensPath = path.join(repoRoot, 'src/frontend/src/ui-tokens/themeTokens.ts');
const publicArticleListPath = path.join(repoRoot, 'src/frontend/src/components/public/PublicArticleList.vue');
const productionSourceRoot = path.join(repoRoot, 'src/frontend/src');
const articleDetailPath = path.join(repoRoot, 'src/frontend/src/views/ArticleDetail.vue');
const publicPageCssPath = path.join(repoRoot, 'src/frontend/src/assets/public-page.css');
const publicShellCriticalCssPath = path.join(repoRoot, 'src/frontend/src/assets/public-shell-foundation.css');
const publicShellEmergencyCssPath = path.join(repoRoot, 'src/frontend/public/public-shell-emergency.css');
const mainCssPath = path.join(repoRoot, 'src/frontend/src/assets/main.css');
const markdownCssPath = path.join(repoRoot, 'src/frontend/src/assets/markdown.css');
const markdownRendererPath = path.join(repoRoot, 'src/frontend/src/components/ui/MarkdownRenderer.vue');
const publicShellOwnershipPath = path.join(repoRoot, 'docs/frontend/public-shell-ownership.md');
const readingTypographyPath = path.join(repoRoot, 'docs/design/reading-typography.md');
const pageTitleScalePath = path.join(repoRoot, 'docs/design/page-title-scale.md');
const publicRenderersRoot = path.join(repoRoot, 'src/frontend/src/public-renderers');
const commentDetailViewContractPath = path.join(repoRoot, 'src/frontend/src/view-contracts/commentDetail.ts');
const identityCenterPath = path.join(repoRoot, 'src/frontend/src/views/user/IdentityCenter.vue');
const userCommentsListPath = path.join(repoRoot, 'src/frontend/src/components/user/UserCommentsList.vue');
const messagesConversationListPath = path.join(repoRoot, 'src/frontend/src/components/user/messages/MessagesConversationList.vue');
const articleTrashPath = path.join(repoRoot, 'src/frontend/src/views/admin/article/Trash.vue');
const articleWritePath = path.join(repoRoot, 'src/frontend/src/views/admin/article/Write.vue');
const articleWriteCommandBarPath = path.join(
    repoRoot,
    'src/frontend/src/components/admin/article/ArticleWriteCommandBar.vue'
);
const auditLogPath = path.join(repoRoot, 'src/frontend/src/views/admin/AuditLog.vue');
const dashboardAuthorAnalyticsListPath = path.join(repoRoot, 'src/frontend/src/components/admin/DashboardAuthorAnalyticsList.vue');

const dashboardPanelPattern = /src\/frontend\/src\/(?:views\/admin\/Dashboard|components\/admin\/Dashboard|views\/admin\/security\/Security|views\/admin\/moderation\/Moderation|components\/admin\/comment-moderation\/CommentModeration)/;
const nonActionHoverPrimaryFiles = new Set([
    'src/frontend/src/views/admin/Dashboard.vue',
    'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue'
]);
const governedMicroLabelFiles = new Set([
    'src/frontend/src/views/admin/Dashboard.vue',
    'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue',
    'src/frontend/src/views/admin/security/SecurityDashboard.vue',
    'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue',
    'src/frontend/src/components/admin/users/UserManageTable.vue',
    'src/frontend/src/components/public/ArticleDetailCommentsPlaceholder.vue',
    'src/frontend/src/components/public/pages/PublicArchivePageContent.vue',
    'src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue',
    'src/frontend/src/components/public/pages/PublicHomePageContent.vue',
    'src/frontend/src/components/filter/FilterHeader.vue',
    'src/frontend/src/components/home/FeaturedArticlesSection.vue',
    'src/frontend/src/components/article/ArticleReadingNotice.vue'
]);
const dashboardDensityFiles = [
    'src/frontend/src/views/admin/Dashboard.vue',
    'src/frontend/src/components/admin/AdminDashboardTaskWorkbench.vue',
    'src/frontend/src/views/admin/Analytics.vue',
    'src/frontend/src/components/admin/DashboardAuthorAnalyticsList.vue',
    'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'
];
const roleAuditedTypographyFiles = new Set([
    'src/frontend/src/components/admin/article/ArticleAssetLibraryPanel.vue',
    'src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue',
    'src/frontend/src/components/admin/article/ArticleRevisionPanel.vue',
    'src/frontend/src/components/admin/comment-moderation/CommentModerationBulkActions.vue',
    'src/frontend/src/components/admin/comment-moderation/CommentModerationDetailDrawer.vue',
    'src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue',
    'src/frontend/src/components/admin/comment-moderation/CommentModerationToolbar.vue'
]);

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

function walkTouchTargetSources(dir, files = [])
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
            walkTouchTargetSources(fullPath, files);
            continue;
        }

        if (entry.isFile() && /\.(?:css|scss|ts|vue)$/.test(entry.name))
        {
            files.push(fullPath);
        }
    }

    return files;
}

function hasAllowComment(lines, index)
{
    return /fsus-allow-visual-density:/.test(lines[index] ?? '')
    || /fsus-allow-visual-density:/.test(lines[index - 1] ?? '');
}

function checkSourceFile(file, scope)
{
    const relative = rel(file);
    const lines = read(file).split(/\r?\n/);

    lines.forEach((line, index) =>
    {
        if (hasAllowComment(lines, index))
        {
            return;
        }

        if (/\bfont-black\b/.test(line))
        {
            fail(file, index + 1, `${scope} ordinary labels and metadata must not use font-black`);
        }

        if (scope === 'admin/account' && /\btext-5xl\b/.test(line))
        {
            fail(file, index + 1, 'admin/account KPI and panel surfaces must not use text-5xl by default');
        }

        if (dashboardPanelPattern.test(relative) && /\btext-3xl\b/.test(line))
        {
            fail(file, index + 1, 'nested dashboard/security/moderation panels must not use text-3xl as routine titles or metrics');
        }

        if (dashboardPanelPattern.test(relative) && /\bgap-px\b/.test(line) && /bg-\[var\(--fsusblog-panel-bg-soft\)\]/.test(line))
        {
            fail(file, index + 1, 'dashboard/security/moderation panels must not use gap-px soft-background lattice as default card grammar');
        }

        if (nonActionHoverPrimaryFiles.has(relative) && /group-hover:text-\[var\(--fsusblog-color-primary\)\]/.test(line))
        {
            fail(file, index + 1, 'hover-primary styling must be limited to actual links/actions');
        }

        if (governedMicroLabelFiles.has(relative) && /\btext-\[(?:9|10|11)px\]\s+font-(?:bold|semibold)\b/.test(line))
        {
            fail(file, index + 1, 'governed dashboard/public labels must use 12px+ readable metadata scale');
        }

        if (roleAuditedTypographyFiles.has(relative) && /\btext-\[11px\]\b/.test(line))
        {
            fail(file, index + 1, 'audited article/comment moderation labels and metadata must use 12px+ role-specific scale');
        }
    });
}

function checkProductionFocusRing(file)
{
    const lines = read(file).split(/\r?\n/);

    lines.forEach((line, index) =>
    {
        if (hasAllowComment(lines, index))
        {
            return;
        }

        if (/\bfocus-visible:ring-1\b/.test(line))
        {
            fail(file, index + 1, 'production focus-visible styles must use 2px inset focus rings, not ring-1');
        }
    });
}

function lineNumberFromSource(source, index)
{
    return source.slice(0, index).split(/\r?\n/).length;
}

function assertContains(file, pattern, message)
{
    if (!fs.existsSync(file))
    {
        fail(file, 1, message);
        return;
    }

    if (!pattern.test(read(file)))
    {
        fail(file, 1, message);
    }
}

function assertNotContains(file, pattern, message)
{
    if (!fs.existsSync(file))
    {
        return;
    }

    const source = read(file);
    const match = pattern.exec(source);
    if (match?.index !== undefined)
    {
        fail(file, lineNumberFromSource(source, match.index), message);
    }
}

function checkTouchTargetFloor()
{
    const forbiddenHeightPattern = /min-height\s*:\s*(?:36px|2\.25rem)\s*;/g;

    for (const file of walkTouchTargetSources(productionSourceRoot))
    {
        const source = read(file);
        for (const match of source.matchAll(forbiddenHeightPattern))
        {
            fail(
                file,
                lineNumberFromSource(source, match.index ?? 0),
                'touch targets must not use the retired 36px/2.25rem minimum-height tier'
            );
        }
    }

    assertNotContains(
        publicShellCriticalCssPath,
        /\.(?:el-public-shell|el-theme-mode-toggle)(?:__|--|\b)/,
        'public component touch-target geometry belongs to FsusUI, not the consumer foundation'
    );
    assertNotContains(
        publicShellCriticalCssPath,
        /--fsusblog-public-(?:control|mobile-control)[a-z0-9-]*\s*:/,
        'consumer CSS must not duplicate FsusUI public control-height tokens'
    );
    assertContains(
        identityCenterPath,
        /\.identity-touch-action\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/,
        'IdentityCenter touch actions must keep 44px targets on both axes'
    );
    assertContains(
        userCommentsListPath,
        /\.user-comment-delete-button\s*\{[\s\S]*?min-width:\s*2\.75rem;[\s\S]*?min-height:\s*2\.75rem;/,
        'user comment delete actions must keep 44px targets on both axes'
    );
    assertContains(
        messagesConversationListPath,
        /\.messages-header-create-ticket\s*\{[\s\S]*?min-height:\s*2\.75rem;/,
        'mobile message creation actions must keep the 44px identity touch tier'
    );
    assertContains(
        articleTrashPath,
        /\.article-trash-empty-action\.el-button\)\s*\{[\s\S]*?min-height:\s*40px;/,
        'article trash empty actions must keep the 40px admin compact tier'
    );
    assertContains(
        articleWriteCommandBarPath,
        /\.article-write-command-bar__back\s*\{[\s\S]*?min-width:\s*2\.5rem;[\s\S]*?min-height:\s*2\.5rem;/,
        'article write back actions must keep 40px targets on both axes'
    );
    assertContains(
        auditLogPath,
        /\.audit-compact-row__action\s*\{[\s\S]*?min-width:\s*40px;[\s\S]*?min-height:\s*40px;/,
        'audit row actions must keep 40px targets on both axes'
    );
    assertContains(
        dashboardAuthorAnalyticsListPath,
        /\.analytics-list__item\s*\{[\s\S]*?min-height:\s*40px;/,
        'dashboard analytics rows must keep the 40px admin compact tier'
    );
    assertContains(
        publicShellOwnershipPath,
        /触控目标档位[\s\S]*?public header[\s\S]*?40px[\s\S]*?identity[\s\S]*?44px[\s\S]*?admin[\s\S]*?40px/,
        'public shell authority must document public, identity, and admin touch-target tiers'
    );
}

function contrastRatio(foreground, background)
{
    const parseHex = (value) =>
    {
        const normalized = value.replace('#', '');
        if (!/^[0-9a-f]{6}$/i.test(normalized))
        {
            throw new Error(`expected six-digit hex color, got ${value}`);
        }

        return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
    };

    const relativeLuminance = (value) => parseHex(value)
        .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
        .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);

    const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
    return (lighter + 0.05) / (darker + 0.05);
}

function checkPublicTypographyContract()
{
    const publicComponentsRoot = path.join(repoRoot, 'src/frontend/src/components/public');
    const publicDisplayScaleFiles = [
        ...walk(publicComponentsRoot),
        themeTokensPath
    ];
    const readableSourceFiles = [
        ...publicEditorialRoots.flatMap((dir) => walk(dir)),
        ...walk(publicRenderersRoot),
        articleDetailPath,
        commentDetailViewContractPath,
        themeTokensPath
    ];
    const forbiddenReadableScale = /text-\[(?:9|10|11)px\]|font-size:\s*(?:0?\.625|0?\.6875|0?\.71875)rem\s*;/;

    for (const file of publicDisplayScaleFiles)
    {
        const source = read(file);
        const oversizedDisplay = /\btext-(?:4xl|5xl)\b/g;
        for (const match of source.matchAll(oversizedDisplay))
        {
            fail(
                file,
                lineNumberFromSource(source, match.index ?? 0),
                'public display typography must stay within the 20/24/30px title scale'
            );
        }

        for (const match of source.matchAll(/<h1\b[^>]*>/gs))
        {
            const heading = match[0];
            const headingClasses = new Set((/\bclass="([^"]*)"/s.exec(heading)?.[1] ?? '').split(/\s+/));
            if (!['text-2xl', 'sm:text-3xl', 'font-bold'].every((className) => headingClasses.has(className)))
            {
                fail(
                    file,
                    lineNumberFromSource(source, match.index ?? 0),
                    'public page H1 must use the 24/30px text-2xl sm:text-3xl scale and loaded font-bold weight'
                );
            }
        }
    }

    for (const file of readableSourceFiles)
    {
        const lines = read(file).split(/\r?\n/);
        lines.forEach((line, index) =>
        {
            if (hasAllowComment(lines, index))
            {
                return;
            }

            if (forbiddenReadableScale.test(line))
            {
                fail(file, index + 1, 'public readable copy must use 12px+ metadata and controls, never 9/10/11px or sub-12px rem scales');
            }
        });
    }

    for (const file of [publicPageCssPath, publicShellCriticalCssPath, publicShellEmergencyCssPath, markdownCssPath])
    {
        assertNotContains(
            file,
            /font-size:\s*(?:0?\.(?:625|6875|71875|95|96)rem|(?:9|10|11)px)\s*;/,
            'public readable CSS must not use 9/10/11px or sub-12px rem typography'
        );
    }

    const markdownCss = read(markdownCssPath);
    const paragraphRuleCount = markdownCss.match(/^\.markdown-body p\s*\{/gm)?.length ?? 0;
    if (paragraphRuleCount !== 1)
    {
        fail(markdownCssPath, 1, 'Markdown paragraph spacing must have one authoritative rule');
    }
    assertContains(
        markdownCssPath,
        /\.markdown-body\s*\{[\s\S]*?font-size:\s*1rem;[\s\S]*?line-height:\s*1\.8;/,
        'Markdown reading body must use the 16px/1.8 canonical reading scale'
    );
    assertContains(
        markdownRendererPath,
        /:class="\{\s*'markdown-body--article': props\.mode === 'article',\s*'markdown-body--document': props\.mode === 'about',\s*'markdown-body--preview': props\.mode === 'preview' \|\| props\.mode === 'editor'\s*\}"/,
        'MarkdownRenderer must expose article, document, and preview ownership on one reading surface'
    );
    assertContains(
        markdownCssPath,
        /\.markdown-body--document\s*\{[^}]*text-align:\s*left;[^}]*letter-spacing:\s*normal;[^}]*text-autospace:\s*normal;/,
        'document Markdown must use left alignment and natural character spacing'
    );
    assertContains(
        markdownCssPath,
        /\.markdown-body--document \.markdown-renderer__text\s*\{[^}]*text-align:\s*left;[^}]*letter-spacing:\s*normal;/,
        'document Markdown must override the nested renderer text spacing'
    );
    assertContains(
        markdownCssPath,
        /\.markdown-body--document p\s*\{[^}]*text-indent:\s*0;/,
        'document Markdown paragraphs must keep legal clauses flush left'
    );
    assertContains(
        markdownCssPath,
        /\.markdown-body--document ul,\s*\.markdown-body--document ol\s*\{[^}]*margin:\s*1\.5rem 0;[^}]*padding-left:\s*1\.5em;/,
        'document Markdown lists must align their marker column with the document edge'
    );

    assertContains(
        themeTokensPath,
        /const metadataText = `text-xs sm:text-sm leading-\[1\.5\][^`]*normal-case/,
        'article detail metadata must use the readable 12px/14px natural-case role scale'
    );
    assertContains(
        themeTokensPath,
        /title: `ui-article-title text-lg sm:text-xl lg:text-2xl[\s\S]*?leading-\[1\.25\] sm:leading-\[1\.2\]/,
        'public article list titles must use the 18/20/24px scale with readable multiline leading'
    );
    assertContains(
        themeTokensPath,
        /articleDetail:\s*\{[\s\S]*?title: `text-2xl sm:text-3xl font-bold[^`]*leading-\[1\.25\] sm:leading-\[1\.2\]/,
        'hydrated article detail titles must use the 24/30px page scale, loaded 700 weight, and responsive multiline leading'
    );
    assertContains(
        themeTokensPath,
        /summary: `ui-article-summary mt-2 text-sm sm:text-base font-normal[\s\S]*?leading-\[1\.7\]/,
        'public article list summaries must use the stable 14/16px, 400 weight, 1.7 leading role'
    );
    assertContains(
        themeTokensPath,
        /metaCategory: `ui-article-category inline-flex min-h-9 items-center -mx-1 px-1[\s\S]*?outline-none \$\{focusRing\}/,
        'public article category links must retain a 36px mobile touch target and visible focus treatment'
    );
    assertNotContains(
        themeTokensPath,
        /metaCategory: `[^`]*\bsm:min-h-[0-8]\b/,
        'public article category links must not shrink below the 36px touch target at larger breakpoints'
    );
    assertContains(
        themeTokensPath,
        /articleDetail:\s*\{[\s\S]*?categoryLink: `inline-flex min-h-11 min-w-11[^`]*normal-case[\s\S]*?outline-none \$\{focusRing\}/,
        'article detail category links must retain a 44px hit target, natural casing, and visible focus treatment'
    );
    assertContains(
        themeTokensPath,
        /tagLink: `inline-flex min-h-11 min-w-11[^`]*normal-case[\s\S]*?outline-none \$\{focusRing\}/,
        'article detail tags must retain a 44px hit target, natural casing, and visible focus treatment'
    );
    assertContains(
        publicArticleListPath,
        /class="public-article-tag el-tag el-tag--small el-tag--light inline-flex min-h-\[32px\] items-center px-2"[\s\S]*?:class="themeTokens\.focusRing"/,
        'public article-list tags must retain a 32px centered hit target and shared inset focus ring'
    );
    assertContains(
        publicArticleListPath,
        /\.public-article-tag\s*\{[\s\S]*?min-height:\s*32px;[\s\S]*?padding-inline:\s*8px;/,
        'public article-list tag geometry must override the 20px small-tag default'
    );
    assertContains(
        publicArticleListPath,
        /\.public-article-tag:focus-visible\s*\{[\s\S]*?box-shadow:\s*inset 0 0 0 2px var\(--fsusblog-color-focus-ring\);[\s\S]*?outline:\s*none;/,
        'public article-list tag focus must override the FsusUI el-tag shadow reset without clipping'
    );

    const publicShellCriticalCss = read(publicShellCriticalCssPath);
    const publicShellEmergencyCss = read(publicShellEmergencyCssPath);
    for (const file of [
        publicPageCssPath,
        publicShellCriticalCssPath,
        publicShellEmergencyCssPath
    ])
    {
        assertContains(file, /--fsusblog-color-focus-ring:\s*var\(--fsus-color-primary, #2A599C\);/, 'focus ring must map to Scholarly Blue');
    }
    assertContains(
        themeTokensPath,
        /focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-\[var\(--fsusblog-color-focus-ring\)\] focus-visible:outline-none/,
        'shared focus utility must use a 2px inset Scholarly Blue ring'
    );
    for (const file of [publicPageCssPath, publicShellCriticalCssPath, publicShellEmergencyCssPath])
    {
        assertContains(
            file,
            /@media \(forced-colors: active\)[\s\S]*?outline:\s*2px solid Highlight;[\s\S]*?outline-offset:\s*-2px;/,
            'public custom focus must retain a system outline in forced-colors mode'
        );
    }
    assertContains(
        accountNavigationPanelPath,
        /@media \(forced-colors: active\)[\s\S]*?\.account-module-link:focus-visible,[\s\S]*?\.account-local-navigation__link:focus-visible[\s\S]*?outline:\s*2px solid Highlight;[\s\S]*?outline-offset:\s*-2px;/,
        'account navigation focus must retain a system outline in forced-colors mode'
    );

    for (const file of walkTouchTargetSources(productionSourceRoot))
    {
        const source = read(file);
        for (const match of source.matchAll(/:focus-visible[^{}]*\{[^}]*outline-offset:\s*(?:2|4)px/gs))
        {
            fail(file, lineNumberFromSource(source, match.index ?? 0), 'custom focus must use the shared inset ring without a positive outline offset');
        }
        for (const match of source.matchAll(/:focus-visible[^{}]*\{[^}]*box-shadow:\s*0 0 0 2px var\(--fsusblog-color-focus-ring\)/gs))
        {
            fail(file, lineNumberFromSource(source, match.index ?? 0), 'custom focus ring must be inset');
        }
    }
    const requiredTokenAssignments = [
        '--text-tertiary: #71717A;',
        '--text-muted: #62626A;',
        '--text-decorative: #A1A1AA;',
        '--text-tertiary: #A1A1AA;',
        '--text-muted: #B2B2BA;',
        '--text-decorative: #71717A;',
        '--fsus-dot-gray: var(--text-decorative);',
        '--fsusblog-reading-marker: var(--text-decorative);',
        '--fsusblog-text-subtle: var(--fsus-color-text-decorative, var(--text-decorative, #A1A1AA));',
        '--fsusblog-text-muted: var(--fsus-color-text-muted, var(--text-muted, #71717A));'
    ];
    for (const token of requiredTokenAssignments)
    {
        assertContains(publicPageCssPath, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `public token contract is missing ${token}`);
    }
    for (const token of [
        '--text-tertiary: #71717A;',
        '--text-muted: #62626A;',
        '--text-decorative: #A1A1AA;',
        '--text-tertiary: #A1A1AA;',
        '--text-muted: #B2B2BA;',
        '--text-decorative: #71717A;',
        '--fsus-dot-gray: var(--text-decorative);',
        '--fsusblog-text-subtle: var(--fsus-color-text-decorative-dark, var(--text-decorative, #71717A));',
        '--fsusblog-text-muted: var(--fsus-color-text-muted-dark, var(--text-muted, #A1A1AA));'
    ])
    {
        assertContains(publicShellCriticalCssPath, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `critical public shell token contract is missing ${token}`);
    }
    assertContains(mainCssPath, /--fsus-dot-gray:\s*var\(--text-decorative\);/, 'hydrated public shell must keep dot gray decorative-only');
    assertContains(publicShellEmergencyCssPath, /--fsus-dot-gray:\s*var\(--text-decorative\);/, 'emergency public shell must keep dot gray decorative-only');

    for (const [foreground, background, role] of [
        ['#71717A', '#F7F7F8', 'light tertiary information'],
        ['#62626A', '#F7F7F8', 'light muted information'],
        ['#A1A1AA', '#09090B', 'dark tertiary information'],
        ['#B2B2BA', '#09090B', 'dark muted information']
    ])
    {
        const ratio = contrastRatio(foreground, background);
        if (ratio < 4.5)
        {
            fail(publicPageCssPath, 1, `${role} contrast must meet WCAG AA 4.5:1; got ${ratio.toFixed(2)}:1`);
        }
    }

    for (const [file, source] of [
        [publicShellCriticalCssPath, publicShellCriticalCss],
        [publicShellEmergencyCssPath, publicShellEmergencyCss]
    ])
    {
        assertContains(file, /#fsus-aot-shell \.ui-article-list\s*\{[\s\S]*?gap:\s*2\.5rem;/, 'AOT article list feed must use 40px group separation');
        assertContains(file, /@media \(min-width: 640px\)\s*\{[\s\S]*?#fsus-aot-shell \.ui-article-list\s*\{[\s\S]*?gap:\s*3rem;/, 'AOT article list feed must use 48px group separation at the small breakpoint');
        assertContains(file, /#fsus-aot-shell \.ui-article-title\s*\{[\s\S]*?font-size:\s*1\.125rem;[\s\S]*?line-height:\s*1\.25;/, 'AOT article list title must match the 18px display baseline');
        assertContains(file, /@media \(min-width: 640px\)\s*\{[\s\S]*?#fsus-aot-shell \.ui-article-title\s*\{[\s\S]*?font-size:\s*1\.25rem;[\s\S]*?line-height:\s*1\.2;/, 'AOT article list title must match the 20px display breakpoint');
        assertContains(file, /@media \(min-width: 1024px\)\s*\{[\s\S]*?#fsus-aot-shell \.ui-article-title\s*\{[\s\S]*?font-size:\s*1\.5rem;/, 'AOT article list title must match the 24px display breakpoint');
        assertContains(file, /#fsus-aot-shell \.ui-article-summary\s*\{[\s\S]*?font-size:\s*14px;[\s\S]*?line-height:\s*1\.7;[\s\S]*?font-weight:\s*400;/, 'AOT article list summary must match the 14px, 400 weight, 1.7 leading baseline');
        assertContains(file, /@media \(min-width: 640px\)\s*\{[\s\S]*?#fsus-aot-shell \.ui-article-summary\s*\{[\s\S]*?font-size:\s*16px;/, 'AOT article list summary must match the 16px reading breakpoint');
        assertContains(file, /#fsus-aot-shell \.ui-article-meta[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*1rem;/, 'AOT metadata must match the 12px readable metadata baseline');
        assertContains(file, /#fsus-aot-shell \.ui-article-meta,[\s\S]*?#fsus-aot-shell \.ui-article-link\s*\{[\s\S]*?text-transform:\s*none;/, 'AOT article list metadata and CTA must not use uppercase');
        assertContains(file, /#fsus-aot-shell \.ui-article-link\s*\{[\s\S]*?color:\s*var\(--fsusblog-text-muted, GrayText\);/, 'AOT article list CTA must use the muted role by default');
        assertContains(file, /#fsus-aot-shell \.ui-article-link:hover,[\s\S]*?#fsus-aot-shell \.ui-article-link:focus-visible\s*\{[\s\S]*?color:\s*var\(--fsusblog-color-primary, LinkText\);/, 'AOT article list CTA must use Scholarly Blue for interaction feedback');
        if (source.includes('font-size: 1.35rem;') || source.includes('font-size: .96rem;'))
        {
            fail(file, 1, 'AOT typography must not retain non-contract 1.35rem or .96rem scales');
        }
    }

    assertContains(
        readingTypographyPath,
        /## Display、reading 与 metadata[\s\S]*?display[\s\S]*?reading[\s\S]*?metadata/,
        'reading typography authority must document display, reading, and metadata roles'
    );
    assertContains(
        pageTitleScalePath,
        /页面级标题统一使用[\s\S]*?24\/30px[\s\S]*?`text-4xl`/,
        'page-title authority must document the bounded H1 scale and oversized utility ban'
    );
}

function checkIssueDensityContracts()
{
    assertContains(accountShellBasePath, /\.account-skip-link:focus-visible\s*\{/, 'account skip-link must reveal only on :focus-visible');
    assertNotContains(accountShellBasePath, /\.account-skip-link:focus\s*\{/, 'account skip-link must not use mouse-triggered :focus');
    assertContains(accountShellBasePath, /\.account-skip-link:focus-visible\s*\{[\s\S]*?font-size:\s*12px;/, 'account skip-link must use the 12px readable text scale');
    assertNotContains(accountShellBasePath, /disabled:opacity-40/, 'account header/meta links must not use 40% disabled opacity');
    assertNotContains(accountShellBasePath, /\.account-header-link\s*\{[\s\S]*?\bmin-h-9\b/, 'account main-site header action must not use the retired 36px tier');
    assertContains(accountShellBasePath, /\.account-header-link\s*\{[\s\S]*?min-width:\s*var\(--fsus-control-height-compact\);[\s\S]*?min-height:\s*var\(--fsus-control-height-compact\);/, 'account desktop main-site action must consume the 40px compact control token');
    assertContains(accountShellBasePath, /\.account-header-link--mobile\s*\{[\s\S]*?min-width:\s*var\(--fsus-control-height\);[\s\S]*?min-height:\s*var\(--fsus-control-height\);/, 'account mobile main-site action must consume the 44px default control token');
    assertContains(accountLayoutPath, /<ThemeModeToggle[\s\S]*?class="account-header-theme-action"[\s\S]*?variant="menu-button"/, 'account desktop theme action must use the low-noise FsusUI menu-button variant');
    assertContains(accountLayoutPath, /account-header-theme-action--mobile[\s\S]*?variant="menu-button"/, 'account mobile theme action must use the low-noise FsusUI menu-button variant');
    assertContains(accountShellBasePath, /\.account-mobile-drawer-trigger\s*\{[\s\S]*?width:\s*var\(--fsus-control-height\);[\s\S]*?min-height:\s*var\(--fsus-control-height\);/, 'account mobile drawer trigger must consume the 44px default control token from the shared base layer');
    assertContains(accountMobileActionPath, /aria-controls="account-mobile-drawer"[\s\S]*?:aria-expanded="mobileDrawerVisible"/, 'account mobile drawer trigger must expose its controlled expanded state');
    assertContains(accountHeaderMenuPath, /\.account-header-menu__trigger\s*\{[\s\S]*?min-height:\s*var\(--fsus-control-height-compact\);[\s\S]*?min-width:\s*var\(--fsus-control-height-compact\);/, 'account desktop menu trigger must consume the 40px compact control token');
    assertContains(accountHeaderMenuPath, /\.account-header-menu__trigger--touch\s*\{[\s\S]*?min-height:\s*var\(--fsus-control-height\);[\s\S]*?min-width:\s*var\(--fsus-control-height\);/, 'account mobile menu trigger must consume the 44px default control token');
    assertContains(accountHeaderMenuPath, /\.account-header-menu__trigger\[aria-expanded="true"\]/, 'account menu trigger must keep a distinguishable expanded state');
    assertContains(accountShellBasePath, /@media \(forced-colors:\s*active\)[\s\S]*?outline:\s*2px solid Highlight;/, 'account shared header actions must retain a visible system focus outline in forced-colors mode');
    assertContains(accountHeaderMenuPath, /@media \(forced-colors:\s*active\)[\s\S]*?outline:\s*2px solid Highlight;/, 'account menu trigger must retain a visible system focus outline in forced-colors mode');
    assertContains(accountRouteFramePath, /<ElDrawer[\s\S]*?id="account-mobile-drawer"[\s\S]*?<\/ElDrawer>/, 'account route frame mobile navigation must use a drawer that carries the account sidebar visual language');
    assertContains(accountLayoutPath, /<RouterView name="accountMobileAction" \/>/, 'AccountLayout must host the active frame mobile action without duplicating the header');
    assertContains(accountMobileActionPath, /account-mobile-drawer-trigger/, 'active account frame must expose a compact drawer trigger');
    assertContains(accountRouteFramePath, /<AccountNavigationPanel[\s\S]*?variant="mobile"/, 'account route frame drawer must reuse the module and local navigation panel');
    assertContains(accountRouteFramePath, /:motion="fsusBlogMotionPresets\.mobileDrawer"/, 'account route frame drawer must use the shared mobile drawer motion preset');
    assertNotContains(accountRouteFramePath, /FsusUiSegmentedControl/, 'account route frame navigation must not use segmented-control as a separate visual language');
    assertNotContains(accountRouteFramePath, /account-mobile-more-strip|mobileOverflowGroups|mobileMoreOpen/, 'account route frame navigation must stay two-level and must not reintroduce an overflow group row');
    assertNotContains(accountRouteFramePath, /account-mobile-link-strip/, 'account route frame navigation must not use a separate horizontal tab strip');
    assertContains(taskPageHeaderAdapterPath, /FsusTaskPageHeader\s+as\s+FsusUiTaskPageHeader/, 'Account task pages must consume the canonical FsusUI task-page header through the boundary');
    assertContains(accountShellBasePath, /\.account-task-page-header\s*\{[^}]*margin-bottom:\s*var\(--fsus-space-6\);/, 'Account base may retain only the Blog-owned header-to-content composition margin');
    assertNotContains(accountShellBasePath, /\.account-page-(?:header|title|description)\b/, 'Account base must not duplicate canonical task-page header visuals');
    assertContains(identityCenterPath, /<FsusUiTaskPageHeader[\s\S]*?:title="sectionMeta\.title"[\s\S]*?:description="sectionMeta\.description"/, 'IdentityCenter must expose the route heading through the canonical task-page header');
    assertNotContains(identityCenterPath, /identity-section-header__copy|font-size:\s*1\.875rem/, 'IdentityCenter must not keep a local task-page title implementation');
    assertContains(accountNavigationPanelPath, /\.account-module-link,[\s\S]*?\.account-local-navigation__link\s*\{[\s\S]*?min-height:\s*2\.75rem;/, 'AccountLayout mobile drawer module and local links must provide 44px hit targets');
    assertContains(accountNavigationPanelPath, /account-global-module-nav[\s\S]*account-local-navigation/, 'Account navigation must separate first-level modules from current-module local links');
    assertContains(accountNavigationPanelPath, /\.account-sidebar-index-label,[\s\S]*?font-size:\s*11px;[\s\S]*?font-weight:\s*700;[\s\S]*?text-transform:\s*uppercase;/, 'Account navigation group labels must keep the 11px bold uppercase hierarchy role');
    assertContains(accountNavigationPanelPath, /\.account-module-link__label\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*500;/, 'Account first-level modules must keep the 13px/500 inactive hierarchy role');
    assertContains(accountNavigationPanelPath, /\.account-local-navigation__link > span:first-child\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*500;/, 'Account local links must keep the 13px/500 inactive hierarchy role');
    assertContains(accountNavigationPanelPath, /\.account-module-link-active \.account-module-link__label,[\s\S]*?font-weight:\s*700;/, 'Account active navigation items must keep the 13px/700 hierarchy role');
    assertContains(accountNavigationPanelPath, /\.account-module-link::before,[\s\S]*?width:\s*2px;[\s\S]*?background:\s*var\(--fsusblog-color-primary\);/, 'Account navigation must keep a 2px primary active indicator');
    assertContains(accountNavigationPanelPath, /\.account-module-link-active::before,[\s\S]*?\.account-local-navigation__link--active::before\s*\{[^}]*opacity:\s*1;/, 'Account active navigation items must reveal the primary indicator');
    assertNotContains(accountNavigationPanelPath, /(?:hover|focus-visible)::before/, 'Account hover and focus states must not reuse the active indicator');
    assertContains(accountNavigationPanelPath, /\.account-global-module-list,[\s\S]*?gap:\s*var\(--fsus-space-1\);/, 'Account global navigation items must retain the four-pixel rhythm');
    assertContains(accountNavigationPanelPath, /\.account-local-navigation\s*\{[\s\S]*?margin-top:\s*var\(--fsus-space-6\);/, 'Account local navigation must remain one 24px section step below global modules');
    assertContains(accountNavigationPanelPath, /\.account-local-navigation__title\s*\{[^}]*\}\s*\.account-local-navigation__link\s*\{[^}]*padding:\s*var\(--fsus-space-1\) var\(--fsus-space-2\) var\(--fsus-space-1\) var\(--fsus-space-8\);/, 'Account local links must indent one tokenized 16px step beyond first-level modules');
    assertContains(accountNavigationPanelPath, /\.account-navigation-panel\[data-variant="desktop"\] \.account-local-navigation__link\s*\{[^}]*min-height:\s*2\.5rem;/, 'Account desktop local links must use the 40px compact tier without shrinking mobile targets');
    assertNotContains(accountRouteFramePath, /account-sidebar-scroll|\.account-sidebar-frame\s*\{[^}]*overflow-y:\s*auto;/s, 'desktop account sidebar must not create an internal scrollbar from leaf navigation');
    assertContains(accountHeaderMenuPath, /打开账号菜单[\s\S]*使用规范[\s\S]*隐私政策[\s\S]*command="logout"/, 'account menu must own policy and logout actions');
    assertContains(accountLayoutPath, /<template #desktop-actions>[\s\S]*?class="account-header-locale-action"[\s\S]*?\bbordered\b[\s\S]*?<\/template>/, 'account desktop locale action must join the bordered action family');
    assertNotContains(accountLayoutPath, /<template #mobile-primary-actions>[\s\S]*?account-header-locale-action[\s\S]*?<\/template>/, 'account mobile locale action must not inherit the desktop-only bordered hook');
    assertContains(accountShellBasePath, /\.account-site-header__actions \.account-header-link,[\s\S]*?\.account-header-theme-action > button,[\s\S]*?\.account-header-locale-action\.fsusblog-locale-toggle,[\s\S]*?\.account-header-menu__trigger\.account-header-menu__trigger[\s\S]*?height:\s*var\(--fsus-control-height-compact\);[\s\S]*?border:\s*1px solid var\(--fsusblog-panel-border\);/, 'account desktop actions must share the 40px bordered paper treatment');
    assertContains(accountShellBasePath, /\.account-site-header__actions \.account-header-link:hover,[\s\S]*?border-color:\s*var\(--fsusblog-color-primary\);[\s\S]*?background:\s*var\(--fsusblog-page-bg-soft\);/, 'account desktop actions must share the restrained hover treatment');
    assertContains(accountShellBasePath, /@media \(min-width: 1024px\)[\s\S]*?\.account-route-frame\s*\{[\s\S]*?gap:\s*var\(--fsus-space-8\);[\s\S]*?padding-inline:\s*var\(--fsus-space-6\);/, 'account desktop frame must use the 32px gap and 24px horizontal inset');
    assertNotContains(accountShellBasePath, /calc\(var\(--fsus-space-5\) \* 2\)/, 'account desktop frame must not restore the non-tokenized 40px calculation');
    assertContains(accountShellBasePath, /\.account-shell\s*\{[\s\S]*?--fsusblog-account-header-height:\s*5\.5625rem;/, 'account shell must expose the measured 89px header token');
    assertContains(accountShellBasePath, /max-height:\s*calc\(100dvh - var\(--fsusblog-account-header-height\) - var\(--fsus-space-8\) - var\(--fsus-space-8\)\);/, 'account desktop scroll region must derive from measured header and tokenized insets');
    assertNotContains(accountShellBasePath, /max-height:\s*calc\(100dvh - 7rem\);/, 'account desktop scroll region must not restore the hard-coded offset');
    assertContains(accountRouteFramePath, /<template #header="\{ titleId, titleClass \}">[\s\S]*?\[titleClass, 'account-mobile-drawer__title'\]/, 'account drawer must own its title through the public header slot');
    assertContains(accountShellBasePath, /\.account-mobile-drawer__title\s*\{[\s\S]*?margin:\s*0;[\s\S]*?color:\s*var\(--fsusblog-text-primary\);[\s\S]*?font-size:\s*16px;[\s\S]*?font-weight:\s*700;/, 'account drawer title must retain its explicit hierarchy');
    assertContains(accountShellBasePath, /\.account-mobile-drawer\s*\{[\s\S]*?--el-drawer-padding-primary:\s*var\(--fsus-space-5\);/, 'account drawer must configure its 20px inset through the public token');
    assertNotContains(accountShellBasePath, /\.el-drawer__(?:header|title)/, 'account shell must not reach into FsusUI drawer internals');
    assertContains(siteChromeHeaderAdapterPath, /:class="`site-chrome-header__brand-mark--\$\{brandContext\}`"/, 'site chrome brand mark must expose its context modifier');
    assertContains(siteChromeHeaderAdapterPath, /\.site-chrome-header__brand-mark\s*\{[\s\S]*?max-width:\s*min\(14rem, 42vw\);/, 'site chrome default wordmark must retain its public width cap');
    assertContains(siteChromeHeaderAdapterPath, /\.site-chrome-header__brand-mark--account\s*\{[\s\S]*?max-width:\s*min\(10rem, 32vw\);/, 'site chrome account wordmark must retain its tighter width cap');
    assertNotContains(siteChromeHeaderAdapterPath, /\.site-chrome-header__brand-mark--public\s*\{/, 'site chrome public wordmark must keep the shared default rather than a forked override');
    assertContains(path.join(repoRoot, 'docs/frontend/account-navigation.md'), /Desktop[\s\S]*Mobile[\s\S]*exactly one Drawer[\s\S]*44px/, 'account navigation authority must document the single-drawer module navigation pattern');

    assertNotContains(registerPath, /高级|极致|奢华|未来感|智能|大气|简约而不简单|沉浸式/, 'Register copy must avoid FsusUI marketing adjective blacklist');
    const registerCopyPath = path.join(repoRoot, 'src/frontend/src/copy/auth.ts');
    assertContains(registerCopyPath, /TOTP 可在账户设置中作为二次验证启用/, 'Register copy must describe TOTP as optional two-step verification (in @/copy auth registry)');
    assertNotContains(registerPath, /min-height:\s*36px;/, 'Register inline policy action must use at least 40px hit target');
    assertContains(registerPath, /min-height:\s*40px;/, 'Register inline policy action must use the compact 40px control height');

    assertNotContains(path.join(repoRoot, 'src/frontend/src/components/admin/AdminSegmentedControl.vue'), /\bmin-h-8\b/, 'Admin segmented controls must not use 32px hit targets');
    assertContains(path.join(repoRoot, 'src/frontend/src/components/admin/AdminSegmentedControl.vue'), /\bmin-h-10\b/, 'Admin segmented controls must use at least 40px hit targets');
    assertNotContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleImageLightbox.vue'), /min-height:\s*2\.5rem;/, 'Article lightbox controls must use the 44px default control height');
    assertContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleImageLightbox.vue'), /min-height:\s*2\.75rem;/, 'Article lightbox controls must use the 44px default control height');
    assertNotContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleTocPanel.vue'), /min-height:\s*2\.25rem;|font-size:\s*0\.71875rem;/, 'Article TOC controls must use 40px hit targets and the 12px small text scale');
    assertContains(path.join(repoRoot, 'src/frontend/src/components/article/ArticleTocPanel.vue'), /min-height:\s*2\.5rem;/, 'Article TOC controls must use the 40px compact height');

    assertNotContains(homeTextFirstRecommendationsPath, /\bmb-16\b|\bsm:mb-20\b|\bmin-h-24\b|\bgap-5\b/, 'Home text-first recommendations must stay within compact list density');
    assertContains(homeTextFirstRecommendationsPath, /home-text-first-recommendations mb-8 sm:mb-10/, 'Home text-first recommendations must keep section-to-feed spacing at 32/40px');
    assertContains(homeTextFirstRecommendationsPath, /\bmin-h-16\b/, 'Home text-first recommendation rows must use compact 64px list density');
    assertContains(homeTextFirstRecommendationsPath, /grid gap-3 sm:grid-cols-2 sm:gap-4/, 'Home text-first recommendation row gaps must use 12/16px list spacing');
    assertNotContains(themeTokensPath, /articleList:\s*\{[\s\S]*?container:\s*'[^']*\b(?:gap-20|sm:gap-28|lg:gap-32)\b[^']*'/, 'Public article list feed spacing must not use large editorial gaps');
    assertContains(themeTokensPath, /articleList:\s*\{[\s\S]*?container:\s*'flex flex-col gap-10 sm:gap-12'/, 'Public article list feed spacing must use 40/48px group separation');
    assertContains(publicArticleListPath, /class="ui-article-list"\s+:class="themeTokens\.articleList\.container"/, 'PublicArticleList must expose the AOT/hydration list spacing hook');
    assertNotContains(themeTokensPath, /articleList:\s*\{[\s\S]*?metaRow:\s*`[^`]*\buppercase\b[^`]*`/, 'Public article list metadata must not use uppercase');
    assertNotContains(themeTokensPath, /articleList:\s*\{[\s\S]*?readLink:\s*`[^`]*\buppercase\b[^`]*`/, 'Public article list CTA must not use uppercase');
    assertContains(themeTokensPath, /articleList:\s*\{[\s\S]*?readLink:\s*`[^`]*\$\{textMuted\}[^`]*\$\{primaryHover\}[^`]*`/, 'Public article list CTA must stay muted until the Scholarly Blue hover state');

    assertNotContains(adminDashboardPath, /DashboardAuthorAnalyticsPanel|DashboardCommentModerationPanel|DashboardQuickActionsPanel|DashboardPopularArticles|DashboardRecentComments|访客来源|地域访问/, 'ManageDashboard must stay a lightweight overview and link out to dedicated workspaces');
    assertContains(adminDashboardPath, /AdminDashboardTaskWorkbench/, 'ManageDashboard must delegate rendering to the task-first workbench');
    assertContains(adminDashboardWorkbenchPath, /今日待处理[\s\S]*dashboard-task-list[\s\S]*站点摘要[\s\S]*dashboard-stat-ledger/, 'ManageDashboard workbench must keep tasks before its compact summary ledger');
    assertContains(adminDashboardWorkbenchPath, /<dl class="dashboard-stat-ledger" aria-label="站点统计摘要">/, 'ManageDashboard summary must use definition-list semantics');
    assertContains(adminDashboardWorkbenchPath, /帮助与反馈[\s\S]*帮助与反馈入口/, 'ManageDashboard feedback must live behind a help disclosure');
    assertNotContains(adminDashboardWorkbenchPath, /dashboard-stat-card|<el-icon|GitHub|Issue|仓库维护/, 'ManageDashboard must not restore icon KPI cards or repository maintenance copy');
    assertNotContains(adminDashboardWorkbenchPath, /DashboardAuthorAnalyticsPanel|DashboardCommentModerationPanel|DashboardQuickActionsPanel|DashboardPopularArticles|DashboardRecentComments|累计阅读|totalReads|RUM|AOT|访客来源|地域访问/, 'ManageDashboard workbench must not absorb reading, runtime, traffic analytics, or legacy panels');
    assertContains(adminAnalyticsPath, /DashboardAuthorAnalyticsPanel/, 'ManageAnalytics must own the author analytics panel');
    assertContains(adminAnalyticsPath, /访客来源[\s\S]*地域访问/, 'ManageAnalytics must own traffic source and region panels');
    assertContains(path.join(repoRoot, 'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'), /AdminStatusMatrix/, 'ManageAnalytics content and technical metrics must use FsusBlog AdminStatusMatrix compact density');
    assertNotContains(path.join(repoRoot, 'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'), /FsusUiMetricList|FsusUiMetricItem/, 'ManageAnalytics content and technical metrics must not use the generic FsusUI metric-list control');
    assertNotContains(path.join(repoRoot, 'src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue'), /text-2xl|class="[^"]*\bp-6\b[^"]*"[\s\S]{0,240}\{\{\s*metric\.value\s*\}\}/, 'ManageAnalytics metrics must not regress to large KPI cards');

    for (const relativePath of dashboardDensityFiles)
    {
        const file = path.join(repoRoot, relativePath);
        assertNotContains(file, /\b(?:mb-12|mb-16|p-8|min-h-60|min-h-72|min-h-\[(?:18\.75rem|320px)\])\b|min-height:\s*9rem/, 'admin dashboard task surfaces must stay within 32px spacing and compact panel density');
    }

    const densityScaleFiles = new Map([
        ['src/frontend/src/components/user/UserCommentsErrorState.vue', [/font-size:\s*0\.9375rem;/, /font-size:\s*0\.8125rem;/]],
        ['src/frontend/src/components/user/UserCommentsEmptyState.vue', [/font-size:\s*0\.9375rem;/, /font-size:\s*0\.8125rem;/]],
        ['src/frontend/src/components/user/messages/MessagesEmptyState.vue', [/font-size:\s*0\.9375rem;/, /font-size:\s*0\.8125rem;/]],
        ['src/frontend/src/components/user/messages/MessagesConversationList.vue', [/font-size:\s*0\.9375rem;/]],
        ['src/frontend/src/components/user/messages/MessagesThreadPanel.vue', [/font-size:\s*0\.95rem;/, /font-size:\s*0\.6875rem;/]],
        ['src/frontend/src/layouts/AccountLayout.vue', [/font-size:\s*0\.(?:625|6875|8125)rem;/]],
        ['src/frontend/src/components/article/ArticleImageLightbox.vue', [/font-size:\s*0\.8125rem;/]],
        ['src/frontend/src/components/article/ArticleTocPanel.vue', [/font-size:\s*0\.(?:6875|71875)rem;/]],
        ['src/frontend/src/components/admin/article/ArticleSeoPreviewPanel.vue', [/font-size:\s*0\.(?:62|68|72|82|92)rem;/]],
        ['src/frontend/src/components/admin/article/ArticleWriteSidebar.vue', [/font-size:\s*0\.(?:72|82|86)rem;/]],
        ['src/frontend/src/components/admin/article/ArticleRevisionPanel.vue', [/font-size:\s*0\.78rem;/]],
        ['src/frontend/src/views/admin/article/Write.vue', [/font-size:\s*0\.(?:6875|72|78|82)rem;/]]
    ]);
    for (const [relativePath, patterns] of densityScaleFiles)
    {
        const file = path.join(repoRoot, relativePath);
        for (const pattern of patterns)
        {
            assertNotContains(file, pattern, 'issue #722 governed typography must use 12/14/16px scale values');
        }
    }
}

function checkAdminColorGovernance()
{
    const governedFiles = [
        'src/frontend/src/components/admin/AdminStatusMatrix.vue',
        'src/frontend/src/views/admin/moderation/ModerationLayout.vue',
        'src/frontend/src/views/admin/moderation/ModerationDashboard.vue',
        'src/frontend/src/views/admin/moderation/ModerationModel.vue',
        'src/frontend/src/views/admin/moderation/ModerationReplay.vue',
        'src/frontend/src/views/admin/moderation/ModerationDictionaries.vue',
        'src/frontend/src/views/admin/security/SecurityLayout.vue',
        'src/frontend/src/views/admin/Settings.vue',
        'src/frontend/src/components/admin/users/UserBanDialog.vue'
    ];

    assertContains(
        adminWorkspaceCssPath,
        /--fsusblog-admin-status-success:/,
        'account/admin shells must expose muted admin status tokens for task surfaces'
    );
    assertContains(
        adminWorkspaceCssPath,
        /\.admin-muted-alert\s*\{/,
        'account/admin shells must expose a muted alert primitive for non-critical task notices'
    );

    for (const relativePath of governedFiles)
    {
        const file = path.join(repoRoot, relativePath);
        assertNotContains(
            file,
            /border-l-4\s+border-\[var\(--fsusblog-color-(?:primary|success|warning|error|danger)\)\]/,
            'admin task notices must not use high-saturation 4px semantic rails'
        );
    }

    const statusMatrixPath = path.join(repoRoot, 'src/frontend/src/components/admin/AdminStatusMatrix.vue');
    assertNotContains(
        statusMatrixPath,
        /border-left-color:\s*var\(--fsusblog-color-(?:success|warning|error|primary)\)/,
        'AdminStatusMatrix must not use high-saturation semantic rails for repeated status cells'
    );
    assertNotContains(
        statusMatrixPath,
        /background:\s*var\(--fsusblog-color-(?:success|warning|error|primary)\)/,
        'AdminStatusMatrix bars and dots must use muted admin status tokens'
    );
    assertContains(
        statusMatrixPath,
        /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*14rem\),\s*1fr\)\);/,
        'AdminStatusMatrix compact cells must keep enough column width for label/value/helper text'
    );
    assertContains(
        statusMatrixPath,
        /min-height:\s*64px;/,
        'AdminStatusMatrix compact cells must not compress label, value, and helper copy into a 44px row'
    );
    assertContains(
        statusMatrixPath,
        /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(3ch,\s*auto\);/,
        'AdminStatusMatrix compact cells must align labels and right-side numeric values'
    );
    assertContains(
        statusMatrixPath,
        /justify-self:\s*end;/,
        'AdminStatusMatrix compact values must not sit directly after the label text'
    );
    assertNotContains(
        statusMatrixPath,
        /admin-status-matrix--compact[\s\S]{0,260}min-height:\s*44px;/,
        'AdminStatusMatrix compact cells must not regress to the over-compressed 44px layout'
    );

    const motionPath = path.join(repoRoot, 'src/frontend/src/assets/motion.css');
    assertNotContains(
        motionPath,
        /--blog-motion-highlight-(?:bg|border):\s*color-mix\(in srgb, var\(--fsusblog-color-primary[^)]*\)\s+(?:[7-9]|[1-9]\d)%/,
        'blog motion highlight must keep primary tint below the large-area task-surface threshold'
    );
    assertNotContains(
        motionPath,
        /color-mix\(in srgb, var\(--fsusblog-color-error[^)]*\)\s+(?:[7-9]|[1-9]\d)%/,
        'blog motion error feedback must use muted danger tokens instead of bright large-area error tint'
    );
}

function checkAdminStatusDensityGovernance()
{
    const governedRoots = [
        'src/frontend/src/views/admin/moderation',
        'src/frontend/src/views/admin/security'
    ].map((dir) => path.join(repoRoot, dir));

    for (const file of governedRoots.flatMap((dir) => walk(dir)))
    {
        const source = read(file);
        const largeMetricCardPattern = /class="[^"]*\bgrid\b[^"]*\b(?:md|lg):grid-cols-[^"]*"[\s\S]{0,700}<div\s+v-for="[^"]+"[^>]*class="[^"]*\bp-5\b[^"]*"[\s\S]{0,500}\btext-2xl\b/;
        const match = largeMetricCardPattern.exec(source);
        if (match?.index !== undefined)
        {
            fail(
                file,
                lineNumberFromSource(source, match.index),
                'admin moderation/security status metrics must use AdminStatusMatrix compact density instead of p-5 text-2xl cards'
            );
        }
    }
}

for (const file of adminAccountRoots.flatMap((dir) => walk(dir)))
{
    checkSourceFile(file, 'admin/account');
}

for (const file of publicEditorialRoots.flatMap((dir) => walk(dir)))
{
    checkSourceFile(file, 'public editorial');
}

for (const file of walk(productionSourceRoot))
{
    checkProductionFocusRing(file);
}

checkTouchTargetFloor();
checkIssueDensityContracts();
checkPublicTypographyContract();
checkAdminColorGovernance();
checkAdminStatusDensityGovernance();

const accountShellBase = read(accountShellBasePath);
if (/\.account-(?:page-eyebrow|section-title)[\s\S]*?text-transform:\s*uppercase/.test(accountShellBase))
{
    fail(accountShellBasePath, 1, 'account page eyebrow and section title must not use uppercase text transform');
}

const accountLayout = read(accountLayoutPath);
if (/\bfont-weight:\s*800\b/.test(accountLayout))
{
    fail(accountLayoutPath, 1, 'account navigation group labels must not use 800 font weight');
}
if (/\btext-\[11px\]\s+font-(?:bold|semibold)\s+uppercase\b/.test(accountLayout))
{
    fail(accountLayoutPath, 1, 'account navigation and eyebrow labels must not use 11px uppercase micro-labels');
}
if (/\baccount-nav-link-label\s*\{[\s\S]*?\btext-\[11px\]/.test(accountLayout))
{
    fail(accountLayoutPath, 1, 'account nav item labels must use 13px readable scale');
}
const accountHeader = /<header[\s\S]*?<\/header>/.exec(accountLayout)?.[0] ?? '';
if (/areaMeta\.(?:eyebrow|title)/.test(accountHeader))
{
    fail(accountLayoutPath, 1, 'account header must not duplicate the area eyebrow/title already shown in aside');
}

const packageJson = JSON.parse(read(packageJsonPath));
const scripts = packageJson.scripts ?? {};
const checkScript = 'node ../../tests/frontend/checks/static/check-visual-density-governance.mjs';
if (scripts['check:visual-density-governance'] !== checkScript)
{
    fail(packageJsonPath, 1, 'check:visual-density-governance script is missing');
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:visual-density-governance'))
{
    fail(packageJsonPath, 1, 'check:views-constraints must run check:visual-density-governance');
}

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[visual-density-governance] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[visual-density-governance] ok');
