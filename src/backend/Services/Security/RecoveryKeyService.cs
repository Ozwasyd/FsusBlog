using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public sealed record class RecoveryKeySession(
    int UserId,
    bool RevokePasskeys,
    DateTime IssuedAtUtc,
    DateTime ExpiresAtUtc);

public interface IRecoveryKeyService
{
    Task<Result<RecoveryKeyCreateResponseCoreModel>> CreateAsync(int userId, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeyCreateResponseCoreModel>> RotateAsync(int userId, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeyVerifyResponseCoreModel>> VerifyAsync(RecoveryKeyVerifyRequestCoreModel request, string clientIp, string? userAgent, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeySession>> GetRecoverySessionAsync(string token, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeySession>> ConsumeRecoverySessionAsync(string token, CancellationToken cancellationToken = default);
    Task ApplyPostPasskeyBindAsync(RecoveryKeySession session, CancellationToken cancellationToken = default);
}

public sealed class RecoveryKeyService(
    ISqlSugarClient db,
    IUnifiedCache cache,
    IConfiguration configuration) : IRecoveryKeyService
{
    private const int RecoveryKeyRandomBytes = 32;
    private const int RecoveryKeySaltBytes = 16;
    private const int RecoveryKeyHashBytes = 32;
    private const int RecoveryKeyPbkdf2Iterations = 210_000;
    private const int MaxFailedAttempts = 8;
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RecoverySessionTtl = TimeSpan.FromMinutes(10);

    public Task<Result<RecoveryKeyCreateResponseCoreModel>> CreateAsync(int userId, CancellationToken cancellationToken = default)
        => CreateOrRotateAsync(userId, rotate: false, cancellationToken);

    public Task<Result<RecoveryKeyCreateResponseCoreModel>> RotateAsync(int userId, CancellationToken cancellationToken = default)
        => CreateOrRotateAsync(userId, rotate: true, cancellationToken);

    public async Task<Result<RecoveryKeyVerifyResponseCoreModel>> VerifyAsync(
        RecoveryKeyVerifyRequestCoreModel request,
        string clientIp,
        string? userAgent,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (request.UserId <= 0 || string.IsNullOrWhiteSpace(request.RecoveryKey))
        {
            return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Validation, "RECOVERY_KEY_REQUEST_INVALID");
        }

        string attemptIdentity = BuildAttemptIdentity(request.UserId, clientIp, userAgent);
        if (await IsVerificationLockedAsync(attemptIdentity, cancellationToken).ConfigureAwait(false))
        {
            return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Forbidden, "RECOVERY_KEY_RATE_LIMITED");
        }

        RecoveryKeyCredential? credential = await db.Queryable<RecoveryKeyCredential>()
            .Where(k => k.UserId == request.UserId && k.UsedAt == null && k.RevokedAt == null)
            .OrderBy(k => k.KeyVersion, OrderByType.Desc)
            .FirstAsync();
        if (credential is null)
        {
            return await RecordVerificationFailureAsync(attemptIdentity, cancellationToken).ConfigureAwait(false);
        }

        byte[] pepper = ResolveRecoveryKeyPepper();
        if (!VerifyRecoveryKey(request.RecoveryKey, credential.KeyHash, pepper))
        {
            return await RecordVerificationFailureAsync(attemptIdentity, cancellationToken).ConfigureAwait(false);
        }

        DateTime now = DateTime.UtcNow;
        int consumed = await db.Updateable<RecoveryKeyCredential>()
            .SetColumns(k => k.UsedAt == now)
            .Where(k => k.Id == credential.Id && k.UsedAt == null && k.RevokedAt == null)
            .ExecuteCommandAsync();
        if (consumed <= 0)
        {
            return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Unauthorized, "RECOVERY_KEY_ALREADY_USED");
        }

        await db.Updateable<User>()
            .SetColumns(u => u.RecoveryEnabled == false)
            .Where(u => u.Id == request.UserId)
            .ExecuteCommandAsync();

        if (request.RevokeSessions)
        {
            await db.Updateable<UserSession>()
                .SetColumns(s => s.RevokedAt == now)
                .SetColumns(s => s.RevokeReason == "recovery_key_verified")
                .Where(s => s.UserId == request.UserId && s.RevokedAt == null)
                .ExecuteCommandAsync();
        }

        string token = GenerateSecretToken();
        DateTime expiresAt = now.Add(RecoverySessionTtl);
        var session = new RecoveryKeySession(request.UserId, request.RevokePasskeys, now, expiresAt);
        await cache.SetStringAsync(
            CachePolicyId.SecurityRecoveryKeySession,
            BuildSessionIdentity(token),
            EncodeSession(session),
            RecoverySessionTtl,
            cancellationToken).ConfigureAwait(false);

        return Result<RecoveryKeyVerifyResponseCoreModel>.Success(
            new RecoveryKeyVerifyResponseCoreModel(request.UserId, token, expiresAt));
    }

    public async Task<Result<RecoveryKeySession>> GetRecoverySessionAsync(string token, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return Result<RecoveryKeySession>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_INVALID");
        }

        string? encoded = await cache.GetStringAsync(
            CachePolicyId.SecurityRecoveryKeySession,
            BuildSessionIdentity(token),
            cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(encoded) || !TryDecodeSession(encoded, out RecoveryKeySession? session) || session is null)
        {
            return Result<RecoveryKeySession>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_INVALID");
        }

        RecoveryKeySession resolvedSession = session;
        if (resolvedSession.ExpiresAtUtc <= DateTime.UtcNow)
        {
            await cache.RemoveAsync(CachePolicyId.SecurityRecoveryKeySession, BuildSessionIdentity(token), cancellationToken).ConfigureAwait(false);
            return Result<RecoveryKeySession>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_EXPIRED");
        }

        return Result<RecoveryKeySession>.Success(resolvedSession);
    }

