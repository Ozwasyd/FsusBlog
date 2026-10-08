using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Holds one root admitted by the existing Linux native verifier. Subsequent path inspection accepts
/// only root-relative projections; the scope performs no watching, source reads or materialization.
/// </summary>
public sealed class LinuxVaultRootPathScope
{
    private readonly LinuxVaultRootVerifier.VerifiedLinuxVaultRoot _root;

    private LinuxVaultRootPathScope(
        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root,
        string agentIdentity)
    {
        _root = root;
        Scope = new VaultPathStructuralScope(
            root.Manifest.SiteIdentity,
            root.Manifest.VaultIdentity,
            root.Manifest.DeviceIdentity,
            agentIdentity,
            root.RootIdentity,
            root.Manifest.ContentSha256,
            VaultPathComparisonPolicy.Ordinal);
    }

    /// <summary>Describes the binding; this serialized value cannot recreate the native scope.</summary>
    public VaultPathStructuralScope Scope
    {
        get;
    }

    /// <summary>
    /// Registers one explicitly chosen root using the sole existing Linux verifier. No factory
    /// accepts caller-verified facts or a digest in place of actual native admission.
    /// </summary>
    public static LinuxVaultRootPathScope Open(
        string rootPath,
        ArticleVaultRootManifest rootManifest,
        string agentIdentity)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("Article Vault root path inspection requires Linux.");
        }

        // Snapshot the manifest so later caller mutations cannot alter the admitted inventory.
        ArticleVaultRootManifest snapshot = ArticleVaultManifestCodec.DeserializeRoot(
            ArticleVaultManifestCodec.Serialize(rootManifest));
        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root = LinuxVaultRootVerifier.Verify(new(
            rootPath,
            snapshot,
            agentIdentity,
            new LinuxVaultWatcherOptions()));
        if (!root.Filesystem.CaseSensitive || root.Filesystem.UnicodeNormalization != "none")
        {
            throw new LinuxVaultWatcherException("linux_vault_path_semantics_unsupported");
        }

        return new LinuxVaultRootPathScope(root, agentIdentity);
    }

    /// <summary>
    /// Rechecks native root/path facts before returning structural classification. The result is an
    /// observation, not persistent authorization: future content access must revalidate at its own
    /// native use boundary, and the structural result always requires independent native admission.
    /// </summary>
    public VaultPathStructuralAnalysis AnalyzeProjection(
        string relativePath,
        IReadOnlyList<string> observedRelativePaths)
    {
        LinuxVaultRootVerifier.PathVerification rootVerification = LinuxVaultRootVerifier.VerifyWatchedRoot(_root);
        if (rootVerification.Disposition == LinuxVaultPathDisposition.Blocked)
        {
            throw new LinuxVaultWatcherException(
                rootVerification.ErrorCode ?? "linux_vault_root_path_blocked");
        }

        VaultPathStructuralAnalysis analysis = ArticleVaultPathStructureValidator.Analyze(
            _root.Manifest, Scope, relativePath, observedRelativePaths);
        if (analysis.Classification == VaultPathStructuralClass.Blocked)
        {
            return analysis;
        }

        foreach (string path in analysis.ObservedRelativePaths.Append(relativePath).Distinct(StringComparer.Ordinal))
        {
            LinuxVaultRootVerifier.PathVerification pathVerification = LinuxVaultRootVerifier.VerifyRelativePath(_root, path);
            if (pathVerification.Disposition == LinuxVaultPathDisposition.Blocked)
            {
                throw new LinuxVaultWatcherException(
                    pathVerification.ErrorCode ?? "linux_vault_path_blocked");
            }
        }

        return analysis;
    }
}
