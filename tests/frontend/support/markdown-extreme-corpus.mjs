export const DEFAULT_MARKDOWN_EXTREME_SIZE = 500_000;

export function normalizeMarkdownExtremeSize(value)
{
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 10_000 ? Math.floor(parsed) : DEFAULT_MARKDOWN_EXTREME_SIZE;
}

export function normalizeMarkdownSource(input)
{
    return String(input || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function fnv1a32(input)
{
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1)
    {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

export function buildMarkdownExtremeCorpus(targetSize = DEFAULT_MARKDOWN_EXTREME_SIZE)
{
    const normalizedTargetSize = normalizeMarkdownExtremeSize(targetSize);
    const seedBlocks = [
        '\uFEFF# Markdown Extreme Corpus',
        '',
        'Intro paragraph with **strong**, *emphasis*, `inline code`, [link](https://example.com/path?q=markdown&x=1), 中文、かな、한글、emoji-like text, and escaped HTML.',
        '<script>alert("xss")</script><img src=x onerror=alert(1)>',
        '',
        '| Column A | Column B | Column C |',
        '| --- | ---: | :--- |',
        '| short | 42 | text |',
        '| very-long-cell | ' + 'cell-value-'.repeat(64) + ' | end |',
        '',
        '```ts',
        'const value = "<unsafe>& markdown";',
        'console.log(value.repeat(2));',
        '```',
        '',
        '```mermaid',
        'flowchart LR;',
        'A["Alpha Node"] --> B("Beta Branch");',
        'B --> C[Gamma End];',
        '```',
        '',
        ':::mermaid',
        'flowchart TD;',
        'Root["Root"] --> Leaf("Leaf");',
        ':::',
        '',
        'Inline math \\(x_1^2 + \\alpha + \\sqrt{b}\\) and display math:',
        '$$',
        '\\frac{a_1^2 + \\sqrt{b}}{\\alpha + 2}',
        '$$',
        '',
        'Invalid latex should stay contained: \\(\\frac{unterminated',
        '',
        '```mermaid',
        'flowchart LR;',
        'Broken -->',
        '```',
        '',
        '```',
        'unterminated fence sentinel starts here and keeps parser honest'
    ];

    const parts = [seedBlocks.join('\r\n')];
    let blockIndex = 0;
    while (parts.join('\n').length < normalizedTargetSize)
    {
        blockIndex += 1;
        parts.push([
            '',
            `## Boundary Section ${blockIndex}`,
            `Paragraph ${blockIndex} with repeated words ${'longword'.repeat((blockIndex % 7) + 1)} and inline math \\(n_${blockIndex}^2 + \\beta\\).`,
      blockIndex % 5 === 0 ? '```mermaid\nflowchart LR;\nN' + blockIndex + '["Node ' + blockIndex + '"] --> M' + blockIndex + '("Next");\n```' : '- list item alpha\n- list item beta\n- list item gamma',
      blockIndex % 9 === 0 ? '$$\n\\sum_{i=1}^{n} \\frac{i^2}{n}\n$$' : '| a | b |\n| --- | --- |\n| 1 | 2 |',
      `Escaped html probe ${blockIndex}: <iframe src="javascript:alert(${blockIndex})"></iframe>`,
      `Long url ${blockIndex}: https://example.com/${'segment/'.repeat(12)}?q=${blockIndex}&unsafe=%3Cscript%3E`
        ].join('\n'));
    }

    let corpus = parts.join('\n').slice(0, normalizedTargetSize + 4096);
    while (normalizeMarkdownSource(corpus).length < normalizedTargetSize)
    {
        corpus += `\n\nPadding boundary ${blockIndex}: ${'pad'.repeat(64)}`;
        blockIndex += 1;
    }
    return corpus;
}

export function describeMarkdownExtremeCorpus(source)
{
    const normalized = normalizeMarkdownSource(source);
    return {
        length: normalized.length,
        byteLength: Buffer.byteLength(normalized, 'utf8'),
        lineCount: normalized.split('\n').length,
        hash: fnv1a32(normalized),
        hasMermaid: normalized.includes('```mermaid') && normalized.includes(':::mermaid'),
        hasLatex: normalized.includes('\\(') && normalized.includes('$$'),
        hasDangerousHtmlProbe: normalized.includes('<script>') && normalized.includes('javascript:')
    };
}
