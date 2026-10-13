using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.MacOS;

// Private native boundary for the sole macOS observer, not a second portable root authority.
internal sealed class MacVaultRootPathScope : IDisposable
{
    private const int MaxControlManifestBytes = 1024 * 1024;
    private readonly ArticleVaultRootManifest _manifest;
    private readonly VaultPathStructuralScope _structuralScope;

    private MacVaultRootPathScope(
        MacVaultNativeHandle handle, string rootPath, ArticleVaultRootManifest manifest, MacVaultWatchIdentity identity)
    {
        Handle = handle;
        RootPath = rootPath;
        _manifest = manifest;
        Identity = identity;
        _structuralScope = new VaultPathStructuralScope(
            identity.SiteIdentity, identity.VaultIdentity, identity.DeviceIdentity, identity.AgentIdentity,
            identity.RootIdentitySha256, identity.RootManifestSha256,
            identity.Filesystem.CaseSensitive ? VaultPathComparisonPolicy.CanonicalUnicode
                : VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase);
    }

    internal MacVaultNativeHandle Handle
    {
        get;
    }
    internal string RootPath
    {
        get;
    }
    internal MacVaultWatchIdentity Identity
    {
        get;
    }

    internal static MacVaultRootPathScope Open(MacVaultWatchRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Options);
        request.Options.Validate();
        if (!OperatingSystem.IsMacOS())
        {
            throw new MacVaultWatcherException("mac_vault_platform_required");
        }

        if (!ArticleVaultManifestValidator.Validate(request.RootManifest).IsValid
            || !MacVaultRawFactCodec.IsIdentity(request.AgentIdentity)
            || string.IsNullOrWhiteSpace(request.RootPath)
            || !Path.IsPathFullyQualified(request.RootPath)
            || request.RootPath != Path.GetFullPath(request.RootPath)
            || request.RootPath.Length > 1024)
        {
            throw new MacVaultWatcherException("mac_vault_request_invalid");
        }

        nint native = FSEventsNative.Open(request.RootPath, out ulong fileId, out uint device, out int caseSensitive, out int error);
        if (native == 0)
        {
            throw new MacVaultWatcherException(FSEventsNative.Reason(error));
        }

        var handle = new MacVaultNativeHandle(native);
        try
        {
            byte[] volume = new byte[37];
            FSEventsNative.Volume(handle, volume);
            string volumeIdentity = Encoding.ASCII.GetString(volume.AsSpan(0, 36));
            var filesystem = new MacVaultFilesystemSemantics("apfs", volumeIdentity, caseSensitive == 1,
                "canonical-equivalence", device, fileId);
            string rootDigest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n',
                request.RootManifest.SiteIdentity, request.RootManifest.VaultIdentity, request.RootManifest.DeviceIdentity,
                request.AgentIdentity, request.RootManifest.ContentSha256, request.RootPath, volumeIdentity,
                fileId.ToString(System.Globalization.CultureInfo.InvariantCulture)))));
            var identity = new MacVaultWatchIdentity(
                request.RootManifest.SiteIdentity, request.RootManifest.VaultIdentity, request.RootManifest.DeviceIdentity,
                request.AgentIdentity, rootDigest, request.RootManifest.ContentSha256, Guid.NewGuid().ToString("N"), filesystem);
            var scope = new MacVaultRootPathScope(handle, request.RootPath, request.RootManifest, identity);
            scope.VerifyControlManifest();
            // Seals collisions in the manifest and exact control tree before creating the stream.
            VaultPathStructuralAnalysis initial = ArticleVaultPathStructureValidator.Analyze(
                request.RootManifest, scope._structuralScope, ArticleVaultSchemas.RootManifestPath, []);
            if (initial.Classification != VaultPathStructuralClass.RegisteredControlPath)
            {
                throw new MacVaultWatcherException("mac_vault_projection_collision");
            }

            return scope;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    internal void VerifyControlManifest()
    {
        byte[] buffer = new byte[MaxControlManifestBytes];
        int error = FSEventsNative.ReadManifest(Handle, buffer, buffer.Length, out int length);
        if (error != 0)
        {
            throw new MacVaultWatcherException(FSEventsNative.Reason(error));
        }

        ArticleVaultRootManifest manifest;
        try
        {
            manifest = ArticleVaultManifestCodec.DeserializeRoot(buffer.AsSpan(0, length));
        }
        catch (InvalidDataException)
        {
            throw new MacVaultWatcherException("mac_vault_control_manifest_invalid");
        }

        if (manifest.ContentSha256 != _manifest.ContentSha256
            || manifest.SiteIdentity != _manifest.SiteIdentity
            || manifest.VaultIdentity != _manifest.VaultIdentity
            || manifest.DeviceIdentity != _manifest.DeviceIdentity)
        {
            throw new MacVaultWatcherException("mac_vault_control_manifest_drift");
        }
    }

    internal (MacVaultPathDisposition Disposition, ulong? FileId) Inspect(string relativePath)
    {
        VerifyControlManifest();
        if (relativePath.Length == 0)
        {
            return (MacVaultPathDisposition.ControlTree, null);
        }

        if (!ArticleVaultPathStructureValidator.ValidateRelativePath(relativePath).IsValid)
        {
            throw new MacVaultWatcherException("mac_vault_path_blocked");
        }

        int error = FSEventsNative.Inspect(Handle, relativePath, out ulong fileId, out int missing);
        if (error != 0)
        {
            throw new MacVaultWatcherException(FSEventsNative.Reason(error));
        }

        VaultPathStructuralAnalysis structural = ArticleVaultPathStructureValidator.Analyze(
            _manifest, _structuralScope, relativePath, [relativePath]);
        if (structural.Classification == VaultPathStructuralClass.Blocked)
        {
            throw new MacVaultWatcherException("mac_vault_unclassified_or_collision");
        }

        return (structural.Classification == VaultPathStructuralClass.RegisteredControlPath
            ? MacVaultPathDisposition.ControlTree
            : missing != 0 ? MacVaultPathDisposition.MissingEntry
            : MacVaultPathDisposition.SourceProjection, missing != 0 ? null : fileId);
    }

    public void Dispose() => Handle.Dispose();
}
