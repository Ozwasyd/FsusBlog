using System.Data.Common;
using System.Globalization;
using System.Text.Json;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed class UserAccountReader(
    ISqlSugarClient db,
    ICacheTypedReader cacheReader,
    ICacheRawWriter cacheWriter,
    ICacheStringReader stringReader,
    ICacheInvalidationStore invalidation) : IUserAccountReader
{
    private static readonly JsonSerializerOptions s_snapshotJsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<UserAccountSnapshot?> GetAccountByIdAsync(int id)
    {
        long version = await GetSnapshotVersionAsync(id).ConfigureAwait(false);
        string identity = BuildSnapshotIdentity(id, version);
        CacheReadResult<AccountSnapshotCacheEnvelope> cached = await cacheReader.TryGetAsync(
                CachePolicyId.AccountSnapshot,
                identity,
                static payload => DecodeSnapshotEnvelope(payload),
                CancellationToken.None)
            .ConfigureAwait(false);
        if (cached.Hit
            && cached.Value is { } envelope
            && envelope.Version == version
            && AccountSubjectHashRequirement.TryResolve(
                envelope.Snapshot.AccountSubjectHash,
                out _))
        {
            FsusObservability.RecordAccountSnapshotCacheHit(hit: true);
            return envelope.Snapshot;
        }

        FsusObservability.RecordAccountSnapshotCacheHit(hit: false);
        FsusObservability.RecordAccountSnapshotDbReadCount();
        UserAccountSnapshot? snapshot = await LoadAccountSnapshotAsync(id).ConfigureAwait(false);
        if (snapshot.HasValue
            && AccountSubjectHashRequirement.TryResolve(snapshot.Value.AccountSubjectHash, out _))
        {
            byte[] payload = JsonSerializer.SerializeToUtf8Bytes(
                new AccountSnapshotCacheEnvelope(version, snapshot.Value),
                s_snapshotJsonOptions);
            await cacheWriter.SetRawAsync(CachePolicyId.AccountSnapshot, identity, payload).ConfigureAwait(false);
        }
        else
        {
            await invalidation.RemoveAsync(CachePolicyId.AccountSnapshot, identity).ConfigureAwait(false);
        }

        return snapshot;
    }

    private async Task<UserAccountSnapshot?> LoadAccountSnapshotAsync(int id)
    {
        const string Sql = """
            SELECT id AS "Id",
                   status AS "Status",
                   banreason AS "BanReason",
                   mfaenabled AS "MfaEnabled",
                   deleted_at AS "DeletedAt",
                   public_handle AS "PublicHandle",
                   identity_kind AS "IdentityKind",
                   passkey_enabled AS "PasskeyEnabled",
                   recovery_enabled AS "RecoveryEnabled",
                   anonymous_credential_status AS "AnonymousCredentialStatus",
                   anonymous_credential_level AS "AnonymousCredentialLevel",
                   account_subject_hash AS "AccountSubjectHash"
            FROM sys_user
            WHERE id = @Id
            LIMIT 1;
            """;

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            Sql,
            new SugarParameter[] { new("@Id", id) }).ConfigureAwait(false);
        if (!await reader.ReadAsync().ConfigureAwait(false))
        {
            return null;
        }

        int fId = reader.GetOrdinal("Id");
        int fStatus = reader.GetOrdinal("Status");
        int fBanReason = reader.GetOrdinal("BanReason");
        int fMfaEnabled = reader.GetOrdinal("MfaEnabled");
        int fDeletedAt = reader.GetOrdinal("DeletedAt");
        int fPublicHandle = reader.GetOrdinal("PublicHandle");
        int fIdentityKind = reader.GetOrdinal("IdentityKind");
        int fPasskeyEnabled = reader.GetOrdinal("PasskeyEnabled");
        int fRecoveryEnabled = reader.GetOrdinal("RecoveryEnabled");
        int fAnonymousCredentialStatus = reader.GetOrdinal("AnonymousCredentialStatus");
        int fAnonymousCredentialLevel = reader.GetOrdinal("AnonymousCredentialLevel");
        int fAccountSubjectHash = reader.GetOrdinal("AccountSubjectHash");
        int accountId = reader.GetInt32(fId);
        string identityKind = reader.IsDBNull(fIdentityKind)
            ? AnonymousIdentityRuntime.AnonymousAccountKind
            : reader.GetString(fIdentityKind);

        return new UserAccountSnapshot(
            accountId,
            reader.GetInt32(fStatus),
            reader.IsDBNull(fBanReason) ? null : reader.GetString(fBanReason),
            reader.GetBoolean(fMfaEnabled),
            reader.IsDBNull(fDeletedAt) ? null : reader.GetDateTime(fDeletedAt),
            reader.IsDBNull(fPublicHandle) ? null : reader.GetString(fPublicHandle),
            identityKind,
            reader.GetBoolean(fPasskeyEnabled),
            reader.GetBoolean(fRecoveryEnabled),
            reader.IsDBNull(fAnonymousCredentialStatus) ? null : reader.GetString(fAnonymousCredentialStatus),
            reader.IsDBNull(fAnonymousCredentialLevel) ? null : reader.GetString(fAnonymousCredentialLevel),
            reader.IsDBNull(fAccountSubjectHash) ? null : reader.GetString(fAccountSubjectHash));
    }

    private async Task<long> GetSnapshotVersionAsync(int id)
    {
        string? value = await stringReader.GetStringAsync(
                CachePolicyId.AccountSnapshotVersion,
                id.ToString(CultureInfo.InvariantCulture))
            .ConfigureAwait(false);
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long version) && version > 0
            ? version
            : 0;
    }

    private static string BuildSnapshotIdentity(int id, long version)
        => string.Concat(
            "account:subject-v1:",
            id.ToString(CultureInfo.InvariantCulture),
            ":v",
            version.ToString(CultureInfo.InvariantCulture));

    private static (bool Success, AccountSnapshotCacheEnvelope? Value) DecodeSnapshotEnvelope(ReadOnlyMemory<byte> payload)
    {
        try
        {
            AccountSnapshotCacheEnvelope? envelope = JsonSerializer.Deserialize<AccountSnapshotCacheEnvelope>(payload.Span, s_snapshotJsonOptions);
            return envelope is null ? (false, null) : (true, envelope);
        }
        catch (JsonException)
        {
            return (false, null);
        }
    }

    private sealed record AccountSnapshotCacheEnvelope(long Version, UserAccountSnapshot Snapshot);

    internal static UserAccountSnapshot ToAccountSnapshot(User user)
        => new(
            user.Id,
            user.Status,
            user.BanReason,
            user.MfaEnabled,
            user.DeletedAt,
            user.PublicHandle,
            user.IdentityKind,
            user.PasskeyEnabled,
            user.RecoveryEnabled,
            user.AnonymousCredentialStatus,
            user.AnonymousCredentialLevel,
            user.AccountSubjectHash);

    internal static IdentityAccountSnapshotCoreModel ToAnonymousAccountSnapshot(UserAccountSnapshot account)
        => new(
            AccountId: account.Id,
            PublicHandle: string.IsNullOrWhiteSpace(account.PublicHandle) ? null : account.PublicHandle,
            PasskeyEnabled: account.PasskeyEnabled,
            RecoveryEnabled: account.RecoveryEnabled,
            TotpStepUpEnabled: account.MfaEnabled,
            AnonymousCredentialStatus: string.IsNullOrWhiteSpace(account.AnonymousCredentialStatus) ? null : account.AnonymousCredentialStatus,
            AnonymousCredentialLevel: string.IsNullOrWhiteSpace(account.AnonymousCredentialLevel) ? null : account.AnonymousCredentialLevel,
            IdentityKind: string.IsNullOrWhiteSpace(account.IdentityKind) ? AnonymousIdentityRuntime.AnonymousAccountKind : account.IdentityKind,
            Status: account.Status,
            BanReason: string.IsNullOrWhiteSpace(account.BanReason) ? null : account.BanReason,
            DeletedAt: account.DeletedAt);

}

