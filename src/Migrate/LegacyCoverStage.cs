using System.Data;
using System.Text;
using System.Text.Json;
using Npgsql;
using FsusBlogV2.Storage;

internal static partial class Migration
{
    private static Task<int> RunLegacyCoverStageAsync(string package, string packageSha, string owners, string ownersSha,
        string revisionsSha, string publicationsSha, string proofPath, string proofSha, string backup, string backupSha,
        CancellationToken token) => RunLegacyCoverProofAsync(package, packageSha, owners, ownersSha, revisionsSha,
        publicationsSha, token, async (fresh, ct) =>
        {
            var approved = await ReadLegacyCoverProofFileAsync(proofPath, proofSha, ct);
            if (approved != fresh + Environment.NewLine)
                throw new InvalidOperationException("The approved cover proof differs from the current frozen source.");
            return await StoreOrVerifyLegacyCoversAsync(package, packageSha, approved, proofSha, backup, backupSha, false, ct);
        });

    private static Task<int> RunLegacyCoverVerifyAsync(string package, string packageSha, string proofPath,
        string proofSha, string backup, string backupSha, CancellationToken token) => RunBoundedLegacyOperationAsync(token, 8,
        "The isolated cover verification exceeded its run budget.", "The isolated cover candidate rejected the read", async ct =>
        await StoreOrVerifyLegacyCoversAsync(package, packageSha, await ReadLegacyCoverProofFileAsync(proofPath, proofSha, ct),
            proofSha, backup, backupSha, true, ct));

    private static async Task<string> ReadLegacyCoverProofFileAsync(string path, string sha, CancellationToken ct)
    {
        if (!Path.IsPathFullyQualified(path) || !IsSha256(sha))
            throw new ArgumentException("Supply an absolute cover proof file and its independently recorded SHA-256.");
        using var parent = OpenImportBackupDirectory(Path.GetDirectoryName(path)!);
        await using var input = OpenImportBackupFile(parent, Path.GetFileName(path));
        var bytes = await ReadBoundedArtifactAsync(input, 16_000_000, ct,
            static () => new InvalidOperationException("The cover proof exceeds its artifact size bound."),
            static () => new InvalidOperationException("The cover proof differs from its reviewed SHA-256."), sha);
        return StrictUtf8.GetString(bytes);
    }

