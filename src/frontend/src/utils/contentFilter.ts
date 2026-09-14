// 文件路径: src/utils/contentFilter.ts
// 职责: 前端轻量内容风控，避免违规输入消耗本地 WASM 算力及服务器带宽。

export interface ValidationResult {
    isValid: boolean;
    message: string;
}

export interface CommentMarkdownInspection extends ValidationResult {
    reasonCode: string;
    reviewText: string;
    linkTargets: string[];
}

export interface CommentContentPolicy {
    maxChars: number;
    maxUtf8Bytes: number;
}

export type ContentRiskFactor =
  | 'ad'
  | 'redline'
  | 'url'
  | 'obfuscation'
  | 'reserved'
  | 'repetition';

export interface ContentRiskScore {
    score: number;
    normalizedText: string;
    factors: ContentRiskFactor[];
    firstMatch: string | null;
}

export const PUBLIC_HANDLE_CONSTRAINT = {
    minLength: 3,
    maxLength: 20,
    patternMessage: '公开称呼允许中文、英文字母、数字和 #',
    lengthMessage: '公开称呼长度必须在 3 到 20 个字符之间'
} as const;

export const COMMENT_CONTENT_CONSTRAINT = {
    minMaxChars: 100,
    minMaxUtf8Bytes: 1024,
    defaultMaxChars: 1000,
    defaultMaxUtf8Bytes: 4096,
    hardMaxChars: 3000,
    hardMaxUtf8Bytes: 12288,
    maxChars: 1000,
    maxUtf8Bytes: 4096,
    createPayloadMaxBytes: 16 * 1024,
    rootRenderLimit: 20,
    replyRenderLimit: 300,
    collapsedMarkdownMaxLines: 8,
    charLengthMessage: '评论内容不能超过 1000 个字符',
    byteLengthMessage: '评论内容编码后不能超过 4096 bytes',
    imageMarkdownMessage: '评论暂不支持图片 Markdown，请改为文字或链接。',
    rawHtmlMessage: '评论暂不支持 HTML，请使用 Markdown 文本格式。',
    unsafeLinkMessage: '评论链接仅支持 http/https 或相对地址。'
} as const;

const utf8Encoder = new TextEncoder();

export const DEFAULT_COMMENT_CONTENT_POLICY: CommentContentPolicy = Object.freeze({
    maxChars: COMMENT_CONTENT_CONSTRAINT.defaultMaxChars,
    maxUtf8Bytes: COMMENT_CONTENT_CONSTRAINT.defaultMaxUtf8Bytes
});

interface AhoCorasickNode {
    next: Map<string, number>;
    fail: number;
    outputs: string[];
}

export type AhoCorasickMatcher = Readonly<{
    findFirst: (text: string) => string | null;
    findAll: (text: string) => string[];
}>;

