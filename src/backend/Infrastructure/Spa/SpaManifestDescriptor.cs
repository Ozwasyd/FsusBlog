using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Infrastructure.Spa;

internal sealed record SpaManifestDescriptor(
    string? DescriptorPath,
    string? DescriptorContentDigest,
    string? BuildReceiptPath,
    string? BuildReceiptDigest,
    string? SourceCommit,
    string? WorktreeFingerprint,
    string? ReleaseId,
    string AssetRoot,
    string IndexPath,
    string ManifestPath,
    string? ManifestDigest,
    string? AssetInventoryPath,
    string? AssetInventoryDigest)
{
    private const string DescriptorSchema = "fsusblog.spa-manifest-descriptor.v1";
    private const string ProductionBuildReceiptSchema = "fsusblog.ci-production-build-receipt.v1";
    private static readonly FrozenSet<string> s_descriptorKeys = new[]
    {
        "schema",
        "releaseId",
        "sourceCommit",
        "worktreeFingerprint",
        "buildReceiptDigest",
        "assetRoot",
        "manifestPath",
        "manifestDigest",
        "assetInventoryDigest",
        "contentDigest"
    }.ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> s_generatedReleaseFiles = new[]
    {
        "asset-manifest.json",
        "release-compatibility.json",
        "spa-manifest-descriptor.json",
        "production-build-receipt.json"
    }.ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> s_requiredToolchain = new[]
    {
        "node",
        "npm",
        "dotnet",
        "vite",
        "vitest",
        "playwright",
        "emsdk"
    }.ToFrozenSet(StringComparer.Ordinal);

    public static SpaManifestDescriptor ReadAndValidate(
        string descriptorPath,
        string buildReceiptPath,
        string configuredAssetBase,
        ReleaseIdentitySnapshot identity)
    {
        if (string.IsNullOrWhiteSpace(configuredAssetBase))
        {
            throw new SpaManifestValidationException("spa_release_asset_root_missing");
        }

        string releaseId = identity.ReleaseId;
        string assetBasePath = Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(configuredAssetBase));
        RejectSymlinkPath(assetBasePath, assetBasePath);
        string rootPath = Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(Path.Combine(assetBasePath, releaseId)));
        RequireContained(
            assetBasePath,
            rootPath,
            "spa_manifest_asset_root_authority_mismatch");
        string? rootParentPath = Path.GetDirectoryName(rootPath);
        if (rootParentPath is null || !PathEquals(rootParentPath, assetBasePath))
        {
            throw new SpaManifestValidationException(
                "spa_manifest_asset_root_authority_mismatch");
        }
        RejectSymlinkPath(assetBasePath, rootPath);
        string realAssetBasePath = ResolveRealPath(assetBasePath);
        string expectedRealRootPath = Path.GetFullPath(
            Path.Combine(realAssetBasePath, releaseId));
        if (!PathEquals(ResolveRealPath(rootPath), expectedRealRootPath))
        {
            throw new SpaManifestValidationException(
                "spa_manifest_asset_root_authority_mismatch");
        }

        string fullDescriptorPath = Path.GetFullPath(descriptorPath);
        if (!PathEquals(
                fullDescriptorPath,
                Path.Combine(rootPath, "spa-manifest-descriptor.json")))
        {
            throw new SpaManifestValidationException(
                "spa_manifest_descriptor_authority_mismatch");
        }
        RejectSymlinkPath(rootPath, fullDescriptorPath);
        if (!File.Exists(fullDescriptorPath))
        {
            throw new SpaManifestValidationException("spa_manifest_descriptor_missing");
        }

        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(fullDescriptorPath));
        JsonElement descriptor = document.RootElement;
        RequireExactKeys(descriptor, s_descriptorKeys, "spa_manifest_descriptor_schema_invalid");
        Require(descriptor, "schema", DescriptorSchema);
        string descriptorDigest = RequireDigest(descriptor, "contentDigest");
        if (!string.Equals(descriptorDigest, ComputeContentDigest(descriptor), StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_manifest_descriptor_content_digest_mismatch");
        }

        string descriptorReleaseId = Require(descriptor, "releaseId");
        string sourceCommit = Require(descriptor, "sourceCommit", identity.CommitSha);
        string worktreeFingerprint = RequireFingerprint(descriptor, "worktreeFingerprint");
        string buildReceiptDigest = RequireDigest(descriptor, "buildReceiptDigest");
        string assetRoot = Require(descriptor, "assetRoot");
        string manifestPath = Require(descriptor, "manifestPath");
        string manifestDigest = RequireDigest(descriptor, "manifestDigest");
        string inventoryDigest = RequireDigest(descriptor, "assetInventoryDigest");
        if (!string.Equals(descriptorReleaseId, releaseId, StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_manifest_release_identity_mismatch");
        }

        string descriptorRootPath = Path.TrimEndingDirectorySeparator(
            Path.GetFullPath(assetRoot));
        RejectSymlinkPath(assetBasePath, descriptorRootPath);
        if (!PathEquals(descriptorRootPath, rootPath)
            || !PathEquals(ResolveRealPath(descriptorRootPath), expectedRealRootPath))
        {
            throw new SpaManifestValidationException(
                "spa_manifest_asset_root_authority_mismatch");
        }

        if (string.IsNullOrWhiteSpace(buildReceiptPath))
        {
            throw new SpaManifestValidationException("spa_build_receipt_missing");
        }
        string fullBuildReceiptPath = Path.GetFullPath(buildReceiptPath);
        if (!PathEquals(
                fullBuildReceiptPath,
                Path.Combine(rootPath, "production-build-receipt.json")))
        {
            throw new SpaManifestValidationException(
                "spa_build_receipt_authority_mismatch");
        }
        RejectSymlinkPath(rootPath, fullBuildReceiptPath);

        string fullManifestPath = Path.GetFullPath(manifestPath);
        RequireContained(rootPath, fullManifestPath, "spa_manifest_path_escaped_asset_root");
        RejectSymlinkPath(rootPath, fullManifestPath);
        if (!PathEquals(
                fullManifestPath,
                Path.Combine(rootPath, ".vite", "manifest.json")))
        {
            throw new SpaManifestValidationException(
                "spa_manifest_path_authority_mismatch");
        }
        if (!File.Exists(fullManifestPath))
        {
            throw new SpaManifestValidationException("spa_manifest_missing");
        }
        if (!string.Equals(Sha256File(fullManifestPath), manifestDigest, StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_manifest_digest_mismatch");
        }

        string inventoryPath = Path.Combine(rootPath, "asset-manifest.json");
        RequireContained(rootPath, inventoryPath, "spa_asset_inventory_escaped_asset_root");
        RejectSymlinkPath(rootPath, inventoryPath);
        if (!File.Exists(inventoryPath)
            || !string.Equals(Sha256File(inventoryPath), inventoryDigest, StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_asset_inventory_digest_mismatch");
        }

        ReceiptBinding receipt = ValidateBuildReceipt(
            fullBuildReceiptPath,
            sourceCommit,
            worktreeFingerprint,
            buildReceiptDigest);
        ValidateInventory(inventoryPath, fullManifestPath, releaseId, receipt);
        string indexPath = Path.Combine(rootPath, "index.html");
        return new SpaManifestDescriptor(
            fullDescriptorPath,
            descriptorDigest,
            receipt.ReceiptPath,
            buildReceiptDigest,
            sourceCommit,
            worktreeFingerprint,
            descriptorReleaseId,
            rootPath,
            indexPath,
            fullManifestPath,
            manifestDigest,
            inventoryPath,
            inventoryDigest);
    }

    private static ReceiptBinding ValidateBuildReceipt(
        string buildReceiptPath,
        string expectedCommit,
        string expectedWorktreeFingerprint,
        string expectedReceiptDigest)
    {
        if (string.IsNullOrWhiteSpace(buildReceiptPath))
        {
            throw new SpaManifestValidationException("spa_build_receipt_missing");
        }

        string fullReceiptPath = Path.GetFullPath(buildReceiptPath);
        if (IsSymlink(fullReceiptPath))
        {
            throw new SpaManifestValidationException("spa_build_receipt_symlink");
        }
        if (!File.Exists(fullReceiptPath))
        {
            throw new SpaManifestValidationException("spa_build_receipt_missing");
        }

        using JsonDocument receiptDocument = JsonDocument.Parse(File.ReadAllText(fullReceiptPath));
        JsonElement receipt = receiptDocument.RootElement;
        Require(receipt, "schema", ProductionBuildReceiptSchema, "spa_build_receipt_contract_invalid");
        Require(receipt, "status", "complete", "spa_build_receipt_contract_invalid");
        string receiptDigest = RequireDigest(
            receipt,
            "contentDigest",
            "spa_build_receipt_content_digest_invalid");
        if (!string.Equals(receiptDigest, ComputeContentDigest(receipt), StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_build_receipt_content_digest_mismatch");
        }
        if (!string.Equals(receiptDigest, expectedReceiptDigest, StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_build_receipt_digest_mismatch");
        }

        JsonElement sourceState = RequireObject(receipt, "sourceState", "spa_build_receipt_source_invalid");
        Require(sourceState, "commit", expectedCommit, "spa_build_receipt_source_invalid");
        string receiptFingerprint = RequireFingerprint(
            sourceState,
            "worktreeFingerprint",
            "spa_build_receipt_source_invalid");
        if (!string.Equals(receiptFingerprint, expectedWorktreeFingerprint, StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_build_receipt_worktree_mismatch");
        }

        ValidateProducer(receipt);
        ValidateToolchain(receipt);
        ValidateInputs(receipt);
        ValidateSeal(receipt);

        JsonElement domainsElement = RequireArray(
            receipt,
            "domains",
            "spa_build_receipt_contract_invalid");
        var domains = new Dictionary<string, ReceiptDomain>(StringComparer.Ordinal);
        var domainPaths = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement item in domainsElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
            }
            string name = Require(item, "name", errorPrefix: "spa_build_receipt_contract_invalid");
            string domainPath = NormalizeRelative(
                Require(item, "path", errorPrefix: "spa_build_receipt_contract_invalid"),
                "spa_build_receipt_contract_invalid");
            string consumerMode = Require(
                item,
                "consumerMode",
                errorPrefix: "spa_build_receipt_contract_invalid");
            int fileCount = RequireNonNegativeInt32(
                item,
                "fileCount",
                "spa_build_receipt_contract_invalid");
            if (!Regex.IsMatch(name, "^[a-z][a-z0-9-]*$", RegexOptions.CultureInvariant)
                || fileCount < 1
                || consumerMode is not ("read-only" or "copy-before-write")
                || !domains.TryAdd(name, new ReceiptDomain(name, domainPath, consumerMode, fileCount))
                || !domainPaths.Add(domainPath))
            {
                throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
            }
        }

        if (!domains.TryGetValue("frontend-dist", out ReceiptDomain? frontendDomain)
            || !string.Equals(frontendDomain.ConsumerMode, "read-only", StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
        }

        JsonElement artifactsElement = RequireArray(
            receipt,
            "artifacts",
            "spa_build_receipt_contract_invalid");
        var artifacts = new Dictionary<string, ReceiptArtifact>(StringComparer.Ordinal);
        foreach (JsonElement item in artifactsElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
            }
            string artifactPath = NormalizeRelative(
                Require(item, "path", errorPrefix: "spa_build_receipt_artifact_mismatch"),
                "spa_build_receipt_artifact_mismatch");
            long size = RequireNonNegativeInt64(item, "size", "spa_build_receipt_artifact_mismatch");
            string digest = RequireDigest(item, "sha256", "spa_build_receipt_artifact_mismatch");
            if (!artifacts.TryAdd(artifactPath, new ReceiptArtifact(artifactPath, size, digest)))
            {
                throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
            }
        }

        JsonElement digestTable = RequireObject(
            receipt,
            "digestTable",
            "spa_build_receipt_contract_invalid");
        Require(
            digestTable,
            "authority",
            "receipt.artifacts",
            "spa_build_receipt_contract_invalid");
        if (RequireNonNegativeInt32(
                digestTable,
                "traversalCount",
                "spa_build_receipt_contract_invalid") != 1
            || RequireNonNegativeInt32(
                digestTable,
                "entryCount",
                "spa_build_receipt_contract_invalid") != artifacts.Count)
        {
            throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
        }

        foreach (ReceiptDomain domain in domains.Values)
        {
            int ownedCount = artifacts.Keys.Count(path => IsInDomain(path, domain.Path));
            if (ownedCount != domain.FileCount)
            {
                throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
            }
        }
        foreach (string artifactPath in artifacts.Keys)
        {
            if (domains.Values.Count(domain => IsInDomain(artifactPath, domain.Path)) != 1)
            {
                throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
            }
        }
        JsonElement metrics = RequireObject(
            receipt,
            "metrics",
            "spa_build_receipt_contract_invalid");
        if (RequireNonNegativeInt32(
                metrics,
                "artifactCount",
                "spa_build_receipt_contract_invalid") != artifacts.Count
            || RequireNonNegativeInt64(
                metrics,
                "artifactBytes",
                "spa_build_receipt_contract_invalid") != artifacts.Values.Sum(
                    static artifact => artifact.Size))
        {
            throw new SpaManifestValidationException(
                "spa_build_receipt_contract_invalid");
        }

        string frontendPrefix = frontendDomain.Path + "/";
        var frontendArtifacts = new Dictionary<string, ReceiptArtifact>(StringComparer.Ordinal);
        foreach (ReceiptArtifact artifact in artifacts.Values.Where(
            artifact => artifact.Path.StartsWith(frontendPrefix, StringComparison.Ordinal)))
        {
            string relative = NormalizeRelative(
                artifact.Path[frontendPrefix.Length..],
                "spa_build_receipt_artifact_mismatch");
            if (!frontendArtifacts.TryAdd(relative, artifact))
            {
                throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
            }
        }
        if (frontendArtifacts.Count != frontendDomain.FileCount || frontendArtifacts.Count == 0)
        {
            throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
        }

        return new ReceiptBinding(
            fullReceiptPath,
            receiptDigest,
            frontendDomain,
            frontendArtifacts);
    }

    private static void ValidateProducer(JsonElement receipt)
    {
        JsonElement producer = RequireObject(
            receipt,
            "producer",
            "spa_build_receipt_contract_invalid");
        Require(producer, "runId", errorPrefix: "spa_build_receipt_contract_invalid");
        Require(producer, "job", errorPrefix: "spa_build_receipt_contract_invalid");
        if (RequireNonNegativeInt32(
                producer,
                "runAttempt",
                "spa_build_receipt_contract_invalid") < 1)
        {
            throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
        }
    }

    private static void ValidateToolchain(JsonElement receipt)
    {
        JsonElement toolchain = RequireObject(
            receipt,
            "toolchain",
            "spa_build_receipt_contract_invalid");
        foreach (string name in s_requiredToolchain)
        {
            Require(toolchain, name, errorPrefix: "spa_build_receipt_contract_invalid");
        }
    }

    private static void ValidateInputs(JsonElement receipt)
    {
        JsonElement inputs = RequireArray(
            receipt,
            "inputDigests",
            "spa_build_receipt_contract_invalid");
        if (inputs.GetArrayLength() == 0)
        {
            throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
        }

        var paths = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement input in inputs.EnumerateArray())
        {
            if (input.ValueKind != JsonValueKind.Object)
            {
                throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
            }
            string inputPath = NormalizeRelative(
                Require(input, "path", errorPrefix: "spa_build_receipt_contract_invalid"),
                "spa_build_receipt_contract_invalid");
            if (!paths.Add(inputPath)
                || RequireNonNegativeInt32(
                    input,
                    "fileCount",
                    "spa_build_receipt_contract_invalid") < 1)
            {
                throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
            }
            RequireNonNegativeInt64(input, "size", "spa_build_receipt_contract_invalid");
            RequireDigest(input, "sha256", "spa_build_receipt_contract_invalid");
        }
    }

    private static void ValidateSeal(JsonElement receipt)
    {
        JsonElement seal = RequireObject(
            receipt,
            "seal",
            "spa_build_receipt_contract_invalid");
        Require(seal, "mode", "read-only-files", "spa_build_receipt_contract_invalid");
        if (!seal.TryGetProperty("atomicReceipt", out JsonElement atomicReceipt)
            || atomicReceipt.ValueKind is not JsonValueKind.True)
        {
            throw new SpaManifestValidationException("spa_build_receipt_contract_invalid");
        }
    }

    private static void ValidateInventory(
        string inventoryPath,
        string manifestPath,
        string releaseId,
        ReceiptBinding receipt)
    {
        using JsonDocument inventory = JsonDocument.Parse(File.ReadAllText(inventoryPath));
        Require(inventory.RootElement, "schema", "fsusblog.release-assets.v1");
        Require(inventory.RootElement, "releaseId", releaseId);
        Require(inventory.RootElement, "frontendBuildId", releaseId);
        JsonElement files = RequireArray(
            inventory.RootElement,
            "files",
            "spa_asset_inventory_invalid");
        string root = Path.GetDirectoryName(inventoryPath)!;
        string relativeManifest = Path.GetRelativePath(root, manifestPath)
            .Replace(Path.DirectorySeparatorChar, '/');
        var inventoryEntries = new Dictionary<string, InventoryAsset>(
            StringComparer.Ordinal);
        foreach (JsonElement file in files.EnumerateArray())
        {
            if (file.ValueKind != JsonValueKind.Object)
            {
                throw new SpaManifestValidationException("spa_asset_inventory_invalid");
            }
            string relative = NormalizeRelative(
                Require(file, "path", errorPrefix: "spa_asset_inventory_invalid"),
                "spa_asset_inventory_invalid");
            string digest = RequireDigest(file, "sha256", "spa_asset_inventory_invalid");
            long size = RequireNonNegativeInt64(
                file,
                "bytes",
                "spa_asset_inventory_invalid");
            if (!inventoryEntries.TryAdd(relative, new InventoryAsset(digest, size)))
            {
                throw new SpaManifestValidationException("spa_asset_inventory_invalid");
            }
        }

        HashSet<string> entries = inventoryEntries.Keys.ToHashSet(StringComparer.Ordinal);
        if (!entries.Contains("index.html") || !entries.Contains(relativeManifest))
        {
            throw new SpaManifestValidationException("spa_asset_inventory_missing_index_or_manifest");
        }

        foreach ((string entry, InventoryAsset inventoryAsset) in inventoryEntries)
        {
            string assetPath = Path.GetFullPath(Path.Combine(
                root,
                entry.Replace('/', Path.DirectorySeparatorChar)));
            RequireContained(root, assetPath, "spa_asset_inventory_path_escaped_asset_root");
            RejectSymlinkPath(root, assetPath);
            if (!File.Exists(assetPath))
            {
                throw new SpaManifestValidationException("spa_asset_inventory_file_missing");
            }
            long physicalSize = new FileInfo(assetPath).Length;
            if (physicalSize != inventoryAsset.Size
                || !string.Equals(
                    Sha256File(assetPath),
                    inventoryAsset.Sha256,
                    StringComparison.Ordinal))
            {
                throw new SpaManifestValidationException("spa_asset_inventory_file_digest_mismatch");
            }
            if (!receipt.FrontendArtifacts.TryGetValue(entry, out ReceiptArtifact? artifact)
                || !string.Equals(
                    artifact.Path,
                    receipt.FrontendDomain.Path + "/" + entry,
                    StringComparison.Ordinal)
                || artifact.Size != inventoryAsset.Size
                || !string.Equals(
                    artifact.Sha256,
                    inventoryAsset.Sha256,
                    StringComparison.Ordinal))
            {
                throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
            }
        }

        HashSet<string> materializedFiles = EnumerateMaterializedFiles(root);
        if (!materializedFiles.SetEquals(entries))
        {
            throw new SpaManifestValidationException("spa_asset_inventory_materialization_mismatch");
        }
        if (!receipt.FrontendArtifacts.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(entries))
        {
            throw new SpaManifestValidationException("spa_build_receipt_artifact_mismatch");
        }

        using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
        foreach (string assetPath in EnumerateManifestAssets(manifest.RootElement))
        {
            if (!entries.Contains(assetPath))
            {
                throw new SpaManifestValidationException("spa_manifest_asset_missing_from_inventory");
            }
        }
    }

    private static HashSet<string> EnumerateMaterializedFiles(string root)
    {
        var files = new HashSet<string>(StringComparer.Ordinal);
        Visit(root, string.Empty);
        return files;

        void Visit(string directory, string prefix)
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(directory)
                .OrderBy(static value => value, StringComparer.Ordinal))
            {
                if (IsSymlink(entry))
                {
                    throw new SpaManifestValidationException("spa_manifest_symlink_escaped_asset_root");
                }
                string name = Path.GetFileName(entry);
                string relative = string.IsNullOrEmpty(prefix) ? name : prefix + "/" + name;
                if (Directory.Exists(entry))
                {
                    Visit(entry, relative);
                }
                else if (File.Exists(entry))
                {
                    if (string.IsNullOrEmpty(prefix) && s_generatedReleaseFiles.Contains(relative))
                    {
                        continue;
                    }
                    files.Add(relative);
                }
                else
                {
                    throw new SpaManifestValidationException("spa_asset_inventory_materialization_mismatch");
                }
            }
        }
    }

    private static IEnumerable<string> EnumerateManifestAssets(JsonElement manifest)
    {
        if (manifest.ValueKind != JsonValueKind.Object)
        {
            yield break;
        }
        foreach (JsonProperty entry in manifest.EnumerateObject())
        {
            if (entry.Value.ValueKind != JsonValueKind.Object)
            {
                continue;
            }
            foreach (string propertyName in new[] { "file", "css", "assets" })
            {
                if (!entry.Value.TryGetProperty(propertyName, out JsonElement value))
                {
                    continue;
                }
                if (value.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(value.GetString()))
                {
                    yield return NormalizeManifestAssetReference(value.GetString()!);
                }
                else if (value.ValueKind == JsonValueKind.Array)
                {
                    foreach (JsonElement item in value.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String
                            && !string.IsNullOrWhiteSpace(item.GetString()))
                        {
                            yield return NormalizeManifestAssetReference(item.GetString()!);
                        }
                    }
                }
            }
        }
    }

    private static string NormalizeManifestAssetReference(string value)
    {
        string relative = NormalizeRelative(value, "spa_manifest_asset_path_invalid");
        if (!relative.StartsWith("assets/", StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException("spa_manifest_asset_path_invalid");
        }

        return relative;
    }

    private static string NormalizeRelative(string value, string error)
    {
        if (string.IsNullOrWhiteSpace(value)
            || Path.IsPathRooted(value)
            || value.Contains('\\')
            || value.Split('/').Any(static segment => string.IsNullOrEmpty(segment) || segment is "." or ".."))
        {
            throw new SpaManifestValidationException(error);
        }
        return value;
    }

    private static bool IsInDomain(string artifactPath, string domainPath)
        => string.Equals(artifactPath, domainPath, StringComparison.Ordinal)
            || artifactPath.StartsWith(domainPath + "/", StringComparison.Ordinal);

    private static string Require(
        JsonElement root,
        string name,
        string? expected = null,
        string? errorPrefix = null)
    {
        string value = root.TryGetProperty(name, out JsonElement element)
            && element.ValueKind == JsonValueKind.String
            ? element.GetString() ?? string.Empty
            : string.Empty;
        if (string.IsNullOrWhiteSpace(value)
            || (expected is not null
                && !string.Equals(value, expected, StringComparison.Ordinal)))
        {
            throw new SpaManifestValidationException(
                errorPrefix ?? "spa_manifest_descriptor_field_invalid");
        }
        return value;
    }

    private static string RequireDigest(
        JsonElement root,
        string name,
        string? errorPrefix = null)
    {
        string value = Require(root, name, errorPrefix: errorPrefix);
        if (!Regex.IsMatch(
                value,
                "^sha256:[a-f0-9]{64}$",
                RegexOptions.CultureInvariant))
        {
            throw new SpaManifestValidationException(
                errorPrefix ?? "spa_manifest_descriptor_field_invalid");
        }
        return value;
    }

    private static string RequireFingerprint(
        JsonElement root,
        string name,
        string? errorPrefix = null)
    {
        string value = Require(root, name, errorPrefix: errorPrefix);
        if (!Regex.IsMatch(
                value,
                "^(?:sha256:)?[a-f0-9]{64}$",
                RegexOptions.CultureInvariant))
        {
            throw new SpaManifestValidationException(
                errorPrefix ?? "spa_manifest_descriptor_field_invalid");
        }
        return value;
    }

    private static int RequireNonNegativeInt32(
        JsonElement root,
        string name,
        string error)
    {
        if (!root.TryGetProperty(name, out JsonElement value)
            || !value.TryGetInt32(out int result)
            || result < 0)
        {
            throw new SpaManifestValidationException(error);
        }
        return result;
    }

    private static long RequireNonNegativeInt64(
        JsonElement root,
        string name,
        string error)
    {
        if (!root.TryGetProperty(name, out JsonElement value)
            || !value.TryGetInt64(out long result)
            || result < 0)
        {
            throw new SpaManifestValidationException(error);
        }
        return result;
    }

    private static JsonElement RequireObject(JsonElement root, string name, string error)
    {
        if (!root.TryGetProperty(name, out JsonElement value)
            || value.ValueKind != JsonValueKind.Object)
        {
            throw new SpaManifestValidationException(error);
        }
        return value;
    }

    private static JsonElement RequireArray(JsonElement root, string name, string error)
    {
        if (!root.TryGetProperty(name, out JsonElement value)
            || value.ValueKind != JsonValueKind.Array)
        {
            throw new SpaManifestValidationException(error);
        }
        return value;
    }

    private static void RequireExactKeys(
        JsonElement root,
        FrozenSet<string> expected,
        string error)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new SpaManifestValidationException(error);
        }
        string[] actual = root.EnumerateObject()
            .Select(static property => property.Name)
            .ToArray();
        if (actual.Length != expected.Count
            || actual.Distinct(StringComparer.Ordinal).Count() != expected.Count
            || actual.Any(name => !expected.Contains(name)))
        {
            throw new SpaManifestValidationException(error);
        }
    }

    private static string ComputeContentDigest(JsonElement value)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        }))
        {
            WriteCanonicalJson(writer, value, omitContentDigest: true);
        }
        return "sha256:"
            + Convert.ToHexStringLower(SHA256.HashData(buffer.ToArray()));
    }

    private static void WriteCanonicalJson(
        Utf8JsonWriter writer,
        JsonElement value,
        bool omitContentDigest)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (JsonProperty property in value.EnumerateObject()
                    .Where(property => !omitContentDigest
                        || !string.Equals(
                            property.Name,
                            "contentDigest",
                            StringComparison.Ordinal))
                    .OrderBy(static property => property.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonicalJson(writer, property.Value, omitContentDigest: false);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement item in value.EnumerateArray())
                {
                    WriteCanonicalJson(writer, item, omitContentDigest: false);
                }
                writer.WriteEndArray();
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }

    private static void RequireContained(string root, string target, string error)
    {
        string prefix = Path.EndsInDirectorySeparator(root)
            ? root
            : root + Path.DirectorySeparatorChar;
        if (!target.StartsWith(
                prefix,
                OperatingSystem.IsWindows()
                    ? StringComparison.OrdinalIgnoreCase
                    : StringComparison.Ordinal))
        {
            throw new SpaManifestValidationException(error);
        }
    }

    private static bool PathEquals(string left, string right)
        => string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
            OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal);

    private static string ResolveRealPath(string path)
    {
        string fullPath = Path.GetFullPath(path);
        string root = Path.GetPathRoot(fullPath)
            ?? throw new SpaManifestValidationException(
                "spa_manifest_asset_root_authority_mismatch");
        string current = root;
        foreach (string segment in fullPath[root.Length..].Split(
            Path.DirectorySeparatorChar,
            StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            FileSystemInfo info = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            if (info.LinkTarget is not null)
            {
                current = info.ResolveLinkTarget(returnFinalTarget: true)?.FullName
                    ?? throw new SpaManifestValidationException(
                        "spa_manifest_asset_root_authority_mismatch");
            }
        }
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(current));
    }

    private static void RejectSymlinkPath(string root, string target)
    {
        for (string? current = target;
            current is not null && !PathEquals(current, root);
            current = Path.GetDirectoryName(current))
        {
            if (IsSymlink(current))
            {
                throw new SpaManifestValidationException(
                    "spa_manifest_symlink_escaped_asset_root");
            }
        }
        if (IsSymlink(root))
        {
            throw new SpaManifestValidationException(
                "spa_manifest_asset_root_symlink");
        }
    }

    private static bool IsSymlink(string path)
        => (File.Exists(path) || Directory.Exists(path))
            && File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint);

    private static string Sha256File(string path)
        => "sha256:"
            + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));

    private sealed record ReceiptDomain(
        string Name,
        string Path,
        string ConsumerMode,
        int FileCount);

    private sealed record ReceiptArtifact(string Path, long Size, string Sha256);

    private sealed record InventoryAsset(string Sha256, long Size);

    private sealed record ReceiptBinding(
        string ReceiptPath,
        string ReceiptDigest,
        ReceiptDomain FrontendDomain,
        IReadOnlyDictionary<string, ReceiptArtifact> FrontendArtifacts);
}

internal sealed class SpaManifestValidationException(string code)
    : InvalidOperationException(code)
{
    public string Code { get; } = code;
}
