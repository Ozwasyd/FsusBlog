using System.Buffers.Text;
using System.Buffers;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public sealed record class RecoveryKeySession(
    int AccountId,
    bool RevokePasskeys,
    DateTime IssuedAtUtc,
    DateTime ExpiresAtUtc);

public readonly record struct RecoveryPasskeyBindOutcome(bool WasIdempotentReplay);

internal enum RecoveryPasskeyCompletionState
{
    Pending,
    Completing,
    Completed
}

internal sealed record RecoverySessionEnvelope(
    RecoveryKeySession Session,
    RecoveryPasskeyCompletionState State,
    string? RequestHash,
    string? LeaseId,
    DateTime? LeaseExpiresAtUtc);

public interface IRecoveryKeyService
{
    Task<Result<RecoveryKeyCreateResponseCoreModel>> CreateAsync(int accountId, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeyCreateResponseCoreModel>> RotateAsync(int accountId, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeyVerifyResponseCoreModel>> VerifyAsync(RecoveryKeyVerifyRequestCoreModel request, string clientIp, string? userAgent, CancellationToken cancellationToken = default);
    Task<Result<RecoveryKeySession>> GetRecoverySessionAsync(string token, CancellationToken cancellationToken = default);
    Task<Result<RecoveryPasskeyBindOutcome>> CompletePasskeyBindAsync(
        string token,
        PasskeyRegisterCompleteCoreModel request,
        CancellationToken cancellationToken = default);
}

public sealed class RecoveryKeyService(
    ISqlSugarClient db,
    IUnifiedCache cache,
    IConfiguration configuration,
    IPasskeyService passkeys,
    ILogger<RecoveryKeyService> logger,
    IUserSessionValidationCache userSessionValidationCache) : IRecoveryKeyService
{
    private const string RecoveryKeyPrefix = "frk_";
    private const char RecoveryKeySeparator = '_';
    private const int RecoveryKeyLookupBytes = 16;
    private const int RecoveryKeyRandomBytes = 32;
    private const int RecoveryKeySaltBytes = 16;
    private const int RecoveryKeyHashBytes = 32;
    private const int RecoveryKeyPbkdf2Iterations = 600_000;
    private const int MaxRecoveryKeyChars = 256;
    private const int MaxFailedAttempts = 8;
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RecoverySessionTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan CompletionLeaseTtl = TimeSpan.FromSeconds(90);

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
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
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
            await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, credential.AccountId, cancellationToken).ConfigureAwait(false);

            if (request.RevokeSessions)
            {
                using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    """
                    UPDATE sys_user_session
                    SET revokedat = @RevokedAt,
                        revokereason = 'recovery_key_verified'
                    WHERE userid = @AccountId
                      AND revokedat IS NULL
                    RETURNING sessionid,
                              userid,
                              revokedat,
                              idleexpiresat,
                              absoluteexpiresat,
                              xmin::text AS row_version;
                    """,
                    new SugarParameter("@RevokedAt", now),
                    new SugarParameter("@AccountId", credential.AccountId));
                while (await reader.ReadAsync(cancellationToken))
                {
                    revokedSessions.Add(new UserSessionValidationCacheState(
                        reader.GetString(0),
                        reader.GetInt32(1),
                        AsUtc(reader.GetDateTime(2)),
                        AsUtc(reader.GetDateTime(3)),
                        AsUtc(reader.GetDateTime(4)),
                        reader.GetString(5),
                        0,
                        null,
                        AnonymousIdentityRuntime.AnonymousAccountKind));
                }
            }

            string token = GenerateSecretToken();
            DateTime expiresAt = now.Add(RecoverySessionTtl);
            var session = new RecoveryKeySession(credential.AccountId, request.RevokePasskeys, now, expiresAt);
            await cache.SetStringAsync(
                CachePolicyId.SecurityRecoveryKeySession,
                BuildSessionIdentity(token),
                EncodeSessionEnvelope(ToPendingEnvelope(session)),
                RecoverySessionTtl,
                cancellationToken).ConfigureAwait(false);

            transactionResult = Result<RecoveryKeyVerifyResponseCoreModel>.Success(
                new RecoveryKeyVerifyResponseCoreModel(token, expiresAt));

