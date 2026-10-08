using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Analyzes portable path structure and sealed manifest bindings without accessing the filesystem.
/// Native root/parent/link/mount/permission validation remains mandatory at the platform boundary.
/// </summary>
public static class ArticleVaultPathStructureValidator
{
    public const string Schema = "fsusblog.article-vault.path-structure.v1";
    public const int Version = 1;
    public const int MaxObservedPaths = 4096;
    public const string SourceRule = "vault-path.manifest-source.v1";
    public const string ControlRule = "vault-path.manifest-control.v1";
    public const string UnknownRule = "vault-path.unknown-artifact.v1";

    private static readonly string[] s_reservedNames =
    [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "COM\u00b9", "COM\u00b2", "COM\u00b3", "LPT\u00b9", "LPT\u00b2", "LPT\u00b3"
    ];

    /// <summary>
    /// Seals the finite classification rules. Unknown editor temp/backup/lock shapes remain blocked;
    /// there is no prefix/suffix ignore rule or cleanup permission.
    /// </summary>
    public static string RuleRegistrySha256
    {
        get;
    } = Hash(string.Join('\n',
        SourceRule,
        ControlRule,
        UnknownRule,
        ArticleVaultSchemas.RootManifestPath,
        ArticleVaultSchemas.ArticleManifestDirectory,
        ArticleVaultSchemas.ReceiptDirectory));

