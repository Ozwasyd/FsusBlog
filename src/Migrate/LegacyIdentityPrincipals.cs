using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;

internal static partial class Migration
{
    private sealed record LegacyAccountFlags(bool Passkey, bool Recovery, bool Mfa);

    private sealed partial class LegacyIdentityAudit
    {
        private Task<long> CheckAccountsAsync()
        {
            var subjects = new HashSet<string>(StringComparer.Ordinal);
            var handles = new HashSet<string>(StringComparer.Ordinal);
            var webAuthnHandles = new HashSet<string>(StringComparer.Ordinal);
            return ReadProjectedAsync("sys_user", AccountProjection, "id",
                [("public_handle", 256), ("identity_kind", 32), ("account_subject_hash", 64),
                    ("registration_state", 24), ("passkey_user_handle", 128)],
                row =>
                {
                    long id = AssetInteger(row.GetValue(0));
                    var handle = IdentityText(row, 1);
                    var kind = IdentityText(row, 2);
                    var subject = IdentityText(row, 3);
                    var registration = IdentityText(row, 4);
                    var passkey = IdentityBoolean(row, 5);
                    var webAuthnHandle = IdentityText(row, 6);
                    long signal = AssetInteger(row.GetValue(7));
                    var recovery = IdentityBoolean(row, 8);
                    long status = AssetInteger(row.GetValue(9));
                    long generation = AssetInteger(row.GetValue(10));
                    var mfa = IdentityBoolean(row, 11);

                    if (id is < 1 or > int.MaxValue || !accounts.TryAdd(id, new LegacyAccountFlags(passkey, recovery, mfa)))
                        throw new InvalidOperationException("The v1 account identity set is ambiguous.");
                    if (kind != "anonymous_account" || registration is not ("provisional" or "active" or "suspended" or "closed") ||
                        status is < 0 or > 2 || generation < 1 || signal < 0)
                        AddIssue("account-lifecycle-unrecognized");
                    else if (registration != "active" || status != 0 || generation != 1 || signal != 0)
                        AddIssue("account-lifecycle-projection-required");
                    if (handle is not null && (handle.Length is < 1 or > 64 || !handles.Add(handle)))
                        AddIssue("account-public-handle-invalid");
                    if (subject is not { Length: 64 } || !subject.All(char.IsAsciiHexDigitLower) || !subjects.Add(subject))
                        AddIssue("account-subject-invalid");
                    else AddIssue("account-subject-projection-required");
                    if (webAuthnHandle is not null && (!IsCanonicalIdentityBytes(webAuthnHandle, 32, 32) || !webAuthnHandles.Add(webAuthnHandle)) ||
                        passkey && webAuthnHandle is null)
                        AddIssue("account-passkey-user-handle-invalid");
                    if (recovery) AddIssue("account-recovery-custody-required");
                    if (mfa) AddIssue("account-mfa-custody-required");
                }, required: true);
        }

        private Task<long> CheckAdministratorsAsync()
        {
            var handles = new HashSet<string>(StringComparer.Ordinal);
            return ReadProjectedAsync("admin_principal", AdministratorProjection, "id", [("handle", 256), ("status", 32), ("permissions", 4096)],
                row =>
                {
                    long id = AssetInteger(row.GetValue(0));
                    if (id < 1 || !administrators.Add(id))
                        throw new InvalidOperationException("The v1 administrator identity set is ambiguous.");
                    var handle = IdentityText(row, 1);
                    if (handle is not { Length: >= 1 and <= 64 } || handle[0] is < 'a' or > 'z' ||
                        !handle.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '.' or '-') ||
                        !handles.Add(handle))
                        AddIssue("administrator-handle-invalid");
                    var state = IdentityText(row, 2);
                    long generation = AssetInteger(row.GetValue(3));
                    if (state is not ("active" or "disabled") || generation < 1)
                        AddIssue("administrator-lifecycle-unrecognized");
                    else if (state == "disabled" || generation != 1)
                        AddIssue("administrator-lifecycle-projection-required");
                    if (IdentityBoolean(row, 4)) AddIssue("administrator-root-unsupported");
                    var permissions = IdentityText(row, 5);
                    if (permissions is null) AddIssue("administrator-permission-unknown");
                    else
                    {
                        // v1 stores one exact grant per line. Audit recognized grants without mapping them to v2.
                        var names = permissions.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                        if (names.Any(KnownUnmappedAdminPermissions.Contains)) AddIssue("administrator-permission-unmapped");
                        if (names.Any(name => !MappedAdminPermissions.Contains(name) && !KnownUnmappedAdminPermissions.Contains(name)) ||
                            names.Distinct(StringComparer.Ordinal).Count() != names.Length)
                            AddIssue("administrator-permission-unknown");
                        if (names.Any(MappedAdminPermissions.Contains)) AddIssue("administrator-grant-review-required");
                    }
                    if (IdentityBoolean(row, 6) | IdentityBoolean(row, 7))
                        AddIssue("administrator-totp-custody-required");
                }, required: true);
        }
    }

    private static bool IsCanonicalIdentityBytes(string? value, int minimum, int maximum)
    {
        if (value is null || value.Length == 0 || value.Length > ((maximum + 2) / 3) * 4 ||
            !value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_'))
            return false;
        var bytes = new byte[Math.Min(maximum, ((value.Length + 3) / 4) * 3)];
        try
        {
            var padded = value.Replace('-', '+').Replace('_', '/').PadRight((value.Length + 3) / 4 * 4, '=');
            return Convert.TryFromBase64String(padded, bytes, out var length) && length >= minimum &&
                Convert.ToBase64String(bytes, 0, length).TrimEnd('=').Replace('+', '-').Replace('/', '_') == value;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static DateTimeOffset? IdentityTime(DbDataReader row, int ordinal)
    {
        if (row.IsDBNull(ordinal)) return null;
        return row.GetValue(ordinal) switch
        {
            DateTime date when date.Kind != DateTimeKind.Local => new DateTimeOffset(date, TimeSpan.Zero),
            DateTimeOffset date => date.ToUniversalTime(),
            string text when text.Length <= 64 && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date) => date,
            _ => throw new InvalidOperationException("Unsupported v1 identity timestamp.")
        };
    }
}
