using FsusBlog.Server.Infrastructure.Bootstrap;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

public sealed class WebApplicationCompositionExtensionsTests
{
    [Fact]
    public void ApplyCspNonceToHtml_AddsNonceToScriptStyleAndHeadMeta()
    {
        var context = new DefaultHttpContext();
        context.Items["__fsusblog_csp_nonce"] = "abc123";

        string html = "<html><head></head><body><script type=\"module\"></script><style>.a{}</style></body></html>";

        string rendered = WebApplicationCompositionExtensions.ApplyCspNonceToHtml(context, html);

        Assert.Contains("<head>\n    <meta property=\"csp-nonce\" nonce=\"abc123\" /></head>", rendered);
        Assert.Contains("<script nonce=\"abc123\" type=\"module\">", rendered);
        Assert.Contains("<style nonce=\"abc123\">", rendered);
    }

    [Fact]
    public void ApplyCspNonceToHtml_PreservesExistingNonceAndMeta()
    {
        var context = new DefaultHttpContext();
        context.Items["__fsusblog_csp_nonce"] = "new";

        string html = "<html><head><meta property=\"csp-nonce\" nonce=\"old\" /></head><body><script nonce=\"old\"></script></body></html>";

        string rendered = WebApplicationCompositionExtensions.ApplyCspNonceToHtml(context, html);

        Assert.Contains("<meta property=\"csp-nonce\" nonce=\"old\" />", rendered);
        Assert.Contains("<script nonce=\"old\"></script>", rendered);
        Assert.DoesNotContain("nonce=\"new\"", rendered);
    }

    [Theory]
    [InlineData("/search/index.core.0123456789abcdef.bin", true)]
    [InlineData("/search/index.recent.0123456789ABCDEF.bin", true)]
    [InlineData("/search/index.archive.0123456789abcdef.bin", true)]
    [InlineData("/search/index.body.0123456789abcdef.bin", true)]
    [InlineData("/search/index.core.01234.bin", false)]
    [InlineData("/search/index.other.0123456789abcdef.bin", false)]
    [InlineData("/search/index.core.0123456789abcdef.json", false)]
    public void IsImmutableSearchIndexAssetPath_MatchesFixedHashedShape(string path, bool expected)
    {
        Assert.Equal(expected, WebApplicationCompositionExtensions.IsImmutableSearchIndexAssetPath(path));
    }

    [Fact]
    public void HotPathCompositionSource_AvoidsRegexAndFullPageReplaceForStaticAndFallback()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src", "backend", "Infrastructure", "Bootstrap", "WebApplicationCompositionExtensions.cs"));

        Assert.DoesNotContain("Regex.IsMatch", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Replace(\"</head>\"", source, StringComparison.Ordinal);
        Assert.Contains("SpaHtmlByteTemplate", source, StringComparison.Ordinal);
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
