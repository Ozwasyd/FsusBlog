using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

internal static partial class Migration
{
    private static async Task CopyLegacyMediaAsync(AssetSnapshot snapshot, string publicPath, string privatePath,
        LegacyMediaReview approved, MediaOutput output, CancellationToken token)
    {
        var objects = LegacyMediaObjects(snapshot.Metadata, approved.Owners);
        var manifest = new LegacyMediaManifest(MediaPackageFormat, approved, output.ReviewDigest, objects,
            snapshot.References.Bindings, ReadyToApply: false);
        ValidateLegacyMediaManifest(manifest);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(manifest, OwnerMapJson);
        var manifestDigest = Convert.ToHexStringLower(SHA256.HashData(bytes));
        using (var destination = CreateLegacyMediaPackage(output.Parent, output.Name))
        {
            var buffer = new byte[128 * 1024];
            foreach (var asset in objects)
            {
                token.ThrowIfCancellationRequested();
                bool isPrivate = asset.StorageClass == "private";
                await using var copied = destination.CreatePayload(asset.AssetId);
                var (digest, failure) = await HashLegacyAssetFileAsync(isPrivate ? snapshot.PrivateRoot : snapshot.PublicRoot,
                    isPrivate ? privatePath : publicPath, asset.StorageKey, asset.Bytes, buffer, token, copied);
                if (failure is not null || digest != asset.Sha256)
                    throw new InvalidOperationException("Verified source media bytes changed before the offline copy could be sealed.");
                copied.Flush(flushToDisk: true);
            }
            token.ThrowIfCancellationRequested();
            destination.Seal(bytes);
        }

        var verified = await VerifyLegacyMediaPackageAsync(Path.Join(output.Parent, output.Name), manifestDigest, token);
        WriteLegacyMediaReceipt(manifestDigest, verified.Files.Length);
    }

    private static LegacyMediaObject[] LegacyMediaObjects(AssetMeta[] metadata, LegacyMediaOwner[] approved)
    {
        var owners = approved.ToDictionary(mapping => mapping.SourceAdminPrincipalId, mapping => mapping.TargetUserId);
        return metadata.Select(asset => new LegacyMediaObject(asset.Id, asset.StorageClass, asset.Key,
            asset.Bytes, asset.Digest!.ToLowerInvariant(), asset.MediaType, asset.Extension, asset.Width, asset.Height,
            NormalizeLegacyMediaTime(asset.Created), NormalizeLegacyMediaTime(asset.Updated), asset.Owner,
            asset.Owner is { } id ? owners[id] : null)).ToArray();
    }

    private static async Task<LegacyMediaManifest> VerifyLegacyMediaPackageAsync(string path, string approvedDigest, CancellationToken token)
    {
        if (!IsSha256(approvedDigest))
            throw new ArgumentException("Supply the independently recorded lowercase manifest SHA-256.");
        using var package = OpenLegacyMediaPackage(path);
        var bytes = await package.ReadManifestAsync(approvedDigest, token);
        var manifest = JsonSerializer.Deserialize<LegacyMediaManifest>(bytes, OwnerMapJson);
        ValidateLegacyMediaManifest(manifest);
        package.RequireExactFiles(manifest!.Files.Select(asset => asset.AssetId));
        var buffer = new byte[128 * 1024];
        foreach (var asset in manifest.Files)
        {
            token.ThrowIfCancellationRequested();
            await using var input = package.OpenPayload(asset.AssetId);
            if (await DigestLegacyMediaStreamAsync(input, asset.Bytes, token, buffer) != asset.Sha256)
                throw new InvalidOperationException("A quarantined media payload does not match its manifest length or SHA-256.");
        }
        package.RequireExactFiles(manifest.Files.Select(asset => asset.AssetId));
        return manifest;
    }

    private static void WriteLegacyMediaReceipt(string sha256, int files) =>
        Console.WriteLine(JsonSerializer.Serialize(new { manifestSha256 = sha256, files, readyToApply = false }, Json));

