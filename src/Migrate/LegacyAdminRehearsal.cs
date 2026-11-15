using System.Data;
using System.Globalization;
using System.Text.Json;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyAdminReviewFormat = "fsusblog-legacy-admin-rehearsal-v1";
    private const int LegacyAdminSelectionLimit = 256;
    private sealed record LegacyAdminSelection(long SourceAdminId, string SourceHandle, string SourceStatus,
        long SourceGeneration, string[] SourceGrants, long SourcePasskeys, long SourceSessions, Guid? TargetAdminId);
    private sealed record LegacyAdminReview(string Format, string SourceReference, string Provider, string SourceSchema,
        Guid SourceSiteId, Guid TargetSiteId, string SourceDatabaseSha256, string TargetDatabaseSha256, string TargetSchemaSha256,
        string BackupManifestSha256, LegacyAdminSelection[] Principals, bool ReadyToApply);

    private static async Task<int> RunLegacyAdminRehearsalAsync(string[] arguments, CancellationToken token)
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux())
            throw new ArgumentException("Administrator migration rehearsal requires macOS or Linux.");
        return await RunBoundedLegacyOperationAsync(token, 5, "The administrator migration rehearsal exceeded its run budget.",
            "The isolated administrator operation failed", Run, postgresState: true,
            representationError: "The old administrator metadata has an unsupported field representation.");

        async Task<int> Run(CancellationToken ct)
        {
            switch (arguments)
            {
                case ["plan", var provider, var sourceText, var targetText, var backup, var backupSha, .. var ids]:
                    if (ids.Length is < 1 or > LegacyAdminSelectionLimit)
                        throw new ArgumentException("Select between 1 and 256 exact old administrator IDs.");
                    var selected = ids.Select(ParseLegacyAdminId).Order().ToArray();
                    if (selected.Distinct().Count() != selected.Length)
                        throw new ArgumentException("Each selected old administrator ID must be unique.");
                    await RehearseLegacyAdminsAsync(provider, ParseLegacySiteId(sourceText), ParseLegacySiteId(targetText),
                        backup, backupSha, selected, null, null, null, "plan", ct);
                    return 0;
                case [("stage" or "verify") and var mode, var path, var approvedSha, var backup, var backupSha, .. var receipt]:
                    if (mode == "verify" ? receipt is not [var expected] || !IsSha256(expected) : receipt.Length != 0)
                        throw new ArgumentException("Verify requires the independently recorded candidate SHA-256 from the stage receipt.");
                    var review = await ReadLegacyAdminReviewAsync(path, approvedSha, ct);
                    await RehearseLegacyAdminsAsync(review.Provider, review.SourceSiteId, review.TargetSiteId, backup, backupSha,
                        review.Principals.Select(item => item.SourceAdminId).ToArray(), review, approvedSha,
                        mode == "verify" ? receipt[0] : null, mode, ct);
                    return 0;
                default:
                    throw new ArgumentException("Use legacy admin plan, stage or verify with the documented arguments.");
            }
        }
    }

    private static long ParseLegacyAdminId(string value) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0 &&
        id.ToString(CultureInfo.InvariantCulture) == value ? id :
        throw new ArgumentException("Select only canonical positive Int64 old administrator IDs.");

    private static async Task RehearseLegacyAdminsAsync(string provider, Guid sourceSite, Guid targetSite, string backupPath,
        string backupSha, long[] selected, LegacyAdminReview? approved, string? approvedSha, string? expectedCandidateSha,
        string mode, CancellationToken ct)
    {
        if (sourceSite == targetSite) throw new ArgumentException("Source and candidate must have distinct reviewed site IDs.");
        var backup = await ReadLegacyImportBackupAsync(backupPath, backupSha, ct);
        var settings = ParseImportTarget();
        await using var target = new NpgsqlConnection(settings.ConnectionString);
        await target.OpenAsync(ct);
        await RequireBackupDatabaseLockAsync(target, ct);
        await using var targetTx = mode == "stage"
            ? await target.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct)
            : await BeginReadOnlyAsync(target, ct);
        await ExecuteAsync(target, targetTx, "SET LOCAL search_path TO pg_catalog", ct);
        await SetBackupRepresentationAsync(target, targetTx, ct);
        var cluster = await ReadLegacyPostgresClusterAsync(target, targetTx, ct);
        var targetFingerprint = await FingerprintLegacyPostgresDatabaseAsync(target, targetTx, cluster, ct);
        var schemaFingerprint = Digest(await SchemaSqlAsync(ct));
        var quarantined = await ReadLegacyAdminTargetAsync(target, targetTx, targetSite, mode, ct);
        await CheckLegacyAdminBaselineAsync(target, targetTx, backup, quarantined, ct);
        if (approved is not null && (approved.BackupManifestSha256 != backupSha || approved.TargetDatabaseSha256 != targetFingerprint ||
            approved.TargetSchemaSha256 != schemaFingerprint))
            throw new InvalidOperationException("The reviewed administrator plan no longer matches its target, backup or schema.");
        if (mode != "verify")
        {
            var source = ParseLegacySource(provider);
            await using var sourceDb = source.Connection;
            await sourceDb.OpenAsync(ct);
            await using var sourceTx = await BeginLegacyReadAsync(sourceDb, ct);
            var databaseDigest = await ReadLegacySourceDatabaseFingerprintAsync(source, sourceTx, cluster, ct,
                bindSqliteBytes: false);
            var principals = await ReadLegacyAdminSelectionsAsync(source, sourceTx, selected, ct);
            await sourceTx.RollbackAsync(ct);
            var review = new LegacyAdminReview(LegacyAdminReviewFormat, LegacyReference, provider, source.Schema, sourceSite, targetSite,
                databaseDigest, targetFingerprint, schemaFingerprint, backupSha, principals, ReadyToApply: false);
            if (approved is null)
            {
                Console.WriteLine(JsonSerializer.Serialize(review, Json));
                await targetTx.RollbackAsync(ct);
                return;
            }
            var withoutMappings = approved with { Principals = approved.Principals.Select(row => row with { TargetAdminId = null }).ToArray() };
            if (DigestMediaDocument(withoutMappings) != DigestMediaDocument(review))
                throw new InvalidOperationException("The old administrator records no longer match the reviewed source.");
        }
        if (!quarantined)
            await StageDisabledLegacyAdminsAsync(target, targetTx, approved!, approvedSha!, ct);
        var candidateDigest = await VerifyDisabledLegacyAdminsAsync(target, targetTx, approved!, approvedSha!, quarantined, ct);
        if (expectedCandidateSha is not null && candidateDigest != expectedCandidateSha)
            throw new InvalidOperationException("The independently recorded administrator candidate SHA-256 differs.");
        await targetTx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            reviewSha256 = approvedSha,
            candidateSha256 = candidateDigest,
            principals = approved!.Principals.Length,
            result = mode == "verify" ? "verified" : quarantined ? "revalidated" : "staged",
            readyToApply = false,
            enrollment = "separate approved v2 enrollment required"
        }, Json));
    }

    private static async Task<LegacyAdminReview> ReadLegacyAdminReviewAsync(string path, string expectedSha, CancellationToken ct)
    {
        if (!IsSha256(expectedSha)) throw new ArgumentException("Provide the independently reviewed plan SHA-256.");
        await using var file = OpenLegacyMediaReviewFile(path);
        var bytes = await ReadBoundedArtifactAsync(file, MaxMediaReviewBytes, ct,
            static () => new InvalidOperationException("The reviewed administrator plan exceeds its input bound."),
            static () => new InvalidOperationException("The reviewed administrator plan SHA-256 differs."), expectedSha);
        var review = JsonSerializer.Deserialize<LegacyAdminReview>(bytes, OwnerMapJson);
        if (review is null || review.Format != LegacyAdminReviewFormat || review.SourceReference != LegacyReference ||
            review.Provider is not ("postgres" or "mysql" or "sqlite") || string.IsNullOrWhiteSpace(review.SourceSchema) ||
            review.SourceSiteId == Guid.Empty || review.TargetSiteId == Guid.Empty || review.SourceSiteId == review.TargetSiteId ||
            !IsSha256(review.SourceDatabaseSha256) || !IsSha256(review.TargetDatabaseSha256) || !IsSha256(review.TargetSchemaSha256) ||
            !IsSha256(review.BackupManifestSha256) || review.ReadyToApply ||
            review.Principals is not { Length: >= 1 and <= LegacyAdminSelectionLimit })
            throw new InvalidOperationException("Invalid reviewed legacy administrator plan.");
        var targets = new HashSet<Guid>();
        var handles = new HashSet<string>(StringComparer.Ordinal);
        long last = 0;
        foreach (var principal in review.Principals)
        {
            if (principal is null || principal.SourceAdminId <= last || principal.TargetAdminId is not { } target ||
                target == Guid.Empty || !targets.Add(target) || !IsLegacyAdminHandle(principal.SourceHandle) ||
                !handles.Add(principal.SourceHandle) || principal.SourceStatus is not ("active" or "disabled") ||
                principal.SourceGeneration < 1 || principal.SourcePasskeys < 0 || principal.SourceSessions < 0 ||
                principal.SourceGrants is null || !IsReviewedLegacyGrantSet(principal.SourceGrants))
                throw new InvalidOperationException("Every selected old administrator requires a distinct reviewed UUID and compatible metadata.");
            last = principal.SourceAdminId;
        }
        return review;
    }
}
