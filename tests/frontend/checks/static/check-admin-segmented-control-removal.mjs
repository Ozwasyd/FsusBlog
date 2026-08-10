#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const legacyComponentPath = 'src/frontend/src/components/admin/AdminSegmentedControl.vue';
const articleListPath = 'src/frontend/src/views/admin/article/List.vue';
const articleListComposablePath = 'src/frontend/src/composables/useAdminArticleList.ts';
const adapterPath = 'src/frontend/src/fsusui/segmentedControl.ts';
const browserSmokePath = 'tests/frontend/e2e/ux/admin-article-segmented-consumer.spec.ts';
const visualRunnerPath = 'tools/frontend/check-console-visual.sh';

const browserGroups = [
    'admin article direct FsusUI segmented consumer (#1888, light)',
    'admin article direct FsusUI segmented consumer (#1888, dark)'
];
const evidenceScreenshots = [
    'issue-1888-admin-article-segmented-light-375-100-states.png',
    'issue-1888-admin-article-segmented-dark-375-100-states.png',
    'issue-1888-admin-article-segmented-light-375-200-long-scroll.png',
    'issue-1888-admin-article-segmented-dark-375-200-long-scroll.png'
];

const normalizePath = (value) => value.replaceAll(path.sep, '/');

const walkSourceFiles = (root, relative = 'src/frontend/src') =>
{
    const absolute = path.join(root, relative);
    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    {
        const child = normalizePath(path.join(relative, entry.name));
        if (entry.isDirectory())
        {
            return walkSourceFiles(root, child);
        }
        return /\.(?:ts|tsx|vue|css|scss)$/u.test(entry.name) ? [child] : [];
    });
};

export const loadAdminSegmentedControlSources = (root) => Object.fromEntries(
    walkSourceFiles(root).map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(root, relativePath), 'utf8')
    ])
);

const countMatches = (source, expression) => [...source.matchAll(expression)].length;
const countLiteral = (source, token) => source.split(token).length - 1;
const countQuotedLiteral = (source, token) => (
    countLiteral(source, `'${token}'`) + countLiteral(source, `"${token}"`)
);

