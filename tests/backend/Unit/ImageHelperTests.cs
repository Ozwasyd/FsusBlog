using FsusBlog.Server.Helpers;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Unit tests for ImageHelper — Markdown stripping, illustration URL extraction.
/// Pure static class, no external dependencies.
/// </summary>
public sealed class ImageHelperTests
{
    // ─── StripMarkdown ─────────────────────────────────────────────────────

    [Fact]
    public void StripMarkdown_EmptyContent_ReturnsEmpty()
    {
        Assert.Equal(string.Empty, ImageHelper.StripMarkdown("", 100));
    }

    [Fact]
    public void StripMarkdown_WhitespaceContent_ReturnsEmpty()
    {
        Assert.Equal(string.Empty, ImageHelper.StripMarkdown("   ", 100));
    }

    [Fact]
    public void StripMarkdown_ZeroMaxLength_ReturnsEmpty()
    {
        Assert.Equal(string.Empty, ImageHelper.StripMarkdown("# Title", 0));
    }

    [Fact]
    public void StripMarkdown_PlainText_ReturnsAsIs()
    {
        string result = ImageHelper.StripMarkdown("Hello world", 100);
        Assert.Equal("Hello world", result);
    }

    [Fact]
    public void StripMarkdown_HeadingMarkdown_RemovesHashPrefix()
    {
        string result = ImageHelper.StripMarkdown("# Introduction", 100);
        Assert.DoesNotContain("#", result);
        Assert.Contains("Introduction", result);
    }

    [Fact]
    public void StripMarkdown_ImageMarkdown_RemovesAltAndUrl()
    {
        string result = ImageHelper.StripMarkdown("![alt text](https://example.com/img.png)", 200);
        Assert.DoesNotContain("![", result);
    }

    [Fact]
    public void StripMarkdown_LinkMarkdown_RemovesBrackets()
    {
        string result = ImageHelper.StripMarkdown("[click here](https://example.com)", 200);
        Assert.DoesNotContain("[click here]", result);
        Assert.Equal("click here", result);
    }

    [Fact]
    public void StripMarkdown_HtmlTag_RemovesTag()
    {
        string result = ImageHelper.StripMarkdown("Some <b>bold</b> text", 100);
        Assert.DoesNotContain("<b>", result);
        Assert.DoesNotContain("</b>", result);
        Assert.Contains("bold", result);
    }

    [Fact]
    public void StripMarkdown_TruncatesAtMaxLength()
    {
        string longText = new string('a', 200);
        string result = ImageHelper.StripMarkdown(longText, 50);
        Assert.True(result.Length <= 50);
    }

    [Fact]
    public void StripMarkdown_CollapsesMultipleSpaces()
    {
        // Markdown stripping inserts spaces; consecutive spaces should collapse
        string result = ImageHelper.StripMarkdown("A  # B", 100);
        Assert.DoesNotContain("  ", result);
    }

    [Fact]
    public void StripMarkdown_TrimsLeadingAndTrailingSpaces()
    {
        string result = ImageHelper.StripMarkdown("# Title\nSome text", 200);
        Assert.False(result.StartsWith(' '));
        Assert.False(result.EndsWith(' '));
    }

    [Fact]
    public void StripMarkdown_BackticksRemoved()
    {
        string result = ImageHelper.StripMarkdown("`code snippet`", 100);
        Assert.DoesNotContain("`", result);
    }

    [Fact]
    public void StripMarkdown_RemovesFencedCodeAndDecodesHtmlEntities()
    {
        string result = ImageHelper.StripMarkdown("Intro &amp; note.\n```csharp\nthrow new Exception();\n```\nAfter", 200);

        Assert.Equal("Intro & note. After", result);
        Assert.DoesNotContain("Exception", result);
    }

