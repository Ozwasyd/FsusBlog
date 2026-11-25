namespace FsusBlog.V2.Contracts;

public enum SearchFieldKind : byte
{
    Title = 1,
    Heading = 2,
    Summary = 3,
    Taxonomy = 4,
    Body = 5,
    Code = 6
}

/// <summary>
/// A contiguous slice of visible text extracted from published Markdown, paired with its exact
/// UTF-16 offsets in the original unnormalized source string.
/// </summary>
public readonly record struct MarkdownVisibleSpan(
    SearchFieldKind Field,
    int SourceStart,
    int SourceEnd,
    bool StartsNewBlock);

/// <summary>
/// Bounded, O(N), zero-backtracking extractor of visible searchable content from published Markdown.
/// Preserves visible prose, headings, inline/fenced code, and visible link/image labels while excluding
/// Markdown syntax markers, link destinations, reference definitions, HTML comments, HTML tag attributes,
/// and script/style bodies. Never splits UTF-16 surrogate pairs.
/// </summary>
public static class SearchMarkdownExtractor
{
    public const int MaxExtractedSourceChars = 256 * 1024;

    public static List<MarkdownVisibleSpan> Extract(string markdown, CancellationToken ct = default,
        int maxChars = MaxExtractedSourceChars)
    {
        var spans = new List<MarkdownVisibleSpan>();
        if (string.IsNullOrEmpty(markdown)) return spans;
        var limit = Math.Min(markdown.Length, maxChars);
        if (limit > 0 && limit < markdown.Length && char.IsHighSurrogate(markdown[limit - 1]))
            limit--;

        var inFence = false;
        var fenceChar = '\0';
        var fenceLen = 0;
        var inHtmlComment = false;
        string? hiddenTag = null; // "script" or "style"
        var blockBreak = true;

        var pos = 0;
        var lineCount = 0;
        while (pos < limit)
        {
            if ((lineCount++ & 63) == 0) ct.ThrowIfCancellationRequested();
            var lineStart = pos;
            var lineEnd = pos;
            while (lineEnd < limit && markdown[lineEnd] is not '\n' and not '\r') lineEnd++;
            var nextPos = lineEnd;
            if (nextPos < limit && markdown[nextPos] == '\r') nextPos++;
            if (nextPos < limit && markdown[nextPos] == '\n') nextPos++;

            var trimmedStart = lineStart;
            while (trimmedStart < lineEnd && markdown[trimmedStart] is ' ' or '\t') trimmedStart++;
            var trimmedEnd = lineEnd;
            while (trimmedEnd > trimmedStart && markdown[trimmedEnd - 1] is ' ' or '\t') trimmedEnd--;

            // 1. Inside fenced code block: emit verbatim code lines until closing fence
            if (inFence)
            {
                if (IsClosingFence(markdown, trimmedStart, trimmedEnd, fenceChar, fenceLen))
                {
                    inFence = false;
                    blockBreak = true;
                }
                else if (lineEnd > lineStart)
                {
                    spans.Add(new MarkdownVisibleSpan(SearchFieldKind.Code, lineStart, lineEnd, blockBreak));
                    blockBreak = false;
                }
                pos = nextPos;
                continue;
            }

            // 2. Inside multi-line HTML comment or <script>/<style> block
            if (inHtmlComment || hiddenTag is not null)
            {
                var cur = lineStart;
                if (inHtmlComment)
                {
                    var close = IndexOfOrdinal(markdown, cur, lineEnd, "-->");
                    if (close < 0) { pos = nextPos; continue; }
                    cur = close + 3;
                    inHtmlComment = false;
                }
                if (hiddenTag is not null)
                {
                    var closeEnd = FindClosingRawTag(markdown, cur, lineEnd, hiddenTag);
                    if (closeEnd < 0) { pos = nextPos; continue; }
                    cur = closeEnd;
                    hiddenTag = null;
                }
                if (cur < lineEnd)
                {
                    ExtractInline(markdown, cur, lineEnd, SearchFieldKind.Body, spans, ref blockBreak,
                        ref inHtmlComment, ref hiddenTag, ct);
                }
                pos = nextPos;
                continue;
            }

            // 3. Blank line -> block boundary
            if (trimmedStart == trimmedEnd)
            {
                blockBreak = true;
                pos = nextPos;
                continue;
            }

            // 4. Opening fenced code block (``` or ~~~)
            if (TryOpeningFence(markdown, trimmedStart, trimmedEnd, out var openChar, out var openLen))
            {
                inFence = true;
                fenceChar = openChar;
                fenceLen = openLen;
                blockBreak = true;
                pos = nextPos;
                continue;
            }

            // 5. Thematic break / horizontal rule (---, ***, ___) or GFM table separator row (| --- | :---: |)
            if (IsThematicBreak(markdown, trimmedStart, trimmedEnd) || IsTableSeparatorRow(markdown, trimmedStart, trimmedEnd))
            {
                blockBreak = true;
                pos = nextPos;
                continue;
            }

            // 6. Link reference definition: [label]: destination
            if (IsLinkReferenceDefinition(markdown, trimmedStart, trimmedEnd))
            {
                blockBreak = true;
                pos = nextPos;
                continue;
            }

            // 7. Strip blockquote prefixes (>)
            var contentStart = trimmedStart;
            var strippedQuote = false;
            while (contentStart < trimmedEnd && markdown[contentStart] == '>')
            {
                strippedQuote = true;
                contentStart++;
                while (contentStart < trimmedEnd && markdown[contentStart] is ' ' or '\t') contentStart++;
            }
            if (strippedQuote) blockBreak = true;
            if (contentStart >= trimmedEnd)
            {
                blockBreak = true;
                pos = nextPos;
                continue;
            }

            // 8. ATX heading (#..###### followed by space/tab or end of line)
            if (TryAtxHeading(markdown, contentStart, trimmedEnd, out var hStart, out var hEnd))
            {
                blockBreak = true;
                if (hEnd > hStart)
                {
                    ExtractInline(markdown, hStart, hEnd, SearchFieldKind.Heading, spans, ref blockBreak,
                        ref inHtmlComment, ref hiddenTag, ct);
                }
                blockBreak = true;
                pos = nextPos;
                continue;
            }

            // 9. List item marker (-, *, +, or 1.)
            if (TryStripListMarker(markdown, contentStart, trimmedEnd, out var listContentStart))
            {
                blockBreak = true;
                contentStart = listContentStart;
            }

            // 10. Check for Setext heading underline on the immediately following line
            var field = SearchFieldKind.Body;
            if (!strippedQuote && nextPos < limit && IsSetextUnderline(markdown, nextPos, limit, out var underlineNext))
            {
                field = SearchFieldKind.Heading;
                blockBreak = true;
                nextPos = underlineNext;
            }

            // 11. Table row: split cells on unescaped '|' so each cell has a clean boundary
            if (field == SearchFieldKind.Body && LooksLikeTableRow(markdown, contentStart, trimmedEnd))
            {
                ExtractTableRow(markdown, contentStart, trimmedEnd, spans, ref inHtmlComment, ref hiddenTag, ct);
                blockBreak = true;
                pos = nextPos;
                continue;
            }

            ExtractInline(markdown, contentStart, trimmedEnd, field, spans, ref blockBreak,
                ref inHtmlComment, ref hiddenTag, ct);
            if (field == SearchFieldKind.Heading) blockBreak = true;
            pos = nextPos;
        }

        return spans;
    }