    public async Task<Result<RecoveryKeySession>> ConsumeRecoverySessionAsync(string token, CancellationToken cancellationToken = default)
    {
        Result<RecoveryKeySession> session = await GetRecoverySessionAsync(token, cancellationToken).ConfigureAwait(false);
        if (!session.IsSuccess || session.Value is null)
        {
            return session;
        }

        bool consumed = await cache.ConsumeOnceAsync(
            CachePolicyId.SecurityRecoveryKeySession,
            BuildSessionIdentity(token),
            cancellationToken).ConfigureAwait(false);
        return consumed
            ? session
            : Result<RecoveryKeySession>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_INVALID");
    }

    public async Task ApplyPostPasskeyBindAsync(RecoveryKeySession session, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (session.RevokePasskeys)
        {
            await db.Deleteable<PasskeyCredential>()
                .Where(c => c.UserId == session.UserId && c.CreatedAt < session.IssuedAtUtc)
                .ExecuteCommandAsync();
        }

        await db.Updateable<User>()
            .SetColumns(u => u.PasskeyEnabled == true)
            .Where(u => u.Id == session.UserId)
            .ExecuteCommandAsync();
    }

    private async Task<Result<RecoveryKeyCreateResponseCoreModel>> CreateOrRotateAsync(int userId, bool rotate, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await db.Queryable<User>().InSingleAsync(userId);
        if (user is null || user.DeletedAt.HasValue || user.Status == 2)
        {
            return Result<RecoveryKeyCreateResponseCoreModel>.Failure(ErrorCode.NotFound, "用户不存在");
        }

        DateTime now = DateTime.UtcNow;
        RecoveryKeyCredential? active = await db.Queryable<RecoveryKeyCredential>()
            .Where(k => k.UserId == userId && k.UsedAt == null && k.RevokedAt == null)
            .OrderBy(k => k.KeyVersion, OrderByType.Desc)
            .FirstAsync();
        if (active is not null && !rotate)
        {
            return Result<RecoveryKeyCreateResponseCoreModel>.Failure(ErrorCode.Conflict, "RECOVERY_KEY_ALREADY_EXISTS");
        }

        int latestVersion = await db.Queryable<RecoveryKeyCredential>()
            .Where(k => k.UserId == userId)
            .MaxAsync(k => k.KeyVersion);
        int nextVersion = Math.Max(latestVersion, 0) + 1;

        if (rotate)
        {
            await db.Updateable<RecoveryKeyCredential>()
                .SetColumns(k => k.RevokedAt == now)
                .Where(k => k.UserId == userId && k.UsedAt == null && k.RevokedAt == null)
                .ExecuteCommandAsync();
        }

        string recoveryKey = GenerateRecoveryKey();
        byte[] pepper = ResolveRecoveryKeyPepper();
        var credential = new RecoveryKeyCredential
        {
            UserId = userId,
            KeyHash = HashRecoveryKey(recoveryKey, pepper),
            KeyVersion = nextVersion,
            CreatedAt = now
        };

        await db.Insertable(credential).ExecuteCommandAsync();
        await db.Updateable<User>()
            .SetColumns(u => u.RecoveryEnabled == true)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

        return Result<RecoveryKeyCreateResponseCoreModel>.Success(
            new RecoveryKeyCreateResponseCoreModel(recoveryKey, nextVersion, now));
    }