    private static async Task<int> StoreOrVerifyLegacyCoversAsync(string package, string packageSha, string proof,
        string proofSha, string backupPath, string backupSha, bool readOnly, CancellationToken ct)
    {
        var media = await VerifyLegacyMediaPackageAsync(package, packageSha, ct);
        using var document = JsonDocument.Parse(proof);
        var root = document.RootElement;
        if (root.GetProperty("format").GetString() != "fsusblog-legacy-cover-proof-v1" ||
            root.GetProperty("sourceReference").GetString() != LegacyReference ||
            root.GetProperty("mediaManifestSha256").GetString() != packageSha ||
            root.GetProperty("sourceSiteId").GetGuid() != media.Review.SourceSiteId ||
            root.GetProperty("targetSiteId").GetGuid() != media.Review.TargetSiteId ||
            root.GetProperty("sourceDatabaseSha256").GetString() != media.Review.SourceDatabaseSha256 ||
            root.GetProperty("readyToApply").GetBoolean() || root.GetProperty("readyToStage").GetBoolean())
            throw new InvalidOperationException("The approved cover proof disagrees with the media custody package.");
        var rows = root.GetProperty("candidates").Deserialize<LegacyCoverCandidate[]>(Json);
        if (rows is null || rows.Length is < 1 or > LegacyAssetReferenceLimit ||
            rows.Select(row => (row.SourceKind, row.ArticleId, row.SourceId)).Distinct().Count() != rows.Length)
            throw new InvalidOperationException("The approved cover mapping set is empty or ambiguous.");
        var owners = rows.GroupBy(row => row.ArticleId).Select(group => new ArticleOwner(group.Key,
            group.First().SourceOwnerId, group.First().TargetOwnerId)).ToArray();
        var byOwner = ValidateOwnerMap(owners);
        var assets = media.Files.ToDictionary(asset => asset.AssetId);
        var references = media.References.Select(reference =>
            (reference.AssetId, reference.SourceKind, reference.SourceId, reference.ArticleId)).ToHashSet();
        foreach (var row in rows)
            if (row.SourceKind is not ("article" or "revision") || row.ArticleId <= 0 || row.SourceId <= 0 ||
                row.SourceRevisionId <= 0 || row.Revision <= 0 || row.Role != "cover" || !IsSha256(row.SourceUrlSha256) ||
                row.SourceId != (row.SourceKind == "article" ? row.ArticleId : row.SourceRevisionId) ||
                byOwner[row.ArticleId].LegacyAdminId != row.SourceOwnerId || byOwner[row.ArticleId].V2UserId != row.TargetOwnerId ||
                !assets.TryGetValue(row.AssetId, out var asset) || asset.StorageClass != "public" || asset.Sha256 != row.AssetSha256 ||
                asset.SourceOwnerId != row.SourceOwnerId || asset.TargetOwnerId != row.TargetOwnerId ||
                !references.Contains((row.AssetId, row.SourceKind, row.SourceId, row.ArticleId)))
                throw new InvalidOperationException("The approved cover mapping has an invalid source, asset or owner binding.");
        var baseline = await ReadLegacyImportBackupAsync(backupPath, backupSha, ct);
        var settings = ParseImportTarget();
        await using var db = new NpgsqlConnection(settings.ConnectionString);
        await db.OpenAsync(ct);
        await RequireBackupDatabaseLockAsync(db, ct);
        var (_, site, quarantined) = await ObserveLegacyTargetAsync(db, baseline, owners, ct);
        if (site != media.Review.TargetSiteId || Digest(await SchemaSqlAsync(ct)) != media.Review.TargetSchemaSha256 || readOnly && !quarantined)
            throw new InvalidOperationException("The isolated cover target has a different site, schema or quarantine state.");
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        if (readOnly) await ExecuteAsync(db, tx, "SET TRANSACTION READ ONLY", ct);
        else
        {
            await ExecuteAsync(db, tx, BootstrapLock, ct);
            // Lock every existing public table before the final baseline read. No application writes are admitted.
            var names = baseline.Site.Relations.Where(row => row.Kind == "r")
                .Select(row => "public.\"" + row.Name.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"");
            await ExecuteAsync(db, tx, "LOCK TABLE " + string.Join(',', names) + " IN ACCESS EXCLUSIVE MODE", ct);
        }
        await SetBackupRepresentationAsync(db, tx, ct);
        var cluster = await ReadLegacyPostgresClusterAsync(db, tx, ct);
        var physical = await FingerprintLegacyPostgresDatabaseAsync(db, tx, cluster, ct);
        // Write/replay is tied to the original candidate. Only the verify command permits a restored independent database.
        if ((!readOnly && physical != media.Review.TargetDatabaseSha256) || physical == media.Review.SourceDatabaseSha256)
            throw new InvalidOperationException("Cover staging requires the exact reviewed independent target database.");
        var (publicRows, publicMedia) = await ReadBackupSiteAsync(db, tx, ct, quarantined ? ImportSchema : null);
        if (publicMedia.Count != 0 || publicRows.Count != baseline.Site.Relations.Length ||
            publicRows.Any(row => !baseline.Site.Relations.Any(old => old.Name == row.Name &&
                (quarantined && row.Name == "v2_schema" ? row.Rows == old.Rows && row.Kind == old.Kind : row == old))))
            throw new InvalidOperationException("The cover candidate business baseline changed before staging.");
        var binding = JsonSerializer.Serialize(new
        {
            format = "fsusblog-legacy-cover-candidate-v1", proofSha256 = proofSha, mediaManifestSha256 = packageSha,
            baselineSha256 = backupSha, originalSchemaVersion = baseline.Site.SchemaVersion, media.Review.SourceSiteId, media.Review.TargetSiteId,
            media.Review.SourceDatabaseSha256, media.Review.TargetDatabaseSha256, serving = false
        }, Json);
        if (!quarantined)
        {
            await ExecuteAsync(db, tx, $"""
                CREATE SCHEMA {ImportSchema};
                CREATE TABLE {ImportSchema}.cover_candidate (
                    singleton boolean PRIMARY KEY CHECK(singleton), binding text NOT NULL);
                CREATE TABLE {ImportSchema}.cover_mapping (
                    source_kind text NOT NULL, article_id integer NOT NULL, source_id bigint NOT NULL,
                    source_revision_id bigint NOT NULL, revision bigint NOT NULL, source_url_sha256 text NOT NULL,
                    asset_id uuid NOT NULL, asset_sha256 text NOT NULL, source_owner_id bigint NOT NULL,
                    target_owner_id uuid NOT NULL, role text NOT NULL, current_edit boolean NOT NULL,
                    current_publication boolean NOT NULL, PRIMARY KEY(source_kind,article_id,source_id));
                """, ct);
            await using (var header = new NpgsqlCommand($"INSERT INTO {ImportSchema}.cover_candidate VALUES (true,$1)", db, tx))
            {
                header.Parameters.AddWithValue(binding);
                await header.ExecuteNonQueryAsync(ct);
            }
            foreach (var row in rows)
            {
                await using var insert = new NpgsqlCommand($"INSERT INTO {ImportSchema}.cover_mapping VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", db, tx);
                foreach (var value in new object[] { row.SourceKind, row.ArticleId, row.SourceId, row.SourceRevisionId, row.Revision,
                    row.SourceUrlSha256, row.AssetId, row.AssetSha256, row.SourceOwnerId, row.TargetOwnerId, row.Role, row.CurrentEdit, row.CurrentPublication })
                    insert.Parameters.AddWithValue(value);
                await insert.ExecuteNonQueryAsync(ct);
            }
            await using var marker = new NpgsqlCommand("UPDATE public.v2_schema SET version=-1 WHERE singleton AND version=$1", db, tx);
            marker.Parameters.AddWithValue(CurrentSchema.Version);
            if (await marker.ExecuteNonQueryAsync(ct) != 1) throw new InvalidOperationException("The cover quarantine marker changed.");
        }
        await VerifyLegacyCoverStorageAsync(db, tx, binding, rows, ct);
        if (readOnly) await tx.RollbackAsync(ct); else await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            format = "fsusblog-legacy-cover-candidate-receipt-v1", proofSha256 = proofSha, mediaManifestSha256 = packageSha,
            baselineSha256 = backupSha, siteId = site, rows = rows.Length, mappingSha256 = DigestMediaDocument(rows),
            result = readOnly ? "verified" : quarantined ? "revalidated" : "staged",
            serving = false, readyToApply = false, readyToPublish = false
        }, Json));
        return 0;
    }

    private static async Task VerifyLegacyCoverStorageAsync(NpgsqlConnection db, NpgsqlTransaction tx, string binding,
        LegacyCoverCandidate[] expected, CancellationToken ct)
    {
        await using (var marker = new NpgsqlCommand("SELECT version FROM public.v2_schema WHERE singleton", db, tx))
            if (await marker.ExecuteScalarAsync(ct) is not int version || version != ImportQuarantineVersion)
                throw new InvalidOperationException("The cover-only candidate must retain its disabled schema marker.");
        var definitions = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["cover_candidate"] = "singleton:boolean:true,binding:text:true",
            ["cover_mapping"] = "source_kind:text:true,article_id:integer:true,source_id:bigint:true,source_revision_id:bigint:true,revision:bigint:true,source_url_sha256:text:true,asset_id:uuid:true,asset_sha256:text:true,source_owner_id:bigint:true,target_owner_id:uuid:true,role:text:true,current_edit:boolean:true,current_publication:boolean:true"
        };
        await using (var catalog = new NpgsqlCommand($"""
            SELECT c.relname,c.relkind::text,c.relpersistence::text,c.relrowsecurity,c.relforcerowsecurity,
                EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
                EXISTS(SELECT FROM pg_rewrite r WHERE r.ev_class=c.oid),
                (SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text,',' ORDER BY a.attnum)
                 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
                EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND (a.attgenerated<>'' OR a.attidentity<>'' OR a.atthasdef)),
                (SELECT string_agg(a.attname,',' ORDER BY k.position) FROM pg_constraint p CROSS JOIN LATERAL
                 unnest(p.conkey) WITH ORDINALITY k(number,position) JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.number
                 WHERE p.conrelid=c.oid AND p.contype='p'),
                (SELECT string_agg(pg_get_constraintdef(p.oid),'|' ORDER BY p.contype,p.conname)
                 FROM pg_constraint p WHERE p.conrelid=c.oid AND p.contype<>'n'),
                EXISTS(SELECT FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='{ImportSchema}' AND c.relkind<>'i' ORDER BY c.relname
            """, db, tx))
        await using (var rows = await catalog.ExecuteReaderAsync(ct))
        {
            var count = 0;
            while (await rows.ReadAsync(ct))
            {
                var name = rows.GetString(0);
                if (!definitions.TryGetValue(name, out var shape) || rows.GetString(1) != "r" || rows.GetString(2) != "p" ||
                    rows.GetBoolean(3) || rows.GetBoolean(4) || rows.GetBoolean(5) || rows.GetBoolean(6) ||
                    rows.IsDBNull(7) || rows.GetString(7) != shape || rows.GetBoolean(8) || rows.IsDBNull(9) ||
                    rows.GetString(9) != (name == "cover_candidate" ? "singleton" : "source_kind,article_id,source_id") ||
                    rows.IsDBNull(10) || rows.GetString(10) != (name == "cover_candidate"
                        ? "CHECK (singleton)|PRIMARY KEY (singleton)" : "PRIMARY KEY (source_kind, article_id, source_id)") || rows.GetBoolean(11))
                    throw new InvalidOperationException("The cover-only quarantine catalog differs from its exact storage shape.");
                count++;
            }
            if (count != definitions.Count) throw new InvalidOperationException("The cover-only quarantine is incomplete.");
        }
        await using (var header = new NpgsqlCommand($"SELECT singleton,binding FROM {ImportSchema}.cover_candidate", db, tx))
        await using (var row = await header.ExecuteReaderAsync(ct))
            if (!await row.ReadAsync(ct) || !row.GetBoolean(0) || row.GetString(1) != binding || await row.ReadAsync(ct))
                throw new InvalidOperationException("The cover-only quarantine belongs to a different approved proof or baseline.");
        var observed = new List<LegacyCoverCandidate>();
        await using (var query = new NpgsqlCommand($"SELECT * FROM {ImportSchema}.cover_mapping ORDER BY source_kind COLLATE \"C\",article_id,source_id LIMIT {LegacyAssetReferenceLimit + 1}", db, tx))
        await using (var rows = await query.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
                observed.Add(new(rows.GetString(0),rows.GetInt32(1),rows.GetInt64(2),rows.GetInt64(3),rows.GetInt64(4),
                    rows.GetString(5),rows.GetGuid(6),rows.GetString(7),rows.GetInt64(8),rows.GetGuid(9),rows.GetString(10),rows.GetBoolean(11),rows.GetBoolean(12)));
        if (!observed.SequenceEqual(expected.OrderBy(row => row.SourceKind, StringComparer.Ordinal).ThenBy(row => row.ArticleId).ThenBy(row => row.SourceId)))
            throw new InvalidOperationException("The stored cover mappings differ from the approved source proof.");
    }
}
