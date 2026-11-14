using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlogV2.Storage;

internal static partial class Migration
{
    private const int LegacyIdentityRows = 50_000;
    private static readonly string[] AccountProjection =
    [
        "id", "public_handle", "identity_kind", "account_subject_hash", "registration_state", "passkey_enabled",
        "passkey_user_handle", "passkey_signal_version", "recovery_enabled", "status", "ban_state_generation", "mfaenabled"
    ];
    private static readonly string[] AdministratorProjection =
    [
        "id", "handle", "status", "validationversion", "isroot", "permissions", "totpenabled", "?totpsecretencrypted"
    ];
    private static readonly HashSet<string> MappedAdminPermissions = new(StringComparer.Ordinal)
    {
        CurrentSchema.AdminManagePermission, CurrentSchema.AuditReadPermission, CurrentSchema.CommentModeratePermission,
        CurrentSchema.ArticleWritePermission, CurrentSchema.SystemConfigPermission
    };
    private static readonly HashSet<string> KnownUnmappedAdminPermissions = new(StringComparer.Ordinal)
    {
        "article.publish", "anonymous.comment.configure", "anonymous.nullifier.block", "anonymous.credential.revoke",
        "audit.investigate"
    };
    private sealed record IdentityRelation(string Name, bool Present, long Rows);