    private static void ExtractTableRow(string md, int start, int end, List<MarkdownVisibleSpan> spans,
        ref bool inHtmlComment, ref string? hiddenTag, CancellationToken ct)
    {
        var cur = start;
        if (cur < end && md[cur] == '|') cur++;
        var cellStart = cur;
        var inCode = false;
        while (cur <= end)
        {
            var isPipe = cur == end || (!inCode && md[cur] == '|' && (cur == start || md[cur - 1] != '\\'));
            if (cur < end && md[cur] == '`') inCode = !inCode;
            if (isPipe)
            {
                var cStart = cellStart;
                var cEnd = cur;
                while (cStart < cEnd && md[cStart] is ' ' or '\t') cStart++;
                while (cEnd > cStart && md[cEnd - 1] is ' ' or '\t') cEnd--;
                if (cEnd > cStart)
                {
                    var cellBreak = true;
                    ExtractInline(md, cStart, cEnd, SearchFieldKind.Body, spans, ref cellBreak,
                        ref inHtmlComment, ref hiddenTag, ct);
                }
                cellStart = cur + 1;
            }
            cur++;
        }
    }

    private static void ExtractInline(string md, int start, int end, SearchFieldKind field,
        List<MarkdownVisibleSpan> spans, ref bool blockBreak, ref bool inHtmlComment, ref string? hiddenTag,
        CancellationToken ct)
    {
        var cur = start;
        var runStart = cur;
        var localBreak = blockBreak;

        void Flush(int runEnd)
        {
            if (runEnd > runStart)
            {
                spans.Add(new MarkdownVisibleSpan(field, runStart, runEnd, localBreak));
                localBreak = false;
            }
        }

        while (cur < end)
        {
            if ((cur & 1023) == 0) ct.ThrowIfCancellationRequested();
            var ch = md[cur];

            // Backslash escape of ASCII punctuation: \* -> emit literal * without the backslash
            if (ch == '\\' && cur + 1 < end && IsAsciiPunctuation(md[cur + 1]))
            {
                Flush(cur);
                cur++;
                runStart = cur;
                cur++;
                continue;
            }

            // Inline code span: `...` or ``...``
            if (ch == '`')
            {
                var tickEnd = cur;
                while (tickEnd < end && md[tickEnd] == '`') tickEnd++;
                var tickLen = tickEnd - cur;
                var close = FindMatchingBackticks(md, tickEnd, end, tickLen);
                if (close >= 0)
                {
                    Flush(cur);
                    var codeStart = tickEnd;
                    var codeEnd = close;
                    if (codeEnd - codeStart >= 2 && md[codeStart] == ' ' && md[codeEnd - 1] == ' ')
                    {
                        codeStart++;
                        codeEnd--;
                    }
                    if (codeEnd > codeStart)
                    {
                        var codeField = field == SearchFieldKind.Heading ? SearchFieldKind.Heading : SearchFieldKind.Code;
                        spans.Add(new MarkdownVisibleSpan(codeField, codeStart, codeEnd, localBreak));
                        localBreak = false;
                    }
                    cur = close + tickLen;
                    runStart = cur;
                    continue;
                }
            }

            // HTML comment <!-- ... -->, <script>...</script>, <style>...</style>, or inline HTML tag <...>
            if (ch == '<')
            {
                if (StartsWithOrdinal(md, cur, end, "<!--"))
                {
                    Flush(cur);
                    var close = IndexOfOrdinal(md, cur + 4, end, "-->");
                    if (close >= 0)
                    {
                        cur = close + 3;
                        runStart = cur;
                    }
                    else
                    {
                        inHtmlComment = true;
                        blockBreak = localBreak;
                        return;
                    }
                    continue;
                }
                if (TryParseHtmlTag(md, cur, end, out var tagEnd, out var tagName, out var isClosing, out var isSelfClosing))
                {
                    Flush(cur);
                    if (!isClosing && !isSelfClosing &&
                        (tagName.Equals("script", StringComparison.OrdinalIgnoreCase) ||
                         tagName.Equals("style", StringComparison.OrdinalIgnoreCase)))
                    {
                        var rawClose = FindClosingRawTag(md, tagEnd, end, tagName);
                        if (rawClose >= 0)
                        {
                            cur = rawClose;
                            runStart = cur;
                        }
                        else
                        {
                            hiddenTag = tagName.ToLowerInvariant();
                            blockBreak = localBreak;
                            return;
                        }
                        continue;
                    }
                    // Block-level HTML tags create a clean block gap so unrelated spans don't bridge phrases
                    if (IsBlockHtmlTag(tagName)) localBreak = true;
                    cur = tagEnd;
                    runStart = cur;
                    continue;
                }
            }

            // Image ![alt](url) or link [label](url) / [label][ref]
            if (ch == '[' || (ch == '!' && cur + 1 < end && md[cur + 1] == '['))
            {
                var isImage = ch == '!';
                var bracketStart = isImage ? cur + 1 : cur;
                if (TryParseLinkOrImage(md, bracketStart, end, out var labelStart, out var labelEnd, out var afterLink))
                {
                    Flush(cur);
                    if (labelEnd > labelStart)
                    {
                        ExtractInline(md, labelStart, labelEnd, field, spans, ref localBreak,
                            ref inHtmlComment, ref hiddenTag, ct);
                    }
                    cur = afterLink;
                    runStart = cur;
                    continue;
                }
            }

            // Emphasis / strikethrough delimiters: **, *, ~~, and boundary-only __ / _
            // Never strip intra-word '_' (e.g. batch_job-42, x86_64, v2_schema) or trailing/technical symbols!
            if (ch is '*' or '~')
            {
                var dEnd = cur;
                while (dEnd < end && md[dEnd] == ch) dEnd++;
                var dLen = dEnd - cur;
                if ((ch == '*' && dLen is >= 1 and <= 3) || (ch == '~' && dLen == 2))
                {
                    Flush(cur);
                    cur = dEnd;
                    runStart = cur;
                    continue;
                }
            }
            else if (ch == '_')
            {
                var dEnd = cur;
                while (dEnd < end && md[dEnd] == '_') dEnd++;
                var prevIsWord = cur > start && char.IsAsciiLetterOrDigit(md[cur - 1]);
                var nextIsWord = dEnd < end && char.IsAsciiLetterOrDigit(md[dEnd]);
                if (!(prevIsWord && nextIsWord) && dEnd - cur <= 3)
                {
                    Flush(cur);
                    cur = dEnd;
                    runStart = cur;
                    continue;
                }
            }

            cur++;
        }

        Flush(end);
        blockBreak = localBreak;
    }

