const sourceExtensions = /\.(?:css|scss|vue|ts|tsx|js|jsx)$/u;
const forbiddenPattern = /font-size\s*:\s*(0?\.[6-9][0-9]*(?:rem|em)|(?:11|13)px)(?:\s*!important)?\s*;/gu;
const exceptions = new Map([
    ['src/frontend/src/components/account/AccountNavigationPanel.vue', new Set(['11px', '13px'])],
    ['src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue', new Set(['13px'])],
    ['src/frontend/src/components/admin/AdminTaxonomyManageView.vue', new Set(['13px'])]
]);

function span(content, start, end)
{
    const lines = content.slice(0, start).split('\n');
    return { start, end, line: lines.length, column: lines.at(-1).length + 1 };
}

function finding(path, content, start, end, code, message)
{
    return {
        id: `font-size-contract:${code}:${path}:${start}`,
        path,
        span: span(content, start, end),
        message
    };
}

function file(index, path)
{
    return index.files.find((entry) => entry.path === path);
}

function expectRule(findings, record, label, pattern, expectedSize)
{
    const body = pattern.exec(record.content)?.groups?.body ?? '';
    if (!body || !new RegExp(`font-size\\s*:\\s*${expectedSize.replace('.', '\\.')};`, 'u').test(body))
    {
        findings.push(finding(record.path, record.content, 0, 0, `required-${label.replaceAll(' ', '-')}`,
            `${label} must keep font-size ${expectedSize}`));
    }
}

export const fontSizeContractRule = {
    id: 'font-size-contract',
    coverageIds: ['frontend-public-typography', 'frontend-source-index-rule-host'],
    legacyMetrics(index)
    {
        const scanned = index.files.filter(({ path }) =>
            (path.startsWith('src/frontend/src/') && !path.startsWith('src/frontend/src/generated/')
                && sourceExtensions.test(path))
            || path === 'src/frontend/public/public-shell-emergency.css').length;
        return {
            inventoryCount: scanned,
            readCount: scanned + 5,
            primaryParseCount: scanned
        };
    },
    evaluate(index, { scanOnly = false } = {})
    {
        const findings = [];
        for (const record of index.files.filter(({ path }) =>
            (path.startsWith('src/frontend/src/') && !path.startsWith('src/frontend/src/generated/')
        && sourceExtensions.test(path))
      || path === 'src/frontend/public/public-shell-emergency.css'))
        {
            forbiddenPattern.lastIndex = 0;
            for (const match of record.content.matchAll(forbiddenPattern))
            {
                if (exceptions.get(record.path)?.has(match[1]))
                {
                    continue;
                }
                findings.push(finding(
                    record.path,
                    record.content,
                    match.index,
                    match.index + match[0].length,
                    'forbidden-declaration',
                    `font-size ${match[1]} must use the canonical 12/14/16px small-text scale`
                ));
            }
        }
        if (scanOnly)
        {
            return { findings };
        }

        const markdown = file(index, 'src/frontend/src/assets/markdown.css');
        const comments = file(index, 'src/frontend/src/components/article/ArticleCommentsVirtualList.vue');
        const identity = file(index, 'src/frontend/src/views/user/IdentityCenter.vue');
        const account = file(index, 'src/frontend/src/assets/account-shell-base.css');
        const docs = file(index, 'docs/design/reading-typography.md');
        for (const required of [markdown, comments, identity, account, docs])
        {
            if (!required)
            {
                throw new Error('font-size-contract source is absent from index');
            }
        }
        const quote = /\.markdown-body blockquote\s*\{(?<body>[^}]*)\}/u.exec(markdown.content)?.groups?.body ?? '';
        if (!quote || /font-size\s*:/u.test(quote))
        {
            findings.push(finding(markdown.path, markdown.content, 0, 0, 'blockquote-inherit',
                'blockquote must inherit the canonical 16px Markdown reading size'));
        }
        if (!/\.fsus-comment__reply-target,\s*\n\.fsus-comment__time\s*\{[^}]*font-size:\s*14px;[^}]*line-height:\s*1\.4;/su.test(comments.content))
        {
            findings.push(finding(comments.path, comments.content, 0, 0, 'comment-time',
                'comment time metadata must keep the 14px/1.4 contract'));
        }
        for (const [label, pattern, size] of [
            ['status value', /\.identity-status-card strong\s*\{(?<body>[^}]*)\}/u, '16px'],
            ['status description', /\.identity-status-card p,\s*\.identity-copy-block p\s*\{(?<body>[^}]*)\}/u, '12px'],
            ['status label', /\.identity-status-label\s*\{(?<body>[^}]*)\}/u, '12px'],
            ['summary list', /\.identity-summary-list,\s*\.identity-state-row\s*\{(?<body>[^}]*)\}/u, '14px'],
            ['summary term', /\.identity-summary-list dt\s*\{(?<body>[^}]*)\}/u, '12px'],
            ['summary detail', /\.identity-summary-list dt\s*\{[^}]*\}\s*\.identity-summary-list dd\s*\{(?<body>[^}]*)\}/u, '14px'],
            ['policy item', /\.identity-policy-item\s*\{(?<body>[^}]*)\}/u, '14px'],
            ['loading and error states', /\.identity-loading-state,\s*\.identity-error-state\s*\{(?<body>[^}]*)\}/u, '14px'],
            ['secret value', /\.identity-secret-panel code\s*\{(?<body>[^}]*)\}/u, '14px']
        ])
        {
            expectRule(findings, identity, label, pattern, size);
        }
        expectRule(findings, account, 'account header action', /\.account-header-link\s*\{(?<body>[^}]*)\}/u, '12px');
        for (const text of [
            'CSS `font-size` 小字号只写 `12px`、`14px` 或 `16px`',
            '`AccountNavigationPanel.vue` 的导航层级是唯一例外',
            'Markdown blockquote 继承 16px'
        ])
        {
            if (!docs.content.includes(text))
            {
                findings.push(finding(docs.path, docs.content, 0, 0, `docs-${findings.length}`,
                    `missing font-size contract text: ${text}`));
            }
        }
        return { findings };
    }
};
