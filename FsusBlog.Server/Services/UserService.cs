using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using SqlSugar;
using StackExchange.Redis;
using System.Text.RegularExpressions;
namespace FsusBlog.Server.Services;

/// <summary>
/// 用户服务
/// </summary>
public partial class UserService(
    ISqlSugarClient _db,
    ILogger<UserService> _logger,
    IJwtHelper _jwtHelper,
    IConnectionMultiplexer _redisMultiplexer,
    IBlacklistService _blacklistService,
    IMessageService _messageService) : IUserService
{
    private readonly IDatabase _redis = _redisMultiplexer.GetDatabase();

    // 使用编译期生成的正则引擎 (需要 partial class)
    [GeneratedRegex(@"^[\u4e00-\u9fa5a-zA-Z]+$")]
    private static partial Regex UsernameRegex();

    /// <summary>
    /// 用户注册 (Success, Message)
    /// </summary>
    public async Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto)
    {
        if (dto.Password != dto.ConfirmPassword)
            return (false, "两次输入的密码不一致");

        // 2. 数据清洗与规范化：去除首尾空格并统一转小写
        // PostgreSQL 大小写敏感，统一转小写可实现"逻辑上的大小写不敏感"
        string normalizedUsername = dto.Username.Trim().ToLowerInvariant();

        // 3. 安全性保障：Service 层二次正则校验（防止绕过前端/DTO）
        if (!UsernameRegex().IsMatch(normalizedUsername))
        {
            return (false, "用户名格式非法，仅允许中英文");
        }

        // 业务层预检 (使用清洗后的用户名)
        if (await _db.Queryable<User>().AnyAsync(u => u.Username == normalizedUsername))
            return (false, "用户名已存在");

        var newUser = new User
        {
            Username = normalizedUsername, // 存入小写
            Password = BCrypt.Net.BCrypt.HashPassword(dto.Password),
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
            _logger.LogWarning("注册竞态冲突 | 用户名: {Username}", normalizedUsername);
            return (false, "用户名已被占用");
        }
    }

    /// <summary>
    /// 用户登录 (适配限制性治理企划)
    /// </summary>
    public async Task<(bool Success, string Message, TokenResponseDto? Data, User? UserEntity)> LoginAsync(LoginDto dto, string clientIp)
    {
        // 逻辑自洽：登录时也必须转小写，否则无法匹配到注册时存入的数据
        string normalizedUsername = dto.Username.Trim().ToLowerInvariant();

        // 1. 获取用户信息
        var user = await _db.Queryable<User>().FirstAsync(u => u.Username == normalizedUsername);

        // 2. 基础账号密码校验
        if (user == null || !BCrypt.Net.BCrypt.Verify(dto.Password, user.Password))
        {
            _logger.LogWarning("登录验证未通过 | 用户名: {Username} | IP: {IP}", normalizedUsername, clientIp);
            return (false, "用户名或密码错误", null, null);
        }

        // 允许封禁用户登录。此处仅记录审计日志，不中断流程。
        if (user.Status == 1)
        {
            _logger.LogInformation("封禁用户登录 | 用户名: {Username} | 状态: 只读受限", normalizedUsername);
        }

        // 签发双令牌
        var accessToken = _jwtHelper.GenerateAccessToken(user);
        var refreshToken = _jwtHelper.GenerateRefreshToken();

        // 更新审计信息与会话凭证
        user.RefreshToken = refreshToken;
        user.RefreshTokenExpiryTime = DateTime.UtcNow.AddDays(7);
        user.LastLoginTime = DateTime.UtcNow;
        user.LastLoginIp = clientIp;

        await _db.Updateable(user)
            .UpdateColumns(it => new
            {
                it.RefreshToken,
                it.RefreshTokenExpiryTime,
                it.LastLoginTime,
                it.LastLoginIp
            })
            .ExecuteCommandAsync();

        return (true, "登录成功", new TokenResponseDto
        {
            AccessToken = accessToken,
            RefreshToken = refreshToken
        }, user);
    }

    public async Task<User?> GetByIdAsync(int id) => await _db.Queryable<User>().InSingleAsync(id);

    public async Task<User?> GetByUsernameAsync(string username)
    {
        if (string.IsNullOrWhiteSpace(username)) return null;
        // 归一化查询
        return await _db.Queryable<User>().FirstAsync(u => u.Username == username.Trim().ToLowerInvariant());
    }

    /// <summary>
    /// 更改用户名 (Success, Message, Data)
    /// </summary>
    public async Task<(bool Success, string Message, TokenResponseDto? Data)> UpdateUsernameAsync(int userId, string newUsername)
    {
        // 1. 归一化处理
        string normalizedUsername = newUsername.Trim().ToLowerInvariant();

        // 2. 正则校验
        if (!UsernameRegex().IsMatch(normalizedUsername))
            return (false, "用户名格式非法，仅允许中英文", null);

        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null) return (false, "用户不存在", null);

        // 30天频率限制逻辑
        if (user.LastUsernameUpdateTime.HasValue &&
            (DateTime.UtcNow - user.LastUsernameUpdateTime.Value).TotalDays < 30)
        {
            var remain = Math.Ceiling(30 - (DateTime.UtcNow - user.LastUsernameUpdateTime.Value).TotalDays);
            return (false, $"修改过于频繁，请在 {remain} 天后再试", null);
        }

        // 查重时使用归一化后的名称
        if (await _db.Queryable<User>().AnyAsync(u => u.Username == normalizedUsername && u.Id != userId))
            return (false, "该用户名已被占用", null);

        user.Username = normalizedUsername;
        user.LastUsernameUpdateTime = DateTime.UtcNow;

        var result = await _db.Updateable(user)
            .UpdateColumns(u => new { u.Username, u.LastUsernameUpdateTime })
            .ExecuteCommandAsync();

        if (result > 0)
        {
            return (true, "修改成功", new TokenResponseDto
            {
                AccessToken = _jwtHelper.GenerateAccessToken(user),
                RefreshToken = user.RefreshToken ?? ""
            });
        }

        return (false, "修改失败", null);
    }

    // ... UpdatePasswordAsync, RefreshTokenAsync, RevokeRefreshTokenAsync, GetAdminUserListAsync, AdminChangeStatusAsync, AdminResetPasswordAsync 保持原样 ...
    // (由于篇幅限制且这些方法未改动逻辑，此处省略重复代码，请保留原有的实现)
    public async Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto)
    {
        if (dto.NewPassword != dto.ConfirmPassword)
            return (false, "两次输入的新密码不一致");

        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null || !BCrypt.Net.BCrypt.Verify(dto.OldPassword, user.Password))
            return (false, "旧密码验证失败");

        string newHash = BCrypt.Net.BCrypt.HashPassword(dto.NewPassword);

        var success = await _db.Updateable<User>()
            .SetColumns(u => new User
            {
                Password = newHash,
                RefreshToken = null,
                RefreshTokenExpiryTime = null
            })
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync() > 0;

        return success ? (true, "密码修改成功") : (false, "操作失败");
    }

    public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken)
    {
        var user = await _db.Queryable<User>().FirstAsync(u => u.RefreshToken == refreshToken);

        if (user == null || user.RefreshTokenExpiryTime < DateTime.UtcNow)
        {
            _logger.LogWarning("续期失败 | 刷新凭证已失效或不存在");
            return (false, null);
        }

        if (user.Status == 1)
        {
            _logger.LogInformation("受限用户执行令牌续期 | 用户: {Username} | 状态: 只读模式", user.Username);
        }

        var newAccessToken = _jwtHelper.GenerateAccessToken(user);
        var newRefreshToken = _jwtHelper.GenerateRefreshToken();

        user.RefreshToken = newRefreshToken;
        user.RefreshTokenExpiryTime = DateTime.UtcNow.AddDays(7);

        await _db.Updateable(user)
            .UpdateColumns(it => new { it.RefreshToken, it.RefreshTokenExpiryTime })
            .ExecuteCommandAsync();

        return (true, new TokenResponseDto
        {
            AccessToken = newAccessToken,
            RefreshToken = newRefreshToken
        });
    }

    public async Task<bool> RevokeRefreshTokenAsync(string refreshToken)
    {
        if (string.IsNullOrWhiteSpace(refreshToken)) return false;

        return await _db.Updateable<User>()
            .SetColumns(it => new User { RefreshToken = null, RefreshTokenExpiryTime = null })
            .Where(it => it.RefreshToken == refreshToken)
            .ExecuteCommandAsync() > 0;
    }

    public async Task<PageResult<UserListDto>> GetAdminUserListAsync(UserQueryDto dto)
    {
        RefAsync<int> total = 0;

        var list = await _db.Queryable<User>()
            .WhereIF(!string.IsNullOrWhiteSpace(dto.Keyword), u => u.Username.Contains(dto.Keyword!))
            .WhereIF(dto.Status.HasValue, u => u.Status == dto.Status)
            .OrderByDescending(u => u.CreateTime)
            .Select(u => new UserListDto
            {
                Id = u.Id,
                Username = u.Username,
                Role = u.Role,
                Status = u.Status,
                CreateTime = u.CreateTime,
                LastLoginIp = u.LastLoginIp,
                LastLoginTime = u.LastLoginTime
            })
            .ToPageListAsync(dto.Page, dto.PageSize, total);

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

        string? effectiveReason = dto.Status == 1
            ? (string.IsNullOrWhiteSpace(dto.Reason) ? "违反社区规定" : dto.Reason)
            : null;

        await _db.Updateable<User>()
                .SetColumns(u => new User { Status = dto.Status, BanReason = effectiveReason })
                .Where(u => u.Id == dto.UserId)
                .ExecuteCommandAsync();

        if (dto.Status == 1)
        {
            await _blacklistService.BanUserAsync(dto.UserId, effectiveReason!);
            await _messageService.SendUserBannedNoticeAsync(dto.UserId, effectiveReason!);
        }
        else
        {
            await _blacklistService.UnbanUserAsync(dto.UserId);
            await _messageService.SendUserUnbannedNoticeAsync(dto.UserId);
        }

        return (true, dto.Status == 1 ? "用户已封禁（只读模式）" : "用户已解封并下发通知");
    }

    public async Task<(bool Success, string Message)> AdminResetPasswordAsync(AdminResetPwdDto dto)
    {
        var user = await _db.Queryable<User>().InSingleAsync(dto.UserId);
        if (user == null) return (false, "用户不存在");

        string newHash = BCrypt.Net.BCrypt.HashPassword(dto.NewPassword);

        user.Password = newHash;
        user.RefreshToken = null;
        user.RefreshTokenExpiryTime = null;

        await _db.Updateable(user)
                 .UpdateColumns(u => new { u.Password, u.RefreshToken, u.RefreshTokenExpiryTime })
                 .ExecuteCommandAsync();

        await _redis.StringSetAsync($"blocked:user:{dto.UserId}", "pwd_reset", TimeSpan.FromMinutes(20));
        await _messageService.PushUserStatusAsync(dto.UserId, 1, "管理员重置了您的密码，请重新登录");

        return (true, "密码已重置，该用户已被强制登出");
    }
}