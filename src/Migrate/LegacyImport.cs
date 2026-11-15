using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private const string ImportSchema = "fsus_legacy_candidate";
    private const string ImportVariable = "FSUSBLOG_IMPORT_DB";
    private const int ImportPlanVersion = 1;
    private const int ImportPlanWithCreateCommandsVersion = 2;
    private const int ImportPlanWithProcessedOutboxVersion = 3;
    private const int ImportPlanWithRepublishOutboxVersion = 4;
    private const int ImportPlanWithRollbackOutboxVersion = 5;
    private const int ImportQuarantineVersion = -1;
    private const long ImportBackupBytes = 1024L * 1024 * 1024;

    private sealed record ImportFinding(string Category, string Source, long Rows);
    private sealed record LegacyImportEvidence(LegacyCreateCommandRead Commands, LegacyOutboxRead Outbox,
        LegacyTaxonomyEvidence Taxonomy, LegacyReadingHistoryRead ReadingHistory, LegacySavedViewRead SavedViews, ImportFinding[] Findings)
    {
        internal LegacyProjection[] SourceProjections(LegacyAudit audit, bool includeTaxonomy = true)
        {
            var projections = new List<LegacyProjection>(audit.Projections);
            if (Commands.Projection is { } command) projections.Add(command);
            projections.AddRange(Outbox.Entries.Select(entry => entry.Projection));
            if (includeTaxonomy) projections.AddRange(Taxonomy.Projections);
            projections.AddRange(ReadingHistory.Projections);
            projections.AddRange(SavedViews.Relations.Select(relation => relation.Projection));
            return projections.ToArray();
        }
    }

    private sealed record ImportPlan(int Version, string SourceReference, string Provider, string SourceSchema,
        int SchemaVersion, string SchemaSha256, DatabaseTarget Target, Guid TargetSiteId, string BackupManifestSha256,
        string OwnerMapSha256, string SourceAdminIdentitySha256, LegacyProjection[] SourceProjections,
        ShadowCount[] ExpectedTables, ImportFinding[] Findings, bool ReadyToApply, bool ReadyToStage,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] LegacyPostgresSourceSeal? SourceSeal = null);

    private static async Task<int> RunLegacyImportAsync(string[] arguments, CancellationToken token)
    {
        if (arguments is [("project" or "verify") and var projectionMode, var plan, var planDigest,
                var backupDirectory, var backupDigest, .. var options])
        {
            var evaluation = options switch
            {
                [] => (DateTimeOffset?)null,
                ["--evaluate-schedules-at", var timestamp] => ParseLegacyScheduleEvaluation(timestamp),
                _ => throw new ArgumentException("Use --evaluate-schedules-at with one UTC evaluation timestamp.")
            };
            return await RunLegacyProjectionAsync(projectionMode, plan, planDigest, backupDirectory, backupDigest, evaluation, token);
        }
        if (arguments.Length is < 5 or > 6 || arguments[0] is not ("plan" or "apply") ||
            (arguments[0] == "apply") != (arguments.Length == 6))
            throw new ArgumentException("Use legacy import plan|apply with provider, owner map, backup directory, manifest digest, and apply plan.");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromMinutes(8));
        var ct = timeout.Token;
        try
        {
            var actual = await ImportLegacyAsync(arguments, ct);
            return actual;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && timeout.IsCancellationRequested)
        {
            throw new InvalidOperationException("The isolated legacy import exceeded its run budget.");
        }
        catch (DbException error)
        {
            throw new InvalidOperationException($"The isolated legacy source or target rejected its operation ({error.GetType().Name}).");
        }
    }

    private static async Task<int> ImportLegacyAsync(string[] arguments, CancellationToken token)
    {
        var (mode, provider, ownerPath, backupDirectory, backupDigest) =
            (arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]);
        var expected = mode == "apply"
            ? await ReadImportPlanAsync(arguments[5], token)
            : null;
        var backup = await ReadLegacyImportBackupAsync(backupDirectory, backupDigest, token);
        var settings = ParseImportTarget();
        var source = ParseLegacySource(provider);
        await using var sourceConnection = source.Connection;
        await sourceConnection.OpenAsync(token);
        await using var sourceTransaction = await BeginLegacyReadAsync(sourceConnection, token);
        var sourceSeal = sourceConnection is NpgsqlConnection postgres && (expected is null || expected.SourceSeal is not null)
            ? await SealLegacyPostgresSourceAsync(source, postgres, (NpgsqlTransaction)sourceTransaction, token)
            : null;
        if (expected?.SourceSeal is { } recorded && recorded != sourceSeal)
            throw new InvalidOperationException("The import plan no longer matches the PostgreSQL source identity or catalog.");
        var catalog = await ReadLegacyCatalogAsync(source, sourceTransaction, token);
        var (tables, blockers) = SelectLegacyTables(source, catalog);
        if (blockers.Count != 0)
            throw new InvalidOperationException("The source is outside the supported v1 article catalog. Run legacy plan for details.");
        var principal = FindLegacyImportPrincipal(source, catalog);
        if (principal is null)
            throw new InvalidOperationException("The source administrator identity relation does not match the supported intake.");

        var audit = await AuditLegacyAsync(source, sourceTransaction, tables, plan: true, token);
        if (audit.Issues.Count != 0)
            throw new InvalidOperationException("The source has article integrity defects. Run legacy plan for details.");
        var taxonomy = await VerifyLegacyTaxonomyAsync(source, sourceTransaction, catalog, tables, audit, token);
        var evidence = await ReadLegacyImportEvidenceAsync(source, sourceTransaction, catalog, tables, principal, taxonomy, token);
        var (commands, outbox, _, readingHistory, savedViews, findings) = evidence;
        var ownerMap = await ReadLegacyOwnerMapAsync(ownerPath, token);
        await using var shadow = await MaterializeLegacyShadowAsync(source, sourceTransaction, tables, principal, audit, ownerMap, token,
            commands.Rows, outbox.Entries, readingHistory.Rows, savedViews.Relations);
        await sourceTransaction.RollbackAsync(token);

        await using var target = new NpgsqlConnection(settings.ConnectionString);
        await target.OpenAsync(token);
        await RequireBackupDatabaseLockAsync(target, token);
        var (identity, siteId, quarantined) = await ObserveLegacyTargetAsync(target, backup, shadow.Owners, token);
        if (provider == "postgres" && expected is { SourceSeal: null } && !quarantined)
            throw new InvalidOperationException("Create a new sealed PostgreSQL plan before staging a fresh legacy candidate.");
        var schemaDigest = Digest(await SchemaSqlAsync(token));
        // Previously admitted empty derived tables were not sealed. An existing approved plan can replay that empty case.
        var includeTaxonomy = taxonomy.Status != "verified-empty" || expected?.SourceProjections is not { } prior ||
            prior.Any(row => IsLegacyTaxonomyRelation(row.Table));
        var sourceProjections = evidence.SourceProjections(audit, includeTaxonomy);
        var version = outbox.RollbackCount > 0 ? ImportPlanWithRollbackOutboxVersion :
            outbox.RepublishCount > 0 ? ImportPlanWithRepublishOutboxVersion :
            outbox.Entries.Length != 0 ? ImportPlanWithProcessedOutboxVersion :
            commands.Projection is null ? ImportPlanVersion : ImportPlanWithCreateCommandsVersion;
        var plan = new ImportPlan(version,
            LegacyReference, provider, source.Schema, CurrentSchema.Version,
            schemaDigest, identity, siteId, backupDigest, ownerMap.Digest, shadow.Report.SourceAdminIdentitySha256,
            sourceProjections, shadow.Report.Counts, findings, ReadyToApply: false, ReadyToStage: findings.Length == 0, SourceSeal: sourceSeal);
        if (mode == "plan")
        {
            if (quarantined) throw new InvalidOperationException("Reuse the original plan for an initialized legacy candidate.");
            Console.WriteLine(JsonSerializer.Serialize(plan, Json));
            return plan.ReadyToStage ? 0 : 2;
        }
        if (!plan.ReadyToStage)
            throw new InvalidOperationException("The legacy source contains unsupported rows. Run legacy import plan for category counts.");
        var digest = CanonicalImportPlanDigest(plan);
        if (expected is null || CanonicalImportPlanDigest(expected) != digest)
            throw new InvalidOperationException("The import plan no longer matches its source, owners, backup, schema or target.");
        var phases = await StageLegacyCandidateAsync(target, shadow, plan, digest, quarantined, token);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            planSha256 = digest,
            target = identity,
            phases,
            readyToApply = false,
            blockers = new[] { "candidate must not serve", "privileges, credentials, attachments and unsupported domains have no production converter",
                "signed proofs, activation and end-to-end recovery remain separate" }
        }, Json));
        return 0;
    }

    private static NpgsqlConnectionStringBuilder ParseImportTarget()
    {
        var dsn = Environment.GetEnvironmentVariable(ImportVariable);
        if (string.IsNullOrWhiteSpace(dsn))
            throw new ArgumentException($"Set {ImportVariable} to a disposable PostgreSQL candidate.");
        var settings = new NpgsqlConnectionStringBuilder(dsn)
        {
            Pooling = false, Enlist = false, Multiplexing = false, CommandTimeout = 30
        };
        if (settings.Database is not { } database || settings.Host is not { } host ||
            !database.StartsWith("fsusv2_import_", StringComparison.Ordinal) ||
            database.Length > 63 || database.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_') ||
            !Path.IsPathFullyQualified(host) || host.Contains(','))
            throw new ArgumentException("Legacy import requires a local Unix socket and a disposable fsusv2_import_* PostgreSQL database.");
        return settings;
    }

    private static LegacyTable? FindLegacyImportPrincipal(LegacySource source, LegacyTable[] catalog)
    {
        var principals = catalog.Where(table => table.Name.Equals("admin_principal", StringComparison.OrdinalIgnoreCase)).ToArray();
        return principals is [var table] && source.IsSnapshotTable(table.Kind) && HasField(table, "id") && HasField(table, "handle")
            ? table : null;
    }

    private static async Task<LegacyImportEvidence> ReadLegacyImportEvidenceAsync(LegacySource source, DbTransaction transaction,
        LegacyTable[] catalog, Dictionary<string, LegacyTable> tables, LegacyTable principal, LegacyTaxonomyEvidence taxonomy,
        CancellationToken token)
    {
        var commands = await ReadLegacyCreateCommandsAsync(source, transaction, catalog, tables, principal, token);
        var outbox = await ReadLegacyProcessedOutboxAsync(source, transaction, catalog, tables, principal, token);
        var history = await ReadLegacyReadingHistoryAsync(source, transaction, tables[Article], catalog, token);
        var savedViews = await ReadLegacySavedViewsAsync(source, transaction, catalog, principal, token);
        var findings = await ScanImportBoundariesAsync(source, transaction, catalog, tables, principal, commands, outbox, taxonomy, history, savedViews, token);
        return new LegacyImportEvidence(commands, outbox, taxonomy, history, savedViews, findings);
    }

    private static async Task<ImportFinding[]> ScanImportBoundariesAsync(LegacySource source, DbTransaction transaction,
        LegacyTable[] catalog, Dictionary<string, LegacyTable> tables, LegacyTable principal, LegacyCreateCommandRead commands,
        LegacyOutboxRead outbox, LegacyTaxonomyEvidence taxonomy, LegacyReadingHistoryRead history, LegacySavedViewRead savedViews,
        CancellationToken token)
    {
        var found = new List<ImportFinding>(taxonomy.Findings);
        if (commands.Finding is { } finding) found.Add(finding);
        if (history.Finding is { } historyFinding) found.Add(historyFinding);
        if (savedViews.Finding is { } savedViewFinding) found.Add(savedViewFinding);
        found.AddRange(outbox.Findings);
        foreach (var relation in catalog)
        {
            var name = relation.Name.ToLowerInvariant();
            if (LegacyColumns.ContainsKey(name) || relation == principal || relation == commands.Relation || outbox.Relations.Contains(relation) ||
                taxonomy.Covers(relation.Name) || (history.HandlesSeed && name == LegacyViewSeed) || savedViews.Covers(relation.Name)) continue;
            var category = name.Contains("asset", StringComparison.Ordinal) || name.Contains("upload", StringComparison.Ordinal)
                ? "attachments" : name.Contains("credential", StringComparison.Ordinal) || name.Contains("permission", StringComparison.Ordinal)
                || name.Contains("session", StringComparison.Ordinal) || name.Contains("user", StringComparison.Ordinal)
                ? "identity-or-privilege" : "unsupported-source-relation";
            if (!source.IsSnapshotTable(relation.Kind))
            {
                found.Add(new ImportFinding("unverifiable-source-relation", relation.Name, 1));
                continue;
            }
            await CountUnsupported(category, relation.Name, $"FROM {source.Table(relation)}");
        }

        // A registered conversion does not infer even an author grant from old principal properties.
        var admin = source.Table(principal);
        if (HasField(principal, "permissions"))
        {
            var permissions = source.Field(principal, "permissions");
            await CountUnsupported("legacy-privilege", "admin_principal.permissions",
                $"FROM {admin} WHERE {permissions} IS NOT NULL AND TRIM({permissions}) NOT IN ('', '[]')");
        }
        if (HasField(principal, "isroot"))
            await CountUnsupported("legacy-privilege", "admin_principal.isroot", $"FROM {admin} WHERE {source.Field(principal, "isroot")} = true");
        if (HasField(principal, "totpenabled"))
            await CountUnsupported("legacy-credential", "admin_principal.totpenabled", $"FROM {admin} WHERE {source.Field(principal, "totpenabled")} = true");
        if (HasField(principal, "totpsecretencrypted"))
            await CountUnsupported("legacy-credential", "admin_principal.totpsecretencrypted", $"FROM {admin} WHERE {source.Field(principal, "totpsecretencrypted")} IS NOT NULL");
        if (HasField(principal, "status"))
            await CountUnsupported("legacy-privilege", "admin_principal.status",
                $"FROM {admin} WHERE {source.Field(principal, "status")} IS NULL OR {source.Field(principal, "status")} <> 'active'");
        if (HasField(principal, "validationversion"))
            await CountUnsupported("legacy-privilege", "admin_principal.validationversion",
                $"FROM {admin} WHERE {source.Field(principal, "validationversion")} IS NULL OR {source.Field(principal, "validationversion")} <> 1");

        foreach (var (name, cover) in new[] { (Article, "coverimageurl"), (Revision, "cover_image_url") })
        {
            var field = source.Field(tables[name], cover);
            await CountUnsupported("attachment-reference", name + "." + cover,
                $"FROM {source.Table(tables[name])} WHERE {field} IS NOT NULL AND TRIM({field}) <> ''");
        }
        foreach (var (name, content) in new[] { (Body, "markdown_content"), (Revision, "markdown_content"), (Block, "markdown_content") })
        {
            var field = source.Field(tables[name], content);
            await CountUnsupported("attachment-reference", name + "." + content,
                $"FROM {source.Table(tables[name])} WHERE LOWER({field}) LIKE '%/api/assets/%' OR LOWER({field}) LIKE '%/api/media/%' " +
                $"OR LOWER({field}) LIKE '%asset:%' OR LOWER({field}) LIKE '%/uploads/%'");
        }

        var knownPrincipalColumns = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "id", "handle", "displayname", "status", "validationversion", "isroot", "permissions",
            "createdatutc", "lastloginatutc", "totpenabled", "totpsecretencrypted", "totpverifiedatutc"
        };
        foreach (var field in principal.Columns.Where(field => !knownPrincipalColumns.Contains(field.Name)))
            await CountUnsupported("unregistered-administrator-field", field.Name,
                $"FROM {admin} WHERE {source.Quote(field.Name)} IS NOT NULL");
        foreach (var (name, relation) in tables)
        {
            var known = LegacyColumns[name];
            foreach (var field in relation.Columns.Where(field => !known.Contains(field.Name, StringComparer.OrdinalIgnoreCase)))
            {
                if (name == Article && history.HandlesViews && field.Name.Equals("views", StringComparison.OrdinalIgnoreCase)) continue;
                await CountUnsupported("unregistered-source-field", name + "." + field.Name,
                    $"FROM {source.Table(relation)} WHERE {source.Quote(field.Name)} IS NOT NULL");
            }
        }
        return found.OrderBy(finding => finding.Category, StringComparer.Ordinal)
            .ThenBy(finding => finding.Source, StringComparer.Ordinal).ToArray();

        async Task CountUnsupported(string category, string name, string sql)
        {
            var rows = await CountAsync(sql, transaction, token);
            if (rows > 0) found.Add(new ImportFinding(category, name, rows));
        }
    }

    private static bool HasField(LegacyTable table, string field) =>
        table.Columns.Count(value => value.Name.Equals(field, StringComparison.OrdinalIgnoreCase)) == 1;

    private static async Task<ImportPlan> ReadImportPlanAsync(string path, CancellationToken token)
    {
        await using var input = File.OpenRead(path);
        if (input.Length is <= 0 or > 2_000_000) throw new InvalidOperationException("The legacy import plan is outside its size boundary.");
        var plan = await JsonSerializer.DeserializeAsync<ImportPlan>(input, OwnerMapJson, token) ??
            throw new InvalidOperationException("Expected an exact legacy import plan.");
        if (plan.SourceSeal is { } seal && (plan.Provider != "postgres" || !seal.IsValid()))
            throw new InvalidOperationException("The legacy import plan contains an invalid PostgreSQL source seal.");
        return plan;
    }

    private static string CanonicalImportPlanDigest(ImportPlan plan)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(plan, OwnerMapJson)));
}
