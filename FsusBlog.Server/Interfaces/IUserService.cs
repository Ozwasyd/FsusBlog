using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;

namespace FsusBlog.Server.Interfaces;

public interface IUserService
{
    /// <summary>
    /// 用户注册
    /// </summary>
    /// <param name="dto">注册信息</param>
    /// <returns>元组：是否成功，错误/成功信息</returns>
    Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto);

    /// <summary>
    /// 用户登录
    /// </summary>
    /// <param name="dto">登录信息</param>
    /// <returns>元组：是否成功，错误信息，生成的 Token</returns>
    Task<(bool Success, string Message, TokenResponseDto? Data, User? UserEntity)> LoginAsync(LoginDto dto, string clientIp);

    /// <summary>
    /// 根据 ID 获取用户信息（用于权限验证或个人资料）
    /// </summary>
    Task<User?> GetByIdAsync(int id);

    /// <summary>
    /// 根据用户名获取用户信息
    /// </summary>
    Task<User?> GetByUsernameAsync(string username);

    /// <summary>
    /// 更改用户名
    /// </summary>
    /// <param name="userId">用户ID（从Token解析）</param>
    /// <param name="newUsername">新用户名串</param>
    Task<(bool Success, string Message, TokenResponseDto? Data)> UpdateUsernameAsync(int userId, string newUsername);

    /// <summary>
    /// 更改密码
    /// </summary>
    /// <param name="userId">用户ID（从Token解析）</param>
    /// <param name="dto">新密码</param>
    Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto);

    /// <summary>
    /// 更改密码
    /// </summary>
    /// <param name="refreshToken">RefreshToken</param>
    Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken);

    /// <summary>
    /// 作废/删除指定的 RefreshToken
    /// </summary>
    /// <param name="refreshToken">要作废的 Token 字符串</param>
    /// <returns>是否操作成功</returns>
    Task<bool> RevokeRefreshTokenAsync(string refreshToken);

    Task<PageResult<UserListDto>> GetAdminUserListAsync(UserQueryDto dto);
    Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto);
    Task<(bool Success, string Message)> AdminResetPasswordAsync(AdminResetPwdDto dto);
}
