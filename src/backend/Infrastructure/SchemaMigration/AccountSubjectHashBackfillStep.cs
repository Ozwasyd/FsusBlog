using System.Data.Common;
using System.Globalization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>
/// Resumable C# backfill for the physical account-subject projection. The C#
/// hasher is deliberately reused here so PostgreSQL collation/case-folding
/// differences cannot change the canonical digest.
/// </summary>
public sealed record AccountSubjectHashBackfillStep : SchemaMigrationStep
{
    internal const int BatchSize = 256;

    internal override string Kind => "AccountSubjectHashBackfill";
    internal override string Fingerprint => "v1:csharp-canonical-hasher:keyset-batch-256";
    internal override SchemaMigrationCommand? BuildCommand(ISchemaDdlProvider ddl) => null;

    internal override async Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        var handler = new AccountSubjectHashOnlineBackfillHandler(db);
        string? resumeToken = null;
        while (true)
        {
            OnlineSchemaBackfillBatchResult batch = await handler.ExecuteBatchAsync(
                    resumeToken,
                    BatchSize,
                    cancellationToken)
                .ConfigureAwait(false);
            if (batch.Complete)
            {
                if (!await handler.VerifyAsync(cancellationToken).ConfigureAwait(false))
                {
                    throw new InvalidOperationException("account_subject_hash_backfill_verification_failed");
                }
                return;
            }
            if (batch.RowsProcessed <= 0
                || string.Equals(batch.ResumeToken, resumeToken, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("account_subject_hash_backfill_no_progress");
            }
            resumeToken = batch.ResumeToken;
        }
    }
}

public sealed class AccountSubjectHashOnlineBackfillHandler(ISqlSugarClient db)
    : IOnlineSchemaBackfillHandler
{
    public const string ExpandMigrationId = "20260711-pre-account-subject-hash-expand";
    public const string BackfillMigrationId = "20260711-post-account-subject-hash-backfill";

    public string MigrationId => BackfillMigrationId;

    public async Task<OnlineSchemaBackfillBatchResult> ExecuteBatchAsync(
        string? resumeToken,
        int batchSize,
        CancellationToken cancellationToken)
    {
        if (batchSize is <= 0 or > 1000)
        {
            throw new ArgumentOutOfRangeException(nameof(batchSize), "Backfill batch size must be between 1 and 1000.");
        }

        int lastAccountId = ParseResumeToken(resumeToken);
        if (!await TableExistsAsync(cancellationToken).ConfigureAwait(false))
        {
            return new OnlineSchemaBackfillBatchResult(resumeToken, 0, Complete: true, RemainingRowsEstimate: 0);
        }

        List<AccountIdentityMaterial> batch = await ReadBatchAsync(
                lastAccountId,
                batchSize,
                cancellationToken)
            .ConfigureAwait(false);
        if (batch.Count == 0)
        {
            long remaining = await CountInvalidAsync().ConfigureAwait(false);
            return new OnlineSchemaBackfillBatchResult(
                resumeToken,
                0,
                Complete: remaining == 0,
                RemainingRowsEstimate: remaining);
        }

        foreach (AccountIdentityMaterial row in batch)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string accountSubjectHash = AccountSubjectHasher.Create(new User
            {
                Id = row.AccountId,
                IdentityKind = row.IdentityKind ?? AnonymousIdentityRuntime.AnonymousAccountKind,
                PasskeyUserHandle = row.PasskeyUserHandle,
                PublicHandle = row.PublicHandle
            });

            await db.Ado.ExecuteCommandAsync(
                """
                UPDATE sys_user
                SET account_subject_hash = @AccountSubjectHash
                WHERE id = @AccountId
                  AND (
                      account_subject_hash IS NULL
                      OR btrim(account_subject_hash) = ''
                      OR account_subject_hash !~ '^[0-9a-f]{64}$'
                  );
                """,
                new SugarParameter("@AccountSubjectHash", accountSubjectHash),
                new SugarParameter("@AccountId", row.AccountId)).ConfigureAwait(false);
        }

        int nextAccountId = batch[^1].AccountId;
        long remainingRows = await CountInvalidAsync().ConfigureAwait(false);
        return new OnlineSchemaBackfillBatchResult(
            nextAccountId.ToString(CultureInfo.InvariantCulture),
            batch.Count,
            Complete: remainingRows == 0,
            RemainingRowsEstimate: remainingRows);
    }

    public async Task<bool> VerifyAsync(CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(cancellationToken).ConfigureAwait(false))
        {
            return true;
        }
        if (await CountInvalidAsync().ConfigureAwait(false) != 0)
        {
            return false;
        }

        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'ck_sys_user_account_subject_hash_format'
                      AND conrelid = 'sys_user'::regclass
                ) THEN
                    ALTER TABLE sys_user
                    ADD CONSTRAINT ck_sys_user_account_subject_hash_format
                    CHECK (
                        account_subject_hash IS NULL
                        OR account_subject_hash ~ '^[0-9a-f]{64}$'
                    ) NOT VALID;
                END IF;

                ALTER TABLE sys_user
                VALIDATE CONSTRAINT ck_sys_user_account_subject_hash_format;
            END $$;
            """).ConfigureAwait(false);
        return await CountInvalidAsync().ConfigureAwait(false) == 0;
    }

    private async Task<List<AccountIdentityMaterial>> ReadBatchAsync(
        int lastAccountId,
        int batchSize,
        CancellationToken cancellationToken)
    {
        var rows = new List<AccountIdentityMaterial>(batchSize);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id,
                   identity_kind,
                   passkey_user_handle,
                   public_handle
            FROM sys_user
            WHERE id > @LastAccountId
              AND (
                  account_subject_hash IS NULL
                  OR btrim(account_subject_hash) = ''
                  OR account_subject_hash !~ '^[0-9a-f]{64}$'
              )
            ORDER BY id
            LIMIT @BatchSize;
            """,
            new SugarParameter("@LastAccountId", lastAccountId),
            new SugarParameter("@BatchSize", batchSize)).ConfigureAwait(false);

        int idOrdinal = reader.GetOrdinal("id");
        int identityKindOrdinal = reader.GetOrdinal("identity_kind");
        int passkeyUserHandleOrdinal = reader.GetOrdinal("passkey_user_handle");
        int publicHandleOrdinal = reader.GetOrdinal("public_handle");
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new AccountIdentityMaterial(
                reader.GetInt32(idOrdinal),
                ReadNullableString(reader, identityKindOrdinal),
                ReadNullableString(reader, passkeyUserHandleOrdinal),
                ReadNullableString(reader, publicHandleOrdinal)));
        }

        return rows;
    }

    private async Task<bool> TableExistsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int tableExists = await db.Ado.GetIntAsync(
            """
            SELECT COUNT(1)
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'sys_user';
            """).ConfigureAwait(false);
        return tableExists > 0;
    }

    private async Task<long> CountInvalidAsync()
        => await db.Ado.GetIntAsync(
            """
            SELECT COUNT(1)
            FROM sys_user
            WHERE account_subject_hash IS NULL
               OR btrim(account_subject_hash) = ''
               OR account_subject_hash !~ '^[0-9a-f]{64}$';
            """).ConfigureAwait(false);

    private static int ParseResumeToken(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return 0;
        }
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int accountId)
            || accountId < 0)
        {
            throw new InvalidOperationException("account_subject_hash_backfill_resume_token_invalid");
        }
        return accountId;
    }

    private static string? ReadNullableString(DbDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private sealed record AccountIdentityMaterial(
        int AccountId,
        string? IdentityKind,
        string? PasskeyUserHandle,
        string? PublicHandle);
}
