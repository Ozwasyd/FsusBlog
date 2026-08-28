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
    public Task<Result<ConversationDetailResponse>> CreateAccountTicketAsync(int accountId, string subject, string body)
        => CreateAccountTicketAsync(
            accountId,
            subject,
            body,
            SnowFlakeSingle.Instance.NextId().ToString(CultureInfo.InvariantCulture));

    public async Task<Result<ConversationDetailResponse>> CreateAccountTicketAsync(
        int accountId,
        string subject,
        string body,
        string clientMutationId)
    {
        MessageContentValidation subjectValidation = MessageContentPolicy.ValidateSubject(subject, "用户申诉");
        MessageContentValidation bodyValidation = MessageContentPolicy.ValidateBody(body);
        if (!subjectValidation.IsValid)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, ToContentValidationCode("subject", subjectValidation.Violation));
        }
        if (!bodyValidation.IsValid)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, ToContentValidationCode("body", bodyValidation.Violation));
        }
        string normalizedSubject = subjectValidation.Value;
        string normalizedBody = bodyValidation.Value;
        if (!TryNormalizeClientMutationId(clientMutationId, out string mutationId))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "client_mutation_id_invalid");
        }

        long conversationId = 0;
        long messageId = 0;
        MutationReplayState replayState = MutationReplayState.None;
        string requestHash = ComputeMutationRequestHash("create", normalizedSubject, normalizedBody);
        DateTime now = UtcNow;

        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync(MessageMutationPrincipalKinds.Account, accountId, mutationId);
            MessageConversation? existing = await FindConversationMutationAsync(
                MessageMutationPrincipalKinds.Account,
                accountId,
                mutationId);
            if (existing is not null)
            {
                conversationId = existing.Id;
                replayState = string.Equals(existing.MutationRequestHash, requestHash, StringComparison.Ordinal)
                    ? MutationReplayState.Replay
                    : MutationReplayState.Conflict;
                return;
            }
            if (await FindMessageMutationAsync(MessageMutationPrincipalKinds.Account, accountId, mutationId) is not null)
            {
                replayState = MutationReplayState.Conflict;
                return;
            }

            var conversation = new MessageConversation
            {
                Id = SnowFlakeSingle.Instance.NextId(),
                Subject = normalizedSubject,
                InitiatorAccountId = accountId,
                Status = ConversationStatus.Open,
                IsSystemSource = false,
                CreatedByType = MessageSenderType.Account,
                CreatedByAccountId = accountId,
                ClientMutationPrincipalKind = MessageMutationPrincipalKinds.Account,
                ClientMutationPrincipalId = accountId,
                ClientMutationId = mutationId,
                MutationRequestHash = requestHash,
                CreatedAt = now,
                UpdatedAt = now,
                LastMessageAt = now
            };
            conversationId = conversation.Id;
            messageId = SnowFlakeSingle.Instance.NextId();
            var firstMessage = new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.Account,
                SenderAccountId = accountId,
                Body = normalizedBody,
                ClientMutationPrincipalKind = MessageMutationPrincipalKinds.Account,
                ClientMutationPrincipalId = accountId,
                ClientMutationId = mutationId,
                MutationRequestHash = requestHash,
                CreatedAt = now
            };
            var participant = new ConversationParticipantState
            {
                ConversationId = conversationId,
                AccountId = accountId,
                LastReadMessageId = messageId,
                UnreadCount = 0,
                LastReadAt = now,
                UpdatedAt = now
            };

            await db.Insertable(conversation).ExecuteCommandAsync();
            await db.Insertable(firstMessage).ExecuteCommandAsync();
            await db.Insertable(participant).ExecuteCommandAsync();
            await db.Insertable(new AdminConversationQueueState
            {
                ConversationId = conversationId,
                UnreadCount = 1,
                Version = 1,
                UpdatedAt = now
            }).ExecuteCommandAsync();
            await EnqueueMessageDeliveriesAsync(
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Account, accountId, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.MessageAppend, MessageMutationOutboxAudiences.Admins, null, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Admins, null, conversationId, messageId, null));
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-create-account-ticket"))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "创建会话失败");
        }
        if (replayState == MutationReplayState.Conflict)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Conflict, "client_mutation_content_conflict");
        }

        var detail = await GetAccountConversationDetailAsync(accountId, conversationId);
        if (detail is null)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "会话创建后读取失败");
        }

        return Result<ConversationDetailResponse>.Success(detail with
        {
            IdempotencyReplay = replayState == MutationReplayState.Replay
        });
    }

    public Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync(
        int accountId,
        long conversationId,
        long readThroughMessageId,
        string body)
        => ReplyAsAccountAsync(
            accountId,
            conversationId,
            readThroughMessageId,
            body,
            SnowFlakeSingle.Instance.NextId().ToString(CultureInfo.InvariantCulture));

    public async Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync(
        int accountId,
        long conversationId,
        long readThroughMessageId,
        string body,
        string clientMutationId)
    {
        long startedAt = Stopwatch.GetTimestamp();
        MessageContentValidation bodyValidation = MessageContentPolicy.ValidateBody(body);
        if (!bodyValidation.IsValid)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, ToContentValidationCode("body", bodyValidation.Violation));
        }
        string normalizedBody = bodyValidation.Value;
        if (!TryNormalizeClientMutationId(clientMutationId, out string mutationId))
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "client_mutation_id_invalid");
        }

        ReplyWriteOutcome writeOutcome = await WriteReplyAsync(new ReplyWriteCommand(
            conversationId,
            normalizedBody,
            MessageSenderType.Account,
            accountId,
            null,
            null,
            readThroughMessageId,
            MessageMutationPrincipalKinds.Account,
            accountId,
            mutationId));
        if (writeOutcome.Status != ReplyWriteStatus.Succeeded)
        {
            return MapReplyWriteOutcome(writeOutcome);
        }

        var message = await BuildMessageResponseAsync(conversationId, writeOutcome.DeliveryEvent.MessageId, MessageViewer.Account);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        FsusObservability.RecordMessageCenterReply("account", FsusObservability.GetElapsed(startedAt));
        return Result<ConversationMessageResponse>.Success(message with
        {
            IdempotencyReplay = writeOutcome.IdempotencyReplay
        });
    }

    private async Task<ReplyWriteOutcome> WriteReplyAsync(ReplyWriteCommand command)
    {
        DateTime now = UtcNow;
        long messageId = SnowFlakeSingle.Instance.NextId();
        string requestHash = ComputeMutationRequestHash(
            "reply",
            command.ConversationId.ToString(CultureInfo.InvariantCulture),
            command.ReadThroughMessageId?.ToString(CultureInfo.InvariantCulture) ?? "0",
            command.Body);
        ReplyWriteOutcome outcome = ReplyWriteOutcome.NotFound;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync(command.MutationPrincipalKind, command.MutationPrincipalId, command.ClientMutationId);
            ConversationMessage? existingMutation = await FindMessageMutationAsync(
                command.MutationPrincipalKind,
                command.MutationPrincipalId,
                command.ClientMutationId);
            if (existingMutation is not null)
            {
                outcome = string.Equals(existingMutation.MutationRequestHash, requestHash, StringComparison.Ordinal)
                    ? ReplyWriteOutcome.Replayed(new ReplyDeliveryEvent(
                        existingMutation.ConversationId,
                        existingMutation.Id,
                        existingMutation.SenderType,
                        existingMutation.CreatedAt))
                    : ReplyWriteOutcome.IdempotencyConflict;
                return;
            }
            if (await FindConversationMutationAsync(
                    command.MutationPrincipalKind,
                    command.MutationPrincipalId,
                    command.ClientMutationId) is not null)
            {
                outcome = ReplyWriteOutcome.IdempotencyConflict;
                return;
            }

            ReplyConversationLock? conversation = await LoadReplyConversationForUpdateAsync(command.ConversationId);
            if (conversation is null)
            {
                outcome = ReplyWriteOutcome.NotFound;
                return;
            }

            if (conversation.Status == ConversationStatus.Closed)
            {
                outcome = ReplyWriteOutcome.Closed;
                return;
            }

            int unreadCount = 0;
            if (command.SenderType == MessageSenderType.Account)
            {
                ReplyParticipantLock? participant = await LoadReplyParticipantForUpdateAsync(
                    command.ConversationId,
                    command.SenderAccountId!.Value);
                if (participant is null)
                {
                    outcome = ReplyWriteOutcome.Forbidden;
                    return;
                }

                ReadAdvanceResult readAdvance = await AdvanceParticipantReadThroughAsync(
                    participant,
                    command.ReadThroughMessageId!.Value,
                    now);
                if (readAdvance.Outcome != ReadAdvanceOutcome.Accepted)
                {
                    outcome = readAdvance.Outcome == ReadAdvanceOutcome.CursorRegression
                        ? ReplyWriteOutcome.CursorRegression
                        : ReplyWriteOutcome.ReadTargetNotVisible;
                    return;
                }

                unreadCount = readAdvance.UnreadCount;
            }

            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = command.ConversationId,
                SenderType = command.SenderType,
                SenderAccountId = command.SenderAccountId,
                SenderAdminPrincipalId = command.SenderAdminPrincipalId,
                SenderAdminSessionAuditReference = command.SenderAdminSessionAuditReference,
                Body = command.Body,
                ClientMutationPrincipalKind = command.MutationPrincipalKind,
                ClientMutationPrincipalId = command.MutationPrincipalId,
                ClientMutationId = command.ClientMutationId,
                MutationRequestHash = requestHash,
                CreatedAt = now
            }).ExecuteCommandAsync();

            int conversationUpdated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_conversation
                SET updatedat = @Now,
                    lastmessageat = @Now
                WHERE id = @ConversationId
                  AND status = @ExpectedStatus;
                """,
                new SugarParameter("@ConversationId", command.ConversationId),
                new SugarParameter("@ExpectedStatus", (int)conversation.Status),
                new SugarParameter("@Now", now));
            if (conversationUpdated != 1)
            {
                throw new ReplyWriteConflictException();
            }

            if (command.SenderType == MessageSenderType.Account)
            {
                await IncrementAdminQueueUnreadAsync(command.ConversationId, now);
            }
            else
            {
                await EnsureAdminQueueStateAsync(command.ConversationId, now);
                await RefreshParticipantsUnreadAfterAdminReplyAsync(command.ConversationId, now);
            }

            await EnqueueReplyDeliveriesAsync(command, messageId);

            outcome = ReplyWriteOutcome.Succeeded(
                unreadCount,
                new ReplyDeliveryEvent(command.ConversationId, messageId, command.SenderType, now));
        });

        if (transaction.IsSuccess)
        {
            return outcome;
        }

        if (transaction.ErrorException is ReplyWriteConflictException)
        {
            return ReplyWriteOutcome.Conflict;
        }

        logger.LogError(
            transaction.ErrorException,
            "Message reply transaction failed. ConversationId: {ConversationId} | SenderType: {SenderType}",
            command.ConversationId,
            command.SenderType);
        return ReplyWriteOutcome.InfraFailure;
    }

    private Task<int> RefreshParticipantsUnreadAfterAdminReplyAsync(long conversationId, DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE msg_participant_state state
            SET unreadcount = (
                    SELECT COUNT(*)::integer
                    FROM msg_message message
                    WHERE message.conversationid = state.conversationid
                      AND message.id > COALESCE(state.lastreadmessageid, 0)
                      AND message.isinternalnote = false
                      AND NOT (
                          message.sendertype = @AccountSenderType
                          AND message.senderaccountid = state.accountid
                      )
                ),
                updatedat = @Now
            WHERE state.conversationid = @ConversationId;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));



    private static Result<ConversationMessageResponse> MapReplyWriteOutcome(ReplyWriteOutcome outcome)
        => outcome.Status switch
        {
            ReplyWriteStatus.Forbidden => Result<ConversationMessageResponse>.Failure(ErrorCode.Forbidden, "无权访问该会话"),
            ReplyWriteStatus.Closed => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "会话已关闭"),
            ReplyWriteStatus.Conflict => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "会话状态冲突"),
            ReplyWriteStatus.IdempotencyConflict => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "client_mutation_content_conflict"),
            ReplyWriteStatus.CursorRegression => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "已读位置不能后退"),
            ReplyWriteStatus.ReadTargetNotVisible => Result<ConversationMessageResponse>.Failure(ErrorCode.NotFound, "已读位置不属于可见会话消息"),
            ReplyWriteStatus.InfraFailure => Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败"),
            _ => Result<ConversationMessageResponse>.Failure(ErrorCode.NotFound, "会话不存在")
        };

    private enum ReadAdvanceOutcome
    {
        NotFound,
        Forbidden,
        Closed,
        TargetNotVisible,
        CursorRegression,
        Accepted
    }

    private readonly record struct ReadAdvanceResult(ReadAdvanceOutcome Outcome, int UnreadCount);

    private enum ReplyWriteStatus
    {
        NotFound,
        Forbidden,
        Closed,
        Conflict,
        IdempotencyConflict,
        CursorRegression,
        ReadTargetNotVisible,
        InfraFailure,
        Succeeded
    }

    private readonly record struct ReplyWriteCommand(
        long ConversationId,
        string Body,
        MessageSenderType SenderType,
        int? SenderAccountId,
        long? SenderAdminPrincipalId,
        string? SenderAdminSessionAuditReference,
        long? ReadThroughMessageId,
        string MutationPrincipalKind,
        long MutationPrincipalId,
        string ClientMutationId);

    private readonly record struct ReplyDeliveryEvent(
        long ConversationId,
        long MessageId,
        MessageSenderType SenderType,
        DateTime CreatedAt);

    private readonly record struct ReplyWriteOutcome(
        ReplyWriteStatus Status,
        int UnreadCount,
        ReplyDeliveryEvent DeliveryEvent,
        bool IdempotencyReplay)
    {
        public static ReplyWriteOutcome NotFound => new(ReplyWriteStatus.NotFound, 0, default, false);
        public static ReplyWriteOutcome Forbidden => new(ReplyWriteStatus.Forbidden, 0, default, false);
        public static ReplyWriteOutcome Closed => new(ReplyWriteStatus.Closed, 0, default, false);
        public static ReplyWriteOutcome Conflict => new(ReplyWriteStatus.Conflict, 0, default, false);
        public static ReplyWriteOutcome IdempotencyConflict => new(ReplyWriteStatus.IdempotencyConflict, 0, default, false);
        public static ReplyWriteOutcome CursorRegression => new(ReplyWriteStatus.CursorRegression, 0, default, false);
        public static ReplyWriteOutcome ReadTargetNotVisible => new(ReplyWriteStatus.ReadTargetNotVisible, 0, default, false);
        public static ReplyWriteOutcome InfraFailure => new(ReplyWriteStatus.InfraFailure, 0, default, false);
        public static ReplyWriteOutcome Succeeded(int unreadCount, ReplyDeliveryEvent deliveryEvent)
            => new(ReplyWriteStatus.Succeeded, unreadCount, deliveryEvent, false);
        public static ReplyWriteOutcome Replayed(ReplyDeliveryEvent deliveryEvent)
            => new(ReplyWriteStatus.Succeeded, 0, deliveryEvent, true);
    }

    private sealed class ReplyWriteConflictException : Exception
    {
    }

    private sealed record ReplyConversationLock(long Id, ConversationStatus Status);

    private sealed record ReplyParticipantLock(long ConversationId, int AccountId, long? LastReadMessageId);



    public Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(
        long conversationId,
        string body,
        AdminMessageActor adminActor)
        => ReplyAsAdminAsync(
            conversationId,
            body,
            adminActor,
            SnowFlakeSingle.Instance.NextId().ToString(CultureInfo.InvariantCulture));

    public async Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(
        long conversationId,
        string body,
        AdminMessageActor adminActor,
        string clientMutationId)
    {
        MessageContentValidation bodyValidation = MessageContentPolicy.ValidateBody(body);
        if (!bodyValidation.IsValid)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, ToContentValidationCode("body", bodyValidation.Violation));
        }
        string normalizedBody = bodyValidation.Value;
        if (!TryNormalizeClientMutationId(clientMutationId, out string mutationId))
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "client_mutation_id_invalid");
        }

        ReplyWriteOutcome writeOutcome = await WriteReplyAsync(new ReplyWriteCommand(
            conversationId,
            normalizedBody,
            MessageSenderType.Admin,
            null,
            adminActor.AdminPrincipalId,
            ComputeAdminSessionAuditReference(adminActor.AdminSessionId),
            null,
            MessageMutationPrincipalKinds.Admin,
            adminActor.AdminPrincipalId,
            mutationId));
        if (writeOutcome.Status != ReplyWriteStatus.Succeeded)
        {
            return MapReplyWriteOutcome(writeOutcome);
        }

        var message = await BuildMessageResponseAsync(conversationId, writeOutcome.DeliveryEvent.MessageId, MessageViewer.Admin);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        return Result<ConversationMessageResponse>.Success(message with
        {
            IdempotencyReplay = writeOutcome.IdempotencyReplay
        });
    }

    public async Task<Result<ConversationStatusMutationResultResponse>> UpdateConversationStatusAsync(
        long conversationId,
        ConversationStatusValue status,
        string reason,
        AdminMessageActor adminActor)
    {
        if (!adminActor.HasAdminPrincipal || string.IsNullOrWhiteSpace(adminActor.AdminSessionId))
        {
            return Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Unauthorized, "admin_session_missing");
        }
        string normalizedReason = reason.Trim();
        if (normalizedReason.Length is < 1 or > 256)
        {
            return Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Validation, "conversation_status_reason_invalid");
        }

        DateTime now = UtcNow;
        ConversationStatusWriteOutcome outcome = ConversationStatusWriteOutcome.NotFound;
        ConversationStatus previousStatus = default;
        ConversationStatus currentStatus = default;
        ConversationStatus targetStatus = ToStatusEntity(status);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ConversationStatusUpdateState? currentState = await LoadConversationStatusUpdateStateAsync(conversationId);
            if (currentState is null)
            {
                return;
            }
            previousStatus = currentState.Status;
            currentStatus = currentState.Status;

            if (currentState.Status == targetStatus)
            {
                outcome = ConversationStatusWriteOutcome.NoChange;
                return;
            }
            if (!IsAllowedStatusTransition(currentState.Status, targetStatus))
            {
                outcome = ConversationStatusWriteOutcome.InvalidTransition;
                return;
            }

            int affected = await TryUpdateConversationStatusAsync(conversationId, status, currentState, now);
            if (affected <= 0)
            {
                ConversationStatusUpdateState? concurrentState = await LoadConversationStatusUpdateStateAsync(conversationId);
                if (concurrentState is null)
                {
                    outcome = ConversationStatusWriteOutcome.NotFound;
                    return;
                }
                previousStatus = concurrentState.Status;
                currentStatus = concurrentState.Status;
                outcome = concurrentState.Status == targetStatus
                    ? ConversationStatusWriteOutcome.NoChange
                    : ConversationStatusWriteOutcome.Conflict;
                return;
            }
            currentStatus = targetStatus;

            await db.Insertable(new ConversationStatusEvent
            {
                Id = SnowFlakeSingle.Instance.NextId(),
                ConversationId = conversationId,
                PreviousStatus = previousStatus,
                CurrentStatus = currentStatus,
                AdminPrincipalId = adminActor.AdminPrincipalId,
                AdminSessionAuditReference = ComputeAdminSessionAuditReference(adminActor.AdminSessionId),
                Reason = normalizedReason,
                CreatedAt = now
            }).ExecuteCommandAsync();

            List<int> participants = await db.Queryable<ConversationParticipantState>()
                .Where(it => it.ConversationId == conversationId)
                .Select(it => it.AccountId)
                .ToListAsync();
            var deliveries = new List<MessageMutationOutbox>(participants.Count + 1);
            long mutationCoordinate = now.Ticks;
            for (int i = 0; i < participants.Count; i++)
            {
                deliveries.Add(CreateDelivery(
                    mutationCoordinate,
                    MessageMutationOutboxEventKinds.ConversationStatus,
                    MessageMutationOutboxAudiences.Account,
                    participants[i],
                    conversationId,
                    null,
                    null,
                    targetStatus));
            }
            deliveries.Add(CreateDelivery(
                mutationCoordinate,
                MessageMutationOutboxEventKinds.ConversationStatus,
                MessageMutationOutboxAudiences.Admins,
                null,
                conversationId,
                null,
                null,
                targetStatus));
            await EnqueueMessageDeliveriesAsync(deliveries.ToArray());
            outcome = ConversationStatusWriteOutcome.Succeeded;
        });
        if (!transaction.IsSuccess)
        {
            FsusObservability.RecordMessageCenterStatus("unknown", "unknown", "error");
            logger.LogError(transaction.ErrorException, "Message status transaction failed. ConversationId: {ConversationId}", conversationId);
            return Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.InfraFailure, "会话状态更新失败");
        }

        string previousStatusMetric = outcome == ConversationStatusWriteOutcome.NotFound
            ? "unknown"
            : ToStatusValue(previousStatus).ToString();
        string currentStatusMetric = outcome == ConversationStatusWriteOutcome.NotFound
            ? "unknown"
            : ToStatusValue(currentStatus).ToString();
        FsusObservability.RecordMessageCenterStatus(previousStatusMetric, currentStatusMetric, outcome.ToString());

        return outcome switch
        {
            ConversationStatusWriteOutcome.NotFound => Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.NotFound, "会话不存在"),
            ConversationStatusWriteOutcome.InvalidTransition => Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Conflict, "conversation_status_transition_invalid"),
            ConversationStatusWriteOutcome.Conflict => Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Conflict, "会话状态已被其他管理员修改"),
            ConversationStatusWriteOutcome.NoChange => Result<ConversationStatusMutationResultResponse>.Success(
                new ConversationStatusMutationResultResponse(
                    ToStatusValue(previousStatus),
                    ToStatusValue(currentStatus),
                    ConversationStatusMutationOutcomeValue.NoChange)),
            _ => Result<ConversationStatusMutationResultResponse>.Success(
                new ConversationStatusMutationResultResponse(
                    ToStatusValue(previousStatus),
                    ToStatusValue(currentStatus),
                    ConversationStatusMutationOutcomeValue.Changed))
        };
    }

    private static bool IsAllowedStatusTransition(ConversationStatus previousStatus, ConversationStatus currentStatus)
        => (previousStatus, currentStatus) switch
        {
            (ConversationStatus.Open, ConversationStatus.Pending or ConversationStatus.Closed) => true,
            (ConversationStatus.Pending, ConversationStatus.Open or ConversationStatus.Closed) => true,
            (ConversationStatus.Closed, ConversationStatus.Open) => true,
            _ => false
        };

    private sealed record ConversationStatusUpdateState(ConversationStatus Status, string RowVersion);

    private enum ConversationStatusWriteOutcome
    {
        NotFound,
        InvalidTransition,
        Conflict,
        NoChange,
        Succeeded
    }



    private Task<int> TryUpdateConversationStatusAsync(
        long conversationId,
        ConversationStatusValue status,
        ConversationStatusUpdateState currentState,
        DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE msg_conversation
            SET status = @Status,
                updatedat = @UpdatedAt
            WHERE id = @ConversationId
              AND status = @ExpectedStatus
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@Status", (int)ToStatusEntity(status)),
            new SugarParameter("@ExpectedStatus", (int)currentState.Status),
            new SugarParameter("@RowVersion", currentState.RowVersion),
            new SugarParameter("@UpdatedAt", now));

    public Task<Result<ConversationDetailResponse>> SendSystemMessageAsync(
        string subject,
        string body,
        long? targetAccountId,
        AdminMessageActor adminActor)
        => SendSystemMessageAsync(
            subject,
            body,
            targetAccountId,
            adminActor,
            SnowFlakeSingle.Instance.NextId());

    public async Task<Result<ConversationDetailResponse>> SendSystemMessageAsync(
        string subject,
        string body,
        long? targetAccountId,
        AdminMessageActor adminActor,
        long sourceEventId,
        SystemMessageTargetPolicy targetPolicy = SystemMessageTargetPolicy.ActiveAccountOnly)
    {
        if (!targetAccountId.HasValue || targetAccountId.Value <= 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "目标账号不能为空");
        }
        if (targetAccountId.Value > int.MaxValue)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.NotFound, "system_message_target_not_found");
        }
        if (sourceEventId <= 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "source_event_id_invalid");
        }

        MessageContentValidation subjectValidation = MessageContentPolicy.ValidateSubject(subject, "系统消息");
        MessageContentValidation bodyValidation = MessageContentPolicy.ValidateBody(body);
        if (!subjectValidation.IsValid)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, ToContentValidationCode("subject", subjectValidation.Violation));
        }
        if (!bodyValidation.IsValid)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, ToContentValidationCode("body", bodyValidation.Violation));
        }
        string normalizedSubject = subjectValidation.Value;
        string normalizedBody = bodyValidation.Value;

        int target = checked((int)targetAccountId.Value);
        bool hasAdminPrincipal = adminActor.HasAdminPrincipal;
        long conversationId = SnowFlakeSingle.Instance.NextId();
        long messageId = SnowFlakeSingle.Instance.NextId();
        string requestHash = ComputeMutationRequestHash(
            "system",
            target.ToString(CultureInfo.InvariantCulture),
            normalizedSubject,
            normalizedBody);
        MutationReplayState replayState = MutationReplayState.None;
        SystemMessageTargetValidation targetValidation = SystemMessageTargetValidation.Allowed;
        DateTime now = UtcNow;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync("system", 0, sourceEventId.ToString(CultureInfo.InvariantCulture));
            MessageConversation? existing = await db.Queryable<MessageConversation>()
                .Where(item => item.SourceMessageId == sourceEventId)
                .FirstAsync();
            if (existing is not null)
            {
                conversationId = existing.Id;
                replayState = string.Equals(existing.MutationRequestHash, requestHash, StringComparison.Ordinal)
                    ? MutationReplayState.Replay
                    : MutationReplayState.Conflict;
                return;
            }

            if (!(configuration.GetValue<bool?>("Messages:SystemMessageTargetValidationEnabled") ?? true))
            {
                targetValidation = SystemMessageTargetValidation.Disabled;
                return;
            }

            SystemMessageTargetLock? targetState = await LoadSystemMessageTargetForUpdateAsync(target);
            targetValidation = ValidateSystemMessageTarget(targetState, targetPolicy);
            if (targetValidation != SystemMessageTargetValidation.Allowed)
            {
                return;
            }

            await db.Insertable(new MessageConversation
            {
                Id = conversationId,
                Subject = normalizedSubject,
                InitiatorAccountId = target,
                Status = ConversationStatus.Open,
                IsSystemSource = true,
                SourceMessageId = sourceEventId,
                MutationRequestHash = requestHash,
                CreatedByType = hasAdminPrincipal ? MessageSenderType.Admin : MessageSenderType.System,
                CreatedByAdminPrincipalId = hasAdminPrincipal ? adminActor.AdminPrincipalId : null,
                CreatedByAdminSessionAuditReference = hasAdminPrincipal
                    ? ComputeAdminSessionAuditReference(adminActor.AdminSessionId)
                    : null,
                CreatedAt = now,
                UpdatedAt = now,
                LastMessageAt = now
            }).ExecuteCommandAsync();

            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.System,
                Body = normalizedBody,
                CreatedAt = now
            }).ExecuteCommandAsync();

            await db.Insertable(new ConversationParticipantState
            {
                ConversationId = conversationId,
                AccountId = target,
                UnreadCount = 1,
                UpdatedAt = now
            }).ExecuteCommandAsync();
            await db.Insertable(new AdminConversationQueueState
            {
                ConversationId = conversationId,
                UnreadCount = 0,
                Version = 1,
                UpdatedAt = now
            }).ExecuteCommandAsync();
            await EnqueueMessageDeliveriesAsync(
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Account, target, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.MessageAppend, MessageMutationOutboxAudiences.Account, target, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Admins, null, conversationId, messageId, null));
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-send-system-message"))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "系统消息创建失败");
        }
        if (replayState == MutationReplayState.Conflict)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Conflict, "source_event_content_conflict");
        }
        Result<ConversationDetailResponse>? targetFailure = targetValidation switch
        {
            SystemMessageTargetValidation.Missing => Result<ConversationDetailResponse>.Failure(
                ErrorCode.NotFound,
                "system_message_target_not_found"),
            SystemMessageTargetValidation.Deleted => Result<ConversationDetailResponse>.Failure(
                ErrorCode.NotFound,
                "system_message_target_deleted"),
            SystemMessageTargetValidation.Restricted => Result<ConversationDetailResponse>.Failure(
                ErrorCode.Forbidden,
                "system_message_target_restricted"),
            SystemMessageTargetValidation.InvalidStatus => Result<ConversationDetailResponse>.Failure(
                ErrorCode.Forbidden,
                "system_message_target_status_invalid"),
            SystemMessageTargetValidation.Disabled => Result<ConversationDetailResponse>.Failure(
                ErrorCode.InfraFailure,
                "system_message_target_validation_disabled"),
            _ => null
        };
        if (targetFailure.HasValue)
        {
            return targetFailure.Value;
        }

        var detail = await GetAccountConversationDetailAsync(target, conversationId);
        if (detail is null)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "系统消息创建后读取失败");
        }

        return Result<ConversationDetailResponse>.Success(detail with
        {
            IdempotencyReplay = replayState == MutationReplayState.Replay
        });
    }

    public async Task SendAccountTransactionalNoticeAsync(int accountId, string subject, string body)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                subject,
                body,
                accountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("account-transactional", accountId, subject, body)),
            "send-account-transactional-notice",
            accountId);

    public async Task SendCommentDeletedNoticeAsync(int targetAccountId, string articleTitle, string commentSnippet, string reason)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                "评论处理通知",
                $"您在《{articleTitle}》下的评论「{commentSnippet}...」已被管理员移除。原因：{reason}",
                targetAccountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("comment-deleted", targetAccountId, articleTitle, commentSnippet, reason)),
            "send-comment-deleted-notice",
            targetAccountId);

    public async Task SendAccountBannedNoticeAsync(int accountId, string reason)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                "账号处罚通知",
                $"您的账号已被封禁，当前仅保留只读权限。原因：{reason}",
                accountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("account-banned", accountId, reason),
                SystemMessageTargetPolicy.AllowRestrictedForGovernance),
            "send-account-banned-notice",
            accountId);
        await PushAccountStatusAsync(accountId, 1, reason);
    }

    public async Task SendAccountUnbannedNoticeAsync(int accountId)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                "账号恢复通知",
                "您已解除账户管控。",
                accountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("account-unbanned", accountId),
                SystemMessageTargetPolicy.AllowRestrictedForGovernance),
            "send-account-unbanned-notice",
            accountId);
        await PushAccountStatusAsync(accountId, 0, null);
    }

    private static SystemMessageTargetValidation ValidateSystemMessageTarget(
        SystemMessageTargetLock? target,
        SystemMessageTargetPolicy policy)
    {
        if (target is null)
        {
            return SystemMessageTargetValidation.Missing;
        }
        if (target.DeletedAt.HasValue || target.Status == 2)
        {
            return SystemMessageTargetValidation.Deleted;
        }
        if (target.Status == 0)
        {
            return SystemMessageTargetValidation.Allowed;
        }
        if (target.Status == 1)
        {
            return policy == SystemMessageTargetPolicy.AllowRestrictedForGovernance
                ? SystemMessageTargetValidation.Allowed
                : SystemMessageTargetValidation.Restricted;
        }

        return SystemMessageTargetValidation.InvalidStatus;
    }
}
