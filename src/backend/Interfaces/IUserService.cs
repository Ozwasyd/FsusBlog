using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;

namespace FsusBlog.Server.Interfaces;

public interface IUserService
{
    /// <summary>
    /// 根据 ID 获取用户信息（用于权限验证或个人资料）
    /// </summary>
    Task<User?> GetByIdAsync(int id);

    /// <summary>
    /// 刷新 Token
    /// </summary>
    /// <param name="refreshToken">RefreshToken</param>
    Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken);

    /// <summary>
    /// 作废/删除指定的 RefreshToken
    /// </summary>
    /// <param name="refreshToken">要作废的 Token 字符串</param>
    /// <returns>是否操作成功</returns>
    Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default);

    Task<PageResult<AdminAccountListItemDto>> GetAdminUserListAsync(UserQueryDto dto);
    Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto);
}
