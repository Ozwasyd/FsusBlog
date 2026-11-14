using System.Data.Common;

internal static partial class Migration
{
    private sealed partial class LegacyIdentityAudit
    {
        internal async Task CheckRelatedAsync()
        {
            var accountPasskeys = await CheckPasskeysAsync(administrator: false);
            var adminPasskeys = await CheckPasskeysAsync(administrator: true);
            AddIssue("passkey-relying-party-proof-required", accountPasskeys.Values.Sum() + adminPasskeys.Values.Sum());
            AddIssue("administrator-multiple-passkeys", adminPasskeys.Values.Count(count => count > 1));
            AddIssue("account-passkey-missing", accounts.Count(item => item.Value.Passkey && !accountPasskeys.ContainsKey(item.Key)));

            await CheckRecoveryAsync();
            await CheckSessionsAsync();
            await ReadProjectedAsync("admin_audit_log", ["id", "adminprincipalid", "occurredatutc"], "id", [], row =>
            {
                AddIssue("administrator-audit-history-retention-required");
                if (AssetInteger(row.GetValue(0)) < 1 || IdentityTime(row, 2) is null)
                    AddIssue("administrator-audit-metadata-unrecognized");
                if (!row.IsDBNull(1) && !administrators.Contains(AssetInteger(row.GetValue(1))))
                    AddIssue("administrator-audit-owner-unresolved");
            });
        }

        private async Task<Dictionary<long, long>> CheckPasskeysAsync(bool administrator)
        {
            var ownerColumn = administrator ? "adminprincipalid" : "account_id";
            var relation = administrator ? "admin_passkey_credential" : "passkey_credential";
            string[] columns = ["id", ownerColumn, "credentialid", "publickey", "signcount", "backupeligible", "backupstate"];
            (string Column, int Bytes)[] text = [("credentialid", 512), ("publickey", 21900)];
            if (administrator)
            {
                columns = [.. columns, "userhandle"];
                text = [.. text, ("userhandle", 128)];
            }
            var owners = new Dictionary<long, long>();
            var credentialRows = new HashSet<long>();
            var credentialIds = new HashSet<string>(StringComparer.Ordinal);
            await ReadProjectedAsync(relation, columns, "id", text, row =>
            {
                long rowId = AssetInteger(row.GetValue(0));
                long owner = AssetInteger(row.GetValue(1));
                var credential = IdentityText(row, 2);
                var publicKey = IdentityText(row, 3);
                long counter = AssetInteger(row.GetValue(4));
                var eligible = IdentityBoolean(row, 5);
                var backedUp = IdentityBoolean(row, 6);
                if (rowId < 1 || !credentialRows.Add(rowId) || credential is null || !credentialIds.Add(credential) ||
                    !IsCanonicalIdentityBytes(credential, 1, 1023) || !IsCanonicalIdentityBytes(publicKey, 1, 16384) ||
                    counter is < 0 or > uint.MaxValue || backedUp && !eligible ||
                    administrator && !IsCanonicalIdentityBytes(IdentityText(row, 7), 32, 32))
                    AddIssue("passkey-record-unrecognized");
                if (administrator ? !administrators.Contains(owner) : !accounts.ContainsKey(owner))
                    AddIssue(administrator ? "administrator-passkey-owner-unresolved" : "account-passkey-owner-unresolved");
                else if (!administrator && !accounts[owner].Passkey)
                    AddIssue("account-passkey-enabled-state-conflict");
                owners[owner] = owners.GetValueOrDefault(owner) + 1;
            });
            return owners;
        }

        private async Task CheckRecoveryAsync()
        {
            var recoveryRows = new HashSet<long>();
            var currentRecovery = new HashSet<long>();
            await ReadProjectedAsync("account_recovery_key", ["id", "account_id", "key_version", "used_at", "revoked_at",
                "?key_hash", "?lookup_id_hash"], "id", [], row =>
            {
                AddIssue("recovery-key-custody-required");
                long identity = AssetInteger(row.GetValue(0));
                long owner = AssetInteger(row.GetValue(1));
                var used = IdentityTime(row, 3);
                var revoked = IdentityTime(row, 4);
                if (identity < 1 || !recoveryRows.Add(identity) || AssetInteger(row.GetValue(2)) < 1 || !IdentityBoolean(row, 5))
                    AddIssue("recovery-key-metadata-unrecognized");
                if (!accounts.ContainsKey(owner)) AddIssue("recovery-key-owner-unresolved");
                if (used is not null) AddIssue("used-recovery-key-retention-required");
                if (revoked is not null) AddIssue("revoked-recovery-key-retention-required");
                if (used is null && revoked is null && !currentRecovery.Add(owner)) AddIssue("multiple-current-recovery-keys");
            });
            AddIssue("account-recovery-state-conflict", accounts.Count(item => item.Value.Recovery != currentRecovery.Contains(item.Key)));

            var profiles = new HashSet<long>();
            var profileOwners = new HashSet<long>();
            var activeSeeds = new HashSet<long>();
            await ReadProjectedAsync("user_mfa_profile", ["id", "user_id", "hash_version", "?mfa_secret_encrypted",
                "?mfa_pending_secret_encrypted", "?mfa_recovery_codes_hash"], "id", [], row =>
            {
                AddIssue("account-mfa-profile-custody-required");
                long identity = AssetInteger(row.GetValue(0));
                long owner = AssetInteger(row.GetValue(1));
                if (identity < 1 || !profiles.Add(identity) || !profileOwners.Add(owner) || AssetInteger(row.GetValue(2)) < 1)
                    AddIssue("account-mfa-profile-unrecognized");
                if (!accounts.ContainsKey(owner)) AddIssue("account-mfa-profile-owner-unresolved");
                if (IdentityBoolean(row, 3)) activeSeeds.Add(owner);
                if (IdentityBoolean(row, 4)) AddIssue("account-mfa-pending-setup-revocation-required");
            });
            AddIssue("account-mfa-state-conflict", accounts.Count(item => item.Value.Mfa != activeSeeds.Contains(item.Key)));
        }

