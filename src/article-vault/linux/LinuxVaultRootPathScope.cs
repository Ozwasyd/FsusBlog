using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Holds one root admitted by the existing Linux native verifier. Subsequent path inspection accepts
/// only root-relative projections. Operation preparation compares expected-old bytes at its native
/// use boundary; stable snapshot production, watching and source replacement have separate owners.
/// </summary>
public sealed partial class LinuxVaultRootPathScope : IDisposable
{
    private const int MaximumIssuedDescriptors = 64;
    private readonly LinuxVaultRootVerifier.VerifiedLinuxVaultRoot _root;
    private readonly SafeFileHandle _rootDescriptor;
    private readonly LinuxVaultPathNative.DescriptorIdentity _rootDescriptorIdentity;
    private readonly object _gate = new();
    private readonly Dictionary<SafeFileHandle, IssuedDescriptor> _issued = new(ReferenceEqualityComparer.Instance);
    private bool _disposed;

    private LinuxVaultRootPathScope(
        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root,
        string agentIdentity,
        SafeFileHandle rootDescriptor)
    {
        _root = root;
        _rootDescriptor = rootDescriptor;
        _rootDescriptorIdentity = LinuxVaultPathNative.Identify(rootDescriptor);
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
        var request = new LinuxVaultWatchRequest(rootPath, snapshot, agentIdentity, new LinuxVaultWatcherOptions());
        SafeFileHandle descriptor;
        try
        {
            // Capture before the path-based verifier runs, then compare the actual root object.
            descriptor = LinuxVaultPathNative.OpenRoot(rootPath);
        }
        catch (LinuxVaultWatcherException)
        {
            // Preserve the canonical verifier's original rejection (including root symlinks).
            // A successful verifier cannot override failure to acquire the descriptor.
            LinuxVaultRootVerifier.Verify(request);
            throw;
        }

        try
        {
            LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root = LinuxVaultRootVerifier.Verify(request);
            if (!root.Filesystem.CaseSensitive || root.Filesystem.UnicodeNormalization != "none")
            {
                throw new LinuxVaultWatcherException("linux_vault_path_semantics_unsupported");
            }

            var scope = new LinuxVaultRootPathScope(root, agentIdentity, descriptor);
            scope.RevalidateRoot();
            return scope;
        }
        catch
        {
            descriptor.Dispose();
            throw;
        }
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
        lock (_gate)
        {
            ThrowIfDisposed();
            RevalidateRoot();
            VaultPathStructuralAnalysis analysis = ArticleVaultPathStructureValidator.Analyze(
                _root.Manifest, Scope, relativePath, observedRelativePaths);
            if (analysis.Classification == VaultPathStructuralClass.Blocked)
            {
                return analysis;
            }

            foreach (string path in analysis.ObservedRelativePaths.Append(relativePath).Distinct(StringComparer.Ordinal))
            {
                VerifyPath(path);
                VerifyDirectorySemantics(path);
            }

            return analysis;
        }
    }

    /// <summary>
    /// Opens an existing manifest source projection read-only, without reading its body. The handle
    /// belongs to this scope and does not grant stable-content, writer-lease or materialization
    /// admission. Consumers must revalidate it at their own native use boundary. At most 64 live
    /// source/parent descriptors may be issued per scope; callers may close handles early.
    /// </summary>
    public SafeFileHandle OpenSourceFile(string relativePath)
        => OpenIssued(relativePath, directory: false);

    /// <summary>
    /// Opens only the parent of a manifest source leaf. It accepts neither an arbitrary parent nor
    /// a control path, and grants no creation, replacement or atomic-writer authority. Future writers
    /// must implement root-anchored resolution and validation at each native operation themselves.
    /// </summary>
    public SafeFileHandle OpenOwnedParent(string sourceRelativePath)
        => OpenIssued(sourceRelativePath, directory: true);