    private static bool TryParseLinkOrImage(string md, int openBracket, int end,
        out int labelStart, out int labelEnd, out int afterLink)
    {
        labelStart = openBracket + 1;
        labelEnd = -1;
        afterLink = -1;
        var depth = 0;
        var i = openBracket;
        while (i < end)
        {
            if (md[i] == '\\' && i + 1 < end) { i += 2; continue; }
            if (md[i] == '[') depth++;
            else if (md[i] == ']')
            {
                depth--;
                if (depth == 0) { labelEnd = i; break; }
            }
            i++;
        }
        if (labelEnd < 0 || labelEnd + 1 >= end) return false;

        // Inline link: [label](destination "title")
        if (md[labelEnd + 1] == '(')
        {
            var pDepth = 1;
            var j = labelEnd + 2;
            while (j < end && pDepth > 0)
            {
                if (md[j] == '\\' && j + 1 < end) { j += 2; continue; }
                if (md[j] == '(') pDepth++;
                else if (md[j] == ')') pDepth--;
                j++;
            }
            if (pDepth == 0)
            {
                afterLink = j;
                return true;
            }
            return false;
        }

        // Reference link: [label][ref]
        if (md[labelEnd + 1] == '[')
        {
            var j = labelEnd + 2;
            while (j < end && md[j] != ']')
            {
                if (md[j] == '\\' && j + 1 < end) { j += 2; continue; }
                if (md[j] == '[') return false;
                j++;
            }
            if (j < end && md[j] == ']')
            {
                afterLink = j + 1;
                return true;
            }
        }
        return false;
    }

