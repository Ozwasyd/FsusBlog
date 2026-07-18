using System.Globalization;
using System.Runtime.CompilerServices;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// Extracts typed identity values from <see cref="ClaimsPrincipal"/> and treats invalid IDs as absent.
/// </summary>
public static class ClaimsPrincipalExtensions
{
    /// <summary>
    /// 从 Claims 中安全获取用户 ID (int)
    /// </summary>
    /// <returns>返回用户 ID，若解析失败则返回 0</returns>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static int GetUserId(this ClaimsPrincipal? user)
    {
        long? parsed = FastUserIdProvider.TryParseUserId(user);
        return parsed is > 0 and <= int.MaxValue ? (int)parsed.Value : 0;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string GetInternalAccountId(this ClaimsPrincipal? user)
        => user.GetUserId().ToString(CultureInfo.InvariantCulture);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string? GetSessionId(this ClaimsPrincipal? user)
    {
        return user?.FindFirst("sid")?.Value;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool TryGetAdminPrincipalId(this ClaimsPrincipal? user, out long adminId)
    {
        adminId = 0;
        string? value = user?.FindFirst("admin_id")?.Value;
        return long.TryParse(value, out adminId) && adminId > 0;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static string? GetAdminSessionId(this ClaimsPrincipal? user)
    {
        return user?.FindFirst("admin_sid")?.Value;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsAdminPrincipal(this ClaimsPrincipal? user)
    {
        return string.Equals(
            user?.FindFirst("identity_kind")?.Value,
            AnonymousIdentityRuntime.AdminPrincipalKind,
            StringComparison.Ordinal);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsAdminStepUpVerified(this ClaimsPrincipal? user)
    {
        return user?.FindFirst("admin_step_up")?.Value == "1";
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool HasAdminPermission(this ClaimsPrincipal? user, string permission)
    {
        return !string.IsNullOrWhiteSpace(permission) &&
            user?.Claims.Any(claim =>
                claim.Type == AdminPermissions.PermissionClaimType &&
                string.Equals(claim.Value, permission, StringComparison.Ordinal)) == true;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsMfaVerified(this ClaimsPrincipal? user)
    {
        return user?.FindFirst("mfa")?.Value == "1";
    }
}