            publicationAttempted = revokedSessions.Count > 0;
            await userSessionValidationCache.PublishManyAsync(
                revokedSessions,
                allowOverwrite: true,
                cancellationToken: cancellationToken).ConfigureAwait(false);
        });
        if (!transaction.IsSuccess)
        {
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(revokedSessions).ConfigureAwait(false);
            }

            throw transaction.ErrorException ?? new InvalidOperationException("Recovery key verification transaction failed.");
        }

        return transactionResult ?? Result<RecoveryKeyVerifyResponseCoreModel>.Failure(ErrorCode.Unauthorized, "RECOVERY_KEY_INVALID");
    }

    private async Task BestEffortInvalidateRevocationSnapshotsAsync(
        IReadOnlyList<UserSessionValidationCacheState> revokedSessions)
    {
        try
        {
            await userSessionValidationCache.InvalidateManyAsync(
                revokedSessions,
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Leaving the pre-commit revoked snapshot in place is conservative: it can
            // deny an active session after rollback, but cannot resurrect a revoked one.
            logger.LogWarning(
                ex,
                "Failed to clean up {SessionCount} pre-commit recovery revocation snapshots",
                revokedSessions.Count);
        }
    }

    public async Task<Result<RecoveryKeySession>> GetRecoverySessionAsync(string token, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return Result<RecoveryKeySession>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_INVALID");
        }

        string identity = BuildSessionIdentity(token);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            string? encoded = await cache.GetStringAsync(
                CachePolicyId.SecurityRecoveryKeySession,
                identity,
                cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(encoded) || !TryDecodeSessionEnvelope(encoded, out RecoverySessionEnvelope? envelope) || envelope is null)
            {
                return Result<RecoveryKeySession>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_INVALID");
            }

            DateTime now = DateTime.UtcNow;
            if (envelope.Session.ExpiresAtUtc <= now)
            {
                await cache.RemoveAsync(CachePolicyId.SecurityRecoveryKeySession, identity, cancellationToken).ConfigureAwait(false);
                return Result<RecoveryKeySession>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_EXPIRED");
            }

            if (envelope.State == RecoveryPasskeyCompletionState.Pending)
            {
                return Result<RecoveryKeySession>.Success(envelope.Session);
            }

            if (envelope.State == RecoveryPasskeyCompletionState.Completed)
            {
                return Result<RecoveryKeySession>.Failure(ErrorCode.Conflict, "RECOVERY_PASSKEY_ALREADY_COMPLETED");
            }

            if (envelope.LeaseExpiresAtUtc > now)
            {
                return Result<RecoveryKeySession>.Failure(ErrorCode.Conflict, "RECOVERY_PASSKEY_COMPLETION_IN_PROGRESS");
            }

            RecoverySessionEnvelope pending = ToPendingEnvelope(envelope.Session);
            if (await TryReplaceSessionEnvelopeAsync(identity, encoded, pending, cancellationToken).ConfigureAwait(false))
            {
                return Result<RecoveryKeySession>.Success(envelope.Session);
            }
        }

        return Result<RecoveryKeySession>.Failure(ErrorCode.Conflict, "RECOVERY_PASSKEY_COMPLETION_IN_PROGRESS");
    }

    public async Task<Result<RecoveryPasskeyBindOutcome>> CompletePasskeyBindAsync(
        string token,
        PasskeyRegisterCompleteCoreModel request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(token))
        {
            return Result<RecoveryPasskeyBindOutcome>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_INVALID");
        }

        string identity = BuildSessionIdentity(token);
        string recoverySessionHash = HashRecoverySessionToken(token);
        string recoveryRequestHash = HashRecoveryPasskeyRequest(request);
        Result<RecoveryPasskeyBindOutcome>? durable = await TryResolveDurableCompletionAsync(
            recoverySessionHash,
            recoveryRequestHash,
            request.SessionKey,
            cancellationToken).ConfigureAwait(false);
        if (durable.HasValue)
        {
            return durable.Value;
        }

        RecoverySessionEnvelope? claimedEnvelope = null;
        string? claimedEncoded = null;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            string? encoded = await cache.GetStringAsync(
                CachePolicyId.SecurityRecoveryKeySession,
                identity,
                cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(encoded) || !TryDecodeSessionEnvelope(encoded, out RecoverySessionEnvelope? envelope) || envelope is null)
            {
                return Result<RecoveryPasskeyBindOutcome>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_INVALID");
            }

            DateTime now = DateTime.UtcNow;
            if (envelope.Session.ExpiresAtUtc <= now)
            {
                await cache.RemoveAsync(CachePolicyId.SecurityRecoveryKeySession, identity, cancellationToken).ConfigureAwait(false);
                return Result<RecoveryPasskeyBindOutcome>.Failure(ErrorCode.Unauthorized, "RECOVERY_SESSION_EXPIRED");
            }

            if (envelope.State == RecoveryPasskeyCompletionState.Completed)
            {
                durable = await TryResolveDurableCompletionAsync(
                    recoverySessionHash,
                    recoveryRequestHash,
                    request.SessionKey,
                    cancellationToken).ConfigureAwait(false);
                return durable ?? Result<RecoveryPasskeyBindOutcome>.Failure(
                    ErrorCode.InfraFailure,
                    "RECOVERY_PASSKEY_COMPLETION_STATE_INVALID");
            }

            if (envelope.State == RecoveryPasskeyCompletionState.Completing)
            {
                if (envelope.LeaseExpiresAtUtc > now)
                {
                    string reason = string.Equals(envelope.RequestHash, recoveryRequestHash, StringComparison.Ordinal)
                        ? "RECOVERY_PASSKEY_COMPLETION_IN_PROGRESS"
                        : "RECOVERY_PASSKEY_COMPLETION_BOUND_TO_ANOTHER_REQUEST";
                    return Result<RecoveryPasskeyBindOutcome>.Failure(ErrorCode.Conflict, reason);
                }

                RecoverySessionEnvelope pending = ToPendingEnvelope(envelope.Session);
                _ = await TryReplaceSessionEnvelopeAsync(identity, encoded, pending, cancellationToken).ConfigureAwait(false);
                continue;
            }

            string leaseId = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(16));
            var completing = envelope with
            {
                State = RecoveryPasskeyCompletionState.Completing,
                RequestHash = recoveryRequestHash,
                LeaseId = leaseId,
                LeaseExpiresAtUtc = Min(envelope.Session.ExpiresAtUtc, now.Add(CompletionLeaseTtl))
            };
            if (await TryReplaceSessionEnvelopeAsync(identity, encoded, completing, cancellationToken).ConfigureAwait(false))
            {
                claimedEnvelope = completing;
                claimedEncoded = EncodeSessionEnvelope(completing);
                break;
            }
        }

        if (claimedEnvelope is null || string.IsNullOrWhiteSpace(claimedEncoded))
        {
            return Result<RecoveryPasskeyBindOutcome>.Failure(ErrorCode.Conflict, "RECOVERY_PASSKEY_COMPLETION_IN_PROGRESS");
        }

        try
        {
            RecoveryPasskeyRegistrationResult registration = await passkeys.CompleteRecoveryRegistrationAsync(
                claimedEnvelope.Session,
                recoverySessionHash,
                recoveryRequestHash,
                request,
                cancellationToken).ConfigureAwait(false);
            if (!registration.IsSuccess)
            {
                await RestorePendingAfterFailureAsync(identity, claimedEncoded, claimedEnvelope.Session).ConfigureAwait(false);
                ErrorCode code = registration.Status switch
                {
                    RecoveryPasskeyRegistrationStatus.ValidationFailed => ErrorCode.Validation,
                    RecoveryPasskeyRegistrationStatus.Conflict => ErrorCode.Conflict,
                    _ => ErrorCode.InfraFailure
                };
                return Result<RecoveryPasskeyBindOutcome>.Failure(code, registration.Message);
            }

            var completed = claimedEnvelope with
            {
                State = RecoveryPasskeyCompletionState.Completed,
                LeaseId = null,
                LeaseExpiresAtUtc = null
            };
            _ = await TryReplaceSessionEnvelopeAsync(
                identity,
                claimedEncoded,
                completed,
                cancellationToken).ConfigureAwait(false);
            return Result<RecoveryPasskeyBindOutcome>.Success(new RecoveryPasskeyBindOutcome(
                registration.Status == RecoveryPasskeyRegistrationStatus.AlreadyCompleted));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await RestorePendingAfterFailureAsync(identity, claimedEncoded, claimedEnvelope.Session).ConfigureAwait(false);
            throw;
        }
        catch (Exception exception)
        {
            await RestorePendingAfterFailureAsync(identity, claimedEncoded, claimedEnvelope.Session).ConfigureAwait(false);
            logger.LogWarning(
                exception,
                "Recovery Passkey completion failed safely before response. RecoverySessionHash={RecoverySessionHash} ExceptionType={ExceptionType}",
                recoverySessionHash[..16],
                exception.GetType().Name);
            return Result<RecoveryPasskeyBindOutcome>.Failure(ErrorCode.InfraFailure, "RECOVERY_PASSKEY_RETRYABLE");
        }
    }

    private async Task<Result<RecoveryPasskeyBindOutcome>?> TryResolveDurableCompletionAsync(
        string recoverySessionHash,
        string recoveryRequestHash,
        string registrationSessionKey,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RecoveryPasskeyRegistrationResult? completed = await passkeys.TryResolveRecoveryRegistrationAsync(
            recoverySessionHash,
            recoveryRequestHash,
            registrationSessionKey,
            cancellationToken).ConfigureAwait(false);
        if (completed is null)
        {
            return null;
        }

        if (!completed.Value.IsSuccess)
        {
            return Result<RecoveryPasskeyBindOutcome>.Failure(
                ErrorCode.Conflict,
                completed.Value.Message);
        }

        return Result<RecoveryPasskeyBindOutcome>.Success(new RecoveryPasskeyBindOutcome(true));
    }

    private async Task<bool> TryReplaceSessionEnvelopeAsync(
        string identity,
        string expectedEncoded,
        RecoverySessionEnvelope replacement,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        TimeSpan remaining = replacement.Session.ExpiresAtUtc - DateTime.UtcNow;
        if (remaining <= TimeSpan.Zero)
        {
            return false;
        }

        return await cache.TrySetStringIfValueAsync(
            CachePolicyId.SecurityRecoveryKeySession,
            identity,
            EncodeSessionEnvelope(replacement),
            identity,
            expectedEncoded,
            remaining,
            cancellationToken).ConfigureAwait(false);
    }

    private async Task RestorePendingAfterFailureAsync(
        string identity,
        string completingEncoded,
        RecoveryKeySession session)
    {
        try
        {
            _ = await TryReplaceSessionEnvelopeAsync(
                identity,
                completingEncoded,
                ToPendingEnvelope(session),
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            logger.LogWarning(
                exception,
                "Recovery Passkey completion lease could not be released. SessionIdentity={SessionIdentity} ExceptionType={ExceptionType}",
                identity,
                exception.GetType().Name);
        }
    }

    internal static RecoverySessionEnvelope ToPendingEnvelope(RecoveryKeySession session)
        => new(session, RecoveryPasskeyCompletionState.Pending, null, null, null);

    private static DateTime Min(DateTime left, DateTime right)
        => left <= right ? left : right;

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
        await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, accountId, cancellationToken).ConfigureAwait(false);

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

    internal static string BuildSessionIdentity(string token)
        => $"token:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))[..32]}";

    internal static string HashRecoverySessionToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    internal static string HashRecoveryPasskeyRequest(PasskeyRegisterCompleteCoreModel request)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        PodBinaryCodec.WritePasskeyRegisterCompleteRequest(request, payload);
        return Convert.ToHexString(SHA256.HashData(payload.WrittenSpan));
    }

    internal static string EncodeSessionEnvelope(RecoverySessionEnvelope envelope)
        => string.Join(
            '|',
            "v2",
            envelope.State switch
            {
                RecoveryPasskeyCompletionState.Pending => "pending",
                RecoveryPasskeyCompletionState.Completing => "completing",
                RecoveryPasskeyCompletionState.Completed => "completed",
                _ => throw new ArgumentOutOfRangeException(nameof(envelope))
            },
            envelope.Session.AccountId.ToString(CultureInfo.InvariantCulture),
            envelope.Session.RevokePasskeys ? "1" : "0",
            envelope.Session.IssuedAtUtc.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
            envelope.Session.ExpiresAtUtc.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
            envelope.RequestHash ?? "-",
            envelope.LeaseId ?? "-",
            envelope.LeaseExpiresAtUtc?.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) ?? "-1");

    internal static bool TryDecodeSessionEnvelope(string value, out RecoverySessionEnvelope? envelope)
    {
        envelope = null;
        string[] parts = value.Split('|');
        if (parts.Length == 4)
        {
            if (!TryDecodeSessionFields(parts[0], parts[1], parts[2], parts[3], out RecoveryKeySession? legacySession) ||
                legacySession is null)
            {
                return false;
            }

            envelope = ToPendingEnvelope(legacySession);
            return true;
        }

        if (parts.Length != 9 || !string.Equals(parts[0], "v2", StringComparison.Ordinal) ||
            !TryDecodeSessionFields(parts[2], parts[3], parts[4], parts[5], out RecoveryKeySession? session) ||
            session is null)
        {
            return false;
        }

        RecoveryPasskeyCompletionState state = parts[1] switch
        {
            "pending" => RecoveryPasskeyCompletionState.Pending,
            "completing" => RecoveryPasskeyCompletionState.Completing,
            "completed" => RecoveryPasskeyCompletionState.Completed,
            _ => (RecoveryPasskeyCompletionState)(-1)
        };
        if (!Enum.IsDefined(state))
        {
            return false;
        }

        string? requestHash = parts[6] == "-" ? null : parts[6];
        string? leaseId = parts[7] == "-" ? null : parts[7];
        DateTime? leaseExpiresAtUtc = null;
        if (parts[8] != "-1")
        {
            if (!long.TryParse(parts[8], NumberStyles.None, CultureInfo.InvariantCulture, out long leaseTicks) ||
                !TryCreateUtc(leaseTicks, out DateTime leaseExpiry))
            {
                return false;
            }
            leaseExpiresAtUtc = leaseExpiry;
        }

        bool fieldsValid = state switch
        {
            RecoveryPasskeyCompletionState.Pending => requestHash is null && leaseId is null && leaseExpiresAtUtc is null,
            RecoveryPasskeyCompletionState.Completing =>
                requestHash is { Length: 64 } && leaseId is not null && leaseExpiresAtUtc.HasValue,
            RecoveryPasskeyCompletionState.Completed => requestHash is { Length: 64 } && leaseId is null && leaseExpiresAtUtc is null,
            _ => false
        };
        if (!fieldsValid)
        {
            return false;
        }

        envelope = new RecoverySessionEnvelope(session, state, requestHash, leaseId, leaseExpiresAtUtc);
        return true;
    }

    private static bool TryDecodeSessionFields(
        string accountValue,
        string revokePasskeysValue,
        string issuedValue,
        string expiresValue,
        out RecoveryKeySession? session)
    {
        session = null;
        if (!int.TryParse(accountValue, NumberStyles.None, CultureInfo.InvariantCulture, out int accountId) ||
            accountId <= 0 ||
            (revokePasskeysValue != "0" && revokePasskeysValue != "1") ||
            !long.TryParse(issuedValue, NumberStyles.None, CultureInfo.InvariantCulture, out long issuedTicks) ||
            !long.TryParse(expiresValue, NumberStyles.None, CultureInfo.InvariantCulture, out long expiresTicks) ||
            !TryCreateUtc(issuedTicks, out DateTime issuedAtUtc) ||
            !TryCreateUtc(expiresTicks, out DateTime expiresAtUtc) ||
            expiresAtUtc <= issuedAtUtc)
        {
            return false;
        }

        session = new RecoveryKeySession(
            accountId,
            revokePasskeysValue == "1",
            issuedAtUtc,
            expiresAtUtc);
        return true;
    }

    private static bool TryCreateUtc(long ticks, out DateTime value)
    {
        try
        {
            value = new DateTime(ticks, DateTimeKind.Utc);
            return true;
        }
        catch (ArgumentOutOfRangeException)
        {
            value = default;
            return false;
        }
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    private readonly record struct RecoveryKeyGeneration(string RecoveryKey, string LookupIdHash);
}
