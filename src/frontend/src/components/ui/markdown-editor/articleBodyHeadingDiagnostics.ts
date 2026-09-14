export type ArticleBodyH1Kind = 'atx' | 'setext';

export type ArticleBodyH1Issue = Readonly<{
    line: number;
    kind: ArticleBodyH1Kind;
    text: string;
}>;

function fenceMarker(line: string): { character: '`' | '~'; count: number } | null
{
    const match = /^( {0,3})(`{3,}|~{3,})/u.exec(line);
    if (!match)
    {
        return null;
    }

    const marker = match[2] ?? '';
    return {
        character: marker.startsWith('`') ? '`' : '~',
        count: marker.length
    };
}

function closesFence(line: string, marker: { character: '`' | '~'; count: number }): boolean
{
    const match = /^( {0,3})(`{3,}|~{3,})\s*$/u.exec(line);
    if (!match)
    {
        return false;
    }

    const closing = match[2] ?? '';
    return closing.startsWith(marker.character) && closing.length >= marker.count;
}

function isAtxH1(line: string): boolean
{
    return /^ {0,3}#(?!#)(?:[ \t]+|[ \t]*#*[ \t]*$)/u.test(line);
}

function isSetextH1Underline(line: string): boolean
{
    return /^ {0,3}=+[ \t]*$/u.test(line);
}

function headingPreview(line: string): string
{
    return line.replace(/^ {0,3}#(?:[ \t]+|[ \t]*#*[ \t]*$)/u, '').replace(/[ \t]+#*[ \t]*$/u, '').trim();
}

/**
 * Detects body-level Markdown H1 without rewriting source. Fenced code is
 * ignored so authors can document heading syntax. Setext `===` underlines
 * count as H1; H2–H6 and empty documents produce no issues.
 */
export function diagnoseArticleBodyH1(source: string): readonly ArticleBodyH1Issue[]
{
    if (!source)
    {
        return [];
    }

    const lines = source.split(/\r?\n/u);
    const issues: ArticleBodyH1Issue[] = [];
    let fence: { character: '`' | '~'; count: number } | null = null;

    for (let index = 0; index < lines.length; index += 1)
    {
        const line = lines[index] ?? '';
        if (fence)
        {
            if (closesFence(line, fence))
            {
                fence = null;
            }
            continue;
        }

        const opening = fenceMarker(line);
        if (opening)
        {
            fence = opening;
            continue;
        }

        if (isAtxH1(line))
        {
            issues.push({
                kind: 'atx',
                line: index + 1,
                text: headingPreview(line) || line.trim()
            });
            continue;
        }

        if (index > 0 && isSetextH1Underline(line))
        {
            const previous = lines[index - 1] ?? '';
            if (previous.trim() && !/^ {0,3}#{1,6}(?:[ \t]|$)/u.test(previous) && !isSetextH1Underline(previous))
            {
                issues.push({
                    kind: 'setext',
                    line: index,
                    text: previous.trim()
                });
            }
        }
    }

    return issues;
}

export function formatArticleBodyH1Diagnostic(
    issues: readonly ArticleBodyH1Issue[]
): string | null
{
    if (issues.length === 0)
    {
        return null;
    }

    const lineList = issues.map((issue) => String(issue.line)).join('、');
    return `正文含 ${issues.length} 个一级标题（第 ${lineList} 行）。文章标题已是页面唯一 H1；现有正文不会被改写，请将一级标题改为章节（##）。`;
}