    private static void ValidateLegacyMediaManifest(LegacyMediaManifest? manifest)
    {
        if (manifest is null || manifest.Format != MediaPackageFormat || manifest.ReadyToApply ||
            !IsSha256(manifest.ReviewSha256) || manifest.Review is null || manifest.Files is null || manifest.References is null)
            throw new InvalidOperationException("Invalid quarantined media manifest.");
        CheckLegacyMediaReview(manifest.Review);
        if (manifest.Review.Files != manifest.Files.Length || manifest.Review.References != manifest.References.Length)
            throw new InvalidOperationException("Quarantined media rows differ from the reviewed counts.");
        var owners = manifest.Review.Owners.ToDictionary(owner => owner.SourceAdminPrincipalId, owner => owner.TargetUserId);
        var usedOwners = new HashSet<long>();
        var ids = new HashSet<Guid>();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        long totalBytes = 0;
        foreach (var asset in manifest.Files)
        {
            if (asset is null || asset.AssetId == Guid.Empty || !ids.Add(asset.AssetId) || asset.StorageKey is null ||
                !keys.Add(asset.StorageKey) || asset.Extension is null || asset.MediaType is null || !IsSha256(asset.Sha256) ||
                !IsCanonicalMediaTime(asset.CreatedAtUtc) || !IsCanonicalMediaTime(asset.UpdatedAtUtc) ||
                CheckAssetMetadata(new AssetMeta(asset.AssetId, asset.StorageClass, asset.StorageKey, asset.Extension, asset.MediaType,
                    asset.Bytes, asset.Sha256, asset.Width, asset.Height, asset.SourceOwnerId, "active", asset.CreatedAtUtc,
                    asset.UpdatedAtUtc)) is not null)
                throw new InvalidOperationException("Invalid quarantined media metadata.");
            if (asset.SourceOwnerId is { } source)
            {
                if (!owners.TryGetValue(source, out var chosen) || chosen is null || chosen != asset.TargetOwnerId)
                    throw new InvalidOperationException("Quarantined media metadata differs from its reviewed ownership.");
                usedOwners.Add(source);
            }
            else if (asset.StorageClass == "private" || asset.TargetOwnerId is not null)
                throw new InvalidOperationException("Private or assigned quarantined media requires a reviewed owner.");
            totalBytes += asset.Bytes;
            if (totalBytes > LegacyAssetByteLimit)
                throw new InvalidOperationException("Quarantined media exceeds its byte bound.");
        }
        if (usedOwners.Count != owners.Count)
            throw new InvalidOperationException("The quarantined metadata does not use every reviewed owner.");

        var keysSeen = new HashSet<(Guid, string, long)>();
        foreach (var reference in manifest.References)
            if (reference is null || !ids.Contains(reference.AssetId) || reference.SourceKind is not ("article" or "revision") ||
                reference.SourceId < 1 || reference.ArticleId < 1 || reference.ReferenceCount < 1 ||
                reference.SourceKind == "article" && reference.SourceId != reference.ArticleId ||
                reference.AltText?.Length > 256 || !IsCanonicalMediaTime(reference.UpdatedAtUtc) ||
                !keysSeen.Add((reference.AssetId, reference.SourceKind, reference.SourceId)))
                throw new InvalidOperationException("Invalid quarantined media source reference.");
    }

    private static bool IsCanonicalMediaTime(string? value) => value is not null &&
        DateTimeOffset.TryParseExact(value, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var time) &&
        time.Offset == TimeSpan.Zero;

    private static string NormalizeLegacyMediaTime(object value)
    {
        var utc = value switch
        {
            DateTimeOffset instant => instant.ToUniversalTime(),
            DateTime instant when instant.Kind != DateTimeKind.Local => new DateTimeOffset(instant, TimeSpan.Zero),
            string text when DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var instant) => instant,
            _ => throw new InvalidOperationException("Unsupported legacy media timestamp.")
        };
        return utc.ToString("O", CultureInfo.InvariantCulture);
    }

    private static async Task<string?> DigestLegacyMediaStreamAsync(Stream input, long expected, CancellationToken token,
        byte[]? copyBuffer = null)
    {
        if (!input.CanSeek || input.Length != expected) return null;
        var buffer = copyBuffer ?? new byte[128 * 1024];
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long remaining = expected;
        while (remaining > 0)
        {
            var read = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(remaining, buffer.Length)), token);
            if (read == 0) return null;
            hash.AppendData(buffer.AsSpan(0, read));
            remaining -= read;
        }
        return input.ReadByte() == -1 ? Convert.ToHexStringLower(hash.GetHashAndReset()) : null;
    }
}
