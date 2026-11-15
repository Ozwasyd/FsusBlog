using System.Globalization;
using FsusBlog.V2.Contracts;
using Npgsql;
using NpgsqlTypes;

internal static partial class Migration
{
    private static async Task<(LegacyPasskeyCredential Credential, string Sha)> ReadLegacyPasskeyCredentialAsync(LegacySource source,
        NpgsqlTransaction tx, int account, CancellationToken ct)
    {
        var catalog = await ReadLegacyCatalogAsync(source, tx, ct);
        if (catalog.Any(table => table.Name.Equals("v2_schema", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Passkey import requires an original v1 source.");
        var users = LegacyPasskeyTable(catalog, "sys_user");
        var credentials = LegacyPasskeyTable(catalog, "passkey_credential");
        foreach (var (name, owner) in new[] { ("user_mfa_profile", "user_id"), ("account_recovery_key", "account_id") })
        {
            if (catalog.All(table => table.Name != name)) continue;
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
                p.signcount,p.backupeligible,p.backupstate,p.createdat,p.lastusedat
            FROM {source.Table(users)} u JOIN {source.Table(credentials)} p ON p.account_id=u.id
            WHERE u.id=$1 AND u.tableoid=to_regclass($2) AND p.tableoid=to_regclass($3)
                AND u.identity_kind='anonymous_account' AND u.registration_state='active' AND u.status=0 AND u.deleted_at IS NULL
                AND u.ban_state_generation=1 AND u.passkey_signal_version=1 AND u.passkey_enabled
                AND NOT u.mfaenabled AND NOT u.recovery_enabled
                AND p.recovery_session_hash IS NULL AND p.recovery_request_hash IS NULL
                AND (u.public_handle IS NULL OR octet_length(u.public_handle)<=256)
                AND NOT EXISTS (SELECT FROM {source.Table(users)} other_user WHERE other_user.id<>u.id
                    AND (other_user.passkey_user_handle=u.passkey_user_handle OR other_user.account_subject_hash=u.account_subject_hash))
                AND NOT EXISTS (SELECT FROM {source.Table(credentials)} other WHERE other.id<>p.id
                    AND (other.credentialid=p.credentialid OR other.account_id=p.account_id))
            LIMIT 2
            """, tx.Connection, tx);
        query.Parameters.AddWithValue(account);
        query.Parameters.AddWithValue(source.Table(users));
        query.Parameters.AddWithValue(source.Table(credentials));
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || IdentityText(row, 1) is not { } subject || !IsSha256(subject) ||
            !IsCanonicalIdentityBytes(IdentityText(row, 2), WireLimits.PasskeyUserHandleBytes, WireLimits.PasskeyUserHandleBytes) ||
            !IsCanonicalIdentityBytes(IdentityText(row, 4), 1, WireLimits.PasskeyCredentialIdBytes) ||
            !IsCanonicalIdentityBytes(IdentityText(row, 5), 1, 16384) ||
            IdentityTime(row, 9) is not { } created || AssetInteger(row.GetValue(3)) < 1)
            throw new InvalidOperationException("A single compatible active legacy account and Passkey are required.");
        var handle = IdentityText(row, 0);
        var rowId = AssetInteger(row.GetValue(3));
        var last = IdentityTime(row, 10);
        var counter = AssetInteger(row.GetValue(6));
        var eligible = IdentityBoolean(row, 7);
        var backedUp = IdentityBoolean(row, 8);
        if (counter is < 0 or > uint.MaxValue || backedUp && !eligible || last < created)
            throw new InvalidOperationException("Unknown old Passkey counter, backup or timestamp state.");
        var credential = new LegacyPasskeyCredential(ReadCanonicalBase64Url(row.GetString(2), 43, 43),
            ReadCanonicalBase64Url(row.GetString(4), 2, 512), ReadCanonicalBase64Url(row.GetString(5), 2, 21900),
            (uint)counter, eligible, backedUp, created, last);
        if (await row.ReadAsync(ct)) throw new InvalidOperationException("The old account or Passkey identity is ambiguous.");
        return (credential, DigestMediaDocument(new { account, handle, subject, rowId, credential }));
    }

    private static LegacyTable LegacyPasskeyTable(LegacyTable[] catalog, string name) =>
        catalog.SingleOrDefault(table => table.Name == name) is { Kind: "r" } relation ? relation :
            throw new InvalidOperationException("The selected old identity relation is absent or unsupported.");

    private static async Task WriteLegacyPasskeyAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyPasskeySelection selection, LegacyPasskeyCredential credential, uint counter, CancellationToken ct)
    {
        await using var insert = new NpgsqlCommand("""
            WITH new_subject AS (
                INSERT INTO public.passkey_subject (user_id,account_id,user_handle) VALUES ($1,$2,$3) RETURNING user_id
            )
            INSERT INTO public.passkey_credential (user_id,credential_id,public_key,sign_count,backup_eligible,backed_up,created_at,last_used_at)
            SELECT user_id,$4,$5,$6,$7,$8,$9,$10 FROM new_subject
            """, db, tx);
        BindLegacyPasskeyParameters(insert, selection, credential, counter);
        if (await insert.ExecuteNonQueryAsync(ct) != 1)
            throw new InvalidOperationException("The approved Passkey was not installed.");
        await ExecuteAsync(db, tx, FormattableString.Invariant(
            $"ALTER SEQUENCE public.passkey_subject_account_id_seq RESTART WITH {selection.Account + 1}"), ct);
    }

    private static async Task VerifyLegacyPasskeyDestinationAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyPasskeySelection selection, LegacyPasskeyCredential credential, bool pristine, uint counter, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand(pristine ? """
            SELECT NOT EXISTS (SELECT FROM public.passkey_subject) AND NOT EXISTS (SELECT FROM public.passkey_credential)
                AND (SELECT last_value=1 AND NOT is_called FROM public.passkey_subject_account_id_seq)
            """ : """
            SELECT (SELECT count(*) FROM public.passkey_subject)=1 AND (SELECT count(*) FROM public.passkey_credential)=1
                AND (SELECT last_value=$2::bigint+1 AND NOT is_called FROM public.passkey_subject_account_id_seq)
                AND EXISTS (SELECT FROM public.passkey_subject s JOIN public.passkey_credential c USING (user_id)
                    WHERE s.user_id=$1 AND s.account_id=$2 AND s.user_handle=$3 AND c.credential_id=$4 AND c.public_key=$5
                        AND c.sign_count=$6 AND c.backup_eligible=$7 AND c.backed_up=$8 AND c.created_at=$9
                        AND c.last_used_at IS NOT DISTINCT FROM $10)
            """, db, tx);
        if (!pristine) BindLegacyPasskeyParameters(query, selection, credential, counter);
        if (await query.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The Passkey destination is neither pristine nor the complete approved result.");
    }

    private static void BindLegacyPasskeyParameters(NpgsqlCommand query, LegacyPasskeySelection selection,
        LegacyPasskeyCredential credential, uint counter)
    {
        foreach (var value in new object[] { selection.User, selection.Account, credential.Handle, credential.Id, credential.Key,
                     (long)counter, credential.Eligible, credential.BackedUp, credential.Created })
            query.Parameters.AddWithValue(value);
        query.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.TimestampTz, Value = (object?)credential.LastUsed ?? DBNull.Value });
    }
}