public sealed class AnonymousAccountBootstrapService(UserService users) : IAnonymousAccountBootstrapService
{
    public async Task<(bool Success, string Message, UserAccountSnapshot? User)> BootstrapAsync(
        string? publicHandle,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await users.BootstrapAnonymousAccountAsync(publicHandle);
        return (result.Success, result.Message, result.User is null ? null : UserAccountReader.ToAccountSnapshot(result.User));
    }
}

public sealed class UserLoginWorkflowService(UserService users) : IUserLoginWorkflowService
{
    public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, UserAccountSnapshot? User)> CompleteLoginAsync(
        int userId,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await users.GetByIdAsync(userId);
        if (user is null)
        {
            return (false, "用户不存在", null, null);
        }

        var result = await users.CompleteLoginAsync(user, clientIp, deviceFingerprint, userAgent, mfaVerified, rememberMe);
        return (result.Success, result.Message, result.Data, result.UserEntity is null ? null : UserAccountReader.ToAccountSnapshot(result.UserEntity));
    }

    public Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.EvaluateLoginRiskAsync(userId, clientIp, deviceFingerprint, userAgent);
    }

    public async Task<bool> VerifyMfaOrRecoveryCodeAsync(
        int userId,
        string? code,
        string? recoveryCode,
        bool persistRecoveryConsumption,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await users.GetByIdAsync(userId);
        return user is not null && await users.VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption);
    }
}

public sealed class UserMfaCommandService(UserService users) : IUserMfaCommandService
{
    public Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync(
        int userId,
        string issuer,
        string? password = null,
        string? code = null,
        string? recoveryCode = null,
        bool stepUpVerified = false)
        => users.StartMfaSetupAsync(userId, issuer, password, code, recoveryCode, stepUpVerified);

    public Task<MfaProfileDto?> GetMfaProfileAsync(int userId)
        => users.GetMfaProfileAsync(userId);

    public Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code)
        => users.VerifyMfaSetupAsync(userId, code);

    public Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode, bool stepUpVerified = false)
        => users.DisableMfaAsync(userId, password, code, recoveryCode, stepUpVerified);

    public Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode,
        bool stepUpVerified = false)
        => users.RegenerateMfaRecoveryCodesAsync(userId, password, code, recoveryCode, stepUpVerified);
}
