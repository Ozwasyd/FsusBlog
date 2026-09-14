using System.Data.Common;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed class UserAdminModerationService(
    ISqlSugarClient db,
    ILogger<UserAdminModerationService> logger,
    IBanStateProjectionObligationCoordinator banStateObligations,
    IMessageCommandService messages,
    IAccountStateProjectionMutationPublisher accountStates,
    IUserSessionValidationCache? sessionValidation = null) : IUserAdminModerationService
{
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private const int MaxAdminPageSize = 200;
    private const int MaxPublicHandleLength = 20;
    public async Task<PageResult<AdminAccountListItemDto>> GetAdminUserListAsync(UserQueryDto dto)
    {
        long started = Stopwatch.GetTimestamp();
        var page = dto.Page < 1 ? 1 : dto.Page;
        var pageSize = dto.PageSize switch
        {
            < 1 => 20,
            > MaxAdminPageSize => MaxAdminPageSize,
            _ => dto.PageSize
        };

        AdminAccountSearchPlan search = ApplyAdminAccountSearch(dto.Keyword);
        var list = new List<AdminAccountListItemDto>(pageSize);
        DateTime? cursorTime = null;
        int? cursorId = null;
        bool hasMore = false;
        int observedRows = 0;
        for (int currentPage = 1; currentPage <= page; currentPage++)
        {
            List<AdminAccountListItemDto> window = await LoadAdminAccountListWindowAsync(
                pageSize + 1,
                cursorTime,
                cursorId,
                dto.Status,
                search);
            hasMore = window.Count > pageSize;
            if (hasMore)
            {
                window.RemoveAt(window.Count - 1);
            }

            if (currentPage == page || window.Count == 0)
            {
                list = window;
                observedRows += window.Count + (hasMore ? 1 : 0);
                break;
            }

            observedRows += window.Count;
            AdminAccountListItemDto last = window[^1];
            cursorTime = last.CreateTime;
            cursorId = last.AccountId;
        }

        FsusObservability.RecordAdminAccountListQuery(
            search.Kind,
            page,
            pageSize,
            cursorTime.HasValue,
            totalCountUsed: false,
            Stopwatch.GetElapsedTime(started));

        return new PageResult<AdminAccountListItemDto>
        {
            Total = observedRows,
            Items = list
        };
    }

    private async Task<List<AdminAccountListItemDto>> LoadAdminAccountListWindowAsync(
        int limit,
        DateTime? cursorTime,
        int? cursorId,
        int? status,
        AdminAccountSearchPlan search)
    {
        var where = new StringBuilder("WHERE 1 = 1");
        var parameters = new List<SugarParameter>
        {
            new("@Limit", limit)
        };

        if (status.HasValue)
        {
            where.AppendLine(" AND status = @Status");
            parameters.Add(new SugarParameter("@Status", status.Value));
        }

        if (cursorTime.HasValue && cursorId.HasValue)
        {
            where.AppendLine(" AND (createtime < @CursorTime OR (createtime = @CursorTime AND id < @CursorId))");
            parameters.Add(new SugarParameter("@CursorTime", cursorTime.Value));
            parameters.Add(new SugarParameter("@CursorId", cursorId.Value));
        }

        search.AppendWhere(where, parameters);

        string sql = $$"""
            SELECT id AS "Id",
                   identity_kind AS "IdentityKind",
                   public_handle AS "PublicHandle",
                   passkey_enabled AS "PasskeyEnabled",
                   recovery_enabled AS "RecoveryEnabled",
                   privacy_initialized_at AS "PrivacyInitializedAt",
                   anonymous_credential_status AS "AnonymousCredentialStatus",
                   riskflags AS "RiskFlags",
                   status AS "Status",
                   createtime AS "CreateTime",
                   deleted_at AS "DeletedAt"
            FROM sys_user
            {{where}}
            ORDER BY createtime DESC, id DESC
            LIMIT @Limit;
            """;

        var list = new List<AdminAccountListItemDto>(Math.Min(limit, MaxAdminPageSize + 1));
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters.ToArray()))
        {
            int fId = reader.GetOrdinal("Id");
            int fIdentityKind = reader.GetOrdinal("IdentityKind");
            int fPublicHandle = reader.GetOrdinal("PublicHandle");
            int fPasskeyEnabled = reader.GetOrdinal("PasskeyEnabled");
            int fRecoveryEnabled = reader.GetOrdinal("RecoveryEnabled");
            int fPrivacyInitializedAt = reader.GetOrdinal("PrivacyInitializedAt");
            int fAnonymousCredentialStatus = reader.GetOrdinal("AnonymousCredentialStatus");
            int fRiskFlags = reader.GetOrdinal("RiskFlags");
            int fStatus = reader.GetOrdinal("Status");
            int fTime = reader.GetOrdinal("CreateTime");
            int fDeletedAt = reader.GetOrdinal("DeletedAt");

            while (await reader.ReadAsync())
            {
                list.Add(new AdminAccountListItemDto(
                    reader.GetInt32(fId),
                    reader.IsDBNull(fIdentityKind) ? AnonymousIdentityRuntime.AnonymousAccountKind : reader.GetString(fIdentityKind),
                    reader.IsDBNull(fPublicHandle) ? null : reader.GetString(fPublicHandle),
                    reader.GetBoolean(fPasskeyEnabled),
                    reader.GetBoolean(fRecoveryEnabled),
                    reader.IsDBNull(fPrivacyInitializedAt) ? null : reader.GetDateTime(fPrivacyInitializedAt),
                    reader.IsDBNull(fAnonymousCredentialStatus) ? "unknown" : reader.GetString(fAnonymousCredentialStatus),
                    reader.GetInt32(fRiskFlags),
                    reader.GetInt32(fStatus),
                    reader.GetDateTime(fTime),
                    reader.IsDBNull(fDeletedAt) ? null : reader.GetDateTime(fDeletedAt)));
            }
        }

        return list;
    }

    private static AdminAccountSearchPlan ApplyAdminAccountSearch(string? keyword)
    {
        string normalized = keyword?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return AdminAccountSearchPlan.None;
        }

        if (int.TryParse(normalized, out int accountId) && accountId > 0)
        {
            return AdminAccountSearchPlan.AccountId(accountId);
        }

        if (string.Equals(normalized, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal)
            || string.Equals(normalized, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal))
        {
            return AdminAccountSearchPlan.IdentityKind(normalized);
        }

        string handlePrefix = NormalizePublicHandleToken(normalized);
        return string.IsNullOrWhiteSpace(handlePrefix)
            ? AdminAccountSearchPlan.NoMatch("empty")
            : AdminAccountSearchPlan.PublicHandlePrefix(handlePrefix);
    }

    private sealed record AdminAccountSearchPlan(string Kind, string? Sql, IReadOnlyList<SugarParameter> Parameters)
    {
        public static AdminAccountSearchPlan None { get; } = new("none", null, []);

        public static AdminAccountSearchPlan AccountId(int accountId)
            => new("account_id", " AND id = @SearchAccountId", [new SugarParameter("@SearchAccountId", accountId)]);

        public static AdminAccountSearchPlan IdentityKind(string identityKind)
            => new("identity_kind", " AND identity_kind = @SearchIdentityKind", [new SugarParameter("@SearchIdentityKind", identityKind)]);

        public static AdminAccountSearchPlan PublicHandlePrefix(string publicHandlePrefix)
            => new("public_handle_prefix", " AND public_handle LIKE @SearchPublicHandlePrefix", [new SugarParameter("@SearchPublicHandlePrefix", publicHandlePrefix + "%")]);

        public static AdminAccountSearchPlan NoMatch(string reason)
            => new($"no_match_{reason}", " AND 1 = 0", []);

        public void AppendWhere(StringBuilder where, List<SugarParameter> parameters)
        {
            if (!string.IsNullOrWhiteSpace(Sql))
            {
                where.AppendLine(Sql);
            }

            parameters.AddRange(Parameters);
        }
    }

    public async Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto)
    {
        if (dto.Status is not (UserStatusNormal or UserStatusBanned))
        {
            return (false, "管理员接口只允许封禁或解封用户");
        }

        var user = await LoadAdminStatusTargetAsync(dto.AccountId);
        if (user == null)
            return (false, "用户不存在");
        if (string.Equals(user.IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal))
        {
            return (false, "管理员主体不通过普通账号状态接口治理");
        }

        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
            return (false, "已注销账户不可变更状态");

        string? effectiveReason = dto.Status == 1 ? (dto.Reason ?? "违反社区规定") : null;
        if (user.Status == dto.Status)
        {
            return (true, dto.Status == UserStatusBanned ? "用户已封禁" : "用户已解封");
        }

        AdminStatusUpdateResult statusUpdate = await TryUpdateAdminStatusAsync(user, dto.Status, effectiveReason);
        if (!statusUpdate.Success)
        {
            var current = await LoadAdminStatusTargetAsync(dto.AccountId);
            if (current == null)
                return (false, "用户不存在");
            if (string.Equals(current.IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal))
            {
                return (false, "管理员主体不通过普通账号状态接口治理");
            }

            if (current.Status == UserStatusDeleted || current.DeletedAt.HasValue)
            {
                return (false, "已注销账户不可变更状态");
            }

            return (false, "账户状态已变化，请刷新后重试");
        }

        await banStateObligations.ApplyLocalAndPublishPreparedAsync(
            statusUpdate.Invalidation,
            statusUpdate.BanUpdate is BanStateProjectionUpdate update ? [update] : [])
            .ConfigureAwait(false);

        if (dto.Status == UserStatusBanned)
        {
            await NotifyUserBannedAsync(dto.AccountId, effectiveReason!).ConfigureAwait(false);
        }
        else
        {
            await NotifyUserUnbannedAsync(dto.AccountId).ConfigureAwait(false);
        }

        await InvalidateAccountSnapshotAsync(dto.AccountId).ConfigureAwait(false);
        return (true, dto.Status == UserStatusBanned ? "用户已封禁" : "用户已解封");
    }

    private async Task<AdminStatusTarget?> LoadAdminStatusTargetAsync(int accountId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id,
                   identity_kind,
                   status,
                   deleted_at,
                   xmin::text AS row_version
            FROM sys_user
            WHERE id = @AccountId;
            """,
            new SugarParameter("@AccountId", accountId));
        if (!await reader.ReadAsync())
        {
            return null;
        }

        return new AdminStatusTarget(
            reader.ReadInt32("id"),
            reader.IsNull("identity_kind") ? AnonymousIdentityRuntime.AnonymousAccountKind : reader.ReadString("identity_kind"),
            reader.ReadInt32("status"),
            reader.IsNull("deleted_at") ? null : reader.ReadDateTime("deleted_at"),
            reader.ReadString("row_version"));
    }

    private async Task<AdminStatusUpdateResult> TryUpdateAdminStatusAsync(AdminStatusTarget target, int status, string? banReason)
    {
        if (db.CurrentConnectionConfig?.DbType != DbType.PostgreSQL)
        {
            throw new NotSupportedException("Ban-state mutation requires PostgreSQL transactional projection obligations.");
        }

        var states = new List<UserSessionValidationCacheState>();
        bool publicationAttempted = false;
        bool accountUpdated = false;
        BanStateProjectionUpdate? banUpdate = null;
        DistributedInvalidationEvent? banInvalidation = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await UserSessionConcurrencyGate.AcquireAsync(db, target.Id);
            string? accountRowVersion = null;
            using (var accountReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user
                SET status = @Status,
                    banreason = @BanReason,
                    ban_state_generation = ban_state_generation + 1
                WHERE id = @AccountId
                  AND identity_kind = @IdentityKind
                  AND status <> 2
                  AND deleted_at IS NULL
                  AND xmin::text = @RowVersion
                RETURNING xmin::text AS account_row_version,
                          account_subject_hash,
                          status,
                          ban_state_generation;
                """,
                new SugarParameter("@AccountId", target.Id),
                new SugarParameter("@IdentityKind", target.IdentityKind),
                new SugarParameter("@Status", status),
                new SugarParameter("@BanReason", banReason),
                new SugarParameter("@RowVersion", target.RowVersion)))
            {
                if (await accountReader.ReadAsync())
                {
                    accountUpdated = true;
                    accountRowVersion = accountReader.ReadString("account_row_version");
                    if (accountReader.IsNull("account_subject_hash"))
                    {
                        throw new InvalidOperationException("account status projection identity is missing");
                    }
                    banUpdate = BanStateProjectionFacts.Create(
                        accountReader.ReadString("account_subject_hash"),
                        accountReader.ReadInt32("status"),
                        accountReader.ReadInt64("ban_state_generation"));
                }
            }

            if (!accountUpdated)
            {
                return;
            }

            UserSessionMode mode = status == UserStatusBanned
                ? UserSessionMode.Restricted
                : UserSessionMode.Normal;
            using var sessionReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET session_mode = @SessionMode
                WHERE userid = @AccountId
                  AND revokedat IS NULL
                RETURNING sessionid, userid, revokedat, idleexpiresat, absoluteexpiresat,
                          authentication_method, authentication_strength, authenticated_at_utc,
                          session_mode, xmin::text AS row_version;
                """,
                new SugarParameter("@AccountId", target.Id),
                new SugarParameter("@SessionMode", (int)mode));
            while (await sessionReader.ReadAsync())
            {
                states.Add(new UserSessionValidationCacheState(
                    sessionReader.ReadString("sessionid"),
                    sessionReader.ReadInt32("userid"),
                    null,
                    AsUtc(sessionReader.ReadDateTime("idleexpiresat")),
                    AsUtc(sessionReader.ReadDateTime("absoluteexpiresat")),
                    sessionReader.ReadString("row_version"),
                    status,
                    null,
                    target.IdentityKind,
                    sessionReader.ReadString("authentication_method"),
                    sessionReader.ReadString("authentication_strength"),
                    AsUtc(sessionReader.ReadDateTime("authenticated_at_utc")),
                    mode,
                    accountRowVersion!));
            }

            publicationAttempted = states.Count > 0 && sessionValidation is not null;
            if (sessionValidation is not null)
            {
                await sessionValidation.PublishManyAsync(states, allowOverwrite: true);
            }

            if (banUpdate is BanStateProjectionUpdate update)
            {
                banInvalidation = await banStateObligations.PrepareAsync([update]).ConfigureAwait(false);
            }
        });

        if (!transaction.IsSuccess)
        {
            if (publicationAttempted)
            {
                try
                {
                    await sessionValidation!.InvalidateManyAsync(states, CancellationToken.None);
                }
                catch (Exception cleanupError)
                {
                    logger.LogWarning(cleanupError, "Failed to clean up rolled-back session-mode snapshots");
                }
            }
            throw transaction.ErrorException ?? new InvalidOperationException("account status transaction failed");
        }

        return new AdminStatusUpdateResult(accountUpdated, states.Count, banUpdate, banInvalidation);
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind == DateTimeKind.Utc ? value : DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private readonly record struct AdminStatusUpdateResult(
        bool Success,
        int SessionCount,
        BanStateProjectionUpdate? BanUpdate = null,
        DistributedInvalidationEvent? Invalidation = null);

    private sealed record AdminStatusTarget(
        int Id,
        string IdentityKind,
        int Status,
        DateTime? DeletedAt,
        string RowVersion);


    private Task InvalidateAccountSnapshotAsync(int userId, CancellationToken cancellationToken = default)
        => accountStates.ProjectCommittedMutationAsync(userId, cancellationToken);

    private Task NotifyUserBannedAsync(int userId, string reason)
        => ExecuteNotificationAsync(
            static (service, accountId, payload) => service.SendAccountBannedNoticeAsync(accountId, payload),
            userId,
            reason);

    private Task NotifyUserUnbannedAsync(int userId)
        => ExecuteNotificationAsync(
            static (service, accountId, _) => service.SendAccountUnbannedNoticeAsync(accountId),
            userId,
            string.Empty);

    private async Task ExecuteNotificationAsync(
        Func<IMessageCommandService, int, string, Task> sender,
        int userId,
        string payload)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () => await sender(messages, userId, payload),
            logger,
            $"user-notify:{userId}",
            LogLevel.Error);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string NormalizePublicHandleToken(string input)
    {
        ReadOnlySpan<char> span = input.AsSpan().Trim();
        if (span.IsEmpty)
        {
            return string.Empty;
        }

        if (span.Length > MaxPublicHandleLength)
        {
            span = span[..MaxPublicHandleLength];
        }

        return string.Create(span.Length, span, static (destination, source) => source.ToLowerInvariant(destination));
    }
}
