using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Articles;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticlePublicationValidatorTests
{
    private static readonly DateTime s_now = new(2026, 7, 19, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Published_RequiresCompleteContent()
    {
        ArticlePublicationValidationResult result = CreateValidator().ValidateContent(
            Input(title: " ", content: string.Empty, status: ArticleStatus.Published),
            s_now);

        Assert.False(result.CanWrite);
        Assert.False(result.CanPublish);
        Assert.Contains(result.Issues, static issue => issue.Code == "title_invalid");
        Assert.Contains(result.Issues, static issue => issue.Code == "content_invalid");
    }

    [Theory]
    [InlineData(ArticleStatus.Draft)]
    [InlineData(ArticleStatus.Archived)]
    public void NonPublicStates_MayRemainIncomplete(ArticleStatus status)
    {
        ArticlePublicationValidationResult result = CreateValidator().ValidateContent(
            Input(title: string.Empty, content: string.Empty, status: status),
            s_now);

        Assert.True(result.CanWrite);
        Assert.False(result.CanPublish);
    }

    [Fact]
    public void Scheduled_UsesFixedTimeStatusPolicy()
    {
        ArticlePublicationValidationResult result = CreateValidator().ValidateContent(
            Input(
                title: "Scheduled",
                content: "# body",
                status: ArticleStatus.Scheduled,
                scheduledPublishAt: s_now),
            s_now);

        Assert.False(result.CanWrite);
        Assert.Contains(result.Issues, static issue => issue.Code == "article_scheduled_at_must_be_future");
    }

    [Fact]
    public void LengthLimits_AcceptBoundaryAndRejectOverflowWithoutTruncation()
    {
        ArticlePublicationValidator validator = CreateValidator();
        ArticlePublicationValidationResult boundary = validator.ValidateContent(
            new ArticlePublicationValidationInput(
                new string('t', ArticlePublicationValidator.MaxTitleLength),
                new string('c', ArticlePublicationValidator.MaxContentLength),
                new string('s', ArticlePublicationValidator.MaxSummaryLength),
                $"https://example.com/{new string('x', ArticlePublicationValidator.MaxCoverImageUrlLength - 20)}",
                1,
                [],
                ArticleStatus.Published,
                null),
            s_now);
        ArticlePublicationValidationResult overflow = validator.ValidateContent(
            new ArticlePublicationValidationInput(
                new string('t', ArticlePublicationValidator.MaxTitleLength + 1),
                new string('c', ArticlePublicationValidator.MaxContentLength + 1),
                new string('s', ArticlePublicationValidator.MaxSummaryLength + 1),
                new string('x', ArticlePublicationValidator.MaxCoverImageUrlLength + 1),
                1,
                [],
                ArticleStatus.Published,
                null),
            s_now);

        Assert.True(boundary.CanWrite);
        Assert.False(overflow.CanWrite);
        Assert.Contains(overflow.Issues, static issue => issue.Code == "title_invalid");
        Assert.Contains(overflow.Issues, static issue => issue.Code == "content_invalid");
        Assert.Contains(overflow.Issues, static issue => issue.Code == "summary_invalid");
        Assert.Contains(overflow.Issues, static issue => issue.Code == "cover_url_invalid");
    }

    [Fact]
    public void Draft_DangerousMarkdownIsAWriteBlocker()
    {
        ArticlePublicationValidationResult result = CreateValidator().ValidateContent(
            Input("Draft", "<script>alert(1)</script>", ArticleStatus.Draft),
            s_now);

        Assert.False(result.CanWrite);
        Assert.Contains(result.Issues, static issue => issue.Code == "dangerous_html");
    }

    private static ArticlePublicationValidator CreateValidator()
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, "ok", string.Empty));
        return new ArticlePublicationValidator(Substitute.For<ISqlSugarClient>(), contentFilter);
    }

    private static ArticlePublicationValidationInput Input(
        string title,
        string content,
        ArticleStatus status,
        DateTime? scheduledPublishAt = null)
        => new(title, content, "summary", null, 1, [], status, scheduledPublishAt);
}
