using System.Collections;
using System.Data;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class GraphNativeMetadataCaptureTests
{
    [Theory]
    [InlineData("title")]
    [InlineData("status")]
    public async Task TwoPassFactsRejectTitleAndStatusDrift(string field)
    {
        int rowReads = 0;
        var permission = Substitute.For<IAuthorArticlePinPermissionProjectionProvider>();
        permission.ResolveAsync(Arg.Any<AuthorArticlePinPermissionBatchRequest>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                var request = call.Arg<AuthorArticlePinPermissionBatchRequest>();
                var snapshot = new AuthorArticlePinPermissionSnapshot(AuthorArticlePinPermissionSnapshotStatus.Current,
                    request.Owner, "permission:1", "site:1", "session:1",
                    request.ArticleIds.Select(static id => new AuthorArticlePinPermissionDecision(id, true, true, "permission:1")).ToArray(), "");
                return snapshot with
                {
                    ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
                };
            });
        int probe = 0;
        var reader = new SqlArticleGraphPersistedMetadataReader(permission,
            _ => Task.FromResult(new SqlArticleGraphPersistedMetadataReader.SessionStamp(1, (++probe).ToString(),
                IsolationLevel.ReadCommitted, false, false)),
            (_, _, _) => Task.FromResult(new[] { new SqlArticleGraphPersistedMetadataReader.Row(1,
                ++rowReads == 2 && field == "status" ? ArticleStatus.Archived : ArticleStatus.Draft,
                false, 1, 1, null, null, null, null, null, 1, 1, 7, "9",
                rowReads == 2 && field == "title" ? "changed" : "current title") }),
            (_, _) => Task.FromResult(new[] { new ArticleRelationRevisionCoordinate(1, 1, 1,
                "article:11111111-1111-4111-8111-111111111111", "revision:22222222-2222-4222-8222-222222222222", Guid.Parse("33333333-3333-4333-8333-333333333333")) }));
        Assert.Null(await reader.ReadAsync(Request([new(1, "article:11111111-1111-4111-8111-111111111111")])));
        Assert.Equal(2, rowReads);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CandidateGetterCancellationWinsBeforeAnyProbe(bool index)
    {
        using var cancellation = new CancellationTokenSource();
        var reader = new SqlArticleGraphPersistedMetadataReader(
            Substitute.For<IAuthorArticlePinPermissionProjectionProvider>(),
            _ => throw new InvalidOperationException("No probe may run."),
            (_, _, _) => throw new InvalidOperationException("No rows may run."),
            (_, _) => throw new InvalidOperationException("No coordinates may run."));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadAsync(
            Request(new CancellingCandidates(cancellation, index)), cancellation.Token));
    }

    private static ArticleGraphPersistedMetadataRequest Request(IReadOnlyList<ArticleRelationArticleCoordinate> candidates)
        => new(new(1, "primary-site"), Guid.NewGuid(), candidates, ArticleGraphMetadataSelection.Current, 26, 250);

    private sealed class CancellingCandidates(CancellationTokenSource cancellation, bool atIndex)
        : IReadOnlyList<ArticleRelationArticleCoordinate>
    {
        public int Count
        {
            get
            {
                if (!atIndex)
                {
                    cancellation.Cancel();
                    return int.MaxValue;
                }
                return 1;
            }
        }
        public ArticleRelationArticleCoordinate this[int index]
        {
            get
            {
                cancellation.Cancel();
                return new(-1, "invalid");
            }
        }
        public IEnumerator<ArticleRelationArticleCoordinate> GetEnumerator() => throw new InvalidOperationException("Do not enumerate.");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