    /// <summary>Checks one portable relative projection; it never resolves or rewrites a native path.</summary>
    public static ArticleVaultValidationResult ValidateRelativePath(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath)
            || relativePath.Length > 1024
            || relativePath.IndexOfAny(['\\', ':', '%', '<', '>', '"', '|', '?', '*']) >= 0
            || relativePath.Any(static character => char.IsControl(character)))
        {
            return ArticleVaultValidationResult.Invalid("vault_path_structure_invalid");
        }

        // Reject invalid UTF-16 rather than letting normalization replace or reinterpret it.
        try
        {
            _ = relativePath.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            return ArticleVaultValidationResult.Invalid("vault_path_unicode_invalid");
        }

        foreach (string segment in relativePath.Split('/'))
        {
            if (segment.Length is 0 or > 255
                || segment is "." or ".."
                || segment.EndsWith(' ')
                || segment.EndsWith('.'))
            {
                return ArticleVaultValidationResult.Invalid("vault_path_segment_invalid");
            }

            string stem = segment.Split('.')[0];
            if (s_reservedNames.Contains(stem, StringComparer.OrdinalIgnoreCase))
            {
                return ArticleVaultValidationResult.Invalid("vault_path_reserved_name");
            }
        }

        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>
    /// Classifies an exact manifest-bound path using a bounded inventory of spellings. Inputs are
    /// structural observations only; this method performs no I/O and cannot establish realpath safety.
    /// </summary>
    public static VaultPathStructuralAnalysis Analyze(
        ArticleVaultRootManifest root,
        VaultPathStructuralScope scope,
        string relativePath,
        IReadOnlyList<string> observedRelativePaths)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(relativePath);
        ArgumentNullException.ThrowIfNull(observedRelativePaths);

        ArticleVaultValidationResult binding = ValidateScope(root, scope);
        if (!binding.IsValid)
        {
            throw new InvalidDataException(binding.ReasonCode);
        }

        if (observedRelativePaths.Count > MaxObservedPaths)
        {
            throw new InvalidDataException("vault_path_inventory_bound_exceeded");
        }

        ArticleVaultValidationResult path = ValidateRelativePath(relativePath);
        if (!path.IsValid)
        {
            throw new InvalidDataException(path.ReasonCode);
        }

        foreach (string observed in observedRelativePaths)
        {
            ArticleVaultValidationResult observedValidation = ValidateRelativePath(observed);
            if (!observedValidation.IsValid)
            {
                throw new InvalidDataException(observedValidation.ReasonCode);
            }
        }

        string[] observations = observedRelativePaths
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] inventory = observations
            .Concat(root.Articles.Select(static article => article.RelativePath))
            .Concat(ControlPaths(root))
            .Append(relativePath)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();

        if (inventory.Length > MaxObservedPaths)
        {
            throw new InvalidDataException("vault_path_inventory_bound_exceeded");
        }

        foreach (string candidate in inventory)
        {
            ArticleVaultValidationResult candidateValidation = ValidateRelativePath(candidate);
            if (!candidateValidation.IsValid)
            {
                throw new InvalidDataException(candidateValidation.ReasonCode);
            }
        }

        VaultPathCollision[] collisions = FindCollisions(inventory, scope.ComparisonPolicy);
        VaultPathCollision[] duplicateProjections = root.Articles
            .GroupBy(static article => article.RelativePath, StringComparer.Ordinal)
            .Where(static group => group.Count() > 1)
            .Select(static group => new VaultPathCollision(
                "vault_path_duplicate_projection",
                group.Select(static article => article.RelativePath).ToArray()))
            .ToArray();
        VaultPathCollision[] fileAncestorCollisions = FindFileAncestorCollisions(root, inventory, scope.ComparisonPolicy);
        collisions = collisions.Concat(duplicateProjections).Concat(fileAncestorCollisions)
            .OrderBy(static collision => collision.RelativePaths[0], StringComparer.Ordinal)
            .ToArray();
        string? reasonCode = collisions.Length == 0 ? null : "vault_path_projection_collision";
        bool controlAlias = inventory.Select(static item => item.Split('/')[0]).Any(
            static segment => string.Equals(segment, ".fsus", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(segment, ".fsus", StringComparison.Ordinal));
        if (controlAlias)
        {
            reasonCode = "vault_path_control_alias";
        }

        bool control = ControlPaths(root).Contains(relativePath, StringComparer.Ordinal);
        VaultArticleReference? article = root.Articles.FirstOrDefault(
            item => string.Equals(item.RelativePath, relativePath, StringComparison.Ordinal));
        string rule = control ? ControlRule : article is not null ? SourceRule : UnknownRule;
        if (reasonCode is null && !control && article is null)
        {
            reasonCode = "vault_path_unknown_artifact";
        }

        VaultPathStructuralClass classification = reasonCode is not null
            ? VaultPathStructuralClass.Blocked
            : control ? VaultPathStructuralClass.RegisteredControlPath
            : VaultPathStructuralClass.ManifestSourceProjection;
        var analysis = new VaultPathStructuralAnalysis(
            Schema,
            Version,
            scope,
            relativePath,
            classification,
            rule,
            RuleRegistrySha256,
            classification == VaultPathStructuralClass.ManifestSourceProjection
                ? article?.PortableArticleIdentity : null,
            reasonCode,
            observations,
            collisions,
            string.Empty);
        return analysis with
        {
            ContentSha256 = ComputeContentSha256(analysis)
        };
    }

    /// <summary>Rejects cross-scope, unknown comparison and stale manifest inputs.</summary>
    public static ArticleVaultValidationResult ValidateScope(
        ArticleVaultRootManifest root,
        VaultPathStructuralScope scope)
    {
        if (scope is null
            || root is null
            || root.Articles?.Any(static item => item is null) == true
            || root.OperationReceipts?.Any(static item => item is null) == true)
        {
            return ArticleVaultValidationResult.Invalid("vault_path_scope_invalid");
        }

        ArticleVaultValidationResult manifest = ArticleVaultManifestValidator.Validate(root);
        if (!manifest.IsValid)
        {
            return manifest;
        }

        if (!Enum.IsDefined(scope.ComparisonPolicy)
            || !ArticleVaultManifestValidator.IsIdentity(scope.AgentIdentity)
            || !ArticleVaultManifestValidator.IsSha256(scope.RootIdentitySha256)
            || !string.Equals(scope.SiteIdentity, root.SiteIdentity, StringComparison.Ordinal)
            || !string.Equals(scope.VaultIdentity, root.VaultIdentity, StringComparison.Ordinal)
            || !string.Equals(scope.DeviceIdentity, root.DeviceIdentity, StringComparison.Ordinal)
            || !string.Equals(scope.RootManifestSha256, root.ContentSha256, StringComparison.Ordinal))
        {
            return ArticleVaultValidationResult.Invalid("vault_path_scope_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>
    /// Independently recomputes structural rules and digests; even a valid result grants no native
    /// admission. Expected scope and observations must come from the consumer's own bound context,
    /// not from the supplied analysis itself.
    /// </summary>
    public static ArticleVaultValidationResult Verify(
        ArticleVaultRootManifest root,
        VaultPathStructuralScope expectedScope,
        string expectedRelativePath,
        IReadOnlyList<string> expectedObservedRelativePaths,
        VaultPathStructuralAnalysis? analysis)
    {
        if (analysis is null
            || analysis.Schema != Schema
            || analysis.SchemaVersion != Version
            || analysis.Scope != expectedScope
            || !string.Equals(analysis.RelativePath, expectedRelativePath, StringComparison.Ordinal)
            || analysis.RuleRegistrySha256 != RuleRegistrySha256
            || !Enum.IsDefined(analysis.Classification)
            || analysis.RelativePath is null
            || analysis.ObservedRelativePaths is null
            || analysis.Collisions is null
            || analysis.Collisions.Any(static collision => collision is null
                || collision.RelativePaths is null
                || collision.RelativePaths.Any(static path => path is null)))
        {
            return ArticleVaultValidationResult.Invalid("vault_path_analysis_invalid");
        }

        try
        {
            VaultPathStructuralAnalysis expected = Analyze(
                root, expectedScope, expectedRelativePath, expectedObservedRelativePaths);
            if (!ArticleVaultManifestValidator.IsSha256(analysis.ContentSha256)
                || analysis.ContentSha256 != ComputeContentSha256(analysis)
                || analysis.ContentSha256 != expected.ContentSha256)
            {
                return ArticleVaultValidationResult.Invalid("vault_path_analysis_digest_mismatch");
            }
        }
        catch (InvalidDataException)
        {
            return ArticleVaultValidationResult.Invalid("vault_path_analysis_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>Content-addresses structural data only, excluding the digest slot itself.</summary>
    public static string ComputeContentSha256(VaultPathStructuralAnalysis analysis)
        => Convert.ToHexStringLower(SHA256.HashData(ArticleVaultManifestCodec.SerializeCanonical(
            analysis with
            {
                ContentSha256 = string.Empty
            })));

    private static IEnumerable<string> ControlPaths(ArticleVaultRootManifest root)
        => new[]
        {
            root.ControlTree.RootManifestPath,
            root.ControlTree.ArticleManifestDirectory,
            root.ControlTree.ReceiptDirectory
        }
        .Concat(root.Articles.Select(static article => article.ManifestPath))
        .Concat(root.OperationReceipts.Select(static receipt => receipt.ReceiptPath));

    private static VaultPathCollision[] FindCollisions(
        string[] inventory,
        VaultPathComparisonPolicy comparisonPolicy)
    {
        bool unicode = comparisonPolicy is VaultPathComparisonPolicy.CanonicalUnicode
            or VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase;
        bool ignoreCase = comparisonPolicy is VaultPathComparisonPolicy.OrdinalIgnoreCase
            or VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase;
        StringComparer comparer = ignoreCase ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        var prefixes = new HashSet<string>(StringComparer.Ordinal);
        foreach (string prefix in inventory.SelectMany(static path => Prefixes(path)))
        {
            prefixes.Add(prefix);
            if (prefixes.Count > MaxObservedPaths)
            {
                throw new InvalidDataException("vault_path_inventory_bound_exceeded");
            }
        }

        return prefixes
            .GroupBy(path => unicode ? path.Normalize(NormalizationForm.FormC) : path, comparer)
            .Where(static group => group.Count() > 1)
            .Select(group => new VaultPathCollision(
                unicode && group.Select(static path => path.Normalize(NormalizationForm.FormC))
                    .Distinct(StringComparer.Ordinal).Count() < group.Count()
                    ? "vault_path_unicode_collision" : "vault_path_case_collision",
                group.Order(StringComparer.Ordinal).ToArray()))
            .OrderBy(static collision => collision.RelativePaths[0], StringComparer.Ordinal)
            .ToArray();
    }

    private static IEnumerable<string> Prefixes(string relativePath)
    {
        string[] segments = relativePath.Split('/');
        for (int count = 1; count <= segments.Length; count++)
        {
            yield return string.Join('/', segments.Take(count));
        }
    }

    private static VaultPathCollision[] FindFileAncestorCollisions(
        ArticleVaultRootManifest root,
        string[] inventory,
        VaultPathComparisonPolicy comparisonPolicy)
    {
        bool unicode = comparisonPolicy is VaultPathComparisonPolicy.CanonicalUnicode
            or VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase;
        StringComparer comparer = comparisonPolicy is VaultPathComparisonPolicy.OrdinalIgnoreCase
            or VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase
            ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        string[] files = root.Articles.Select(static article => article.RelativePath)
            .Concat(root.Articles.Select(static article => article.ManifestPath))
            .Concat(root.OperationReceipts.Select(static receipt => receipt.ReceiptPath))
            .Append(root.ControlTree.RootManifestPath)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var filesByComparisonPath = new Dictionary<string, List<string>>(comparer);
        foreach (string file in files)
        {
            string comparisonFile = unicode ? file.Normalize(NormalizationForm.FormC) : file;
            if (!filesByComparisonPath.TryGetValue(comparisonFile, out List<string>? spellings))
            {
                spellings = [];
                filesByComparisonPath.Add(comparisonFile, spellings);
            }

            spellings.Add(file);
        }

        var collisions = new List<VaultPathCollision>();
        foreach (string candidate in inventory)
        {
            foreach (string prefix in Prefixes(candidate).SkipLast(1))
            {
                string comparisonPrefix = unicode ? prefix.Normalize(NormalizationForm.FormC) : prefix;
                if (filesByComparisonPath.TryGetValue(comparisonPrefix, out List<string>? spellings))
                {
                    foreach (string file in spellings)
                    {
                        collisions.Add(new VaultPathCollision(
                            "vault_path_file_ancestor_collision",
                            new[] { file, candidate }.Order(StringComparer.Ordinal).ToArray()));
                        if (collisions.Count > MaxObservedPaths)
                        {
                            throw new InvalidDataException("vault_path_inventory_bound_exceeded");
                        }
                    }
                }
            }
        }

        return collisions.ToArray();
    }

    private static string Hash(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
