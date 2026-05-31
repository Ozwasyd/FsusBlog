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
}
