using System.Data.Common;
using System.Runtime.CompilerServices;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

/// <summary>
/// Coordinates user identity, authentication, session, and account-state operations.
/// </summary>
// Public named-argument source compatibility; exact exception registered in csharp-style-policy.
#pragma warning disable IDE1006
public partial class UserService(
    ISqlSugarClient _db,
    ILogger<UserService> _logger,
    IAccountStateProjectionMutationPublisher _accountStates,
    ITotpService _totpService,
    TimeProvider? timeProvider = null) : IUserMfaCommandService, IUserMfaVerificationService
#pragma warning restore IDE1006
{
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

    private async Task<UserMfaProfile?> GetUserMfaProfileAsync(int userId)
        => await _db.Queryable<UserMfaProfile>()
            .Where(profile => profile.UserId == userId)
            .FirstAsync();

    private async Task UpsertUserMfaProfileAsync(UserMfaProfile profile)
    {
        profile.UpdatedAtUtc = _timeProvider.GetUtcNow().UtcDateTime;
        const string Sql = """
            INSERT INTO user_mfa_profile (
                user_id,
                mfa_secret_encrypted,
                mfa_pending_secret_encrypted,
                mfa_pending_created_at,
                mfa_verified_at,
                mfa_recovery_codes_hash,
                hash_version,
                updated_at_utc
            )
            VALUES (
                @UserId,
                @MfaSecretEncrypted,
                @MfaPendingSecretEncrypted,
                CAST(@MfaPendingCreatedAt AS timestamp),
                CAST(@MfaVerifiedAt AS timestamp),
                @MfaRecoveryCodesHash,
                @MfaRecoveryCodesHashVersion,
                CAST(@UpdatedAtUtc AS timestamp)
            )
            ON CONFLICT (user_id) DO UPDATE SET
                mfa_secret_encrypted = EXCLUDED.mfa_secret_encrypted,
                mfa_pending_secret_encrypted = EXCLUDED.mfa_pending_secret_encrypted,
                mfa_pending_created_at = EXCLUDED.mfa_pending_created_at,
                mfa_verified_at = EXCLUDED.mfa_verified_at,
                mfa_recovery_codes_hash = EXCLUDED.mfa_recovery_codes_hash,
                hash_version = EXCLUDED.hash_version,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """;

        await _db.Ado.ExecuteCommandAsync(Sql, new SugarParameter[]
        {
            new SugarParameter("@UserId", profile.UserId),
            new SugarParameter("@MfaSecretEncrypted", DbValue(profile.MfaSecretEncrypted)),
            new SugarParameter("@MfaPendingSecretEncrypted", DbValue(profile.MfaPendingSecretEncrypted)),
            new SugarParameter("@MfaPendingCreatedAt", DbValue(profile.MfaPendingCreatedAt)),
            new SugarParameter("@MfaVerifiedAt", DbValue(profile.MfaVerifiedAt)),
            new SugarParameter("@MfaRecoveryCodesHash", DbValue(profile.MfaRecoveryCodesHash)),
            new SugarParameter("@MfaRecoveryCodesHashVersion", profile.MfaRecoveryCodesHashVersion),
            new SugarParameter("@UpdatedAtUtc", profile.UpdatedAtUtc)
        });
    }

    private static object DbValue(string? value)
        => value is null ? DBNull.Value : value;

    private static object DbValue(DateTime? value)
        => value.HasValue ? value.Value : DBNull.Value;

    private Task InvalidateAccountSnapshotAsync(int userId, CancellationToken cancellationToken = default)
        => _accountStates.ProjectCommittedMutationAsync(userId, cancellationToken);

    public async Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync(
        int userId,
        string issuer,
        string? password = null,
        string? code = null,
        string? recoveryCode = null,
        bool stepUpVerified = false)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, null, "用户不存在");
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        if (user.MfaEnabled)
        {
            bool anonymousIdentityMode = AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled();
            if (anonymousIdentityMode)
            {
                if (!stepUpVerified)
                {
                    return (false, null, "MFA_REBIND_STEP_UP_REQUIRED");
                }
            }
            else
            {
                return (false, null, "MFA_REBIND_PASSWORD_REQUIRED");
            }
        }

        string secret = _totpService.GenerateSecret();
        string protectedSecret = _totpService.ProtectSecret(secret);
        string account = BuildMfaAccountLabel(user);
        string otpAuthUrl = _totpService.BuildOtpAuthUri(issuer, account, secret);

        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        profile ??= new UserMfaProfile { UserId = userId };
        profile.MfaPendingSecretEncrypted = protectedSecret;
        profile.MfaPendingCreatedAt = now;
        await UpsertUserMfaProfileAsync(profile);

        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>("AuditAction", "mfa_setup_started"),
            new KeyValuePair<string, object?>("UserId", userId),
            new KeyValuePair<string, object?>("Rebind", user.MfaEnabled));

        return (true, new MfaSetupStartDto(user.MfaEnabled, secret, otpAuthUrl, issuer, account), "MFA_SETUP_STARTED");
    }

    public async Task<MfaProfileDto?> GetMfaProfileAsync(int userId)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);

        if (user == null)
        {
            return null;
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        return new MfaProfileDto(user.MfaEnabled, profile?.MfaVerifiedAt);
    }

    public async Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        UserMfaProfile? profile = user is null ? null : await GetUserMfaProfileAsync(userId);
        if (user == null || profile == null || string.IsNullOrWhiteSpace(profile.MfaPendingSecretEncrypted))
        {
            return (false, null, "MFA_SETUP_NOT_STARTED");
        }

        if (profile.MfaPendingCreatedAt is null ||
            _timeProvider.GetUtcNow().UtcDateTime - profile.MfaPendingCreatedAt.Value > TimeSpan.FromMinutes(10))
        {
            profile.MfaPendingSecretEncrypted = null;
            profile.MfaPendingCreatedAt = null;
            await UpsertUserMfaProfileAsync(profile);
            return (false, null, "MFA_SETUP_EXPIRED");
        }

        Result<string> secretResult = BoundaryExecutor.ExecuteResult(
            () => _totpService.UnprotectSecret(profile.MfaPendingSecretEncrypted),
            _ => ErrorDetail.Create(ErrorCode.Validation, "MFA_SECRET_INVALID"),
            _logger,
            $"mfa-verify-setup:{userId}");
        if (!secretResult.IsSuccess || string.IsNullOrWhiteSpace(secretResult.Value))
        {
            return (false, null, "MFA_SECRET_INVALID");
        }
        string secret = secretResult.Value;

        if (!_totpService.TryVerifyCode(secret, code, out long matchedSetupStep))
        {
            return (false, null, "INVALID_TOTP");
        }

        var recoveryCodes = _totpService.GenerateRecoveryCodes(10);
        string recoveryHashes = _totpService.HashRecoveryCodes(recoveryCodes);

        profile.MfaSecretEncrypted = profile.MfaPendingSecretEncrypted;
        profile.MfaVerifiedAt = _timeProvider.GetUtcNow().UtcDateTime;
        profile.MfaRecoveryCodesHash = recoveryHashes;
        profile.MfaRecoveryCodesHashVersion = TotpService.CurrentRecoveryCodeHashVersion;
        profile.LastTotpStep = matchedSetupStep;
        profile.LastTotpUsedAtUtc = _timeProvider.GetUtcNow().UtcDateTime;
        profile.MfaPendingSecretEncrypted = null;
        profile.MfaPendingCreatedAt = null;
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            bool? lockedMfaEnabled = await LockUserMfaStateForUpdateAsync(userId);
            if (lockedMfaEnabled is null)
            {
                throw new InvalidOperationException("mfa_user_missing");
            }

            await _db.Updateable<User>()
                .SetColumns(u => u.MfaEnabled == true)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();
            await UpsertUserMfaProfileAsync(profile);
        });
        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "MFA setup verification transaction failed for user {UserId}", userId);
            return (false, null, "MFA_ENABLE_FAILED");
        }

        await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
        return (true, new MfaSetupVerifyDto
        {
            Enabled = true,
            RecoveryCodes = [.. recoveryCodes]
        }, "MFA_ENABLED");
    }

    public async Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode, bool stepUpVerified = false)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, "用户不存在");
        }

        bool anonymousIdentityMode = AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled();
        if (!anonymousIdentityMode)
        {
            return (false, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage);
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        if (!user.MfaEnabled)
        {
            return (true, "MFA_ALREADY_DISABLED");
        }

        if (anonymousIdentityMode)
        {
            if (!stepUpVerified)
            {
                return (false, "MFA_STEP_UP_REQUIRED");
            }
        }
        else
        {
            bool pass = await VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption: true);
            if (!pass)
            {
                return (false, "MFA_VERIFY_FAILED");
            }
        }

        if (profile is not null)
        {
            profile.MfaSecretEncrypted = null;
            profile.MfaPendingSecretEncrypted = null;
            profile.MfaPendingCreatedAt = null;
            profile.MfaRecoveryCodesHash = null;
            profile.MfaRecoveryCodesHashVersion = 1;
            profile.MfaVerifiedAt = null;
        }
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            bool? lockedMfaEnabled = await LockUserMfaStateForUpdateAsync(userId);
            if (lockedMfaEnabled is null)
            {
                throw new InvalidOperationException("mfa_user_missing");
            }

            await _db.Updateable<User>()
                .SetColumns(u => u.MfaEnabled == false)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();
            if (profile is not null)
            {
                await UpsertUserMfaProfileAsync(profile);
            }
        });
        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "MFA disable transaction failed for user {UserId}", userId);
            return (false, "MFA_DISABLE_FAILED");
        }

        await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
        return (true, "MFA_DISABLED");
    }

    public async Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode,
        bool stepUpVerified = false)
    {
        var user = await _db.Queryable<User>().InSingleAsync(userId);
        if (user == null)
        {
            return (false, null, "用户不存在");
        }

        bool anonymousIdentityMode = AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled();
        if (!anonymousIdentityMode)
        {
            return (false, null, AnonymousIdentityRuntime.LegacyPasswordDisabledMessage);
        }

        UserMfaProfile? profile = await GetUserMfaProfileAsync(userId);
        if (!user.MfaEnabled || string.IsNullOrWhiteSpace(profile?.MfaSecretEncrypted))
        {
            return (false, null, "MFA_NOT_ENABLED");
        }

        if (anonymousIdentityMode)
        {
            if (!stepUpVerified)
            {
                return (false, null, "MFA_STEP_UP_REQUIRED");
            }
        }
        else
        {
            bool pass = await VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption: true);
            if (!pass)
            {
                return (false, null, "MFA_VERIFY_FAILED");
            }
        }

        var recoveryCodes = _totpService.GenerateRecoveryCodes(10);
        string recoveryHashes = _totpService.HashRecoveryCodes(recoveryCodes);

        profile.MfaRecoveryCodesHash = recoveryHashes;
        profile.MfaRecoveryCodesHashVersion = TotpService.CurrentRecoveryCodeHashVersion;
        await UpsertUserMfaProfileAsync(profile);

        return (true, new MfaSetupVerifyDto
        {
            Enabled = true,
            RecoveryCodes = [.. recoveryCodes]
        }, "MFA_RECOVERY_CODES_REGENERATED");
    }

    public async Task<bool> ResetMfaByAdminAsync(int userId)
    {
        int updated = 0;
        DateTime updatedAtUtc = _timeProvider.GetUtcNow().UtcDateTime;
        var tran = await _db.Ado.UseTranAsync(async () =>
        {
            bool? lockedMfaEnabled = await LockUserMfaStateForUpdateAsync(userId);
            if (lockedMfaEnabled is null)
            {
                return;
            }

            updated = await _db.Updateable<User>()
                .SetColumns(u => u.MfaEnabled == false)
                .Where(u => u.Id == userId)
                .ExecuteCommandAsync();

            await _db.Updateable<UserMfaProfile>()
                .SetColumns(p => p.MfaSecretEncrypted == null)
                .SetColumns(p => p.MfaPendingSecretEncrypted == null)
                .SetColumns(p => p.MfaPendingCreatedAt == null)
                .SetColumns(p => p.MfaRecoveryCodesHash == null)
                .SetColumns(p => p.MfaRecoveryCodesHashVersion == 1)
                .SetColumns(p => p.MfaVerifiedAt == null)
                .SetColumns(p => p.UpdatedAtUtc == updatedAtUtc)
                .Where(p => p.UserId == userId)
                .ExecuteCommandAsync();
        });
        if (!tran.IsSuccess)
        {
            _logger.LogError(tran.ErrorException, "Admin MFA reset transaction failed for user {UserId}", userId);
            return false;
        }

        await InvalidateAccountSnapshotAsync(userId).ConfigureAwait(false);
        return updated > 0;
    }

    private async Task<bool?> LockUserMfaStateForUpdateAsync(int userId)
    {
        using var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT COALESCE(mfaenabled, false) AS mfa_enabled
            FROM sys_user
            WHERE id = @UserId
            FOR UPDATE;
            """,
            new SugarParameter[] { new("@UserId", userId) });
        if (!await reader.ReadAsync())
        {
            return null;
        }

        return reader.ReadBoolean("mfa_enabled");
    }

    public async Task<bool> VerifyMfaOrRecoveryCodeAsync(
        int userId,
        string? code,
        string? recoveryCode,
        bool persistRecoveryConsumption,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await _db.Queryable<User>().InSingleAsync(userId);
        return user is not null
            && await VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption);
    }

    public async Task<bool> VerifyMfaOrRecoveryCodeAsync(User user, string? code, string? recoveryCode, bool persistRecoveryConsumption)
    {
        UserMfaProfile? profile = await GetUserMfaProfileAsync(user.Id);
        if (!user.MfaEnabled || string.IsNullOrWhiteSpace(profile?.MfaSecretEncrypted))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(code))
        {
            Result<string> secretResult = BoundaryExecutor.ExecuteResult(
                () => _totpService.UnprotectSecret(profile.MfaSecretEncrypted),
                _ => ErrorDetail.Create(ErrorCode.Validation, "MFA_SECRET_INVALID"),
                _logger,
                $"mfa-verify-code:{user.Id}");
            if (!secretResult.IsSuccess || string.IsNullOrWhiteSpace(secretResult.Value))
            {
                return false;
            }
            string secret = secretResult.Value;
            if (_totpService.TryVerifyCode(secret, code, out long matchedStep))
            {
                if (!await TryConsumeTotpStepAsync(user.Id, matchedStep))
                {
                    return false;
                }

                if (persistRecoveryConsumption &&
                    profile.MfaRecoveryCodesHashVersion < TotpService.CurrentRecoveryCodeHashVersion &&
                    !string.IsNullOrWhiteSpace(profile.MfaRecoveryCodesHash))
                {
                    profile.MfaRecoveryCodesHash = string.Empty;
                    profile.MfaRecoveryCodesHashVersion = 0;
                    await UpsertUserMfaProfileAsync(profile);
                }

                return true;
            }
        }

        if (!string.IsNullOrWhiteSpace(recoveryCode))
        {
            RecoveryCodeConsumeResult consumeResult = _totpService.ConsumeRecoveryCode(profile.MfaRecoveryCodesHash, recoveryCode);
            if (consumeResult.Success)
            {
                if (persistRecoveryConsumption)
                {
                    string oldHashes = profile.MfaRecoveryCodesHash ?? string.Empty;
                    short nextHashVersion = consumeResult.RequiresRecoveryCodeRegeneration
                        ? string.IsNullOrWhiteSpace(consumeResult.UpdatedHashes) ? (short)0 : (short)1
                        : TotpService.CurrentRecoveryCodeHashVersion;
                    if (!await TryPersistRecoveryCodeConsumptionAsync(
                        user.Id,
                        oldHashes,
                        consumeResult.UpdatedHashes,
                        nextHashVersion))
                    {
                        return false;
                    }

                    profile.MfaRecoveryCodesHash = consumeResult.UpdatedHashes;
                    profile.MfaRecoveryCodesHashVersion = nextHashVersion;
                }
                return true;
            }
        }

        return false;
    }

    private async Task<bool> TryConsumeTotpStepAsync(int userId, long matchedStep)
    {
        DateTime usedAtUtc = _timeProvider.GetUtcNow().UtcDateTime;
        const string Sql = """
            UPDATE user_mfa_profile
            SET last_totp_step = @MatchedStep,
                last_totp_used_at_utc = @UsedAtUtc,
                updated_at_utc = @UsedAtUtc
            WHERE user_id = @UserId
              AND (last_totp_step IS NULL OR last_totp_step < @MatchedStep);
            """;
        int updated = await _db.Ado.ExecuteCommandAsync(Sql, new SugarParameter[]
        {
            new("@MatchedStep", matchedStep),
            new("@UsedAtUtc", usedAtUtc),
            new("@UserId", userId)
        });

        return updated > 0;
    }

    private async Task<bool> TryPersistRecoveryCodeConsumptionAsync(
        int userId,
        string oldHashes,
        string updatedHashes,
        short hashVersion)
    {
        const string Sql = """
            UPDATE user_mfa_profile
            SET mfa_recovery_codes_hash = @UpdatedHashes,
                hash_version = @HashVersion,
                updated_at_utc = @UpdatedAtUtc
            WHERE user_id = @UserId
              AND mfa_recovery_codes_hash = @OldHashes;
            """;
        int updated = await _db.Ado.ExecuteCommandAsync(Sql, new SugarParameter[]
        {
            new("@UpdatedHashes", updatedHashes),
            new("@HashVersion", hashVersion),
            new("@UpdatedAtUtc", _timeProvider.GetUtcNow().UtcDateTime),
            new("@UserId", userId),
            new("@OldHashes", oldHashes)
        });
        return updated > 0;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string BuildMfaAccountLabel(User user)
        => $"FsusBlog:account:{user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
}
