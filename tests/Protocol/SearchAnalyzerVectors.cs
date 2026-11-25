using System.Text.Json;

internal static class SearchAnalyzerVectors
{
    private sealed record ExpectedToken(
        string Term, string Kind, int Position, int Width, int Advance,
        int SourceStart, int SourceEnd, bool IsStopword);

    private sealed record TextCase(
        string Name, string Mode, string Input, int ExpectedSourceLength,
        ExpectedToken[] MustContain, string[] MustNotContainTerms);

    private sealed record QueryCase(
        string Name, string Input, bool IsExactIdentifier, bool IsOverlongExactIdentifier,
        string[] ExpectedTerms);

    private sealed record VectorFile(int AnalyzerVersion, TextCase[] TextCases, QueryCase[] QueryCases);

    internal static void Run(string fixtures)
    {
        var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var doc = JsonSerializer.Deserialize<VectorFile>(
            File.ReadAllText(Path.Combine(fixtures, "search-analyzer-vectors.json")), opts)
            ?? throw new InvalidDataException("Invalid search-analyzer-vectors.json");

        Require(doc.AnalyzerVersion == SearchTextAnalyzer.Version, "Analyzer version mismatch with golden vectors");

        foreach (var tc in doc.TextCases)
        {
            var mode = tc.Mode == "index" ? SearchAnalysisMode.Index : SearchAnalysisMode.Query;
            var result = SearchTextAnalyzer.AnalyzePlainField(tc.Input, SearchFieldKind.Body, mode, 0, CancellationToken.None);
            Require(result.SourceLength == tc.ExpectedSourceLength,
                $"[{tc.Name}] sourceLength={result.SourceLength}, expected {tc.ExpectedSourceLength}");

            // Every emitted token offset must be valid and never split UTF-16 surrogate pairs
            foreach (var tok in result.Tokens)
            {
                Require(tok.SourceStart >= 0 && tok.SourceEnd >= tok.SourceStart && tok.SourceEnd <= tc.Input.Length,
                    $"[{tc.Name}] invalid offset [{tok.SourceStart}, {tok.SourceEnd}) for '{tok.Term}'");
                if (tok.SourceStart < tc.Input.Length)
                    Require(!char.IsLowSurrogate(tc.Input[tok.SourceStart]), $"[{tc.Name}] sourceStart splits surrogate pair");
                if (tok.SourceEnd > 0 && tok.SourceEnd < tc.Input.Length)
                    Require(!char.IsLowSurrogate(tc.Input[tok.SourceEnd]), $"[{tc.Name}] sourceEnd splits surrogate pair");
            }

            foreach (var exp in tc.MustContain)
            {
                var found = result.Tokens.Any(t =>
                    t.Term == exp.Term &&
                    KindName(t.Kind) == exp.Kind &&
                    t.Position == exp.Position &&
                    t.Width == exp.Width &&
                    t.Advance == exp.Advance &&
                    t.SourceStart == exp.SourceStart &&
                    t.SourceEnd == exp.SourceEnd &&
                    t.IsStopword == exp.IsStopword);
                Require(found, $"[{tc.Name}] missing expected token {exp}");
            }

            foreach (var forbidden in tc.MustNotContainTerms)
            {
                Require(result.Tokens.All(t => t.Term != forbidden),
                    $"[{tc.Name}] emitted forbidden term '{forbidden}'");
            }
        }

        foreach (var qc in doc.QueryCases)
        {
            var analyzed = SearchTextAnalyzer.AnalyzeQuery(qc.Input, CancellationToken.None);
            Require(analyzed.IsExactIdentifier == qc.IsExactIdentifier, $"[{qc.Name}] IsExactIdentifier mismatch");
            Require(analyzed.IsOverlongExactIdentifier == qc.IsOverlongExactIdentifier, $"[{qc.Name}] IsOverlongExactIdentifier mismatch");
            var terms = analyzed.Tokens.Select(t => t.Term).ToArray();
            Require(terms.SequenceEqual(qc.ExpectedTerms),
                $"[{qc.Name}] terms=[{string.Join(',', terms)}], expected=[{string.Join(',', qc.ExpectedTerms)}]");
        }

        // Malformed UTF-16 isolated surrogate & NUL must never throw or produce out-of-range offsets
        var malformed = "alpha\uD800beta\0gamma";
        var malResult = SearchTextAnalyzer.AnalyzePlainField(malformed, SearchFieldKind.Body, SearchAnalysisMode.Index, 0, CancellationToken.None);
        Require(malResult.Tokens.Any(t => t.Term == "alpha") && malResult.Tokens.Any(t => t.Term == "beta") && malResult.Tokens.Any(t => t.Term == "gamma"),
            "Malformed input lost valid ASCII neighbors");

        // Long CJK run (> 4096 chars) stays bounded and observes cancellation
        var longCjk = "博客" + new string('雪', 4100) + "搜索";
        var longResult = SearchTextAnalyzer.AnalyzePlainField(longCjk, SearchFieldKind.Body, SearchAnalysisMode.Index, 0, CancellationToken.None);
        Require(longResult.SourceLength == longCjk.Length, "Long CJK run source length mismatch");
        Require(longResult.Tokens.Any(t => t.Term == "博客" && t.Position == 0) &&
                longResult.Tokens.Any(t => t.Term == "搜索" && t.Position == 4102),
            "Long CJK run missed boundary dictionary words");

        // Published Markdown extraction: preserve visible headings, code, link labels; exclude hidden URLs/HTML/scripts
        const string markdown = """
            # VisibleHeadingOne

            Read [VisibleLinkLabel](https://hidden.invalid/url-only-999) and `InlineCodeSym`.

            <!-- hidden-comment-888 -->
            <div data-secret="hidden-attr-777">VisibleInnerHtml</div>
            <script>var hidden_script_666 = 1;</script>
            <style>.hidden-style-555 { display: none; }</style>

            ```csharp
            var ok = FencedCodeSym();
            ```

            [ref-id]: https://hidden.invalid/ref-url-444
            """;
        var (headings, body, code) = SearchTextAnalyzer.AnalyzeMarkdownBody(markdown, CancellationToken.None);
        Require(headings.Tokens.Any(t => t.Term == "visibleheadingone"), "Markdown heading lost");
        Require(body.Tokens.Any(t => t.Term == "visiblelinklabel"), "Visible link label lost");
        Require(body.Tokens.Any(t => t.Term == "visibleinnerhtml"), "Visible inner HTML text lost");
        Require(code.Tokens.Any(t => t.Term == "inlinecodesym"), "Inline code lost");
        Require(code.Tokens.Any(t => t.Term == "fencedcodesym"), "Fenced code lost");
        var allTerms = headings.Tokens.Concat(body.Tokens).Concat(code.Tokens).Select(t => t.Term).ToHashSet(StringComparer.Ordinal);
        foreach (var hidden in new[] { "url-only-999", "hidden-comment-888", "hidden-attr-777", "hidden_script_666", "hidden-style-555", "ref-url-444" })
            Require(!allTerms.Contains(hidden), $"Hidden Markdown/HTML token '{hidden}' leaked into index");

        // Non-bridging position gaps between distinct Markdown blocks
        const string twoBlocks = "Alpha\n\nBeta";
        var (_, twoBody, _) = SearchTextAnalyzer.AnalyzeMarkdownBody(twoBlocks, CancellationToken.None);
        var alphaPos = twoBody.Tokens.First(t => t.Term == "alpha").Position;
        var betaPos = twoBody.Tokens.First(t => t.Term == "beta").Position;
        Require(betaPos - alphaPos > 1, "Separate Markdown paragraphs must not have adjacent phrase positions");

        // Collision-safe term identity: distinct terms with equal 64-bit hash key slot still compare by exact string
        var leftKey = new SearchTermKey(0x123456789ABCDEF0UL, "term-alpha");
        var rightKey = new SearchTermKey(0x123456789ABCDEF0UL, "term-beta");
        Require(leftKey != rightKey && leftKey.CompareTo(rightKey) != 0, "SearchTermKey failed collision safety");
    }

    private static string KindName(SearchTokenKind kind) => kind switch
    {
        SearchTokenKind.Exact => "exact",
        SearchTokenKind.CjkBigram => "cjkBigram",
        SearchTokenKind.CjkChar => "cjkChar",
        SearchTokenKind.Prefix => "prefix",
        SearchTokenKind.Subword => "subword",
        SearchTokenKind.ScriptAlias => "scriptAlias",
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };
}
