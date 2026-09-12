using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed record AuthoringPackageActivationState(
    string ExtensionId,
    string CurrentPackageIdentity,
    string CurrentVersion,
    string CurrentArchiveSha256,
    string CurrentPackageSha256,
    string CurrentContentSha256,
    string CurrentContractIdentity,
    string CurrentPublisher,
    string CurrentKeyId,
    AuthoringPackageTrustStatus CurrentTrustStatus,
    string CurrentKeysetIdentity,
    string? PreviousPackageIdentity,
    long Generation,
    string StateSha256);

public interface IAuthoringPackageRecoveryStore
{
    ValueTask<AuthoringPackageActivationState?> GetActivationStateAsync(
        string extensionId,
        CancellationToken cancellationToken);

    ValueTask<VerifiedAuthoringPackage> GetByIdentityAsync(
        string packageIdentity,
        CancellationToken cancellationToken);

    ValueTask RollbackUncommittedAsync(
        string extensionId,
        string expectedPackageIdentity,
        CancellationToken cancellationToken);
}

public sealed class LocalAuthoringPackageStore : IAuthoringPackageStore, IAuthoringPackageRecoveryStore
{
    private const int StoreSchemaVersion = 1;
    private const string ArchiveFileName = "archive.fspkg";
    private const string ContentDirectoryName = "content";
    private const string MetadataFileName = "metadata.json";

    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 16,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private readonly string _packagesRoot;
    private readonly string _activeRoot;
    private readonly string _mutationLockPath;
    private readonly AuthoringPackageVerifier _verifier;
    private readonly AuthoringHostPlatform _platform;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public LocalAuthoringPackageStore(
        string rootPath,
        AuthoringPackageVerifier verifier,
        AuthoringHostPlatform platform)
    {
        ArgumentNullException.ThrowIfNull(verifier);
        string root = NormalizeOwnedRoot(rootPath);
        _packagesRoot = Path.Combine(root, "packages");
        _activeRoot = Path.Combine(root, "active");
        _mutationLockPath = Path.Combine(root, ".mutation.lock");
        EnsurePrivateDirectory(_packagesRoot);
        EnsurePrivateDirectory(_activeRoot);
        _verifier = verifier;
        _platform = platform;
    }