const structuralAdRegex = /(日入\s*\d+|微信\s*[:：=]|威信\s*[:：=]|薇信\s*[:：=]|[qQ]{2}\s*[:：=]|t\.cn\/|dwz\.cn\/|suo\.im\/|url\.cn\/)/i;
const whiteListRegex = /(学习|复习|练习|预习|实习|演习|习惯|习俗|习题|恶习|陋习|最近|接近|附近|靠近|亲近|近期|近日|远近|近似|和平|平安|公平|水平|平常|平静|平稳|平等|平台|生平|平局)/g;
const topRedLineRegex = /([习習].{0,6}近.{0,6}平|毛.{0,6}[泽澤].{0,6}[东東]|六.{0,6}四.{0,6}事.{0,6}件)/i;
const zeroWidthRegex = /[\u200B-\u200F\uFEFF\u202A-\u202E]/g;
const zeroWidthDetector = /[\u200B-\u200F\uFEFF\u202A-\u202E]/;
const urlLikeRegex = /(https?:\/\/|www\.|t\.cn\/|dwz\.cn\/|suo\.im\/|url\.cn\/)/i;
const markdownReferenceDefinitionRegex = /^\s{0,3}\[([^\]]+)\]:\s*(\S[^\n]*)$/u;
const markdownFenceRegex = /^\s{0,3}(`{3,}|~{3,})/;
const rawHtmlStartRegex = /^<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s|>|\/>)/u;

const confusableCharacters = new Map<string, string>([
    ['習', '习'],
    ['澤', '泽'],
    ['東', '东'],
    ['薇', '微'],
    ['威', '微'],
    ['嶶', '微'],
    ['扣', 'q'],
    ['＋', '+']
]);

const moderationTerms = [
    '加微',
    '加微信',
    '加vx',
    '+v',
    'vx:',
    'vx=',
    '微信:',
    '微信=',
    'qq:',
    'qq=',
    'q群',
    '加群',
    '企鹅',
    '扣扣',
    '代开',
    '代写',
    '代刷',
    '刷单',
    '兼职',
    '网赚',
    '博彩',
    '棋牌',
    '菠菜',
    '澳门金沙',
    '新葡京',
    '威尼斯人',
    '裸聊',
    '同城约',
    '上门服务',
    '富婆包养',
    't.cn/',
    'dwz.cn/',
    'suo.im/',
    'url.cn/'
] as const;

const reservedIdentityHandleTerms = [
    'admin',
    'administrator',
    'system',
    'root',
    'moderator',
    'fsusblog',
    'fsu'
] as const;

function tryDecodeUriComponent(input: string): string
{
    try
    {
        return decodeURIComponent(input);
    }
    catch
    {
        return input;
    }
}

export function normalizeModerationText(input: string): string
{
    const decoded = tryDecodeUriComponent(input);
    const normalized = decoded.normalize('NFKC').replace(zeroWidthRegex, '').toLocaleLowerCase();
    let output = '';
    let previous = '';
    let repeated = 0;

    for (const char of normalized)
    {
        if (/\s/u.test(char))
        {
            continue;
        }

        const mapped = confusableCharacters.get(char) ?? char;
        repeated = mapped === previous ? repeated + 1 : 1;
        previous = mapped;

        if (repeated <= 2)
        {
            output += mapped;
        }
    }

    return output;
}

export function createAhoCorasickMatcher(patterns: readonly string[]): AhoCorasickMatcher
{
    const nodes: AhoCorasickNode[] = [{ next: new Map<string, number>(), fail: 0, outputs: [] }];

    for (const pattern of patterns)
    {
        if (!pattern)
        {
            continue;
        }

        let state = 0;
        for (const char of pattern)
        {
            const existing = nodes[state].next.get(char);
            if (existing !== undefined)
            {
                state = existing;
                continue;
            }

            const nextState = nodes.length;
            nodes[state].next.set(char, nextState);
            nodes.push({ next: new Map<string, number>(), fail: 0, outputs: [] });
            state = nextState;
        }

        nodes[state].outputs.push(pattern);
    }

    const queue: number[] = [];
    for (const state of nodes[0].next.values())
    {
        nodes[state].fail = 0;
        queue.push(state);
    }

    for (let index = 0; index < queue.length; index += 1)
    {
        const state = queue[index];
        for (const [char, nextState] of nodes[state].next)
        {
            let failState = nodes[state].fail;
            while (failState !== 0 && !nodes[failState].next.has(char))
            {
                failState = nodes[failState].fail;
            }

            nodes[nextState].fail = nodes[failState].next.get(char) ?? 0;
            nodes[nextState].outputs.push(...nodes[nodes[nextState].fail].outputs);
            queue.push(nextState);
        }
    }

    const step = (state: number, char: string): number =>
    {
        while (state !== 0 && !nodes[state].next.has(char))
        {
            state = nodes[state].fail;
        }

        return nodes[state].next.get(char) ?? 0;
    };

    return {
        findFirst(text: string): string | null
        {
            let state = 0;
            for (const char of text)
            {
                state = step(state, char);
                if (nodes[state].outputs.length > 0)
                {
                    return nodes[state].outputs[0];
                }
            }

            return null;
        },
        findAll(text: string): string[]
        {
            const matches: string[] = [];
            let state = 0;
            for (const char of text)
            {
                state = step(state, char);
                matches.push(...nodes[state].outputs);
            }

            return matches;
        }
    };
}

const adMatcher = createAhoCorasickMatcher(moderationTerms.map(normalizeModerationText));
const reservedIdentityHandleSet = new Set(reservedIdentityHandleTerms.map(normalizeModerationText));
const reservedIdentityHandleMatcher = createAhoCorasickMatcher([...reservedIdentityHandleSet]);

export function createUsernamePattern(): RegExp
{
    try
    {
        return new RegExp('^[\\p{Script=Han}\\p{L}]+$', 'u');
    }
    catch
    {
        return /^[\u4e00-\u9fa5A-Za-z]+$/;
    }
}

export function isUsernameCharacterSetValid(value: string): boolean
{
    return createUsernamePattern().test(value);
}

export function createPublicHandlePattern(): RegExp
{
    try
    {
        return new RegExp('^[\\p{Script=Han}\\p{L}0-9#]+$', 'u');
    }
    catch
    {
        return /^[\u4e00-\u9fa5A-Za-z0-9#]+$/;
    }
}

export function isPublicHandleCharacterSetValid(value: string): boolean
{
    return createPublicHandlePattern().test(value);
}

function pushFactor(factors: ContentRiskFactor[], factor: ContentRiskFactor): void
{
    if (!factors.includes(factor))
    {
        factors.push(factor);
    }
}

function successMarkdownInspection(reviewText: string, linkTargets: string[]): CommentMarkdownInspection
{
    return {
        isValid: true,
        message: '',
        reasonCode: 'ok',
        reviewText: reviewText.replace(/\s+/gu, ' ').trim(),
        linkTargets
    };
}

function failMarkdownInspection(reasonCode: string, message: string): CommentMarkdownInspection
{
    return {
        isValid: false,
        message,
        reasonCode,
        reviewText: '',
        linkTargets: []
    };
}

function normalizeReferenceLabel(label: string): string
{
    return label.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function extractMarkdownLinkDestination(rawDestination: string): string
{
    const value = rawDestination.trim();
    if (value.startsWith('<'))
    {
        const end = value.indexOf('>');
        return end > 0 ? value.slice(1, end).trim() : value.slice(1).trim();
    }

    const whitespace = value.search(/\s/u);
    return whitespace >= 0 ? value.slice(0, whitespace).trim() : value;
}

function normalizeUrlForPolicy(value: string): string
{
    return value.trim().replace(/[\u0000-\u001f\u007f\s]+/gu, '');
}

function isSafeCommentLinkDestination(value: string): boolean
{
    const normalized = normalizeUrlForPolicy(extractMarkdownLinkDestination(value));
    if (!normalized || normalized.startsWith('#') || normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../'))
    {
        return true;
    }

    try
    {
        const parsed = new URL(normalized, 'https://fsus.invalid');
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        {
            return true;
        }

        return !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized);
    }
    catch
    {
        return false;
    }
}

function buildLinkReviewTarget(value: string): string
{
    const normalized = normalizeUrlForPolicy(extractMarkdownLinkDestination(value));
    if (!normalized)
    {
        return '';
    }

    try
    {
        const parsed = new URL(normalized, 'https://fsus.invalid');
        if (parsed.hostname === 'fsus.invalid')
        {
            return parsed.pathname === '/' ? '' : parsed.pathname;
        }

        return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    }
    catch
    {
        return normalized.split(/[?#]/u)[0] ?? normalized;
    }
}

function findClosingBracket(source: string, start: number): number
{
    let escaped = false;
    for (let index = start; index < source.length; index += 1)
    {
        const char = source[index];
        if (escaped)
        {
            escaped = false;
            continue;
        }
        if (char === '\\')
        {
            escaped = true;
            continue;
        }
        if (char === ']')
        {
            return index;
        }
    }

    return -1;
}

function findClosingParen(source: string, start: number): number
{
    let escaped = false;
    let depth = 0;
    for (let index = start; index < source.length; index += 1)
    {
        const char = source[index];
        if (escaped)
        {
            escaped = false;
            continue;
        }
        if (char === '\\')
        {
            escaped = true;
            continue;
        }
        if (char === '(')
        {
            depth += 1;
            continue;
        }
        if (char === ')')
        {
            if (depth === 0)
            {
                return index;
            }
            depth -= 1;
        }
    }

    return -1;
}

function skipHorizontalWhitespace(source: string, start: number): number
{
    let index = start;
    while (index < source.length && /[ \t]/u.test(source[index] ?? ''))
    {
        index += 1;
    }
    return index;
}

function stripLinePrefix(line: string): string
{
    return line
        .replace(/^\s{0,3}#{1,6}\s+/u, '')
        .replace(/^\s{0,3}>\s?/u, '')
        .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/u, '');
}

function collectReferenceDefinitions(source: string): Map<string, string>
{
    const references = new Map<string, string>();
    let inFence = false;
    let fenceMarker = '';
    for (const line of source.replace(/\r\n?/gu, '\n').split('\n'))
    {
        const fence = (markdownFenceRegex.exec(line))?.[1];
        if (fence)
        {
            if (!inFence)
            {
                inFence = true;
                fenceMarker = fence[0] ?? '';
            }
            else if ((fence[0] ?? '') === fenceMarker)
            {
                inFence = false;
                fenceMarker = '';
            }
            continue;
        }
        if (inFence)
        {
            continue;
        }

        const match = markdownReferenceDefinitionRegex.exec(line);
        if (match)
        {
            references.set(normalizeReferenceLabel(match[1] ?? ''), extractMarkdownLinkDestination(match[2] ?? ''));
        }
    }

    return references;
}

function readInlineMarkdownReview(
    line: string,
    references: ReadonlyMap<string, string>,
    linkTargets: string[]
): { ok: true; text: string; } | { ok: false; reasonCode: string; message: string; }
{
    let output = '';
    const source = stripLinePrefix(line);

    for (let index = 0; index < source.length; index += 1)
    {
        const char = source[index] ?? '';

        if (char === '`')
        {
            const end = source.indexOf('`', index + 1);
            if (end > index)
            {
                output += ` ${source.slice(index + 1, end)} `;
                index = end;
                continue;
            }
        }

        if (source.startsWith('<!--', index) || rawHtmlStartRegex.test(source.slice(index)))
        {
            return {
                ok: false,
                reasonCode: 'comment_markdown_html',
                message: COMMENT_CONTENT_CONSTRAINT.rawHtmlMessage
            };
        }

        if (char === '!' && source[index + 1] === '[')
        {
            const labelEnd = findClosingBracket(source, index + 2);
            if (labelEnd > index)
            {
                const next = skipHorizontalWhitespace(source, labelEnd + 1);
                if (source[next] === '(' || source[next] === '[' || next >= source.length)
                {
                    return {
                        ok: false,
                        reasonCode: 'comment_markdown_image',
                        message: COMMENT_CONTENT_CONSTRAINT.imageMarkdownMessage
                    };
                }
            }
        }

        if (char === '[')
        {
            const labelEnd = findClosingBracket(source, index + 1);
            if (labelEnd > index)
            {
                const label = source.slice(index + 1, labelEnd);
                const next = skipHorizontalWhitespace(source, labelEnd + 1);
                if (source[next] === '(')
                {
                    const destinationEnd = findClosingParen(source, next + 1);
                    if (destinationEnd > next)
                    {
                        const destination = source.slice(next + 1, destinationEnd);
                        if (!isSafeCommentLinkDestination(destination))
                        {
                            return {
                                ok: false,
                                reasonCode: 'comment_markdown_unsafe_link',
                                message: COMMENT_CONTENT_CONSTRAINT.unsafeLinkMessage
                            };
                        }
                        const reviewTarget = buildLinkReviewTarget(destination);
                        if (reviewTarget)
                        {
                            linkTargets.push(reviewTarget);
                            output += ` ${label} ${reviewTarget} `;
                        }
                        else
                        {
                            output += ` ${label} `;
                        }
                        index = destinationEnd;
                        continue;
                    }
                }
                else if (source[next] === '[')
                {
                    const refEnd = source.indexOf(']', next + 1);
                    if (refEnd > next)
                    {
                        const refLabel = source.slice(next + 1, refEnd) || label;
                        const destination = references.get(normalizeReferenceLabel(refLabel));
                        if (destination)
                        {
                            if (!isSafeCommentLinkDestination(destination))
                            {
                                return {
                                    ok: false,
                                    reasonCode: 'comment_markdown_unsafe_link',
                                    message: COMMENT_CONTENT_CONSTRAINT.unsafeLinkMessage
                                };
                            }
                            const reviewTarget = buildLinkReviewTarget(destination);
                            if (reviewTarget)
                            {
                                linkTargets.push(reviewTarget);
                                output += ` ${label} ${reviewTarget} `;
                            }
                            else
                            {
                                output += ` ${label} `;
                            }
                            index = refEnd;
                            continue;
                        }
                    }
                }
            }
        }

        if (/[*_~>#|]/u.test(char))
        {
            output += ' ';
        }
        else
        {
            output += char;
        }
    }

    return { ok: true, text: output };
}

export function inspectCommentMarkdownContent(text: string): CommentMarkdownInspection
{
    const source = text.trim();
    if (!source)
    {
        return successMarkdownInspection('', []);
    }

    const references = collectReferenceDefinitions(source);
    const linkTargets: string[] = [];
    const reviewParts: string[] = [];
    let inFence = false;
    let fenceMarker = '';

    for (const line of source.replace(/\r\n?/gu, '\n').split('\n'))
    {
        const fence = (markdownFenceRegex.exec(line))?.[1];
        if (fence)
        {
            if (!inFence)
            {
                inFence = true;
                fenceMarker = fence[0] ?? '';
            }
            else if ((fence[0] ?? '') === fenceMarker)
            {
                inFence = false;
                fenceMarker = '';
            }
            continue;
        }

        if (inFence)
        {
            reviewParts.push(line);
            continue;
        }

        if (markdownReferenceDefinitionRegex.test(line))
        {
            continue;
        }

        const inline = readInlineMarkdownReview(line, references, linkTargets);
        if (!inline.ok)
        {
            return failMarkdownInspection(inline.reasonCode, inline.message);
        }
        reviewParts.push(inline.text);
    }

    return successMarkdownInspection(reviewParts.join(' '), linkTargets);
}

function clampRisk(value: number): number
{
    return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

export function scoreContentRisk(text: string): ContentRiskScore
{
    const normalizedText = normalizeModerationText(text);
    const factors: ContentRiskFactor[] = [];
    let score = 0;
    let firstMatch: string | null = null;

    if (zeroWidthDetector.test(text) || normalizedText !== text.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ''))
    {
        pushFactor(factors, 'obfuscation');
        score += 0.2;
    }

    if (/(.)\1{3,}/u.test(text.normalize('NFKC')))
    {
        pushFactor(factors, 'repetition');
        score += 0.12;
    }

    firstMatch = adMatcher.findFirst(normalizedText);
    if (firstMatch || structuralAdRegex.test(text))
    {
        pushFactor(factors, 'ad');
        score += 0.92;
    }

    if (urlLikeRegex.test(normalizedText))
    {
        pushFactor(factors, 'url');
        score += 0.35;
    }

    const safeText = normalizedText.replace(whiteListRegex, '○');
    if (topRedLineRegex.test(safeText))
    {
        pushFactor(factors, 'redline');
        score = 1;
    }

    return {
        score: clampRisk(score),
        normalizedText,
        factors,
        firstMatch
    };
}

export function validateCommentContent(text: string, policy?: Partial<CommentContentPolicy> | null): ValidationResult
{
    return validateCommentContentWithPolicy(text, policy ?? DEFAULT_COMMENT_CONTENT_POLICY);
}

export function normalizeCommentContentPolicy(policy?: Partial<CommentContentPolicy> | null): CommentContentPolicy
{
    const maxChars = Number(policy?.maxChars);
    const maxUtf8Bytes = Number(policy?.maxUtf8Bytes);
    return {
        maxChars: Number.isFinite(maxChars) &&
      maxChars >= COMMENT_CONTENT_CONSTRAINT.minMaxChars &&
      maxChars <= COMMENT_CONTENT_CONSTRAINT.hardMaxChars
            ? Math.trunc(maxChars)
            : COMMENT_CONTENT_CONSTRAINT.defaultMaxChars,
        maxUtf8Bytes: Number.isFinite(maxUtf8Bytes) &&
      maxUtf8Bytes >= COMMENT_CONTENT_CONSTRAINT.minMaxUtf8Bytes &&
      maxUtf8Bytes <= COMMENT_CONTENT_CONSTRAINT.hardMaxUtf8Bytes
            ? Math.trunc(maxUtf8Bytes)
            : COMMENT_CONTENT_CONSTRAINT.defaultMaxUtf8Bytes
    };
}

export function getCommentUtf8ByteLength(text: string): number
{
    return utf8Encoder.encode(text).byteLength;
}

export function validateCommentContentWithPolicy(
    text: string,
    policy?: Partial<CommentContentPolicy> | null
): ValidationResult
{
    const trimmed = text.trim();
    const resolvedPolicy = normalizeCommentContentPolicy(policy);
    if (!text || trimmed === '')
    {
        return { isValid: false, message: '评论内容不能为空' };
    }

    if (getCommentUtf8ByteLength(trimmed) > resolvedPolicy.maxUtf8Bytes)
    {
        return {
            isValid: false,
            message: resolvedPolicy.maxUtf8Bytes === COMMENT_CONTENT_CONSTRAINT.defaultMaxUtf8Bytes
                ? COMMENT_CONTENT_CONSTRAINT.byteLengthMessage
                : `评论内容编码后不能超过 ${resolvedPolicy.maxUtf8Bytes} bytes`
        };
    }

    if (trimmed.length > resolvedPolicy.maxChars)
    {
        return {
            isValid: false,
            message: resolvedPolicy.maxChars === COMMENT_CONTENT_CONSTRAINT.defaultMaxChars
                ? COMMENT_CONTENT_CONSTRAINT.charLengthMessage
                : `评论内容不能超过 ${resolvedPolicy.maxChars} 个字符`
        };
    }

    const markdownInspection = inspectCommentMarkdownContent(trimmed);
    if (!markdownInspection.isValid)
    {
        return { isValid: false, message: markdownInspection.message };
    }

    return { isValid: true, message: '' };
}

export function validatePublicHandle(publicHandle: string): ValidationResult
{
    if (!publicHandle || publicHandle.trim() === '')
    {
        return { isValid: false, message: '公开称呼不能为空' };
    }

    if (zeroWidthDetector.test(publicHandle))
    {
        return { isValid: false, message: '公开称呼包含非法的隐形排版字符' };
    }

    const cleanHandle = publicHandle.trim();
    if (cleanHandle.length < PUBLIC_HANDLE_CONSTRAINT.minLength || cleanHandle.length > PUBLIC_HANDLE_CONSTRAINT.maxLength)
    {
        return { isValid: false, message: PUBLIC_HANDLE_CONSTRAINT.lengthMessage };
    }

    if (!isPublicHandleCharacterSetValid(cleanHandle))
    {
        return { isValid: false, message: PUBLIC_HANDLE_CONSTRAINT.patternMessage };
    }

    const normalizedHandle = normalizeModerationText(cleanHandle);
    if (reservedIdentityHandleSet.has(normalizedHandle) || reservedIdentityHandleMatcher.findFirst(normalizedHandle) === normalizedHandle)
    {
        return { isValid: false, message: '该公开称呼已被系统保留，请更换' };
    }

    const risk = scoreContentRisk(cleanHandle);
    if (risk.factors.includes('ad'))
    {
        return { isValid: false, message: '公开称呼包含违规引流特征' };
    }

    if (risk.factors.includes('redline'))
    {
        return { isValid: false, message: '严重违规：公开称呼包含对抗性涉政词汇' };
    }

    return { isValid: true, message: '' };
}