    private static async Task<int> VerifyLegacyIdentityAsync(string provider, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(4));
        var ct = deadline.Token;
        try
        {
            var source = ParseLegacySource(provider);
            await using var database = source.Connection;
            await database.OpenAsync(ct);
            await using var transaction = await BeginLegacyReadAsync(database, ct);
            var catalog = await ReadLegacyCatalogAsync(source, transaction, ct);
            if (catalog.Any(table => table.Name.Equals("v2_schema", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("The identity verifier requires a v1 source.");
            var now = DateTimeOffset.UtcNow;
            var audit = new LegacyIdentityAudit(source, transaction, catalog,
                DateTimeOffset.FromUnixTimeSeconds(now.ToUnixTimeSeconds()), ct);
            await audit.CheckPrincipalsAsync();
            await audit.CheckRelatedAsync();
            await transaction.RollbackAsync(ct);
            return audit.Report();
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            throw new InvalidOperationException("The identity verification exceeded its run budget.");
        }
        catch (DbException error)
        {
            throw new InvalidOperationException($"The legacy identity catalog could not be read ({error.GetType().Name}).");
        }
        catch (Exception error) when (error is InvalidCastException or OverflowException)
        {
            throw new InvalidOperationException("The source catalog contains an unsupported identity field representation.");
        }
    }

    private sealed partial class LegacyIdentityAudit
    {
        private readonly LegacySource source;
        private readonly DbTransaction transaction;
        private readonly LegacyTable[] catalog;
        private readonly DateTimeOffset observedAt;
        private readonly CancellationToken token;
        private readonly Dictionary<string, long> issues = new(StringComparer.Ordinal);
        private readonly List<IdentityRelation> relations = [];
        private readonly Dictionary<long, LegacyAccountFlags> accounts = [];
        private readonly HashSet<long> administrators = [];
        private readonly List<(string Relation, string Digest)> relationDigests = [];

        internal LegacyIdentityAudit(LegacySource source, DbTransaction transaction, LegacyTable[] catalog,
            DateTimeOffset observedAt, CancellationToken token)
        {
            this.source = source;
            this.transaction = transaction;
            this.catalog = catalog;
            this.observedAt = observedAt;
            this.token = token;
        }

        internal async Task CheckPrincipalsAsync()
        {
            await CheckAccountsAsync();
            await CheckAdministratorsAsync();
            await CheckUnrecognizedIdentityAsync();
        }

        internal int Report()
        {
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            AppendLegacyValue(digest, LegacyReference);
            AppendLegacyValue(digest, source.Provider);
            foreach (var (relation, fingerprint) in relationDigests)
            {
                AppendLegacyValue(digest, relation);
                AppendLegacyValue(digest, fingerprint);
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                sourceReference = LegacyReference,
                provider = source.Provider,
                sessionStateAtUtc = observedAt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
                accountRows = accounts.Count,
                administratorRows = administrators.Count,
                namespaceIdOverlaps = accounts.Keys.Count(administrators.Contains),
                sourceIdentitySha256 = Convert.ToHexStringLower(digest.GetHashAndReset()),
                relations,
                issues = issues.OrderBy(entry => entry.Key).Select(entry => new { kind = entry.Key, count = entry.Value }),
                readyToApply = false,
                remaining = new[] { "independent owner mapping", "credential custody and relying-party proof",
                    "session revocation and reenrollment", "verified role and lifecycle migration" }
            }, Json));
            return issues.Count == 0 ? 0 : 2;
        }

        private void AddIssue(string issue, long count = 1)
        {
            if (count != 0) issues[issue] = issues.GetValueOrDefault(issue) + count;
        }

        private LegacyTable? FindIdentityTable(string name, bool required)
        {
            var matches = catalog.Where(table => table.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matches.Length == 0 && !required)
            {
                relations.Add(new IdentityRelation(name, false, 0));
                relationDigests.Add((name, "missing"));
                AddIssue("identity-relation-missing");
                return null;
            }
            if (matches is [var exact] && source.IsSnapshotTable(exact.Kind)) return exact;
            throw new InvalidOperationException($"Required v1 identity authority differs: {name}.");
        }

        private async Task CheckUnrecognizedIdentityAsync()
        {
            var legacy = FindIdentityTable("sys_user", required: true)!;
            foreach (var column in new[] { "username", "password", "passwordhash", "passwordsalt", "email", "role",
                         "refreshtoken", "refresh_token", "mfasecretencrypted", "mfapendingsecretencrypted", "mfarecoverycodeshash" })
            {
                var matches = legacy.Columns.Count(field => field.Name.Equals(column, StringComparison.OrdinalIgnoreCase));
                if (matches == 0) continue;
                if (matches != 1) throw new InvalidOperationException("The legacy account credential field set is ambiguous.");
                var count = await CountAsync($"FROM {source.Table(legacy)} WHERE {source.Field(legacy, column)} IS NOT NULL",
                    transaction, token);
                AddIssue("legacy-password-era-account-fields", count);
                relationDigests.Add((column, count.ToString(CultureInfo.InvariantCulture)));
            }
        }

        private async Task<long> ReadProjectedAsync(string name, string[] columns, string sort,
            (string Column, int Bytes)[] textBounds, Action<DbDataReader> observe, bool required = false)
        {
            var table = FindIdentityTable(name, required);
            if (table is null) return 0;
            if (!columns.Append(sort).All(field => HasField(table, field.TrimStart('?'))))
                throw new InvalidOperationException($"Required v1 identity authority differs: {name}.");
            if (textBounds.Length != 0) await RequireBoundedAssetTextAsync(source, transaction, table, textBounds, token);
            string Project(string value)
            {
                if (!value.StartsWith('?')) return source.Field(table, value);
                return $"CASE WHEN {source.Field(table, value[1..])} IS NULL THEN 0 ELSE 1 END";
            }
            await using var command = CreateLegacyCommand(transaction, $"""
                SELECT {string.Join(", ", columns.Select(Project))} FROM {source.Table(table)}
                ORDER BY {source.Field(table, sort)} LIMIT {LegacyIdentityRows + 1}
                """);
            await using var rows = await command.ExecuteReaderAsync(token);
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach (var field in columns) AppendLegacyValue(digest, field);
            long count = 0;
            while (await rows.ReadAsync(token))
            {
                if (++count > LegacyIdentityRows)
                    throw new InvalidOperationException($"The legacy identity relation exceeds its verification bound: {name}.");
                observe(rows);
                for (var ordinal = 0; ordinal < columns.Length; ordinal++)
                    AppendLegacyValue(digest, rows.IsDBNull(ordinal) ? null : rows.GetValue(ordinal));
            }
            relations.Add(new IdentityRelation(name, true, count));
            relationDigests.Add((name, Convert.ToHexStringLower(digest.GetHashAndReset())));
            return count;
        }
    }

    private static string? IdentityText(DbDataReader row, int ordinal) => row.IsDBNull(ordinal) ? null : row.GetString(ordinal);

    private static bool IdentityBoolean(DbDataReader row, int ordinal) => row.GetValue(ordinal) switch
    {
        bool value => value,
        int or long or sbyte or byte or short or ushort or uint or ulong => Convert.ToInt64(row.GetValue(ordinal),
            CultureInfo.InvariantCulture) switch
        {
            0 => false,
            1 => true,
            _ => throw new InvalidOperationException("Unsupported v1 identity boolean.")
        },
        _ => throw new InvalidOperationException("Unsupported v1 identity boolean.")
    };
}
