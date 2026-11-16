using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Microsoft.Win32.SafeHandles;
using Npgsql;

internal static partial class Migration
{
    private static async Task<bool> IsPristineLegacyCandidateSeedAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        string table, CancellationToken ct)
    {
        if (table is "v2_schema" or "authoring_recovery_site" or "admin_identity_schema") return true;
        var sql = table switch
        {
            "site_page_content" => """
                SELECT count(*)=4 AND bool_and(slug IN ('about','privacy','guidelines','copyright')
                    AND revision=0 AND markdown IS NULL) FROM public.site_page_content
                """,
            "appearance_activation" => """
                SELECT count(*)=1 AND bool_and(singleton AND revision=0 AND theme_digest='' AND font_digest='')
                FROM public.appearance_activation
                """,
            "taxonomy_epoch" => """
                SELECT count(*)=1 AND bool_and(singleton AND revision=0) FROM public.taxonomy_epoch
                """,
            "article_read_epoch" => """
                SELECT count(*)=1 AND bool_and(singleton AND last_epoch IS NULL) FROM public.article_read_epoch
                """,
            "root_comment_pow_policy" => """
                SELECT count(*)=1 AND bool_and(singleton AND generation=1 AND proof_seconds=120)
                FROM public.root_comment_pow_policy
                """,
            _ => null
        };
        if (sql is null) return false;
        await using var pristine = new NpgsqlCommand(sql, target, tx);
        return await pristine.ExecuteScalarAsync(ct) is true;
    }

    private sealed record ImportBackup(string Format, ImportArtifact DatabaseDump, ImportBackupSite Site);
    private sealed record ImportArtifact(long Bytes, string Sha256);
    private sealed record ImportBackupSite(int Version, int SchemaVersion, string PostgreSqlMajor,
        BackupRelation[] Relations, BackupMedia[] Media);

    private static async Task<ImportBackup> ReadLegacyImportBackupAsync(string path, string expected, CancellationToken token)
    {
        if (!Path.IsPathFullyQualified(path) || !IsSha256(expected))
            throw new ArgumentException("Provide an absolute verified backup directory and lowercase manifest SHA-256.");
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()))
            throw new InvalidOperationException("The import backup requires private Unix directory handles.");
        using var directory = OpenImportBackupDirectory(path);
        if (File.GetUnixFileMode(directory) != (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute))
            throw new InvalidOperationException("The import backup directory must use Unix permissions 0700.");

        await using var manifest = OpenImportBackupFile(directory, "manifest.json");
        var encoded = await ReadBoundedArtifactAsync(manifest, 2_000_000, token,
            static () => new InvalidOperationException("The import backup manifest is outside its size limit."),
            static () => new InvalidOperationException("The target backup manifest digest differs."), expected);
        var backup = JsonSerializer.Deserialize<ImportBackup>(encoded, OwnerMapJson);
        if (backup is null || backup.Format != "fsusblog-offline-backup-candidate-v1" ||
            backup.DatabaseDump is not { Bytes: > 5 and <= ImportBackupBytes } artifact || !IsSha256(artifact.Sha256) ||
            backup.Site is not { Version: BackupMeasurementVersion, SchemaVersion: CurrentSchema.Version, Media.Length: 0 } ||
            backup.Site.Relations is null)
            throw new InvalidOperationException("The import requires a verified PostgreSQL-only backup of the empty candidate.");

        await using var dump = OpenImportBackupFile(directory, "database.dump");
        if (dump.Length != artifact.Bytes) throw new InvalidOperationException("The import backup dump size differs.");
        var header = new byte[5];
        await dump.ReadExactlyAsync(header, token);
        if (!header.AsSpan().SequenceEqual("PGDMP"u8)) throw new InvalidOperationException("Expected a custom PostgreSQL backup.");
        dump.Position = 0;
        if (Convert.ToHexStringLower(await SHA256.HashDataAsync(dump, token)) != artifact.Sha256)
            throw new InvalidOperationException("The import backup database digest differs.");
        return backup;
    }

    private static int ImportDirectoryFlags => NativeUnixFile.DirectoryReadFlags;
    private static int ImportFileFlags => NativeUnixFile.FileReadFlags;

    private static SafeFileHandle OpenImportBackupDirectory(string path) => NativeUnixFile.OpenDirectory(path);

    private static FileStream OpenImportBackupFile(SafeFileHandle directory, string name)
    {
        var handle = new SafeFileHandle((nint)OpenImportChild(directory, name, ImportFileFlags), ownsHandle: true);
        if (handle.IsInvalid) { handle.Dispose(); throw new InvalidOperationException("The import backup contains an unavailable or linked file."); }
        try
        {
            if (NativeUnixFile.RegularMode(handle) is not (UnixFileMode.UserRead or (UnixFileMode.UserRead | UnixFileMode.UserWrite)))
                throw new InvalidOperationException("The import backup files must use Unix permissions 0400 or 0600.");
            var stream = new FileStream(handle, FileAccess.Read);
            if (!stream.CanSeek) { stream.Dispose(); throw new InvalidOperationException("The import backup files must be seekable."); }
            return stream;
        }
        catch { handle.Dispose(); throw; }
    }

    private static int OpenImportChild(SafeFileHandle directory, string path, int flags) =>
        NativeUnixFile.OpenAt(directory, path, flags);

    private static bool IsSha256(string? token) => token is { Length: 64 } && token.All(char.IsAsciiHexDigitLower);

    private static async Task<(DatabaseTarget Target, Guid Site, bool Quarantined)> ObserveLegacyTargetAsync(
        NpgsqlConnection target, ImportBackup backup, ArticleOwner[] owners, CancellationToken token)
    {
        await using var transaction = await BeginReadOnlyAsync(target, token);
        await SetBackupRepresentationAsync(target, transaction, token);
        await using (var role = new NpgsqlCommand("SHOW session_replication_role", target, transaction))
            if (await role.ExecuteScalarAsync(token) is not "origin")
                throw new InvalidOperationException("Candidate PostgreSQL integrity triggers are not active.");
        await CurrentSchema.VerifyCatalogAsync(target, transaction, token, requireArticleSummary: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(target, transaction, token);
        var site = await CurrentSchema.ReadRecoverySiteIdAsync(target, transaction, token);
        var identity = await ReadTargetAsync(target, transaction, token);
        await using var check = new NpgsqlCommand("""
            SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname='fsus_legacy_candidate'),
                   (SELECT version FROM public.v2_schema WHERE singleton)
            """, target, transaction);
        bool quarantined;
        await using (var row = await check.ExecuteReaderAsync(token))
        {
            if (!await row.ReadAsync(token)) throw new InvalidOperationException("The candidate marker could not be read.");
            quarantined = row.GetBoolean(0);
            if (row.IsDBNull(1) || row.GetInt32(1) != (quarantined ? ImportQuarantineVersion : CurrentSchema.Version))
                throw new InvalidOperationException("The target is not a current empty site or an isolated legacy candidate.");
        }

        var (relations, media) = await ReadBackupSiteAsync(target, transaction, token,
            excludedSchema: quarantined ? ImportSchema : null);
        var existing = backup.Site.Relations.ToDictionary(value => value.Name, StringComparer.Ordinal);
        if (media.Count != 0 || existing.Count != relations.Count ||
            backup.Site.PostgreSqlMajor != target.PostgreSqlVersion.Major.ToString(System.Globalization.CultureInfo.InvariantCulture) ||
            relations.Any(row => !existing.TryGetValue(row.Name, out var known) ||
                (quarantined && row.Name == "v2_schema" ? row.Rows != known.Rows || row.Kind != known.Kind : row != known)))
            throw new InvalidOperationException("The independent target business and sequence digests differ from the backup.");

        foreach (var row in relations.Where(row => row.Kind == "r" && row.Rows != 0))
            if (row.Name != "blog_user" && !await IsPristineLegacyCandidateSeedAsync(target, transaction, row.Name, token))
                throw new InvalidOperationException($"The disposable target contains operational rows in {row.Name}.");

        await using var accounts = new NpgsqlCommand("""
            SELECT id FROM public.blog_user WHERE enabled AND can_author ORDER BY id
            """, target, transaction);
        var allowed = new HashSet<Guid>();
        await using (var rows = await accounts.ExecuteReaderAsync(token))
            while (await rows.ReadAsync(token)) allowed.Add(rows.GetGuid(0));
        if (allowed.Count != relations.Single(row => row.Name == "blog_user").Rows ||
            !allowed.SetEquals(owners.Select(owner => owner.V2UserId)))
            throw new InvalidOperationException("Target authors must be provisioned independently and match the supplied owner map exactly.");

        await transaction.RollbackAsync(token);
        return (identity, site, quarantined);
    }
}
