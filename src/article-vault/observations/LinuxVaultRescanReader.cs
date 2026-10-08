using System.Collections.Immutable;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Observations;

/// <summary>Records a provisional tree leaf or directory, without selecting an article identity.</summary>
public sealed record LinuxVaultTreeEntry(string RelativePath, byte TypeHint);

/// <summary>Retains a bounded real scan attempt; neither enumeration nor supplied close facts release admission.</summary>
public sealed class LinuxVaultRescanResult
{
    internal LinuxVaultRescanResult(VaultRescanObligation obligation, ImmutableArray<LinuxVaultTreeEntry> tree,
        ImmutableArray<VaultFilesystemObservation> observations, bool enumerated, string reasonCode)
    {
        Obligation = obligation;
        Tree = tree;
        Observations = observations;
        TreeEnumerationCompleted = enumerated;
        ReasonCode = reasonCode;
        ContentSha256 = ArticleVaultLocalPreparationDigestCodec.ComputeRescanSha256(obligation,
            tree.Where(static entry => entry.TypeHint == 4).Select(static entry => entry.RelativePath).ToArray(),
            tree.Where(static entry => entry.TypeHint == 8).Select(static entry => entry.RelativePath).ToArray(),
            observations, enumerated, reasonCode);
    }

    public VaultRescanObligation Obligation
    {
        get;
    }
    public ImmutableArray<LinuxVaultTreeEntry> Tree
    {
        get;
    }
    public ImmutableArray<VaultFilesystemObservation> Observations
    {
        get;
    }
    public bool TreeEnumerationCompleted
    {
        get;
    }
    public string ReasonCode
    {
        get;
    }
    public string ContentSha256
    {
        get;
    }
    public bool RequiresNativeTerminalVerification => true;
    public bool CanAdmitSynchronization => false;
}

/// <summary>
/// Rebuilds a bounded source inventory from the actual #2109 root-issued directory API and #2110
/// reader. Two tree passes and per-directory metadata reject observed drift, but do not prove a
/// watch-event cut or no external writer. A structural result still awaits a real terminal receipt.
/// </summary>
public sealed class LinuxVaultRescanReader
{
    public const int MaximumDirectories = 128;
    public const int MaximumTreeEntries = 1024;
    public const int MaximumDepth = 16;
    public const int MaximumDirectoryReads = 512;
    public const int MaximumObservedSourceBytes = 64 * 1024 * 1024;
    private readonly LinuxVaultRootPathScope _scope;
    private readonly ArticleVaultRootManifest _manifest;
    private readonly LinuxVaultSnapshotReader _reader;

    public LinuxVaultRescanReader(LinuxVaultRootPathScope scope, ArticleVaultRootManifest manifest)
    {
        _reader = new(scope, manifest);
        _scope = scope;
        _manifest = ArticleVaultManifestCodec.DeserializeRoot(ArticleVaultManifestCodec.Serialize(manifest));
    }

    /// <summary>Consumes a running same-owner obligation; failed or incomplete attempts remain mandatory.</summary>
    public LinuxVaultRescanResult Scan(VaultRescanObligation running, string ownerIdentity,
        IReadOnlyList<VaultFilesystemObservation> previousVerifiedInventory,
        IReadOnlyList<LinuxVaultRawFact> completionCandidates, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(running);
        ArgumentNullException.ThrowIfNull(previousVerifiedInventory);
        ArgumentNullException.ThrowIfNull(completionCandidates);
        if (!ArticleVaultRescanTracker.Validate(running) || running.OwnerIdentity != ownerIdentity
            || running.State != VaultRescanState.Running || running.Binding.Scope != _scope.Scope
            || _manifest.Articles.Count > ArticleVaultEventNormalizer.MaxFiles
            || previousVerifiedInventory.Count > ArticleVaultEventNormalizer.MaxFiles
            || previousVerifiedInventory.Any(static item => item is null)
            || completionCandidates.Count > ArticleVaultEventNormalizer.MaxFiles
            || completionCandidates.Any(static item => item is null))
        {
            throw new InvalidDataException("vault_rescan_native_request_invalid");
        }

        running = running with
        {
            ReasonCodes = running.ReasonCodes.ToImmutableArray()
        };
        VaultFilesystemObservation[] previous = previousVerifiedInventory.ToArray();
        LinuxVaultRawFact[] completions = completionCandidates.ToArray();
        ImmutableArray<LinuxVaultTreeEntry> tree = [];
        ImmutableArray<VaultFilesystemObservation> observations = [];
        bool enumerated = false;
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            tree = Enumerate(cancellationToken);
            string[] leaves = tree.Where(static entry => entry.TypeHint == 8)
                .Select(static entry => entry.RelativePath).ToArray();
            if (leaves.Length > ArticleVaultEventNormalizer.MaxFiles)
            {
                throw new InvalidDataException("vault_rescan_source_count_bound_exceeded");
            }

            var current = ImmutableArray.CreateBuilder<VaultFilesystemObservation>();
            int observedSourceBytes = 0;
            foreach (string path in leaves.Concat(_manifest.Articles.Select(static item => item.RelativePath))
                .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (current.Count >= ArticleVaultEventNormalizer.MaxFiles)
                {
                    throw new InvalidDataException("vault_rescan_source_count_bound_exceeded");
                }

                if (!leaves.Contains(path, StringComparer.Ordinal))
                {
                    current.Add(new(path, false, null));
                    continue;
                }

                LinuxVaultRawFact? completion = completions.Where(fact => fact.RawNewRelativePath == path
                    && fact.WatchInstanceIdentity == running.Binding.WatchInstanceIdentity)
                    .OrderByDescending(static fact => fact.Sequence)
                    .ThenBy(static fact => fact.ContentSha256, StringComparer.Ordinal).FirstOrDefault();
                int remaining = Math.Min(ArticleVaultSnapshotAssessor.MaxSourceBytes,
                    MaximumObservedSourceBytes - observedSourceBytes);
                LinuxVaultSnapshotReadResult read = _reader.ReadBounded(path, leaves, completion, remaining, cancellationToken);
                // Failed reads without metadata reserve the full attempted bound instead of allowing
                // repeated failed large samples to bypass the inventory budget.
                observedSourceBytes += checked((int)(read.Assessment?.Metadata?.ByteLength ?? remaining));
                current.Add(read.ToFilesystemObservation());
            }

            observations = current.ToImmutable();
            ImmutableArray<LinuxVaultTreeEntry> after = Enumerate(cancellationToken);
            if (!tree.SequenceEqual(after))
            {
                throw new InvalidDataException("vault_rescan_tree_changed");
            }

            enumerated = true;
            VaultRescanObligation result = ArticleVaultRescanTracker.CompleteStructuralScan(_manifest, running,
                ownerIdentity, leaves, observations, previous);
            return new(result, tree, observations, true, "vault_rescan_native_terminal_verification_required");
        }
        catch (LinuxVaultWatcherException exception)
        {
            return Failure(exception.ReasonCode);
        }
        catch (InvalidDataException exception)
        {
            return Failure(exception.Message);
        }
        catch (UnauthorizedAccessException)
        {
            return Failure("vault_rescan_directory_permission_blocked");
        }
        catch (IOException)
        {
            return Failure("vault_rescan_native_io_failed");
        }
        catch (ObjectDisposedException)
        {
            return Failure("vault_rescan_native_scope_closed");
        }
        catch (PlatformNotSupportedException)
        {
            return Failure("vault_rescan_native_platform_unsupported");
        }

