using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

internal static partial class Migration
{
    private const int RehearsalVersion = 3;
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
        var map = await ReadLegacyOwnerMapAsync(ownerMapPath, token);
        await using var shadow = await MaterializeLegacyShadowAsync(source, transaction, tables, principals, audit, map, token);
        return shadow.Report;
    }

    private static async Task<(OwnerMap Map, string Digest)> ReadLegacyOwnerMapAsync(string ownerMapPath, CancellationToken token)
    {
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
        return (map, Convert.ToHexStringLower(SHA256.HashData(mapBytes)));
    }

    private static async Task<LegacyShadow> MaterializeLegacyShadowAsync(LegacySource source, DbTransaction transaction,
        Dictionary<string, LegacyTable> tables, LegacyTable principals, LegacyAudit audit,
        (OwnerMap Map, string Digest) ownerMap, CancellationToken token, LegacyCreateCommand[]? commands = null,
        LegacyOutboxEntry[]? outbox = null, LegacyReadingHistoryRow[]? readingHistory = null)
    {
        if (audit.Projections.Any(projection => projection.Rows > RehearsalLimit))
            throw new InvalidOperationException($"The shadow rehearsal supports up to {RehearsalLimit} rows per table.");
        var (map, ownerDigest) = ownerMap;
        var articleProjection = audit.Projections.Single(projection => projection.Table == Article);
        if (!string.Equals(map.SourceArticleSha256, articleProjection.Sha256, StringComparison.OrdinalIgnoreCase) ||
            map.Owners is null || map.Owners.LongLength != articleProjection.Rows)
            throw new InvalidOperationException("The owner map must match this source article fingerprint and cover every article.");
        var owners = ValidateOwnerMap(map.Owners);
        var adminIdentitySha256 = await FingerprintLegacyPrincipalsAsync(source, transaction, principals, owners.Values, token);
        if (!string.Equals(map.SourceAdminIdentitySha256, adminIdentitySha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The owner map was prepared for a different legacy administrator identity set.");

        var shadow = new SqliteConnection("Data Source=:memory:;Foreign Keys=True;Pooling=False");
        try
        {
            await shadow.OpenAsync(token);
            return await PopulateLegacyShadowAsync(source, transaction, tables, audit, shadow, owners, ownerDigest,
                adminIdentitySha256, token, commands, outbox ?? [], readingHistory);
        }
        catch
        {
            await shadow.DisposeAsync();
            throw;
        }
    }

    private static async Task<LegacyShadow> PopulateLegacyShadowAsync(LegacySource source, DbTransaction transaction,
        Dictionary<string, LegacyTable> tables, LegacyAudit audit, SqliteConnection shadow,
        Dictionary<int, ArticleOwner> owners, string ownerDigest, string adminIdentitySha256, CancellationToken token,
        LegacyCreateCommand[]? commands, LegacyOutboxEntry[] outbox, LegacyReadingHistoryRow[]? readingHistory)
    {
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
        var revisionTagRows = await BuildShadowReleaseAsync(shadowTransaction, token);
        await BuildShadowPublicationsAsync(shadowTransaction, token);
        if (commands is not null) await WriteLegacyCreateCommandShadowAsync(shadowTransaction, commands, token);
        foreach (var entry in outbox) await WriteLegacyOutboxShadowAsync(shadowTransaction, entry, token);
        if (readingHistory is not null) await WriteLegacyReadingHistoryShadowAsync(shadowTransaction, readingHistory, token);
        await shadowTransaction.CommitAsync(token);
        await using var readBack = shadow.BeginTransaction(deferred: true);
        var checkedRows = await VerifyShadowRowsAsync(readBack, audit, revisionTagRows, token);
        if (commands is not null) checkedRows = [.. checkedRows, await VerifyLegacyCreateCommandShadowAsync(readBack, commands, token)];
        foreach (var entry in outbox) checkedRows = [.. checkedRows, await VerifyLegacyOutboxShadowAsync(readBack, entry, token)];
        if (readingHistory is not null)
            checkedRows = [.. checkedRows, await VerifyLegacyReadingHistoryShadowAsync(readBack, readingHistory, token)];
        await readBack.RollbackAsync(token);
        return new LegacyShadow(shadow, new ShadowReport(RehearsalVersion, ownerDigest, adminIdentitySha256, checkedRows), owners.Values.ToArray());
    }

    private sealed record LegacyShadow(SqliteConnection Database, ShadowReport Report, ArticleOwner[] Owners) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => Database.DisposeAsync();
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
            summary TEXT,
            cover_image_url TEXT,
            source_status INTEGER NOT NULL,
            source_category_id INTEGER NOT NULL,
            deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
            scheduled_publish_at TEXT,
            pending_publication_at TEXT,
            published_at TEXT,
            last_published_at TEXT,
            public_updated_at TEXT,
            archived_at TEXT,
            deleted_at TEXT,
            current_publication_id INTEGER,
            current_public_revision_candidate INTEGER,
            last_publication_number INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            source_metadata_updated_at TEXT NOT NULL,
            source_body_updated_at TEXT NOT NULL,
            FOREIGN KEY (id, current_revision) REFERENCES shadow_revision (article_id, revision) DEFERRABLE INITIALLY DEFERRED
        ) STRICT;
        CREATE TABLE shadow_revision (
            source_revision_id INTEGER PRIMARY KEY,
            article_id INTEGER NOT NULL REFERENCES shadow_article (id),
            revision INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            summary TEXT,
            cover_image_url TEXT,
            source_category_id INTEGER NOT NULL,
            source_tag_ids TEXT NOT NULL,
            source_content_block_id INTEGER NOT NULL,
            source_content_sha256 TEXT NOT NULL,
            source_inline_markdown TEXT NOT NULL,
            source_diff_summary TEXT,
            source_admin_id INTEGER NOT NULL,
            source_rollback_revision_id INTEGER,
            source_rollback_reason TEXT,
            happened_at TEXT NOT NULL,
            UNIQUE (article_id, revision), UNIQUE (source_revision_id, article_id, revision)
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
            source_created_at TEXT NOT NULL,
            UNIQUE (article_id, publication_number),
            FOREIGN KEY (source_rights_snapshot_id, source_revision_id, article_id, revision)
                REFERENCES shadow_article_rights_snapshot (id, article_revision_id, article_id, revision_no)
                DEFERRABLE INITIALLY DEFERRED,
            FOREIGN KEY (source_responsibility_snapshot_id, source_revision_id, article_id, revision)
                REFERENCES shadow_article_responsibility_snapshot (id, article_revision_id, article_id, revision_no)
                DEFERRABLE INITIALLY DEFERRED
        ) STRICT;
        """;
}
