using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class MessageRetentionCleanupIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_now = new(2026, 7, 19, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task CleanupAsync_AppliesRetentionAccountErasureAndIdempotencyWithoutDroppingAuditReferences()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState));
        DateTime now = s_now.UtcDateTime;
        int deletedAccountId = await db.Insertable(
            new User { Status = 2, DeletedAt = now.AddDays(-1), CreateTime = now.AddYears(-1) })
            .ExecuteReturnIdentityAsync();
        int activeAccountId = await db.Insertable(
            new User { Status = 0, CreateTime = now.AddYears(-1) })
            .ExecuteReturnIdentityAsync();
        await db.Insertable(new[]
        {
            Conversation(100, "deleted account recent", ConversationStatus.Open, false, now.AddDays(-1), deletedAccountId),
            Conversation(200, "sensitive governance reason", ConversationStatus.Open, true, now.AddDays(-91), null),
            Conversation(300, "closed private thread", ConversationStatus.Closed, false, now.AddDays(-181), activeAccountId),
            Conversation(400, "stale open thread", ConversationStatus.Open, false, now.AddDays(-366), activeAccountId),
            Conversation(500, "current thread", ConversationStatus.Open, false, now.AddDays(-1), activeAccountId)
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            AccountMessage(1001, 100, deletedAccountId, "deleted account original"),
            AdminMessage(2001, 200, 44, "audit-system", "ban reason and comment excerpt", now.AddDays(-91)),
            AdminMessage(3001, 300, 44, "audit-closed", "closed original", now.AddDays(-181)),
            AdminMessage(4001, 400, 44, "audit-open", "open original", now.AddDays(-366)),
            AdminMessage(5001, 500, 44, "audit-current", "current original", now.AddDays(-1))
        }).ExecuteCommandAsync();
        await db.Insertable(new ConversationParticipantState
        {
            ConversationId = 100,
            AccountId = deletedAccountId,
            UnreadCount = 1,
            UpdatedAt = now
        }).ExecuteCommandAsync();

        var service = new MessageRetentionCleanupService(
            db,
            new FixedTimeProvider(s_now),
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                [MessageRetentionCleanupService.RuntimeGate] = "true"
            }).Build(),
            NullLogger<MessageRetentionCleanupService>.Instance);
        MessageRetentionCleanupResult first = await service.CleanupAsync();
        MessageRetentionCleanupResult second = await service.CleanupAsync();

        Assert.Equal(new MessageRetentionCleanupResult(1, 1, 1, 3, 3), first);
        Assert.Equal(0, second.ChangedRows);
        ConversationMessage deleted = await db.Queryable<ConversationMessage>().InSingleAsync(1001);
        Assert.Equal("[account-deleted]", deleted.Body);
        Assert.Null(deleted.SenderAccountId);
        Assert.Equal("account_deleted", deleted.ContentRedactionReason);
        MessageConversation deletedConversation = await db.Queryable<MessageConversation>().InSingleAsync(100);
        Assert.Null(deletedConversation.InitiatorAccountId);
        Assert.Equal("[account-deleted]", deletedConversation.Subject);
        Assert.Equal("account_deleted", deletedConversation.ContentRedactionReason);
        Assert.Equal(0, await db.Queryable<ConversationParticipantState>().Where(row => row.AccountId == deletedAccountId).CountAsync());

        foreach (long messageId in new long[] { 2001, 3001, 4001 })
        {
            ConversationMessage expired = await db.Queryable<ConversationMessage>().InSingleAsync(messageId);
            Assert.Equal("[retention-expired]", expired.Body);
            Assert.Equal(44, expired.SenderAdminPrincipalId);
            Assert.StartsWith("audit-", expired.SenderAdminSessionAuditReference, StringComparison.Ordinal);
        }
        Assert.Equal("[retention-expired]", (await db.Queryable<MessageConversation>().InSingleAsync(200)).Subject);
        Assert.Equal("[retention-expired]", (await db.Queryable<MessageConversation>().InSingleAsync(300)).Subject);
        Assert.Equal("[retention-expired]", (await db.Queryable<MessageConversation>().InSingleAsync(400)).Subject);
        Assert.Equal("current original", (await db.Queryable<ConversationMessage>().InSingleAsync(5001)).Body);
    }

    private static MessageConversation Conversation(
        long id,
        string subject,
        ConversationStatus status,
        bool system,
        DateTime activity,
        int? accountId)
        => new()
        {
            Id = id,
            Subject = subject,
            Status = status,
            IsSystemSource = system,
            InitiatorAccountId = accountId,
            CreatedByType = accountId.HasValue ? MessageSenderType.Account : MessageSenderType.System,
            CreatedByAccountId = accountId,
            CreatedAt = activity,
            UpdatedAt = activity,
            LastMessageAt = activity
        };

    private static ConversationMessage AccountMessage(long id, long conversationId, int accountId, string body)
        => new()
        {
            Id = id,
            ConversationId = conversationId,
            SenderType = MessageSenderType.Account,
            SenderAccountId = accountId,
            Body = body,
            CreatedAt = s_now.UtcDateTime.AddDays(-1)
        };

    private static ConversationMessage AdminMessage(
        long id,
        long conversationId,
        long principalId,
        string auditReference,
        string body,
        DateTime createdAt)
        => new()
        {
            Id = id,
            ConversationId = conversationId,
            SenderType = MessageSenderType.Admin,
            SenderAdminPrincipalId = principalId,
            SenderAdminSessionAuditReference = auditReference,
            Body = body,
            CreatedAt = createdAt
        };

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
