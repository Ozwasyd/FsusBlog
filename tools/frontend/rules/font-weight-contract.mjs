const sourceExtensions = /\.(?:css|scss|vue|ts|tsx|js|jsx)$/u;
const allowedNumericWeights = new Set(['400', '500', '700']);
const patterns = [
    {
        code: 'numeric-declaration',
        pattern: /font-weight\s*:\s*(\d{3})(?:\s*!important)?\s*;/gu,
        message(match)
        {
            return allowedNumericWeights.has(match[1])
                ? null
                : `font-weight ${match[1]} is outside the 400/500/700 whitelist`;
        }
    },
    {
        code: 'forbidden-utility',
        pattern: /\bfont-(thin|extralight|light|semibold|extrabold|black)\b/gu,
        message(match)
        {
            return `utility ${match[0]} requests a font weight outside the 400/500/700 whitelist`;
        }
    },
    {
        code: 'arbitrary-utility',
        pattern: /\bfont-\[(\d{3})\]\b/gu,
        message(match)
        {
            return allowedNumericWeights.has(match[1])
                ? null
                : `utility ${match[0]} requests a font weight outside the 400/500/700 whitelist`;
        }
    }
];

function span(content, start, end)
{
    const lines = content.slice(0, start).split('\n');
    return { start, end, line: lines.length, column: lines.at(-1).length + 1 };
}

function finding(path, content, start, end, code, message)
{
    return {
        id: `font-weight-contract:${code}:${path}:${start}`,
        path,
        span: span(content, start, end),
        message
    };
}

function file(index, path)
{
    return index.files.find((entry) => entry.path === path);
}

function expectRule(findings, record, label, pattern, expectedWeight)
{
    const body = pattern.exec(record.content)?.groups?.body ?? '';
    if (!body || !new RegExp(`font-weight\\s*:\\s*${expectedWeight};`, 'u').test(body))
    {
        findings.push(finding(record.path, record.content, 0, 0, `required-${label.replaceAll(' ', '-')}`,
            `${label} must keep font-weight ${expectedWeight}`));
    }
}

export const fontWeightContractRule = {
    id: 'font-weight-contract',
    coverageIds: ['frontend-public-typography', 'frontend-source-index-rule-host'],
    legacyMetrics(index)
    {
        const scanned = index.files.filter(({ path }) =>
            path.startsWith('src/frontend/src/') && sourceExtensions.test(path)).length;
        return {
            inventoryCount: scanned,
            readCount: scanned + 4,
            primaryParseCount: scanned
        };
    },
    evaluate(index, { scanOnly = false } = {})
    {
        const findings = [];
        for (const record of index.files.filter(({ path }) =>
            path.startsWith('src/frontend/src/') && sourceExtensions.test(path)))
        {
            for (const { code, pattern, message } of patterns)
            {
                pattern.lastIndex = 0;
                for (const match of record.content.matchAll(pattern))
                {
                    const detail = message(match);
                    if (detail)
                    {
                        findings.push(finding(
                            record.path,
                            record.content,
                            match.index,
                            match.index + match[0].length,
                            code,
                            detail
                        ));
                    }
                }
            }
        }
        if (scanOnly)
        {
            return { findings };
        }

        const composer = file(index, 'src/frontend/src/components/article/ArticleCommentComposer.vue');
        const toc = file(index, 'src/frontend/src/components/article/ArticleTocPanel.vue');
        const markdown = file(index, 'src/frontend/src/assets/markdown.css');
        const docs = file(index, 'docs/design/reading-typography.md');
        for (const required of [composer, toc, markdown, docs])
        {
            if (!required)
            {
                throw new Error(`font-weight-contract source is absent from index`);
            }
        }
        for (const [label, pattern] of [
            ['identity label', /\.comment-identity-label\s*\{(?<body>[^}]*)\}/u],
            ['identity badge', /\.comment-identity-badge\s*\{(?<body>[^}]*)\}/u],
            ['identity toggle', /\.comment-identity-toggle\s*\{(?<body>[^}]*)\}/u],
            ['draft status', /\.comment-composer-draft\s*\{(?<body>[^}]*)\}/u],
            ['empty preview', /\.comment-composer-preview\.is-empty\s*\{(?<body>[^}]*)\}/u],
            ['feedback', /\.comment-composer-feedback\s*\{(?<body>[^}]*)\}/u],
            ['metrics', /\.comment-composer-metrics\s*\{(?<body>[^}]*)\}/u]
        ])
        {
            expectRule(findings, composer, label, pattern, '700');
        }
        expectRule(findings, toc, 'desktop TOC title', /\.article-toc-panel__title\s*\{(?<body>[^}]*)\}/u, '700');
        expectRule(findings, markdown, 'Markdown root', /\.markdown-body\s*\{(?<body>[^}]*)\}/u, '400');
        const quote = /\.markdown-body blockquote\s*\{(?<body>[^}]*)\}/u.exec(markdown.content)?.groups?.body ?? '';
        if (!quote || /font-weight\s*:/u.test(quote))
        {
            findings.push(finding(markdown.path, markdown.content, 0, 0, 'blockquote-inherit',
                'blockquote must inherit the loaded 400 Markdown root weight'));
        }
        for (const text of [
            '## 加载字重',
            '只允许真实加载的 `400`、`500`、`700`',
            '`font-normal`、`font-medium`、`font-bold`',
            '不得依赖浏览器合成缺失的粗体或细体'
        ])
        {
            if (!docs.content.includes(text))
            {
                findings.push(finding(docs.path, docs.content, 0, 0, `docs-${findings.length}`,
                    `missing font-weight contract text: ${text}`));
            }
        }
        return { findings };
    }
};
