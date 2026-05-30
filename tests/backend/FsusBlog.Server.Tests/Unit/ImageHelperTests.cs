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

    [Fact]
    public void GetFirstIllustration_SupportedExtensions_AllMatch()
    {
        foreach (string ext in new[] { "jpg", "jpeg", "png", "gif", "webp", "avif", "svg" })
        {
            string content = $"/uploads/illustration/cover.{ext}";
            string? result = ImageHelper.GetFirstIllustration(content);
            Assert.NotNull(result);
        }
    }
}
