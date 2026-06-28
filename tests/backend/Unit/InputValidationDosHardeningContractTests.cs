using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class InputValidationDosHardeningContractTests
{
    [Fact]
    public void SearchIndex_BoundsKeywordBodyAndCjkSegmentWork()
    {
        string source = ReadSource("src/backend/Services/SearchIndexService.cs");

        Assert.Contains("MaxSearchKeywordChars", source, StringComparison.Ordinal);
        Assert.Contains("normalizedKeyword.Length > MaxSearchKeywordChars", source, StringComparison.Ordinal);
        Assert.Contains("MaxIndexedBodyChars", source, StringComparison.Ordinal);
        Assert.Contains("TrimSearchBodyForTokenization", source, StringComparison.Ordinal);
        Assert.Contains("MaxCjkSegmentRunes", source, StringComparison.Ordinal);
        Assert.Contains("runeCount > MaxCjkSegmentRunes", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ContentFilterAndAuthoring_BoundTextBeforeLargeAllocations()
    {
        string contentFilter = ReadSource("src/backend/Services/Security/ContentFilterService.cs");
        string authoringEndpoints = ReadSource("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");
        string authoringDtos = ReadSource("src/backend/Models/Dtos/AuthoringDtos.cs");

        Assert.Contains("MaxValidationTextChars", contentFilter, StringComparison.Ordinal);
        Assert.Contains("text.Length > MaxValidationTextChars", contentFilter, StringComparison.Ordinal);
        Assert.Contains("ArrayPool<char>.Shared.Rent(text.Length)", contentFilter, StringComparison.Ordinal);

        Assert.Contains("MaxAuthoringRequestBytes", authoringEndpoints, StringComparison.Ordinal);
        Assert.Contains("context.Request.ContentLength > MaxAuthoringRequestBytes", authoringEndpoints, StringComparison.Ordinal);
        Assert.Contains("[property: System.ComponentModel.DataAnnotations.MaxLength", authoringDtos, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAndDevInputs_HaveExplicitLengthCaps()
    {
        string localFixture = ReadSource("src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs");
        string audit = ReadSource("src/backend/Infrastructure/Audit/AuditQueryService.cs");
        string subscription = ReadSource("src/backend/Modules/Endpoints/SubscriptionEndpoints.cs");
        string publicAot = ReadSource("src/backend/Modules/Endpoints/PublicAotEndpoints.cs");
        string comments = ReadSource("src/backend/Services/CommentService.cs");

        Assert.Contains("MaxRedirectPathChars", localFixture, StringComparison.Ordinal);
        Assert.Contains("redirect.Length > MaxRedirectPathChars", localFixture, StringComparison.Ordinal);
        Assert.Contains("MaxStorageStateBytes", localFixture, StringComparison.Ordinal);
        Assert.Contains("stream.Length > MaxStorageStateBytes", localFixture, StringComparison.Ordinal);

        Assert.Contains("MaxAuditPage", audit, StringComparison.Ordinal);
        Assert.Contains("Math.Clamp(request.Page, 1, MaxAuditPage)", audit, StringComparison.Ordinal);

        Assert.Contains("MaxEmailChars", subscription, StringComparison.Ordinal);
        Assert.Contains("request.Email.Length > MaxEmailChars", subscription, StringComparison.Ordinal);

        Assert.Contains("MaxNavigationPathChars", publicAot, StringComparison.Ordinal);
        Assert.Contains("rawPath.Length > MaxNavigationPathChars", publicAot, StringComparison.Ordinal);

        Assert.Contains("MaxReplyPreviewRootIds", comments, StringComparison.Ordinal);
        Assert.Contains("Math.Min(rootIds.Length, MaxReplyPreviewRootIds) * limit", comments, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
