using System.Globalization;

using FsusBlog.Server.Entities;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class MessageCenterQueryPlanIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const int AccountId = 42;
    private const int ConversationCount = 128;
    private const int MessagesPerConversation = 8;

    [Fact]
    public async Task FixedDatasetHotQueriesExposeAnalyzeAndBufferEvidence()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(MessageConversation),
            typeof(ConversationMessage),
            typeof(ConversationParticipantState),
            typeof(AdminConversationQueueState));

        DateTime epoch = new(2026, 7, 20, 0, 0, 0, DateTimeKind.Utc);
        var conversations = new List<MessageConversation>(ConversationCount);
        var messages = new List<ConversationMessage>(ConversationCount * MessagesPerConversation);
        var participants = new List<ConversationParticipantState>(ConversationCount);
        var adminStates = new List<AdminConversationQueueState>(ConversationCount);
        long nextMessageId = 10_000;
        for (int index = 0; index < ConversationCount; index++)
        {
            long conversationId = 1_000 + index;
            DateTime createdAt = epoch.AddMinutes(index);
            long firstMessageId = nextMessageId;
            for (int messageIndex = 0; messageIndex < MessagesPerConversation; messageIndex++)
            {
                messages.Add(new ConversationMessage
                {
                    Id = nextMessageId++,
                    ConversationId = conversationId,
                    SenderType = messageIndex % 2 == 0 ? MessageSenderType.Account : MessageSenderType.Admin,
                    SenderAccountId = messageIndex % 2 == 0 ? AccountId : null,
                    SenderAdminPrincipalId = messageIndex % 2 == 0 ? null : 7,
                    SenderAdminSessionAuditReference = messageIndex % 2 == 0 ? null : "fixture-admin",
                    Body = $"fixture-{index.ToString(CultureInfo.InvariantCulture)}-{messageIndex.ToString(CultureInfo.InvariantCulture)}",
                    IsInternalNote = false,
                    CreatedAt = createdAt.AddSeconds(messageIndex)
                });
            }

            long lastMessageId = nextMessageId - 1;
            conversations.Add(new MessageConversation
            {
                Id = conversationId,
                Subject = $"fixture conversation {index.ToString(CultureInfo.InvariantCulture)}",
                InitiatorAccountId = AccountId,
                Status = index % 3 == 0 ? ConversationStatus.Pending : ConversationStatus.Open,
                IsSystemSource = false,
                CreatedByType = MessageSenderType.Account,
                CreatedByAccountId = AccountId,
                CreatedAt = createdAt,
                UpdatedAt = createdAt.AddSeconds(MessagesPerConversation - 1),
                LastMessageAt = createdAt.AddSeconds(MessagesPerConversation - 1)
            });
            participants.Add(new ConversationParticipantState
            {
                ConversationId = conversationId,
                AccountId = AccountId,
                LastReadMessageId = firstMessageId,
                UnreadCount = index % 5,
                LastReadAt = createdAt,
                UpdatedAt = createdAt.AddSeconds(MessagesPerConversation - 1)
            });
            adminStates.Add(new AdminConversationQueueState
            {
                ConversationId = conversationId,
                LastReadMessageId = firstMessageId,
                UnreadCount = index % 4,
                LastReadAt = createdAt,
                Version = 1,
                UpdatedAt = createdAt.AddSeconds(MessagesPerConversation - 1)
            });
        }

        await db.Insertable(conversations).ExecuteCommandAsync();
        await db.Insertable(messages).ExecuteCommandAsync();
        await db.Insertable(participants).ExecuteCommandAsync();
        await db.Insertable(adminStates).ExecuteCommandAsync();

        string connectionString = db.CurrentConnectionConfig.ConnectionString;
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();

        long snapshotMessageId = messages[^1].Id;
        long detailConversationId = conversations[ConversationCount / 2].Id;
        long[] previewConversationIds = conversations.Take(20).Select(static item => item.Id).ToArray();

        string listPlan = await ExplainAsync(
            connection,
            """
            SELECT conversation.id AS conversationid,
                   conversation.subject,
                   conversation.status,
                   conversation.issystemsource,
                   participant.unreadcount,
                   latest.createdat AS lastmessageat,
                   conversation.updatedat
            FROM msg_conversation conversation
            JOIN msg_participant_state participant
              ON participant.conversationid = conversation.id
            JOIN LATERAL (
                SELECT message.id,
                       message.createdat
                FROM msg_message message
                WHERE message.conversationid = conversation.id
                  AND message.id <= @SnapshotMessageId
                  AND message.isinternalnote = false
                ORDER BY message.id DESC
                LIMIT 1
            ) latest ON true
            WHERE participant.accountid = @AccountId
            ORDER BY latest.createdat DESC,
                     conversation.id DESC
            LIMIT @Take;
            """,
            new NpgsqlParameter<long>("SnapshotMessageId", snapshotMessageId),
            new NpgsqlParameter<int>("AccountId", AccountId),
            new NpgsqlParameter<int>("Take", 21));

        string detailPlan = await ExplainAsync(
            connection,
            """
            SELECT id,
                   conversationid,
                   sendertype,
                   senderaccountid,
                   senderadminprincipalid,
                   senderadminsessionauditreference,
                   body,
                   isinternalnote,
                   createdat
            FROM msg_message
            WHERE conversationid = @ConversationId
              AND isinternalnote = false
            ORDER BY id DESC
            LIMIT @Take;
            """,
            new NpgsqlParameter<long>("ConversationId", detailConversationId),
            new NpgsqlParameter<int>("Take", 51));

        string unreadPlan = await ExplainAsync(
            connection,
            """
            SELECT COALESCE(SUM(unreadcount), 0)::integer
            FROM msg_participant_state
            WHERE accountid = @AccountId;
            """,
            new NpgsqlParameter<int>("AccountId", AccountId));

        string lastMessagePlan = await ExplainAsync(
            connection,
            """
            SELECT DISTINCT ON (conversationid)
                   id,
                   conversationid,
                   sendertype,
                   senderaccountid,
                   senderadminprincipalid,
                   senderadminsessionauditreference,
                   body,
                   isinternalnote,
                   createdat
            FROM msg_message
            WHERE conversationid = ANY(@ConversationIds)
              AND isinternalnote = false
              AND id <= @SnapshotMessageId
            ORDER BY conversationid, id DESC;
            """,
            new NpgsqlParameter<long[]>("ConversationIds", previewConversationIds),
            new NpgsqlParameter<long>("SnapshotMessageId", snapshotMessageId));

        AssertPlanEvidence(listPlan, "msg_conversation", "msg_participant_state", "msg_message");
        AssertPlanEvidence(detailPlan, "msg_message");
        AssertPlanEvidence(unreadPlan, "msg_participant_state");
        AssertPlanEvidence(lastMessagePlan, "msg_message");
    }

    private static async Task<string> ExplainAsync(
        NpgsqlConnection connection,
        string query,
        params NpgsqlParameter[] parameters)
    {
        await using var command = new NpgsqlCommand(
            $"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {query}",
            connection);
        command.Parameters.AddRange(parameters);
        object? raw = await command.ExecuteScalarAsync();
        return Convert.ToString(raw, CultureInfo.InvariantCulture) ?? string.Empty;
    }

    private static void AssertPlanEvidence(string plan, params string[] relations)
    {
        Assert.Contains("Execution Time", plan, StringComparison.Ordinal);
        Assert.Contains("Planning Time", plan, StringComparison.Ordinal);
        Assert.Contains("Shared Hit Blocks", plan, StringComparison.Ordinal);
        Assert.Contains("Actual Rows", plan, StringComparison.Ordinal);
        foreach (string relation in relations)
        {
            Assert.Contains(relation, plan, StringComparison.Ordinal);
        }
    }
}
