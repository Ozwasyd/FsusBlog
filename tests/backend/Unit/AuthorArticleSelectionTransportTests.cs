using FsusBlog.Contracts.AuthoringNavigation;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorArticleSelectionTransportTests
{
    private static AuthorArticleSelectionRevalidationRequest Request()
        => new(1, 27, long.MaxValue, Guid.Parse("018f1ce7-093a-7a01-bbcc-123456789abc"), new string('a', 64));

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task UsesOnlyExistingFacade_AndPreservesCoordinatesOwnerTokenAndCancellation(bool current)
    {
        var request = Request();
        var facade = Substitute.For<IAuthorRecentArticleHistoryApplicationFacade>();
        using var cancellation = new CancellationTokenSource();
        facade.RevalidateSelectionAsync(27, long.MaxValue, request.PermissionToken, request.RequestId, cancellation.Token)
            .Returns(new AuthorArticleQuerySelectionRevalidationResult(current, new(long.MaxValue, "primary"),
                27, long.MaxValue, request.RequestId, current ? request.PermissionToken : null));
        var response = await new AuthorArticleSelectionRevalidationTransport(facade).RevalidateAsync(request, cancellation.Token);
        Assert.True(AuthorArticleSelectionRevalidationContract.MatchesRequest(request, response));
        Assert.Equal(current, response.Current);
        Assert.Equal(long.MaxValue, response.Owner.AdminPrincipalId);
        await facade.Received(1).RevalidateSelectionAsync(27, long.MaxValue, request.PermissionToken, request.RequestId, cancellation.Token);
        Assert.Single(facade.ReceivedCalls());
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("request")]
    [InlineData("token")]
    [InlineData("denial-token")]
    [InlineData("owner")]
    public async Task MalformedFacadeReply_IsNeverReleased(string fault)
    {
        var request = Request();
        var facade = Substitute.For<IAuthorRecentArticleHistoryApplicationFacade>();
        var result = new AuthorArticleQuerySelectionRevalidationResult(true, new(77, "primary"),
            27, long.MaxValue, request.RequestId, request.PermissionToken);
        result = fault switch
        {
            "article" => result with { ArticleId = 28 },
            "revision" => result with { ServerRevision = 1 },
            "request" => result with { RequestId = Guid.NewGuid() },
            "token" => result with { PermissionToken = new string('b', 64) },
            "denial-token" => result with { Current = false },
            _ => result with { Owner = new(0, "primary") }
        };
        facade.RevalidateSelectionAsync(27, long.MaxValue, request.PermissionToken, request.RequestId, CancellationToken.None).Returns(result);
        await Assert.ThrowsAsync<InvalidOperationException>(() => new AuthorArticleSelectionRevalidationTransport(facade)
            .RevalidateAsync(request, CancellationToken.None));
    }

    [Fact]
    public async Task PreCancelledAndLateCancelled_DoNotReturnAReply()
    {
        var request = Request();
        var facade = Substitute.For<IAuthorRecentArticleHistoryApplicationFacade>();
        var transport = new AuthorArticleSelectionRevalidationTransport(facade);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => transport.RevalidateAsync(request, cancelled.Token));
        Assert.Empty(facade.ReceivedCalls());
        using var late = new CancellationTokenSource();
        facade.RevalidateSelectionAsync(27, long.MaxValue, request.PermissionToken, request.RequestId, late.Token).Returns(_ =>
        {
            late.Cancel();
            return new AuthorArticleQuerySelectionRevalidationResult(true, new(77, "primary"), 27,
                long.MaxValue, request.RequestId, request.PermissionToken);
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => transport.RevalidateAsync(request, late.Token));
    }
}
