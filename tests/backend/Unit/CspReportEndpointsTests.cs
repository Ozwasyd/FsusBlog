using System.Text;

using FsusBlog.Server.Modules.Endpoints;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

public sealed class CspReportEndpointsTests
{
    [Fact]
    public void TrySummarize_LegacyReportRedactsBlockedUrl()
    {
        byte[] payload = Encoding.UTF8.GetBytes("""
            {"csp-report":{"effective-directive":"style-src-attr","disposition":"enforce","blocked-uri":"https://attacker.invalid/private?q=secret"}}
            """);

        Assert.True(CspReportEndpoints.TrySummarize(payload, out CspReportEndpoints.CspReportSummary summary));
        Assert.Equal("style-src-attr", summary.Directive);
        Assert.Equal("enforce", summary.Disposition);
        Assert.Equal("https", summary.BlockedKind);
        Assert.DoesNotContain("attacker", summary.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret", summary.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TrySummarize_ReportingApiArrayAcceptsInlineViolation()
    {
        byte[] payload = Encoding.UTF8.GetBytes("""
            [{"type":"csp-violation","body":{"effectiveDirective":"script-src-elem","disposition":"enforce","blockedURL":"inline"}}]
            """);

        Assert.True(CspReportEndpoints.TrySummarize(payload, out CspReportEndpoints.CspReportSummary summary));
        Assert.Equal(new CspReportEndpoints.CspReportSummary("script-src-elem", "enforce", "inline"), summary);
    }

    [Fact]
    public async Task HandleAsync_RejectsOversizeReportWithoutReadingBody()
    {
        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/csp-report";
        context.Request.ContentLength = CspReportEndpoints.MaxReportBytes + 1;
        context.Response.Body = new MemoryStream();

        IResult result = await CspReportEndpoints.HandleAsync(
            context,
            NullLoggerFactory.Instance,
            CancellationToken.None);

        Assert.Equal(
            StatusCodes.Status413PayloadTooLarge,
            Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode);
        Assert.Equal("no-store", context.Response.Headers.CacheControl.ToString());
    }
}
