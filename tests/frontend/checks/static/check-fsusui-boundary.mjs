import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkControlLegality } from '@fsusblog/control-legality/admission';

const { verifyCandidateBoundaryInput } = await import(new URL('../../../../tools/dependencies/verify-fsusui-candidate.mjs', import.meta.url));
const { resolveLocalFsusUiRepositoryRoot } = await import(new URL('../../../../src/frontend/scripts/fsusui-root.mjs', import.meta.url));
// Boundary contract: src/frontend/src/fsusui/README.md

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const repoRoot = path.resolve(process.env.FSUSBLOG_FSUSUI_BOUNDARY_ROOT ?? defaultRepoRoot);
const srcRoot = path.join(repoRoot, 'src/frontend/src');
const fsusuiRoot = path.join(srcRoot, 'fsusui');
const boundaryDocPath = path.join(fsusuiRoot, 'README.md');
const themeAdapterPath = path.join(fsusuiRoot, 'theme.ts');
const taskPageHeaderAdapterPath = path.join(fsusuiRoot, 'taskPageHeader.ts');
const settingsPrimitivesAdapterPath = path.join(fsusuiRoot, 'settingsSection.ts');
const primitiveAdaptersPath = path.join(fsusuiRoot, 'primitiveAdapters.ts');
const adminInlineEmptyStatePath = path.join(srcRoot, 'components/admin/AdminInlineEmptyState.vue');
const profileSettingsPrimitivesPath = path.join(srcRoot, 'components/user/ProfileSettingsPrimitives.ts');
const identityCenterPath = path.join(srcRoot, 'views/user/IdentityCenter.vue');
const profilePath = path.join(srcRoot, 'views/user/Profile.vue');
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json');
const strict = true;

const sourceExtensions = new Set(['.css', '.js', '.mjs', '.scss', '.ts', '.tsx', '.vue']);
const programmaticApis = new Set(['ElMessage', 'ElMessageBox', 'ElNotification', 'ElLoading']);
const warnings = [];
const allowedRuntimeImports = new Map([
    ['src/frontend/src/App.vue', new Set(['@ozwasyd/element-plus/motion'])],
    ['src/frontend/src/bootstrap/fullApp.ts', new Set(['@ozwasyd/element-plus/motion'])],
    ['src/frontend/src/components/article/ArticleImageLightbox.vue', new Set(['@ozwasyd/element-plus/motion'])],
    ['src/frontend/src/components/ui/MarkdownTextEditor.vue', new Set(['@ozwasyd/element-plus'])],
    ['src/frontend/src/composables/article/useArticleImageLightbox.ts', new Set(['@ozwasyd/element-plus/motion'])],
    ['src/frontend/src/composables/article/useCodeBlockCopy.ts', new Set(['@ozwasyd/element-plus/motion'])],
    ['src/frontend/src/services/securityPerceptionChallengeFlow.ts', new Set(['@ozwasyd/element-plus/perception-challenge'])]
]);
const allowedInternalSelectors = new Map([
    ['src/frontend/src/components/admin/AdminTaxonomyManageView.vue', new Set([
        '.el-table-fixed-column--right'
    ])],
    ['src/frontend/src/components/admin/article/ArticleWriteSidebar.vue', new Set([
        '.el-form-item__content',
        '.el-textarea',
        '.el-textarea__inner'
    ])],
    ['src/frontend/src/components/admin/comment-moderation/CommentModerationQueue.vue', new Set([
        '.el-table-fixed-column--right'
    ])],
    ['src/frontend/src/components/admin/users/UserManageHeader.vue', new Set([
        '.el-button'
    ])],
    ['src/frontend/src/components/admin/users/UserManageTable.vue', new Set([
        '.el-responsive-collection',
        '.el-responsive-collection__compact'
    ])],
    ['src/frontend/src/components/ui/MarkdownEditorAdapter.vue', new Set([
        '.el-markdown-editor__action',
        '.el-markdown-editor__command'
    ])],

    ['src/frontend/src/public-renderers/clientHydrate.ts', new Set([
        '.el-input',
        '.el-input__inner',
        '.el-input__wrapper',
        '.el-radio-group',
        '.el-theme-mode-toggle'
    ])],
    ['src/frontend/src/views/admin/AuditLog.vue', new Set([
        '.el-date-editor',
        '.el-input',
        '.el-range-input',
        '.el-select'
    ])],
    ['src/frontend/src/views/admin/CacheDiagnostics.vue', new Set([
        '.el-button'
    ])],
    ['src/frontend/src/views/admin/article/List.vue', new Set([
        '.el-button',
        '.el-form-item__content',
        '.el-table-fixed-column--right'
    ])],
    ['src/frontend/src/views/admin/article/Write.vue', new Set([
        '.el-button',
        '.el-form-item',
        '.el-form-item__content',
        '.el-input__count',
        '.el-input__inner',
        '.el-input__wrapper'
    ])],
    ['src/frontend/src/views/admin/article/Trash.vue', new Set([
        '.el-button'
    ])],
    ['src/frontend/src/views/admin/moderation/ModerationDictionaries.vue', new Set([
        '.el-table-fixed-column--right'
    ])],
    ['src/frontend/src/views/admin/moderation/ModerationModel.vue', new Set([
        '.el-button',
        '.el-input',
        '.el-select'
    ])],
    ['src/frontend/src/views/admin/moderation/ModerationRegions.vue', new Set([
        '.el-data-list__cell',
        '.el-data-list__cell--end',
        '.el-data-list__row'
    ])],
    ['src/frontend/src/views/admin/moderation/ModerationReplay.vue', new Set([
        '.el-button',
        '.el-input',
        '.el-input-number',
        '.el-select'
    ])],
    ['src/frontend/src/views/admin/security/SecurityEvents.vue', new Set([
        '.el-input-number'
    ])],
    ['src/frontend/src/views/admin/Settings.vue', new Set([
        '.el-tabs__header',
        '.el-tabs__nav-scroll',
        '.el-tabs__nav-wrap'
    ])],
    ['src/frontend/src/views/auth/Register.vue', new Set([
        '.el-button'
    ])]
]);