    /// <summary>
    /// Opens the registered source parent read-only for metadata operations. Unlike the O_PATH
    /// parent, this descriptor can service directory metadata/flush syscalls. It grants no mutation
    /// admission, and actual flushing and its error handling remain the operation owner's work.
    /// </summary>
    public SafeFileHandle OpenOwnedParentMetadata(string sourceRelativePath)
        => OpenIssued(sourceRelativePath, directory: true, directoryMetadata: true);

    /// <summary>
    /// Reopens the issued relative path beneath the held root and compares both actual descriptor
    /// identities. Moving an issued parent out of the root invalidates this observation. An external
    /// rename after this check remains possible; this method is not an atomic check-and-write API.
    /// Caller-created, closed, foreign-scope or reused descriptors cannot become admitted handles.
    /// </summary>
    public void RevalidateForUse(SafeFileHandle issuedDescriptor)
    {
        ArgumentNullException.ThrowIfNull(issuedDescriptor);
        lock (_gate)
        {
            ThrowIfDisposed();
            if (!_issued.TryGetValue(issuedDescriptor, out IssuedDescriptor? issued)
                || issuedDescriptor.IsClosed || issuedDescriptor.IsInvalid)
            {
                throw new LinuxVaultWatcherException("linux_vault_descriptor_not_issued_or_closed");
            }

            RevalidateRoot();
            VerifyIssuedPath(issued);
            using SafeFileHandle current = LinuxVaultPathNative.OpenRelative(
                _rootDescriptor, issued.DescriptorRelativePath, issued.Directory);
            if (!issued.Identity.SameObject(LinuxVaultPathNative.Identify(issuedDescriptor))
                || !issued.Identity.SameObject(LinuxVaultPathNative.Identify(current)))
            {
                throw new LinuxVaultWatcherException("linux_vault_descriptor_path_identity_changed");
            }

            RevalidateRoot();
            VerifyIssuedPath(issued);
        }
    }

    /// <summary>Closes this scope's root and every issued descriptor. Repeated disposal is safe.</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            foreach (SafeFileHandle descriptor in _issued.Keys)
            {
                descriptor.Dispose();
            }

