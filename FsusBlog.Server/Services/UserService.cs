using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using SqlSugar;
using StackExchange.Redis;
using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services;

/// <summary>
/// 用户服务实现
/// 修复日期: 2026-02-23 (修复 LoginAsync 中 SqlSugar 更新模式混用导致的异常，统一使用泛型表达式原子更新)
/// </summary>
public partial class UserService(
    ISqlSugarClient _db,
    ILogger<UserService> _logger,
    IJwtHelper _jwtHelper,
    IConnectionMultiplexer _redisMultiplexer,
    IBlacklistService _blacklistService,
    IServiceScopeFactory _scopeFactory) : IUserService
{
    private readonly IDatabase _redis = _redisMultiplexer.GetDatabase();

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string NormalizeUsername(string input)
    {
        var span = input.AsSpan().Trim();
        if (span.IsEmpty) return string.Empty;
        return string.Create(span.Length, span, (dst, src) => src.ToLowerInvariant(dst));
    }

    public async Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto)
    {
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

        string passwordHash = await Task.Run(() => BCrypt.Net.BCrypt.HashPassword(dto.Password));

        var newUser = new User
        {
            Username = normalizedUsername,
            Password = passwordHash,
            Role = "guest",
        };

        try
        {
            return await _db.Insertable(newUser).ExecuteCommandAsync() > 0
                ? (true, "注册成功")
                : (false, "注册失败，请稍后重试");
        }
        catch (Exception ex) when (ex.Message.Contains("23505") || ex.Message.Contains("Unique"))
        {
            LogRegistrationConflict(normalizedUsername);
            return (false, "用户名已被占用");
        }
    }

    public async Task<(bool Success, string Message, TokenResponseDto? Data, User? UserEntity)> LoginAsync(LoginDto dto, string clientIp)
    {
        string normalizedUsername = NormalizeUsername(dto.Username);
        if (normalizedUsername.Length == 0) return (false, "用户名不能为空", null, null);

        var user = await _db.Queryable<User>().FirstAsync(u => u.Username == normalizedUsername);

        bool isPasswordValid = false;
        if (user != null)
        {
            isPasswordValid = await Task.Run(() => BCrypt.Net.BCrypt.Verify(dto.Password, user.Password));
        }

        if (user == null || !isPasswordValid)
        {
            LogLoginFailure(normalizedUsername, clientIp);
            return (false, "用户名或密码错误", null, null);
        }

        if (user.Status == 1) LogBannedUserLogin(normalizedUsername);

        var accessToken = _jwtHelper.GenerateAccessToken(user);
        var refreshToken = _jwtHelper.GenerateRefreshToken();
        var now = DateTime.UtcNow;

        // 核心修复：使用泛型 Updateable<User>() 而非 Updateable(user)
        // 这样启用表达式更新模式，支持 SetColumns 原子操作
        await _db.Updateable<User>()
            .SetColumns(it => it.RefreshToken == refreshToken)
            .SetColumns(it => it.RefreshTokenExpiryTime == now.AddDays(7))
            .SetColumns(it => it.LastLoginTime == now)
            .SetColumns(it => it.LastLoginIp == clientIp)
            .Where(it => it.Id == user.Id)
            .ExecuteCommandAsync();

        user.RefreshToken = refreshToken;
        return (true, "登录成功", new TokenResponseDto(accessToken, refreshToken), user);
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
        return (true, "修改成功", new TokenResponseDto(_jwtHelper.GenerateAccessToken(user), user.RefreshToken ?? string.Empty));
    }

    public async Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto)
    {
        if (dto.NewPassword != dto.ConfirmPassword)
            return (false, "两次输入的新密码不一致");

        var user = await _db.Queryable<User>().InSingleAsync(userId);

        bool isOldPasswordValid = false;
        if (user != null)
        {
            isOldPasswordValid = await Task.Run(() => BCrypt.Net.BCrypt.Verify(dto.OldPassword, user.Password));
        }

        if (user == null || !isOldPasswordValid)
            return (false, "旧密码验证失败");

        string newHash = await Task.Run(() => BCrypt.Net.BCrypt.HashPassword(dto.NewPassword));

        var success = await _db.Updateable<User>()
            .SetColumns(u => u.Password == newHash)
            .SetColumns(u => u.RefreshToken == null)
            .SetColumns(u => u.RefreshTokenExpiryTime == null)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync() > 0;

        return success ? (true, "密码修改成功") : (false, "操作失败");
    }

    public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken)
    {
        var user = await _db.Queryable<User>().FirstAsync(u => u.RefreshToken == refreshToken);

        if (user == null || user.RefreshTokenExpiryTime < DateTime.UtcNow)
        {
            LogTokenRefreshFailure();
            return (false, null);
        }

        if (user.Status == 1)
        {
            LogBannedUserTokenRefresh(user.Username);
        }

        var newAccessToken = _jwtHelper.GenerateAccessToken(user);
        var newRefreshToken = _jwtHelper.GenerateRefreshToken();
        var expiry = DateTime.UtcNow.AddDays(7);

        await _db.Updateable<User>()
            .SetColumns(it => it.RefreshToken == newRefreshToken)
            .SetColumns(it => it.RefreshTokenExpiryTime == expiry)
            .Where(it => it.Id == user.Id)
            .ExecuteCommandAsync();

        return (true, new TokenResponseDto(newAccessToken, newRefreshToken));
    }

    public async Task<bool> RevokeRefreshTokenAsync(string refreshToken)
    {
        if (string.IsNullOrWhiteSpace(refreshToken)) return false;
        return await _db.Updateable<User>()
            .SetColumns(it => it.RefreshToken == null)
            .SetColumns(it => it.RefreshTokenExpiryTime == null)
            .Where(it => it.RefreshToken == refreshToken)
            .ExecuteCommandAsync() > 0;
    }

    public async Task<PageResult<UserListDto>> GetAdminUserListAsync(UserQueryDto dto)
    {
        var query = _db.Queryable<User>()
            .WhereIF(!string.IsNullOrWhiteSpace(dto.Keyword), u => u.Username.Contains(dto.Keyword!))
            .WhereIF(dto.Status.HasValue, u => u.Status == dto.Status);

        int total = await query.CountAsync();
        if (total == 0) return new PageResult<UserListDto> { Total = 0, Items = [] };

        var sqlObj = query
            .OrderByDescending(u => u.CreateTime)
            .Select(u => new
            {
                u.Id,
                u.Username,
                u.Role,
                u.Status,
                u.CreateTime,
                u.LastLoginIp,
                u.LastLoginTime
            })
            .Skip((dto.Page - 1) * dto.PageSize)
            .Take(dto.PageSize)
            .ToSql();

        var list = new List<UserListDto>(dto.PageSize);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fName = reader.GetOrdinal("Username");
            int fRole = reader.GetOrdinal("Role");
            int fStatus = reader.GetOrdinal("Status");
            int fTime = reader.GetOrdinal("CreateTime");
            int fIp = reader.GetOrdinal("LastLoginIp");
            int fLastTime = reader.GetOrdinal("LastLoginTime");

            while (await reader.ReadAsync())
            {
                list.Add(new UserListDto
                {
                    Id = reader.GetInt32(fId),
                    Username = reader.GetString(fName),
                    Role = reader.GetString(fRole),
                    Status = reader.GetInt32(fStatus),
                    CreateTime = reader.GetDateTime(fTime),
                    LastLoginIp = reader.IsDBNull(fIp) ? null : reader.GetString(fIp),
                    LastLoginTime = reader.IsDBNull(fLastTime) ? null : reader.GetDateTime(fLastTime)
                });
            }
        }

        return new PageResult<UserListDto>
        {
            Total = total,
            Items = list
        };
    }

    public async Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto)
    {
        var user = await _db.Queryable<User>().InSingleAsync(dto.UserId);
        if (user == null) return (false, "用户不存在");
        if (user.Role == "admin") return (false, "无法封禁管理员账号");

        string? effectiveReason = dto.Status == 1 ? (dto.Reason ?? "违反社区规定") : null;

        await _db.Updateable<User>()
                .SetColumns(u => u.Status == dto.Status)
                .SetColumns(u => u.BanReason == effectiveReason)
                .Where(u => u.Id == dto.UserId)
                .ExecuteCommandAsync();

        if (dto.Status == 1)
        {
            await _blacklistService.BanUserAsync(dto.UserId, effectiveReason!);
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var msgSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                    await msgSvc.SendUserBannedNoticeAsync(dto.UserId, effectiveReason!);
                }
                catch (Exception ex) { LogBackgroundTaskError(ex); }
            });
        }
        else
        {
            await _blacklistService.UnbanUserAsync(dto.UserId);
            _ = Task.Run(async () => {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var msgSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                    await msgSvc.SendUserUnbannedNoticeAsync(dto.UserId);
                }
                catch (Exception ex) { LogBackgroundTaskError(ex); }
            });
        }

        return (true, dto.Status == 1 ? "用户已封禁" : "用户已解封");
    }

    public async Task<(bool Success, string Message)> AdminResetPasswordAsync(AdminResetPwdDto dto)
    {
        var user = await _db.Queryable<User>().InSingleAsync(dto.UserId);
        if (user == null) return (false, "用户不存在");

        string newHash = await Task.Run(() => BCrypt.Net.BCrypt.HashPassword(dto.NewPassword));

        await _db.Updateable<User>()
                 .SetColumns(u => u.Password == newHash)
                 .SetColumns(u => u.RefreshToken == null)
                 .SetColumns(u => u.RefreshTokenExpiryTime == null)
                 .Where(u => u.Id == dto.UserId)
                 .ExecuteCommandAsync();

        await _redis.StringSetAsync($"blocked:user:{dto.UserId}", "pwd_reset", TimeSpan.FromMinutes(20));
        _ = Task.Run(async () => {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var msgSvc = scope.ServiceProvider.GetRequiredService<IMessageService>();
                await msgSvc.PushUserStatusAsync(dto.UserId, 1, "管理员重置了您的密码");
            }
            catch (Exception ex) { LogBackgroundTaskError(ex); }
        });

        return (true, "密码已重置，用户已强制登出");
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "注册竞态冲突 | 用户名: {Username}")]
    private partial void LogRegistrationConflict(string username);

    [LoggerMessage(EventId = 2, Level = LogLevel.Warning, Message = "登录验证未通过 | 用户名: {Username} | IP: {IpAddress}")]
    private partial void LogLoginFailure(string username, string ipAddress);

    [LoggerMessage(EventId = 3, Level = LogLevel.Information, Message = "封禁用户登录 | 用户名: {Username}")]
    private partial void LogBannedUserLogin(string username);

    [LoggerMessage(EventId = 4, Level = LogLevel.Warning, Message = "续期失败 | 凭证失效")]
    private partial void LogTokenRefreshFailure();

    [LoggerMessage(EventId = 5, Level = LogLevel.Information, Message = "受限用户执行令牌续期 | 用户: {Username} | 状态: 只读模式")]
    private partial void LogBannedUserTokenRefresh(string username);

    [LoggerMessage(EventId = 6, Level = LogLevel.Error, Message = "后台异步消息推送失败")]
    private partial void LogBackgroundTaskError(Exception ex);
}