function rel(file)
{
    return path.relative(repoRoot, file).replaceAll(path.sep, '/');
}

function isUnder(file, root)
{
    const relative = path.relative(root, file);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function walk(dir, files = [])
{
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    {
        if (entry.name === 'node_modules' || entry.name === 'dist')
        {
            continue;
        }

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory())
        {
            walk(fullPath, files);
            continue;
        }

        if (sourceExtensions.has(path.extname(entry.name)))
        {
            files.push(fullPath);
        }
    }
    return files;
}

function warn(file, rule, detail)
{
    warnings.push({ file: rel(file), rule, detail });
}

function checkDeepImports(file, content)
{
    const deepImportPattern =
        /@ozwasyd\/element-plus\/(?:(?:es|lib)\/[^'"]*\/src\/[^'"]*|es\/icons-vue\/src\/index\.mjs|es\/wasm\/index\.mjs|es\/components\/config-provider\/src\/theme-mode)/g;
    for (const match of content.matchAll(deepImportPattern))
    {
        warn(file, 'deep-import', `uses ${match[0]}`);
    }
}

function checkProgrammaticImports(file, content)
{
    if (rel(file) === 'src/frontend/src/fsusui/feedback.ts')
    {
        return;
    }

    const importPattern = /import\s*\{([^}]+)\}\s*from\s*['"]@ozwasyd\/element-plus['"]/g;
    for (const match of content.matchAll(importPattern))
    {
        const imports = match[1]
            .split(',')
            .map((item) => item.trim().split(/\s+as\s+/i)[0].trim())
            .filter(Boolean);
        const blocked = imports.filter((name) => programmaticApis.has(name));
        if (blocked.length > 0)
        {
            warn(file, 'programmatic-api', `imports ${blocked.join(', ')}`);
        }
    }
}

function checkRuntimeImports(file, content)
{
    if (isUnder(file, fsusuiRoot))
    {
        return;
    }

    const fileRel = rel(file);
    const allowedSources = allowedRuntimeImports.get(fileRel);
    const importPattern = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](@ozwasyd\/element-plus(?:\/[^'"]+)?)['"]/g;
    for (const match of content.matchAll(importPattern))
    {
        const namedImports = match[2].split(',').map((item) => item.trim()).filter(Boolean);
        const typeOnly = Boolean(match[1]) || (namedImports.length > 0 && namedImports.every((item) => item.startsWith('type ')));
        if (typeOnly || allowedSources?.has(match[3]))
        {
            continue;
        }
        warn(file, 'runtime-import-outside-boundary', `imports runtime from ${match[3]}`);
    }

    const otherImportPattern = /import\s+(?!type\b|\{)([^;\n]+?)\s+from\s+['"](@ozwasyd\/element-plus(?:\/[^'"]+)?)['"]/g;
    for (const match of content.matchAll(otherImportPattern))
    {
        if (!allowedSources?.has(match[2]))
        {
            warn(file, 'runtime-import-outside-boundary', `imports runtime from ${match[2]}`);
        }
    }

    const dynamicImportPattern = /import\(\s*['"](@ozwasyd\/element-plus(?:\/[^'"]+)?)['"]\s*\)/g;
    for (const match of content.matchAll(dynamicImportPattern))
    {
        if (!allowedSources?.has(match[1]))
        {
            warn(file, 'runtime-import-outside-boundary', `imports runtime from ${match[1]}`);
        }
    }
}

function checkBoundaryImplementation(file, content)
{
    if (!isUnder(file, fsusuiRoot) || !file.endsWith('.ts'))
    {
        return;
    }

    if (/\bas\s+Component\b/.test(content))
    {
        warn(file, 'component-type-erasure', 'use a type-preserving named re-export instead of as Component');
    }
    if (/export\s+const\s+FsusUi\w+\s*=\s*defineComponent\s*\(/.test(content) || /name:\s*['"]FsusUi\w+['"]/.test(content))
    {
        warn(file, 'misleading-local-fsusui-component', 'Blog-owned implementations must not use an FsusUi* runtime identity');
    }
}

function checkInternalSelectors(file, content)
{
    const fileRel = rel(file);
    const allowedSelectors = allowedInternalSelectors.get(fileRel);
    const selectorPattern = /(?::deep\()?\.el-[a-z0-9_-]+/gi;
    for (const match of content.matchAll(selectorPattern))
    {
        const selector = match[0].replace(':deep(', '');
        if (allowedSelectors?.has(selector))
        {
            continue;
        }
        warn(file, 'internal-selector', `uses ${selector}`);
    }
}

function checkVisualRewriteClasses(file, content)
{
    if (!file.endsWith('.vue'))
    {
        return;
    }

    const componentClassPattern = /<el-[\w-]+[^>]*\bclass=(["'])([^"']*(?:\bbg-|\btext-|\bborder-|\brounded-|\bshadow-|!important)[^"']*)\1/gi;
    for (const match of content.matchAll(componentClassPattern))
    {
        warn(file, 'visual-rewrite-class', `class="${match[2].trim()}"`);
    }
}

function checkRawDialogUsage(file, content)
{
    const fileRel = rel(file);
    if (!file.endsWith('.vue') || fileRel === 'src/frontend/src/components/ui/FsusDialog.vue')
    {
        return;
    }

    if (content.includes('<el-dialog') || content.includes('</el-dialog>'))
    {
        warn(file, 'raw-dialog', 'use FsusDialog instead of direct el-dialog');
    }
}

function checkMarkdownActivationOwnership(file, content)
{
    const fileRel = rel(file);
    if (fileRel === 'src/frontend/src/fsusui/markdown.ts')
    {
        return;
    }

    const blocked = [
        [/import\s*\(\s*['"]mermaid['"]\s*\)/g, 'direct-mermaid-import'],
        [/import\s*\(\s*['"]katex['"]\s*\)/g, 'direct-katex-import'],
        [/import\s*\(\s*['"]shiki(?:\/[^'"]*)?['"]\s*\)/g, 'direct-shiki-import'],
        [/@\/services\/shikiHighlighter/g, 'local-shiki-highlighter'],
        [/markdownActivationService/g, 'local-markdown-activation'],
        [/data-mermaid-placeholder/g, 'manual-mermaid-placeholder'],
        [/data-latex-placeholder/g, 'manual-latex-placeholder'],
        [/pre\s*>\s*code\[class\*=["']language-["']\]/g, 'manual-code-highlight-selector'],
        [/Node\.prototype\.(?:appendChild|insertBefore)/g, 'dom-nonce-monkey-patch']
    ];

    for (const [pattern, rule] of blocked)
    {
        if (pattern.test(content))
        {
            warn(file, rule, 'generic Markdown feature activation belongs to FsusUI');
        }
    }
}

function checkPackageMarkdownDependencies()
{
    if (!fs.existsSync(packageJsonPath))
    {
        return;
    }

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    for (const name of ['mermaid', 'katex', 'shiki'])
    {
        if (pkg.dependencies?.[name] || pkg.devDependencies?.[name])
        {
            warn(packageJsonPath, 'direct-markdown-feature-package', `${name} must be provided by @ozwasyd/element-plus`);
        }
    }

    if (process.env.FSUSBLOG_FSUSUI_CANDIDATE !== undefined
        || process.env.FSUSBLOG_FSUSUI_CANDIDATE_SHA256 !== undefined)
    {
        try
        {
            verifyCandidateBoundaryInput(repoRoot);
        }
        catch (error)
        {
            warn(packageJsonPath, 'fsusui-candidate', error.message);
        }
    }
    else if (pkg.dependencies?.['@ozwasyd/element-plus'] !== '1.5.1')
    {
        warn(packageJsonPath, 'fsusui-version', '@ozwasyd/element-plus must stay on 1.5.1 for Markdown feature ownership');
    }
}

function checkRequiredAdapters()
{
    const required = [
        'index.ts',
        'theme.ts',
        'feedback.ts',
        'dialog.ts',
        'overlay.ts',
        'result.ts',
        'icons.ts',
        'markdown.ts',
        'renderPipeline.ts',
        'primitiveAdapters.ts',
        'segmentedControl.ts',
        'settingsSection.ts',
        'taskPageHeader.ts'
    ];

    for (const name of required)
    {
        const file = path.join(fsusuiRoot, name);
        if (!fs.existsSync(file))
        {
            warnings.push({
                file: rel(fsusuiRoot),
                rule: 'missing-adapter',
                detail: `${name} is missing`
            });
        }
    }

    const retiredPageHeader = path.join(fsusuiRoot, 'pageHeader.ts');
    if (fs.existsSync(retiredPageHeader))
    {
        warn(retiredPageHeader, 'retired-page-header', 'remove the local page header implementation');
    }
}

function checkIdentitySettingsPrimitiveContract()
{
    if (fs.existsSync(profileSettingsPrimitivesPath))
    {
        warn(profileSettingsPrimitivesPath, 'retired-profile-settings-primitives', 'delete the duplicate local profile settings primitives');
    }

    if (!fs.existsSync(settingsPrimitivesAdapterPath))
    {
        return;
    }

    const adapter = fs.readFileSync(settingsPrimitivesAdapterPath, 'utf8');
    for (const token of [
        'ElSettingsSection as FsusUiSettingsSection',
        'ElResourceList as FsusUiResourceList',
        'ElResourceListItem as FsusUiResourceListItem',
        'ElMetadataRow as FsusUiMetadataRow',
        'ElMetadataItem as FsusUiMetadataItem',
        'ElInlineActions as FsusUiInlineActions',
        'ResourceListProps as FsusUiResourceListProps',
        'MetadataItemProps as FsusUiMetadataItemProps',
        'InlineActionsProps as FsusUiInlineActionsProps'
    ])
    {
        if (!adapter.includes(token))
        {
            warn(settingsPrimitivesAdapterPath, 'identity-settings-adapter-contract', `missing ${token}`);
        }
    }

    if (/\bas\s+Component\b|defineComponent\s*\(/u.test(adapter))
    {
        warn(settingsPrimitivesAdapterPath, 'identity-settings-adapter-contract', 'settings primitives must stay type-preserving named re-exports');
    }

    const identity = fs.existsSync(identityCenterPath)
        ? fs.readFileSync(identityCenterPath, 'utf8')
        : '';
    for (const token of [
        'FsusUiResourceList',
        'FsusUiResourceListItem',
        'FsusUiMetadataRow',
        'FsusUiMetadataItem',
        'FsusUiInlineActions',
        'FsusUiEmptyState',
        'FsusUiDangerZone',
        'FsusUiRiskNotice',
        'FsusUiDestructiveActionPanel'
    ])
    {
        if (!identity.includes(token))
        {
            warn(identityCenterPath, 'identity-settings-consumer-contract', `missing ${token}`);
        }
    }

    for (const token of ['ProfileResourceList', 'ProfileResourceListItem', 'ProfileInlineEmptyState', 'ProfileSettingsPrimitives'])
    {
        if (identity.includes(token))
        {
            warn(identityCenterPath, 'retired-profile-settings-primitives', `uses ${token}`);
        }
    }

    if (!/commitAndReconcile\([\s\S]*?updatePublicHandle\([\s\S]*?getPasskeySignalState[\s\S]*?currentUserDetails:\s*true/u.test(identity)
        || !identity.includes('passkeyCredentials.value.length > 0'))
    {
        warn(identityCenterPath, 'identity-passkey-signal-order', 'public-handle details must be signaled only after the authoritative mutation commits');
    }

    const profile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
    if (!profile.includes('FsusUiEmptyState') || profile.includes('ProfileInlineEmptyState'))
    {
        warn(profilePath, 'identity-settings-consumer-contract', 'profile redirect surface must use FsusUiEmptyState directly');
    }
}

function checkTaskPageHeaderContract()
{
    if (!fs.existsSync(taskPageHeaderAdapterPath))
    {
        return;
    }

    const content = fs.readFileSync(taskPageHeaderAdapterPath, 'utf8');
    for (const token of [
        'FsusTaskPageHeader as FsusUiTaskPageHeader',
        'TaskPageHeaderProps as FsusUiTaskPageHeaderProps',
        'TaskPageHeaderSlots as FsusUiTaskPageHeaderSlots'
    ])
    {
        if (!content.includes(token))
        {
            warn(taskPageHeaderAdapterPath, 'task-page-header-contract', `missing ${token}`);
        }
    }

    if (/\bas\s+Component\b|defineComponent\s*\(/u.test(content))
    {
        warn(taskPageHeaderAdapterPath, 'task-page-header-contract', 'task page header must stay a type-preserving named re-export');
    }
}

function checkRetiredTaskPageHeaderSurface(file, content)
{
    if (isUnder(file, fsusuiRoot) || file === boundaryDocPath)
    {
        return;
    }

    for (const token of ['FsusUiPageHeader', 'account-page-header', 'account-page-title', 'account-page-description'])
    {
        if (content.includes(token))
        {
            warn(file, 'retired-task-page-header', `uses ${token}`);
        }
    }
}

function checkBoundaryDoc()
{
    if (!fs.existsSync(boundaryDocPath))
    {
        warn(boundaryDocPath, 'missing-boundary-doc', 'document the fsusui adapter vs components/ui shell split');
        return;
    }

    const content = fs.readFileSync(boundaryDocPath, 'utf8');
    for (const token of [
        'FsusUI Adapter Boundary',
        'components/ui/',
        'Allowed Exceptions',
        'Type-preserving re-export',
        'Runtime adapter',
        'Semantic policy adapter',
        'check-fsusui-boundary.mjs'
    ])
    {
        if (!content.includes(token))
        {
            warn(boundaryDocPath, 'boundary-doc-content', `missing ${token}`);
        }
    }
}

function checkInternalMotionSurfaceOnFsusUiComponents(file, content)
{
    if (!file.endsWith('.vue') || isUnder(file, fsusuiRoot))
    {
        return;
    }

    const directSurfacePattern = /<el-[\w-]+\b[^>]*\bdata-fsus-motion-surface=/gis;
    for (const match of content.matchAll(directSurfacePattern))
    {
        warn(file, 'internal-motion-surface', `direct ${match[0].trim()} uses a private FsusUI motion data attribute`);
    }
}

function checkThemeAdapterContract()
{
    if (!fs.existsSync(themeAdapterPath))
    {
        return;
    }

    const content = fs.readFileSync(themeAdapterPath, 'utf8');
    if (!/from\s+['"]@ozwasyd\/element-plus\/theme['"]/.test(content))
    {
        warn(themeAdapterPath, 'theme-adapter-contract', 'theme.ts must import the FsusUI public theme contract');
    }

    for (const pattern of [
        /export\s+const\s+themeModes\s*=\s*\[/,
        /export\s+type\s+ThemeMode\s*=\s*\(typeof\s+themeModes\)\[number\]/,
        /export\s+type\s+ResolvedTheme\s*=\s*Exclude<ThemeMode,\s*['"]system['"]>/
    ])
    {
        if (pattern.test(content))
        {
            warn(themeAdapterPath, 'theme-adapter-contract', 'theme.ts must not redeclare FsusUI theme-mode primitives');
            break;
        }
    }
}

function checkAdminEmptyStateDelegation()
{
    const contracts = [
        {
            file: adminInlineEmptyStatePath,
            component: 'AdminInlineEmptyState',
            context: 'adminCollection'
        }
    ];

    const adapterContent = fs.existsSync(primitiveAdaptersPath)
        ? fs.readFileSync(primitiveAdaptersPath, 'utf8')
        : '';

    for (const token of [
        'FsusUiEmptyState',
        'toFsusUiInlineEmptyStateProps',
        "'adminCollection'",
        "'dashboardMetric'",
        'EmptyStateTitleTag'
    ])
    {
        if (!adapterContent.includes(token))
        {
            warn(primitiveAdaptersPath, 'empty-state-adapter-contract', `primitiveAdapters.ts missing ${token}`);
        }
    }

    for (const contract of contracts)
    {
        if (!fs.existsSync(contract.file))
        {
            warn(contract.file, 'empty-state-delegation', `${contract.component} SFC is required`);
            continue;
        }

        const content = fs.readFileSync(contract.file, 'utf8');
        if (!content.includes('FsusUiEmptyState'))
        {
            warn(contract.file, 'empty-state-delegation', `${contract.component} must import the FsusUI empty-state adapter`);
        }
        if (!content.includes('toFsusUiInlineEmptyStateProps'))
        {
            warn(contract.file, 'empty-state-delegation', `${contract.component} must use the FsusUI empty-state adapter`);
        }
        if (!content.includes(`toFsusUiInlineEmptyStateProps('${contract.context}')`))
        {
            warn(contract.file, 'empty-state-delegation', `${contract.component} must derive FsusUI props from ${contract.context}`);
        }
        if (!/<FsusUiEmptyState\b/.test(content))
        {
            warn(contract.file, 'empty-state-delegation', `${contract.component} must render the FsusUI empty-state component`);
        }
    }
}

for (const file of walk(srcRoot))
{
    const content = fs.readFileSync(file, 'utf8');
    checkDeepImports(file, content);
    checkProgrammaticImports(file, content);
    checkRuntimeImports(file, content);
    checkBoundaryImplementation(file, content);
    checkRetiredTaskPageHeaderSurface(file, content);
    checkInternalSelectors(file, content);
    checkVisualRewriteClasses(file, content);
    checkRawDialogUsage(file, content);
    checkInternalMotionSurfaceOnFsusUiComponents(file, content);
    checkMarkdownActivationOwnership(file, content);
}

checkPackageMarkdownDependencies();
checkRequiredAdapters();
checkTaskPageHeaderContract();
checkIdentitySettingsPrimitiveContract();
checkBoundaryDoc();
checkThemeAdapterContract();
checkAdminEmptyStateDelegation();

// The public-source/default-deny model has one production entry: this gate.
// Existing import/selector checks retain their narrow responsibilities above.
// A missing public package or execution receipt never enables a legacy bypass.
try
{
    const argument = (flag) =>
    {
        const index = process.argv.indexOf(flag);
        return index < 0 ? null : process.argv[index + 1];
    };
    const observations = process.argv.flatMap((value, index) => value === '--test-observation' ? [process.argv[index + 1]] : []);
    const inventory = checkControlLegality({ repositoryRoot: repoRoot, parserRoot: defaultRepoRoot,
        fsusUIRoot: resolveLocalFsusUiRepositoryRoot({ repositoryRoot: defaultRepoRoot,
            override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT }),
        executionEvidence: { receipt: argument('--test-receipt'), plan: argument('--test-plan'),
            staticAdmissionReceipt: argument('--static-admission-receipt'), observations } });
    const outputIndex = process.argv.indexOf('--inventory');
    if (outputIndex >= 0)
    {
        const output = process.argv[outputIndex + 1];
        if (!output)
        {
            throw new Error('--inventory requires an output path');
        }
        fs.writeFileSync(path.resolve(output), JSON.stringify(inventory, null, 2) + '\n');
    }
    for (const item of [...inventory.errors, ...inventory.reports.flatMap((report) => report.errors)])
    {
        warnings.push({ file: `${item.path ?? 'control-legality'}:${item.line ?? 1}:${item.column ?? 1}`,
            rule: `control-legality:${item.controlKind ?? 'registration'}`, detail: item.reason,
            resolvedSource: item.resolvedSource ?? null });
    }
}
catch (error)
{
    warnings.push({ file: 'control-legality:1:1', rule: 'control-legality:admission', detail: error.message });
}

if (warnings.length === 0)
{
    console.log('[fsusui-boundary] ok warnings=0 strict=' + strict);
    process.exit(0);
}

console.log(`[fsusui-boundary] warnings=${warnings.length} strict=${strict}`);
for (const item of warnings)
{
    console.log(`- ${item.file}: ${item.rule}: ${item.detail}${item.resolvedSource ? ` source=${JSON.stringify(item.resolvedSource)}` : ''}`);
}

process.exit(1);
