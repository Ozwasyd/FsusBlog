using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Fixtures;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Testing;

/// <summary>
/// Development/Test-only persistence adapter for the auth fixture lifecycle
/// application port. It exposes closed, owner-scoped transitions rather than
/// leaking SqlSugar to the producer or composition root.
/// </summary>
public sealed class SqlSugarAuthFixtureLifecycleRepository(
    ISqlSugarClient db) : IAuthFixtureLifecycleRepository
{
    public async Task<User?> FindUserByOwnedSubjectHashAsync(
        string accountSubjectHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<User>()
            .Where(item => item.AccountSubjectHash == accountSubjectHash)
            .FirstAsync();
    }

    public async Task<User?> FindUserByIdAsync(
        int userId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<User>().InSingleAsync(userId);
    }

    public async Task<bool> HasVerifiedMfaProfileAsync(
        int userId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<UserMfaProfile>()
            .Where(item => item.UserId == userId &&
                item.MfaVerifiedAt != null &&
                item.MfaSecretEncrypted != null &&
                item.MfaPendingSecretEncrypted == null)
            .AnyAsync();
    }

    public async Task<bool> HasUsedPasskeyCredentialAsync(
        int userId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<PasskeyCredential>()
            .Where(item => item.AccountId == userId &&
                item.SignCount > 0 &&
                item.LastUsedAt != null)
            .AnyAsync();
    }

    public async Task<bool> HasActiveRecoveryKeyAsync(
        int userId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<RecoveryKeyCredential>()
            .Where(item => item.AccountId == userId &&
                item.RevokedAt == null &&
                item.UsedAt == null)
            .AnyAsync();
    }

    public async Task<User> InsertOwnedUserAsync(
        User user,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (user.Id != 0 || string.IsNullOrWhiteSpace(user.PublicHandle) ||
            user.Status != 0 || user.DeletedAt.HasValue)
        {
            throw new InvalidOperationException(
                "owned auth fixture user initial state is invalid");
        }
        user.Id = await db.Insertable(user).ExecuteReturnIdentityAsync();
        return user;
    }

    public async Task<bool> TransitionOwnedUserToDeletedAsync(
        int userId,
        DateTime deletedAt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int updated = await db.Updateable<User>()
            .SetColumns(item => item.Status == 2)
            .SetColumns(item => item.RegistrationState == AccountRegistrationStates.Closed)
            .SetColumns(item => item.DeletedAt == deletedAt)
            .SetColumns(item => item.DeletedReason == "fixture_owned_transition")
            .Where(item => item.Id == userId && item.Status == 0 && item.DeletedAt == null)
            .ExecuteCommandAsync();
        return updated == 1;
    }

    public async Task<IReadOnlyList<UserSession>> ListUserSessionsAsync(
        int userId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<UserSession>()
            .Where(item => item.UserId == userId)
            .OrderBy(item => item.CreatedAt)
            .ToListAsync();
    }

    public async Task<IReadOnlyList<UserSession>> ListSessionsByIdsAsync(
        IReadOnlyList<string> sessionIds,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string[] exactIds = sessionIds.Distinct(StringComparer.Ordinal).ToArray();
        return await db.Queryable<UserSession>()
            .Where(item => exactIds.Contains(item.SessionId))
            .ToListAsync();
    }

    public async Task<UserSession?> FindSessionAsync(
        string sessionId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<UserSession>()
            .Where(item => item.SessionId == sessionId)
            .FirstAsync();
    }

    public async Task<bool> TransitionSessionToExpiredAsync(
        string sessionId,
        DateTime expiredAt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int updated = await db.Updateable<UserSession>()
            .SetColumns(item => item.IdleExpiresAt == expiredAt)
            .SetColumns(item => item.AbsoluteExpiresAt == expiredAt)
            .Where(item => item.SessionId == sessionId && item.RevokedAt == null)
            .ExecuteCommandAsync();
        return updated == 1;
    }

    public async Task<AdminPrincipal?> FindAdminByFixtureIdentityAsync(
        string fixtureIdentity,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<AdminPrincipal>()
            .Where(item => item.Handle == fixtureIdentity)
            .FirstAsync();
    }

    public async Task<AdminPrincipal?> FindAdminByIdAsync(
        long adminId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<AdminPrincipal>().InSingleAsync(adminId);
    }

    public async Task<AdminPrincipal> InsertOwnedAdminAsync(
        AdminPrincipal admin,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (admin.Id != 0 || admin.IsRoot || string.IsNullOrWhiteSpace(admin.Handle))
        {
            throw new InvalidOperationException(
                "owned auth fixture admin initial state is invalid");
        }
        admin.Id = await db.Insertable(admin).ExecuteReturnBigIdentityAsync();
        return admin;
    }

    public async Task<int> CountRootAdminsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<AdminPrincipal>()
            .Where(static item => item.IsRoot)
            .CountAsync();
    }
}