    private static bool TryParseHtmlTag(string md, int start, int end,
        out int tagEnd, out string tagName, out bool isClosing, out bool isSelfClosing)
    {
        tagEnd = -1;
        tagName = "";
        isClosing = false;
        isSelfClosing = false;
        var i = start + 1;
        if (i >= end) return false;
        if (md[i] == '/')
        {
            isClosing = true;
            i++;
        }
        if (i >= end || !char.IsAsciiLetter(md[i])) return false;
        var nameStart = i++;
        while (i < end && (char.IsAsciiLetterOrDigit(md[i]) || md[i] is '-' or ':')) i++;
        var nameEnd = i;
        if (i < end && md[i] is not ('>' or '/' or ' ' or '\t')) return false;

        var quote = '\0';
        while (i < end)
        {
            var c = md[i];
            if (quote != '\0')
            {
                if (c == quote) quote = '\0';
            }
            else if (c is '"' or '\'')
            {
                quote = c;
            }
            else if (c == '>')
            {
                isSelfClosing = i > nameEnd && md[i - 1] == '/';
                tagEnd = i + 1;
                tagName = md[nameStart..nameEnd];
                return true;
            }
            else if (c == '<')
            {
                return false;
            }
            i++;
        }
        return false;
    }

    private static int FindClosingRawTag(string md, int start, int end, string tagName)
    {
        var needle = "</" + tagName;
        var cur = start;
        while (cur < end)
        {
            var idx = md.AsSpan(cur, end - cur).IndexOf(needle, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return -1;
            var after = cur + idx + needle.Length;
            while (after < end && md[after] is ' ' or '\t') after++;
            if (after < end && md[after] == '>') return after + 1;
            cur = cur + idx + 2;
        }
        return -1;
    }

    private static int FindMatchingBackticks(string md, int start, int end, int count)
    {
        var i = start;
        while (i < end)
        {
            if (md[i] == '`')
            {
                var run = i;
                while (run < end && md[run] == '`') run++;
                if (run - i == count) return i;
                i = run;
                continue;
            }
            i++;
        }
        return -1;
    }

    private static bool TryOpeningFence(string md, int start, int end, out char fenceChar, out int fenceLen)
    {
        fenceChar = '\0';
        fenceLen = 0;
        if (start >= end || md[start] is not ('`' or '~')) return false;
        var ch = md[start];
        var i = start;
        while (i < end && md[i] == ch) i++;
        var len = i - start;
        if (len < 3) return false;
        if (ch == '`')
        {
            for (var j = i; j < end; j++)
                if (md[j] == '`') return false;
        }
        fenceChar = ch;
        fenceLen = len;
        return true;
    }

    private static bool IsClosingFence(string md, int start, int end, char fenceChar, int minLen)
    {
        if (start >= end || md[start] != fenceChar) return false;
        var i = start;
        while (i < end && md[i] == fenceChar) i++;
        return i - start >= minLen && i == end;
    }

    private static bool TryAtxHeading(string md, int start, int end, out int contentStart, out int contentEnd)
    {
        contentStart = start;
        contentEnd = end;
        if (start >= end || md[start] != '#') return false;
        var i = start;
        while (i < end && md[i] == '#' && i - start < 7) i++;
        var level = i - start;
        if (level is < 1 or > 6) return false;
        if (i < end && md[i] is not (' ' or '\t')) return false;
        while (i < end && md[i] is ' ' or '\t') i++;
        var tail = end;
        while (tail > i && md[tail - 1] == '#') tail--;
        if (tail == i || (tail < end && md[tail - 1] is ' ' or '\t'))
        {
            while (tail > i && md[tail - 1] is ' ' or '\t') tail--;
            contentEnd = tail;
        }
        contentStart = i;
        return true;
    }

    private static bool TryStripListMarker(string md, int start, int end, out int contentStart)
    {
        contentStart = start;
        if (start >= end) return false;
        if (md[start] is '-' or '*' or '+' && start + 1 < end && md[start + 1] is ' ' or '\t')
        {
            var i = start + 2;
            while (i < end && md[i] is ' ' or '\t') i++;
            contentStart = i;
            return true;
        }
        var j = start;
        while (j < end && char.IsAsciiDigit(md[j]) && j - start < 9) j++;
        if (j > start && j + 1 < end && md[j] is '.' or ')' && md[j + 1] is ' ' or '\t')
        {
            var i = j + 2;
            while (i < end && md[i] is ' ' or '\t') i++;
            contentStart = i;
            return true;
        }
        return false;
    }

    private static bool IsThematicBreak(string md, int start, int end)
    {
        if (end - start < 3 || md[start] is not ('-' or '*' or '_')) return false;
        var marker = md[start];
        var count = 0;
        for (var i = start; i < end; i++)
        {
            if (md[i] == marker) count++;
            else if (md[i] is not (' ' or '\t')) return false;
        }
        return count >= 3;
    }

    private static bool IsTableSeparatorRow(string md, int start, int end)
    {
        if (end - start < 3 || !md.AsSpan(start, end - start).Contains('-')) return false;
        var hasPipe = false;
        var hasDash = false;
        for (var i = start; i < end; i++)
        {
            var c = md[i];
            if (c == '|') hasPipe = true;
            else if (c == '-') hasDash = true;
            else if (c is not (':' or ' ' or '\t')) return false;
        }
        return hasPipe && hasDash;
    }

    private static bool LooksLikeTableRow(string md, int start, int end) =>
        md.AsSpan(start, end - start).Contains('|');

    private static bool IsLinkReferenceDefinition(string md, int start, int end)
    {
        if (start >= end || md[start] != '[') return false;
        var close = md.AsSpan(start + 1, end - start - 1).IndexOf(']');
        if (close <= 0) return false;
        var colon = start + 1 + close + 1;
        if (colon >= end || md[colon] != ':') return false;
        var rest = colon + 1;
        while (rest < end && md[rest] is ' ' or '\t') rest++;
        return rest < end;
    }

    private static bool IsSetextUnderline(string md, int lineStart, int limit, out int nextPos)
    {
        nextPos = lineStart;
        var lineEnd = lineStart;
        while (lineEnd < limit && md[lineEnd] is not '\n' and not '\r') lineEnd++;
        var after = lineEnd;
        if (after < limit && md[after] == '\r') after++;
        if (after < limit && md[after] == '\n') after++;
        var s = lineStart;
        while (s < lineEnd && md[s] is ' ' or '\t') s++;
        var e = lineEnd;
        while (e > s && md[e - 1] is ' ' or '\t') e--;
        if (e - s < 2 || md[s] is not ('=' or '-')) return false;
        var ch = md[s];
        for (var i = s + 1; i < e; i++)
            if (md[i] != ch) return false;
        nextPos = after;
        return true;
    }

    private static bool IsBlockHtmlTag(string tag) =>
        tag.Equals("div", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("p", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("section", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("article", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("li", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("tr", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("td", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("th", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("br", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("hr", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("blockquote", StringComparison.OrdinalIgnoreCase) ||
        tag.Equals("pre", StringComparison.OrdinalIgnoreCase) ||
        (tag.Length == 2 && (tag[0] is 'h' or 'H') && tag[1] is >= '1' and <= '6');

    private static bool IsAsciiPunctuation(char c) =>
        c is '!' or '"' or '#' or '$' or '%' or '&' or '\'' or '(' or ')' or '*' or '+' or ',' or '-' or '.' or '/' or
            ':' or ';' or '<' or '=' or '>' or '?' or '@' or '[' or '\\' or ']' or '^' or '_' or '`' or '{' or '|' or '}' or '~';

    private static bool StartsWithOrdinal(string s, int start, int end, string prefix) =>
        end - start >= prefix.Length && s.AsSpan(start, prefix.Length).SequenceEqual(prefix);

    private static int IndexOfOrdinal(string s, int start, int end, string needle)
    {
        var idx = s.AsSpan(start, end - start).IndexOf(needle, StringComparison.Ordinal);
        return idx < 0 ? -1 : start + idx;
    }
}
