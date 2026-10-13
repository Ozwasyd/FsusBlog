using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkRevisionReferenceTests
{
    [Fact]
    public void OpaqueReferenceIsBoundedAndPreservesExactOriginalProvenance()
    {
        var facts = Facts();
        string reference = ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts);
        ArticleLifecycleTransitionWriter.RequireBulkRevisionReferenceShape(reference);
        Assert.InRange(reference.Length, 1, 256);
        Assert.False(long.TryParse(reference, out _));
        Assert.Equal(reference, ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts));
        Assert.NotEqual(reference, ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts with
        {
            PreviousEditableStatus = null
        }));
        Assert.NotEqual(reference, ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts with
        {
            PreviousEditableStatus = ArticleStatus.Inbox
        }));
    }

    [Fact]
    public void EveryRevisionRowOrLifecycleChangeInvalidatesTheFrozenReference()
    {
        var facts = Facts();
        string reference = ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts);
        ArticleLifecycleTransitionWriter.BulkRevisionFacts[] changed =
        [
            facts with { ArticleId = 2 }, facts with { RevisionId = 9 }, facts with { RevisionNo = 2 },
            facts with { ArticleRowVersion = "12" }, facts with { RevisionRowVersion = "12" },
            facts with { Status = ArticleStatus.Inbox }, facts with { IsDeleted = true },
            facts with { ContentBlockId = 8 }, facts with { PublicationId = 8 },
            facts with { ScheduledPublishAt = DateTime.UnixEpoch }
        ];
        Assert.All(changed, change => Assert.NotEqual(reference, ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(change)));
    }

    [Theory]
    [InlineData("9")]
    [InlineData("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("article-bulk-revision.v1:sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("")]
    public void NumericProjectionOrNoncanonicalReferencesDoNotResolve(string reference)
        => Assert.ThrowsAny<ArgumentException>(() => ArticleLifecycleTransitionWriter.RequireBulkRevisionReferenceShape(reference));

    [Fact]
    public void InvalidOrLossyRowVersionFactsAreRejected()
    {
        var facts = Facts();
        Assert.ThrowsAny<ArgumentException>(() => ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts with { ArticleRowVersion = "01" }));
        Assert.ThrowsAny<ArgumentException>(() => ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts with { RevisionRowVersion = "x" + (char)0xd800 }));
        Assert.ThrowsAny<ArgumentException>(() => ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts with { RevisionId = 0 }));
        Assert.ThrowsAny<ArgumentException>(() => ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(facts with { Status = (ArticleStatus)255 }));
    }

    [Fact]
    public async Task ConstructedResolutionCannotInvokeOriginalPreparation()
    {
        string reference = ArticleLifecycleTransitionWriter.ComputeBulkRevisionReference(Facts());
        var fake = new ArticleLifecycleTransitionWriter.BulkRevisionResolution(reference, 1, 7);
        await Assert.ThrowsAnyAsync<ArgumentException>(() => ArticleLifecycleTransitionWriter.PrepareEditableTransitionFromBulkRevisionAsync(
            null!, null!, fake, 1, DateTime.UnixEpoch, "source-control", ArticleStatusTransitionOperation.MoveToInbox,
            CancellationToken.None));
    }

    private static ArticleLifecycleTransitionWriter.BulkRevisionFacts Facts()
        => new(1, 7, 1, "10", "11", ArticleStatus.Archived, false, ArticleStatus.Draft, 3, null, null);
}
