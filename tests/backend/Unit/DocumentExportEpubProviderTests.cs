using System.Buffers.Binary;
using System.Collections.Immutable;
using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportEpubProviderTests
{
    private static DocumentExportResourceBudgets Budgets => DocumentExportContractCatalog.RequireProvider("epub").Budgets;

    [Fact]
    public void GeneratesStableActualEpubWithPortableReferencesAndFrozenMetadata()
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata);
        EpubPackageBuildResult first = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        EpubPackageBuildResult second = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        Assert.Equal(first.Bytes, second.Bytes);
        Assert.Equal(first.Validation.SemanticDigest, second.Validation.SemanticDigest);
        Assert.Equal(DocumentExportDigest.ComputeBytes(first.Bytes), first.Validation.OutputDigest);
        Assert.Equal(1, first.Validation.ChapterCount);
        Assert.Equal(1, first.Validation.NavigationCount);
        Assert.Equal(2, first.Validation.ResourceCount);
        Assert.Equal(2, first.Validation.Warnings.Length);
        using var source = new MemoryStream(first.Bytes);
        using var zip = new ZipArchive(source, ZipArchiveMode.Read);
        Assert.Equal("mimetype", zip.Entries[0].FullName);
        string chapter = Text(zip, "EPUB/chapter-0001.xhtml");
        string opf = Text(zip, "EPUB/package.opf");
        string navigation = Text(zip, "EPUB/nav.xhtml");
        Assert.Contains("chapter-0001.xhtml#epub-reading-start", navigation, StringComparison.Ordinal);
        Assert.Contains("page-progression-direction=\"ltr\"", opf, StringComparison.Ordinal);
        Assert.Contains(metadata.Identifier, opf, StringComparison.Ordinal);
        Assert.Contains(metadata.Modified, opf, StringComparison.Ordinal);
        Assert.Contains("schema:accessibilityFeature", opf, StringComparison.Ordinal);
        Assert.Contains("readingOrder", opf, StringComparison.Ordinal);
        Assert.Contains("<h1 id=\"intro\">中文 🌍</h1>", chapter, StringComparison.Ordinal);
        Assert.Contains("<h2 id=\"second\">Second</h2>", chapter, StringComparison.Ordinal);
        Assert.Contains("href=\"#fn1\"", chapter, StringComparison.Ordinal);
        Assert.Contains("epub:type=\"noteref\"", chapter, StringComparison.Ordinal);
        Assert.Contains("epub:type=\"footnote\"", chapter, StringComparison.Ordinal);
        Assert.Contains("https://example.org/reference", chapter, StringComparison.Ordinal);
        Assert.DoesNotContain("data-asset-id", chapter, StringComparison.Ordinal);
        Assert.DoesNotContain("data:", chapter, StringComparison.Ordinal);
        Assert.DoesNotContain("data:", Text(zip, "EPUB/reading.css"), StringComparison.Ordinal);
        Assert.DoesNotContain(input.InputId, opf, StringComparison.Ordinal);
        Assert.DoesNotContain("ArticleId", opf, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", opf, StringComparison.Ordinal);
        Assert.Equal(0x04034b50u, BinaryPrimitives.ReadUInt32LittleEndian(first.Bytes.AsSpan(0, 4)));
        DocumentExportEpubPackageValidator.Validate(first.Bytes, input, response, metadata, Budgets);
    }

    [Theory]
    [InlineData("<table><p>x</p></table>")]
    [InlineData("<p><div>x</div></p>")]
    [InlineData("<p><a href=\"https://example.org\"><div>x</div></a></p>")]
    [InlineData("<pre><code><div>x</div></code></pre>")]
    [InlineData("<table>x<tr><td>x</td></tr></table>")]
    [InlineData("<table><tbody><td>x</td></tbody></table>")]
    [InlineData("<table><tr><p>x</p></tr></table>")]
    [InlineData("<table><tr><td colspan=\"-1\">x</td></tr></table>")]
    [InlineData("<table><tr><td colspan=\"0\">x</td></tr></table>")]
    [InlineData("<table><tr><td colspan=\"1001\">x</td></tr></table>")]
    [InlineData("<table><tr><td rowspan=\"-1\">x</td></tr></table>")]
    [InlineData("<table><tr><td rowspan=\"65535\">x</td></tr></table>")]
    [InlineData("<table><tr><th scope=\"invalid\">x</th></tr></table>")]
    [InlineData("<table><tr><td>x</td></tr><caption>Late</caption></table>")]
    [InlineData("<table><tbody><tr><td>x</td></tr></tbody><tr><td>x</td></tr></table>")]
    [InlineData("<ul><p>x</p></ul>")]
    [InlineData("<ol>x<li>x</li></ol>")]
    [InlineData("<li>x</li>")]
    [InlineData("<dl><dd>x</dd><dt>x</dt></dl>")]
    [InlineData("<figure><p>x</p><figcaption>x</figcaption><p>x</p></figure>")]
    [InlineData("<figcaption>x</figcaption>")]
    [InlineData("<details><p>x</p><summary>x</summary></details>")]
    [InlineData("<details><summary>x</summary><summary>x</summary></details>")]
    [InlineData("<p><br>x</br></p>")]
    [InlineData("<ol type=\"invalid\"><li>x</li></ol>")]
    [InlineData("<ol reversed=\"false\"><li>x</li></ol>")]
    [InlineData("<details open=\"false\"><summary>x</summary></details>")]
    [InlineData("<a href=\"https://example.org\"><details><summary>Summary</summary><p>Detail</p></details></a>")]
    [InlineData("<a href=\"https://example.org\"><section><div><details><summary>Summary</summary><p>Detail</p></details></div></section></a>")]
    [InlineData("<figure>before<figcaption>Caption</figcaption>after</figure>")]
    [InlineData("<figure>&#160;<figcaption>Caption</figcaption>after</figure>")]
    [InlineData("<figure>before<figcaption>Caption</figcaption>&#160;</figure>")]
    public void RefusesInvalidXhtmlInBuilderAndActualPackageEvenWhenFrozenContentMatches(string fragment)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse invalidResponse = Response(input, metadata, fragment);
        Assert.Throws<InvalidDataException>(() => EpubPackageBuilder.Build(input, invalidResponse, metadata, Budgets));

        const string ValidFragment = "<div id=\"structure-probe\">marker</div>";
        EpubPackageBuildResult valid = EpubPackageBuilder.Build(input, Response(input, metadata, ValidFragment), metadata, Budgets);
        // Match canonical attributes/escaping too: a missing external-link safety
        // attribute must not substitute for rejecting the actual content model.
        string canonicalFragment = Encoding.UTF8.GetString(DocumentExportHtmlSanitizer.Sanitize(fragment, [], Budgets.MaxOutputBytes));
        byte[] mutated = Rewrite(valid.Bytes, "EPUB/chapter-0001.xhtml", bytes => Encoding.UTF8.GetBytes(
            Encoding.UTF8.GetString(bytes).Replace(ValidFragment, canonicalFragment, StringComparison.Ordinal)));
        InvalidDataException failure = Assert.Throws<InvalidDataException>(() =>
            DocumentExportEpubPackageValidator.Validate(mutated, input, invalidResponse, metadata, Budgets));
        Assert.Contains("XHTML", failure.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("<a href=\"https://example.org\"><div><h2>Heading</h2><p>Block link</p></div></a>")]
    [InlineData("<a href=\"https://example.org\"><section><h2>Heading</h2><p>Block link</p></section></a>")]
    [InlineData("<a href=\"https://example.org\"><table><tr><td>Cell</td></tr></table></a>")]
    [InlineData("<a href=\"https://example.org\"><figure><figcaption>Caption</figcaption>body</figure></a>")]
    [InlineData("<figure><figcaption>Caption</figcaption>after</figure>")]
    [InlineData("<figure>before<figcaption>Caption</figcaption></figure>")]
    [InlineData("<figure> \n\t<figcaption>Caption</figcaption>after \n\t</figure>")]
    [InlineData("<figure> \n\tbefore<figcaption>Caption</figcaption> \n\t</figure>")]
    [InlineData("<figure><figcaption>Caption</figcaption></figure>")]
    [InlineData("<figure>before<strong>body</strong>after</figure>")]
    public void PreservesLegalBlockLinksAndFigureCaptionPlacement(string fragment)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata, fragment);
        EpubPackageBuildResult result = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        using var source = new MemoryStream(result.Bytes);
        using var zip = new ZipArchive(source, ZipArchiveMode.Read);
        XNamespace xhtml = "http://www.w3.org/1999/xhtml";
        XElement article = XElement.Parse(Text(zip, "EPUB/chapter-0001.xhtml"), LoadOptions.PreserveWhitespace)
            .Descendants(xhtml + "article").Single();
        XElement expected = XElement.Parse("<article xmlns=\"" + xhtml + "\">" + fragment + "</article>", LoadOptions.PreserveWhitespace);
        Assert.Equal(expected.Value, article.Elements().First().Value);
        Assert.Equal(expected.Descendants().Select(element => element.Name), article.Elements().First().DescendantsAndSelf().Select(element => element.Name));
        DocumentExportEpubPackageValidator.Validate(result.Bytes, input, response, metadata, Budgets);
    }

    [Theory]
    [InlineData("\r")]
    [InlineData("\r\n")]
    [InlineData("&#13;")]
    [InlineData("&#xD;")]
    [InlineData("&#x0d;&#10;")]
    public void RefusesCarriageReturnsBeforeCanonicalCodeWhitespaceCanBeLost(string newline)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata, "<pre><code>a" + newline + "b</code></pre>");
        InvalidDataException failure = Assert.Throws<InvalidDataException>(() => EpubPackageBuilder.Build(input, response, metadata, Budgets));
        Assert.Contains("whitespace must not be normalized", failure.Message, StringComparison.Ordinal);

        EpubPackageBuildResult valid = EpubPackageBuilder.Build(input, Response(input, metadata, "<pre><code>ab</code></pre>"), metadata, Budgets);
        byte[] mutated = Rewrite(valid.Bytes, "EPUB/chapter-0001.xhtml", bytes => Encoding.UTF8.GetBytes(
            Encoding.UTF8.GetString(bytes).Replace("<code>ab</code>", "<code>a" + newline + "b</code>", StringComparison.Ordinal)));
        InvalidDataException actualFailure = Assert.Throws<InvalidDataException>(() =>
            DocumentExportEpubPackageValidator.Validate(mutated, input, response, metadata, Budgets));
        Assert.Contains("whitespace must not be normalized", actualFailure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void PreservesSupportedXhtmlStructuresAndCodeCharactersInActualPackage()
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata, XhtmlSubsetFragment());
        EpubPackageBuildResult result = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        using var source = new MemoryStream(result.Bytes);
        using var zip = new ZipArchive(source, ZipArchiveMode.Read);
        XElement chapter = XElement.Parse(Text(zip, "EPUB/chapter-0001.xhtml"), LoadOptions.PreserveWhitespace);
        XNamespace xhtml = "http://www.w3.org/1999/xhtml";
        Assert.Equal("  α\t<>&\n  β\n", chapter.Descendants(xhtml + "code").Single().Value);
        Assert.Equal("0", (string?)chapter.Descendants(xhtml + "td").First().Attribute("rowspan"));
        Assert.Equal(2, chapter.Descendants(xhtml + "table").Count());
        DocumentExportEpubPackageValidator.Validate(result.Bytes, input, response, metadata, Budgets);
    }

    internal static string XhtmlSubsetFragment() => "<p><strong>Structured</strong> <a href=\"https://example.org\"><em>link</em></a></p>"
        + "<pre><code>  α&#9;&lt;&gt;&amp;&#10;  β\n</code></pre>"
        + "<table><caption>Direct rows</caption><tr><th scope=\"col\" colspan=\"2\">Header</th></tr>"
        + "<tr><td rowspan=\"0\">A</td><td>B</td></tr><tfoot><tr><td colspan=\"2\">Footer</td></tr></tfoot></table>"
        + "<table><thead><tr><th scope=\"row\">Header</th></tr></thead><tbody><tr><td>Body</td></tr></tbody></table>"
        + "<ol start=\"-1\" type=\"a\" reversed=\"reversed\"><li><p>First</p><ul><li>Nested</li></ul></li></ol>"
        + "<dl><dt>Term</dt><dt>Alias</dt><dd><p>Definition</p></dd><dd>Other</dd><dt>Next</dt><dd>Last</dd></dl>"
        + "<figure><figcaption>First caption</figcaption><p>Content</p></figure>"
        + "<details open=\"open\"><summary><strong>Summary</strong></summary><p>Details</p></details>";

    [Theory]
    [InlineData("ar", "rtl", "العربية שלום 🌍")]
    [InlineData("zh-Hant", "ltr", "中文 日本語 🌍")]
    [InlineData("en-US", "ltr", "English 🌍")]
    [InlineData("zh-Hant-TW", "ltr", "中文 🌍")]
    [InlineData("de-CH-1901", "ltr", "Deutsch 🌍")]
    public void PreservesExplicitLanguageDirectionAndUnicode(string language, string direction, string text)
    {
        EpubPublicationMetadata metadata = Metadata() with
        {
            Language = language,
            Direction = direction
        };
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata, "<p>" + text + "</p>");
        EpubPackageBuildResult result = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        using var source = new MemoryStream(result.Bytes);
        using var zip = new ZipArchive(source, ZipArchiveMode.Read);
        string content = Text(zip, "EPUB/chapter-0001.xhtml");
        Assert.Contains(text, content, StringComparison.Ordinal);
        Assert.Contains("dir=\"" + direction + "\"", content, StringComparison.Ordinal);
        Assert.Contains("lang=\"" + language + "\"", content, StringComparison.Ordinal);
        Assert.Contains("fonts:reader-glyph-coverage-not-certified", result.Validation.Warnings);
    }

    [Theory]
    [InlineData("en-a")]
    [InlineData("en-US-US")]
    [InlineData("en-1234-1234")]
    [InlineData("en-variant-VARIANT")]
    [InlineData("en-u-ca-gregory")]
    [InlineData("en-x-private")]
    public void RefusesFrozenLanguageOutsideClosedSupportedPolicy(string language)
    {
        EpubPublicationMetadata metadata = Metadata() with
        {
            Language = language
        };
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata);
        Assert.Throws<InvalidDataException>(() => EpubPackageBuilder.Build(input, response, metadata, Budgets));
    }

    [Fact]
    public void PreservesLargeMultiHeadingBooksWithoutInventingChapterFacts()
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        string fragment = "<h1 id=\"one\">First</h1><p>" + new string('界', 100001)
            + "</p><h2 id=\"two\">Second</h2><a href=\"#one\">Back</a>";
        DocumentExportRendererResponse response = Response(input, metadata, fragment);
        EpubPackageBuildResult result = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        Assert.Equal(1, result.Validation.ChapterCount);
        Assert.Contains("chapters:fixed-single-chapter-no-heading-facts", result.Validation.Warnings);
        Assert.True(result.Bytes.Length > 300000);
    }

    [Theory]
    [InlineData("EPUB/package.opf", "idref=\"chapter-0001\"", "idref=\"missing\"")]
    [InlineData("EPUB/package.opf", "media-type=\"image/png\"", "media-type=\"image/jpeg\"")]
    [InlineData("EPUB/package.opf", "id=\"nav\"", "id=\"chapter-0001\"")]
    [InlineData("EPUB/package.opf", "frozen-title", "private-owner-title")]
    [InlineData("META-INF/container.xml", "EPUB/package.opf", "EPUB/missing.opf")]
    [InlineData("EPUB/nav.xhtml", "chapter-0001.xhtml#epub-reading-start", "chapter-0001.xhtml#missing")]
    [InlineData("EPUB/nav.xhtml", "epub:type=\"landmarks\"", "epub:type=\"toc\"")]
    [InlineData("EPUB/chapter-0001.xhtml", "<h2 id=\"second\">Second</h2>", "<h2 id=\"second\">Changed</h2>")]
    [InlineData("EPUB/chapter-0001.xhtml", "href=\"#fn1\"", "href=\"#missing\"")]
    [InlineData("EPUB/chapter-0001.xhtml", "headers=\"cell-head\"", "headers=\"missing\"")]
    [InlineData("EPUB/chapter-0001.xhtml", "aria-labelledby=\"intro\"", "aria-labelledby=\"missing\"")]
    [InlineData("EPUB/chapter-0001.xhtml", "href=\"#second\"", "href=\"javascript:alert(1)\"")]
    [InlineData("EPUB/chapter-0001.xhtml", "</article>", "<script>bad</script></article>")]
    [InlineData("EPUB/chapter-0001.xhtml", "alt=\"hero\"", "alt=\"\"")]
    [InlineData("EPUB/reading.css", "max-width:72ch", "max-width:12ch")]
    [InlineData("EPUB/reading.css", "@font-face", "@import url(https://evil.invalid/font);@font-face")]
    [InlineData("EPUB/chapter-0001.xhtml", "<head>", "PRIVATE_OWNER_FACT<head>")]
    [InlineData("EPUB/package.opf", "<manifest>", "PRIVATE_OWNER_FACT<manifest>")]
    [InlineData("EPUB/package.opf", "</manifest>", "PRIVATE_OWNER_FACT</manifest>")]
    [InlineData("EPUB/chapter-0001.xhtml", "<head>", "<head xmlns:private=\"private-owner-fact\">")]
    [InlineData("EPUB/package.opf", "<manifest>", "<manifest xmlns:private=\"private-owner-fact\">")]
    [InlineData("META-INF/container.xml", "<rootfiles>", "<rootfiles xmlns:private=\"private-owner-fact\">")]
    [InlineData("EPUB/chapter-0001.xhtml", "encoding=\"utf-8\"", "encoding=\"utf-16\"")]
    [InlineData("EPUB/package.opf", "encoding=\"utf-8\"", "encoding=\"windows-1252\"")]
    public void RefusesResealedValidZipWithTamperedStructureContentOrResources(string path, string oldValue, string newValue)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata);
        EpubPackageBuildResult result = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        byte[] mutated = Rewrite(result.Bytes, path, bytes =>
        {
            string original = Encoding.UTF8.GetString(bytes);
            Assert.Contains(oldValue, original, StringComparison.Ordinal);
            return Encoding.UTF8.GetBytes(original.Replace(oldValue, newValue, StringComparison.Ordinal));
        });
        Assert.NotEqual(DocumentExportDigest.ComputeBytes(result.Bytes), DocumentExportDigest.ComputeBytes(mutated));
        Assert.Throws<InvalidDataException>(() => DocumentExportEpubPackageValidator.Validate(mutated, input, response, metadata, Budgets));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("bytes")]
    [InlineData("crc")]
    [InlineData("truncated")]
    [InlineData("timestamp")]
    [InlineData("compression")]
    [InlineData("tail")]
    [InlineData("duplicate")]
    [InlineData("traversal")]
    public void RefusesCorruptZipAndFrozenResources(string mutation)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata);
        EpubPackageBuildResult result = EpubPackageBuilder.Build(input, response, metadata, Budgets);
        string resourcePath = "EPUB/" + EpubPackageBuilder.ResourcePath(input.Assets.First(asset => asset.Role == "image"));
        byte[] mutated = result.Bytes.ToArray();
        switch (mutation)
        {
            case "missing":
                mutated = Rewrite(mutated, resourcePath, _ => null);
                break;
            case "bytes":
                mutated = Rewrite(mutated, resourcePath, bytes =>
                {
                    bytes[^1] ^= 1;
                    return bytes;
                });
                break;
            case "crc":
                mutated[14] ^= 1;
                break;
            case "truncated":
                mutated = mutated[..^1];
                break;
            case "timestamp":
                mutated[10] = 1;
                break;
            case "compression":
                mutated[8] = 8;
                break;
            case "tail":
                mutated = [.. mutated, 0];
                break;
            case "duplicate":
                mutated = Rewrite(mutated, string.Empty, bytes => bytes, extraPath: resourcePath);
                break;
            case "traversal":
                mutated = Rewrite(mutated, string.Empty, bytes => bytes, extraPath: "../private");
                break;
            default:
                throw new ArgumentException("Unknown test mutation.", nameof(mutation));
        }
        Assert.Throws<InvalidDataException>(() => DocumentExportEpubPackageValidator.Validate(mutated, input, response, metadata, Budgets));
    }

    [Theory]
    [InlineData("title")]
    [InlineData("author")]
    [InlineData("language")]
    [InlineData("direction")]
    [InlineData("identifier")]
    [InlineData("modified")]
    public void RefusesUnfrozenPublicationMetadata(string mutation)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        EpubPublicationMetadata changed = mutation switch
        {
            "title" => metadata with { Title = "changed" },
            "author" => metadata with { Authors = ["private-owner"] },
            "language" => metadata with { Language = "ar" },
            "direction" => metadata with { Direction = "rtl" },
            "identifier" => metadata with { Identifier = "urn:fsus:article:42" },
            "modified" => metadata with { Modified = "2026-10-08T12:00:00Z" },
            _ => throw new ArgumentException("Unknown metadata mutation.", nameof(mutation))
        };
        Assert.Throws<InvalidDataException>(() => EpubPackageBuilder.Build(input, Response(input, metadata), changed, Budgets));
    }

    [Theory]
    [InlineData("<script>bad</script>")]
    [InlineData("<iframe src=\"https://evil.invalid\"></iframe>")]
    [InlineData("<object>bad</object>")]
    [InlineData("<p onclick=\"bad\">bad</p>")]
    [InlineData("<a href=\"javascript:bad\">bad</a>")]
    [InlineData("<p style=\"writing-mode:vertical-rl\">bad</p>")]
    [InlineData("<a href=\"#missing\">bad</a>")]
    [InlineData("<p id=\"epub-reading-start\">collision</p>")]
    [InlineData("<p id=\"repeat\">a</p><p id=\"repeat\">b</p>")]
    [InlineData("<a href=\"https://example.org\"></a>")]
    public void RefusesActiveRemoteUnsupportedOrInaccessibleRendererFragments(string fragment)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        Assert.Throws<InvalidDataException>(() => EpubPackageBuilder.Build(input, Response(input, metadata, fragment), metadata, Budgets));
    }

    [Fact]
    public void RefusesCorruptFrozenMediaEvenWhenDigestsAreResealed()
    {
        EpubPublicationMetadata metadata = Metadata();
        foreach (string role in new[] { "image", "font" })
        {
            DocumentExportFrozenInput original = Input(metadata);
            ImmutableArray<DocumentExportAsset> assets = original.Assets.Select(asset =>
            {
                if (asset.Role != role)
                {
                    return asset;
                }
                byte[] bytes = asset.Bytes.ToArray();
                bytes[^1] ^= 255;
                return asset with
                {
                    Bytes = bytes.ToImmutableArray(),
                    Sha256 = DocumentExportDigest.ComputeBytes(bytes)
                };
            }).ToImmutableArray();
            DocumentExportFrozenInput corrupted = DocumentExportContractValidator.Seal(original with
            {
                Assets = assets,
                AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
                FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets)
            });
            DocumentExportContractValidator.Validate(corrupted);
            Assert.Throws<InvalidDataException>(() => EpubPackageBuilder.Build(corrupted, Response(corrupted, metadata), metadata, Budgets));
        }
    }

    [Fact]
    public void EnforcesCancelInputOutputEntryAndExpandedByteBudgets()
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportRendererResponse response = Response(input, metadata);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => EpubPackageBuilder.Build(input, response, metadata, Budgets, cancellation.Token));
        Assert.Throws<DocumentExportBudgetExceededException>(() => EpubPackageBuilder.Build(input, response, metadata, Budgets with { MaxInputBytes = 1 }));
        Assert.Throws<DocumentExportBudgetExceededException>(() => EpubPackageBuilder.Build(input, response, metadata, Budgets with { MaxOutputBytes = 100 }));
        Assert.Throws<DocumentExportBudgetExceededException>(() => EpubPackageBuilder.Build(input, response, metadata, Budgets with { MaxFileCount = 6 }));
        Assert.Throws<DocumentExportBudgetExceededException>(() => EpubPackageBuilder.Build(input, response, metadata, Budgets with { MaxFileBytes = 8000 }));
    }

    [Fact]
    public void RefusesExcessiveXmlDepthNodesAndUnqualifiedResourceAuthority()
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        string deep = string.Concat(Enumerable.Repeat("<div>", 66)) + "text" + string.Concat(Enumerable.Repeat("</div>", 66));
        Assert.Throws<DocumentExportBudgetExceededException>(() => EpubPackageBuilder.Build(input, Response(input, metadata, deep), metadata, Budgets));
        string many = string.Concat(Enumerable.Repeat("<p>x</p>", 20000));
        Assert.Throws<DocumentExportBudgetExceededException>(() => EpubPackageBuilder.Build(input, Response(input, metadata, many), metadata, Budgets));
        Assert.Throws<ArgumentNullException>(() => new DocumentExportEpubProvider(new RefusingAdapter(), null!));
    }

    [Fact]
    public void RefusesPngWithTrailingCompressedDataEvenWhenChunkCrcAndInputDigestsAreResealed()
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput original = Input(metadata);
        DocumentExportAsset image = original.Assets.First(asset => asset.Role == "image");
        byte[] png = image.Bytes.ToArray();
        int payloadLength = checked((int)BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(33, 4)));
        int crcOffset = 41 + payloadLength;
        byte[] corrupted = [.. png[..crcOffset], 0xff, .. png[crcOffset..]];
        BinaryPrimitives.WriteUInt32BigEndian(corrupted.AsSpan(33, 4), (uint)payloadLength + 1);
        BinaryPrimitives.WriteUInt32BigEndian(corrupted.AsSpan(crcOffset + 1, 4),
            EpubZipValidation.Crc32(corrupted.AsSpan(37, payloadLength + 5)));
        DocumentExportAsset changed = image with
        {
            Bytes = corrupted.ToImmutableArray(),
            Sha256 = DocumentExportDigest.ComputeBytes(corrupted)
        };
        ImmutableArray<DocumentExportAsset> assets = original.Assets.Select(asset => asset.AssetId == image.AssetId ? changed : asset).ToImmutableArray();
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(original with
        {
            Assets = assets,
            AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets)
        });
        DocumentExportContractValidator.Validate(input);
        Assert.Throws<InvalidDataException>(() => EpubPackageBuilder.Build(input, Response(input, metadata), metadata, Budgets));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RefusesInactiveProviderBeforeCanonicalAdapterIsInvoked(bool sharedAttempt)
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = "epub",
            ProviderId = "document-export.epub",
            ProviderVersion = "1"
        });
        var adapter = new RefusingAdapter();
        var provider = new DocumentExportEpubProvider(adapter, new RefusingResourceVerifier());
        var attempt = new DocumentExportAttemptResources(task, input, Budgets, TimeProvider.System);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sharedAttempt
            ? provider.ExportAsync(task, input, metadata, attempt)
            : provider.ExportAsync(task, input, metadata));
        Assert.Equal(0, adapter.Calls);
        Assert.Throws<InvalidDataException>(() => attempt.RequireCompleted(task, input));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task JobAdapterPreCancellationDoesNotResolveFrozenMetadataOrRender(bool verify, bool sharedAttempt)
    {
        var renderer = new RefusingAdapter();
        var resources = new RefusingResourceVerifier();
        var provider = new DocumentExportEpubProvider(renderer, resources);
        int metadataCalls = 0;
        string digest = DocumentExportDigest.ComputeBytes("unused-test-tool"u8);
        var tool = new DocumentExportToolContract("canonical-markdown-renderer", "current-v1",
            "/unused-test-tool", digest, "/unused-test-runtime", digest, []);
        var job = new EpubDocumentExportJobProvider(provider, _ =>
        {
            metadataCalls++;
            throw new InvalidOperationException("Cancelled jobs must not resolve metadata.");
        }, tool, digest, resources, (_, _, _) => throw new InvalidOperationException("Only the job claim may create resources."));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => sharedAttempt
            ? verify ? job.VerifyAsync(null!, null!, null!, null!, cancellation.Token)
                : job.ExportAsync(null!, null!, null!, cancellation.Token)
            : verify ? job.VerifyAsync(null!, null!, null!, cancellation.Token)
                : job.ExportAsync(null!, null!, cancellation.Token));
        Assert.Equal(0, metadataCalls);
        Assert.Equal(0, renderer.Calls);
    }

    [Fact]
    public async Task JobAttemptFactoryDelegatesOnceAndInactivePhasesCannotClaimCompletion()
    {
        EpubPublicationMetadata metadata = Metadata();
        DocumentExportFrozenInput input = Input(metadata);
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = "epub",
            ProviderId = "document-export.epub",
            ProviderVersion = "1"
        });
        TimeProvider time = TimeProvider.System;
        var attempt = new DocumentExportAttemptResources(task, input, Budgets, time);
        var renderer = new RefusingAdapter();
        var resources = new RefusingResourceVerifier();
        string digest = DocumentExportDigest.ComputeBytes("unused-test-tool"u8);
        var tool = new DocumentExportToolContract("canonical-markdown-renderer", "current-v1",
            "/unused-test-tool", digest, "/unused-test-runtime", digest, []);
        int factoryCalls = 0;
        IDocumentExportAttemptJobProvider job = new EpubDocumentExportJobProvider(
            new DocumentExportEpubProvider(renderer, resources), _ => metadata, tool, digest, resources,
            (createdTask, createdInput, createdTime) =>
            {
                factoryCalls++;
                Assert.Same(task, createdTask);
                Assert.Same(input, createdInput);
                Assert.Same(time, createdTime);
                return attempt;
            });
        Assert.Same(attempt, job.CreateAttemptResources(task, input, time));
        await Assert.ThrowsAsync<InvalidOperationException>(() => job.ExportAsync(task, input, attempt, CancellationToken.None));
        var unqualifiedResult = new DocumentExportProviderResult([], [], null!, null!, null!);
        await Assert.ThrowsAsync<InvalidOperationException>(() => job.VerifyAsync(unqualifiedResult, task, input, attempt, CancellationToken.None));
        Assert.Equal(1, factoryCalls);
        Assert.Equal(0, renderer.Calls);
        Assert.Throws<InvalidDataException>(() => attempt.RequireCompleted(task, input));
        IEpubFrozenResourceVerifier unsupported = resources;
        InvalidOperationException unsupportedFailure = Assert.Throws<InvalidOperationException>(() =>
            unsupported.Validate(input, attempt, CancellationToken.None));
        Assert.Equal("EPUB resource verifier does not support the sole attempt resource owner.", unsupportedFailure.Message);
    }

    internal static EpubPublicationMetadata Metadata() => new("frozen-title", "zh-Hant", "ltr", ["Published author"],
        "urn:uuid:9797a920-befb-4e76-83f6-6b296a7a611a", "2026-10-08T00:00:00Z");

    internal static DocumentExportFrozenInput Input(EpubPublicationMetadata metadata)
    {
        DocumentExportFrozenInput baseline = DocumentExportContractTests.ValidInput();
        byte[] png = Convert.FromBase64String(Png);
        byte[] font = Convert.FromBase64String(Font);
        ImmutableArray<DocumentExportAsset> assets = baseline.Assets.Select(asset =>
        {
            byte[] bytes = asset.Role == "image" ? png : font;
            return asset with
            {
                Bytes = bytes.ToImmutableArray(),
                Sha256 = DocumentExportDigest.ComputeBytes(bytes)
            };
        }).ToImmutableArray();
        return DocumentExportContractValidator.Seal(baseline with
        {
            Assets = assets,
            AssetManifestDigest = DocumentExportContractValidator.ComputeAssetManifestDigest(assets),
            FontManifestDigest = DocumentExportContractValidator.ComputeFontManifestDigest(assets),
            Locale = metadata.Language,
            MetadataDigest = metadata.ComputeFrozenDigest()
        });
    }

    internal static DocumentExportRendererResponse Response(DocumentExportFrozenInput input,
        EpubPublicationMetadata metadata, string? fragment = null)
    {
        DocumentExportAsset image = input.Assets.First(asset => asset.Role == "image");
        string html = fragment ?? "<h1 id=\"intro\">中文 🌍</h1><h2 id=\"second\">Second</h2>"
            + "<p aria-labelledby=\"intro\">שלום <a href=\"#second\">Next</a></p>"
            + "<a id=\"ref1\" role=\"doc-noteref\" href=\"#fn1\">1</a><aside id=\"fn1\" role=\"doc-footnote\">Note <a href=\"#ref1\">Back</a></aside>"
            + "<a href=\"https://example.org/reference\">Reference</a><pre><code>int x = 1;</code></pre>"
            + "<table><caption>Numbers</caption><thead><tr><th id=\"cell-head\" scope=\"col\">N</th></tr></thead><tbody><tr><td headers=\"cell-head\">1</td></tr></tbody></table>"
            + "<span class=\"katex\">x²</span><svg xmlns=\"http://www.w3.org/2000/svg\" role=\"img\" aria-label=\"Static diagram\"><title>Diagram</title><path d=\"M0 0L1 1\" /></svg>";
        html += "<figure><img data-asset-id=\"" + image.AssetId + "\" src=\"data:image/png;base64," + Convert.ToBase64String(image.Bytes.AsSpan())
            + "\" alt=\"" + image.AltText + "\" /><figcaption>Frozen caption</figcaption></figure>";
        return SelfContainedHtmlDocumentExportProvider.SealRendererResponse(new DocumentExportRendererResponse(
            DocumentExportContractCatalog.RendererResponseSchema, input.InputId, input.ContentDigest, input.SourceDigest,
            input.AssetManifestDigest, input.FontManifestDigest, input.ReadingStyleAuthorityDigest, input.RendererId,
            input.RendererVersion, input.RendererDigest, metadata.Title, html,
            DocumentExportContractCatalog.FeatureIds.ToImmutableArray(), string.Empty));
    }

    private static string Text(ZipArchive zip, string path)
    {
        using Stream entry = zip.GetEntry(path)!.Open();
        using var text = new StreamReader(entry, Encoding.UTF8);
        return text.ReadToEnd();
    }

    private static byte[] Rewrite(byte[] bytes, string path, Func<byte[], byte[]?> transform, string? extraPath = null)
    {
        using var source = new MemoryStream(bytes);
        using var input = new ZipArchive(source, ZipArchiveMode.Read);
        using var target = new MemoryStream();
        using (var output = new ZipArchive(target, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: Encoding.UTF8))
        {
            foreach (ZipArchiveEntry entry in input.Entries)
            {
                using Stream content = entry.Open();
                using var copy = new MemoryStream();
                content.CopyTo(copy);
                byte[]? payload = entry.FullName == path ? transform(copy.ToArray()) : copy.ToArray();
                if (payload is null)
                {
                    continue;
                }
                ZipArchiveEntry changed = output.CreateEntry(entry.FullName, CompressionLevel.NoCompression);
                changed.LastWriteTime = entry.LastWriteTime;
                changed.ExternalAttributes = 0;
                using Stream destination = changed.Open();
                destination.Write(payload);
            }
            if (extraPath is not null)
            {
                ZipArchiveEntry extra = output.CreateEntry(extraPath, CompressionLevel.NoCompression);
                extra.LastWriteTime = new DateTimeOffset(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);
                extra.ExternalAttributes = 0;
                using Stream content = extra.Open();
                content.Write([1]);
            }
        }
        return target.ToArray();
    }

    private sealed class RefusingAdapter : ICanonicalDocumentRendererAdapter
    {
        public int Calls
        {
            get; private set;
        }
        public DocumentExportToolContract Tool => throw new InvalidOperationException("Inactive provider must not resolve a tool.");
        public Task<CanonicalDocumentRendererResult> RenderAsync(DocumentExportTask task, DocumentExportFrozenInput input,
            CancellationToken cancellationToken = default)
        {
            Calls++;
            throw new InvalidOperationException("Inactive provider must not render.");
        }
    }

    private sealed class RefusingResourceVerifier : IEpubFrozenResourceVerifier
    {
        public void Validate(DocumentExportFrozenInput input, CancellationToken cancellationToken)
            => throw new InvalidOperationException("Inactive provider must not qualify resources.");
    }

    private const string Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

    // Real KaTeX_Size1-Regular.woff2 fixture from KaTeX 0.16.45, not the required reading families.
    // It verifies real table decompression without claiming CJK/RTL/emoji glyph coverage.
    /*
    The MIT License (MIT)

    Copyright (c) 2013-2020 Khan Academy and other contributors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    private const string Font = "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";
}
