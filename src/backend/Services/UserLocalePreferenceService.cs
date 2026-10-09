using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class UserLocalePreferenceService(
    ISqlSugarClient db,
    ILogger<UserLocalePreferenceService> logger,
    TimeProvider? timeProvider = null)
    : IUserLocalePreferenceReader, IUserLocalePreferenceCommand
{
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private static readonly UserLocalePreferenceDto s_default =
        new(LocalePreferenceModes.Auto, null, 0, DateTime.UnixEpoch);

    public async Task<UserLocalePreferenceDto> GetAsync(
        int accountId,
        CancellationToken cancellationToken = default)
    {
        const string Sql = """
            SELECT mode AS "Mode",
                   fixed_locale AS "FixedLocale",
                   revision AS "Revision",
                   updated_at AS "UpdatedAt"
            FROM user_locale_preference
            WHERE account_id = @AccountId
            LIMIT 1;
            """;

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            Sql,
            new SugarParameter("@AccountId", accountId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadPreference(reader)
            : s_default;
    }

    public async Task<UserLocalePreferenceUpdateResult> UpdateAsync(
        int accountId,
        UserLocalePreferenceUpdateDto request,
        CancellationToken cancellationToken = default)
        => await UpdateCoreAsync(
            accountId,
            request,
            _timeProvider.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);

    internal Task<UserLocalePreferenceUpdateResult> UpdateAtAsync(
        int accountId,
        UserLocalePreferenceUpdateDto request,
        DateTimeOffset updatedAt,
        CancellationToken cancellationToken = default)
    {
        if (updatedAt.Offset != TimeSpan.Zero
            || updatedAt.Ticks % TimeSpan.TicksPerMillisecond != 0)
        {
            throw new InvalidOperationException(
                "locale preference fixture time must be an exact millisecond UTC instant");
        }
        return UpdateCoreAsync(accountId, request, updatedAt, cancellationToken);
    }

    private async Task<UserLocalePreferenceUpdateResult> UpdateCoreAsync(
        int accountId,
        UserLocalePreferenceUpdateDto request,
        DateTimeOffset updatedAt,
        CancellationToken cancellationToken)
    {
        if (!TryNormalize(request, out UserLocalePreferenceUpdateDto normalized, out UserLocalePreferenceUpdateOutcome invalid))
        {
            return new UserLocalePreferenceUpdateResult(invalid, null, null, false);
        }

        try
        {
            UserLocalePreferenceDto previous = s_default;
            bool previousExisted = false;
            UserLocalePreferenceDto? committed = null;
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                (previous, previousExisted) = await ReadForUpdateAsync(accountId, cancellationToken).ConfigureAwait(false);
                if (previous.Revision != normalized.ExpectedRevision)
                {
                    return;
                }

                long revision = checked(previous.Revision + 1);
                SugarParameter[] parameters =
                [
                    new("@AccountId", accountId),
                    new("@Mode", normalized.Mode),
                    new("@FixedLocale", normalized.FixedLocale),
                    new("@Revision", revision),
                    new("@UpdatedAt", updatedAt.UtcDateTime),
                    new("@ExpectedRevision", normalized.ExpectedRevision)
                ];
                int affected = previousExisted
                    ? await db.Ado.ExecuteCommandAsync(
                        """
                        UPDATE user_locale_preference
                        SET mode = @Mode,
                            fixed_locale = @FixedLocale,
                            revision = @Revision,
                            updated_at = @UpdatedAt
                        WHERE account_id = @AccountId
                          AND revision = @ExpectedRevision;
                        """,
                        parameters).ConfigureAwait(false)
                    : await db.Ado.ExecuteCommandAsync(
                        """
                        INSERT INTO user_locale_preference (
                            account_id, mode, fixed_locale, revision, updated_at)
                        SELECT @AccountId, @Mode, @FixedLocale, @Revision, @UpdatedAt
                        WHERE @ExpectedRevision = 0
                        ON CONFLICT (account_id) DO NOTHING;
                        """,
                        parameters).ConfigureAwait(false);

                if (affected == 1)
                {
                    committed = new UserLocalePreferenceDto(
                        normalized.Mode,
                        normalized.FixedLocale,
                        revision,
                        updatedAt.UtcDateTime);
                }
            }).ConfigureAwait(false);

            if (!transaction.IsSuccess)
            {
                logger.LogWarning("Locale preference transaction failed | reason=transaction_error");
                return new UserLocalePreferenceUpdateResult(
                    UserLocalePreferenceUpdateOutcome.Unavailable,
                    null,
                    null,
                    false);
            }

            return committed.HasValue
                ? new UserLocalePreferenceUpdateResult(
                    UserLocalePreferenceUpdateOutcome.Success,
                    committed,
                    previous,
                    previousExisted)
                : new UserLocalePreferenceUpdateResult(
                    UserLocalePreferenceUpdateOutcome.RevisionConflict,
                    null,
                    previous,
                    previousExisted);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Locale preference update unavailable | reason=persistence_error");
            return new UserLocalePreferenceUpdateResult(
                UserLocalePreferenceUpdateOutcome.Unavailable,
                null,
                null,
                false);
        }
    }

    public async Task<bool> CompensateAsync(
        int accountId,
        UserLocalePreferenceDto committedPreference,
        UserLocalePreferenceDto previousPreference,
        bool previousPreferenceExisted,
        CancellationToken cancellationToken = default)
    {
        try
        {
            int affected = previousPreferenceExisted
                ? await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE user_locale_preference
                    SET mode = @Mode,
                        fixed_locale = @FixedLocale,
                        revision = @PreviousRevision,
                        updated_at = @PreviousUpdatedAt
                    WHERE account_id = @AccountId
                      AND revision = @CommittedRevision;
                    """,
                    new SugarParameter[]
                    {
                        new SugarParameter("@Mode", previousPreference.Mode),
                        new SugarParameter("@FixedLocale", previousPreference.FixedLocale),
                        new SugarParameter("@PreviousRevision", previousPreference.Revision),
                        new SugarParameter("@PreviousUpdatedAt", previousPreference.UpdatedAt),
                        new SugarParameter("@AccountId", accountId),
                        new SugarParameter("@CommittedRevision", committedPreference.Revision)
                    }).ConfigureAwait(false)
                : await db.Ado.ExecuteCommandAsync(
                    """
                    DELETE FROM user_locale_preference
                    WHERE account_id = @AccountId
                      AND revision = @CommittedRevision;
                    """,
                    new SugarParameter[]
                    {
                        new SugarParameter("@AccountId", accountId),
                        new SugarParameter("@CommittedRevision", committedPreference.Revision)
                    }).ConfigureAwait(false);
            return affected == 1;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Locale preference compensation failed | account={AccountId}", accountId);
            return false;
        }
    }

    private async Task<(UserLocalePreferenceDto Preference, bool Existed)> ReadForUpdateAsync(
        int accountId,
        CancellationToken cancellationToken)
    {
        const string Sql = """
            SELECT mode AS "Mode",
                   fixed_locale AS "FixedLocale",
                   revision AS "Revision",
                   updated_at AS "UpdatedAt"
            FROM user_locale_preference
            WHERE account_id = @AccountId
            FOR UPDATE;
            """;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            Sql,
            new SugarParameter("@AccountId", accountId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? (ReadPreference(reader), true)
            : (s_default, false);
    }

    private static UserLocalePreferenceDto ReadPreference(DbDataReader reader)
    {
        int mode = reader.GetOrdinal("Mode");
        int fixedLocale = reader.GetOrdinal("FixedLocale");
        int revision = reader.GetOrdinal("Revision");
        int updatedAt = reader.GetOrdinal("UpdatedAt");
        return new UserLocalePreferenceDto(
            reader.GetString(mode),
            reader.IsDBNull(fixedLocale) ? null : reader.GetString(fixedLocale),
            reader.GetInt64(revision),
            DateTime.SpecifyKind(reader.GetDateTime(updatedAt), DateTimeKind.Utc));
    }

    private static bool TryNormalize(
        UserLocalePreferenceUpdateDto request,
        out UserLocalePreferenceUpdateDto normalized,
        out UserLocalePreferenceUpdateOutcome invalid)
    {
        string mode = request.Mode?.Trim().ToLowerInvariant() ?? string.Empty;
        if (mode is not (LocalePreferenceModes.Auto or LocalePreferenceModes.Fixed))
        {
            normalized = default;
            invalid = UserLocalePreferenceUpdateOutcome.InvalidMode;
            return false;
        }

        if (request.ExpectedRevision < 0)
        {
            normalized = default;
            invalid = UserLocalePreferenceUpdateOutcome.RevisionConflict;
            return false;
        }

        if (mode == LocalePreferenceModes.Auto)
        {
            if (request.FixedLocale is not null)
            {
                normalized = default;
                invalid = UserLocalePreferenceUpdateOutcome.InvalidLocale;
                return false;
            }

            normalized = new UserLocalePreferenceUpdateDto(mode, null, request.ExpectedRevision);
            invalid = default;
            return true;
        }

        if (!LocaleCatalog.TryParse(request.FixedLocale, out LocaleDescriptor descriptor)
            || !string.Equals(request.FixedLocale, descriptor.Code, StringComparison.Ordinal))
        {
            normalized = default;
            invalid = UserLocalePreferenceUpdateOutcome.InvalidLocale;
            return false;
        }

        normalized = new UserLocalePreferenceUpdateDto(mode, descriptor.Code, request.ExpectedRevision);
        invalid = default;
        return true;
    }
}
