using System.Data.Common;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Shared.Contracts.Localization;
using FsusBlog.Shared.Contracts.Outputs;

using Npgsql;

using NpgsqlTypes;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed class UserLocalePreferenceService(
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

        bool borrowed = db.Ado.Transaction is not null;
        try
        {
            UserLocalePreferenceDto previous = s_default;
            bool previousExisted = false;
            UserLocalePreferenceDto? committed = null;
            async Task ApplyAsync()
            {
                await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
                UserLocaleMutationReceiptPersistence.Capture capture = await UserLocaleMutationReceiptPersistence
                    .CaptureBeforeAsync(db, accountId, cancellationToken: cancellationToken).ConfigureAwait(false);
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
                    UserLocaleMutationReceipt receipt = await UserLocaleMutationReceiptPersistence
                        .PersistActualAfterAsync(db, capture, affected, cancellationToken).ConfigureAwait(false)
                        ?? throw new InvalidOperationException("locale_source_receipt_required");
                    await ArticleSourceGenerationAuthority.RecordDisplayLocaleAsync(db, receipt.ReceiptId, cancellationToken)
                        .ConfigureAwait(false);
                    UserLocalePreferenceReceiptState actual = receipt.After
                        ?? throw new InvalidOperationException("locale_source_after_state_required");
                    committed = new UserLocalePreferenceDto(
                        actual.Mode, actual.FixedLocale, actual.Revision, actual.UpdatedAt);
                }
            }
            if (borrowed)
            {
                await ApplyAsync().ConfigureAwait(false);
            }
            else
            {
                var transaction = await db.Ado.UseTranAsync(ApplyAsync).ConfigureAwait(false);
                if (!transaction.IsSuccess)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    logger.LogWarning("Locale preference transaction failed | reason=transaction_error");
                    return new UserLocalePreferenceUpdateResult(
                        UserLocalePreferenceUpdateOutcome.Unavailable,
                        null,
                        null,
                        false);
                }
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
        catch (Exception exception) when (!borrowed)
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
        bool borrowed = db.Ado.Transaction is not null;
        try
        {
            async Task<bool> ApplyAsync()
            {
                await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
                Guid? originalReceiptId = await FindUncompensatedUpdateReceiptAsync(accountId,
                    committedPreference, previousPreference, previousPreferenceExisted, cancellationToken).ConfigureAwait(false);
                if (!originalReceiptId.HasValue)
                {
                    return false;
                }
                UserLocaleMutationReceiptPersistence.Capture capture = await UserLocaleMutationReceiptPersistence
                    .CaptureBeforeAsync(db, accountId, originalReceiptId, cancellationToken).ConfigureAwait(false);
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
                UserLocaleMutationReceipt? receipt = await UserLocaleMutationReceiptPersistence
                    .PersistActualAfterAsync(db, capture, affected, cancellationToken).ConfigureAwait(false);
                if (receipt is null)
                {
                    return false;
                }
                await ArticleSourceGenerationAuthority.RecordDisplayLocaleAsync(db, receipt.ReceiptId, cancellationToken)
                    .ConfigureAwait(false);
                return true;
            }
            if (borrowed)
                return await ApplyAsync().ConfigureAwait(false);
            var transaction = await db.Ado.UseTranAsync(ApplyAsync).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (!transaction.IsSuccess)
            {
                logger.LogError(transaction.ErrorException, "Locale preference compensation failed | account={AccountId}", accountId);
                return false;
            }
            return transaction.Data;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (!borrowed)
        {
            logger.LogError(exception, "Locale preference compensation failed | account={AccountId}", accountId);
            return false;
        }
    }

    // The original compensation port carries full states, not a receipt ID. Resolve
    // exactly one persisted, unconsumed update; ambiguity refuses rather than picking
    // a revision/timestamp/latest row as authority. No clock is allocated by this read.
    private async Task<Guid?> FindUncompensatedUpdateReceiptAsync(int accountId,
        UserLocalePreferenceDto committed, UserLocalePreferenceDto previous, bool previousExisted,
        CancellationToken cancellationToken)
    {
        (NpgsqlConnection connection, NpgsqlTransaction transaction) = ArticleSourceGenerationAuthority.RequireTransaction(db);
        await using NpgsqlCommand command = new("""
            SELECT original.receipt_id
            FROM user_locale_mutation_receipt original
            WHERE original.account_id = @AccountId AND original.mutation_kind = 'update'
              AND original.after_state = @After
              AND original.before_state IS NOT DISTINCT FROM @Before
              AND NOT EXISTS (SELECT 1 FROM user_locale_mutation_receipt undo
                  WHERE undo.compensates_receipt_id = original.receipt_id)
            LIMIT 2;
            """, connection, transaction);
        command.Parameters.AddWithValue("AccountId", accountId);
        command.Parameters.AddWithValue("After", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(
            new UserLocalePreferenceReceiptState(committed.Mode, committed.FixedLocale, committed.Revision, committed.UpdatedAt)));
        command.Parameters.AddWithValue("Before", NpgsqlDbType.Jsonb, previousExisted
            ? JsonSerializer.Serialize(new UserLocalePreferenceReceiptState(previous.Mode, previous.FixedLocale, previous.Revision, previous.UpdatedAt))
            : DBNull.Value);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            return null;
        Guid receiptId = reader.GetGuid(0);
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            throw new InvalidOperationException("locale_source_compensation_receipt_ambiguous");
        return receiptId;
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