const isSegmentedForwardingWrapper = (source) => (
    /<FsusUiSegmentedControl\b/u.test(source)
  && /:items(?:\s|=\s*["'][^"']*\bitems\b[^"']*["'])/u.test(source)
  && /:model(?:-value|Value)(?:\s|=\s*["'][^"']*\bmodelValue\b[^"']*["'])/u.test(source)
  && /@update:model(?:-value|Value)\s*=\s*["'][^"']*(?:emit|update:modelValue)[^"']*["']/u.test(source)
  && /\bdefineProps\b|\bprops\s*:/u.test(source)
  && /\bdefineEmits\b|\bemits\s*:/u.test(source)
);

export function auditAdminSegmentedControlRemoval(sources)
{
    const failures = [];
    const list = sources[articleListPath] ?? '';
    const composable = sources[articleListComposablePath] ?? '';
    const adapter = sources[adapterPath] ?? '';
    const productionEntries = Object.entries(sources);

    if (legacyComponentPath in sources)
    {
        failures.push(`${legacyComponentPath}: deleted wrapper must not exist`);
    }

    if (countMatches(list, /<FsusUiSegmentedControl\b/gu) !== 1)
    {
        failures.push(`${articleListPath}: article status filter must directly render exactly one FsusUiSegmentedControl`);
    }
    if (!/from ['"]@\/fsusui\/segmentedControl['"]/u.test(list))
    {
        failures.push(`${articleListPath}: segmented component and types must come directly from @/fsusui/segmentedControl`);
    }
    for (const typeName of ['FsusUiSegmentedControlItem', 'FsusUiSegmentedControlValue'])
    {
        if (!new RegExp(`\\btype\\s+${typeName}\\b|\\b${typeName}\\b`, 'u').test(list))
        {
            failures.push(`${articleListPath}: missing strong public type ${typeName}`);
        }
    }
    if (!/\bdisabled\s*:\s*isBusy\.value\b/u.test(list))
    {
        failures.push(`${articleListPath}: busy state must map to each public segmented item disabled state`);
    }
    if (/<FsusUiSegmentedControl\b[^>]*\s:disabled=/u.test(list))
    {
        failures.push(`${articleListPath}: FsusUiSegmentedControl has no public whole-control disabled prop; disable its typed items`);
    }
    if (/<button\b[^>]*\baria-pressed\b|<button\b[\s\S]{0,500}\baria-pressed\b/u.test(list))
    {
        failures.push(`${articleListPath}: caller must not reimplement segmented selection with button[aria-pressed]`);
    }
    if (/\bas\s+any\b|\bas\s+Component\b/u.test(list))
    {
        failures.push(`${articleListPath}: segmented migration must not widen or cast away the public value/component type`);
    }

    const expectedFilterOrder = [
        "{ label: '全部', value: undefined }",
        "{ label: '草稿', value: ArticlePublishStatus.Draft }",
        "{ label: '定时', value: ArticlePublishStatus.Scheduled }",
        "{ label: '已发布', value: ArticlePublishStatus.Published }",
        "{ label: '归档', value: ArticlePublishStatus.Archived }"
    ];
    let previousIndex = -1;
    for (const item of expectedFilterOrder)
    {
        const index = composable.indexOf(item);
        if (index <= previousIndex)
        {
            failures.push(`${articleListComposablePath}: article status filter values and order must remain 全部/草稿/定时/已发布/归档`);
            break;
        }
        previousIndex = index;
    }
    for (const contract of [
        "if (queryParam.status !== undefined) query.status = String(queryParam.status)",
        "queryParam.status = parseStatus(route.query.status)",
        "const setStatusFilter = (status: ArticlePublishStatus | undefined): void =>",
        "queryParam.status = status"
    ])
    {
        if (!composable.includes(contract))
        {
            failures.push(`${articleListComposablePath}: missing unchanged query/result contract ${contract}`);
        }
    }

    for (const [relativePath, source] of productionEntries)
    {
        if (/\bAdminSegmentedControl\b|@\/components\/admin\/AdminSegmentedControl\.vue/u.test(source))
        {
            failures.push(`${relativePath}: legacy AdminSegmentedControl reference must be zero`);
        }
        if (
            /\bAdminFilterTabs\b|\bArticleStatusSegmentedControl\b/u.test(source)
      || /\/(?:AdminFilterTabs|ArticleStatusSegmentedControl)\.(?:ts|tsx|vue)$/u.test(relativePath)
        )
        {
            failures.push(`${relativePath}: renamed segmented wrapper or compatibility alias is forbidden`);
        }
        if (relativePath !== articleListPath && isSegmentedForwardingWrapper(source))
        {
            failures.push(`${relativePath}: arbitrary FsusUiSegmentedControl items/modelValue/update forwarding wrapper is forbidden`);
        }
        if (
            /\bFsusUiSegmentedControl\s+as\s+(?!FsusUiSegmentedControl\b)[A-Za-z_$][\w$]*/u.test(source)
      || /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*FsusUiSegmentedControl\b/u.test(source)
        )
        {
            failures.push(`${relativePath}: arbitrary FsusUiSegmentedControl compatibility alias is forbidden`);
        }
        if (/\.el-segmented(?:-control)?(?:__|[-\s.{:#])/u.test(source))
        {
            failures.push(`${relativePath}: private .el-segmented* consumer override is forbidden`);
        }
        if (
            relativePath !== articleListPath
      && /<button\b[\s\S]{0,800}\baria-pressed\b/u.test(source)
      && /\bitems\b[\s\S]{0,800}\bmodelValue\b|\bmodelValue\b[\s\S]{0,800}\bitems\b/u.test(source)
        )
        {
            failures.push(`${relativePath}: native button[aria-pressed] items/modelValue segmented implementation is forbidden`);
        }
        if (/\b(?:deprecated|legacy|fallback)\b[\s\S]{0,120}\bsegmented\b/iu.test(source))
        {
            failures.push(`${relativePath}: deprecated/legacy/fallback segmented compatibility layer is forbidden`);
        }
    }

    for (const token of [
        'ElSegmentedControl as FsusUiSegmentedControl',
        'SegmentedControlItem as FsusUiSegmentedControlItem',
        'SegmentedControlValue as FsusUiSegmentedControlValue'
    ])
    {
        if (!adapter.includes(token))
        {
            failures.push(`${adapterPath}: missing type-preserving public adapter token ${token}`);
        }
    }

    return failures;
}

export function auditAdminSegmentedControlBrowserContract(browserSmoke, visualRunner)
{
    const failures = [];

    for (const group of browserGroups)
    {
        if (countQuotedLiteral(browserSmoke, group) !== 1)
        {
            failures.push(`${browserSmokePath}: focused browser group must exist exactly once: ${group}`);
        }
        const escapedGroup = group.replace(/[()]/gu, '\\$&');
        if (countQuotedLiteral(visualRunner, escapedGroup) !== 1)
        {
            failures.push(`${visualRunnerPath}: focused browser group must be registered exactly once: ${group}`);
        }
    }

    for (const screenshot of evidenceScreenshots)
    {
        if (countQuotedLiteral(browserSmoke, screenshot) !== 1)
        {
            failures.push(`${browserSmokePath}: fixed evidence screenshot must exist exactly once: ${screenshot}`);
        }
    }

    for (const token of [
        'width: 375',
        '/user/manage/article/list?page=1&size=10&status=2',
        "style.zoom = '2'",
        "press('Home')",
        'ArrowRight',
        'toBeDisabled',
        'longLabel',
        'status=0',
        'status=3',
        'documentOverflow',
        'scrollWidth',
        'clientWidth',
        'scrollLeft',
        'itemInsideRoot',
        'itemNotClipped'
    ])
    {
        if (!browserSmoke.includes(token))
        {
            failures.push(`${browserSmokePath}: missing browser contract ${token}`);
        }
    }

    for (const token of [
        'ux/admin-article-segmented-consumer.spec.ts',
        'FSUSBLOG_VISUAL_DIAGNOSTICS_CONFIG:-playwright.diagnostics.config.ts',
        'segmented_consumer_groups',
        'for group in "${segmented_consumer_groups[@]}"'
    ])
    {
        if (!visualRunner.includes(token))
        {
            failures.push(`${visualRunnerPath}: missing focused browser execution contract ${token}`);
        }
    }
    if (
        !/npx playwright test --config="\$\{segmented_consumer_config\}"[\s\S]*ux\/admin-article-segmented-consumer\.spec\.ts --grep "\$\{group\}"/u
            .test(visualRunner)
    )
    {
        failures.push(`${visualRunnerPath}: focused browser execution must bind diagnostics config, spec and exact group grep`);
    }

    return failures;
}

function run()
{
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const sources = loadAdminSegmentedControlSources(root);
    const failures = auditAdminSegmentedControlRemoval(sources);
    const retiredTest = path.join(root, 'tests/frontend/unit/components/admin/AdminSegmentedControl.test.ts');
    if (fs.existsSync(retiredTest))
    {
        failures.push('tests/frontend/unit/components/admin/AdminSegmentedControl.test.ts: retired wrapper test must be removed');
    }
    const absoluteBrowserSmokePath = path.join(root, browserSmokePath);
    const absoluteVisualRunnerPath = path.join(root, visualRunnerPath);
    if (!fs.existsSync(absoluteBrowserSmokePath))
    {
        failures.push('tests/frontend/e2e/ux/admin-article-segmented-consumer.spec.ts: focused consumer browser smoke is required');
    }
    else
    {
        const browserSmoke = fs.readFileSync(absoluteBrowserSmokePath, 'utf8');
        const visualRunner = fs.existsSync(absoluteVisualRunnerPath)
            ? fs.readFileSync(absoluteVisualRunnerPath, 'utf8')
            : '';
        failures.push(...auditAdminSegmentedControlBrowserContract(browserSmoke, visualRunner));
    }

    if (failures.length > 0)
    {
        console.error(failures.map((failure) => `[admin-segmented-removal] ${failure}`).join('\n'));
        process.exit(1);
    }

    console.log('[admin-segmented-removal] ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    run();
}
