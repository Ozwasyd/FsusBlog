using FsusBlog.V2.Contracts;
using Npgsql;
using NpgsqlTypes;

internal static partial class Migration
{
    private static async Task<(LegacyPasskeyCredential[] Credentials, string Sha)> ReadLegacyPasskeyCredentialsAsync(LegacySource source,
        NpgsqlTransaction tx, int account, bool keepMfa, CancellationToken ct)
    {
        var catalog = await ReadLegacyCatalogAsync(source, tx, ct);
        if (catalog.Any(table => table.Name.Equals("v2_schema", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Passkey import requires an original v1 source.");
        var users = LegacyPasskeyTable(catalog, "sys_user");
        var credentials = LegacyPasskeyTable(catalog, "passkey_credential");
        foreach (var (name, owner) in new[] { ("user_mfa_profile", "user_id"), ("account_recovery_key", "account_id") })
        {
            if (keepMfa && name == "user_mfa_profile" || catalog.All(table => table.Name != name)) continue;
            var relation = LegacyPasskeyTable(catalog, name);
            await using var dependants = new NpgsqlCommand($"SELECT EXISTS(SELECT FROM {source.Table(relation)} WHERE {owner}=$1)", tx.Connection, tx);
            dependants.Parameters.AddWithValue(account);
            if (await dependants.ExecuteScalarAsync(ct) is not false)
                throw new InvalidOperationException("Legacy MFA and recovery authority require a separately verified transition.");
        }

        await using var query = new NpgsqlCommand($"""
            SELECT u.public_handle, u.account_subject_hash, u.passkey_user_handle, p.id,
                CASE WHEN octet_length(p.credentialid)<=512 THEN p.credentialid END,
                CASE WHEN octet_length(p.publickey)<=21900 THEN p.publickey END,
                p.signcount,p.backupeligible,p.backupstate,p.createdat,p.lastusedat,u.passkey_signal_version,
                p.tableoid=to_regclass($3) AND p.recovery_session_hash IS NULL AND p.recovery_request_hash IS NULL
                    AND NOT EXISTS (SELECT FROM {source.Table(credentials)} other
                        WHERE other.account_id IS DISTINCT FROM p.account_id AND other.credentialid=p.credentialid)
            FROM {source.Table(users)} u JOIN {source.Table(credentials)} p ON p.account_id=u.id
            WHERE u.id=$1 AND u.tableoid=to_regclass($2)
                AND u.identity_kind='anonymous_account' AND u.registration_state='active' AND u.status=0 AND u.deleted_at IS NULL
                AND u.ban_state_generation=1 AND u.passkey_enabled
                AND u.mfaenabled=$4 AND NOT u.recovery_enabled
                AND (u.public_handle IS NULL OR octet_length(u.public_handle)<=256)
                AND NOT EXISTS (SELECT FROM {source.Table(users)} other_user WHERE other_user.id<>u.id
                    AND (other_user.passkey_user_handle=u.passkey_user_handle OR other_user.account_subject_hash=u.account_subject_hash))
            ORDER BY p.id LIMIT {LegacyPasskeyCredentialLimit + 1}
            """, tx.Connection, tx);
        query.Parameters.AddWithValue(account);
        query.Parameters.AddWithValue(source.Table(users));
        query.Parameters.AddWithValue(source.Table(credentials));
        query.Parameters.AddWithValue(keepMfa);
        await using var row = await query.ExecuteReaderAsync(ct);
        var observed = new List<LegacyPasskeyCredential>();
        var commitments = new List<string>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        long signal = 0, previousRowId = 0;
        while (await row.ReadAsync(ct))
        {
            var rowId = AssetInteger(row.GetValue(3));
            if (observed.Count == LegacyPasskeyCredentialLimit || rowId <= previousRowId ||
                row.IsDBNull(12) || !row.GetBoolean(12) || IdentityText(row, 1) is not { } subject || !IsSha256(subject) ||
                !IsCanonicalIdentityBytes(IdentityText(row, 2), WireLimits.PasskeyUserHandleBytes, WireLimits.PasskeyUserHandleBytes) ||
                !IsCanonicalIdentityBytes(IdentityText(row, 4), 1, WireLimits.PasskeyCredentialIdBytes) || !ids.Add(row.GetString(4)) ||
                !IsCanonicalIdentityBytes(IdentityText(row, 5), 1, 16384) || IdentityTime(row, 9) is not { } created)
                throw new InvalidOperationException("The old account or complete Passkey set is unsupported or ambiguous.");

            var handle = IdentityText(row, 0);
            var last = IdentityTime(row, 10);
            var counter = AssetInteger(row.GetValue(6));
            var eligible = IdentityBoolean(row, 7);
            var backedUp = IdentityBoolean(row, 8);
            if (counter is < 0 or > uint.MaxValue || backedUp && !eligible || last < created)
                throw new InvalidOperationException("Unknown old Passkey counter, backup or timestamp state.");
            var credential = new LegacyPasskeyCredential(ReadCanonicalBase64Url(row.GetString(2), 43, 43),
                ReadCanonicalBase64Url(row.GetString(4), 2, 512), ReadCanonicalBase64Url(row.GetString(5), 2, 21900),
                (uint)counter, eligible, backedUp, created, last);
            signal = AssetInteger(row.GetValue(11));
            previousRowId = rowId;
            observed.Add(credential);
            commitments.Add(DigestMediaDocument(new { account, handle, subject, rowId, credential }));
        }
        if (observed.Count == 0 || signal != observed.Count)
            throw new InvalidOperationException("Passkey import requires an active legacy account with its complete ordinary enrollment history.");
        return (observed.ToArray(), commitments.Count == 1 ? commitments[0] : DigestMediaDocument(commitments));
    }

    private static LegacyTable LegacyPasskeyTable(LegacyTable[] catalog, string name) =>
        catalog.SingleOrDefault(table => table.Name == name) is { Kind: "r" } relation ? relation :
            throw new InvalidOperationException("The selected old identity relation is absent or unsupported.");

    private const string LegacyPasskeyAccountSequence = "passkey_subject_account_id_seq";

    private static async Task<(LegacyPasskeySequence Sequence, int PriorMax)> ReadLegacyPasskeySequenceAsync(
        NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand($"""
            SELECT last_value,is_called,(SELECT coalesce(max(account_id),0) FROM public.passkey_subject WHERE user_id<>$1)
            FROM public.{LegacyPasskeyAccountSequence}
            """, db, tx);
        query.Parameters.AddWithValue(owner);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new InvalidOperationException("The Passkey sequence is unavailable.");
        return (new(row.GetInt64(0), row.GetBoolean(1)), row.GetInt32(2));
    }

    private static async Task VerifyLegacyPasskeySequenceBaselineAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        BackupRelation[] baseline, LegacyPasskeySequence before, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            SELECT pg_catalog.row_to_json(t)::text FROM (SELECT $1::bigint AS last_value,$2::boolean AS is_called) t
            """, db, tx);
        query.Parameters.AddWithValue(before.LastValue);
        query.Parameters.AddWithValue(before.IsCalled);
        await using var rows = await query.ExecuteReaderAsync(ct);
        if (await MeasureBackupRowsAsync(LegacyPasskeyAccountSequence, "S", rows, ct) !=
            baseline.Single(relation => relation.Name == LegacyPasskeyAccountSequence))
            throw new InvalidOperationException("The approved Passkey sequence is not bound to the rollback backup.");
    }

    private static async Task VerifyLegacyPasskeyPriorAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        BackupRelation[] baseline, bool keepMfa, CancellationToken ct)
    {
        var prior = new (string Relation, string Key)[] { ("blog_user", "id"), ("passkey_subject", "user_id"), ("passkey_credential", "credential_id") };
        foreach (var (relation, key) in keepMfa ? [.. prior, ("mfa_totp", "user_id")] : prior)
        {
            var filter = relation == "blog_user" ? "" : "WHERE t.user_id<>$1";
            await using var query = new NpgsqlCommand($"""
                SELECT CASE WHEN pg_catalog.octet_length(pg_catalog.row_to_json(t)::text)<={BackupRowBytes}
                    THEN pg_catalog.row_to_json(t)::text END
                FROM public.{relation} t {filter} ORDER BY t.{key} LIMIT {BackupRowsPerRelation + 1}
                """, db, tx);
            if (filter.Length != 0) query.Parameters.AddWithValue(owner);
            await using var rows = await query.ExecuteReaderAsync(ct);
            if (await MeasureBackupRowsAsync(relation, "r", rows, ct) != baseline.Single(item => item.Name == relation))
                throw new InvalidOperationException("The previous Passkey or account-owner rows differ from the rollback backup.");
        }
    }

    private static async Task VerifyLegacyPasskeyAvailableAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyPasskeySelection selection, LegacyPasskeyCredential[] credentials, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            SELECT NOT EXISTS (SELECT FROM public.passkey_subject WHERE user_id=$1 OR account_id=$2 OR user_handle=$3)
                AND NOT EXISTS (SELECT FROM public.passkey_credential WHERE credential_id=ANY($4))
            """, db, tx);
        query.Parameters.AddWithValue(selection.User);
        query.Parameters.AddWithValue(selection.Account);
        query.Parameters.AddWithValue(credentials[0].Handle);
        query.Parameters.AddWithValue(credentials.Select(credential => credential.Id).ToArray());
        if (await query.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The target Passkey owner, account number, handle or credential is already allocated.");
    }

    private static async Task WriteLegacyPasskeysAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyPasskeySelection selection, LegacyVerifiedPasskey[] verified, long? restartWith, CancellationToken ct)
    {
        await using var subject = new NpgsqlCommand(
            "INSERT INTO public.passkey_subject (user_id,account_id,user_handle) VALUES ($1,$2,$3)", db, tx);
        subject.Parameters.AddWithValue(selection.User);
        subject.Parameters.AddWithValue(selection.Account);
        subject.Parameters.AddWithValue(verified[0].Credential.Handle);
        if (await subject.ExecuteNonQueryAsync(ct) != 1)
            throw new InvalidOperationException("The approved Passkey subject was not installed.");
        foreach (var entry in verified)
        {
            await using var insert = new NpgsqlCommand("""
                INSERT INTO public.passkey_credential (user_id,credential_id,public_key,sign_count,backup_eligible,backed_up,created_at,last_used_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                """, db, tx);
            BindLegacyPasskeyParameters(insert, selection, entry);
            if (await insert.ExecuteNonQueryAsync(ct) != 1)
                throw new InvalidOperationException("The approved Passkey was not installed.");
        }
        if (restartWith is { } next)
            await ExecuteAsync(db, tx, FormattableString.Invariant(
                $"ALTER SEQUENCE public.{LegacyPasskeyAccountSequence} RESTART WITH {next}"), ct);
    }

    private static async Task VerifyLegacyPasskeyDestinationAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyPasskeySelection selection, LegacyVerifiedPasskey[] verified, CancellationToken ct)
    {
        foreach (var entry in verified)
        {
            await using var query = new NpgsqlCommand("""
                SELECT (SELECT count(*) FROM public.passkey_credential WHERE user_id=$1)=$11
                    AND EXISTS (SELECT FROM public.passkey_subject s JOIN public.passkey_credential c USING (user_id)
                        WHERE s.user_id=$1 AND s.account_id=$9 AND s.user_handle=$10 AND c.credential_id=$2 AND c.public_key=$3
                            AND c.sign_count=$4 AND c.backup_eligible=$5 AND c.backed_up=$6 AND c.created_at=$7
                            AND c.last_used_at IS NOT DISTINCT FROM $8)
                """, db, tx);
            BindLegacyPasskeyParameters(query, selection, entry);
            query.Parameters.AddWithValue(selection.Account);
            query.Parameters.AddWithValue(entry.Credential.Handle);
            query.Parameters.AddWithValue(verified.Length);
            if (await query.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException("The Passkey destination is not the complete approved result.");
        }
    }

    private static void BindLegacyPasskeyParameters(NpgsqlCommand query, LegacyPasskeySelection selection, LegacyVerifiedPasskey entry)
    {
        var credential = entry.Credential;
        foreach (var value in new object[] { selection.User, credential.Id, credential.Key, (long)entry.Counter,
                     credential.Eligible, credential.BackedUp, credential.Created })
            query.Parameters.AddWithValue(value);
        query.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.TimestampTz, Value = (object?)credential.LastUsed ?? DBNull.Value });
    }
}