    [Fact]
    public void StripMarkdown_DecodesEncodedHtmlBeforeRemovingTags()
    {
        string result = ImageHelper.StripMarkdown("&lt;b&gt;text &amp; more&lt;/b&gt;", 200);

        Assert.Equal("text & more", result);
        Assert.DoesNotContain("<b>", result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void StripMarkdown_TruncatesAtSentenceAndGraphemeBoundaries()
    {
        string result = ImageHelper.StripMarkdown("第一句完整。第二句包含家庭表情 👨‍👩‍👧‍👦 和更多文字用于截断。", 12);

        Assert.Equal("第一句完整。", result);
        Assert.False(result.EndsWith('\u200d'));
    }

    // ─── ExtractIllustrationUrls ──────────────────────────────────────────

    [Fact]
    public void ExtractIllustrationUrls_EmptyContent_ReturnsEmptyList()
    {
        var result = ImageHelper.ExtractIllustrationUrls("");
        Assert.Empty(result);
    }

    [Fact]
    public void ExtractIllustrationUrls_NoIllustrations_ReturnsEmptyList()
    {
        var result = ImageHelper.ExtractIllustrationUrls("# Plain markdown with no images");
        Assert.Empty(result);
    }

    [Fact]
    public void ExtractIllustrationUrls_OneIllustration_ReturnsSingleItem()
    {
        string content = "![photo](/uploads/illustration/cover.jpg)";
        var result = ImageHelper.ExtractIllustrationUrls(content);
        Assert.Single(result);
        Assert.Contains("cover.jpg", result[0]);
    }

    [Fact]
    public void ExtractIllustrationUrls_DeduplicatesTheSameUrl()
    {
        string content = """
            ![a](/uploads/illustration/image.png)
            ![b](/uploads/illustration/image.png)
            """;
        var result = ImageHelper.ExtractIllustrationUrls(content);
        Assert.Single(result);
    }

    [Fact]
    public void ExtractIllustrationUrls_MultipleDistinctUrls_ReturnsAll()
    {
        string content = """
            ![a](/uploads/illustration/img1.jpg)
            ![b](/uploads/illustration/img2.png)
            """;
        var result = ImageHelper.ExtractIllustrationUrls(content);
        Assert.Equal(2, result.Count);
    }

    [Fact]
    public void ExtractIllustrationUrls_BuildsPhysicalPathWithWwwroot()
    {
        string content = "![cover](/uploads/illustration/my-photo.webp)";
        var result = ImageHelper.ExtractIllustrationUrls(content);
        Assert.Single(result);
        Assert.StartsWith("wwwroot", result[0]);
    }

    [Fact]
    public void ExtractIllustrationReferences_ReturnsUrlAndAltText()
    {
        string content = """
            ![Main cover](/uploads/illustration/cover.webp)
            bare: /uploads/illustration/inline.png
            duplicate: ![Again](/uploads/illustration/cover.webp)
            """;

        var result = ImageHelper.ExtractIllustrationReferences(content);

        Assert.Equal(2, result.Count);
        Assert.Contains(result, static item => item.Url == "/uploads/illustration/cover.webp" && item.AltText == "Main cover");
        Assert.Contains(result, static item => item.Url == "/uploads/illustration/inline.png" && item.AltText is null);
    }

    [Fact]
    public void ExtractIllustrationReferences_HandlesHtmlWhitespaceAndMalformedReferences()
    {
        string content = """
            <img alt="Inline" src="/uploads/illustration/html image.jpg">
            ![  Trimmed alt  ](/uploads/illustration/markdown-image.png "title")
            ![broken](/uploads/illustration/not-closed.png
            """;

        var result = ImageHelper.ExtractIllustrationReferences(content);

        Assert.Equal(2, result.Count);
        Assert.Contains(result, static item => item.Url == "/uploads/illustration/html image.jpg" && item.AltText is null);
        Assert.Contains(result, static item => item.Url == "/uploads/illustration/markdown-image.png" && item.AltText == "Trimmed alt");
        Assert.DoesNotContain(result, static item => item.Url.Contains("not-closed", StringComparison.Ordinal));
    }

    // ─── GetFirstIllustration ─────────────────────────────────────────────

    [Fact]
    public void GetFirstIllustration_EmptyContent_ReturnsNull()
    {
        Assert.Null(ImageHelper.GetFirstIllustration(""));
    }

    [Fact]
    public void GetFirstIllustration_NoIllustration_ReturnsNull()
    {
        Assert.Null(ImageHelper.GetFirstIllustration("# No images here"));
    }

    [Fact]
    public void GetFirstIllustration_OneMatch_ReturnsUrl()
    {
        string content = "![photo](/uploads/illustration/cover.jpg) and some text";
        string? result = ImageHelper.GetFirstIllustration(content);
        Assert.NotNull(result);
        Assert.Contains("/uploads/illustration/cover.jpg", result);
    }

    [Fact]
    public void GetFirstIllustration_MultipleMatches_ReturnsFirst()
    {
        string content = """
            first: /uploads/illustration/img1.jpg
            second: /uploads/illustration/img2.png
            """;
        string? result = ImageHelper.GetFirstIllustration(content);
        Assert.NotNull(result);
        Assert.Contains("img1.jpg", result);
    }

    [Theory]
    [InlineData("jpg")]
    [InlineData("jpeg")]
    [InlineData("png")]
    [InlineData("gif")]
    [InlineData("webp")]
    [InlineData("avif")]
    [InlineData("svg")]
    public void GetFirstIllustration_SupportedExtensions_ReturnExactUrl(string extension)
    {
        string expected = $"/uploads/illustration/cover.{extension}";
        string content = $"noise before {expected}; noise after";

        Assert.Equal(expected, ImageHelper.GetFirstIllustration(content));
    }

    [Theory]
    [InlineData("JpG")]
    [InlineData("WebP")]
    [InlineData("SVG")]
    public void GetFirstIllustration_MixedCaseExtensions_PreserveOriginalUrl(string extension)
    {
        string expected = $"/uploads/illustration/MixedCaseCover.{extension}";

        Assert.Equal(expected, ImageHelper.GetFirstIllustration($"prefix {expected} suffix"));
    }

    [Theory]
    [InlineData("cover.bmp")]
    [InlineData("cover.tiff")]
    [InlineData("cover.exe")]
    [InlineData("cover")]
    public void GetFirstIllustration_UnsupportedExtensions_ReturnNull(string fileName)
    {
        string content = $"/uploads/illustration/{fileName}";

        Assert.Null(ImageHelper.GetFirstIllustration(content));
    }

    [Fact]
    public void GetFirstIllustration_UnsupportedBeforeSupported_ReturnsFirstSupportedUrl()
    {
        const string Expected = "/uploads/illustration/actual-cover.avif";
        string content = $"ignored /uploads/illustration/unsupported.bmp then {Expected}";

        Assert.Equal(Expected, ImageHelper.GetFirstIllustration(content));
    }

    [Fact]
    public void GetFirstIllustration_AllowedFileNameCharacters_StopAtAdjacentContent()
    {
        const string Expected = "/uploads/illustration/cover photo-(draft)[v2].PNG";
        string content = $"before ({Expected}), next /uploads/illustration/second.jpg.";

        Assert.Equal(Expected, ImageHelper.GetFirstIllustration(content));
    }
}
