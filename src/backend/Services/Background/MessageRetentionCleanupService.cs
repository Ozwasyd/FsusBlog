using FsusBlog.Server.Infrastructure.Operations;

using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public readonly record struct MessageRetentionCleanupResult(
    int AccountMessagesAnonymized,
    int AccountConversationsAnonymized,
    int ParticipantRowsRemoved,
    int ExpiredMessagesRedacted,
    int ExpiredConversationsRedacted)
{
    public int ChangedRows => AccountMessagesAnonymized
        + AccountConversationsAnonymized
        + ParticipantRowsRemoved
        + ExpiredMessagesRedacted
        + ExpiredConversationsRedacted;
}

public sealed class MessageRetentionCleanupService(
    ISqlSugarClient db,
    TimeProvider timeProvider,
    IConfiguration configuration,
    ILogger<MessageRetentionCleanupService> logger,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null,
    IActiveReleaseTransactionalCommitGuard? transactionalCommitGuard = null)
{
    public const int OpenConversationRetentionDays = 365;
    public const int ClosedConversationRetentionDays = 180;
    public const int SystemGovernanceRetentionDays = 90;
    public const string RuntimeGate = "Messages:RetentionCleanupEnabled";

    public async Task<MessageRetentionCleanupResult> CleanupAsync(CancellationToken cancellationToken = default)
    {
        if (!configuration.GetValue(RuntimeGate, true))
        {
            return default;
        }

        if (activeReleaseCommitGuard is not null)
        {
            await activeReleaseCommitGuard.EnsureCurrentAsync(cancellationToken).ConfigureAwait(false);
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        DateTime openCutoff = now.AddDays(-OpenConversationRetentionDays);
        DateTime closedCutoff = now.AddDays(-ClosedConversationRetentionDays);
        DateTime systemCutoff = now.AddDays(-SystemGovernanceRetentionDays);
        MessageRetentionCleanupResult result = default;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            int accountMessages = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_message message
                SET body = '[account-deleted]',
                    senderaccountid = NULL,
                    clientmutationprincipalid = CASE
                        WHEN clientmutationprincipalkind = 'account' THEN NULL
                        ELSE clientmutationprincipalid
                    END,
                    contentredactedat = COALESCE(contentredactedat, @Now),
                    contentredactionreason = COALESCE(contentredactionreason, 'account_deleted')
                FROM sys_user account
                WHERE message.senderaccountid = account.id
                  AND (account.status = 2 OR account.deleted_at IS NOT NULL);
                """,
                new SugarParameter("@Now", now));
            int accountConversations = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_conversation conversation
                SET subject = '[account-deleted]',
                    initiatoraccountid = NULL,
                    createdbyaccountid = NULL,
                    clientmutationprincipalid = CASE
                        WHEN clientmutationprincipalkind = 'account' THEN NULL
                        ELSE clientmutationprincipalid
                    END,
                    contentredactedat = COALESCE(contentredactedat, @Now),
                    contentredactionreason = COALESCE(contentredactionreason, 'account_deleted')
                FROM sys_user account
                WHERE (conversation.initiatoraccountid = account.id OR conversation.createdbyaccountid = account.id)
                  AND (account.status = 2 OR account.deleted_at IS NOT NULL);
                """,
                new SugarParameter("@Now", now));
            int participants = await db.Ado.ExecuteCommandAsync(
                """
                DELETE FROM msg_participant_state participant
                USING sys_user account
                WHERE participant.accountid = account.id
                  AND (account.status = 2 OR account.deleted_at IS NOT NULL);
                """);
            int expiredMessages = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_message message
                SET body = '[retention-expired]',
                    contentredactedat = @Now,
                    contentredactionreason = CASE
                        WHEN conversation.issystemsource THEN 'system_retention'
                        WHEN conversation.status = 2 THEN 'closed_retention'
                        ELSE 'open_retention'
                    END
                FROM msg_conversation conversation
                WHERE message.conversationid = conversation.id
                  AND message.contentredactedat IS NULL
                  AND (
                    (conversation.issystemsource AND conversation.lastmessageat < @SystemCutoff)
                    OR (NOT conversation.issystemsource AND conversation.status = 2 AND conversation.updatedat < @ClosedCutoff)
                    OR (NOT conversation.issystemsource AND conversation.status <> 2 AND conversation.lastmessageat < @OpenCutoff)
                  );
                """,
                new SugarParameter("@Now", now),
                new SugarParameter("@SystemCutoff", systemCutoff),
                new SugarParameter("@ClosedCutoff", closedCutoff),
                new SugarParameter("@OpenCutoff", openCutoff));
            int expiredConversations = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_conversation conversation
                SET subject = '[retention-expired]',
                    contentredactedat = @Now,
                    contentredactionreason = CASE
                        WHEN conversation.issystemsource THEN 'system_retention'
                        WHEN conversation.status = 2 THEN 'closed_retention'
                        ELSE 'open_retention'
                    END
                WHERE conversation.contentredactedat IS NULL
                  AND (
                    (conversation.issystemsource AND conversation.lastmessageat < @SystemCutoff)
                    OR (NOT conversation.issystemsource AND conversation.status = 2 AND conversation.updatedat < @ClosedCutoff)
                    OR (NOT conversation.issystemsource AND conversation.status <> 2 AND conversation.lastmessageat < @OpenCutoff)
                  );
                """,
                new SugarParameter("@Now", now),
                new SugarParameter("@SystemCutoff", systemCutoff),
                new SugarParameter("@ClosedCutoff", closedCutoff),
                new SugarParameter("@OpenCutoff", openCutoff));
            var cleanupResult = new MessageRetentionCleanupResult(
                accountMessages,
                accountConversations,
                participants,
                expiredMessages,
                expiredConversations);
            if (cleanupResult.ChangedRows > 0 && transactionalCommitGuard is not null)
            {
                await transactionalCommitGuard.EnlistAsync(
                    db,
                    "message-retention-cleanup",
                    string.Create(
                        System.Globalization.CultureInfo.InvariantCulture,
                        $"message-retention-cleanup:{now.Ticks}:{cleanupResult.ChangedRows}"),
                    cancellationToken).ConfigureAwait(false);
            }
            return cleanupResult;
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Message retention cleanup transaction failed.", transaction.ErrorException);
        }

        result = transaction.Data;
        if (result.ChangedRows > 0)
        {
            logger.LogInformation(
                "Message retention cleanup completed. accountMessages={AccountMessages} accountConversations={AccountConversations} participants={Participants} expiredMessages={ExpiredMessages} expiredConversations={ExpiredConversations}",
                result.AccountMessagesAnonymized,
                result.AccountConversationsAnonymized,
                result.ParticipantRowsRemoved,
                result.ExpiredMessagesRedacted,
                result.ExpiredConversationsRedacted);
        }
        return result;
    }
}
