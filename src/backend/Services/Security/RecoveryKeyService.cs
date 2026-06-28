using System.Buffers.Text;
using System.Data.Common;
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
    int AccountId,
    bool RevokePasskeys,
    DateTime IssuedAtUtc,
    DateTime ExpiresAtUtc);

public interface IRecoveryKeyService
{
    Task<Result<RecoveryKeyCreateResponseCoreModel>> CreateAsync(int accountId, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeyCreateResponseCoreModel>> RotateAsync(int accountId, CancellationToken cancellationToken = default);
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
    private const string RecoveryKeyPrefix = "frk_";
    private const char RecoveryKeySeparator = '_';
    private const int RecoveryKeyLookupBytes = 16;
    private const int RecoveryKeyRandomBytes = 32;
    private const int RecoveryKeySaltBytes = 16;
    private const int RecoveryKeyHashBytes = 32;
    private const int RecoveryKeyPbkdf2Iterations = 210_000;
    private const int MaxRecoveryKeyChars = 256;
    private const int MaxFailedAttempts = 8;
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RecoverySessionTtl = TimeSpan.FromMinutes(10);

    public Task<Result<RecoveryKeyCreateResponseCoreModel>> CreateAsync(int accountId, CancellationToken cancellationToken = default)
        => CreateOrRotateAsync(accountId, rotate: false, cancellationToken);

    public Task<Result<RecoveryKeyCreateResponseCoreModel>> RotateAsync(int accountId, CancellationToken cancellationToken = default)
        => CreateOrRotateAsync(accountId, rotate: true, cancellationToken);

    public async Task<Result<RecoveryKeyVerifyResponseCoreModel>> VerifyAsync(
        RecoveryKeyVerifyRequestCoreModel request,
        string clientIp,
        string? userAgent,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(request.RecoveryKey))
        {
            return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Validation, "RECOVERY_KEY_REQUEST_INVALID");
        }

