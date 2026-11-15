using System.Security.Cryptography;
using System.Text.Json;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private const string MediaReviewFormat = "fsusblog-legacy-media-review-v1";
    private const string MediaPackageFormat = "fsusblog-legacy-media-quarantine-v1";
    private const int MaxMediaReviewBytes = 1_000_000;

    private sealed record LegacyMediaOwner(long SourceAdminPrincipalId, Guid? TargetUserId);
    private sealed record LegacyMediaReference(Guid AssetId, string SourceKind, long SourceId, int ArticleId, int ReferenceCount,
        string? AltText, string UpdatedAtUtc);
    private sealed record LegacyMediaObject(Guid AssetId, string StorageClass, string StorageKey, long Bytes,
        string Sha256, string MediaType, string Extension, long? Width, long? Height, string CreatedAtUtc, string UpdatedAtUtc,
        long? SourceOwnerId, Guid? TargetOwnerId);
    private sealed record LegacyMediaReview(string Format, string SourceReference, string Provider, string SourceSchema,
        Guid SourceSiteId, Guid TargetSiteId, string SourceDatabaseSha256, string TargetDatabaseSha256, string TargetSchemaSha256,
        string AssetMetadataSha256, string ReferenceSha256, string SourceAdminIdentitySha256, LegacyMediaOwner[] Owners,
        int Files, int References, bool ReadyToApply);
    private sealed record LegacyMediaManifest(string Format, LegacyMediaReview Review, string ReviewSha256,
        LegacyMediaObject[] Files, LegacyMediaReference[] References, bool ReadyToApply);

    private static async Task<int> RunLegacyMediaRehearsalAsync(string[] arguments, CancellationToken token)
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux())
            throw new ArgumentException("Legacy media rehearsal requires macOS or Linux.");
        return await RunBoundedLegacyOperationAsync(token, 8, "The legacy media rehearsal exceeded its run budget.",
            "The legacy media source or candidate rejected the read", Run);

        async Task<int> Run(CancellationToken ct)
        {
            switch (arguments)
            {
                case ["verify", var package, var manifestDigest]:
                    var verified = await VerifyLegacyMediaPackageAsync(package, manifestDigest, ct);
                    WriteLegacyMediaReceipt(manifestDigest, verified.Files.Length);
                    return 0;
                case ["plan", var provider, var publicRoot, var privateRoot, var sourceSite, var targetSite]:
                    return await CaptureLegacyMediaAsync(provider, publicRoot, privateRoot,
                        ParseLegacySiteId(sourceSite), ParseLegacySiteId(targetSite), null, null, ct);
                case ["copy", var provider, var publicRoot, var privateRoot, var reviewedPath, var reviewDigest,
                        var outputParent, var name]:
                    ValidateLegacyAssetRoots(publicRoot, outputParent);
                    ValidateLegacyAssetRoots(privateRoot, outputParent);
                    if (Environment.GetEnvironmentVariable("FSUSBLOG_PRIVATE_MEDIA_ROOT") is { Length: > 0 } liveMedia)
                        ValidateLegacyAssetRoots(Path.TrimEndingDirectorySeparator(Path.GetFullPath(liveMedia)), outputParent);
                    var review = await ReadLegacyMediaReviewAsync(reviewedPath, reviewDigest, ct);
                    return await CaptureLegacyMediaAsync(provider, publicRoot, privateRoot,
                        review.SourceSiteId, review.TargetSiteId, review, new MediaOutput(outputParent, name, reviewDigest), ct);
                default:
                    throw new ArgumentException("Use legacy assets rehearsal plan, copy, or verify. See --help.");
            }
        }
    }

    private sealed record MediaOutput(string Parent, string Name, string ReviewDigest);

    private static Guid ParseLegacySiteId(string value) =>
        Guid.TryParseExact(value, "D", out var id) && id != Guid.Empty
            ? id : throw new ArgumentException("Supply explicit nonempty source and target site UUIDs.");

    private static async Task<int> CaptureLegacyMediaAsync(string provider, string publicPath, string privatePath,
        Guid sourceSite, Guid targetSite, LegacyMediaReview? approved, MediaOutput? output, CancellationToken token)
    {
        if (sourceSite == targetSite)
            throw new InvalidOperationException("Supply distinct source and target site identities for the isolated rehearsal.");
        var settings = ParseImportTarget();
        await using var target = new NpgsqlConnection(settings.ConnectionString);
        await target.OpenAsync(token);
        await RequireBackupDatabaseLockAsync(target, token);
        await using var targetRead = await BeginReadOnlyAsync(target, token);
        var targetCluster = await ReadLegacyPostgresClusterAsync(target, targetRead, token);
        string? sourceFingerprint = null;
        return await ObserveLegacyAssetSnapshotAsync(provider, publicPath, privatePath, async (snapshot, ct) =>
        {
            if (snapshot.Issues.Count != 0 || snapshot.Metadata.Length == 0)
                throw new InvalidOperationException("Only a nonempty, fully verified legacy attachment snapshot can be rehearsed. Run legacy assets for blockers.");
            if (!HasField(snapshot.Principals, "handle"))
                throw new InvalidOperationException("The legacy attachment owner authority requires administrator handles.");
            var targetFingerprint = await CheckMediaCandidateAsync(target, targetRead, targetSite, targetCluster, ct);
            var principalDigest = await FingerprintLegacyPrincipalsAsync(snapshot.Source, snapshot.Transaction, snapshot.Principals,
                null, ct);
            var owners = snapshot.Metadata.Where(asset => asset.Owner is not null).Select(asset => asset.Owner!.Value)
                .Distinct().Order().ToArray();
            var current = new LegacyMediaReview(MediaReviewFormat, LegacyReference, provider, snapshot.Source.Schema,
                sourceSite, targetSite, sourceFingerprint ?? throw new InvalidOperationException("Source database binding was not observed."),
                targetFingerprint, Digest(await SchemaSqlAsync(ct)), snapshot.MetadataSha256, snapshot.References.Sha256,
                principalDigest, owners.Select(owner => new LegacyMediaOwner(owner, null)).ToArray(), snapshot.Metadata.Length,
                snapshot.References.Bindings.Length, ReadyToApply: false);
            if (approved is null)
            {
                Console.WriteLine(JsonSerializer.Serialize(current, Json));
                return 0;
            }
            if (!owners.SequenceEqual(approved.Owners.Select(owner => owner.SourceAdminPrincipalId)) ||
                DigestMediaDocument(approved with { Owners = current.Owners }) != DigestMediaDocument(current))
                throw new InvalidOperationException("The reviewed media plan no longer matches the frozen source, owners, site or candidate.");
            await CheckMediaDestinationOwnersAsync(target, targetRead, approved.Owners, ct);
            await CopyLegacyMediaAsync(snapshot, publicPath, privatePath, approved, output!, ct);
            return 0;
        }, token, async (source, transaction, ct) =>
        {
            sourceFingerprint = await ReadLegacySourceDatabaseFingerprintAsync(source, transaction, targetCluster, ct);
        });
    }

    private static string DigestMediaDocument<T>(T value) =>
        Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, OwnerMapJson)));

    private static async Task<LegacyMediaReview> ReadLegacyMediaReviewAsync(string path, string digest, CancellationToken token)
    {
        if (!Path.IsPathFullyQualified(path) || !IsSha256(digest) ||
            path != Path.GetFullPath(path) || string.IsNullOrEmpty(Path.GetFileName(path)))
            throw new ArgumentException("Provide the absolute reviewed plan path and its approved SHA-256.");
        await using var file = OpenLegacyMediaReviewFile(path);
        var bytes = await ReadBoundedArtifactAsync(file, MaxMediaReviewBytes, token,
            static () => new InvalidOperationException("The reviewed media plan has an invalid size."),
            static () => new InvalidOperationException("The reviewed media plan SHA-256 differs."), digest);
        var review = JsonSerializer.Deserialize<LegacyMediaReview>(bytes, OwnerMapJson);
        CheckLegacyMediaReview(review);
        return review!;
    }

    private static void CheckLegacyMediaReview(LegacyMediaReview? review)
    {
        if (review is null || review.Format != MediaReviewFormat || review.SourceReference != LegacyReference ||
            review.Provider is not ("postgres" or "mysql" or "sqlite") || string.IsNullOrWhiteSpace(review.SourceSchema) ||
            review.SourceSiteId == Guid.Empty || review.TargetSiteId == Guid.Empty || review.SourceSiteId == review.TargetSiteId ||
            !IsSha256(review.SourceDatabaseSha256) || !IsSha256(review.TargetDatabaseSha256) || !IsSha256(review.TargetSchemaSha256) ||
            !IsSha256(review.AssetMetadataSha256) || !IsSha256(review.ReferenceSha256) || !IsSha256(review.SourceAdminIdentitySha256) ||
            review.Owners is null || review.Owners.Length > LegacyAssetLimit || review.ReadyToApply ||
            review.Files is < 1 or > LegacyAssetLimit || review.References is < 0 or > LegacyAssetReferenceLimit)
            throw new InvalidOperationException("Invalid reviewed legacy media plan.");
        var destinations = new HashSet<Guid>();
        long previous = 0;
        foreach (var owner in review.Owners)
        {
            if (owner is null || owner.SourceAdminPrincipalId <= previous || owner.TargetUserId is not { } target ||
                target == Guid.Empty || !destinations.Add(target))
                throw new InvalidOperationException("Every source owner requires a distinct explicit existing target owner.");
            previous = owner.SourceAdminPrincipalId;
        }
    }
}