    private async Task<bool> IsVerificationLockedAsync(string identity, CancellationToken cancellationToken)
    {
        string? value = await cache.GetStringAsync(CachePolicyId.SecurityRecoveryKeyAttempt, identity, cancellationToken).ConfigureAwait(false);
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int attempts) && attempts >= MaxFailedAttempts;
    }

    private async Task<Result<RecoveryKeyVerifyResponseCoreModel>> RecordVerificationFailureAsync(string identity, CancellationToken cancellationToken)
    {
        long attempts = await cache.IncrementWithExpiryAsync(
            CachePolicyId.SecurityRecoveryKeyAttempt,
            identity,
            FailureWindow,
            1,
            cancellationToken).ConfigureAwait(false);
        if (attempts >= MaxFailedAttempts)
        {
            return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Forbidden, "RECOVERY_KEY_RATE_LIMITED");
        }

        return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Unauthorized, "RECOVERY_KEY_INVALID");
    }

    private byte[] ResolveRecoveryKeyPepper()
    {
        string? value = configuration["Security:RecoveryKeyPepper"]
            ?? configuration["RecoveryKeyPepper"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RECOVERY_KEY_PEPPER")
            ?? configuration["Jwt:SecretKey"];
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException("RecoveryKeyPepper is not configured.");
        }

        return Encoding.UTF8.GetBytes(value);
    }

    private static string GenerateRecoveryKey()
        => "frk_" + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(RecoveryKeyRandomBytes));

    private static string GenerateSecretToken()
        => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(RecoveryKeyRandomBytes));

    private static string HashRecoveryKey(string recoveryKey, byte[] pepper)
    {
        byte[] salt = RandomNumberGenerator.GetBytes(RecoveryKeySaltBytes);
        byte[] prehash = HMACSHA256.HashData(pepper, Encoding.UTF8.GetBytes(NormalizeRecoveryKey(recoveryKey)));
        byte[] digest = Rfc2898DeriveBytes.Pbkdf2(prehash, salt, RecoveryKeyPbkdf2Iterations, HashAlgorithmName.SHA256, RecoveryKeyHashBytes);
        return string.Join(
            '$',
            "v1",
            "pbkdf2-sha256",
            RecoveryKeyPbkdf2Iterations.ToString(CultureInfo.InvariantCulture),
            Convert.ToHexString(salt),
            Convert.ToHexString(digest));
    }

    private static bool VerifyRecoveryKey(string recoveryKey, string storedHash, byte[] pepper)
    {
        string[] parts = storedHash.Split('$');
        if (parts.Length != 5 ||
            !string.Equals(parts[0], "v1", StringComparison.Ordinal) ||
            !string.Equals(parts[1], "pbkdf2-sha256", StringComparison.Ordinal) ||
            !int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out int iterations))
        {
            return false;
        }

        try
        {
            byte[] salt = Convert.FromHexString(parts[3]);
            byte[] expected = Convert.FromHexString(parts[4]);
            if (salt.Length != RecoveryKeySaltBytes || expected.Length != RecoveryKeyHashBytes)
            {
                return false;
            }

            byte[] prehash = HMACSHA256.HashData(pepper, Encoding.UTF8.GetBytes(NormalizeRecoveryKey(recoveryKey)));
            byte[] actual = Rfc2898DeriveBytes.Pbkdf2(prehash, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static string NormalizeRecoveryKey(string value)
        => value.Trim();

    private static string BuildAttemptIdentity(int userId, string clientIp, string? userAgent)
    {
        string material = string.Concat(
            userId.ToString(CultureInfo.InvariantCulture),
            ':',
            clientIp,
            ':',
            userAgent ?? string.Empty);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material)))[..32];
    }

    private static string BuildSessionIdentity(string token)
        => $"token:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))[..32]}";

    private static string EncodeSession(RecoveryKeySession session)
        => string.Join(
            '|',
            session.UserId.ToString(CultureInfo.InvariantCulture),
            session.RevokePasskeys ? "1" : "0",
            session.IssuedAtUtc.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
            session.ExpiresAtUtc.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture));

    private static bool TryDecodeSession(string value, out RecoveryKeySession? session)
    {
        session = null;
        string[] parts = value.Split('|');
        if (parts.Length != 4 ||
            !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out int userId) ||
            !long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out long issuedTicks) ||
            !long.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out long expiresTicks))
        {
            return false;
        }

        if (userId <= 0 || (parts[1] != "0" && parts[1] != "1"))
        {
            return false;
        }

        session = new RecoveryKeySession(
            userId,
            parts[1] == "1",
            new DateTime(issuedTicks, DateTimeKind.Utc),
            new DateTime(expiresTicks, DateTimeKind.Utc));
        return true;
    }
}
