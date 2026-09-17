using System.Reflection;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MessageSchemaContractTests
{
    private const string LegacyMessagingSplitChecksum = "C5F517F66C0B90F8A9FB5CAFD945CAD357C8861B6D56FCE9F7AE95B0B8BD1602";

    [Fact]
    public void RuntimeModel_RemovesUnusedMessageFieldsAndCategory()
    {
        Assert.Null(typeof(ConversationMessage).GetProperty("AttachmentsMeta"));
        Assert.Null(typeof(ConversationParticipantState).GetProperty("Muted"));
        Assert.DoesNotContain(
            typeof(MessageConversation).Assembly.GetTypes(),
            static type => type.FullName == "FsusBlog.Server.Entities.MessageCategory");

        Assert.NotNull(typeof(ConversationMessage).GetProperty(nameof(ConversationMessage.IsInternalNote)));
        Assert.NotNull(typeof(MessageConversation).GetProperty(nameof(MessageConversation.SourceMessageId)));
        Assert.Contains(
            typeof(MessageConversation).GetCustomAttributes<SugarIndexAttribute>(),
            static index => index.IndexName == "ux_msg_conversation_source_message" && index.IsUnique);

        string retentionRuntime = RuntimeMetadataInspection.DescribeType(typeof(MessageRetentionCleanupService));
        Assert.DoesNotContain("AttachmentsMeta", retentionRuntime, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void HistoricalBackfill_StopsWritingDeadFieldsWithoutInvalidatingAppliedChecksum()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == "20260418-post-messaging-split");
        string migration = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.DoesNotContain("attachmentsmeta", migration, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("muted", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("isinternalnote", migration, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(LegacyMessagingSplitChecksum, descriptor.AcceptedChecksums);
    }

    [Fact]
    public void InternalNote_IsServerOnlyVisibilityPaginationAndUnreadBoundary()
    {
        string queryRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.GetAccountConversationDetailAsync),
            nameof(MessageCenterService.GetAccountConversationDeltaAsync));
        string unreadRuntime = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(MessageCenterService),
            "message.isinternalnote = false");

        Assert.Contains("ConversationMessage.get_IsInternalNote", queryRuntime, StringComparison.Ordinal);
        Assert.Contains("ConversationMessage.get_Id", queryRuntime, StringComparison.Ordinal);
        Assert.Contains("message.isinternalnote = false", unreadRuntime, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void SourceMessageId_HasExplicitReplayConflictAndUniqueMigrationGuard()
    {
        string commandRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(MessageCenterService),
            nameof(MessageCenterService.SendSystemMessageAsync));
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == "20260719-post-message-mutation-idempotency");
        string migration = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("MessageConversation.get_SourceMessageId", commandRuntime, StringComparison.Ordinal);
        Assert.Contains("MessageConversation.set_SourceMessageId", commandRuntime, StringComparison.Ordinal);
        Assert.Contains("Replay", commandRuntime, StringComparison.Ordinal);
        Assert.Contains("Conflict", commandRuntime, StringComparison.Ordinal);
        Assert.Contains("ux_msg_conversation_source_message", migration, StringComparison.Ordinal);
        Assert.Contains("UNIQUE INDEX", migration, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AedsMessageContracts_DoNotExposePersistenceOnlyFields()
    {
        Type[] contractTypes =
        [
            typeof(ConversationListItemResponse),
            typeof(AdminConversationListItemResponse),
            typeof(ConversationMessagePreviewResponse),
            typeof(ConversationMessageResponse),
            typeof(ConversationDetailResponse),
            typeof(AdminConversationDetailResponse)
        ];
        string[] persistenceOnlyNames =
        [
            "AttachmentsMeta",
            "Muted",
            "IsInternalNote",
            "SourceMessageId",
            "MessageCategory"
        ];

        Assert.All(
            contractTypes,
            type => Assert.DoesNotContain(
                type.GetProperties(BindingFlags.Instance | BindingFlags.Public),
                property => persistenceOnlyNames.Contains(property.Name, StringComparer.Ordinal)));

        var response = new ConversationMessageResponse
        {
            MessageId = "17",
            ConversationId = "9",
            SenderType = ConversationSenderValue.Admin,
            SenderName = "admin",
            Body = "visible payload",
            CreatedAt = new DateTime(2026, 7, 21, 1, 2, 3, DateTimeKind.Utc),
            IdempotencyReplay = true
        };
        byte[] payload = PodBinaryCodec.EncodeConversationMessage(response);

        Assert.True(PodBinaryCodec.TryDecodeConversationMessage(payload, out ConversationMessageResponse decoded));
        Assert.Equal(response.MessageId, decoded.MessageId);
        Assert.Equal(response.ConversationId, decoded.ConversationId);
        Assert.Equal(response.Body, decoded.Body);
        Assert.True(decoded.IdempotencyReplay);
        Assert.All(
            persistenceOnlyNames,
            name => Assert.DoesNotContain(name, RuntimeMetadataInspection.DescribeType(typeof(ConversationMessageResponse)), StringComparison.Ordinal));
    }
}
