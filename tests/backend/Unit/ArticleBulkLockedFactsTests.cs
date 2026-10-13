using System.Collections.Immutable;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

// Ordinary source controls only: no native/auth/group/runtime qualification is claimed.
public sealed class ArticleBulkLockedFactsTests
{
    [Fact]
    public async Task MissingDocumentProducerCannotReturnAWholeSetReservation()
    {
        var owner = new ArticleBulkEditableLifecycleGroupAuthority(null!, null!, null!, null!, null!);
        Assert.Equal(0, owner.MaximumAtomicItems);
        var failure = await Assert.ThrowsAsync<ArticleBulkContractException>(() => owner.ReserveAsync(null!, CancellationToken.None));
        Assert.Equal("article-bulk.locked-facts.document-editor-admission-authority-unavailable", failure.Message);
    }

    [Fact]
    public async Task CancelledReserveWaitCannotCreateAReservation()
    {
        var owner = new ArticleBulkEditableLifecycleGroupAuthority(null!, null!, null!, null!, null!);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owner.ReserveAsync(null!, cancellation.Token));
    }

    [Fact]
    public async Task DuplicateFrozenArticlesRefuseBeforeAnyNativeRead()
    {
        string reference = "article-bulk-revision.v1:sha256:" + new string('0', 64);
        var failure = await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            ArticleLifecycleTransitionWriter.ReadLockedBulkRevisionSetAsync(null!, null!,
                [(2, reference), (2, reference)], CancellationToken.None));
        Assert.Equal("article_bulk_revision_frozen_set_invalid", failure.Code);
    }

    [Fact]
    public async Task NumericExpectedRevisionIsNotAnOriginalRowReference()
    {
        var failure = await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            ArticleLifecycleTransitionWriter.ReadLockedBulkRevisionSetAsync(null!, null!, [(2, "7")], CancellationToken.None));
        Assert.Equal("article_bulk_revision_reference_invalid", failure.Code);
    }

    [Fact]
    public async Task EmptyFrozenSetCannotBecomeAReadyScope()
    {
        var failure = await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            ArticleLifecycleTransitionWriter.ReadLockedBulkRevisionSetAsync(null!, null!,
                ImmutableArray<(int, string)>.Empty, CancellationToken.None));
        Assert.Equal("article_bulk_revision_frozen_set_invalid", failure.Code);
    }

    [Fact]
    public async Task FabricatedDraftReservationHasNoSnapshotCustody()
    {
        var drafts = new AuthoringDraftLifecycleService(null!, null!, null!, null!);
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(() => drafts.ReadLockedBulkDraftFactsAsync(
            new AuthoringDraftLifecycleService.BulkDraftReservation(), null!, null!, null!, null!, CancellationToken.None));
        Assert.Equal("article_bulk_draft_reservation_unavailable", failure.Message);
    }
}