        LinuxVaultRescanResult Failure(string reason)
        {
            string[] reasons = observations.Select(static item => item.NativeFailureReasonCode
                ?? (item.Assessment?.State != VaultSnapshotAssessmentState.StableCandidate ? item.Assessment?.ReasonCode : null))
                .OfType<string>().Append(reason).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
            return new(ArticleVaultRescanTracker.Fail(running, ownerIdentity, reasons), tree, observations, enumerated, reason);
        }
    }

    private ImmutableArray<LinuxVaultTreeEntry> Enumerate(CancellationToken cancellationToken)
    {
        var pending = new SortedSet<string>(StringComparer.Ordinal) { "." };
        var tree = new SortedDictionary<string, LinuxVaultTreeEntry>(StringComparer.Ordinal);
        byte[] buffer = new byte[LinuxVaultDirectoryRecordCodec.MaximumBufferBytes];
        int directories = 0;
        int reads = 0;
        while (pending.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string parent = pending.Min!;
            pending.Remove(parent);
            if (++directories > MaximumDirectories)
            {
                throw new InvalidDataException("vault_rescan_directory_count_bound_exceeded");
            }

            using SafeFileHandle descriptor = _scope.OpenDirectoryForEnumeration(parent);
            _scope.RevalidateForUse(descriptor);
            LinuxVaultRescanNative.DirectoryStamp before = LinuxVaultRescanNative.ObserveDirectory(descriptor);
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (++reads > MaximumDirectoryReads)
                {
                    throw new InvalidDataException("vault_rescan_directory_read_bound_exceeded");
                }

                _scope.RevalidateForUse(descriptor);
                int count = LinuxVaultRescanNative.ReadDirectory(descriptor, buffer);
                if (count == 0)
                {
                    break;
                }

                foreach (LinuxVaultDirectoryEntry entry in LinuxVaultDirectoryRecordCodec.Decode(buffer.AsSpan(0, count)))
                {
                    if (parent == "." && entry.Name == ".fsus" && entry.TypeHint == 4)
                    {
                        continue;
                    }

                    string path = parent == "." ? entry.Name : parent + "/" + entry.Name;
                    ArticleVaultValidationResult validation = ArticleVaultPathStructureValidator.ValidateRelativePath(path);
                    if (!validation.IsValid || entry.Name.Equals(".fsus", StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("vault_rescan_tree_path_blocked");
                    }

                    if (path.Count(static character => character == '/') >= MaximumDepth
                        || tree.Count >= MaximumTreeEntries || !tree.TryAdd(path, new(path, entry.TypeHint)))
                    {
                        throw new InvalidDataException("vault_rescan_tree_bound_or_duplicate");
                    }

                    if (entry.TypeHint == 4)
                    {
                        pending.Add(path);
                    }
                    else if (entry.TypeHint != 8)
                    {
                        throw new InvalidDataException("vault_rescan_tree_kind_unproven_or_blocked");
                    }
                }
            }

            _scope.RevalidateForUse(descriptor);
            if (before != LinuxVaultRescanNative.ObserveDirectory(descriptor))
            {
                throw new InvalidDataException("vault_rescan_directory_changed");
            }
        }

        return tree.Values.ToImmutableArray();
    }
}
