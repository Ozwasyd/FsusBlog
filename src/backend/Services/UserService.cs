using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using SqlSugar;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Server.Services.Security;
using Npgsql;
using System.Diagnostics;

namespace FsusBlog.Server.Services;

/// <summary>
/// 用户服务实现
/// 修复日期: 2026-02-23 (修复 LoginAsync 中 SqlSugar 更新模式混用导致的异常，统一使用泛型表达式原子更新)
/// </summary>
public partial class UserService(
    ISqlSugarClient _db,
    ILogger<UserService> _logger,
    IJwtHelper _jwtHelper,
    IUnifiedCache _cache,
    IBlacklistService _blacklistService,
    IMessageCommandService _messageCommandService,
    IMessageRealtimePublisher _messageRealtimePublisher,
    ITotpService _totpService,
    IAuthRiskService _authRiskService) : IUserService, IUserAuthService
{
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private const int MinPublicHandleLength = 3;
    private const int MaxPublicHandleLength = 20;
    private const int MaxAdminPageSize = 200;
    private const int MaxIpLength = 64;
    private const int UserSessionLoginLockNamespace = 833064;
    private static readonly TimeSpan StandardSessionIdleTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan RememberMeSessionIdleTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan StandardSessionAbsoluteTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan RememberMeSessionAbsoluteTtl = TimeSpan.FromDays(90);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string NormalizePublicHandleToken(string input)
    {
        var span = input.AsSpan().Trim();
        if (span.IsEmpty) return string.Empty;
        if (span.Length > MaxPublicHandleLength) span = span[..MaxPublicHandleLength];
        return string.Create(span.Length, span, static (dst, src) => src.ToLowerInvariant(dst));
    }

    private static TimeSpan ResolveIdleSessionTtl(bool rememberMe)
        => rememberMe ? RememberMeSessionIdleTtl : StandardSessionIdleTtl;

    private static TimeSpan ResolveAbsoluteSessionTtl(bool rememberMe)
        => rememberMe ? RememberMeSessionAbsoluteTtl : StandardSessionAbsoluteTtl;

    private async Task<UserMfaProfile?> GetUserMfaProfileAsync(int userId)
        => await _db.Queryable<UserMfaProfile>()
            .Where(profile => profile.UserId == userId)
            .FirstAsync();

    private async Task UpsertUserMfaProfileAsync(UserMfaProfile profile)
    {
        profile.UpdatedAtUtc = DateTime.UtcNow;
        const string sql = """
            INSERT INTO user_mfa_profile (
                user_id,
                mfa_secret_encrypted,
                mfa_pending_secret_encrypted,
                mfa_pending_created_at,
                mfa_verified_at,
                mfa_recovery_codes_hash,
                hash_version,
                updated_at_utc
            )
            VALUES (
                @UserId,
                @MfaSecretEncrypted,
                @MfaPendingSecretEncrypted,
                CAST(@MfaPendingCreatedAt AS timestamp),
                CAST(@MfaVerifiedAt AS timestamp),
                @MfaRecoveryCodesHash,
                @MfaRecoveryCodesHashVersion,
                CAST(@UpdatedAtUtc AS timestamp)
            )
            ON CONFLICT (user_id) DO UPDATE SET
                mfa_secret_encrypted = EXCLUDED.mfa_secret_encrypted,
                mfa_pending_secret_encrypted = EXCLUDED.mfa_pending_secret_encrypted,
                mfa_pending_created_at = EXCLUDED.mfa_pending_created_at,
                mfa_verified_at = EXCLUDED.mfa_verified_at,
                mfa_recovery_codes_hash = EXCLUDED.mfa_recovery_codes_hash,
                hash_version = EXCLUDED.hash_version,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """;

        await _db.Ado.ExecuteCommandAsync(sql, new SugarParameter[]
        {
            new SugarParameter("@UserId", profile.UserId),
            new SugarParameter("@MfaSecretEncrypted", DbValue(profile.MfaSecretEncrypted)),
            new SugarParameter("@MfaPendingSecretEncrypted", DbValue(profile.MfaPendingSecretEncrypted)),
            new SugarParameter("@MfaPendingCreatedAt", DbValue(profile.MfaPendingCreatedAt)),
            new SugarParameter("@MfaVerifiedAt", DbValue(profile.MfaVerifiedAt)),
            new SugarParameter("@MfaRecoveryCodesHash", DbValue(profile.MfaRecoveryCodesHash)),
            new SugarParameter("@MfaRecoveryCodesHashVersion", profile.MfaRecoveryCodesHashVersion),
            new SugarParameter("@UpdatedAtUtc", profile.UpdatedAtUtc)
        });
    }

    private static object DbValue(string? value)
        => value is null ? DBNull.Value : value;

    private static object DbValue(DateTime? value)
        => value.HasValue ? value.Value : DBNull.Value;

    private static (bool Success, string? PublicHandle, string Message) NormalizePublicHandle(string? publicHandle)
    {
        if (string.IsNullOrWhiteSpace(publicHandle))
        {
            return (true, null, string.Empty);
        }

        string normalized = NormalizePublicHandleToken(publicHandle);
        if (normalized.Length < MinPublicHandleLength || normalized.Length > MaxPublicHandleLength)
        {
            return (false, null, $"公开称呼长度必须在 {MinPublicHandleLength}-{MaxPublicHandleLength} 个字符之间");
        }

        if (!FastCharValidator.IsPublicHandle(normalized))
        {
            return (false, null, "公开称呼允许中文、英文字母、数字和 #");
        }

        return (true, normalized, string.Empty);
    }

    public async Task<(bool Success, string Message, User? User)> BootstrapAnonymousAccountAsync(string? publicHandle)
    {
        if (!AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return (false, "匿名账号初始化仅在匿名身份模式下可用", null);
        }

        var handle = NormalizePublicHandle(publicHandle);
        if (!handle.Success)
        {
            return (false, handle.Message, null);
        }

        if (handle.PublicHandle is { Length: > 0 } normalizedHandle &&
            await _db.Queryable<User>().AnyAsync(u => u.PublicHandle == normalizedHandle))
        {
            return (false, "公开称呼已被占用", null);
        }

        DateTime now = DateTime.UtcNow;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            var newUser = new User
            {
                PublicHandle = handle.PublicHandle,
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                PasskeyEnabled = false,
                RecoveryEnabled = false,
                PrivacyInitializedAt = now,
                AnonymousCredentialLevel = "basic",
                AnonymousCredentialStatus = "active",
                CreateTime = now,
                Status = UserStatusNormal
            };

            Result<int> insertResult = await BoundaryExecutor.ExecuteResultAsync(
                () => _db.Insertable(newUser).ExecuteReturnIdentityAsync(),
                ex => ex.Message.Contains("23505", StringComparison.OrdinalIgnoreCase)
                      || ex.Message.Contains("Unique", StringComparison.OrdinalIgnoreCase)
                    ? ErrorDetail.Create(ErrorCode.Conflict, "匿名账号初始化冲突，请重试")
                    : ErrorDetail.Create(ErrorCode.InfraFailure, "匿名账号初始化失败，请稍后重试"),
                _logger,
                "anonymous-account-bootstrap");

            if (insertResult.IsSuccess && insertResult.Value > 0)
            {
                newUser.Id = insertResult.Value;
                return (true, "匿名账号已初始化", newUser);
            }

            if (insertResult.Error.Code != ErrorCode.Conflict || handle.PublicHandle is { Length: > 0 })
            {
                return (false, insertResult.Error.Message, null);
            }
        }

        return (false, "匿名账号初始化冲突，请重试", null);
    }

    public async Task<User?> GetByIdAsync(int id) => await _db.Queryable<User>().InSingleAsync(id);

    private Task InvalidateAccountSnapshotAsync(int userId, CancellationToken cancellationToken = default)
        => AccountSnapshotCacheInvalidator.BumpVersionAsync(_cache, userId, cancellationToken);

    internal async Task<UserAccountSnapshot?> GetAccountSnapshotProjectionAsync(int id)
    {
        const string sql = """
            SELECT id AS "Id",
                   status AS "Status",
                   banreason AS "BanReason",
                   mfaenabled AS "MfaEnabled",
                   deleted_at AS "DeletedAt",
                   public_handle AS "PublicHandle",
                   identity_kind AS "IdentityKind",
                   passkey_enabled AS "PasskeyEnabled",
                   recovery_enabled AS "RecoveryEnabled",
                   anonymous_credential_status AS "AnonymousCredentialStatus",
                   anonymous_credential_level AS "AnonymousCredentialLevel",
                   passkey_user_handle AS "PasskeyUserHandle"
            FROM sys_user
            WHERE id = @Id
            LIMIT 1;
            """;

        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            sql,
            new SugarParameter[] { new("@Id", id) }).ConfigureAwait(false);
        if (!await reader.ReadAsync().ConfigureAwait(false))
        {
            return null;
        }

        int fId = reader.GetOrdinal("Id");
        int fStatus = reader.GetOrdinal("Status");
        int fBanReason = reader.GetOrdinal("BanReason");
        int fMfaEnabled = reader.GetOrdinal("MfaEnabled");
        int fDeletedAt = reader.GetOrdinal("DeletedAt");
        int fPublicHandle = reader.GetOrdinal("PublicHandle");
        int fIdentityKind = reader.GetOrdinal("IdentityKind");
        int fPasskeyEnabled = reader.GetOrdinal("PasskeyEnabled");
        int fRecoveryEnabled = reader.GetOrdinal("RecoveryEnabled");
        int fAnonymousCredentialStatus = reader.GetOrdinal("AnonymousCredentialStatus");
        int fAnonymousCredentialLevel = reader.GetOrdinal("AnonymousCredentialLevel");
        int fPasskeyUserHandle = reader.GetOrdinal("PasskeyUserHandle");
        int accountId = reader.GetInt32(fId);
        string identityKind = reader.IsDBNull(fIdentityKind)
            ? AnonymousIdentityRuntime.AnonymousAccountKind
            : reader.GetString(fIdentityKind);
        string? publicHandle = reader.IsDBNull(fPublicHandle) ? null : reader.GetString(fPublicHandle);
        string? passkeyUserHandle = reader.IsDBNull(fPasskeyUserHandle) ? null : reader.GetString(fPasskeyUserHandle);
        string accountSubjectHash = AccountSubjectHasher.Create(
            identityKind,
            passkeyUserHandle ?? publicHandle ?? string.Concat("anonymous-account:", accountId.ToString(CultureInfo.InvariantCulture)));

        return new UserAccountSnapshot(
            accountId,
            reader.GetInt32(fStatus),
            reader.IsDBNull(fBanReason) ? null : reader.GetString(fBanReason),
            reader.GetBoolean(fMfaEnabled),
            reader.IsDBNull(fDeletedAt) ? null : reader.GetDateTime(fDeletedAt),
            publicHandle,
            identityKind,
            reader.GetBoolean(fPasskeyEnabled),
            reader.GetBoolean(fRecoveryEnabled),
            reader.IsDBNull(fAnonymousCredentialStatus) ? null : reader.GetString(fAnonymousCredentialStatus),
            reader.IsDBNull(fAnonymousCredentialLevel) ? null : reader.GetString(fAnonymousCredentialLevel),
            accountSubjectHash);
    }

    public async Task<(bool Success, string Message)> UpdatePublicHandleAsync(int userId, string? publicHandle)
    {
        var handle = NormalizePublicHandle(publicHandle);
        if (!handle.Success)
        {
            return (false, handle.Message);
        }

        try
        {
            int updated = handle.PublicHandle is null
                ? await _db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE sys_user
                    SET public_handle = NULL
                    WHERE id = @userId;
                    """,
                    new SugarParameter[] { new("@userId", userId) })
                : await _db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE sys_user
                    SET public_handle = @publicHandle
                    WHERE id = @userId
                      AND NOT EXISTS (
                          SELECT 1
                          FROM sys_user
                          WHERE public_handle = @publicHandle
                            AND id <> @userId
                      );
                    """,
                    new SugarParameter[]
                    {
                        new("@userId", userId),
                        new("@publicHandle", handle.PublicHandle)
                    });

            if (updated > 0)
            {
                await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
                return handle.PublicHandle is null
                    ? (true, "公开称呼已清空")
                    : (true, "公开称呼已保存");
            }
        }
        catch (Exception ex) when (IsUniqueViolation(ex))
        {
            return (false, "公开称呼已被占用");
        }

        if (!await UserExistsAsync(userId))
        {
            return (false, "用户不存在");
        }

        return (false, "公开称呼已被占用");
    }

    private async Task<bool> UserExistsAsync(int userId)
    {
        int exists = await _db.Ado.GetIntAsync(
            """
            SELECT COUNT(1)
            FROM sys_user
            WHERE id = @userId;
            """,
            new SugarParameter[] { new("@userId", userId) });
        return exists > 0;
    }

    private static bool IsUniqueViolation(Exception exception)
        => exception is PostgresException postgres &&
            string.Equals(postgres.SqlState, PostgresErrorCodes.UniqueViolation, StringComparison.Ordinal)
            || exception.Message.Contains("23505", StringComparison.OrdinalIgnoreCase)
            || exception.Message.Contains("Duplicate", StringComparison.OrdinalIgnoreCase)
            || exception.Message.Contains("Unique", StringComparison.OrdinalIgnoreCase);

    public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken)
    {
        return await RefreshTokenAsync(refreshToken, null);
    }

    public async Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(refreshToken)) return false;

        string hash = HashToken(refreshToken);
        int sessionUpdated = await _db.Updateable<UserSession>()
            .SetColumns(s => s.RevokedAt == DateTime.UtcNow)
            .SetColumns(s => s.RevokeReason == "logout")
            .Where(s => s.RefreshTokenHash == hash && s.RevokedAt == null)
            .ExecuteCommandAsync();

        cancellationToken.ThrowIfCancellationRequested();
        return sessionUpdated > 0;
    }

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
                   anonymous_credential_level AS "AnonymousCredentialLevel",
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
        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sql, parameters.ToArray()))
        {
            int fId = reader.GetOrdinal("Id");
            int fIdentityKind = reader.GetOrdinal("IdentityKind");
            int fPublicHandle = reader.GetOrdinal("PublicHandle");
            int fPasskeyEnabled = reader.GetOrdinal("PasskeyEnabled");
            int fRecoveryEnabled = reader.GetOrdinal("RecoveryEnabled");
            int fPrivacyInitializedAt = reader.GetOrdinal("PrivacyInitializedAt");
            int fAnonymousCredentialStatus = reader.GetOrdinal("AnonymousCredentialStatus");
            int fAnonymousCredentialLevel = reader.GetOrdinal("AnonymousCredentialLevel");
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
                    reader.IsDBNull(fAnonymousCredentialLevel) ? "basic" : reader.GetString(fAnonymousCredentialLevel),
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
        if (user == null) return (false, "用户不存在");
        if (string.Equals(user.IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal))
        {
            return (false, "管理员主体不通过普通账号状态接口治理");
        }

        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue) return (false, "已注销账户不可变更状态");

        string? effectiveReason = dto.Status == 1 ? (dto.Reason ?? "违反社区规定") : null;

        if (!await TryUpdateAdminStatusAsync(user, dto.Status, effectiveReason))
        {
            var current = await LoadAdminStatusTargetAsync(dto.AccountId);
            if (current == null) return (false, "用户不存在");
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

        if (dto.Status == UserStatusBanned)
        {
            await _blacklistService.BanUserAsync(dto.AccountId, effectiveReason!);
            await NotifyUserBannedAsync(dto.AccountId, effectiveReason!).ConfigureAwait(false);
        }
        else
        {
            await _blacklistService.UnbanUserAsync(dto.AccountId);
            await NotifyUserUnbannedAsync(dto.AccountId).ConfigureAwait(false);
        }

        await InvalidateAccountSnapshotAsync(dto.AccountId).ConfigureAwait(false);
        return (true, dto.Status == UserStatusBanned ? "用户已封禁" : "用户已解封");
    }

    private async Task<AdminStatusTarget?> LoadAdminStatusTargetAsync(int accountId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
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
            reader.GetInt32(0),
            reader.IsDBNull(1) ? AnonymousIdentityRuntime.AnonymousAccountKind : reader.GetString(1),
            reader.GetInt32(2),
            reader.IsDBNull(3) ? null : reader.GetDateTime(3),
            reader.GetString(4));
    }

    private async Task<bool> TryUpdateAdminStatusAsync(AdminStatusTarget target, int status, string? banReason)
    {
        int updated = await _db.Ado.ExecuteCommandAsync(
            """
            UPDATE sys_user
            SET status = @Status,
                banreason = @BanReason
            WHERE id = @AccountId
              AND identity_kind = @IdentityKind
              AND status <> 2
              AND deleted_at IS NULL
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@AccountId", target.Id),
            new SugarParameter("@IdentityKind", target.IdentityKind),
            new SugarParameter("@Status", status),
            new SugarParameter("@BanReason", banReason),
            new SugarParameter("@RowVersion", target.RowVersion));
        return updated > 0;
    }

    private sealed record AdminStatusTarget(
        int Id,
        string IdentityKind,
        int Status,
        DateTime? DeletedAt,
        string RowVersion);

    public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync(
        User user,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe)
    {
        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, "账户已注销", null, null);
        }

        if (user.Status == UserStatusBanned)
        {
            string accountSubject = AccountSubjectHasher.Create(user);
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "login.restricted"),
                new KeyValuePair<string, object?>("AccountSubjectHash", accountSubject));
            LogBannedAccountLogin(accountSubject);
        }

        string refreshToken = _jwtHelper.GenerateRefreshToken();
        string refreshTokenHash = HashToken(refreshToken);
        string sessionId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        string accessToken = _jwtHelper.GenerateAccessToken(user, sessionId, mfaVerified);
        DateTime now = DateTime.UtcNow;
        DateTime idleExpiresAt = now.Add(ResolveIdleSessionTtl(rememberMe));
        DateTime absoluteExpiresAt = now.Add(ResolveAbsoluteSessionTtl(rememberMe));

        var session = new UserSession
        {
            SessionId = sessionId,
            UserId = user.Id,
            RefreshTokenHash = refreshTokenHash,
            DeviceFingerprint = string.IsNullOrWhiteSpace(deviceFingerprint) ? null : deviceFingerprint,
            LastIp = clientIp,
            UserAgent = Truncate(userAgent, 512),
            CreatedAt = now,
            LastSeenAt = now,
            IdleExpiresAt = idleExpiresAt,
            AbsoluteExpiresAt = absoluteExpiresAt,
            MfaVerified = mfaVerified,
            RememberMe = rememberMe
        };

        long transactionStarted = Stopwatch.GetTimestamp();
        int replacedSessionCount = 0;
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            await AcquireUserSessionLoginLockAsync(user.Id);

            replacedSessionCount = await RevokeActiveUserSessionsForLoginAsync(user.Id, now);

            await _db.Insertable(session).ExecuteCommandAsync();
        });
        FsusObservability.RecordLoginSessionReplacement(
            replacedSessionCount,
            sessionRevokeCommandCount: tran.IsSuccess ? 1 : 0,
            Stopwatch.GetElapsedTime(transactionStarted));
        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "User session login transaction failed for account {AccountId}", user.Id);
            return (false, "登录失败，请重试", null, null);
        }

        return (true, "登录成功", new SessionTokenResponseDto(accessToken, refreshToken, session.SessionId, idleExpiresAt), user);
    }

    private async Task<int> RevokeActiveUserSessionsForLoginAsync(int userId, DateTime revokedAt)
    {
        int count = 0;
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            UPDATE sys_user_session
            SET revokedat = @RevokedAt,
                revokereason = 'login_replaced'
            WHERE userid = @UserId
              AND revokedat IS NULL
            RETURNING sessionid;
            """,
            new SugarParameter("@UserId", userId),
            new SugarParameter("@RevokedAt", revokedAt));

        while (await reader.ReadAsync())
        {
            count++;
        }

        return count;
    }

    private async Task AcquireUserSessionLoginLockAsync(int userId)
    {
        if (_db.CurrentConnectionConfig?.DbType != SqlSugar.DbType.PostgreSQL)
        {
            return;
        }

        await _db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(@LockNamespace, @UserId);",
            new SugarParameter("@LockNamespace", UserSessionLoginLockNamespace),
            new SugarParameter("@UserId", userId));
    }

    public async Task<UserSession?> GetSessionByRefreshTokenAsync(string refreshToken)
    {
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            return null;
        }

        string hash = HashToken(refreshToken);
        return await _db.Queryable<UserSession>()
            .FirstAsync(s => s.RefreshTokenHash == hash && s.RevokedAt == null);
    }

    public async Task<List<UserSessionSummaryDto>> GetUserSessionsAsync(int userId, string? currentSessionId)
    {
        var sessions = await _db.Queryable<UserSession>()
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.IdleExpiresAt > DateTime.UtcNow && s.AbsoluteExpiresAt > DateTime.UtcNow)
            .OrderByDescending(s => s.LastSeenAt)
            .Take(50)
            .Select(s => new UserSessionSummaryRow
            {
                SessionId = s.SessionId,
                DeviceFingerprint = s.DeviceFingerprint,
                UserAgent = s.UserAgent,
                LastSeenAt = s.LastSeenAt,
                MfaVerified = s.MfaVerified
            })
            .ToListAsync();

        return sessions.Select(s => new UserSessionSummaryDto(
            s.SessionId,
            s.DeviceFingerprint ?? "unknown",
            BuildDeviceLabel(s.UserAgent, s.DeviceFingerprint),
            s.LastSeenAt,
            string.Equals(s.SessionId, currentSessionId, StringComparison.Ordinal),
            s.MfaVerified)).ToList();
    }

    private sealed record UserSessionSummaryRow
    {
        public string SessionId { get; init; } = string.Empty;
        public string? DeviceFingerprint { get; init; }
        public string? UserAgent { get; init; }
        public DateTime? LastSeenAt { get; init; }
        public bool MfaVerified { get; init; }
    }

    private static string BuildDeviceLabel(string? userAgent, string? fingerprint)
    {
        if (!string.IsNullOrWhiteSpace(userAgent))
        {
            string normalized = userAgent.Trim();
            if (normalized.Length <= 96)
            {
                return normalized;
            }

            return $"{normalized[..96]}...";
        }

        return string.IsNullOrWhiteSpace(fingerprint) ? "unknown" : fingerprint;
    }

    public async Task<bool> RevokeSessionAsync(int userId, string sessionId, string reason = "manual_revoke")
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        return await _db.Updateable<UserSession>()
            .SetColumns(s => s.RevokedAt == DateTime.UtcNow)
            .SetColumns(s => s.RevokeReason == reason)
            .Where(s => s.UserId == userId && s.SessionId == sessionId && s.RevokedAt == null)
            .ExecuteCommandAsync() > 0;
    }

    public async Task<int> RevokeOtherSessionsAsync(int userId, string? currentSessionId)
    {
        return await _db.Updateable<UserSession>()
            .SetColumns(s => s.RevokedAt == DateTime.UtcNow)
            .SetColumns(s => s.RevokeReason == "revoke_others")
            .Where(s => s.UserId == userId && s.RevokedAt == null && (currentSessionId == null || s.SessionId != currentSessionId))
            .ExecuteCommandAsync();
    }

    public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken, string? sessionId)
    {
        long startedAt = Stopwatch.GetTimestamp();
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh.failed"),
                new KeyValuePair<string, object?>("Reason", "missing-token"));
            LogTokenRefreshFailure();
            return (false, null);
        }

        string hash = HashToken(refreshToken);
        DateTime now = DateTime.UtcNow;
        var query = _db.Queryable<UserSession>()
            .Where(s => s.RefreshTokenHash == hash && s.RevokedAt == null && s.IdleExpiresAt > now && s.AbsoluteExpiresAt > now);
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            query = query.Where(s => s.SessionId == sessionId);
        }

        var session = await query.FirstAsync();
        if (session == null)
        {
            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                await RevokeLikelyRefreshReplayAsync(sessionId, hash);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh.failed"),
                new KeyValuePair<string, object?>("Reason", "session-not-found"));
            LogTokenRefreshFailure();
            return (false, null);
        }

        var user = await _db.Queryable<User>().InSingleAsync(session.UserId);
        if (user == null || user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, null);
        }

        if (user.Status == UserStatusBanned)
        {
            string accountSubject = AccountSubjectHasher.Create(user);
            LogBannedAccountTokenRefresh(accountSubject);
        }

        string newRefreshToken = _jwtHelper.GenerateRefreshToken();
        string newRefreshHash = HashToken(newRefreshToken);
        DateTime idleExpiresAt = now.Add(ResolveIdleSessionTtl(session.RememberMe));
        if (idleExpiresAt > session.AbsoluteExpiresAt)
        {
            idleExpiresAt = session.AbsoluteExpiresAt;
        }
        string accessToken = _jwtHelper.GenerateAccessToken(user, session.SessionId, session.MfaVerified);

        int rotated = await _db.Updateable<UserSession>()
            .SetColumns(s => s.RefreshTokenHash == newRefreshHash)
            .SetColumns(s => s.LastSeenAt == now)
            .SetColumns(s => s.IdleExpiresAt == idleExpiresAt)
            .Where(s => s.SessionId == session.SessionId
                && s.RefreshTokenHash == hash
                && s.RevokedAt == null
                && s.IdleExpiresAt > now
                && s.AbsoluteExpiresAt > now)
            .ExecuteCommandAsync();

        if (rotated != 1)
        {
            await RevokeLikelyRefreshReplayAsync(session.SessionId, hash);
            FsusObservability.RecordAuthRefreshReplayDetected();
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh_token_reuse_detected"),
                new KeyValuePair<string, object?>("SessionId", session.SessionId),
                new KeyValuePair<string, object?>("UserId", session.UserId));
            LogRefreshTokenReuseDetected(session.SessionId, session.UserId);
            return (false, null);
        }

        FsusObservability.RecordAuthRefreshSuccess(3, FsusObservability.GetElapsed(startedAt));
        return (true, new TokenResponseDto(accessToken, newRefreshToken, idleExpiresAt, session.SessionId));
    }

    public async Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync(
        int userId,
        string issuer,
        string? password = null,
        string? code = null,
        string? recoveryCode = null,
        bool stepUpVerified = false)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, null, "用户不存在");
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        if (user.MfaEnabled)
        {
            bool anonymousIdentityMode = AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled();
            if (anonymousIdentityMode)
            {
                if (!stepUpVerified)
                {
                    return (false, null, "MFA_REBIND_STEP_UP_REQUIRED");
                }
            }
            else
            {
                return (false, null, "MFA_REBIND_PASSWORD_REQUIRED");
            }
        }

        string secret = _totpService.GenerateSecret();
        string protectedSecret = _totpService.ProtectSecret(secret);
        string account = BuildMfaAccountLabel(user);
        string otpAuthUrl = _totpService.BuildOtpAuthUri(issuer, account, secret);

        DateTime now = DateTime.UtcNow;
        profile ??= new UserMfaProfile { UserId = userId };
        profile.MfaPendingSecretEncrypted = protectedSecret;
        profile.MfaPendingCreatedAt = now;
        await UpsertUserMfaProfileAsync(profile);

        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>("AuditAction", "mfa_setup_started"),
            new KeyValuePair<string, object?>("UserId", userId),
            new KeyValuePair<string, object?>("Rebind", user.MfaEnabled));

        return (true, new MfaSetupStartDto(user.MfaEnabled, secret, otpAuthUrl, issuer, account), "MFA_SETUP_STARTED");
    }

    public async Task<(bool Success, string Message)> DeleteAccountAsync(int userId, DeleteAccountRequestDto dto)
    {
        if (!string.Equals(dto.ConfirmText?.Trim(), "DELETE", StringComparison.Ordinal))
        {
            return (false, "确认文本不匹配");
        }

        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, "用户不存在");
        }

        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, "账户已注销");
        }

        DateTime deletedAt = DateTime.UtcNow;

        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Updateable<UserSession>()
                .SetColumns(s => s.RevokedAt == deletedAt)
                .SetColumns(s => s.RevokeReason == "account_deleted")
                .Where(s => s.UserId == userId && s.RevokedAt == null)
                .ExecuteCommandAsync();

            await _db.Deleteable<PasskeyCredential>()
                .Where(p => p.AccountId == userId)
                .ExecuteCommandAsync();

            await _db.Updateable<RecoveryKeyCredential>()
                .SetColumns(k => k.RevokedAt == deletedAt)
                .Where(k => k.AccountId == userId && k.RevokedAt == null)
                .ExecuteCommandAsync();

            await _db.Updateable<AnonymousCredential>()
                .SetColumns(c => c.Status == AnonymousCredentialStatuses.Revoked)
                .SetColumns(c => c.RevokedAtUtc == deletedAt)
                .Where(c => c.AccountId == userId && c.RevokedAtUtc == null)
                .ExecuteCommandAsync();

            await _db.Updateable<User>()
                .SetColumns(u => u.Status == UserStatusDeleted)
                .SetColumns(u => u.PublicHandle == null)
                .SetColumns(u => u.IdentityKind == AnonymousIdentityRuntime.AnonymousAccountKind)
                .SetColumns(u => u.PasskeyEnabled == false)
                .SetColumns(u => u.RecoveryEnabled == false)
                .SetColumns(u => u.AnonymousCredentialStatus == AnonymousCredentialStatuses.Revoked)
                .SetColumns(u => u.MfaEnabled == false)
                .SetColumns(u => u.RiskFlags == 0)
                .SetColumns(u => u.BanReason == null)
                .SetColumns(u => u.DeletedAt == deletedAt)
                .SetColumns(u => u.DeletedReason == "self-service")
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();

            await _db.Updateable<UserMfaProfile>()
                .SetColumns(p => p.MfaSecretEncrypted == null)
                .SetColumns(p => p.MfaPendingSecretEncrypted == null)
                .SetColumns(p => p.MfaPendingCreatedAt == null)
                .SetColumns(p => p.MfaRecoveryCodesHash == null)
                .SetColumns(p => p.MfaVerifiedAt == null)
                .SetColumns(p => p.UpdatedAtUtc == deletedAt)
                .Where(p => p.UserId == userId)
                .ExecuteCommandAsync();
        });

        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "Delete account transaction failed for user {UserId}", userId);
            return (false, "账户注销失败，请稍后重试");
        }

        await _blacklistService.UnbanUserAsync(userId);
        await _cache.RemoveAsync(CachePolicyId.SecurityBlockedUser, userId.ToString());
        await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
        return (true, "账户已注销");
    }

    public async Task<MfaProfileDto?> GetMfaProfileAsync(int userId)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);

        if (user == null)
        {
            return null;
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        return new MfaProfileDto(user.MfaEnabled, profile?.MfaVerifiedAt);
    }

    public async Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        UserMfaProfile? profile = user is null ? null : await GetUserMfaProfileAsync(userId);
        if (user == null || profile == null || string.IsNullOrWhiteSpace(profile.MfaPendingSecretEncrypted))
        {
            return (false, null, "MFA_SETUP_NOT_STARTED");
        }

        if (profile.MfaPendingCreatedAt is null || DateTime.UtcNow - profile.MfaPendingCreatedAt.Value > TimeSpan.FromMinutes(10))
        {
            profile.MfaPendingSecretEncrypted = null;
            profile.MfaPendingCreatedAt = null;
            await UpsertUserMfaProfileAsync(profile);
            return (false, null, "MFA_SETUP_EXPIRED");
        }

        Result<string> secretResult = BoundaryExecutor.ExecuteResult(
            () => _totpService.UnprotectSecret(profile.MfaPendingSecretEncrypted),
            _ => ErrorDetail.Create(ErrorCode.Validation, "MFA_SECRET_INVALID"),
            _logger,
            $"mfa-verify-setup:{userId}");
        if (!secretResult.IsSuccess || string.IsNullOrWhiteSpace(secretResult.Value))
        {
            return (false, null, "MFA_SECRET_INVALID");
        }
        string secret = secretResult.Value;

        if (!_totpService.TryVerifyCode(secret, code, out long matchedSetupStep))
        {
            return (false, null, "INVALID_TOTP");
        }

        var recoveryCodes = _totpService.GenerateRecoveryCodes(10);
        string recoveryHashes = _totpService.HashRecoveryCodes(recoveryCodes);

        profile.MfaSecretEncrypted = profile.MfaPendingSecretEncrypted;
        profile.MfaVerifiedAt = DateTime.UtcNow;
        profile.MfaRecoveryCodesHash = recoveryHashes;
        profile.MfaRecoveryCodesHashVersion = TotpService.CurrentRecoveryCodeHashVersion;
        profile.LastTotpStep = matchedSetupStep;
        profile.LastTotpUsedAtUtc = DateTime.UtcNow;
        profile.MfaPendingSecretEncrypted = null;
        profile.MfaPendingCreatedAt = null;
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            bool? lockedMfaEnabled = await LockUserMfaStateForUpdateAsync(userId);
            if (lockedMfaEnabled is null)
            {
                throw new InvalidOperationException("mfa_user_missing");
            }

            await _db.Updateable<User>()
                .SetColumns(u => u.MfaEnabled == true)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();
            await UpsertUserMfaProfileAsync(profile);
        });
        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "MFA setup verification transaction failed for user {UserId}", userId);
            return (false, null, "MFA_ENABLE_FAILED");
        }

        await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
        return (true, new MfaSetupVerifyDto
        {
            Enabled = true,
            RecoveryCodes = [.. recoveryCodes]
        }, "MFA_ENABLED");
    }

    public async Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode, bool stepUpVerified = false)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, "用户不存在");
        }

        bool anonymousIdentityMode = AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled();
        if (!anonymousIdentityMode)
        {
            return (false, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage);
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        if (!user.MfaEnabled)
        {
            return (true, "MFA_ALREADY_DISABLED");
        }

        if (anonymousIdentityMode)
        {
            if (!stepUpVerified)
            {
                return (false, "MFA_STEP_UP_REQUIRED");
            }
        }
        else
        {
            bool pass = await VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption: true);
            if (!pass)
            {
                return (false, "MFA_VERIFY_FAILED");
            }
        }

        if (profile is not null)
        {
            profile.MfaSecretEncrypted = null;
            profile.MfaPendingSecretEncrypted = null;
            profile.MfaPendingCreatedAt = null;
            profile.MfaRecoveryCodesHash = null;
            profile.MfaRecoveryCodesHashVersion = 1;
            profile.MfaVerifiedAt = null;
        }
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            bool? lockedMfaEnabled = await LockUserMfaStateForUpdateAsync(userId);
            if (lockedMfaEnabled is null)
            {
                throw new InvalidOperationException("mfa_user_missing");
            }

            await _db.Updateable<User>()
                .SetColumns(u => u.MfaEnabled == false)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();
            if (profile is not null)
            {
                await UpsertUserMfaProfileAsync(profile);
            }
        });
        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "MFA disable transaction failed for user {UserId}", userId);
            return (false, "MFA_DISABLE_FAILED");
        }

        await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
        return (true, "MFA_DISABLED");
    }

    public async Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode,
        bool stepUpVerified = false)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, null, "用户不存在");
        }

        bool anonymousIdentityMode = AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled();
        if (!anonymousIdentityMode)
        {
            return (false, null, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage);
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        if (!user.MfaEnabled || string.IsNullOrWhiteSpace(profile?.MfaSecretEncrypted))
        {
            return (false, null, "MFA_NOT_ENABLED");
        }

        if (anonymousIdentityMode)
        {
            if (!stepUpVerified)
            {
                return (false, null, "MFA_STEP_UP_REQUIRED");
            }
        }
        else
        {
            bool pass = await VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption: true);
            if (!pass)
            {
                return (false, null, "MFA_VERIFY_FAILED");
            }
        }

        var recoveryCodes = _totpService.GenerateRecoveryCodes(10);
        string recoveryHashes = _totpService.HashRecoveryCodes(recoveryCodes);

        profile.MfaRecoveryCodesHash = recoveryHashes;
        profile.MfaRecoveryCodesHashVersion = TotpService.CurrentRecoveryCodeHashVersion;
        await UpsertUserMfaProfileAsync(profile);

        return (true, new MfaSetupVerifyDto
        {
            Enabled = true,
            RecoveryCodes = [.. recoveryCodes]
        }, "MFA_RECOVERY_CODES_REGENERATED");
    }

    public async Task<bool> ResetMfaByAdminAsync(int userId)
    {
        int updated = 0;
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            bool? lockedMfaEnabled = await LockUserMfaStateForUpdateAsync(userId);
            if (lockedMfaEnabled is null)
            {
                return;
            }

            updated = await _db.Updateable<User>()
                .SetColumns(u => u.MfaEnabled == false)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();

            await _db.Updateable<UserMfaProfile>()
                .SetColumns(p => p.MfaSecretEncrypted == null)
                .SetColumns(p => p.MfaPendingSecretEncrypted == null)
                .SetColumns(p => p.MfaPendingCreatedAt == null)
                .SetColumns(p => p.MfaRecoveryCodesHash == null)
                .SetColumns(p => p.MfaRecoveryCodesHashVersion == 1)
                .SetColumns(p => p.MfaVerifiedAt == null)
                .SetColumns(p => p.UpdatedAtUtc == DateTime.UtcNow)
                .Where(p => p.UserId == userId)
                .ExecuteCommandAsync();
        });
        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "Admin MFA reset transaction failed for user {UserId}", userId);
            return false;
        }

        await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
        return updated > 0;
    }

    private async Task<bool?> LockUserMfaStateForUpdateAsync(int userId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT COALESCE(mfaenabled, false)
            FROM sys_user
            WHERE id = @UserId
            FOR UPDATE;
            """,
            new SugarParameter[] { new("@UserId", userId) });
        if (!await reader.ReadAsync())
        {
            return null;
        }

        return reader.GetBoolean(0);
    }

    public async Task<bool> VerifyMfaOrRecoveryCodeAsync(User user, string? code, string? recoveryCode, bool persistRecoveryConsumption)
    {
        UserMfaProfile? profile = await GetUserMfaProfileAsync(user.Id);
        if (!user.MfaEnabled || string.IsNullOrWhiteSpace(profile?.MfaSecretEncrypted))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(code))
        {
            Result<string> secretResult = BoundaryExecutor.ExecuteResult(
                () => _totpService.UnprotectSecret(profile.MfaSecretEncrypted),
                _ => ErrorDetail.Create(ErrorCode.Validation, "MFA_SECRET_INVALID"),
                _logger,
                $"mfa-verify-code:{user.Id}");
            if (!secretResult.IsSuccess || string.IsNullOrWhiteSpace(secretResult.Value))
            {
                return false;
            }
            string secret = secretResult.Value;
            if (_totpService.TryVerifyCode(secret, code, out long matchedStep))
            {
                if (!await TryConsumeTotpStepAsync(user.Id, matchedStep))
                {
                    return false;
                }

                if (persistRecoveryConsumption &&
                    profile.MfaRecoveryCodesHashVersion < TotpService.CurrentRecoveryCodeHashVersion &&
                    !string.IsNullOrWhiteSpace(profile.MfaRecoveryCodesHash))
                {
                    profile.MfaRecoveryCodesHash = string.Empty;
                    profile.MfaRecoveryCodesHashVersion = 0;
                    await UpsertUserMfaProfileAsync(profile);
                }

                return true;
            }
        }

        if (!string.IsNullOrWhiteSpace(recoveryCode))
        {
            RecoveryCodeConsumeResult consumeResult = _totpService.ConsumeRecoveryCode(profile.MfaRecoveryCodesHash, recoveryCode);
            if (consumeResult.Success)
            {
                if (persistRecoveryConsumption)
                {
                    string oldHashes = profile.MfaRecoveryCodesHash ?? string.Empty;
                    short nextHashVersion = consumeResult.RequiresRecoveryCodeRegeneration
                        ? string.IsNullOrWhiteSpace(consumeResult.UpdatedHashes) ? (short)0 : (short)1
                        : TotpService.CurrentRecoveryCodeHashVersion;
                    if (!await TryPersistRecoveryCodeConsumptionAsync(
                        user.Id,
                        oldHashes,
                        consumeResult.UpdatedHashes,
                        nextHashVersion))
                    {
                        return false;
                    }

                    profile.MfaRecoveryCodesHash = consumeResult.UpdatedHashes;
                    profile.MfaRecoveryCodesHashVersion = nextHashVersion;
                }
                return true;
            }
        }

        return false;
    }

    private async Task<bool> TryConsumeTotpStepAsync(int userId, long matchedStep)
    {
        DateTime usedAtUtc = DateTime.UtcNow;
        const string sql = """
            UPDATE user_mfa_profile
            SET last_totp_step = @MatchedStep,
                last_totp_used_at_utc = @UsedAtUtc,
                updated_at_utc = @UsedAtUtc
            WHERE user_id = @UserId
              AND (last_totp_step IS NULL OR last_totp_step < @MatchedStep);
            """;
        int updated = await _db.Ado.ExecuteCommandAsync(sql, new SugarParameter[]
        {
            new("@MatchedStep", matchedStep),
            new("@UsedAtUtc", usedAtUtc),
            new("@UserId", userId)
        });

        return updated > 0;
    }

    private async Task<bool> TryPersistRecoveryCodeConsumptionAsync(
        int userId,
        string oldHashes,
        string updatedHashes,
        short hashVersion)
    {
        const string sql = """
            UPDATE user_mfa_profile
            SET mfa_recovery_codes_hash = @UpdatedHashes,
                hash_version = @HashVersion,
                updated_at_utc = @UpdatedAtUtc
            WHERE user_id = @UserId
              AND mfa_recovery_codes_hash = @OldHashes;
            """;
        int updated = await _db.Ado.ExecuteCommandAsync(sql, new SugarParameter[]
        {
            new("@UpdatedHashes", updatedHashes),
            new("@HashVersion", hashVersion),
            new("@UpdatedAtUtc", DateTime.UtcNow),
            new("@UserId", userId),
            new("@OldHashes", oldHashes)
        });
        return updated > 0;
    }

    private async Task RevokeLikelyRefreshReplayAsync(string sessionId, string staleHash)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        UserSession? candidate = await _db.Queryable<UserSession>()
            .FirstAsync(s => s.SessionId == sessionId && s.RevokedAt == null);
        if (candidate == null || string.Equals(candidate.RefreshTokenHash, staleHash, StringComparison.Ordinal))
        {
            return;
        }

        await _db.Updateable<UserSession>()
            .SetColumns(s => s.RevokedAt == DateTime.UtcNow)
            .SetColumns(s => s.RevokeReason == "refresh_token_reuse")
            .Where(s => s.SessionId == sessionId && s.RevokedAt == null)
            .ExecuteCommandAsync();
    }

    public Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent)
        => _authRiskService.EvaluateLoginRiskAsync(userId, clientIp, deviceFingerprint, userAgent);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string BuildMfaAccountLabel(User user)
        => $"FsusBlog:account:{user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    private Task NotifyUserBannedAsync(int userId, string reason)
        => ExecuteNotificationAsync(static (svc, uid, payload) => svc.SendAccountBannedNoticeAsync(uid, payload), userId, reason);

    private Task NotifyUserUnbannedAsync(int userId)
        => ExecuteNotificationAsync(static (svc, uid, _) => svc.SendAccountUnbannedNoticeAsync(uid), userId, string.Empty);

    private async Task ExecuteNotificationAsync(Func<IMessageCommandService, int, string, Task> sender, int userId, string payload)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                await sender(_messageCommandService, userId, payload);
            },
            _logger,
            $"user-notify:{userId}",
            LogLevel.Error);
    }

    private async Task ExecuteStatusNotificationAsync(int userId, string reason)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                await _messageRealtimePublisher.PushAccountStatusAsync(userId, 1, reason);
            },
            _logger,
            $"user-status-notify:{userId}",
            LogLevel.Error);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string NormalizeClientIp(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip))
        {
            return string.Empty;
        }

        var value = ip.Trim();
        return value.Length > MaxIpLength ? value[..MaxIpLength] : value;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string HashToken(string token)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(hash);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string? Truncate(string? input, int maxLen)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return null;
        }

        return input.Length <= maxLen ? input : input[..maxLen];
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "匿名账号初始化竞态冲突 | AccountSubject: {AccountSubject}")]
    private partial void LogRegistrationConflict(string accountSubject);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "登录验证未通过 | AccountSubject: {AccountSubject} | ClientIpHash: {ClientIpHash}")]
    private partial void LogLoginFailure(string accountSubject, string clientIpHash);

    [LoggerMessage(EventId = 3, Level = LogLevel.Information, Message = "封禁账号登录 | AccountSubject: {AccountSubject}")]
    private partial void LogBannedAccountLogin(string accountSubject);

    [LoggerMessage(EventId = 4, Level = LogLevel.Information, Message = "续期失败 | 凭证失效")]
    private partial void LogTokenRefreshFailure();

    [LoggerMessage(EventId = 5, Level = LogLevel.Information, Message = "受限账号执行令牌续期 | AccountSubject: {AccountSubject} | 状态: 只读模式")]
    private partial void LogBannedAccountTokenRefresh(string accountSubject);

    [LoggerMessage(EventId = 6, Level = LogLevel.Error, Message = "后台异步消息推送失败")]
    private partial void LogBackgroundTaskError(Exception ex);

    [LoggerMessage(EventId = 7, Level = LogLevel.Warning, Message = "检测到刷新令牌重放 | SessionId: {SessionId} | UserId: {UserId}")]
    private partial void LogRefreshTokenReuseDetected(string sessionId, int userId);
}
