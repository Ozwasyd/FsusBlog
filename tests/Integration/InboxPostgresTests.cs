using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Communication;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class InboxPostgresTests
{
    [PostgresFact]
    public async Task MessageMutationReadPositionAndPrivateReplayAreAtomic()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var alice = await AddUser(db.DataSource, "alice", ct);
        var bob = await AddUser(db.DataSource, "bob", ct);

        var ticket = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ =>
            InTransaction(db.DataSource, alice, inbox => inbox.CreateAsync("ticket:1", "Support", "A ticket", ct), ct)));
        Assert.Single(ticket, result => !result.Replayed);
        var opening = ticket[0].Message;
        Assert.All(ticket, item => Assert.Equal(opening, item.Message));

        var notice = await InTransaction(db.DataSource, alice, inbox => inbox.SendNoticeAsync("ticket:1", "Notice", "For Alice", ct), ct);
        var repeat = await InTransaction(db.DataSource, alice, inbox => inbox.SendNoticeAsync("ticket:1", "Notice", "For Alice", ct), ct);
        Assert.True(repeat.Replayed);
        Assert.Equal(notice.Message, repeat.Message);

        var unread = await InTransaction(db.DataSource, alice, inbox => inbox.ListAsync(null, 20, "unread", ct), ct);
        Assert.Equal(notice.Message.ConversationId, Assert.Single(unread.Conversations).Id);
        Assert.Equal(1, unread.Total);
        Assert.Empty((await InTransaction(db.DataSource, bob, inbox => inbox.ListAsync(null, 20, null, ct), ct)).Conversations);
        Assert.Null(await InTransaction(db.DataSource, bob, inbox => inbox.GetAsync(opening.ConversationId, null, 50, ct), ct));

        var invalidRead = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, alice,
            inbox => inbox.MarkReadAsync(opening.ConversationId, notice.Message.Id, ct), ct));
        Assert.Equal(Rejection.Invalid, invalidRead.Rejection);
        var wrongAccount = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, bob,
            inbox => inbox.MarkReadAsync(opening.ConversationId, opening.Id, ct), ct));
        Assert.Equal(Rejection.NotFound, wrongAccount.Rejection);
        var internalId = await AddInternalMessage(db.DataSource, opening.ConversationId, ct);
        var internalRead = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, alice,
            inbox => inbox.MarkReadAsync(opening.ConversationId, internalId, ct), ct));
        Assert.Equal(Rejection.Invalid, internalRead.Rejection);

        var reply = await InTransaction(db.DataSource, alice, inbox => inbox.ReplyAsync(opening.ConversationId, opening.Id, "reply-1", "Follow up", ct), ct);
        var conflicting = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, alice,
            inbox => inbox.ReplyAsync(opening.ConversationId, opening.Id, "reply-1", "Other text", ct), ct));
        Assert.Equal(Rejection.Conflict, conflicting.Rejection);
        var current = await InTransaction(db.DataSource, alice, inbox => inbox.GetAsync(opening.ConversationId, null, 50, ct), ct);
        Assert.NotNull(current);
        Assert.Equal([opening.Id, reply.Message.Id], current.Messages.Select(message => message.Id));

        var read = await InTransaction(db.DataSource, alice, inbox => inbox.MarkReadAsync(notice.Message.ConversationId, notice.Message.Id, ct), ct);
        Assert.Equal(0, read.UnreadCount);
        var first = await InTransaction(db.DataSource, alice, inbox => inbox.ReplayAsync(0, 2, ct), ct);
        Assert.True(first.HasMore);
        Assert.Equal([1L, 2L], first.Events.Select(item => item.Sequence));
        var second = await InTransaction(db.DataSource, alice, inbox => inbox.ReplayAsync(first.Next, 20, ct), ct);
        Assert.False(second.HasMore);
        Assert.False(second.RequiresResync);
        Assert.Equal(InboxEventKind.ReadUpdated, second.Events[^1].Kind);
        Assert.DoesNotContain(first.Events.Concat(second.Events), item => item.MessageId == internalId);
        Assert.Empty((await InTransaction(db.DataSource, bob, inbox => inbox.ReplayAsync(0, 20, ct), ct)).Events);
        Assert.True((await InTransaction(db.DataSource, bob, inbox => inbox.ReplayAsync(second.Next, 20, ct), ct)).RequiresResync);

        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        await using (var transaction = await connection.BeginTransactionAsync(ct))
        {
            await new InboxStore(connection, transaction, alice).SendNoticeAsync("rollback", "Temporary", "Rollback me", ct);
            await transaction.RollbackAsync(ct);
        }
        var afterRollback = await InTransaction(db.DataSource, alice, inbox => inbox.ReplayAsync(second.Next, 20, ct), ct);
        Assert.Empty(afterRollback.Events);
        Assert.Equal(second.Next, afterRollback.Next);
    }

    [PostgresFact]
    public async Task FirstListPageFreezesMessageVisibilityAcrossNewActivity()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var user = await AddUser(db.DataSource, "reader", ct);
        var older = await InTransaction(db.DataSource, user, inbox => inbox.CreateAsync("older", "First", "Old preview", ct), ct);
        var newer = await InTransaction(db.DataSource, user, inbox => inbox.CreateAsync("newer", "Second", "New preview", ct), ct);
        var first = await InTransaction(db.DataSource, user, inbox => inbox.ListAsync(null, 1, null, ct), ct);
        Assert.Equal(newer.Message.ConversationId, Assert.Single(first.Conversations).Id);
        Assert.NotNull(first.Next);

        var reply = await InTransaction(db.DataSource, user, inbox =>
            inbox.ReplyAsync(older.Message.ConversationId, older.Message.Id, "recent", "Future preview", ct), ct);
        var second = await InTransaction(db.DataSource, user, inbox => inbox.ListAsync(first.Next, 1, null, ct), ct);
        Assert.Equal(2, second.Total);
        var oldPreview = Assert.Single(second.Conversations);
        Assert.Equal(older.Message.ConversationId, oldPreview.Id);
        Assert.Equal("Old preview", oldPreview.Preview);

        var delta = await InTransaction(db.DataSource, user, inbox => inbox.DeltaAsync(older.Message.ConversationId, older.Message.Id, 50, ct), ct);
        Assert.NotNull(delta);
        Assert.Equal(reply.Message, Assert.Single(delta.Messages));
    }

    private static async Task<T> InTransaction<T>(NpgsqlDataSource data, Guid user,
        Func<InboxStore, Task<T>> operation, CancellationToken ct)
    {
        await using var connection = await data.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        var result = await operation(new InboxStore(connection, transaction, user));
        await transaction.CommitAsync(ct);
        return result;
    }

    private static async Task<Guid> AddUser(NpgsqlDataSource data, string name, CancellationToken ct)
    {
        var user = Guid.NewGuid();
        await using var insert = data.CreateCommand("INSERT INTO public.blog_user VALUES ($1, $2, false, true, 1)");
        insert.Parameters.AddWithValue(user);
        insert.Parameters.AddWithValue(name);
        await insert.ExecuteNonQueryAsync(ct);
        return user;
    }

    private static async Task<long> AddInternalMessage(NpgsqlDataSource data, long conversation, CancellationToken ct)
    {
        await using var insert = data.CreateCommand("""
            INSERT INTO public.inbox_message (conversation_id, sender, is_internal, body, sent_at)
            VALUES ($1, 1, true, 'Internal staff note', clock_timestamp()) RETURNING id
            """);
        insert.Parameters.AddWithValue(conversation);
        return (long)(await insert.ExecuteScalarAsync(ct))!;
    }
}