    public async ValueTask<VerifiedAuthoringPackage?> GetActiveAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        ValidateExtensionId(extensionId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            AuthoringPackageActivationState? state = await ReadActivationStateCoreAsync(extensionId, cancellationToken);
            return state is null
                ? null
                : await GetByIdentityCoreAsync(state.CurrentPackageIdentity, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<bool> ContainsAsync(
        string packageIdentity,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            string directory = ResolvePackageDirectory(packageIdentity);
            if (!Directory.Exists(directory))
            {
                return false;
            }

            _ = await LoadFromDirectoryAsync(directory, packageIdentity, cancellationToken);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask StageAsync(
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken)
    {
        ValidateVerifiedPackage(package);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream mutationLock = OpenMutationLock();
            VerifiedAuthoringPackage independentlyVerified = await _verifier.VerifyAsync(
                package.Artifact,
                _platform,
                cancellationToken);
            RequireExactIdentity(independentlyVerified, package);
            string finalDirectory = ResolvePackageDirectory(independentlyVerified.PackageIdentity);
            if (Directory.Exists(finalDirectory))
            {
                VerifiedAuthoringPackage existing = await LoadFromDirectoryAsync(
                    finalDirectory,
                    independentlyVerified.PackageIdentity,
                    cancellationToken);
                RequireExactIdentity(existing, independentlyVerified);
                return;
            }

            string stagingDirectory = Path.Combine(
                _packagesRoot,
                $".staging-{independentlyVerified.PackageIdentity}-{Guid.NewGuid():N}");
            EnsurePrivateDirectory(stagingDirectory);
            try
            {
                await WritePackageAsync(stagingDirectory, independentlyVerified, cancellationToken);
                VerifiedAuthoringPackage staged = await LoadFromDirectoryAsync(
                    stagingDirectory,
                    independentlyVerified.PackageIdentity,
                    cancellationToken);
                RequireExactIdentity(staged, independentlyVerified);
                try
                {
                    Directory.Move(stagingDirectory, finalDirectory);
                }
                catch (IOException) when (Directory.Exists(finalDirectory))
                {
                    DeleteOwnedPackageDirectory(stagingDirectory);
                    VerifiedAuthoringPackage existing = await LoadFromDirectoryAsync(
                        finalDirectory,
                        independentlyVerified.PackageIdentity,
                        cancellationToken);
                    RequireExactIdentity(existing, independentlyVerified);
                    return;
                }

                MakePackageReadOnly(finalDirectory);
                _ = await LoadFromDirectoryAsync(
                    finalDirectory,
                    independentlyVerified.PackageIdentity,
                    cancellationToken);
            }
            catch
            {
                if (Directory.Exists(stagingDirectory))
                {
                    DeleteOwnedPackageDirectory(stagingDirectory);
                }

                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask ActivateAsync(
        string extensionId,
        string packageIdentity,
        CancellationToken cancellationToken)
    {
        ValidateExtensionId(extensionId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream mutationLock = OpenMutationLock();
            VerifiedAuthoringPackage package = await GetByIdentityCoreAsync(packageIdentity, cancellationToken);
            if (!string.Equals(package.Contract.Manifest.Id, extensionId, StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Package activation identity does not match its extension.");
            }

            AuthoringPackageActivationState? current = await ReadActivationStateCoreAsync(extensionId, cancellationToken);
            if (string.Equals(current?.CurrentPackageIdentity, packageIdentity, StringComparison.Ordinal))
            {
                return;
            }

            var state = new AuthoringPackageActivationState(
                extensionId,
                package.PackageIdentity,
                package.Contract.Manifest.Version,
                package.Artifact.ArchiveSha256,
                package.Contract.Manifest.PackageSha256,
                package.Contract.Manifest.ContentSha256,
                package.Contract.ContractIdentity,
                package.Contract.Manifest.Publisher,
                package.Artifact.KeyId,
                package.Trust.Status,
                package.Trust.KeysetIdentity,
                string.Equals(current?.PreviousPackageIdentity, package.PackageIdentity, StringComparison.Ordinal)
                    ? null
                    : current?.CurrentPackageIdentity,
                (current?.Generation ?? 0) + 1,
                string.Empty);
            state = state with
            {
                StateSha256 = ComputeStateSha256(state)
            };
            await WriteActivationStateAsync(state, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DeactivateAsync(
        string extensionId,
        string expectedPackageIdentity,
        CancellationToken cancellationToken)
    {
        ValidateExtensionId(extensionId);
        ValidateDigest(expectedPackageIdentity, "expected package identity");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream mutationLock = OpenMutationLock();
            AuthoringPackageActivationState? current = await ReadActivationStateCoreAsync(extensionId, cancellationToken);
            if (current is null)
            {
                return;
            }

            if (!string.Equals(current.CurrentPackageIdentity, expectedPackageIdentity, StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Package deactivation raced with another activation.");
            }

            File.Delete(ResolveActivationPath(extensionId));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask RemoveStagedAsync(
        string packageIdentity,
        CancellationToken cancellationToken)
    {
        ValidateDigest(packageIdentity, "package identity");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream mutationLock = OpenMutationLock();
            foreach (string pointerPath in Directory.EnumerateFiles(_activeRoot, "*.json", SearchOption.TopDirectoryOnly))
            {
                AuthoringPackageActivationState pointer = await ReadActivationStateFileAsync(pointerPath, cancellationToken);
                if (string.Equals(pointer.CurrentPackageIdentity, packageIdentity, StringComparison.Ordinal))
                {
                    throw new AuthoringExtensionContractException("Active package content cannot be removed as staging.");
                }
            }

            string directory = ResolvePackageDirectory(packageIdentity);
            if (Directory.Exists(directory))
            {
                DeleteOwnedPackageDirectory(directory);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask AssertContentUnchangedAsync(
        string packageIdentity,
        CancellationToken cancellationToken)
    {
        _ = await GetByIdentityAsync(packageIdentity, cancellationToken);
    }

    public async ValueTask<AuthoringPackageActivationState?> GetActivationStateAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        ValidateExtensionId(extensionId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await ReadActivationStateCoreAsync(extensionId, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask<VerifiedAuthoringPackage> GetByIdentityAsync(
        string packageIdentity,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await GetByIdentityCoreAsync(packageIdentity, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask RollbackUncommittedAsync(
        string extensionId,
        string expectedPackageIdentity,
        CancellationToken cancellationToken)
    {
        ValidateExtensionId(extensionId);
        ValidateDigest(expectedPackageIdentity, "expected package identity");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using FileStream mutationLock = OpenMutationLock();
            AuthoringPackageActivationState current = await ReadActivationStateCoreAsync(extensionId, cancellationToken)
                ?? throw new AuthoringExtensionContractException("Package recovery has no active state.");
            if (!string.Equals(current.CurrentPackageIdentity, expectedPackageIdentity, StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Package recovery raced with another activation.");
            }

            if (current.PreviousPackageIdentity is null)
            {
                File.Delete(ResolveActivationPath(extensionId));
                return;
            }

            VerifiedAuthoringPackage previous = await GetByIdentityCoreAsync(
                current.PreviousPackageIdentity,
                cancellationToken);
            var restored = new AuthoringPackageActivationState(
                extensionId,
                previous.PackageIdentity,
                previous.Contract.Manifest.Version,
                previous.Artifact.ArchiveSha256,
                previous.Contract.Manifest.PackageSha256,
                previous.Contract.Manifest.ContentSha256,
                previous.Contract.ContractIdentity,
                previous.Contract.Manifest.Publisher,
                previous.Artifact.KeyId,
                previous.Trust.Status,
                previous.Trust.KeysetIdentity,
                null,
                current.Generation + 1,
                string.Empty);
            restored = restored with
            {
                StateSha256 = ComputeStateSha256(restored)
            };
            await WriteActivationStateAsync(restored, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async ValueTask<VerifiedAuthoringPackage> GetByIdentityCoreAsync(
        string packageIdentity,
        CancellationToken cancellationToken)
    {
        string directory = ResolvePackageDirectory(packageIdentity);
        if (!Directory.Exists(directory))
        {
            throw new AuthoringExtensionContractException("Content-addressed package is missing.");
        }

        return await LoadFromDirectoryAsync(directory, packageIdentity, cancellationToken);
    }

    private async ValueTask<VerifiedAuthoringPackage> LoadFromDirectoryAsync(
        string directory,
        string expectedPackageIdentity,
        CancellationToken cancellationToken)
    {
        ValidateOwnedPackageDirectory(directory);
        string[] names = Directory.EnumerateFileSystemEntries(directory, "*", SearchOption.TopDirectoryOnly)
            .Select(static path => Path.GetFileName(path) ?? string.Empty)
            .Order(StringComparer.Ordinal)
            .ToArray()!;
        if (!names.SequenceEqual(
                new[] { ArchiveFileName, ContentDirectoryName, MetadataFileName },
                StringComparer.Ordinal))
        {
            throw new AuthoringExtensionContractException("Stored package contains an unknown or missing artifact.");
        }

        string archivePath = Path.Combine(directory, ArchiveFileName);
        string metadataPath = Path.Combine(directory, MetadataFileName);
        RejectReparsePoint(archivePath);
        RejectReparsePoint(metadataPath);
        byte[] archive = await ReadBoundedAsync(archivePath, 128 * 1024 * 1024, cancellationToken);
        byte[] metadataBytes = await ReadBoundedAsync(metadataPath, 1024 * 1024, cancellationToken);
        StoredPackageMetadata metadata;
        try
        {
            metadata = JsonSerializer.Deserialize<StoredPackageMetadata>(metadataBytes, s_json)
                ?? throw new AuthoringExtensionContractException("Stored package metadata is missing.");
        }
        catch (JsonException exception)
        {
            throw new AuthoringExtensionContractException($"Stored package metadata is not closed: {exception.GetType().Name}.");
        }

        if (metadata.SchemaVersion != StoreSchemaVersion ||
            !string.Equals(metadata.PackageIdentity, expectedPackageIdentity, StringComparison.Ordinal) ||
            !string.Equals(metadata.ArchiveSha256, Digest(archive), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Stored package metadata or archive identity was tampered.");
        }

        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            ImmutableArray.Create(metadata.Signature),
            metadata.Publisher,
            metadata.KeyId,
            metadata.SourceReference,
            metadata.ProvenanceReference,
            metadata.ArchiveSha256);
        VerifiedAuthoringPackage package = await _verifier.VerifyAsync(artifact, _platform, cancellationToken);
        if (!string.Equals(package.PackageIdentity, metadata.PackageIdentity, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.Id, metadata.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.Version, metadata.Version, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.PackageSha256, metadata.PackageSha256, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.Manifest.ContentSha256, metadata.ContentSha256, StringComparison.Ordinal) ||
            !string.Equals(package.Contract.ContractIdentity, metadata.ContractIdentity, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Stored package metadata drifted from the independently verified archive.");
        }

        await VerifyExtractedContentAsync(
            Path.Combine(directory, ContentDirectoryName),
            package.Contents.Entries,
            cancellationToken);

        return package;
    }

    private async ValueTask WritePackageAsync(
        string directory,
        VerifiedAuthoringPackage package,
        CancellationToken cancellationToken)
    {
        string contentRoot = Path.Combine(directory, ContentDirectoryName);
        EnsurePrivateDirectory(contentRoot);
        foreach (AuthoringPackageEntry entry in package.Contents.Entries)
        {
            string destination = ResolveExtractedPath(contentRoot, entry.Path);
            string? parent = Path.GetDirectoryName(destination);
            if (parent is null)
            {
                throw new AuthoringExtensionContractException("Package entry has no owned staging parent.");
            }

            EnsurePrivateDirectory(parent);
            await WriteNewPrivateFileAsync(destination, entry.Content.AsMemory(), cancellationToken);
        }

        var metadata = new StoredPackageMetadata(
            StoreSchemaVersion,
            package.Contract.Manifest.Id,
            package.Contract.Manifest.Version,
            package.PackageIdentity,
            package.Artifact.ArchiveSha256,
            package.Contract.Manifest.PackageSha256,
            package.Contract.Manifest.ContentSha256,
            package.Contract.ContractIdentity,
            package.Contract.Manifest.Publisher,
            package.Artifact.KeyId,
            package.Artifact.SourceReference,
            package.Artifact.ProvenanceReference,
            package.Artifact.Signature.ToArray());
        await WriteNewPrivateFileAsync(
            Path.Combine(directory, ArchiveFileName),
            package.Artifact.CanonicalArchive.AsMemory(),
            cancellationToken);
        await WriteNewPrivateFileAsync(
            Path.Combine(directory, MetadataFileName),
            JsonSerializer.SerializeToUtf8Bytes(metadata, s_json),
            cancellationToken);
    }

    private async ValueTask<AuthoringPackageActivationState?> ReadActivationStateCoreAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        string path = ResolveActivationPath(extensionId);
        return File.Exists(path)
            ? await ReadActivationStateFileAsync(path, cancellationToken)
            : null;
    }

    private static async ValueTask<AuthoringPackageActivationState> ReadActivationStateFileAsync(
        string path,
        CancellationToken cancellationToken)
    {
        RejectReparsePoint(path);
        byte[] bytes = await ReadBoundedAsync(path, 64 * 1024, cancellationToken);
        AuthoringPackageActivationState state;
        try
        {
            state = JsonSerializer.Deserialize<AuthoringPackageActivationState>(bytes, s_json)
                ?? throw new AuthoringExtensionContractException("Package activation state is missing.");
        }
        catch (JsonException exception)
        {
            throw new AuthoringExtensionContractException($"Package activation state is not closed: {exception.GetType().Name}.");
        }

        ValidateExtensionId(state.ExtensionId);
        ValidateDigest(state.CurrentPackageIdentity, "active package identity");
        if (state.PreviousPackageIdentity is not null)
        {
            ValidateDigest(state.PreviousPackageIdentity, "previous package identity");
        }

        if (state.Generation < 1 || !string.Equals(state.StateSha256, ComputeStateSha256(state), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Package activation state was tampered.");
        }

        return state;
    }

    private async ValueTask WriteActivationStateAsync(
        AuthoringPackageActivationState state,
        CancellationToken cancellationToken)
    {
        string path = ResolveActivationPath(state.ExtensionId);
        string temporary = Path.Combine(_activeRoot, $".{state.ExtensionId}-{Guid.NewGuid():N}.tmp");
        try
        {
            await WriteNewPrivateFileAsync(
                temporary,
                JsonSerializer.SerializeToUtf8Bytes(state, s_json),
                cancellationToken);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    private string ResolvePackageDirectory(string packageIdentity)
    {
        ValidateDigest(packageIdentity, "package identity");
        return Path.Combine(_packagesRoot, packageIdentity);
    }

    private string ResolveActivationPath(string extensionId)
    {
        ValidateExtensionId(extensionId);
        return Path.Combine(_activeRoot, string.Concat(extensionId, ".json"));
    }

    private static string NormalizeOwnedRoot(string rootPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootPath));
        if (string.Equals(root, Path.GetPathRoot(root), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Package store root cannot be a filesystem root.");
        }

        EnsurePrivateDirectory(root);
        return root;
    }

    private static void EnsurePrivateDirectory(string path)
    {
        if (Directory.Exists(path))
        {
            RejectReparsePoint(path);
        }
        else
        {
            Directory.CreateDirectory(path);
        }

        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    private static void ValidateOwnedPackageDirectory(string directory)
    {
        if (!Directory.Exists(directory))
        {
            throw new AuthoringExtensionContractException("Stored package directory is missing.");
        }

        RejectReparsePoint(directory);
    }

    private static void MakePackageReadOnly(string directory)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        foreach (string file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            File.SetUnixFileMode(file, UnixFileMode.UserRead);
        }

        foreach (string child in Directory.EnumerateDirectories(directory, "*", SearchOption.AllDirectories)
                     .OrderByDescending(static path => path.Length))
        {
            File.SetUnixFileMode(child, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        }

        File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserExecute);
    }

    private static void DeleteOwnedPackageDirectory(string directory)
    {
        RejectReparsePoint(directory);
        if (!OperatingSystem.IsWindows())
        {
            foreach (string child in Directory.EnumerateDirectories(directory, "*", SearchOption.AllDirectories))
            {
                RejectReparsePoint(child);
                File.SetUnixFileMode(
                    child,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        Directory.Delete(directory, recursive: true);
    }

    private static async ValueTask WriteNewPrivateFileAsync(
        string path,
        ReadOnlyMemory<byte> content,
        CancellationToken cancellationToken)
    {
        await using (var stream = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            81920,
            FileOptions.Asynchronous | FileOptions.WriteThrough))
        {
            await stream.WriteAsync(content, cancellationToken);
            await stream.FlushAsync(cancellationToken);
            stream.Flush(flushToDisk: true);
        }

        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    private static async ValueTask<byte[]> ReadBoundedAsync(
        string path,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length < 1 || info.Length > maximumBytes)
        {
            throw new AuthoringExtensionContractException("Stored package artifact is missing or outside its byte bound.");
        }

        byte[] bytes = new byte[checked((int)info.Length)];
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            81920,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        await stream.ReadExactlyAsync(bytes, cancellationToken);
        return bytes;
    }

    private static void ValidateVerifiedPackage(VerifiedAuthoringPackage package)
    {
        ArgumentNullException.ThrowIfNull(package);
        ValidateDigest(package.PackageIdentity, "package identity");
        ValidateDigest(package.Artifact.ArchiveSha256, "archive identity");
        if (!string.Equals(package.Artifact.ArchiveSha256, Digest(package.Artifact.CanonicalArchive.AsSpan()), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Verified package archive identity drifted before staging.");
        }
    }

    private static void RequireExactIdentity(VerifiedAuthoringPackage actual, VerifiedAuthoringPackage expected)
    {
        if (!string.Equals(actual.PackageIdentity, expected.PackageIdentity, StringComparison.Ordinal) ||
            !string.Equals(actual.Contract.ContractIdentity, expected.Contract.ContractIdentity, StringComparison.Ordinal) ||
            !string.Equals(actual.Artifact.ArchiveSha256, expected.Artifact.ArchiveSha256, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Content-addressed package collides with different verified content.");
        }
    }

    private static string ComputeStateSha256(AuthoringPackageActivationState state)
    {
        string material = string.Join('\n',
            "fsusblog.authoring-package.activation.v1",
            state.ExtensionId,
            state.CurrentPackageIdentity,
            state.CurrentVersion,
            state.CurrentArchiveSha256,
            state.CurrentPackageSha256,
            state.CurrentContentSha256,
            state.CurrentContractIdentity,
            state.CurrentPublisher,
            state.CurrentKeyId,
            state.CurrentTrustStatus,
            state.CurrentKeysetIdentity,
            state.PreviousPackageIdentity ?? string.Empty,
            state.Generation);
        return Digest(Encoding.UTF8.GetBytes(material));
    }

    private static void ValidateExtensionId(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128 ||
            value[0] is not (>= 'a' and <= 'z') ||
            value.Any(static character => character is not (>= 'a' and <= 'z')
                and not (>= '0' and <= '9') and not '.' and not '-'))
        {
            throw new AuthoringExtensionContractException("Extension store identity is invalid or path-capable.");
        }
    }

    private static void ValidateDigest(string value, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length != 64 || value.Any(static character =>
            character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new AuthoringExtensionContractException($"The {field} is not a lowercase SHA-256 digest.");
        }
    }

    private static void RejectReparsePoint(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new AuthoringExtensionContractException("Package store path crosses a reparse boundary.");
        }
    }

    private static string ResolveExtractedPath(string contentRoot, string relativePath)
    {
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(contentRoot));
        string candidate = Path.GetFullPath(Path.Combine(
            root,
            relativePath.Replace('/', Path.DirectorySeparatorChar)));
        if (!candidate.StartsWith(string.Concat(root, Path.DirectorySeparatorChar), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Package entry escaped its owned staging root.");
        }

        return candidate;
    }

    private static async ValueTask VerifyExtractedContentAsync(
        string contentRoot,
        ImmutableArray<AuthoringPackageEntry> expectedEntries,
        CancellationToken cancellationToken)
    {
        ValidateOwnedPackageDirectory(contentRoot);
        var expectedDirectories = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringPackageEntry entry in expectedEntries)
        {
            string? parent = Path.GetDirectoryName(entry.Path.Replace('/', Path.DirectorySeparatorChar));
            while (!string.IsNullOrEmpty(parent))
            {
                expectedDirectories.Add(parent.Replace(Path.DirectorySeparatorChar, '/'));
                parent = Path.GetDirectoryName(parent);
            }
        }

        string[] actualDirectories = Directory.EnumerateDirectories(contentRoot, "*", SearchOption.AllDirectories)
            .Select(path =>
            {
                RejectReparsePoint(path);
                return Path.GetRelativePath(contentRoot, path).Replace(Path.DirectorySeparatorChar, '/');
            })
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!actualDirectories.SequenceEqual(expectedDirectories.Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new AuthoringExtensionContractException("Stored package contains an unknown or missing content directory.");
        }

        string[] actualFiles = Directory.EnumerateFiles(contentRoot, "*", SearchOption.AllDirectories)
            .Select(path =>
            {
                RejectReparsePoint(path);
                return Path.GetRelativePath(contentRoot, path).Replace(Path.DirectorySeparatorChar, '/');
            })
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] expectedFiles = expectedEntries
            .Select(static entry => entry.Path)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!actualFiles.SequenceEqual(expectedFiles, StringComparer.Ordinal))
        {
            throw new AuthoringExtensionContractException("Stored package contains an unknown or missing content artifact.");
        }

        foreach (AuthoringPackageEntry expected in expectedEntries)
        {
            string path = ResolveExtractedPath(contentRoot, expected.Path);
            byte[] content = await ReadExactLengthAsync(path, expected.Content.Length, cancellationToken);
            if (!CryptographicOperations.FixedTimeEquals(
                    SHA256.HashData(content),
                    Convert.FromHexString(expected.ContentSha256)))
            {
                throw new AuthoringExtensionContractException("Stored package content was modified after verification.");
            }
        }
    }

    private static async ValueTask<byte[]> ReadExactLengthAsync(
        string path,
        int expectedLength,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            81920,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length != expectedLength)
        {
            throw new AuthoringExtensionContractException("Stored package content length changed after verification.");
        }

        byte[] content = new byte[expectedLength];
        await stream.ReadExactlyAsync(content, cancellationToken);
        return content;
    }

    private FileStream OpenMutationLock()
    {
        try
        {
            FileStream stream = new(
                _mutationLockPath,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None,
                1,
                FileOptions.WriteThrough);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(_mutationLockPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }

            return stream;
        }
        catch (IOException exception)
        {
            throw new AuthoringExtensionContractException(
                $"Package store mutation authority is already active: {exception.GetType().Name}.");
        }
    }

    private static string Digest(ReadOnlySpan<byte> content) =>
        Convert.ToHexStringLower(SHA256.HashData(content));

    private sealed record StoredPackageMetadata(
        int SchemaVersion,
        string ExtensionId,
        string Version,
        string PackageIdentity,
        string ArchiveSha256,
        string PackageSha256,
        string ContentSha256,
        string ContractIdentity,
        string Publisher,
        string KeyId,
        string SourceReference,
        string ProvenanceReference,
        byte[] Signature);
}
