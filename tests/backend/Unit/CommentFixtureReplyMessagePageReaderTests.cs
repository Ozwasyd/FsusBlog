using System.Globalization;

using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Shared.Contracts.Outputs;

using NSubstitute;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentFixtureReplyMessagePageReaderTests
{
    [Fact]
    public async Task ReadAsync_CompleteFirstPage_PreservesProductionMessages()
    {
        ConversationDetailResponse page = Page(false, null, 81, 83);
        IMessageQueryService queries = Queries(page);

        IReadOnlyList<ConversationMessageResponse>? result = await CommentFixtureReplyMessagePageReader.ReadAsync(queries, 12, 71);

        Assert.Equal(page.Messages, result);
        Assert.Same(page.Messages[0], result![0]);
        Assert.Equal("reply 81", result[0].Body);
        Assert.Single(queries.ReceivedCalls());
    }

    [Fact]
    public async Task ReadAsync_OlderPages_FollowsExactCursorsAndPreservesAccountConversationAndOrder()
    {
        ConversationDetailResponse newest = Page(true, "81", 81, 83);
        ConversationDetailResponse middle = Page(true, "51", 51, 53);
        ConversationDetailResponse oldest = Page(false, null, 11, 13);
        IMessageQueryService queries = Queries(newest, middle, oldest);
        using var cancellation = new CancellationTokenSource();

        IReadOnlyList<ConversationMessageResponse>? result = await CommentFixtureReplyMessagePageReader.ReadAsync(
            queries, 12, 71, cancellation.Token);

        Assert.NotNull(result);
        Assert.Equal(new[] { "11", "13", "51", "53", "81", "83" }, result.Select(message => message.MessageId));
        Assert.Same(oldest.Messages[0], result[0]);
        Assert.Same(newest.Messages[1], result[^1]);
        object?[][] arguments = queries.ReceivedCalls().Select(call => call.GetArguments()).ToArray();
        Assert.Equal(3, arguments.Length);
        Assert.Equal(new long?[] { null, 81, 51 }, arguments.Select(args => (long?)args[2]));
        Assert.All(arguments, args =>
        {
            Assert.Equal(12, args[0]);
            Assert.Equal(71L, args[1]);
            Assert.Equal(cancellation.Token, args[3]);
        });
    }

    [Fact]
    public async Task ReadAsync_UnavailableInitialProjection_ReturnsNull()
    {
        IMessageQueryService queries = Queries((ConversationDetailResponse?)null);

        Assert.Null(await CommentFixtureReplyMessagePageReader.ReadAsync(queries, 12, 71));
        Assert.Single(queries.ReceivedCalls());
    }

    [Fact]
    public async Task ReadAsync_MissingOrEmptyContinuation_RefusesPartialHistory()
    {
        foreach (ConversationDetailResponse? continuation in new ConversationDetailResponse?[] { null, Page(false, null) })
        {
            IMessageQueryService queries = Queries(Page(true, "81", 81, 83), continuation);

            await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(queries, 12, 71));
            Assert.Equal(2, queries.ReceivedCalls().Count());
        }
    }

    [Fact]
    public async Task ReadAsync_IncorrectPageOrMessageConversation_RefusesHistory()
    {
        ConversationDetailResponse wrongPage = Page(false, null, 11) with
        {
            ConversationId = "72"
        };
        ConversationDetailResponse wrongMessage = Page(false, null, 11) with
        {
            Messages = [Page(false, null, 11).Messages[0] with { ConversationId = "72" }]
        };
        foreach (ConversationDetailResponse invalid in new[] { wrongPage, wrongMessage })
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(Queries(invalid), 12, 71));
            await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
                Queries(Page(true, "81", 81), invalid), 12, 71));
        }
    }

    [Fact]
    public async Task ReadAsync_DuplicateMessageWithinOrAcrossPages_RefusesHistory()
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            Queries(Page(false, null, 81, 81)), 12, 71));
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            Queries(Page(true, "81", 81, 83), Page(false, null, 51, 81)), 12, 71));
    }

    [Fact]
    public async Task ReadAsync_InvalidCursorIdentityOrOrdering_RefusesHistory()
    {
        foreach (string? cursor in new string?[] { null, "", "invalid", "0", "-1", " 81", "+81", "081", "9223372036854775808", "80", "83" })
        {
            IMessageQueryService queries = Queries(Page(true, cursor, 81, 83));
            await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(queries, 12, 71));
            Assert.Single(queries.ReceivedCalls());
        }
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            Queries(Page(false, "81", 81)), 12, 71));
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            Queries(Page(false, null)), 12, 71));
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            Queries(Page(false, null, 83, 81)), 12, 71));
        await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            Queries(Page(true, "81", 81), Page(false, null, 82)), 12, 71));
        foreach (string messageId in new[] { "0", "-1", "081", "invalid", "9223372036854775808" })
        {
            ConversationDetailResponse invalid = Page(false, null, 81) with
            {
                Messages = [Page(false, null, 81).Messages[0] with { MessageId = messageId }]
            };
            await Assert.ThrowsAsync<InvalidOperationException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(Queries(invalid), 12, 71));
        }
    }

    [Fact]
    public async Task ReadAsync_CancellationBeforeOrDuringQuery_StopsReading()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        IMessageQueryService queries = Queries(Page(false, null, 81));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            queries, 12, 71, cancellation.Token));
        Assert.Empty(queries.ReceivedCalls());

        using var duringQuery = new CancellationTokenSource();
        queries.GetAccountConversationDetailAsync(12, 71, null, duringQuery.Token).Returns(_ =>
        {
            duringQuery.Cancel();
            return Page(true, "81", 81);
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CommentFixtureReplyMessagePageReader.ReadAsync(
            queries, 12, 71, duringQuery.Token));
        Assert.Single(queries.ReceivedCalls());
    }

    private static IMessageQueryService Queries(params ConversationDetailResponse?[] pages)
    {
        IMessageQueryService queries = Substitute.For<IMessageQueryService>();
        int pageIndex = 0;
        queries.GetAccountConversationDetailAsync(Arg.Any<int>(), Arg.Any<long>(), Arg.Any<long?>(), Arg.Any<CancellationToken>())
            .Returns(_ => pages[pageIndex++]);
        return queries;
    }

    private static ConversationDetailResponse Page(bool hasOlder, string? cursor, params long[] messageIds)
        => new()
        {
            ConversationId = "71",
            HasOlder = hasOlder,
            PreviousCursor = cursor,
            Messages = messageIds.Select(id => new ConversationMessageResponse
            {
                MessageId = id.ToString(CultureInfo.InvariantCulture),
                ConversationId = "71",
                SenderType = ConversationSenderValue.System,
                Body = $"reply {id.ToString(CultureInfo.InvariantCulture)}",
                CreatedAt = new DateTime(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc)
            }).ToList()
        };
}
