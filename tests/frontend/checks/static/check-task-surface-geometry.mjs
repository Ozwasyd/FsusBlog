#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const dialogWidths = new Set([
    '50%',
    'min(92vw, 28rem)',
    'min(92vw, 24rem)',
    'min(92vw, 48rem)'
]);

const dialogBridgePatterns = [
    { id: 'modal-class-attr', re: /modal-class\s*=/u },
    { id: 'modalClass-prop', re: /\bmodalClass\b/u },
    { id: 'fsusDialogClass', re: /\bfsusDialogClass\b/u },
    { id: 'fsusDialogModalClass', re: /\bfsusDialogModalClass\b/u },
    { id: 'fsusblog-dialog-overlay', re: /fsusblog-dialog-overlay/u },
    { id: 'fsusblog-dialog-bridge', re: /fsusblog-dialog(?!-)/u },
    { id: 'position-fixed', re: /position\s*:\s*fixed/u },
    { id: 'inset', re: /(?:^|[\s;{])inset\s*:/u },
    { id: 'viewport-unit', re: /\b\d*\.?\d*(?:vh|dvh|svh|lvh)\b/u },
    { id: 'safe-area-read', re: /(?:env\(\s*safe-area-inset-|--fsus-safe-area-inset-)/u },
    { id: 'overlay-background', re: /backdrop-filter|background(?:-color)?\s*:\s*(?:rgba?\(|#|var\(--el-overlay)/u },
    { id: 'generic-max-height', re: /max-height\s*:\s*calc\s*\(\s*var\(--fsus-viewport-block-size\)/u },
    { id: 'el-internal-selector', re: /(?:\.el-[\w-]+|:deep\s*\(|\[class\*=['"]el-)/u },
    { id: 'global-overlay-selector', re: /:global\s*\(\s*\.(?:fsusblog-dialog|el-overlay)/u }
];

const dialogContractForbidden = [
    { id: 'css-class-export-fsusDialogClass', re: /\bexport\s+const\s+fsusDialogClass\b/u },
    { id: 'css-class-export-fsusDialogModalClass', re: /\bexport\s+const\s+fsusDialogModalClass\b/u },
    { id: 'string-class-bridge', re: /['"]fsusblog-dialog(?:-overlay)?['"]/u }
];

function lineNumberAt(source, index)
{
    return source.slice(0, index).split('\n').length;
}

function sourceRelative(sourceRoot, path)
{
    return relative(sourceRoot, path).replaceAll('\\', '/');
}

const sourceExtensions = new Set(['.css', '.vue']);
const runtimeScanExtensions = new Set(['.css', '.vue', '.ts', '.tsx', '.js', '.mjs']);

function collect(path, extensions = sourceExtensions)
{
    const entries = readdirSync(path, { withFileTypes: true });
    return entries.flatMap((entry) =>
    {
        const child = resolve(path, entry.name);
        if (entry.isDirectory())
        {
            return collect(child, extensions);
        }
        if (!entry.isFile() || !extensions.has(extname(entry.name)))
        {
            return [];
        }
        return [child];
    });
}

export function findDialogAdapterApiViolations(dialogContractSource)
{
    const errors = [];
    for (const width of dialogWidths)
    {
        if (!dialogContractSource.includes(`'${width}'`))
        {
            errors.push(`fsusui/dialog.ts: missing dialog width preset ${width}`);
        }
    }
    if (!dialogContractSource.includes('export { ElDialog as FsusUiDialog }'))
    {
        errors.push('fsusui/dialog.ts: missing type-preserving FsusUiDialog export');
    }
    if (!dialogContractSource.includes('export type FsusDialogWidth'))
    {
        errors.push('fsusui/dialog.ts: missing FsusDialogWidth type export');
    }
    if (!dialogContractSource.includes('export const isFsusDialogWidth'))
    {
        errors.push('fsusui/dialog.ts: missing isFsusDialogWidth guard');
    }
    for (const { id, re } of dialogContractForbidden)
    {
        if (re.test(dialogContractSource))
        {
            errors.push(`fsusui/dialog.ts: forbidden ${id}`);
        }
    }
    // No CSS class string exports: reject any export const X = 'class-like-string'
    for (const match of dialogContractSource.matchAll(
        /export\s+const\s+(\w+)\s*=\s*['"]([^'"]+)['"]/gu
    ))
    {
        const [, name, value] = match;
        if (/^[a-z][a-z0-9_-]*$/u.test(value) && /class|overlay|dialog/iu.test(name + value))
        {
            errors.push(`fsusui/dialog.ts: must not export CSS class string ${name}=${value}`);
        }
    }
    return errors;
}

export function findDialogWrapperGeometryViolations(dialogWrapperSource)
{
    const errors = [];
    for (const required of [
        'width?: FsusDialogWidth',
        'width: fsusDialogWidths.default'
    ])
    {
        if (!dialogWrapperSource.includes(required))
        {
            errors.push(`components/ui/FsusDialog.vue: missing ${required}`);
        }
    }
    if (dialogWrapperSource.includes('.fsus-dialog__footer') && /@media/u.test(dialogWrapperSource))
    {
        errors.push('components/ui/FsusDialog.vue: footer geometry and responsive width must stay owned by FsusUI and the shared wrapper contract');
    }
    for (const { id, re } of dialogBridgePatterns)
    {
        if (re.test(dialogWrapperSource))
        {
            errors.push(`components/ui/FsusDialog.vue: forbidden Blog-owned overlay geometry residue (${id})`);
        }
    }
    return errors;
}

export function findDialogBridgeResiduesInSource(source, fileLabel = 'source')
{
    const errors = [];
    for (const needle of ['fsusblog-dialog-overlay', 'fsusDialogClass', 'fsusDialogModalClass'])
    {
        if (source.includes(needle))
        {
            errors.push(`${fileLabel}: residual dialog class bridge ${needle}`);
        }
    }
    // Standalone fsusblog-dialog (not part of a longer token like fsusblog-dialog-shell-content)
    if (/(?:^|[^a-z0-9_-])fsusblog-dialog(?:[^a-z0-9_-]|$)/u.test(source))
    {
        errors.push(`${fileLabel}: residual fsusblog-dialog bridge class`);
    }
    return errors;
}

export function findTaskSurfaceGeometryViolations({ root = defaultRepoRoot } = {})
{
    const sourceRoot = resolve(root, 'src/frontend/src');
    const geometryRoots = [
        'assets/account-shell-base.css',
        'assets/account-identity.css',
        'assets/admin-workspace.css',
        'assets/admin',
        'components/account',
        'components/admin',
        'components/ui/FsusDialog.vue',
        'components/ui/MfaSetupModal.vue',
        'components/ui/PasskeyRegisterModal.vue',
        'layouts/AccountLayout.vue',
        'views/admin',
        'views/user'
    ];
    const excludedAuthoringFiles = new Set([
        'components/admin/article/ArticleAssetLibraryPanel.vue',
        'components/admin/article/ArticleBodyMarkdownPreview.vue',
        'components/admin/article/ArticlePrivatePreviewPanel.vue',
        'components/admin/article/ArticleRevisionPanel.vue',
        'components/admin/article/ArticleSeoPreviewPanel.vue',
        'components/admin/article/ArticleWriteEditor.vue',
        'components/admin/article/ArticleWriteSidebar.vue',
        'views/admin/article/Write.vue'
    ]);
    const spacingDeclaration = /(?:^|\n)\s*(?:gap|row-gap|column-gap|(?:padding|margin)(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?)\s*:\s*([^;\n}]+);/gu;
    const radiusDeclaration = /(?:^|\n)\s*border-radius\s*:\s*([^;\n}]+);/gu;
    const rawLength = /(?<![\w-])\d*\.?\d+(?:px|rem)\b/u;
    const allowedRadius = /^(?:0|var\(--fsus-radius-(?:control-small|control|popover|panel|panel-large|pill)(?:,\s*(?:4|6|10|12|24|999)px)?\))$/u;
    const fractionalUtility = /(?<![\w-])(?:-?(?:m|p)[trblxy]?|gap(?:-[xy])?|space-[xy])-\d+\.5\b/gu;
    const genericRadiusUtility = /\brounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?(?=[\s"'`])/gu;
    const mediaFeature = /\((min|max)-(width|height):\s*(\d+)px\)/gu;
    const allowedMediaFeatures = new Set([
        'min-width:640',
        'min-width:768',
        'min-width:1024',
        'min-width:1440',
        'max-width:639',
        'max-width:767',
        'max-width:1023',
        'max-width:1439',
        'max-height:520'
    ]);
    const errors = [];

    const geometryFiles = geometryRoots.flatMap((entry) =>
    {
        const path = resolve(sourceRoot, entry);
        return sourceExtensions.has(extname(path)) ? [path] : collect(path);
    }).filter((path) => !excludedAuthoringFiles.has(sourceRelative(sourceRoot, path)));

    for (const path of geometryFiles)
    {
        const source = readFileSync(path, 'utf8');
        const file = sourceRelative(sourceRoot, path);

        for (const match of source.matchAll(spacingDeclaration))
        {
            if (rawLength.test(match[1]))
            {
                errors.push(`${file}:${lineNumberAt(source, match.index)} task spacing must consume --fsus-space-* tokens: ${match[1].trim()}`);
            }
        }

        for (const match of source.matchAll(radiusDeclaration))
        {
            if (!allowedRadius.test(match[1].trim()))
            {
                errors.push(`${file}:${lineNumberAt(source, match.index)} task radius is outside the semantic radius scale: ${match[1].trim()}`);
            }
        }

        for (const match of source.matchAll(fractionalUtility))
        {
            errors.push(`${file}:${lineNumberAt(source, match.index)} fractional spacing utility ${match[0]} is outside the 4px task scale`);
        }

        for (const match of source.matchAll(genericRadiusUtility))
        {
            errors.push(`${file}:${lineNumberAt(source, match.index)} radius utility ${match[0]} must name a --fsus-radius-* token`);
        }

        for (const match of source.matchAll(mediaFeature))
        {
            const key = `${match[1]}-${match[2]}:${match[3]}`;
            if (!allowedMediaFeatures.has(key))
            {
                errors.push(`${file}:${lineNumberAt(source, match.index)} responsive feature ${match[0]} is outside the shared task breakpoints`);
            }
        }
    }

    const dialogContract = readFileSync(resolve(sourceRoot, 'fsusui/dialog.ts'), 'utf8');
    errors.push(...findDialogAdapterApiViolations(dialogContract));

    const dialogWrapper = readFileSync(resolve(sourceRoot, 'components/ui/FsusDialog.vue'), 'utf8');
    errors.push(...findDialogWrapperGeometryViolations(dialogWrapper));

    // Runtime source must not reintroduce the retired Blog dialog class bridge.
    for (const path of collect(sourceRoot, runtimeScanExtensions))
    {
        const source = readFileSync(path, 'utf8');
        errors.push(...findDialogBridgeResiduesInSource(source, sourceRelative(sourceRoot, path)));
    }

    for (const path of collect(sourceRoot, new Set(['.vue'])))
    {
        const source = readFileSync(path, 'utf8');
        for (const dialog of source.matchAll(/<FsusDialog\b[\s\S]*?>/gu))
        {
            const literalWidth = dialog[0].match(/(?<!:)\bwidth="([^"]+)"/u)?.[1];
            if (literalWidth && !dialogWidths.has(literalWidth))
            {
                errors.push(`${sourceRelative(sourceRoot, path)}:${lineNumberAt(source, dialog.index)} dialog width ${literalWidth} is outside the whitelist`);
            }
            if (/\bmodal-class\b/u.test(dialog[0]) || /\bmodalClass\b/u.test(dialog[0]))
            {
                errors.push(`${sourceRelative(sourceRoot, path)}:${lineNumberAt(source, dialog.index)} FsusDialog must not accept modal-class; overlay geometry is FsusUI-owned`);
            }
        }
    }

    const articleWrite = readFileSync(resolve(sourceRoot, 'views/admin/article/Write.vue'), 'utf8');
    const articleInspector = readFileSync(
        resolve(sourceRoot, 'components/admin/article/ArticleWriteInspectorShell.vue'),
        'utf8'
    );
    for (const token of [
        'data-editor-document-column="stable"',
        'width: min(100%, var(--fsusblog-article-document-inline-size));',
        'margin-inline: auto;',
        'grid-template-columns: minmax(0, 1fr);'
    ])
    {
        if (!articleWrite.includes(token))
        {
            errors.push(`views/admin/article/Write.vue: missing stable article document geometry ${token}`);
        }
    }
    for (const token of [
        'position: fixed;',
        'width: min(32rem, 42vw);',
        "role: 'complementary'",
        "isCompact.value ? publicDrawer : 'aside'"
    ])
    {
        if (!articleInspector.includes(token))
        {
            errors.push(`components/admin/article/ArticleWriteInspectorShell.vue: missing non-reflow inspector geometry ${token}`);
        }
    }
    for (const forbidden of [
        /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+(?:16|18|20|22)rem/u,
        /transition\s*:[^;]*(?:width|inline-size)/u,
        /aria-modal/u
    ])
    {
        if (forbidden.test(`${articleWrite}\n${articleInspector}`))
        {
            errors.push(`article write geometry must not reintroduce split-width or modal desktop residue ${forbidden}`);
        }
    }

    for (const [file, needle] of [
        ['views/admin/Category.vue', 'dialogWidth: fsusDialogWidths.extraCompact'],
        ['views/admin/Tag.vue', 'dialogWidth: fsusDialogWidths.extraCompact'],
        ['composables/useAdminTaxonomyManage.ts', 'dialogWidth: FsusDialogWidth']
    ])
    {
        if (!readFileSync(resolve(sourceRoot, file), 'utf8').includes(needle))
        {
            errors.push(`${file}: missing semantic taxonomy dialog width contract`);
        }
    }

    return { errors, geometryFileCount: geometryFiles.length, dialogWidthCount: dialogWidths.size };
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain)
{
    const { errors, geometryFileCount, dialogWidthCount } = findTaskSurfaceGeometryViolations();
    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[task-surface-geometry] ${error}`);
        }
        process.exit(1);
    }
    console.log(`[task-surface-geometry] ok files=${geometryFileCount} dialogWidths=${dialogWidthCount}`);
}
