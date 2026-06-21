using System.Globalization;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamAdmissionService
{
    Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken);
}

internal sealed record NotificationStreamAdmissionResult(bool IsAllowed, int StatusCode, string? ErrorCode)
{
    public static NotificationStreamAdmissionResult Allowed { get; } = new(true, StatusCodes.Status200OK, null);

    public static NotificationStreamAdmissionResult Denied(int statusCode, string errorCode)
        => new(false, statusCode, errorCode);
}

internal sealed class NotificationStreamAdmissionService(
    IBlacklistService blacklistService,
    IUserAccountReader users) : INotificationStreamAdmissionService
{
    public async Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(userId) || !int.TryParse(userId, out int numericUserId))
        {
            return NotificationStreamAdmissionResult.Allowed;
        }

        UserAccountSnapshot? userSnapshot = await users.GetAccountByIdAsync(numericUserId);
        if (userSnapshot == null || userSnapshot.Value.DeletedAt.HasValue || userSnapshot.Value.Status == 2)
        {
            return NotificationStreamAdmissionResult.Denied(StatusCodes.Status401Unauthorized, "account_deleted");
        }

        string accountSubjectHash = string.IsNullOrWhiteSpace(userSnapshot.Value.AccountSubjectHash)
            ? AccountSubjectHasher.Create(
                userSnapshot.Value.IdentityKind,
                string.Concat("legacy-account:", numericUserId.ToString(CultureInfo.InvariantCulture)))
            : userSnapshot.Value.AccountSubjectHash;
        var banState = await blacklistService.GetBanStateAsync(numericUserId, accountSubjectHash);
        if (banState.IsBanned)
        {
            return NotificationStreamAdmissionResult.Denied(StatusCodes.Status423Locked, "account_blocked");
        }

        return NotificationStreamAdmissionResult.Allowed;
    }
}
