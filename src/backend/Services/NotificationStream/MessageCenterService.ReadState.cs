using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;

using SqlSugar;

namespace FsusBlog.Server.Services.NotificationStream;

public sealed partial class MessageCenterService
{
    private async Task<int> LoadAdminQueueUnreadCountAsync(long conversationId)
    {
        var state = await db.Queryable<AdminConversationQueueState>().InSingleAsync(conversationId);
        return state?.UnreadCount ?? 0;
    }

    private async Task<AdminCounterpartyProjection> LoadAdminCounterpartyProjectionAsync(MessageConversation conversation)
    {
        if (!conversation.InitiatorAccountId.HasValue || conversation.InitiatorAccountId.Value <= 0)
        {
            return new AdminCounterpartyProjection(0, CounterpartyAccountStatusValue.Missing);
        }

        int accountId = conversation.InitiatorAccountId.Value;
        User? account = await db.Queryable<User>().InSingleAsync(accountId);
        return new AdminCounterpartyProjection(
            accountId,
            account is null ? CounterpartyAccountStatusValue.Missing : ToCounterpartyAccountStatus(account.Status));
    }



    private Task<int> IncrementAdminQueueUnreadAsync(long conversationId, DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT @ConversationId,
                   NULL,
                   COUNT(*)::integer,
                   NULL,
                   1,
                   @Now
            FROM msg_message message
            WHERE message.conversationid = @ConversationId
              AND message.sendertype = @AccountSenderType
              AND message.isinternalnote = false
            ON CONFLICT (conversationid) DO UPDATE
            SET unreadcount = msg_admin_queue_state.unreadcount + 1,
                version = msg_admin_queue_state.version + 1,
                updatedat = @Now;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));

    private Task<int> EnsureAdminQueueStateAsync(long conversationId, DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT @ConversationId,
                   NULL,
                   COUNT(*) FILTER (
                       WHERE message.sendertype = @AccountSenderType
                         AND message.isinternalnote = false)::integer,
                   NULL,
                   1,
                   @Now
            FROM msg_message message
            WHERE message.conversationid = @ConversationId
            ON CONFLICT (conversationid) DO NOTHING;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));



    public async Task<int> RebuildAdminQueueStateAsync()
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int changed = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            changed = await db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT conversation.id AS conversationid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_conversation conversation
                LEFT JOIN msg_admin_queue_state state
                  ON state.conversationid = conversation.id
            ), rebuilt AS (
                SELECT resolved.conversationid,
                       resolved.lastreadmessageid,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.sendertype = @AccountSenderType
                             AND message.isinternalnote = false
                       ) AS unreadcount,
                       resolved.lastreadat
                FROM resolved
            )
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT rebuilt.conversationid,
                   rebuilt.lastreadmessageid,
                   rebuilt.unreadcount,
                   rebuilt.lastreadat,
                   1,
                   @Now
            FROM rebuilt
            ON CONFLICT (conversationid) DO UPDATE
            SET lastreadmessageid = EXCLUDED.lastreadmessageid,
                unreadcount = EXCLUDED.unreadcount,
                lastreadat = EXCLUDED.lastreadat,
                version = msg_admin_queue_state.version + 1,
                updatedat = @Now
            WHERE msg_admin_queue_state.lastreadmessageid IS DISTINCT FROM EXCLUDED.lastreadmessageid
               OR msg_admin_queue_state.unreadcount IS DISTINCT FROM EXCLUDED.unreadcount
               OR msg_admin_queue_state.lastreadat IS DISTINCT FROM EXCLUDED.lastreadat;
            """,
                new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
                new SugarParameter("@Now", UtcNow));
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(transaction.ErrorException, "Admin message unread projection rebuild failed.");
            return 0;
        }

        logger.LogInformation("Message unread projection repaired. Scope: admin-all | ChangedRows: {ChangedRows}", changed);
        return changed;
    }

    public async Task<int> RebuildAdminQueueConversationAsync(long conversationId)
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int changed = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            changed = await RebuildAdminQueueConversationCoreAsync(conversationId);
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(
                transaction.ErrorException,
                "Admin conversation unread projection rebuild failed. ConversationId: {ConversationId}",
                conversationId);
            return 0;
        }

        logger.LogInformation(
            "Message unread projection repaired. Scope: admin-conversation | ConversationId: {ConversationId} | ChangedRows: {ChangedRows}",
            conversationId,
            changed);
        return changed;
    }

    public async Task<int> RebuildConversationUnreadAsync(long conversationId)
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int participantChanged = 0;
        int adminChanged = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            participantChanged = await RebuildConversationParticipantUnreadCoreAsync(conversationId);
            adminChanged = await RebuildAdminQueueConversationCoreAsync(conversationId);
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(
                transaction.ErrorException,
                "Conversation unread projection rebuild failed. ConversationId: {ConversationId}",
                conversationId);
            return 0;
        }

        List<int> accountIds = await db.Queryable<ConversationParticipantState>()
            .Where(state => state.ConversationId == conversationId)
            .Select(state => state.AccountId)
            .ToListAsync();
        foreach (int accountId in accountIds.Distinct())
        {
            await RecoverAccountUnreadCacheAsync(accountId);
        }

        int changed = participantChanged + adminChanged;
        logger.LogInformation(
            "Message unread projection repaired. Scope: conversation | ConversationId: {ConversationId} | ParticipantRows: {ParticipantRows} | AdminRows: {AdminRows}",
            conversationId,
            participantChanged,
            adminChanged);
        return changed;
    }

    public async Task<int> RebuildAccountUnreadAsync(int accountId)
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int changed = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            changed = await RebuildAccountParticipantUnreadCoreAsync(accountId);
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(
                transaction.ErrorException,
                "Account unread projection rebuild failed. AccountId: {AccountId}",
                accountId);
            return 0;
        }

        await RecoverAccountUnreadCacheAsync(accountId);
        logger.LogInformation(
            "Message unread projection repaired. Scope: account | AccountId: {AccountId} | ChangedRows: {ChangedRows}",
            accountId,
            changed);
        return changed;
    }

    private bool IsUnreadRepairEnabled()
        => configuration.GetValue<bool?>("Messages:UnreadRepairEnabled") ?? true;

    private Task EnableUnreadRepairTransactionAsync()
        => db.Ado.ExecuteCommandAsync("SELECT set_config('fsus.message_unread_repair', 'on', true);");

    private Task<int> RebuildConversationParticipantUnreadCoreAsync(long conversationId)
        => db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT state.conversationid,
                       state.accountid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_participant_state state
                WHERE state.conversationid = @ConversationId
            ), rebuilt AS (
                SELECT resolved.*,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.isinternalnote = false
                             AND NOT (
                                 message.sendertype = @AccountSenderType
                                 AND message.senderaccountid = resolved.accountid
                             )
                       ) AS unreadcount
                FROM resolved
            )
            UPDATE msg_participant_state state
            SET lastreadmessageid = rebuilt.lastreadmessageid,
                unreadcount = rebuilt.unreadcount,
                lastreadat = rebuilt.lastreadat,
                updatedat = @Now
            FROM rebuilt
            WHERE state.conversationid = rebuilt.conversationid
              AND state.accountid = rebuilt.accountid
              AND (
                  state.lastreadmessageid IS DISTINCT FROM rebuilt.lastreadmessageid
                  OR state.unreadcount IS DISTINCT FROM rebuilt.unreadcount
                  OR state.lastreadat IS DISTINCT FROM rebuilt.lastreadat
              );
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", UtcNow));

    private Task<int> RebuildAccountParticipantUnreadCoreAsync(int accountId)
        => db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT state.conversationid,
                       state.accountid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_participant_state state
                WHERE state.accountid = @AccountId
            ), rebuilt AS (
                SELECT resolved.*,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.isinternalnote = false
                             AND NOT (
                                 message.sendertype = @AccountSenderType
                                 AND message.senderaccountid = resolved.accountid
                             )
                       ) AS unreadcount
                FROM resolved
            )
            UPDATE msg_participant_state state
            SET lastreadmessageid = rebuilt.lastreadmessageid,
                unreadcount = rebuilt.unreadcount,
                lastreadat = rebuilt.lastreadat,
                updatedat = @Now
            FROM rebuilt
            WHERE state.conversationid = rebuilt.conversationid
              AND state.accountid = rebuilt.accountid
              AND (
                  state.lastreadmessageid IS DISTINCT FROM rebuilt.lastreadmessageid
                  OR state.unreadcount IS DISTINCT FROM rebuilt.unreadcount
                  OR state.lastreadat IS DISTINCT FROM rebuilt.lastreadat
              );
            """,
            new SugarParameter("@AccountId", accountId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", UtcNow));

    private Task<int> RebuildAdminQueueConversationCoreAsync(long conversationId)
        => db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT conversation.id AS conversationid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_conversation conversation
                LEFT JOIN msg_admin_queue_state state
                  ON state.conversationid = conversation.id
                WHERE conversation.id = @ConversationId
            ), rebuilt AS (
                SELECT resolved.conversationid,
                       resolved.lastreadmessageid,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.sendertype = @AccountSenderType
                             AND message.isinternalnote = false
                       ) AS unreadcount,
                       resolved.lastreadat
                FROM resolved
            )
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT rebuilt.conversationid,
                   rebuilt.lastreadmessageid,
                   rebuilt.unreadcount,
                   rebuilt.lastreadat,
                   1,
                   @Now
            FROM rebuilt
            ON CONFLICT (conversationid) DO UPDATE
            SET lastreadmessageid = EXCLUDED.lastreadmessageid,
                unreadcount = EXCLUDED.unreadcount,
                lastreadat = EXCLUDED.lastreadat,
                version = msg_admin_queue_state.version + 1,
                updatedat = @Now
            WHERE msg_admin_queue_state.lastreadmessageid IS DISTINCT FROM EXCLUDED.lastreadmessageid
               OR msg_admin_queue_state.unreadcount IS DISTINCT FROM EXCLUDED.unreadcount
               OR msg_admin_queue_state.lastreadat IS DISTINCT FROM EXCLUDED.lastreadat;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", UtcNow));

    private async Task RecoverAccountUnreadCacheAsync(int accountId)
    {
        try
        {
            await RefreshUnreadCacheAsync(accountId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Message unread cache recovery failed. AccountId: {AccountId}",
                accountId);
        }
    }



    public async Task<Result> MarkConversationReadAsync(int accountId, long conversationId, long readThroughMessageId)
    {
        DateTime now = UtcNow;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ReplyParticipantLock? participant = await LoadReplyParticipantForUpdateAsync(conversationId, accountId);
            if (participant is null)
            {
                return new MarkConversationReadResult(ReadAdvanceOutcome.NotFound, null, 0);
            }

            ReadAdvanceResult advanced = await AdvanceParticipantReadThroughAsync(participant, readThroughMessageId, now);
            if (advanced.Outcome == ReadAdvanceOutcome.Accepted)
            {
                await EnqueueMessageDeliveriesAsync(CreateDelivery(
                    readThroughMessageId,
                    MessageMutationOutboxEventKinds.ReadUpdated,
                    MessageMutationOutboxAudiences.Account,
                    accountId,
                    conversationId,
                    null,
                    readThroughMessageId));
            }
            return new MarkConversationReadResult(advanced.Outcome, readThroughMessageId, advanced.UnreadCount);
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(transaction, logger, "message-center-mark-read"))
        {
            return Result.Failure(ErrorCode.InfraFailure, "标记已读失败");
        }

        MarkConversationReadResult readResult = transaction.Data;
        if (readResult.Outcome == ReadAdvanceOutcome.NotFound)
        {
            return Result.Failure(ErrorCode.NotFound, "会话不存在");
        }
        if (readResult.Outcome == ReadAdvanceOutcome.TargetNotVisible)
        {
            return Result.Failure(ErrorCode.NotFound, "已读位置不属于可见会话消息");
        }
        if (readResult.Outcome == ReadAdvanceOutcome.CursorRegression)
        {
            return Result.Failure(ErrorCode.Conflict, "已读位置不能后退");
        }

        return Result.Success();
    }

    private sealed record MarkConversationReadResult(ReadAdvanceOutcome Outcome, long? LastMessageId, int UnreadCount);
}
