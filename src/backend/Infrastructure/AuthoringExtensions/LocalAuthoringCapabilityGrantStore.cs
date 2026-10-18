using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Persists already approved grants for both RPC and lifecycle queries. This store
/// creates no consent or host registration; all callers must share this owner.
/// </summary>
public sealed class LocalAuthoringCapabilityGrantStore :
    IAuthoringCapabilityGrantReadScopeStore, IAuthoringCapabilityGrantCatalog
{
    private const int MaximumEntries = 4096;
    private const int MaximumBytes = 16 * 1024 * 1024;
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 16,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    private readonly string _root;
    private readonly string _statePath;
    private readonly string _lockPath;
    private readonly IDataProtector _protector;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public LocalAuthoringCapabilityGrantStore(
        string rootPath, IDataProtectionProvider protectionProvider, TimeProvider timeProvider)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        ArgumentNullException.ThrowIfNull(protectionProvider);
        ArgumentNullException.ThrowIfNull(timeProvider);
        _root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootPath));
        if (string.Equals(_root, Path.GetPathRoot(_root), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Grant store requires a private owned directory.");
        }
        RequireRoot();
        Directory.CreateDirectory(_root);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(_root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        _statePath = Path.Combine(_root, "grants.bin");
        _lockPath = Path.Combine(_root, ".mutation.lock");
        string rootIdentity = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_root)));
        _protector = protectionProvider.CreateProtector("FsusBlog.AuthoringExtensions.CapabilityGrants.v1", rootIdentity);
        _timeProvider = timeProvider;
    }

    public ValueTask<AuthoringCapabilityGrant?> FindAsync(string grantId, CancellationToken cancellationToken)
    {
        RequireDigest(grantId);
        using IDisposable owner = AcquireOwner(cancellationToken);
        DateTimeOffset now = _timeProvider.GetUtcNow();
        return ValueTask.FromResult(ReadState().Grants
            .Where(entry => IsActive(entry, now) && entry.Grant.GrantId == grantId)
            .Select(entry => entry.Grant).SingleOrDefault());
    }

    public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveAsync(
        string extensionId, string contributionId, string runtimeIdentity, CancellationToken cancellationToken)
    {
        RequireField(extensionId, 128);
        RequireField(contributionId, 256);
        RequireDigest(runtimeIdentity);
        return FindMatching(grant => grant.ExtensionId == extensionId &&
            grant.ContributionId == contributionId && grant.RuntimeIdentity == runtimeIdentity, cancellationToken);
    }

    public ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindActiveExactAsync(
        string extensionId, string extensionVersion, string contributionId, string runtimeIdentity,
        AuthoringExecutionClass executionClass, string documentId, CancellationToken cancellationToken)
    {
        RequireField(extensionId, 128);
        RequireField(extensionVersion, 64);
        RequireField(contributionId, 256);
        RequireDigest(runtimeIdentity);
        RequireField(documentId, 256);
        if (!Enum.IsDefined(executionClass))
        {
            throw new AuthoringExtensionContractException("Unknown grant execution class.");
        }
        return FindMatching(grant => grant.ExtensionId == extensionId &&
            grant.ExtensionVersion == extensionVersion && grant.ContributionId == contributionId &&
            grant.RuntimeIdentity == runtimeIdentity && grant.ExecutionClass == executionClass &&
            grant.DocumentId == documentId, cancellationToken);
    }

    private ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindMatching(
        Func<AuthoringCapabilityGrant, bool> predicate, CancellationToken cancellationToken)
    {
        using IDisposable owner = AcquireOwner(cancellationToken);
        DateTimeOffset now = _timeProvider.GetUtcNow();
        return ValueTask.FromResult(ReadState().Grants.Where(entry => IsActive(entry, now) && predicate(entry.Grant))
            .Select(entry => entry.Grant).OrderBy(grant => grant.GrantId, StringComparer.Ordinal).ToImmutableArray());
    }

    public async ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(grant);
        ValidateGrant(grant);
        using IDisposable owner = AcquireOwner(cancellationToken);
        GrantState state = ReadState();
        if (state.RevokedGrantIds.Contains(grant.GrantId, StringComparer.Ordinal))
        {
            throw new AuthoringExtensionContractException("A revoked grant identity cannot be restored.");
        }
        GrantEntry? existing = state.Grants.SingleOrDefault(entry => entry.Grant.GrantId == grant.GrantId);
        if (existing is not null)
        {
            if (existing.Revoked || existing.Grant != grant)
            {
                throw new AuthoringExtensionContractException("A revoked or different grant cannot replace its stored identity.");
            }
            return;
        }
        DateTimeOffset now = _timeProvider.GetUtcNow();
        if (grant.IssuedAt > now || grant.ExpiresAt <= now || state.Grants.Length + state.RevokedGrantIds.Length >= MaximumEntries)
        {
            throw new AuthoringExtensionContractException("Grant is inactive or the bounded store is full.");
        }
        await WriteStateAsync(state with
        {
            Generation = checked(state.Generation + 1),
            Grants = state.Grants.Add(new GrantEntry(grant, false))
        }, cancellationToken);
    }

    public async ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken)
    {
        RequireDigest(grantId);
        using IDisposable owner = AcquireOwner(cancellationToken);
        GrantState state = ReadState();
        if (state.RevokedGrantIds.Contains(grantId, StringComparer.Ordinal) ||
            state.Grants.Any(entry => entry.Grant.GrantId == grantId && entry.Revoked))
        {
            return;
        }
        if (state.Grants.Any(entry => entry.Grant.GrantId == grantId))
        {
            state = state with
            {
                Grants = state.Grants.Select(entry => entry.Grant.GrantId == grantId
                ? entry with
                {
                    Revoked = true
                } : entry).ToImmutableArray()
            };
        }
        else
        {
            if (state.Grants.Length + state.RevokedGrantIds.Length >= MaximumEntries)
            {
                throw new AuthoringExtensionContractException("The bounded grant tombstone store is full.");
            }
            state = state with
            {
                RevokedGrantIds = state.RevokedGrantIds.Add(grantId)
            };
        }
        await WriteStateAsync(state with
        {
            Generation = checked(state.Generation + 1)
        }, cancellationToken);
    }

    public ValueTask<int> RevokeExtensionAsync(string extensionId, CancellationToken cancellationToken)
    {
        RequireField(extensionId, 128);
        return RevokeMatchingAsync(grant => grant.ExtensionId == extensionId, cancellationToken);
    }

    public ValueTask<int> RevokeRuntimesAsync(
        string extensionId, ImmutableHashSet<string> runtimeIdentities, CancellationToken cancellationToken)
    {
        RequireField(extensionId, 128);
        ArgumentNullException.ThrowIfNull(runtimeIdentities);
        if (runtimeIdentities.Count > MaximumEntries)
        {
            throw new AuthoringExtensionContractException("Grant runtime set is outside its bound.");
        }
        foreach (string identity in runtimeIdentities)
        {
            RequireDigest(identity);
        }
        // Always ordinal, even when the caller supplies a case-insensitive set.
        var exactRuntimes = runtimeIdentities.ToImmutableHashSet(StringComparer.Ordinal);
        return RevokeMatchingAsync(grant => grant.ExtensionId == extensionId &&
            exactRuntimes.Contains(grant.RuntimeIdentity), cancellationToken);
    }

    private async ValueTask<int> RevokeMatchingAsync(
        Func<AuthoringCapabilityGrant, bool> predicate, CancellationToken cancellationToken)
    {
        using IDisposable owner = AcquireOwner(cancellationToken);
        GrantState state = ReadState();
        int count = state.Grants.Count(entry => !entry.Revoked && predicate(entry.Grant));
        if (count > 0)
        {
            await WriteStateAsync(state with
            {
                Generation = checked(state.Generation + 1),
                Grants = state.Grants.Select(entry => !entry.Revoked && predicate(entry.Grant)
                    ? entry with
                    {
                        Revoked = true
                    } : entry).ToImmutableArray()
            }, cancellationToken);
        }
        return count;
    }

    /// <summary>
    /// Retains the same cross-instance mutation lock through terminal publication.
    /// Acquisition never waits; release is idempotent and independent of threads.
    /// </summary>
    public IAuthoringCapabilityGrantReadScope AcquireReadScope(string grantId)
    {
        RequireDigest(grantId);
        IDisposable owner = AcquireOwner(CancellationToken.None);
        try
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            GrantEntry? entry = ReadState().Grants.SingleOrDefault(entry => entry.Grant.GrantId == grantId);
            if (entry is null || !IsActive(entry, now))
            {
                throw new AuthoringExtensionContractException("Grant has no active store-owned read scope.");
            }
            return new GrantReadScope(entry.Grant, owner);
        }
        catch
        {
            owner.Dispose();
            throw;
        }
    }

    private IDisposable AcquireOwner(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_gate.Wait(0))
        {
            throw new AuthoringExtensionContractException("Grant store refused a busy owner.");
        }
        FileStream? stream = null;
        try
        {
            RequireRoot();
            RequireRegularPath(_lockPath);
            if (!File.Exists(_lockPath) && File.Exists(_statePath))
            {
                throw new AuthoringExtensionContractException("Grant ownership lock is missing; recovery is required.");
            }
            if (File.Exists(_lockPath))
            {
                using var original = global::FsusBlog.Algorithms.IO.NativeRegularFileGuard.OpenOriginalRegularFile(
                    _lockPath, cancellationToken);
            }
            bool created = false;
            try
            {
                stream = new FileStream(_lockPath, FileMode.CreateNew, FileAccess.ReadWrite,
                    FileShare.None, 1, FileOptions.WriteThrough);
                created = true;
            }
            catch (IOException) when (File.Exists(_lockPath))
            {
                stream = new FileStream(_lockPath, FileMode.Open, FileAccess.ReadWrite,
                    FileShare.None, 1, FileOptions.WriteThrough);
            }
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(_lockPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            _ = global::FsusBlog.Algorithms.IO.NativeRegularFileGuard.CaptureOriginalHeldRegularFileIdentity(
                _lockPath, stream.SafeFileHandle, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            if (!File.Exists(_statePath))
            {
                if (!created)
                {
                    throw new AuthoringExtensionContractException("Initialized grant state is missing; recovery is required.");
                }
                WriteStateAsync(new GrantState(1, 1, [], []), cancellationToken).GetAwaiter().GetResult();
            }
            return new StoreOwner(stream, _gate);
        }
        catch
        {
            stream?.Dispose();
            _gate.Release();
            throw;
        }
    }

    private GrantState ReadState()
    {
        RequireRegularPath(_statePath);
        if (!File.Exists(_statePath))
        {
            throw new AuthoringExtensionContractException("Initialized grant state is missing; recovery is required.");
        }
        var info = new FileInfo(_statePath);
        if (info.Length is < 1 or > MaximumBytes)
        {
            throw new AuthoringExtensionContractException("Grant state is outside its byte bound.");
        }
        using var handle = global::FsusBlog.Algorithms.IO.NativeRegularFileGuard.OpenOriginalRegularFile(
            _statePath, CancellationToken.None);
        var identity = global::FsusBlog.Algorithms.IO.NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(
            _statePath, handle, CancellationToken.None);
        using var stream = new FileStream(handle, FileAccess.Read);
        byte[] protectedBytes = new byte[checked((int)info.Length)];
        stream.ReadExactly(protectedBytes);
        if (stream.ReadByte() != -1)
        {
            throw new AuthoringExtensionContractException("Grant state changed during reading.");
        }
        global::FsusBlog.Algorithms.IO.NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(
            _statePath, handle, identity, CancellationToken.None);
        byte[] bytes = _protector.Unprotect(protectedBytes);
        if (bytes.Length > MaximumBytes)
        {
            throw new AuthoringExtensionContractException("Grant plaintext is outside its byte bound.");
        }
        using JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
        RejectDuplicateProperties(document.RootElement);
        GrantState state = document.Deserialize<GrantState>(s_json)
            ?? throw new AuthoringExtensionContractException("Grant state is absent.");
        if (state.SchemaVersion != 1 || state.Generation < 1 || state.Grants.IsDefault ||
            state.RevokedGrantIds.IsDefault || state.Grants.Length + state.RevokedGrantIds.Length > MaximumEntries ||
            state.RevokedGrantIds.Distinct(StringComparer.Ordinal).Count() != state.RevokedGrantIds.Length ||
            state.Grants.Select(entry => entry?.Grant?.GrantId).Distinct(StringComparer.Ordinal).Count() != state.Grants.Length)
        {
            throw new AuthoringExtensionContractException("Grant state schema, sequence or membership is invalid.");
        }
        foreach (GrantEntry entry in state.Grants)
        {
            if (entry?.Grant is null)
            {
                throw new AuthoringExtensionContractException("Grant state contains an absent record.");
            }
            ValidateGrant(entry.Grant);
        }
        foreach (string revokedId in state.RevokedGrantIds)
        {
            RequireDigest(revokedId);
            if (state.Grants.Any(entry => entry.Grant.GrantId == revokedId))
            {
                throw new AuthoringExtensionContractException("Grant state repeats a revoked identity.");
            }
        }
        return state;
    }

    private ValueTask WriteStateAsync(GrantState state, CancellationToken cancellationToken)
    {
        byte[] bytes = _protector.Protect(JsonSerializer.SerializeToUtf8Bytes(state, s_json));
        if (bytes.Length > MaximumBytes)
        {
            throw new AuthoringExtensionContractException("Grant state exceeds its byte bound.");
        }
        string temporary = Path.Combine(_root, $".grants-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 16 * 1024, FileOptions.WriteThrough))
            {
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }
                cancellationToken.ThrowIfCancellationRequested();
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            RequireRoot();
            RequireRegularPath(_statePath);
            File.Move(temporary, _statePath, overwrite: true);
            return ValueTask.CompletedTask;
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }

    private static bool IsActive(GrantEntry entry, DateTimeOffset now) =>
        !entry.Revoked && entry.Grant.IssuedAt <= now && entry.Grant.ExpiresAt > now;

    private static void ValidateGrant(AuthoringCapabilityGrant grant)
    {
        RequireDigest(grant.GrantId);
        RequireDigest(grant.RuntimeIdentity);
        RequireField(grant.RequestId, 256);
        RequireField(grant.ExtensionId, 128);
        RequireField(grant.ExtensionVersion, 64);
        RequireField(grant.ContributionId, 256);
        RequireField(grant.DocumentId, 256);
        RequireField(grant.SiteIdentity, 256);
        RequireField(grant.Purpose, 256);
        RequireField(grant.ApprovalReceiptId, 256);
        if (!Enum.IsDefined(grant.ExecutionClass) || !Enum.IsDefined(grant.Capability) ||
            grant.Purpose.Equals("all", StringComparison.OrdinalIgnoreCase) ||
            grant.IssuedAt.Offset != TimeSpan.Zero || grant.ExpiresAt.Offset != TimeSpan.Zero ||
            grant.ExpiresAt <= grant.IssuedAt || grant.ExpiresAt - grant.IssuedAt > TimeSpan.FromHours(24) ||
            grant.GrantId != grant.GrantDigest || grant.GrantDigest != AuthoringCapabilityGrantAuthority.ComputeGrantDigest(grant))
        {
            throw new AuthoringExtensionContractException("Grant record is not exact, bounded and digest-bound.");
        }
        switch (grant.Capability)
        {
            case AuthoringCapability.NetworkDestination:
                RequireField(grant.Destination, 2048);
                if (grant.CanonicalRoot is not null)
                {
                    throw new AuthoringExtensionContractException("Network grant cannot carry a file root.");
                }
                break;
            case AuthoringCapability.FileSystemRootRead:
            case AuthoringCapability.FileSystemRootProposeWrite:
                RequireField(grant.CanonicalRoot, 4096);
                if (grant.Destination is not null)
                {
                    throw new AuthoringExtensionContractException("File grant cannot carry a network destination.");
                }
                break;
            default:
                if (grant.Destination is not null || grant.CanonicalRoot is not null)
                {
                    throw new AuthoringExtensionContractException("Non-I/O grant cannot carry broker scope.");
                }
                break;
        }
        bool exactDocument = grant.DocumentEpoch >= 1 && grant.SourceRevision >= 0 && IsDigest(grant.SnapshotSha256);
        bool noDocument = grant.DocumentEpoch is null && grant.SourceRevision is null && grant.SnapshotSha256 is null;
        if (grant.Capability == AuthoringCapability.DocumentFullRead ? !exactDocument : !noDocument)
        {
            throw new AuthoringExtensionContractException("Grant document revision scope is invalid.");
        }
    }

    private void RequireRoot()
    {
        for (string? path = _root; path is not null; path = Path.GetDirectoryName(path))
        {
            if (new DirectoryInfo(path).LinkTarget is not null ||
                Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 ||
                File.Exists(path))
            {
                throw new AuthoringExtensionContractException("Grant root crosses a file or reparse boundary.");
            }
        }
    }

    private static void RequireRegularPath(string path)
    {
        if (new FileInfo(path).LinkTarget is not null || Directory.Exists(path) ||
            File.Exists(path) && (File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
        {
            throw new AuthoringExtensionContractException("Grant persistence requires regular non-reparse files.");
        }
    }

    private static void RequireField(string? value, int maximum)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximum || value != value.Trim() ||
            value.ContainsAny(['\0', '\r', '\n']))
        {
            throw new AuthoringExtensionContractException("Grant identity is missing or unbounded.");
        }
    }

    private static bool IsDigest(string? value) => value is { Length: 64 } &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void RequireDigest(string value)
    {
        if (!IsDigest(value))
        {
            throw new AuthoringExtensionContractException("Grant digest is not canonical SHA-256.");
        }
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new AuthoringExtensionContractException("Grant state repeats a JSON property.");
                }
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }

    private sealed record GrantState(
        int SchemaVersion, long Generation, ImmutableArray<GrantEntry> Grants, ImmutableArray<string> RevokedGrantIds);
    private sealed record GrantEntry(AuthoringCapabilityGrant Grant, bool Revoked);

    private sealed class StoreOwner(FileStream stream, SemaphoreSlim gate) : IDisposable
    {
        private int _released;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                try
                {
                    stream.Dispose();
                }
                catch (IOException)
                {
                    // Disposal only relinquishes exclusion; it grants no authority.
                }
                finally
                {
                    gate.Release();
                }
            }
        }
    }

    private sealed class GrantReadScope(AuthoringCapabilityGrant grant, IDisposable owner) : IAuthoringCapabilityGrantReadScope
    {
        private int _released;
        public AuthoringCapabilityGrant Grant
        {
            get
            {
                ObjectDisposedException.ThrowIf(Volatile.Read(ref _released) != 0, this);
                return grant;
            }
        }
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                owner.Dispose();
            }
        }
    }
}
