using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using SqlSugar;
using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Server.Services.Security;

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
    private const int MaxUsernameLength = 32;
    private const int MinPublicHandleLength = 3;
    private const int MaxPublicHandleLength = 20;
    private const int MinPasswordLength = 8;
    private const int MaxPasswordLength = 128;
    private const int MaxAdminPageSize = 200;
    private const int MaxIpLength = 64;
    private static readonly TimeSpan StandardSessionIdleTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan RememberMeSessionIdleTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan StandardSessionAbsoluteTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan RememberMeSessionAbsoluteTtl = TimeSpan.FromDays(90);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string NormalizeUsername(string input)
    {
        var span = input.AsSpan().Trim();
        if (span.IsEmpty) return string.Empty;
        if (span.Length > MaxUsernameLength) span = span[..MaxUsernameLength];
        return string.Create(span.Length, span, static (dst, src) => src.ToLowerInvariant(dst));
    }

    private static TimeSpan ResolveIdleSessionTtl(bool rememberMe)
        => rememberMe ? RememberMeSessionIdleTtl : StandardSessionIdleTtl;

    private static TimeSpan ResolveAbsoluteSessionTtl(bool rememberMe)
        => rememberMe ? RememberMeSessionAbsoluteTtl : StandardSessionAbsoluteTtl;

    private static string CreateAnonymousInternalUsername()
        => $"anon_{Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant()}";

    private static (bool Success, string? PublicHandle, string Message) NormalizePublicHandle(string? publicHandle)
    {
        if (string.IsNullOrWhiteSpace(publicHandle))
        {
            return (true, null, string.Empty);
        }

        string normalized = NormalizeUsername(publicHandle);
        if (normalized.Length < MinPublicHandleLength || normalized.Length > MaxPublicHandleLength)
        {
            return (false, null, $"公开称呼长度必须在 {MinPublicHandleLength}-{MaxPublicHandleLength} 个字符之间");
        }

        if (!FastCharValidator.IsOnlyChineseAndAlpha(normalized))
        {
            return (false, null, "公开称呼仅允许中文或英文字母");
        }

        return (true, normalized, string.Empty);
    }

    public async Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto)
    {
        if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return (false, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage);
        }

        if (!IsPasswordLengthValid(dto.Password))
        {
            return (false, "密码长度必须在 8-128 位之间");
        }

        if (dto.Password != dto.ConfirmPassword)
            return (false, "两次输入的密码不一致");

        string normalizedUsername = NormalizeUsername(dto.Username);
        if (normalizedUsername.Length == 0) return (false, "用户名不能为空");

        if (!FastCharValidator.IsOnlyChineseAndAlpha(normalizedUsername))
        {
            return (false, "用户名格式非法，仅允许中英文");
        }

        if (await _db.Queryable<User>().AnyAsync(u => u.Username == normalizedUsername))
            return (false, "用户名已存在");

        string passwordHash = BCrypt.Net.BCrypt.HashPassword(dto.Password);

        var newUser = new User
        {
            Username = normalizedUsername,
            Password = passwordHash,
            Role = "guest",
        };

        Result<int> registerResult = await BoundaryExecutor.ExecuteResultAsync(
            () => _db.Insertable(newUser).ExecuteCommandAsync(),
            ex => ex.Message.Contains("23505", StringComparison.OrdinalIgnoreCase)
                  || ex.Message.Contains("Unique", StringComparison.OrdinalIgnoreCase)
                ? ErrorDetail.Create(ErrorCode.Conflict, "用户名已被占用")
                : ErrorDetail.Create(ErrorCode.InfraFailure, "注册失败，请稍后重试"),
            _logger,
            $"user-register:{normalizedUsername}");

        if (!registerResult.IsSuccess)
        {
            if (registerResult.Error.Code == ErrorCode.Conflict)
            {
                using var _ = AuditLogScope.Push(
                    AuditSourceCatalog.Auth,
                    AuditTypeCatalog.Business,
                    new KeyValuePair<string, object?>("AuditAction", "register.conflict"),
                    new KeyValuePair<string, object?>("Username", normalizedUsername));
                LogRegistrationConflict(normalizedUsername);
                return (false, "用户名已被占用");
            }

            return (false, registerResult.Error.Message);
        }

        return registerResult.Value > 0
            ? (true, "注册成功")
            : (false, "注册失败，请稍后重试");
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
            string internalUsername = CreateAnonymousInternalUsername();
            var newUser = new User
            {
                Username = internalUsername,
                Password = string.Empty,
                Role = "guest",
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

    public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> LoginAsync(LoginDto dto, string clientIp)
    {
        var check = await ValidateCredentialsAsync(dto, clientIp);
        if (!check.Success || check.User == null)
        {
            return (false, check.Message, null, null);
        }

        return await CompleteLoginAsync(
            check.User,
            NormalizeClientIp(clientIp),
            deviceFingerprint: null,
            userAgent: null,
            mfaVerified: !check.User.MfaEnabled,
            rememberMe: dto.RememberMe);
    }

    public async Task<(bool Success, string Message, User? User)> ValidateCredentialsAsync(LoginDto dto, string clientIp)
    {
        if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return (false, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage, null);
        }

        clientIp = NormalizeClientIp(clientIp);
        string normalizedUsername = NormalizeUsername(dto.Username);
        if (normalizedUsername.Length == 0) return (false, "用户名不能为空", null);

        var user = await _db.Queryable<User>().FirstAsync(u => u.Username == normalizedUsername);

        bool isPasswordValid = false;
        if (user != null)
        {
            isPasswordValid = BCrypt.Net.BCrypt.Verify(dto.Password, user.Password);
        }

        if (user == null || !isPasswordValid)
        {
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "login.failed"),
                new KeyValuePair<string, object?>("Username", normalizedUsername),
                new KeyValuePair<string, object?>("ClientIp", clientIp));
            LogLoginFailure(normalizedUsername, clientIp);
            return (false, "用户名或密码错误", null);
        }

        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, "账户已注销", null);
        }

        return (true, "验证通过", user);
    }

    public async Task<User?> GetByIdAsync(int id) => await _db.Queryable<User>().InSingleAsync(id);

    public async Task<User?> GetByUsernameAsync(string username)
    {
        if (string.IsNullOrWhiteSpace(username)) return null;
        return await _db.Queryable<User>().FirstAsync(u => u.Username == NormalizeUsername(username));
    }

    public async Task<(bool Success, string Message, TokenResponseDto? Data)> UpdateUsernameAsync(int userId, string newUsername)
    {
        string normalizedUsername = NormalizeUsername(newUsername);
        if (normalizedUsername.Length == 0) return (false, "新用户名不能为空", null);

        if (!FastCharValidator.IsOnlyChineseAndAlpha(normalizedUsername))
            return (false, "用户名格式非法，仅允许中英文", null);

        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null) return (false, "用户不存在", null);

        if (user.LastUsernameUpdateTime.HasValue)
        {
            var elapsed = DateTime.UtcNow - user.LastUsernameUpdateTime.Value;
            var limit = TimeSpan.FromDays(30);
            if (elapsed < limit)
            {
                int remainDays = (limit - elapsed).Days + 1;
                return (false, $"修改过于频繁，请在 {remainDays} 天后再试", null);
            }
        }

        if (await _db.Queryable<User>().AnyAsync(u => u.Username == normalizedUsername && u.Id != userId))
            return (false, "该用户名已被占用", null);

        var now = DateTime.UtcNow;
        await _db.Updateable<User>()
            .SetColumns(u => u.Username == normalizedUsername)
            .SetColumns(u => u.LastUsernameUpdateTime == now)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

        user.Username = normalizedUsername;
        return (true, "修改成功", new TokenResponseDto(_jwtHelper.GenerateAccessToken(user), string.Empty));
    }

    public async Task<(bool Success, string Message)> UpdatePublicHandleAsync(int userId, string? publicHandle)
    {
        var handle = NormalizePublicHandle(publicHandle);
        if (!handle.Success)
        {
            return (false, handle.Message);
        }

        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, "用户不存在");
        }

        if (handle.PublicHandle is { Length: > 0 } normalizedHandle &&
            await _db.Queryable<User>().AnyAsync(u => u.PublicHandle == normalizedHandle && u.Id != userId))
        {
            return (false, "公开称呼已被占用");
        }

        await _db.Updateable<User>()
            .SetColumns(u => u.PublicHandle == handle.PublicHandle)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

        return handle.PublicHandle is null
            ? (true, "公开称呼已清空")
            : (true, "公开称呼已保存");
    }

    public async Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto)
    {
        if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return (false, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage);
        }

        if (!IsPasswordLengthValid(dto.NewPassword))
        {
            return (false, "新密码长度必须在 8-128 位之间");
        }

        if (dto.NewPassword != dto.ConfirmPassword)
            return (false, "两次输入的新密码不一致");

        var user = await _db.Queryable<User>().InSingleAsync(userId);

        bool isOldPasswordValid = false;
        if (user != null)
        {
            isOldPasswordValid = BCrypt.Net.BCrypt.Verify(dto.OldPassword, user.Password);
        }

        if (user == null || !isOldPasswordValid)
            return (false, "旧密码验证失败");

        string newHash = BCrypt.Net.BCrypt.HashPassword(dto.NewPassword);

        DateTime revokedAt = DateTime.UtcNow;
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Updateable<User>()
                .SetColumns(u => u.Password == newHash)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();

            await _db.Updateable<UserSession>()
                .SetColumns(s => s.RevokedAt == revokedAt)
                .SetColumns(s => s.RevokeReason == "password_changed")
                .Where(s => s.UserId == userId && s.RevokedAt == null)
                .ExecuteCommandAsync();
        });

        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "Password change transaction failed for user {UserId}", userId);
            return (false, "操作失败");
        }

        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>("AuditAction", "password_changed"),
            new KeyValuePair<string, object?>("UserId", userId),
            new KeyValuePair<string, object?>("SessionsRevoked", true));
        return (true, "密码修改成功");
    }

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
        var page = dto.Page < 1 ? 1 : dto.Page;
        var pageSize = dto.PageSize switch
        {
            < 1 => 20,
            > MaxAdminPageSize => MaxAdminPageSize,
            _ => dto.PageSize
        };

        string? keyword = dto.Keyword?.Trim();
        var query = _db.Queryable<User>();
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            query = int.TryParse(keyword, out int accountId) && accountId > 0
                ? query.Where(u => u.Id == accountId || u.PublicHandle!.Contains(keyword) || u.IdentityKind.Contains(keyword))
                : query.Where(u => u.PublicHandle!.Contains(keyword) || u.IdentityKind.Contains(keyword));
        }

        query = query.WhereIF(dto.Status.HasValue, u => u.Status == dto.Status);

        int total = await query.CountAsync();
        if (total == 0) return new PageResult<AdminAccountListItemDto> { Total = 0, Items = [] };

        var sqlObj = query
            .OrderByDescending(u => u.CreateTime)
            .Select(u => new
            {
                u.Id,
                u.IdentityKind,
                u.PublicHandle,
                u.PasskeyEnabled,
                u.RecoveryEnabled,
                u.PrivacyInitializedAt,
                u.AnonymousCredentialStatus,
                u.AnonymousCredentialLevel,
                u.RiskFlags,
                u.Status,
                u.CreateTime,
                u.DeletedAt
            })
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToSql();

        var list = new List<AdminAccountListItemDto>(pageSize);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
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

        return new PageResult<AdminAccountListItemDto>
        {
            Total = total,
            Items = list
        };
    }

    public async Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto)
    {
        if (dto.Status is not (UserStatusNormal or UserStatusBanned))
        {
            return (false, "管理员接口只允许封禁或解封用户");
        }

        var user = await _db.Queryable<User>().InSingleAsync(dto.UserId);
        if (user == null) return (false, "用户不存在");
        if (user.Role == "admin") return (false, "无法封禁管理员账号");
        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue) return (false, "已注销账户不可变更状态");

        string? effectiveReason = dto.Status == 1 ? (dto.Reason ?? "违反社区规定") : null;

        await _db.Updateable<User>()
                .SetColumns(u => u.Status == dto.Status)
                .SetColumns(u => u.BanReason == effectiveReason)
                .Where(u => u.Id == dto.UserId)
                .ExecuteCommandAsync();

        if (dto.Status == UserStatusBanned)
        {
            await _blacklistService.BanUserAsync(dto.UserId, effectiveReason!);
            _ = NotifyUserBannedAsync(dto.UserId, effectiveReason!);
        }
        else
        {
            await _blacklistService.UnbanUserAsync(dto.UserId);
            _ = NotifyUserUnbannedAsync(dto.UserId);
        }

        return (true, dto.Status == UserStatusBanned ? "用户已封禁" : "用户已解封");
    }

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
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "login.restricted"),
                new KeyValuePair<string, object?>("Username", user.Username));
            LogBannedUserLogin(user.Username);
        }

        string refreshToken = _jwtHelper.GenerateRefreshToken();
        string refreshTokenHash = HashToken(refreshToken);
        string sessionId = Convert.ToHexString(Guid.NewGuid().ToByteArray());
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

        await _db.Insertable(session).ExecuteCommandAsync();

        await _db.Updateable<User>()
            .SetColumns(it => it.LastLoginTime == now)
            .SetColumns(it => it.LastLoginIp == clientIp)
            .Where(it => it.Id == user.Id)
            .ExecuteCommandAsync();

        return (true, "登录成功", new SessionTokenResponseDto(accessToken, refreshToken, idleExpiresAt), user);
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
                LastIp = s.LastIp,
                UserAgent = s.UserAgent,
                LastSeenAt = s.LastSeenAt,
                MfaVerified = s.MfaVerified
            })
            .ToListAsync();

        return sessions.Select(s => new UserSessionSummaryDto(
            s.SessionId,
            s.DeviceFingerprint ?? "unknown",
            s.LastIp ?? "unknown",
            BuildDeviceLabel(s.UserAgent, s.DeviceFingerprint),
            s.LastSeenAt,
            string.Equals(s.SessionId, currentSessionId, StringComparison.Ordinal),
            s.MfaVerified)).ToList();
    }

    private sealed record UserSessionSummaryRow
    {
        public string SessionId { get; init; } = string.Empty;
        public string? DeviceFingerprint { get; init; }
        public string? LastIp { get; init; }
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
            LogBannedUserTokenRefresh(user.Username);
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
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh_token_reuse_detected"),
                new KeyValuePair<string, object?>("SessionId", session.SessionId),
                new KeyValuePair<string, object?>("UserId", session.UserId));
            LogRefreshTokenReuseDetected(session.SessionId, session.UserId);
            return (false, null);
        }

        return (true, new TokenResponseDto(accessToken, newRefreshToken));
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
            else if (string.IsNullOrWhiteSpace(password) || !BCrypt.Net.BCrypt.Verify(password, user.Password))
            {
                return (false, null, "MFA_REBIND_PASSWORD_REQUIRED");
            }
            else
            {
                bool stepUpPassed = await VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption: true);
                if (!stepUpPassed)
                {
                    return (false, null, "MFA_REBIND_STEP_UP_REQUIRED");
                }
            }
        }

        string secret = _totpService.GenerateSecret();
        string protectedSecret = _totpService.ProtectSecret(secret);
        string account = BuildMfaAccountLabel(user);
        string otpAuthUrl = _totpService.BuildOtpAuthUri(issuer, account, secret);

        DateTime now = DateTime.UtcNow;
        await _db.Updateable<User>()
            .SetColumns(u => u.MfaPendingSecretEncrypted == protectedSecret)
            .SetColumns(u => u.MfaPendingCreatedAt == now)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

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
        if (AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return (false, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage);
        }

        if (!string.Equals(dto.ConfirmText?.Trim(), "DELETE", StringComparison.Ordinal))
        {
            return (false, "确认文本不匹配");
        }

        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, "用户不存在");
        }

        if (user.Role.Equals("admin", StringComparison.OrdinalIgnoreCase))
        {
            return (false, "管理员账户暂不支持自助注销");
        }

        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, "账户已注销");
        }

        if (!BCrypt.Net.BCrypt.Verify(dto.Password, user.Password))
        {
            return (false, "密码验证失败");
        }

        if (user.MfaEnabled)
        {
            bool passed = await VerifyMfaOrRecoveryCodeAsync(user, dto.Code, dto.RecoveryCode, persistRecoveryConsumption: true);
            if (!passed)
            {
                return (false, "多因素验证失败");
            }
        }

        string anonymizedUsername = BuildDeletedUsername(user.Id);
        string replacementPassword = BCrypt.Net.BCrypt.HashPassword(Guid.NewGuid().ToString("N"));
        DateTime deletedAt = DateTime.UtcNow;

        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Updateable<UserSession>()
                .SetColumns(s => s.RevokedAt == deletedAt)
                .SetColumns(s => s.RevokeReason == "account_deleted")
                .Where(s => s.UserId == userId && s.RevokedAt == null)
                .ExecuteCommandAsync();

            await _db.Updateable<User>()
                .SetColumns(u => u.Status == UserStatusDeleted)
                .SetColumns(u => u.Username == anonymizedUsername)
                .SetColumns(u => u.Password == replacementPassword)
                .SetColumns(u => u.MfaEnabled == false)
                .SetColumns(u => u.MfaSecretEncrypted == null)
                .SetColumns(u => u.MfaPendingSecretEncrypted == null)
                .SetColumns(u => u.MfaPendingCreatedAt == null)
                .SetColumns(u => u.MfaRecoveryCodesHash == null)
                .SetColumns(u => u.RiskFlags == 0)
                .SetColumns(u => u.BanReason == null)
                .SetColumns(u => u.LastUsernameUpdateTime == deletedAt)
                .SetColumns(u => u.DeletedAt == deletedAt)
                .SetColumns(u => u.DeletedReason == "self-service")
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();
        });

        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "Delete account transaction failed for user {UserId}", userId);
            return (false, "账户注销失败，请稍后重试");
        }

        await _blacklistService.UnbanUserAsync(userId);
        await _cache.RemoveAsync(CachePolicyId.SecurityBlockedUser, userId.ToString());
        return (true, "账户已注销");
    }

    private static string BuildDeletedUsername(int userId)
    {
        string suffix = Guid.NewGuid().ToString("N")[..8];
        return $"deleted_{userId}_{suffix}";
    }

    public async Task<MfaProfileDto?> GetMfaProfileAsync(int userId)
    {
        var user = await _db.Queryable<User>()
            .Where(u => u.Id == userId)
            .Select(u => new { u.MfaEnabled, u.MfaVerifiedAt })
            .FirstAsync();

        if (user == null)
        {
            return null;
        }

        return new MfaProfileDto(user.MfaEnabled, user.MfaVerifiedAt);
    }

    public async Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null || string.IsNullOrWhiteSpace(user.MfaPendingSecretEncrypted))
        {
            return (false, null, "MFA_SETUP_NOT_STARTED");
        }

        if (user.MfaPendingCreatedAt is null || DateTime.UtcNow - user.MfaPendingCreatedAt.Value > TimeSpan.FromMinutes(10))
        {
            await _db.Updateable<User>()
                .SetColumns(u => u.MfaPendingSecretEncrypted == null)
                .SetColumns(u => u.MfaPendingCreatedAt == null)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();
            return (false, null, "MFA_SETUP_EXPIRED");
        }

        Result<string> secretResult = BoundaryExecutor.ExecuteResult(
            () => _totpService.UnprotectSecret(user.MfaPendingSecretEncrypted),
            _ => ErrorDetail.Create(ErrorCode.Validation, "MFA_SECRET_INVALID"),
            _logger,
            $"mfa-verify-setup:{userId}");
        if (!secretResult.IsSuccess || string.IsNullOrWhiteSpace(secretResult.Value))
        {
            return (false, null, "MFA_SECRET_INVALID");
        }
        string secret = secretResult.Value;

        if (!_totpService.VerifyCode(secret, code))
        {
            return (false, null, "INVALID_TOTP");
        }

        var recoveryCodes = _totpService.GenerateRecoveryCodes(10);
        string recoveryHashes = _totpService.HashRecoveryCodes(recoveryCodes);

        await _db.Updateable<User>()
            .SetColumns(u => u.MfaSecretEncrypted == user.MfaPendingSecretEncrypted)
            .SetColumns(u => u.MfaEnabled == true)
            .SetColumns(u => u.MfaVerifiedAt == DateTime.UtcNow)
            .SetColumns(u => u.MfaRecoveryCodesHash == recoveryHashes)
            .SetColumns(u => u.MfaPendingSecretEncrypted == null)
            .SetColumns(u => u.MfaPendingCreatedAt == null)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

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
        if (!anonymousIdentityMode && !BCrypt.Net.BCrypt.Verify(password, user.Password))
        {
            return (false, "密码验证失败");
        }

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

        await _db.Updateable<User>()
            .SetColumns(u => u.MfaEnabled == false)
            .SetColumns(u => u.MfaSecretEncrypted == null)
            .SetColumns(u => u.MfaPendingSecretEncrypted == null)
            .SetColumns(u => u.MfaPendingCreatedAt == null)
            .SetColumns(u => u.MfaRecoveryCodesHash == null)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

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
        if (!anonymousIdentityMode && !BCrypt.Net.BCrypt.Verify(password, user.Password))
        {
            return (false, null, "密码验证失败");
        }

        if (!user.MfaEnabled || string.IsNullOrWhiteSpace(user.MfaSecretEncrypted))
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

        await _db.Updateable<User>()
            .SetColumns(u => u.MfaRecoveryCodesHash == recoveryHashes)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

        return (true, new MfaSetupVerifyDto
        {
            Enabled = true,
            RecoveryCodes = [.. recoveryCodes]
        }, "MFA_RECOVERY_CODES_REGENERATED");
    }

    public async Task<bool> ResetMfaByAdminAsync(int userId)
    {
        return await _db.Updateable<User>()
            .SetColumns(u => u.MfaEnabled == false)
            .SetColumns(u => u.MfaSecretEncrypted == null)
            .SetColumns(u => u.MfaPendingSecretEncrypted == null)
            .SetColumns(u => u.MfaPendingCreatedAt == null)
            .SetColumns(u => u.MfaRecoveryCodesHash == null)
            .SetColumns(u => u.MfaVerifiedAt == null)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync() > 0;
    }

    public async Task<bool> VerifyMfaOrRecoveryCodeAsync(User user, string? code, string? recoveryCode, bool persistRecoveryConsumption)
    {
        if (!user.MfaEnabled || string.IsNullOrWhiteSpace(user.MfaSecretEncrypted))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(code))
        {
            Result<string> secretResult = BoundaryExecutor.ExecuteResult(
                () => _totpService.UnprotectSecret(user.MfaSecretEncrypted),
                _ => ErrorDetail.Create(ErrorCode.Validation, "MFA_SECRET_INVALID"),
                _logger,
                $"mfa-verify-code:{user.Id}");
            if (!secretResult.IsSuccess || string.IsNullOrWhiteSpace(secretResult.Value))
            {
                return false;
            }
            string secret = secretResult.Value;
            if (_totpService.VerifyCode(secret, code))
            {
                return true;
            }
        }

        if (!string.IsNullOrWhiteSpace(recoveryCode))
        {
            if (_totpService.TryConsumeRecoveryCode(user.MfaRecoveryCodesHash, recoveryCode, out string updatedHashes))
            {
                if (persistRecoveryConsumption)
                {
                    await _db.Updateable<User>()
                        .SetColumns(u => u.MfaRecoveryCodesHash == updatedHashes)
                        .Where(u => u.Id == user.Id)
                        .ExecuteCommandAsync();
                }
                return true;
            }
        }

        return false;
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
    private static bool IsPasswordLengthValid(string? password)
    {
        if (string.IsNullOrEmpty(password)) return false;
        return password.Length is >= MinPasswordLength and <= MaxPasswordLength;
    }

    private static string BuildMfaAccountLabel(User user)
        => AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled()
            ? $"FsusBlog:account:{user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
            : user.Username;

    private Task NotifyUserBannedAsync(int userId, string reason)
        => ExecuteNotificationAsync(static (svc, uid, payload) => svc.SendUserBannedNoticeAsync(uid, payload), userId, reason);

    private Task NotifyUserUnbannedAsync(int userId)
        => ExecuteNotificationAsync(static (svc, uid, _) => svc.SendUserUnbannedNoticeAsync(uid), userId, string.Empty);

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
                await _messageRealtimePublisher.PushUserStatusAsync(userId, 1, reason);
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

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "注册竞态冲突 | 用户名: {Username}")]
    private partial void LogRegistrationConflict(string username);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "登录验证未通过 | 用户名: {Username} | IP: {IpAddress}")]
    private partial void LogLoginFailure(string username, string ipAddress);

    [LoggerMessage(EventId = 3, Level = LogLevel.Information, Message = "封禁用户登录 | 用户名: {Username}")]
    private partial void LogBannedUserLogin(string username);

    [LoggerMessage(EventId = 4, Level = LogLevel.Information, Message = "续期失败 | 凭证失效")]
    private partial void LogTokenRefreshFailure();

    [LoggerMessage(EventId = 5, Level = LogLevel.Information, Message = "受限用户执行令牌续期 | 用户: {Username} | 状态: 只读模式")]
    private partial void LogBannedUserTokenRefresh(string username);

    [LoggerMessage(EventId = 6, Level = LogLevel.Error, Message = "后台异步消息推送失败")]
    private partial void LogBackgroundTaskError(Exception ex);

    [LoggerMessage(EventId = 7, Level = LogLevel.Warning, Message = "检测到刷新令牌重放 | SessionId: {SessionId} | UserId: {UserId}")]
    private partial void LogRefreshTokenReuseDetected(string sessionId, int userId);
}