        string normalized = NormalizeRecoveryKey(request.RecoveryKey);
        if (normalized.Length == 0 || normalized.Length > MaxRecoveryKeyChars)
        {
            return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Validation, "RECOVERY_KEY_INVALID");
        }

        byte[] pepper = ResolveRecoveryKeyPepper();
        bool hasLookup = TryParseRecoveryKeyLookup(normalized, pepper, out string lookupIdHash);
        string attemptIdentity = BuildAttemptIdentity(
            hasLookup ? lookupIdHash : HashRecoveryKeyAttemptIdentity(normalized, pepper));
        if (await IsVerificationLockedAsync(attemptIdentity, cancellationToken).ConfigureAwait(false))
        {
            return Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Forbidden, "RECOVERY_KEY_RATE_LIMITED");
        }

        if (!hasLookup)
        {
            return await RecordVerificationFailureAsync(attemptIdentity, cancellationToken).ConfigureAwait(false);
        }

        Result<RecoveryKeyVerifyResponseCoreModel>? transactionResult = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            RecoveryKeyCredential? credential = await LoadRecoveryKeyCredentialForUpdateAsync(lookupIdHash, cancellationToken).ConfigureAwait(false);
            if (credential is null)
            {
                transactionResult = await RecordVerificationFailureAsync(attemptIdentity, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (!VerifyRecoveryKey(normalized, credential.KeyHash, pepper))
            {
                transactionResult = await RecordVerificationFailureAsync(attemptIdentity, cancellationToken).ConfigureAwait(false);
                return;
            }

            DateTime now = DateTime.UtcNow;
            int consumed = await db.Updateable<RecoveryKeyCredential>()
                .SetColumns(k => k.UsedAt == now)
                .Where(k => k.Id == credential.Id && k.UsedAt == null && k.RevokedAt == null)
                .ExecuteCommandAsync();
            if (consumed <= 0)
            {
                transactionResult = Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Unauthorized, "RECOVERY_KEY_ALREADY_USED");
                return;
            }

            await db.Updateable<User>()
                .SetColumns(u => u.RecoveryEnabled == false)
                .Where(u => u.Id == credential.AccountId)
                .ExecuteCommandAsync();

            if (request.RevokeSessions)
            {
                await db.Updateable<UserSession>()
                    .SetColumns(s => s.RevokedAt == now)
                    .SetColumns(s => s.RevokeReason == "recovery_key_verified")
                    .Where(s => s.UserId == credential.AccountId && s.RevokedAt == null)
                    .ExecuteCommandAsync();
            }

            string token = GenerateSecretToken();
            DateTime expiresAt = now.Add(RecoverySessionTtl);
            var session = new RecoveryKeySession(credential.AccountId, request.RevokePasskeys, now, expiresAt);
            await cache.SetStringAsync(
                CachePolicyId.SecurityRecoveryKeySession,
                BuildSessionIdentity(token),
                EncodeSession(session),
                RecoverySessionTtl,
                cancellationToken).ConfigureAwait(false);

            transactionResult = Result<RecoveryKeyVerifyResponseCoreModel>.Success(
                new RecoveryKeyVerifyResponseCoreModel(token, expiresAt));
        });
        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException ?? new InvalidOperationException("Recovery key verification transaction failed.");
        }

        return transactionResult ?? Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Unauthorized, "RECOVERY_KEY_INVALID");
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
                .Where(c => c.AccountId == session.AccountId && c.CreatedAt < session.IssuedAtUtc)
                .ExecuteCommandAsync();
        }

        await db.Updateable<User>()
            .SetColumns(u => u.PasskeyEnabled == true)
            .Where(u => u.Id == session.AccountId)
            .ExecuteCommandAsync();
    }

    private async Task<Result<RecoveryKeyCreateResponseCoreModel>> CreateOrRotateAsync(int accountId, bool rotate, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await db.Queryable<User>().InSingleAsync(accountId);
        if (user is null || user.DeletedAt.HasValue || user.Status == 2)
        {
            return Result<RecoveryKeyCreateResponseCoreModel>.Failure(ErrorCode.NotFound, "用户不存在");
        }

        DateTime now = DateTime.UtcNow;
        RecoveryKeyCredential? active = await db.Queryable<RecoveryKeyCredential>()
            .Where(k => k.AccountId == accountId && k.UsedAt == null && k.RevokedAt == null)
            .OrderBy(k => k.KeyVersion, OrderByType.Desc)
            .FirstAsync();
        if (active is not null && !rotate)
        {
            return Result<RecoveryKeyCreateResponseCoreModel>.Failure(ErrorCode.Conflict, "RECOVERY_KEY_ALREADY_EXISTS");
        }

        int latestVersion = await db.Queryable<RecoveryKeyCredential>()
            .Where(k => k.AccountId == accountId)
            .MaxAsync(k => k.KeyVersion);
        int nextVersion = Math.Max(latestVersion, 0) + 1;

        if (rotate)
        {
            await db.Updateable<RecoveryKeyCredential>()
                .SetColumns(k => k.RevokedAt == now)
                .Where(k => k.AccountId == accountId && k.UsedAt == null && k.RevokedAt == null)
                .ExecuteCommandAsync();
        }

        byte[] pepper = ResolveRecoveryKeyPepper();
        var generated = GenerateRecoveryKey(pepper);
        var credential = new RecoveryKeyCredential
        {
            AccountId = accountId,
            LookupIdHash = generated.LookupIdHash,
            KeyHash = HashRecoveryKey(generated.RecoveryKey, pepper),
            KeyVersion = nextVersion,
            CreatedAt = now
        };

        await db.Insertable(credential).ExecuteCommandAsync();
        await db.Updateable<User>()
            .SetColumns(u => u.RecoveryEnabled == true)
            .Where(u => u.Id == accountId)
            .ExecuteCommandAsync();

        return Result<RecoveryKeyCreateResponseCoreModel>.Success(
            new RecoveryKeyCreateResponseCoreModel(generated.RecoveryKey, nextVersion, now));
    }

    private async Task<bool> IsVerificationLockedAsync(string identity, CancellationToken cancellationToken)
    {
        string? value = await cache.GetStringAsync(CachePolicyId.SecurityRecoveryKeyAttempt, identity, cancellationToken).ConfigureAwait(false);
        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int attempts) && attempts >= MaxFailedAttempts;
    }

    private async Task<RecoveryKeyCredential?> LoadRecoveryKeyCredentialForUpdateAsync(
        string lookupIdHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id,
                   account_id,
                   lookup_id_hash,
                   key_hash,
                   key_version,
                   created_at,
                   used_at,
                   revoked_at
            FROM account_recovery_key
            WHERE lookup_id_hash = @LookupIdHash
              AND used_at IS NULL
              AND revoked_at IS NULL
            ORDER BY key_version DESC
            LIMIT 1
            FOR UPDATE;
            """,
            new SugarParameter("@LookupIdHash", lookupIdHash));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new RecoveryKeyCredential
        {
            Id = reader.GetInt32(0),
            AccountId = reader.GetInt32(1),
            LookupIdHash = reader.IsDBNull(2) ? null : reader.GetString(2),
            KeyHash = reader.GetString(3),
            KeyVersion = reader.GetInt32(4),
            CreatedAt = reader.GetDateTime(5),
            UsedAt = reader.IsDBNull(6) ? null : reader.GetDateTime(6),
            RevokedAt = reader.IsDBNull(7) ? null : reader.GetDateTime(7)
        };
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
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RECOVERY_KEY_PEPPER");
        if (string.IsNullOrWhiteSpace(value) || value.Trim().Length < 32)
        {
            throw new InvalidOperationException("Security:RecoveryKeyPepper is not configured with at least 32 characters.");
        }

        return Encoding.UTF8.GetBytes(value.Trim());
    }

    private static RecoveryKeyGeneration GenerateRecoveryKey(byte[] pepper)
    {
        string lookupId = Convert.ToHexString(RandomNumberGenerator.GetBytes(RecoveryKeyLookupBytes)).ToLowerInvariant();
        string secret = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(RecoveryKeyRandomBytes));
        string recoveryKey = string.Concat(RecoveryKeyPrefix, lookupId, RecoveryKeySeparator, secret);
        return new RecoveryKeyGeneration(recoveryKey, HashRecoveryKeyLookupId(lookupId, pepper));
    }

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
    {
        string normalized = value.Trim();
        if (normalized.Length > MaxRecoveryKeyChars)
        {
            return normalized;
        }

        return normalized;
    }

    private static bool TryParseRecoveryKeyLookup(string recoveryKey, byte[] pepper, out string lookupIdHash)
    {
        lookupIdHash = string.Empty;
        string normalized = NormalizeRecoveryKey(recoveryKey);
        if (!normalized.StartsWith(RecoveryKeyPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> body = normalized.AsSpan(RecoveryKeyPrefix.Length);
        int separator = body.IndexOf(RecoveryKeySeparator);
        if (separator <= 0 || separator >= body.Length - 1)
        {
            return false;
        }

        ReadOnlySpan<char> lookupId = body[..separator];
        ReadOnlySpan<char> secret = body[(separator + 1)..];
        if (lookupId.Length != RecoveryKeyLookupBytes * 2 ||
            !IsHexToken(lookupId) ||
            !IsBase64UrlToken(secret))
        {
            return false;
        }

        lookupIdHash = HashRecoveryKeyLookupId(lookupId.ToString(), pepper);
        return true;
    }

    private static bool IsHexToken(ReadOnlySpan<char> value)
    {
        if (value.IsEmpty)
        {
            return false;
        }

        foreach (char c in value)
        {
            if (!((c >= '0' && c <= '9') ||
                  (c >= 'a' && c <= 'f') ||
                  (c >= 'A' && c <= 'F')))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsBase64UrlToken(ReadOnlySpan<char> value)
    {
        if (value.IsEmpty)
        {
            return false;
        }

        foreach (char c in value)
        {
            if (!((c >= 'A' && c <= 'Z') ||
                  (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') ||
                  c is '-' or '_'))
            {
                return false;
            }
        }

        return true;
    }

    private static string HashRecoveryKeyLookupId(string lookupId, byte[] pepper)
        => Convert.ToHexString(HMACSHA256.HashData(
            pepper,
            Encoding.UTF8.GetBytes("recovery-key-lookup:" + lookupId.Trim())));

    private static string HashRecoveryKeyAttemptIdentity(string recoveryKey, byte[] pepper)
        => Convert.ToHexString(HMACSHA256.HashData(
            pepper,
            Encoding.UTF8.GetBytes("recovery-key-attempt:" + NormalizeRecoveryKey(recoveryKey))))[..32];

    private static string BuildAttemptIdentity(string lookupIdentity)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(lookupIdentity)))[..32];

    private static string BuildSessionIdentity(string token)
        => $"token:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))[..32]}";

    private static string EncodeSession(RecoveryKeySession session)
        => string.Join(
            '|',
            session.AccountId.ToString(CultureInfo.InvariantCulture),
            session.RevokePasskeys ? "1" : "0",
            session.IssuedAtUtc.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
            session.ExpiresAtUtc.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture));

    private static bool TryDecodeSession(string value, out RecoveryKeySession? session)
    {
        session = null;
        string[] parts = value.Split('|');
        if (parts.Length != 4 ||
            !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out int accountId) ||
            !long.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out long issuedTicks) ||
            !long.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out long expiresTicks))
        {
            return false;
        }

        if (accountId <= 0 || (parts[1] != "0" && parts[1] != "1"))
        {
            return false;
        }

        session = new RecoveryKeySession(
            accountId,
            parts[1] == "1",
            new DateTime(issuedTicks, DateTimeKind.Utc),
            new DateTime(expiresTicks, DateTimeKind.Utc));
        return true;
    }

    private readonly record struct RecoveryKeyGeneration(string RecoveryKey, string LookupIdHash);
}
