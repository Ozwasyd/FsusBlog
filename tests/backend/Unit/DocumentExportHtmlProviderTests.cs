using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Text;

using AngleSharp.Html.Parser;

using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Tests.Helpers;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportHtmlProviderTests
{
    // Captured from the actual FsusUI runtime probe; this fixture does not qualify
    // the sandbox renderer tool, font coverage, or browser offline acceptance.
    private const string CanonicalMermaidFragment = """
        <figure class="markdown-renderer__mermaid" data-mermaid-rendered="true" data-mermaid-width="396" data-mermaid-height="104"><svg class="mermaid" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 396 104" width="396" height="104" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mermaid diagram"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#71717a" /></marker></defs><line x1="172" y1="52" x2="224" y2="52" stroke="#71717a" stroke-width="2" marker-end="url(#arrow)" /><rect x="24" y="24" width="148" height="56" rx="16" fill="#ffffff" stroke="#d4d4d8" stroke-width="1.5" /><text x="98" y="52" text-anchor="middle" dominant-baseline="middle" fill="#18181b" font-size="14" font-family="Google Sans, Noto Sans SC, system-ui, sans-serif">A</text><rect x="224" y="24" width="148" height="56" rx="16" fill="#ffffff" stroke="#d4d4d8" stroke-width="1.5" /><text x="298" y="52" text-anchor="middle" dominant-baseline="middle" fill="#18181b" font-size="14" font-family="Google Sans, Noto Sans SC, system-ui, sans-serif">B</text></svg></figure>
        """;
    private const string SvgOpen = "<svg xmlns=\"http://www.w3.org/2000/svg\">";

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void PreservesSvgAccessibleTitlesAlongsideOwnedPageTitle(int diagramCount)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        string fragment = string.Concat(Enumerable.Range(0, diagramCount).Select(index =>
            $"<svg xmlns=\"http://www.w3.org/2000/svg\" role=\"img\" aria-label=\"Diagram {index}\"><title>Diagram {index}</title><desc>Details {index}</desc><path d=\"M 0 0 L 1 1\" /></svg>"));
        byte[] sanitized = DocumentExportHtmlSanitizer.Sanitize(fragment, [], 1_048_576);
        byte[] document = SelfContainedHtmlDocumentExportProvider.ComposeDocument("Page title", input, sanitized, 16_777_216);

        DocumentExportHtmlVerifier.Validate(document, input, 16_777_216);
        using var parsed = new HtmlParser().ParseDocument(Encoding.UTF8.GetString(document));
        Assert.Equal("Page title", parsed.Title);
        Assert.Single(parsed.Head!.QuerySelectorAll("title"));
        Assert.Equal(diagramCount, parsed.QuerySelectorAll("svg title").Length);
        for (int index = 0; index < diagramCount; index++)
        {
            var svg = parsed.QuerySelectorAll("svg")[index];
            Assert.Equal($"Diagram {index}", svg.GetAttribute("aria-label"));
            Assert.Equal($"Diagram {index}", svg.QuerySelector("title")!.TextContent);
            Assert.Equal("http://www.w3.org/2000/svg", svg.QuerySelector("title")!.NamespaceUri);
            Assert.Equal($"Details {index}", svg.QuerySelector("desc")!.TextContent);
        }
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("duplicate")]
    [InlineData("body-only")]
    [InlineData("body-extra")]
    [InlineData("nested-head")]
    [InlineData("foreign-title")]
    [InlineData("foreign-head")]
    [InlineData("svg-substitute")]
    public void RefusesPageTitleOutsideItsUniqueHtmlHeadOwnership(string mutation)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        byte[] document = SelfContainedHtmlDocumentExportProvider.ComposeDocument("Page title", input, "<p>Text</p>"u8, 16_777_216);
        string original = Encoding.UTF8.GetString(document);
        const string PageTitle = "<title>Page title</title>";
        string changed = mutation switch
        {
            "missing" => original.Replace(PageTitle, string.Empty, StringComparison.Ordinal),
            "duplicate" => original.Replace(PageTitle, PageTitle + PageTitle, StringComparison.Ordinal),
            "body-only" => original.Replace(PageTitle, string.Empty, StringComparison.Ordinal)
                .Replace("<body>", "<body>" + PageTitle, StringComparison.Ordinal),
            "body-extra" => original.Replace("<body>", "<body>" + PageTitle, StringComparison.Ordinal),
            "nested-head" => original.Replace(PageTitle, "<div>" + PageTitle + "</div>", StringComparison.Ordinal),
            "foreign-title" => original.Replace(PageTitle, "<title xmlns=\"urn:other\">Page title</title>", StringComparison.Ordinal),
            "foreign-head" => original.Replace("<head>", "<head xmlns=\"urn:other\">", StringComparison.Ordinal),
            "svg-substitute" => original.Replace(PageTitle, string.Empty, StringComparison.Ordinal)
                .Replace("<article>", "<article>" + SvgOpen + "<title>Page title</title><path d=\"M 0 0 L 1 1\" /></svg>", StringComparison.Ordinal),
            _ => throw new InvalidOperationException("Unknown title mutation.")
        };

        Assert.NotEqual(original, changed);
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlVerifier.Validate(
            Encoding.UTF8.GetBytes(changed), input, 16_777_216));
    }

    [Theory]
    [InlineData("em")]
    [InlineData("strong")]
    [InlineData("span")]
    [InlineData("a")]
    public void EmptyNonVoidElementsPreserveHtml5SiblingSemantics(string element)
    {
        string attributes = element == "a" ? " href=\"https://example.invalid\"" : string.Empty;
        string fragment = $"<p><{element}{attributes} />plain text</p><h2 id=\"heading\">Heading</h2><p>After</p>";
        var parser = new HtmlParser();
        using var unsanitized = parser.ParseDocument(fragment);
        Assert.Contains("plain text", unsanitized.QuerySelector(element)!.TextContent, StringComparison.Ordinal);

        byte[] sanitized = DocumentExportHtmlSanitizer.Sanitize(fragment, [], 1_048_576);
        string html = Encoding.UTF8.GetString(sanitized);
        using var document = parser.ParseDocument(html);

        Assert.Contains($"</{element}>", html, StringComparison.Ordinal);
        Assert.Empty(document.QuerySelector(element)!.TextContent);
        Assert.Equal("plain text", document.QuerySelector("p")!.TextContent);
        Assert.Null(document.GetElementById("heading")!.Closest(element));
        Assert.Equal("After", document.QuerySelectorAll("p")[1].TextContent);
    }

    [Fact]
    public void IndependentVerifierRefusesXmlValidNonVoidSelfClosingMutation()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        byte[] fragment = DocumentExportHtmlSanitizer.Sanitize("<p><em />plain text</p>", [], 1_048_576);
        byte[] document = SelfContainedHtmlDocumentExportProvider.ComposeDocument("Title", input, fragment, 16_777_216);
        DocumentExportHtmlVerifier.Validate(document, input, 16_777_216);
        string mutation = Encoding.UTF8.GetString(document).Replace("<em></em>", "<em />", StringComparison.Ordinal);
        Assert.NotEqual(Encoding.UTF8.GetString(document), mutation);

        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlVerifier.Validate(
            Encoding.UTF8.GetBytes(mutation), input, 16_777_216));
    }

    [Fact]
    public void ExplicitNonVoidClosingPreservesExistingVoidAndSvgElements()
    {
        string fragment = "<p>Line<br />Next</p><hr />" + SvgOpen + "<path d=\"M 0 0 L 1 1\" /></svg>";
        byte[] sanitized = DocumentExportHtmlSanitizer.Sanitize(fragment, [], 1_048_576);
        using var parsed = new HtmlParser().ParseDocument(Encoding.UTF8.GetString(sanitized));

        Assert.Single(parsed.QuerySelectorAll("br"));
        Assert.Single(parsed.QuerySelectorAll("hr"));
        Assert.Equal("LineNext", parsed.QuerySelector("p")!.TextContent);
        Assert.Equal("http://www.w3.org/2000/svg", parsed.QuerySelector("path")!.NamespaceUri);
    }

    [Theory]
    [InlineData("fa-IR", "rtl")]
    [InlineData("ur-PK", "rtl")]
    [InlineData("ar-EG", "rtl")]
    [InlineData("he-IL", "rtl")]
    [InlineData("en-US", "ltr")]
    [InlineData("zh-Hant", "ltr")]
    public void ComposesAndIndependentlyVerifiesActualLocaleDirection(string locale, string direction)
    {
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput() with
        {
            Locale = locale
        });
        byte[] document = SelfContainedHtmlDocumentExportProvider.ComposeDocument("Title", input,
            "<p>Text</p>"u8, 16_777_216);
        using var parsed = new HtmlParser().ParseDocument(Encoding.UTF8.GetString(document));

        Assert.Equal(direction, parsed.DocumentElement!.GetAttribute("dir"));
        Assert.Equal(locale, parsed.DocumentElement.GetAttribute("lang"));
        DocumentExportHtmlVerifier.Validate(document, input, 16_777_216);
        string opposite = direction == "rtl" ? "ltr" : "rtl";
        string mutation = Encoding.UTF8.GetString(document).Replace($"dir=\"{direction}\"",
            $"dir=\"{opposite}\"", StringComparison.Ordinal);
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlVerifier.Validate(
            Encoding.UTF8.GetBytes(mutation), input, 16_777_216));
    }

    [Theory]
    [InlineData("中文")]
    [InlineData("fn-中文")]
    [InlineData("fnref-中文")]
    [InlineData("ملاحظة")]
    [InlineData("हिन्दी")]
    [InlineData("e\u0301")]
    [InlineData("𐐀-Ⅳ")]
    public void PreservesBoundedUnicodeHtmlIdsAndExactLocalReferences(string id)
    {
        string fragment = $"<h1 id=\"{id}\">Heading</h1><a href=\"#{id}\">Top</a><p aria-describedby=\"{id}\">Text</p>";
        byte[] sanitized = DocumentExportHtmlSanitizer.Sanitize(fragment, [], 1_048_576);
        using var parsed = new HtmlParser().ParseDocument(Encoding.UTF8.GetString(sanitized));

        Assert.NotNull(parsed.GetElementById(id));
        Assert.Equal("#" + id, parsed.QuerySelector("a")!.GetAttribute("href"));
        Assert.Equal(id, parsed.QuerySelector("p")!.GetAttribute("aria-describedby"));
    }

    [Fact]
    public void PreservesObservedCanonicalUnicodeFootnoteAndBackreferences()
    {
        // Captured with the existing upstream ordinary Wasm parser. This is not
        // browser or sandbox renderer qualification.
        const string Fragment = "<p class=\"markdown-renderer__text\">note<sup><a href=\"#fn-中文\" id=\"fnref-中文\" class=\"footnote-ref\">1</a></sup></p><section class=\"footnotes\"><hr /><ol><li id=\"fn-中文\">原文 <a href=\"#fnref-中文\" class=\"footnote-backref\">↩</a></li></ol></section>";
        byte[] sanitized = DocumentExportHtmlSanitizer.Sanitize(Fragment, [], 1_048_576);
        using var parsed = new HtmlParser().ParseDocument(Encoding.UTF8.GetString(sanitized));

        Assert.Equal("#fn-中文", parsed.GetElementById("fnref-中文")!.GetAttribute("href"));
        Assert.Equal("#fnref-中文", parsed.QuerySelector(".footnote-backref")!.GetAttribute("href"));
        Assert.Contains("原文", parsed.GetElementById("fn-中文")!.TextContent, StringComparison.Ordinal);
    }

    [Fact]
    public void UnicodeHtmlIdsRetainTheOriginalUtf16LengthCeiling()
    {
        string id = new('中', 161);
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(
            $"<p id=\"{id}\">Text</p>", [], 1_048_576));
    }

    [Theory]
    [InlineData("white space")]
    [InlineData("bidi\u202eoverride")]
    [InlineData("join\u200der")]
    [InlineData("html&lt;tag")]
    public void UnicodeHtmlIdsStillRefuseWhitespaceFormatAndMarkupCharacters(string id)
    {
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(
            $"<p id=\"{id}\">Text</p>", [], 1_048_576));
    }

    [Theory]
    [InlineData("<p id=\"中文\">One</p><p id=\"中文\">Two</p>")]
    [InlineData("<a href=\"#中文\">Missing</a>")]
    [InlineData(SvgOpen + "<path id=\"中文\" /></svg>")]
    public void UnicodeHtmlIdsDoNotRelaxUniquenessResolutionOrSvgGrammar(string fragment)
    {
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(fragment, [], 1_048_576));
    }

    [Theory]
    [InlineData("<table><tr><th style=\"text-align:left\">Aligned</th></tr></table>")]
    [InlineData("<span class=\"katex-mathml\"><math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mi>x</mi></math></span>")]
    [InlineData("<p><a href=\"#fn-中文\" id=\"fnref-中文\">1</a><a href=\"#fn-中文\" id=\"fnref-中文\">1</a></p><p id=\"fn-中文\">Note</p>")]
    public void UnsupportedRendererShapesRefuseInsteadOfDroppingOrRewritingContent(string fragment)
    {
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(fragment, [], 1_048_576));
    }

    [Fact]
    public void PreservesObservedCanonicalMermaidMarkerDocumentDeterministically()
    {
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;
        byte[] first = DocumentExportHtmlSanitizer.Sanitize(CanonicalMermaidFragment, [], maximumBytes);
        byte[] second = DocumentExportHtmlSanitizer.Sanitize(CanonicalMermaidFragment, [], maximumBytes);

        Assert.Equal(first, second);
        string output = Encoding.UTF8.GetString(first);
        Assert.Contains("data-mermaid-rendered=\"true\"", output, StringComparison.Ordinal);
        Assert.Contains("preserveAspectRatio=\"xMidYMid meet\"", output, StringComparison.Ordinal);
        Assert.Contains("<defs><marker ", output, StringComparison.Ordinal);
        Assert.Contains("id=\"arrow\"", output, StringComparison.Ordinal);
        Assert.Contains("marker-end=\"url(#arrow)\"", output, StringComparison.Ordinal);
        Assert.Contains("font-family=\"Google Sans, Noto Sans SC, system-ui, sans-serif\"", output, StringComparison.Ordinal);
        Assert.Contains(">A</text>", output, StringComparison.Ordinal);
        Assert.Contains(">B</text>", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("url(#arrow)", "url(https://example.invalid/marker.svg#arrow)")]
    [InlineData("url(#arrow)", "url(data:image/svg+xml,arrow)")]
    [InlineData("url(#arrow)", "url(javascript:alert(1))")]
    [InlineData("url(#arrow)", "url(#missing)")]
    [InlineData("<defs>", "<defs onclick=\"alert(1)\">")]
    [InlineData("<defs>", "<defs><script>alert(1)</script>")]
    [InlineData("<defs>", "<defs><foreignObject />")]
    [InlineData("<defs>", "<defs><use href=\"https://example.invalid/remote.svg#icon\" />")]
    [InlineData("<svg class=\"mermaid\"", "<svg class=\"mermaid\" style=\"background:url(https://example.invalid)\"")]
    [InlineData("markerWidth=\"7\"", "markerWidth=\"-1\"")]
    [InlineData("markerWidth=\"7\"", "markerWidth=\"NaN\"")]
    [InlineData("markerWidth=\"7\"", "markerWidth=\"100001\"")]
    [InlineData("font-size=\"14\"", "font-size=\"100000\"")]
    [InlineData("Google Sans, Noto Sans SC, system-ui, sans-serif", "url(https://example.invalid/font)")]
    [InlineData("xMidYMid meet", "url(https://example.invalid/layout)")]
    [InlineData("auto-start-reverse", "url(https://example.invalid/orient)")]
    [InlineData("data-mermaid-rendered=\"true\"", "data-mermaid-rendered=\"false\"")]
    [InlineData("data-mermaid-width=\"396\"", "data-mermaid-width=\"0\"")]
    public void RejectsCanonicalMermaidActiveRemoteDanglingAndUnboundedMutations(string original, string mutation)
    {
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;
        string fragment = CanonicalMermaidFragment.Replace(original, mutation, StringComparison.Ordinal);

        Assert.NotEqual(CanonicalMermaidFragment, fragment);
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(fragment, [], maximumBytes));
    }

    [Theory]
    [InlineData(SvgOpen + "<line marker-end=\"url(#arrow)\" /></svg><p id=\"arrow\">outside</p>")]
    [InlineData("<p id=\"arrow\">outside</p>" + SvgOpen + "<line marker-end=\"url(#arrow)\" /></svg>")]
    [InlineData(SvgOpen + "<line marker-end=\"url(#arrow)\" /></svg>" + SvgOpen + "<defs><marker id=\"arrow\" /></defs></svg>")]
    [InlineData(SvgOpen + "<defs><marker id=\"arrow\" /></defs></svg>" + SvgOpen + "<line marker-end=\"url(#arrow)\" /></svg>")]
    [InlineData(SvgOpen + "<path id=\"arrow\" /><line marker-end=\"url(#arrow)\" /></svg>")]
    [InlineData(SvgOpen + "<defs><marker id=\"arrow\" /></defs><path marker-end=\"url(#arrow)\" /></svg>")]
    [InlineData(SvgOpen + "<path fill=\"url(#outside)\" /></svg>" + SvgOpen + "<path id=\"outside\" /></svg>")]
    [InlineData(SvgOpen + "<text aria-describedby=\"outside\">A</text></svg><p id=\"outside\">outside</p>")]
    [InlineData(SvgOpen + "<marker id=\"arrow\" /><line marker-end=\"url(#arrow)\" /></svg>")]
    [InlineData(SvgOpen + "<g><defs><marker id=\"arrow\" /></defs></g></svg>")]
    [InlineData(SvgOpen + SvgOpen + "</svg></svg>")]
    [InlineData(SvgOpen + "<p xmlns=\"http://www.w3.org/1999/xhtml\">outside namespace</p></svg>")]
    public void RejectsSvgReferencesOutsideTheirDocumentOrMarkerOwner(string fragment)
    {
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;

        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(fragment, [], maximumBytes));
    }

    [Fact]
    public void AllowsOwnSvgForwardReferencesWithoutLeakingIntoAnotherDocument()
    {
        string fragment = SvgOpen + "<line marker-end=\"url(#first)\" /><defs><marker id=\"first\" /></defs></svg>"
            + SvgOpen + "<defs><marker id=\"second\" /></defs><line marker-end=\"url(#second)\" /></svg>";
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;

        string output = Encoding.UTF8.GetString(DocumentExportHtmlSanitizer.Sanitize(fragment, [], maximumBytes));

        Assert.Contains("marker-end=\"url(#first)\"", output, StringComparison.Ordinal);
        Assert.Contains("marker-end=\"url(#second)\"", output, StringComparison.Ordinal);
    }

    [Fact]
    public void RequiresSandboxRuntime()
    {
        Assert.Throws<ArgumentNullException>(() => new DocumentExportProviderRegistry(null!));
    }

    [Fact]
    public async Task ProducesStableOfflineFullSyntaxDocumentAndQualifiedReceipt()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput(
            new string('x', 100_001) + "\n\n# 中文\n\nRTL שלום 🌍");
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(input).ContentDigest);
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);

        DocumentExportProviderResult first = await provider.ExportAsync(task, input);
        DocumentExportProviderResult second = await provider.ExportAsync(task, input);

        Assert.Equal(first.Bytes, second.Bytes);
        Assert.Equal(first.Receipt.OutputDigest, second.Receipt.OutputDigest);
        string html = Encoding.UTF8.GetString(first.Bytes);
        Assert.StartsWith("<!doctype html>\n", html, StringComparison.Ordinal);
        Assert.Contains("Content-Security-Policy", html, StringComparison.Ordinal);
        Assert.Contains("default-src 'none'", html, StringComparison.Ordinal);
        Assert.Contains("data:image/png;base64,", html, StringComparison.Ordinal);
        Assert.Contains("noopener noreferrer external", html, StringComparison.Ordinal);
        Assert.Contains("<svg", html, StringComparison.Ordinal);
        Assert.Contains("katex", html, StringComparison.Ordinal);
        Assert.Contains("中文 🌍", html, StringComparison.Ordinal);
        Assert.Contains($"content=\"{input.ReadingStyleAuthorityDigest}\"", html, StringComparison.Ordinal);
        Assert.Equal(7, html.Split("@font-face", StringSplitOptions.None).Length - 1);
        Assert.Contains("font-family:'Google Sans';font-style:normal;font-weight:400", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Google Sans';font-style:normal;font-weight:500", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Google Sans';font-style:normal;font-weight:700", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Noto Sans SC';font-style:normal;font-weight:400", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Noto Sans SC';font-style:normal;font-weight:500", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'Noto Sans SC';font-style:normal;font-weight:700", html, StringComparison.Ordinal);
        Assert.Contains("font-family:'JetBrains Mono';font-style:normal;font-weight:400", html, StringComparison.Ordinal);
        Assert.Equal(7, html.Split("src:url(data:font/woff2;base64,", StringSplitOptions.None).Length - 1);
        Assert.Contains("max-width:72ch", html, StringComparison.Ordinal);
        Assert.Contains("font-size:16px;font-weight:400;line-height:1.8", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("src=\"http", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("url(http", html, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(DocumentExportContractCatalog.FeatureIds.Count, first.Receipt.ObservedFeatures.Count);
        Assert.Single(first.Receipt.Warnings);
        Assert.Empty(first.Receipt.Errors);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            first,
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest);
    }

    [Theory]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("<img src=\"https://example.com/a.png\" data-asset-id=\"asset-1\" alt=\"pixel\" />")]
    [InlineData("<a href=\"javascript:alert(1)\">bad</a>")]
    [InlineData("<svg><use href=\"https://example.com/remote.svg#icon\" /></svg>")]
    [InlineData("<iframe srcdoc=\"bad\"></iframe>")]
    [InlineData("<p style=\"background:url(https://example.com/a)\">bad</p>")]
    [InlineData("<img data-asset-id=\"3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f\" src=\"data:image/png;base64,iVBORw0KGgo=\" srcset=\"https://example.com/a.png 2x\" alt=\"hero\" />")]
    [InlineData("<p onclick=\"alert(1)\">bad</p>")]
    [InlineData("<p id=\"duplicate\">a</p><p id=\"duplicate\">b</p>")]
    [InlineData("<a href=\"#missing\">missing target</a>")]
    public async Task RejectsActiveOrRemoteCanonicalRendererOutput(string fragment)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            fragment,
            ValidResponse(input, fragment).ContentDigest);
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);

        await Assert.ThrowsAsync<InvalidDataException>(
            () => provider.ExportAsync(task, input));
    }

    [Theory]
    [InlineData("</article><p>TAIL-CANARY</p>")]
    [InlineData("</article>TAIL-CANARY")]
    [InlineData("</article><!--TAIL-CANARY-->")]
    public void RejectsPrematureWrapperCloseWithoutDroppingTrailingRendererContent(string suffix)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;
        byte[] benign = DocumentExportHtmlSanitizer.Sanitize(
            DocumentExportTestToolFixture.DefaultFragment, input.Assets, maximumBytes);
        Assert.NotEmpty(benign);
        Assert.Contains("Heading 中文 🌍", Encoding.UTF8.GetString(benign), StringComparison.Ordinal);

        DocumentExportRendererResponse response = ValidResponse(
            input, DocumentExportTestToolFixture.DefaultFragment + suffix);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        Assert.Throws<InvalidDataException>(() => DocumentExportHtmlSanitizer.Sanitize(
            response.HtmlFragment, input.Assets, maximumBytes));
    }

    [Theory]
    [InlineData("")]
    [InlineData(" \n\t")]
    public void PreservesCompleteRendererFragmentAndLegalSurroundingWhitespace(string whitespace)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        long maximumBytes = DocumentExportContractCatalog.RequireProvider("self-contained-html").Budgets.MaxOutputBytes;
        byte[] baseline = DocumentExportHtmlSanitizer.Sanitize(
            DocumentExportTestToolFixture.DefaultFragment, input.Assets, maximumBytes);
        DocumentExportRendererResponse response = ValidResponse(
            input, whitespace + DocumentExportTestToolFixture.DefaultFragment + whitespace);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);

        byte[] actual = DocumentExportHtmlSanitizer.Sanitize(response.HtmlFragment, input.Assets, maximumBytes);

        Assert.Equal(whitespace + Encoding.UTF8.GetString(baseline) + whitespace, Encoding.UTF8.GetString(actual));
    }

    [Fact]
    public async Task ProviderRejectsFullySealedPrematureWrapperCloseAfterCompleteValidPrefix()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        string fragment = DocumentExportTestToolFixture.DefaultFragment + "</article><p>TAIL-CANARY</p>";
        DocumentExportRendererResponse response = ValidResponse(input, fragment);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        using var fixture = new DocumentExportTestToolFixture(fragment, response.ContentDigest);

        await Assert.ThrowsAsync<InvalidDataException>(() => CreateProvider(fixture).ExportAsync(task, input));
    }

    [Fact]
    public async Task ProviderPreservesAllowedTailAfterCompleteValidPrefix()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        string fragment = DocumentExportTestToolFixture.DefaultFragment + "<p>TAIL-CANARY</p>";
        DocumentExportRendererResponse response = ValidResponse(input, fragment);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        using var fixture = new DocumentExportTestToolFixture(fragment, response.ContentDigest);

        DocumentExportProviderResult result = await CreateProvider(fixture).ExportAsync(task, input);

        Assert.Contains("<p>TAIL-CANARY</p>", Encoding.UTF8.GetString(result.Bytes), StringComparison.Ordinal);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result, task, input, fixture.Tool, fixture.HostBuildDigest);
    }

    [Theory]
    [InlineData("light-v1", "ltr", "#FFFFFF", "#0F0F11", "#71717A", "#2A599C")]
    [InlineData("dark-v1", "rtl", "#09090B", "#F0F0F4", "#A1A1AA", "#4B79CC")]
    public async Task ProjectsExactThemeDirectionAndReadingAuthority(
        string themeProfile,
        string direction,
        string background,
        string foreground,
        string muted,
        string link)
    {
        DocumentExportFrozenInput baseline = DocumentExportContractTests.ValidInput();
        string locale = direction == "rtl" ? "he-IL" : "zh-Hant";
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(baseline with
        {
            ThemeProfile = themeProfile,
            Locale = locale,
            ContentDigest = string.Empty
        });
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(input).ContentDigest);

        DocumentExportProviderResult result = await CreateProvider(fixture).ExportAsync(task, input);
        string html = Encoding.UTF8.GetString(result.Bytes);

        Assert.Contains($"<html lang=\"{locale}\" dir=\"{direction}\">", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-bg:{background}", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-fg:{foreground}", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-muted:{muted}", html, StringComparison.Ordinal);
        Assert.Contains($"--reading-link:{link}", html, StringComparison.Ordinal);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result,
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest);
    }

    [Theory]
    [InlineData(false, 0)]
    [InlineData(true, 1)]
    public async Task DerivesWarningsOnlyFromClosedObservedFeaturePolicy(
        bool observePageEbookLimit,
        int expectedWarningCount)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        ImmutableArray<string> observed = observePageEbookLimit
            ? ["headings", "page-ebook-limits"]
            : ["headings"];
        DocumentExportRendererResponse response = ValidResponse(input, observedFeatures: observed);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: response.ContentDigest,
            observedFeatures: observed);

        DocumentExportProviderResult result = await CreateProvider(fixture).ExportAsync(task, input);

        Assert.Equal(expectedWarningCount, result.Receipt.Warnings.Count);
        if (observePageEbookLimit)
        {
            Assert.Equal(
                "page-ebook-limits:preserve-semantic-flow-with-explicit-warning",
                Assert.Single(result.Receipt.Warnings));
        }
        Assert.Equal(observed.OrderBy(value => value, StringComparer.Ordinal), result.Receipt.ObservedFeatures);
    }

    [Theory]
    [InlineData("headings,headings")]
    [InlineData("headings,unknown-feature")]
    public async Task RejectsUnknownOrDuplicateObservedFeatures(string observedCsv)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        ImmutableArray<string> observed = observedCsv.Split(',').ToImmutableArray();
        DocumentExportRendererResponse response = ValidResponse(input, observedFeatures: observed);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: response.ContentDigest,
            observedFeatures: observed);

        await Assert.ThrowsAsync<InvalidDataException>(
            () => CreateProvider(fixture).ExportAsync(task, input));
    }

    [Fact]
    public void RendererResponseDigestBindsEveryClosedIdentityAndSemanticField()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportRendererResponse response = ValidResponse(input);

        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(response, input);
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                Title = "tampered title"
            }, input));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                ObservedFeatures = ["headings"]
            }, input));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                RendererVersion = "other"
            }, input));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            response with
            {
                HtmlFragment = "<p>tampered</p>"
            }, input));
    }

    [Fact]
    public async Task OwnsDeepFrozenInputBeforeAwaitAndIgnoresCallerMutation()
    {
        DocumentExportFrozenInput baseline = DocumentExportContractTests.ValidInput("# original caller source");
        byte[] sourceBytes = baseline.MarkdownUtf8.ToArray();
        byte[] assetBytes = baseline.Assets[0].Bytes.ToArray();
        var asset = baseline.Assets[0] with
        {
            Bytes = ImmutableCollectionsMarshal.AsImmutableArray(assetBytes)
        };
        DocumentExportAsset[] assetContainer = baseline.Assets.ToArray();
        assetContainer[0] = asset;
        DocumentExportFrozenInput callerOwned = baseline with
        {
            MarkdownUtf8 = ImmutableCollectionsMarshal.AsImmutableArray(sourceBytes),
            Assets = ImmutableCollectionsMarshal.AsImmutableArray(assetContainer),
            ContentDigest = string.Empty
        };
        callerOwned = callerOwned with
        {
            ContentDigest = DocumentExportDigest.Compute(callerOwned)
        };
        DocumentExportFrozenInput expectedSnapshot = DocumentExportContractValidator.Seal(callerOwned);
        DocumentExportTask task = DocumentExportContractTests.ValidTask(expectedSnapshot);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(expectedSnapshot).ContentDigest);
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);

        Task<DocumentExportProviderResult> pending = provider.ExportAsync(task, callerOwned);
        sourceBytes[0] = (byte)'!';
        assetBytes[0] = 0;
        assetContainer[0] = asset with
        {
            AltText = "mutated"
        };
        DocumentExportProviderResult result = await pending;

        string expectedDataUri = $"data:{asset.MediaType};base64,{Convert.ToBase64String(expectedSnapshot.Assets[0].Bytes.AsSpan())}";
        Assert.Contains(expectedDataUri, Encoding.UTF8.GetString(result.Bytes), StringComparison.Ordinal);
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result,
            task,
            expectedSnapshot,
            fixture.Tool,
            fixture.HostBuildDigest);
    }

    [Fact]
    public async Task IndependentVerifierRejectsOutputReceiptAndSandboxTamper()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        using var fixture = new DocumentExportTestToolFixture(
            responseDigest: ValidResponse(input).ContentDigest);
        SelfContainedHtmlDocumentExportProvider provider = CreateProvider(fixture);
        DocumentExportProviderResult result = await provider.ExportAsync(task, input);
        var registry = new DocumentExportProviderRegistry(fixture.CreateSandbox());
        IDocumentExportJobProvider jobProvider = registry.RequireJobProvider("self-contained-html");
        Assert.Equal(result.Receipt.ProviderId, jobProvider.ProviderId);
        Assert.Same(jobProvider, registry.RequireJobProvider("self-contained-html"));
        await jobProvider.VerifyAsync(result, task, input, CancellationToken.None);
        await Assert.ThrowsAsync<InvalidDataException>(() => jobProvider.VerifyAsync(
            result with
            {
                Bytes = [.. result.Bytes, 0]
            },
            task,
            input,
            CancellationToken.None));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => jobProvider.VerifyAsync(
            result, task, input, cancelled.Token));
        Assert.Throws<InvalidOperationException>(() => registry.RequireJobProvider("pdf"));
        Assert.Throws<InvalidOperationException>(() => registry.RequireJobProvider("docx"));
        Assert.Throws<InvalidOperationException>(() => registry.RequireJobProvider("epub"));

        string substitutedHost = DocumentExportDigest.ComputeBytes("substituted host"u8);
        DocumentExportSandboxPlan substitutedPlan = DocumentExportSandboxRuntime.SealPlan(result.SandboxPlan with
        {
            HostBuildDigest = substitutedHost
        });
        DocumentExportSandboxReceipt substitutedSandbox = result.SandboxReceipt with
        {
            HostBuildDigest = substitutedHost,
            PlanDigest = substitutedPlan.ContentDigest,
            ContentDigest = string.Empty
        };
        substitutedSandbox = substitutedSandbox with
        {
            ContentDigest = DocumentExportDigest.Compute(substitutedSandbox)
        };
        DocumentExportProviderReceipt substitutedReceipt = DocumentExportContractValidator.Seal(result.Receipt with
        {
            SandboxReceiptDigest = substitutedSandbox.ContentDigest
        });
        DocumentExportProviderResult substitutedResult = result with
        {
            SandboxPlan = substitutedPlan,
            SandboxReceipt = substitutedSandbox,
            Receipt = substitutedReceipt
        };
        // All changed envelopes are resealed; the registry must still use its
        // own frozen host identity rather than adopting the result's identity.
        SelfContainedHtmlDocumentExportProvider.ValidateResult(
            substitutedResult, task, input, fixture.Tool, substitutedHost);
        await Assert.ThrowsAsync<InvalidDataException>(() => jobProvider.VerifyAsync(
            substitutedResult, task, input, CancellationToken.None));

        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                Bytes = [.. result.Bytes, 0]
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                Receipt = result.Receipt with
                {
                    Status = DocumentExportProviderResultStatus.Failed
                }
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                SandboxReceipt = result.SandboxReceipt with
                {
                    RunDirectoryRemoved = false
                }
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                SandboxOutputBytes = [.. result.SandboxOutputBytes, 0]
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));

        DocumentExportProviderReceipt warningTamper = result.Receipt with
        {
            Warnings = [],
            ContentDigest = string.Empty
        };
        warningTamper = warningTamper with
        {
            ContentDigest = DocumentExportDigest.Compute(warningTamper)
        };
        Assert.Throws<InvalidDataException>(() => SelfContainedHtmlDocumentExportProvider.ValidateResult(
            result with
            {
                Receipt = warningTamper
            },
            task,
            input,
            fixture.Tool,
            fixture.HostBuildDigest));
    }

    [Fact]
    public void StaticGovernanceHasNoRendererParserNetworkScreenshotOrFormatFallbackAuthority()
    {
        Type[] closedTypes =
        [
            typeof(DocumentExportRendererRequest),
            typeof(DocumentExportRendererResponse),
            typeof(DocumentExportProviderResult),
            typeof(SelfContainedHtmlDocumentExportProvider),
            typeof(CanonicalDocumentRendererResult),
            typeof(ICanonicalDocumentRendererAdapter),
            typeof(SandboxCanonicalDocumentRendererAdapter),
            typeof(DocumentExportProviderRegistry),
            typeof(DocumentExportBoundedMemoryStream),
            typeof(DocumentExportHtmlSanitizer),
            typeof(DocumentExportHtmlVerifier)
        ];
        Assert.All(closedTypes, AssertNoFallbackAuthority);
        Assert.Empty(typeof(SelfContainedHtmlDocumentExportProvider).GetConstructors());
        MethodInfo export = Assert.Single(
            typeof(SelfContainedHtmlDocumentExportProvider).GetMethods(),
            method => method.Name == nameof(SelfContainedHtmlDocumentExportProvider.ExportAsync));
        Assert.Equal(
            [typeof(DocumentExportTask), typeof(DocumentExportFrozenInput), typeof(CancellationToken)],
            export.GetParameters().Select(parameter => parameter.ParameterType));
        AssertRegistryConstruction(typeof(DocumentExportProviderRegistry));
    }

    [Fact]
    public void CompiledRegistryRefusalsCannotSubstituteTextOrAnotherTypeForRealConstruction()
    {
        Type[] refusals =
        [
            typeof(TextOnlyRegistryFixture),
            typeof(OtherProviderRegistryFixture),
            typeof(DuplicateProviderRegistryFixture),
            typeof(TextOnlyToolRegistryFixture),
            typeof(OtherToolRegistryFixture),
            typeof(WrongFormatRegistryFixture)
        ];
        ConstructorInfo providerConstructor = ProviderConstructor();
        MethodInfo requireTool = RegisteredToolMethod();
        Assert.Empty(ReadSoleConstructor(typeof(TextOnlyRegistryFixture))
            .Where(instruction => instruction.OpCode == OpCodes.Newobj && instruction.Member == providerConstructor));
        IlInstruction otherConstruction = Assert.Single(ReadSoleConstructor(typeof(OtherProviderRegistryFixture)),
            instruction => instruction.OpCode == OpCodes.Newobj
                && instruction.Member?.DeclaringType == typeof(OtherProviderRegistryFixture.SelfContainedHtmlDocumentExportProvider));
        Assert.NotEqual(providerConstructor, otherConstruction.Member);
        Assert.Equal(2, ReadSoleConstructor(typeof(DuplicateProviderRegistryFixture))
            .Count(instruction => instruction.OpCode == OpCodes.Newobj && instruction.Member == providerConstructor));
        Assert.DoesNotContain(ReadSoleConstructor(typeof(TextOnlyToolRegistryFixture)),
            instruction => instruction.Member == requireTool);
        Assert.Contains(ReadSoleConstructor(typeof(OtherToolRegistryFixture)),
            instruction => instruction.Member?.DeclaringType == typeof(OtherToolRegistryFixture.OtherSandbox)
                && instruction.Member?.Name == requireTool.Name);
        Assert.Contains(ReadSoleConstructor(typeof(WrongFormatRegistryFixture)),
            instruction => instruction.Member == requireTool
                && (instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt));
        Assert.All(refusals, type => Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertRegistryConstruction(type)));

        AssertRegistryConstruction(typeof(BenignRegistryFixture));
    }

    [Fact]
    public void CompiledFallbackRefusalsIncludeUncalledNestedMethodsAndConstructors()
    {
        MethodInfo network = Assert.Single(typeof(NestedNetworkFixture.Uncalled).GetMethods(DeclaredMembers),
            method => method.Name == nameof(NestedNetworkFixture.Uncalled.CreateClient));
        Assert.Contains(ReadInstructions(network), instruction => instruction.OpCode == OpCodes.Newobj
            && instruction.Member?.DeclaringType == typeof(System.Net.Http.HttpClient));
        MethodInfo process = Assert.Single(typeof(NestedProcessFixture.Uncalled).GetMethods(DeclaredMembers),
            method => method.Name == nameof(NestedProcessFixture.Uncalled.Start));
        Assert.Contains(ReadInstructions(process), instruction => instruction.OpCode == OpCodes.Call
            && instruction.Member?.DeclaringType == typeof(System.Diagnostics.Process)
            && instruction.Member?.Name == nameof(System.Diagnostics.Process.Start));
        Assert.Contains(ReadSoleConstructor(typeof(NestedConstructorFixture.Uncalled)),
            instruction => instruction.OpCode == OpCodes.Ldstr && instruction.Literal == "Screenshot");
        (Type Type, string Method, string Literal)[] literalBodies =
        [
            (typeof(NestedFormatFixture.Uncalled), "Format", "document-export.epub"),
            (typeof(NestedPdfFixture.Uncalled), "Format", "document-export.pdf"),
            (typeof(NestedDocxFixture.Uncalled), "Format", "document-export.docx"),
            (typeof(NestedParserFixture.Uncalled), "Parser", "Markdig"),
            (typeof(NestedMarkdownFixture.Uncalled), "Parser", "Markdown.Parse")
        ];
        Assert.All(literalBodies, candidate =>
        {
            MethodInfo method = Assert.Single(candidate.Type.GetMethods(DeclaredMembers),
                declared => declared.Name == candidate.Method);
            Assert.Contains(ReadInstructions(method), instruction => instruction.OpCode == OpCodes.Ldstr
                && instruction.Literal == candidate.Literal);
        });
        Type[] refusals =
        [
            typeof(NestedNetworkFixture),
            typeof(NestedProcessFixture),
            typeof(NestedConstructorFixture),
            typeof(NestedFormatFixture),
            typeof(NestedPdfFixture),
            typeof(NestedDocxFixture),
            typeof(NestedParserFixture),
            typeof(NestedMarkdownFixture)
        ];
        Assert.All(refusals, type => Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoFallbackAuthority(type)));
        AssertNoFallbackAuthority(typeof(BenignFallbackFixture));
    }

    private const BindingFlags DeclaredMembers = BindingFlags.Instance | BindingFlags.Static
        | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

    private static readonly IReadOnlyDictionary<ushort, OpCode> s_opCodes = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(field => field.FieldType == typeof(OpCode))
        .Select(field => (OpCode)field.GetValue(null)!)
        .GroupBy(opCode => unchecked((ushort)opCode.Value))
        .ToDictionary(group => group.Key, group => group.First());

    private static void AssertNoFallbackAuthority(Type type)
    {
        string compiled = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(type),
            RuntimeMetadataInspection.DescribeConstructors(type));
        Assert.DoesNotContain("Markdig", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Markdown.Parse", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpClient", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.Start", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Screenshot", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.pdf", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.docx", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("document-export.epub", compiled, StringComparison.Ordinal);
        Assert.All(type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic), AssertNoFallbackAuthority);
    }

    private static ConstructorInfo ProviderConstructor()
    {
        ConstructorInfo constructor = Assert.Single(typeof(SelfContainedHtmlDocumentExportProvider).GetConstructors(DeclaredMembers));
        Assert.Equal([typeof(ICanonicalDocumentRendererAdapter)],
            constructor.GetParameters().Select(parameter => parameter.ParameterType));
        return constructor;
    }

    private static MethodInfo RegisteredToolMethod()
    {
        MethodInfo method = Assert.Single(typeof(DocumentExportSandboxRuntime).GetMethods(DeclaredMembers),
            candidate => candidate.Name == "RequireRegisteredTool");
        Assert.Equal(typeof(DocumentExportToolContract), method.ReturnType);
        Assert.Equal([typeof(string)], method.GetParameters().Select(parameter => parameter.ParameterType));
        return method;
    }

    private static void AssertRegistryConstruction(Type type)
    {
        IReadOnlyList<IlInstruction> instructions = ReadSoleConstructor(type);
        ConstructorInfo providerConstructor = ProviderConstructor();
        Assert.Single(instructions, instruction => instruction.OpCode == OpCodes.Newobj
            && instruction.Member == providerConstructor);
        MethodInfo requireTool = RegisteredToolMethod();
        // These are exact sites in the declared constructor, not a tool-to-provider dataflow proof.
        Assert.Contains(Enumerable.Range(1, instructions.Count - 1), index =>
            (instructions[index].OpCode == OpCodes.Call || instructions[index].OpCode == OpCodes.Callvirt)
            && instructions[index].Member == requireTool
            && instructions[index - 1].OpCode == OpCodes.Ldstr
            && instructions[index - 1].Literal == "self-contained-html");
    }

    private static IReadOnlyList<IlInstruction> ReadSoleConstructor(Type type)
        => ReadInstructions(Assert.Single(type.GetConstructors(DeclaredMembers)));

    private static IReadOnlyList<IlInstruction> ReadInstructions(MethodBase method)
    {
        MethodBody body = Assert.IsAssignableFrom<MethodBody>(method.GetMethodBody());
        byte[] il = Assert.IsType<byte[]>(body.GetILAsByteArray());
        Type[] typeArguments = method.DeclaringType?.GetGenericArguments() ?? Type.EmptyTypes;
        Type[] methodArguments = method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes;
        var instructions = new List<IlInstruction>();
        for (int offset = 0; offset < il.Length;)
        {
            ushort value = il[offset++];
            if (value == 0xfe)
            {
                Assert.True(offset < il.Length);
                value = (ushort)(0xfe00 | il[offset++]);
            }
            Assert.True(s_opCodes.TryGetValue(value, out OpCode opCode));
            int operandSize = opCode.OperandType switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI or OperandType.InlineMethod
                    or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
                    or OperandType.ShortInlineR => 4,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch when offset + 4 <= il.Length => checked(4 + BitConverter.ToInt32(il, offset) * 4),
                _ => -1
            };
            Assert.True(operandSize >= 0 && operandSize <= il.Length - offset);
            MemberInfo? member = opCode.OperandType == OperandType.InlineMethod
                ? method.Module.ResolveMethod(BitConverter.ToInt32(il, offset), typeArguments, methodArguments)
                : null;
            string? literal = opCode == OpCodes.Ldstr
                ? method.Module.ResolveString(BitConverter.ToInt32(il, offset))
                : null;
            if (opCode != OpCodes.Nop)
            {
                instructions.Add(new IlInstruction(opCode, member, literal));
            }
            offset += operandSize;
        }
        return instructions;
    }

    private readonly record struct IlInstruction(OpCode OpCode, MemberInfo? Member, string? Literal);

    private sealed class TextOnlyRegistryFixture
    {
        public TextOnlyRegistryFixture() => GC.KeepAlive(
            "SelfContainedHtmlDocumentExportProvider..ctor\nself-contained-html\nFsusBlog.Server.Services.DocumentExport.DocumentExportSandboxRuntime.RequireRegisteredTool");
    }

    private sealed class OtherProviderRegistryFixture
    {
        public OtherProviderRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive(sandbox.RequireRegisteredTool("self-contained-html"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider());
        }

        internal sealed class SelfContainedHtmlDocumentExportProvider
        {
            public SelfContainedHtmlDocumentExportProvider()
            {
            }
        }
    }

    private sealed class DuplicateProviderRegistryFixture
    {
        public DuplicateProviderRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive(sandbox.RequireRegisteredTool("self-contained-html"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }
    }

    private sealed class TextOnlyToolRegistryFixture
    {
        public TextOnlyToolRegistryFixture()
        {
            GC.KeepAlive("self-contained-html\nFsusBlog.Server.Services.DocumentExport.DocumentExportSandboxRuntime.RequireRegisteredTool");
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }
    }

    private sealed class WrongFormatRegistryFixture
    {
        public WrongFormatRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive("self-contained-html");
            GC.KeepAlive(sandbox.RequireRegisteredTool("document-export.pdf"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }
    }

    private sealed class OtherToolRegistryFixture
    {
        public OtherToolRegistryFixture(OtherSandbox sandbox)
        {
            GC.KeepAlive(sandbox.RequireRegisteredTool("self-contained-html"));
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(null!));
        }

        internal sealed class OtherSandbox
        {
            public DocumentExportToolContract RequireRegisteredTool(string formatId) => null!;
        }
    }

    private sealed class BenignRegistryFixture
    {
        public BenignRegistryFixture(DocumentExportSandboxRuntime sandbox)
        {
            GC.KeepAlive("SelfContainedHtmlDocumentExportProvider..ctor");
            DocumentExportToolContract tool = sandbox.RequireRegisteredTool("self-contained-html");
            GC.KeepAlive(new SelfContainedHtmlDocumentExportProvider(
                new SandboxCanonicalDocumentRendererAdapter(sandbox, tool)));
        }
    }

    private sealed class NestedNetworkFixture
    {
        internal static class Uncalled
        {
            public static object CreateClient() => new System.Net.Http.HttpClient();
        }
    }

    private sealed class NestedProcessFixture
    {
        internal static class Uncalled
        {
            public static object? Start() => System.Diagnostics.Process.Start("forbidden-fixture");
        }
    }

    private sealed class NestedConstructorFixture
    {
        internal sealed class Uncalled
        {
            public Uncalled() => GC.KeepAlive("Screenshot");
        }
    }

    private sealed class NestedFormatFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "document-export.epub";
        }
    }

    private sealed class BenignFallbackFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "self-contained-html";
        }
    }

    private sealed class NestedPdfFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "document-export.pdf";
        }
    }

    private sealed class NestedDocxFixture
    {
        internal static class Uncalled
        {
            public static string Format() => "document-export.docx";
        }
    }

    private sealed class NestedParserFixture
    {
        internal static class Uncalled
        {
            public static string Parser() => "Markdig";
        }
    }

    private sealed class NestedMarkdownFixture
    {
        internal static class Uncalled
        {
            public static string Parser() => "Markdown.Parse";
        }
    }

    private static DocumentExportRendererResponse ValidResponse(
        DocumentExportFrozenInput input,
        string? fragment = null,
        ImmutableArray<string>? observedFeatures = null)
        => SelfContainedHtmlDocumentExportProvider.SealRendererResponse(new DocumentExportRendererResponse(
            DocumentExportContractCatalog.RendererResponseSchema,
            input.InputId,
            input.ContentDigest,
            input.SourceDigest,
            input.AssetManifestDigest,
            input.FontManifestDigest,
            input.ReadingStyleAuthorityDigest,
            input.RendererId,
            input.RendererVersion,
            input.RendererDigest,
            "离线文档",
            fragment ?? DocumentExportTestToolFixture.DefaultFragment,
            observedFeatures ?? DocumentExportTestToolFixture.DefaultObservedFeatures,
            string.Empty));

    private static SelfContainedHtmlDocumentExportProvider CreateProvider(
        DocumentExportTestToolFixture fixture)
        => new DocumentExportProviderRegistry(fixture.CreateSandbox())
            .RequireSelfContainedHtml("self-contained-html");
}
