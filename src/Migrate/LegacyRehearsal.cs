using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

internal static partial class Migration
{
    private const int RehearsalVersion = 1;
    private const int RehearsalLimit = 5_000;
    private const int RehearsalMapBytes = 1_000_000;
    private const long RehearsalTextBytes = 128_000_000;

    private static readonly JsonSerializerOptions OwnerMapJson = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        AllowDuplicateProperties = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 8,
        NumberHandling = JsonNumberHandling.Strict
    };

    private sealed record OwnerMap(string SourceArticleSha256, string SourceAdminIdentitySha256, ArticleOwner[] Owners);
    private sealed record ArticleOwner(int ArticleId, long LegacyAdminId, Guid V2UserId);
    private sealed record ShadowCount(string Table, long Rows, string Sha256);
    private sealed record ShadowReport(int Version, string OwnerMapSha256, string SourceAdminIdentitySha256, ShadowCount[] Counts);

    private static async Task<ShadowReport> RehearseLegacyAsync(LegacySource source, DbTransaction transaction,
        Dictionary<string, LegacyTable> tables, LegacyTable principals, LegacyAudit audit, string ownerMapPath, CancellationToken token)
    {
        if (audit.Projections.Any(projection => projection.Rows > RehearsalLimit))
            throw new InvalidOperationException($"The shadow rehearsal supports up to {RehearsalLimit} rows per table.");

        await using var file = new FileStream(ownerMapPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (file.Length is < 1 or > RehearsalMapBytes)
            throw new InvalidOperationException("An owner map within the rehearsal size limit is required.");
        var mapBytes = new byte[(int)file.Length];
        await file.ReadExactlyAsync(mapBytes, token);
        if (file.ReadByte() != -1) throw new InvalidOperationException("The owner map changed while being read.");
        OwnerMap map;
        try
        {
            map = JsonSerializer.Deserialize<OwnerMap>(mapBytes, OwnerMapJson) ??
                throw new InvalidOperationException("Expected a valid owner map.");
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("Expected a valid owner map.");
        }

        var articleProjection = audit.Projections.Single(projection => projection.Table == Article);
        if (!string.Equals(map.SourceArticleSha256, articleProjection.Sha256, StringComparison.OrdinalIgnoreCase) ||
            map.Owners is null || map.Owners.LongLength != articleProjection.Rows)
            throw new InvalidOperationException("The owner map must match this source article fingerprint and cover every article.");
        var owners = ValidateOwnerMap(map.Owners);
        var adminIdentitySha256 = await FingerprintLegacyPrincipalsAsync(source, transaction, principals, owners.Values, token);
        if (!string.Equals(map.SourceAdminIdentitySha256, adminIdentitySha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The owner map was prepared for a different legacy administrator identity set.");

        await using var shadow = new SqliteConnection("Data Source=:memory:;Foreign Keys=True;Pooling=False");
        await shadow.OpenAsync(token);
        await using var shadowTransaction = shadow.BeginTransaction();
        await using (var ddl = CreateLegacyCommand(shadowTransaction, ShadowDdl))
            await ddl.ExecuteNonQueryAsync(token);

        var totalText = 0L;
        foreach (var projection in audit.Projections)
        {
            var count = await CopyRehearsalProjectionAsync(source, transaction, tables[projection.Table],
                projection, shadowTransaction, token);
            totalText = checked(totalText + count);
            if (totalText > RehearsalTextBytes)
                throw new InvalidOperationException("The shadow rehearsal exceeds its aggregate text limit.");
        }

        await BuildShadowRowsAsync(shadowTransaction, owners, token);
        await shadowTransaction.CommitAsync(token);
        await using var readBack = shadow.BeginTransaction(deferred: true);
        var checkedRows = await VerifyShadowRowsAsync(readBack, audit, token);
        await readBack.RollbackAsync(token);
        return new ShadowReport(RehearsalVersion, Convert.ToHexStringLower(SHA256.HashData(mapBytes)), adminIdentitySha256, checkedRows);
    }

    private static Dictionary<int, ArticleOwner> ValidateOwnerMap(ArticleOwner[] mapping)
    {
        var owners = new Dictionary<int, ArticleOwner>();
        var byPrincipal = new Dictionary<long, Guid>();
        var byUser = new Dictionary<Guid, long>();
        foreach (var owner in mapping)
        {
            if (owner is null || owner.ArticleId <= 0 || owner.LegacyAdminId <= 0 || owner.V2UserId == Guid.Empty ||
                !owners.TryAdd(owner.ArticleId, owner))
                throw new InvalidOperationException("An owner map contains invalid or duplicate source article identities.");
            if (byPrincipal.TryGetValue(owner.LegacyAdminId, out var userId) && userId != owner.V2UserId ||
                byUser.TryGetValue(owner.V2UserId, out var principalId) && principalId != owner.LegacyAdminId)
                throw new InvalidOperationException("Legacy administrators and target user UUIDs need a one-to-one identity mapping.");
            byPrincipal[owner.LegacyAdminId] = owner.V2UserId;
            byUser[owner.V2UserId] = owner.LegacyAdminId;
        }

        return owners;
    }

    private static async Task<string> FingerprintLegacyPrincipalsAsync(LegacySource source, DbTransaction transaction,
        LegacyTable table, IEnumerable<ArticleOwner>? owners, CancellationToken token)
    {
        var required = owners?.Select(owner => owner.LegacyAdminId).ToHashSet();
        var id = source.Field(table, "id");
        var handle = source.Field(table, "handle");
        var tableName = source.Table(table);
        if (await CountAsync($"FROM {tableName} WHERE {source.Utf8Length(handle)} > 512", transaction, token) != 0)
            throw new InvalidOperationException("The legacy principal handle exceeds its audited size.");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(hash, "admin_principal");
        AppendLegacyValue(hash, "id");
        AppendLegacyValue(hash, "handle");
        await using var command = CreateLegacyCommand(transaction,
            $"SELECT {id}, {handle} FROM {tableName} ORDER BY {id} LIMIT {RehearsalLimit + 1}");
        await using var reader = await command.ExecuteReaderAsync(token);
        var seen = new HashSet<long>();
        while (await reader.ReadAsync(token))
        {
            var current = reader.GetValue(0);
            var identity = current is long or int ? Convert.ToInt64(current, CultureInfo.InvariantCulture) : 0;
            if (identity <= 0 || !seen.Add(identity) || seen.Count > RehearsalLimit ||
                reader.GetValue(1) is not string principalHandle || principalHandle.Length is < 1 or > 128)
                throw new InvalidOperationException("An invalid or oversized legacy administrator identity set was read.");
            AppendLegacyValue(hash, identity);
            AppendLegacyValue(hash, principalHandle);
            required?.Remove(identity);
        }
        if (required?.Count > 0)
            throw new InvalidOperationException("An article owner does not resolve to one legacy administrator.");
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private const string ShadowDdl = """
        CREATE TABLE owner_map (
            article_id INTEGER PRIMARY KEY,
            legacy_admin_id INTEGER NOT NULL,
            v2_user_id TEXT NOT NULL
        ) STRICT;
        CREATE TABLE shadow_article (
            id INTEGER PRIMARY KEY CHECK (id > 0 AND id <= 2147483647),
            legacy_admin_id INTEGER NOT NULL,
            owner_id TEXT NOT NULL,
            current_source_revision_id INTEGER NOT NULL,
            current_revision INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            source_status INTEGER NOT NULL,
            deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
            current_publication_id INTEGER,
            current_public_revision_candidate INTEGER,
            last_publication_number INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (id, current_revision) REFERENCES shadow_revision (article_id, revision) DEFERRABLE INITIALLY DEFERRED
        ) STRICT;
        CREATE TABLE shadow_revision (
            source_revision_id INTEGER PRIMARY KEY,
            article_id INTEGER NOT NULL REFERENCES shadow_article (id),
            revision INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            source_content_block_id INTEGER NOT NULL,
            source_content_sha256 TEXT NOT NULL,
            source_admin_id INTEGER NOT NULL,
            source_rollback_revision_id INTEGER,
            happened_at TEXT NOT NULL,
            UNIQUE (article_id, revision)
        ) STRICT;
        CREATE TABLE shadow_publication (
            source_publication_id INTEGER PRIMARY KEY,
            article_id INTEGER NOT NULL REFERENCES shadow_article (id),
            source_revision_id INTEGER NOT NULL REFERENCES shadow_revision (source_revision_id),
            revision INTEGER NOT NULL,
            publication_number INTEGER NOT NULL,
            source_rights_snapshot_id INTEGER NOT NULL,
            source_responsibility_snapshot_id INTEGER,
            source_transition TEXT NOT NULL,
            published_at TEXT NOT NULL,
            UNIQUE (article_id, publication_number)
        ) STRICT;
        """;
}
