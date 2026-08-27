using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

internal sealed record AccountProfilePreferenceObservedState(
    int UserId,
    bool Exists,
    string? PublicHandle,
    long ProfileRevision,
    int Status,
    bool MfaEnabled,
    bool PasskeyEnabled,
    bool RecoveryEnabled,
    int RiskFlags,
    int ActiveSessionCount,
    bool PreferenceExists,
    UserLocalePreferenceDto Preference,
    string SecurityStateDigest);

internal interface IAccountProfilePreferenceFixtureStateReader
{
    Task<AccountProfilePreferenceObservedState> ReadAsync(
        int userId,
        CancellationToken cancellationToken = default);

    Task<int> CountHandleOwnersAsync(
        string publicHandle,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Independent test-only observer. It performs no writes; all mutations remain
/// behind the production profile and preference command ports.
/// </summary>
internal sealed class AccountProfilePreferenceFixtureStateReader(
    ISqlSugarClient db) : IAccountProfilePreferenceFixtureStateReader
{
    private static readonly UserLocalePreferenceDto s_defaultPreference =
        new(LocalePreferenceModes.Auto, null, 0, DateTime.UnixEpoch);

    public async Task<AccountProfilePreferenceObservedState> ReadAsync(
        int userId,
        CancellationToken cancellationToken = default)
    {
        const string Sql = """
            SELECT u.id AS "UserId",
                   u.public_handle AS "PublicHandle",
                   u.passkey_signal_version AS "ProfileRevision",
                   u.status AS "Status",
                   u.mfaenabled AS "MfaEnabled",
                   u.passkey_enabled AS "PasskeyEnabled",
                   u.recovery_enabled AS "RecoveryEnabled",
                   u.riskflags AS "RiskFlags",
                   (SELECT COUNT(1)
                    FROM sys_user_session s
                    WHERE s.userid = u.id
                      AND s.revokedat IS NULL) AS "ActiveSessionCount",
                   p.account_id AS "PreferenceAccountId",
                   p.mode AS "PreferenceMode",
                   p.fixed_locale AS "PreferenceFixedLocale",
                   p.revision AS "PreferenceRevision",
                   p.updated_at AS "PreferenceUpdatedAt"
            FROM sys_user u
            LEFT JOIN user_locale_preference p ON p.account_id = u.id
            WHERE u.id = @UserId
            LIMIT 1;
            """;

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            Sql,
            new SugarParameter("@UserId", userId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return new AccountProfilePreferenceObservedState(
                userId,
                false,
                null,
                0,
                0,
                false,
                false,
                false,
                0,
                0,
                false,
                s_defaultPreference,
                ComputeSecurityDigest(userId, 0, false, false, false, 0, 0));
        }

        bool preferenceExists = !reader.IsDBNull(reader.GetOrdinal("PreferenceAccountId"));
        UserLocalePreferenceDto preference = preferenceExists
            ? new UserLocalePreferenceDto(
                reader.GetString(reader.GetOrdinal("PreferenceMode")),
                reader.IsDBNull(reader.GetOrdinal("PreferenceFixedLocale"))
                    ? null
                    : reader.GetString(reader.GetOrdinal("PreferenceFixedLocale")),
                reader.GetInt64(reader.GetOrdinal("PreferenceRevision")),
                DateTime.SpecifyKind(
                    reader.GetDateTime(reader.GetOrdinal("PreferenceUpdatedAt")),
                    DateTimeKind.Utc))
            : s_defaultPreference;
        int status = reader.GetInt32(reader.GetOrdinal("Status"));
        bool mfaEnabled = reader.GetBoolean(reader.GetOrdinal("MfaEnabled"));
        bool passkeyEnabled = reader.GetBoolean(reader.GetOrdinal("PasskeyEnabled"));
        bool recoveryEnabled = reader.GetBoolean(reader.GetOrdinal("RecoveryEnabled"));
        int riskFlags = reader.GetInt32(reader.GetOrdinal("RiskFlags"));
        int activeSessionCount = Convert.ToInt32(
            reader.GetValue(reader.GetOrdinal("ActiveSessionCount")),
            CultureInfo.InvariantCulture);
        return new AccountProfilePreferenceObservedState(
            userId,
            true,
            reader.IsDBNull(reader.GetOrdinal("PublicHandle"))
                ? null
                : reader.GetString(reader.GetOrdinal("PublicHandle")),
            reader.GetInt64(reader.GetOrdinal("ProfileRevision")),
            status,
            mfaEnabled,
            passkeyEnabled,
            recoveryEnabled,
            riskFlags,
            activeSessionCount,
            preferenceExists,
            preference,
            ComputeSecurityDigest(
                userId,
                status,
                mfaEnabled,
                passkeyEnabled,
                recoveryEnabled,
                riskFlags,
                activeSessionCount));
    }

    public Task<int> CountHandleOwnersAsync(
        string publicHandle,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return db.Ado.GetIntAsync(
            """
            SELECT COUNT(1)
            FROM sys_user
            WHERE public_handle = @PublicHandle;
            """,
            new SugarParameter("@PublicHandle", publicHandle));
    }

    private static string ComputeSecurityDigest(
        int userId,
        int status,
        bool mfaEnabled,
        bool passkeyEnabled,
        bool recoveryEnabled,
        int riskFlags,
        int activeSessionCount)
    {
        string canonical = string.Join(
            '|',
            userId.ToString(CultureInfo.InvariantCulture),
            status.ToString(CultureInfo.InvariantCulture),
            mfaEnabled ? "1" : "0",
            passkeyEnabled ? "1" : "0",
            recoveryEnabled ? "1" : "0",
            riskFlags.ToString(CultureInfo.InvariantCulture),
            activeSessionCount.ToString(CultureInfo.InvariantCulture));
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }
}