        private async Task CheckSessionsAsync()
        {
            await ReadProjectedAsync("sys_user_session", ["userid", "rememberme", "duration_policy", "session_mode",
                "refresh_generation", "refresh_compromised_at_utc", "revokedat", "idleexpiresat", "absoluteexpiresat"],
                "sessionid", [("duration_policy", 24)], row =>
                {
                    if (!accounts.ContainsKey(AssetInteger(row.GetValue(0)))) AddIssue("account-session-owner-unresolved");
                    var remember = IdentityBoolean(row, 1);
                    var duration = IdentityText(row, 2);
                    var mode = AssetInteger(row.GetValue(3));
                    bool persistent = duration == "persistent_30d" || remember;
                    if (duration is not ("persistent_30d" or "browser_session") || remember != (duration == "persistent_30d") ||
                        mode is < 0 or > 2 || AssetInteger(row.GetValue(4)) < 0)
                        AddIssue("account-session-metadata-unrecognized");
                    var compromised = IdentityTime(row, 5);
                    var revoked = IdentityTime(row, 6);
                    if (compromised is not null) AddIssue("compromised-session-retention-required");
                    var unexpired = IsLegacySessionUnexpired(row, 7, 8);
                    if (compromised is null && revoked is null && mode != 2 && unexpired)
                        AddIssue(persistent ? "persistent-session-revocation-required" : "browser-session-revocation-required");
                    else AddIssue("account-session-history-retention-required");
                });
            await ReadProjectedAsync("admin_session", ["adminprincipalid", "validationversion", "revokedatutc",
                "idleexpiresatutc", "absoluteexpiresatutc"], "sessionid", [], row =>
                {
                    if (!administrators.Contains(AssetInteger(row.GetValue(0)))) AddIssue("administrator-session-owner-unresolved");
                    if (AssetInteger(row.GetValue(1)) < 1) AddIssue("administrator-session-metadata-unrecognized");
                    var unexpired = IsLegacySessionUnexpired(row, 3, 4);
                    AddIssue(IdentityTime(row, 2) is null && unexpired ? "administrator-session-revocation-required" :
                        "administrator-session-history-retention-required");
                });
            await ReadProjectedAsync("user_refresh_token_tombstone", ["id", "generation", "used_at_utc", "expires_at_utc"], "id", [],
                row =>
                {
                    AddIssue("refresh-tombstone-retention-required");
                    if (AssetInteger(row.GetValue(0)) < 1 || AssetInteger(row.GetValue(1)) < 0 ||
                        IdentityTime(row, 2) is not { } used || IdentityTime(row, 3) is not { } expires || used > expires)
                        AddIssue("refresh-tombstone-metadata-unrecognized");
                });
            await ReadProjectedAsync("account_enrollment_session", ["account_id", "state", "created_at", "expires_at",
                "?protected_refresh_token"], "token_hash", [("state", 24)], row =>
                {
                    AddIssue("enrollment-session-revocation-required");
                    if (!accounts.ContainsKey(AssetInteger(row.GetValue(0)))) AddIssue("enrollment-session-owner-unresolved");
                    if (IdentityText(row, 1) is not ("pending" or "completing" or "completed" or "cancelled" or "expired") ||
                        IdentityTime(row, 2) is not { } created || IdentityTime(row, 3) is not { } expires || created > expires)
                        AddIssue("enrollment-session-metadata-unrecognized");
                });
        }

        private bool IsLegacySessionUnexpired(DbDataReader row, int idleColumn, int absoluteColumn)
        {
            var idle = IdentityTime(row, idleColumn);
            var absolute = IdentityTime(row, absoluteColumn);
            if (idle is null || absolute is null || idle > absolute)
                AddIssue("session-expiry-unrecognized");
            return idle > observedAt && absolute > observedAt;
        }
    }
}