            _issued.Clear();
            _rootDescriptor.Dispose();
        }
    }

    private SafeFileHandle OpenIssued(string relativePath, bool directory, bool directoryMetadata = false)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            VaultPathStructuralAnalysis analysis = ArticleVaultPathStructureValidator.Analyze(
                _root.Manifest, Scope, relativePath, []);
            if (analysis.Classification != VaultPathStructuralClass.ManifestSourceProjection)
            {
                throw new LinuxVaultWatcherException("linux_vault_descriptor_source_not_registered");
            }

            RevalidateRoot();
            VerifyPath(relativePath);
            VerifyDirectorySemantics(relativePath);
            foreach (SafeFileHandle closed in _issued.Keys.Where(static handle => handle.IsClosed).ToArray())
            {
                _issued.Remove(closed);
            }

            if (_issued.Count >= MaximumIssuedDescriptors)
            {
                throw new LinuxVaultWatcherException("linux_vault_descriptor_limit_exceeded");
            }

            int separator = relativePath.LastIndexOf('/');
            string descriptorPath = directory
                ? separator < 0 ? "." : relativePath[..separator]
                : relativePath;
            SafeFileHandle descriptor = LinuxVaultPathNative.OpenRelative(_rootDescriptor, descriptorPath, directory,
                directoryMetadataProbe: directoryMetadata);
            try
            {
                var issued = new IssuedDescriptor(relativePath, descriptorPath, directory,
                    LinuxVaultPathNative.Identify(descriptor));
                _issued.Add(descriptor, issued);
                RevalidateForUse(descriptor);
                return descriptor;
            }
            catch
            {
                _issued.Remove(descriptor);
                descriptor.Dispose();
                throw;
            }
        }
    }

    private void RevalidateRoot()
    {
        using SafeFileHandle current = LinuxVaultPathNative.OpenRoot(_root.CanonicalPath);
        if (!_rootDescriptorIdentity.SameObject(LinuxVaultPathNative.Identify(_rootDescriptor))
            || !_rootDescriptorIdentity.SameObject(LinuxVaultPathNative.Identify(current))
            || _rootDescriptorIdentity.MountIdentity != (ulong)_root.Filesystem.MountIdentity)
        {
            throw new LinuxVaultWatcherException("linux_vault_root_descriptor_identity_changed");
        }

        LinuxVaultRootVerifier.PathVerification rootVerification = LinuxVaultRootVerifier.VerifyWatchedRoot(_root);
        if (rootVerification.Disposition == LinuxVaultPathDisposition.Blocked)
        {
            throw new LinuxVaultWatcherException(
                rootVerification.ErrorCode ?? "linux_vault_root_path_blocked");
        }

        // Only control metadata is read. The descriptor anchor prevents a path swap from making
        // the path-based verifier validate a different root's identical-looking control tree.
        LinuxVaultPathNative.RequireOrdinalDirectorySemantics(_rootDescriptor, ".");
        LinuxVaultPathNative.RequireOrdinalDirectorySemantics(_rootDescriptor, ".fsus");
        try
        {
            VerifyAnchoredManifest();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            throw new LinuxVaultWatcherException("linux_vault_root_manifest_unreadable", exception);
        }

        using SafeFileHandle after = LinuxVaultPathNative.OpenRoot(_root.CanonicalPath);
        if (!_rootDescriptorIdentity.SameObject(LinuxVaultPathNative.Identify(after)))
        {
            throw new LinuxVaultWatcherException("linux_vault_root_descriptor_identity_changed");
        }
    }

    private void VerifyAnchoredManifest()
    {
        using SafeFileHandle manifest = LinuxVaultPathNative.OpenRelative(
            _rootDescriptor, ArticleVaultSchemas.RootManifestPath, directory: false);
        const int MaximumManifestBytes = 1024 * 1024;
        byte[] buffer = new byte[MaximumManifestBytes + 1];
        int count = 0;
        while (count < buffer.Length)
        {
            int read = RandomAccess.Read(manifest, buffer.AsSpan(count), count);
            if (read == 0)
            {
                break;
            }

            count += read;
        }

        if (count > MaximumManifestBytes)
        {
            throw new LinuxVaultWatcherException("linux_vault_root_manifest_too_large");
        }

        ArticleVaultRootManifest actual = ArticleVaultManifestCodec.DeserializeRoot(buffer.AsSpan(0, count));
        if (!ArticleVaultManifestValidator.Validate(actual).IsValid
            || !ArticleVaultManifestCodec.Serialize(actual).AsSpan().SequenceEqual(
                ArticleVaultManifestCodec.Serialize(_root.Manifest)))
        {
            throw new LinuxVaultWatcherException("linux_vault_root_manifest_binding_mismatch");
        }

    }

    private void VerifyPath(string relativePath)
    {
        LinuxVaultRootVerifier.PathVerification verification = LinuxVaultRootVerifier.VerifyRelativePath(_root, relativePath);
        if (verification.Disposition == LinuxVaultPathDisposition.Blocked)
        {
            throw new LinuxVaultWatcherException(verification.ErrorCode ?? "linux_vault_path_blocked");
        }
    }

    private void VerifyDirectorySemantics(string sourceRelativePath)
    {
        int separator = sourceRelativePath.IndexOf('/');
        while (separator >= 0)
        {
            LinuxVaultPathNative.RequireOrdinalDirectorySemantics(_rootDescriptor, sourceRelativePath[..separator]);
            separator = sourceRelativePath.IndexOf('/', separator + 1);
        }
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    private void VerifyIssuedPath(IssuedDescriptor issued)
    {
        if (issued.Enumeration)
        {
            VerifyEnumerationPath(issued.DescriptorRelativePath);
        }
        else
        {
            VerifyPath(issued.SourceRelativePath);
            VerifyDirectorySemantics(issued.SourceRelativePath);
        }
    }

    private sealed record IssuedDescriptor(string SourceRelativePath, string DescriptorRelativePath,
        bool Directory, LinuxVaultPathNative.DescriptorIdentity Identity, bool Enumeration = false);
}
