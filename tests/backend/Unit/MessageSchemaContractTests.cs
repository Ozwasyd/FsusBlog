using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
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

        string retentionSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src", "backend", "Services", "Background", "MessageRetentionCleanupService.cs"));
        Assert.DoesNotContain("attachmentsmeta", retentionSource, StringComparison.OrdinalIgnoreCase);
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
        string querySource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src", "backend", "Services", "NotificationStream", "MessageCenterService.ConversationQuery.cs"));
        string unreadSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src", "backend", "Services", "NotificationStream", "MessageCenterService.cs"));

        Assert.Contains("!it.IsInternalNote", querySource, StringComparison.Ordinal);
        Assert.Contains("!it.IsInternalNote && it.Id > afterMessageId", querySource, StringComparison.Ordinal);
        Assert.Contains("!it.IsInternalNote", unreadSource, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceMessageId_HasExplicitReplayConflictAndUniqueMigrationGuard()
    {
        string commandSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src", "backend", "Services", "NotificationStream", "MessageCenterService.MessageCommand.cs"));
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == "20260719-post-message-mutation-idempotency");
        string migration = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("item.SourceMessageId == sourceEventId", commandSource, StringComparison.Ordinal);
        Assert.Contains("SourceMessageId = sourceEventId", commandSource, StringComparison.Ordinal);
        Assert.Contains("MutationReplayState.Replay", commandSource, StringComparison.Ordinal);
        Assert.Contains("MutationReplayState.Conflict", commandSource, StringComparison.Ordinal);
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

        string codecSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src", "core", "Cache", "PodBinaryCodec.Message.cs"));
        Assert.All(
            persistenceOnlyNames,
            name => Assert.DoesNotContain(name, codecSource, StringComparison.Ordinal));
    }
}
