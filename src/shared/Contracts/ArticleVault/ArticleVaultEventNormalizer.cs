using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Normalizes validated native observations against complete supplied filesystem inventories.
/// No event arrival time, mtime, path similarity, server writer or filesystem I/O is consumed.
/// </summary>
public static class ArticleVaultEventNormalizer
{
    public const string Schema = "fsusblog.article-vault.observation-batch.v1";
    public const int MaxRawFacts = 512;
    public const int MaxFiles = 512;
    public const int MaxPathDepth = 32;
    public const int MaxEvents = 4096;

    /// <summary>
    /// Seals a finite window. Over-bound input is refused with split-required before processing;
    /// the caller retains every undelivered fact and must rescan if contiguous delivery is lost.
    /// All output remains observation-only until original native snapshots are available.
    /// </summary>
    public static VaultObservationBatch Normalize(
        ArticleVaultRootManifest root,
        VaultObservationBinding binding,
        VaultObservationWatermark before,
        IReadOnlyList<VaultRawObservation> rawFacts,
        IReadOnlyList<VaultFilesystemObservation> previousInventory,
        IReadOnlyList<VaultFilesystemObservation> currentInventory,
        IReadOnlyList<VaultRescanObligation> pendingRescans)
    {
        ValidateInputs(root, binding, before, rawFacts, previousInventory, currentInventory, pendingRescans);
        VaultRawObservation[] raw = rawFacts.Distinct().OrderBy(static item => item.Sequence)
            .ThenBy(static item => item.NativeFactSha256, StringComparer.Ordinal).ToArray();
        VaultRawSequenceCoverage[] coverage = raw.GroupBy(static item => item.Sequence)
            .Select(static group => new VaultRawSequenceCoverage(group.Key,
                group.Select(static item => item.NativeFactSha256).Distinct(StringComparer.Ordinal)
                    .Order(StringComparer.Ordinal).ToArray())).ToArray();
        var reasons = new SortedSet<string>(StringComparer.Ordinal);
        var events = new SortedDictionary<string, VaultNormalizedEvent>(StringComparer.Ordinal);
        if (coverage.Any(static item => item.NativeFactSha256s.Count != 1)
            || raw.GroupBy(static item => item.Sequence).Any(static group => group.Count() != 1))
        {
            reasons.Add("vault_observation_sequence_conflict");
        }

        long expectedSequence = before.LastSequence;
        foreach (VaultRawSequenceCoverage item in coverage)
        {
            if (expectedSequence == long.MaxValue || item.Sequence != expectedSequence + 1)
            {
                reasons.Add("vault_observation_sequence_gap");
            }

            expectedSequence = item.Sequence;
        }

        if (before.WatchInstanceIdentity != binding.WatchInstanceIdentity)
        {
            reasons.Add("vault_observation_watch_restart");
        }

        foreach (VaultRawObservation fact in raw)
        {
            if (fact.RescanRequired || !fact.WatermarkValid)
            {
                reasons.Add(fact.ReasonCode ?? "vault_observation_watermark_lost");
            }

            string? interruption = fact.Class switch
            {
                VaultRawObservationClass.Restarted => "vault_observation_watch_restart",
                VaultRawObservationClass.Overflow => "vault_observation_watch_overflow",
                VaultRawObservationClass.PermissionBlocked => "vault_observation_permission_blocked",
                VaultRawObservationClass.RootLost => "vault_observation_root_lost",
                VaultRawObservationClass.WatchInvalidated => "vault_observation_watch_invalidated",
                VaultRawObservationClass.Unknown => "vault_observation_unknown_event",
                _ => null
            };
            if (interruption is not null)
            {
                reasons.Add(interruption);
            }
        }

        VaultFilesystemObservation[] current = currentInventory.OrderBy(static item => item.RelativePath,
            StringComparer.Ordinal).ToArray();
        string[] paths = current.Select(static item => item.RelativePath).ToArray();
        var previous = previousInventory.ToDictionary(static item => item.RelativePath, StringComparer.Ordinal);
        foreach (VaultFilesystemObservation file in current)
        {
            VaultPathStructuralAnalysis path = ArticleVaultPathStructureValidator.Analyze(
                root, binding.Scope, file.RelativePath, paths);
            long[] sequences = Sequences(raw, file.RelativePath);
            string? identity = path.PortableArticleIdentity;
            if (path.Classification == VaultPathStructuralClass.RegisteredControlPath)
            {
                if (sequences.Length > 0)
                {
                    AddEvent(events, new(VaultNormalizedEventClass.MetadataSidecarChanged,
                        file.RelativePath, null, null, sequences, null,
                        "vault_observation_control_revalidation_required"));
                    reasons.Add("vault_observation_control_revalidation_required");
                }

                continue;
            }

            if (path.Classification == VaultPathStructuralClass.Blocked)
            {
                reasons.Add(path.ReasonCode ?? "vault_observation_path_blocked");
            }

            VaultPathStructuralAnalysis portablePath = ArticleVaultPathStructureValidator.Analyze(
                root, binding.Scope with
                {
                    ComparisonPolicy = VaultPathComparisonPolicy.CanonicalUnicodeIgnoreCase
                }, file.RelativePath, paths);
            foreach (VaultPathCollision collision in portablePath.Collisions)
            {
                reasons.Add(collision.ReasonCode);
                if (collision.RelativePaths.Contains(file.RelativePath, StringComparer.Ordinal))
                {
                    AddEvent(events, new(collision.ReasonCode == "vault_path_unicode_collision"
                        ? VaultNormalizedEventClass.UnicodeCollision : VaultNormalizedEventClass.CaseCollision,
                        file.RelativePath, null, identity, sequences, null, collision.ReasonCode));
                }
            }

            previous.TryGetValue(file.RelativePath, out VaultFilesystemObservation? old);
            if (!file.Present)
            {
                if (old?.Present == true)
                {
                    AddEvent(events, new(VaultNormalizedEventClass.Removed, file.RelativePath, null,
                        identity, sequences, null, null));
                }

                continue;
            }

            VaultSnapshotAssessment? snapshot = file.Assessment;
            if (snapshot is null || snapshot.State != VaultSnapshotAssessmentState.StableCandidate)
            {
                bool permission = snapshot?.State == VaultSnapshotAssessmentState.PermissionBlocked;
                string reason = snapshot?.ReasonCode ?? "vault_observation_snapshot_missing";
                reasons.Add(reason);
                AddEvent(events, new(permission ? VaultNormalizedEventClass.PermissionBlocked
                    : VaultNormalizedEventClass.IncompleteWrite, file.RelativePath, null,
                    identity, sequences, snapshot?.ContentSha256, reason));
                continue;
            }

            bool deleteSeen = raw.Any(item => item.RelativePath == file.RelativePath
                && item.Class == VaultRawObservationClass.Deleted);
            VaultNormalizedEventClass? change = old?.Present != true
                ? old is not null || deleteSeen ? VaultNormalizedEventClass.Reappeared : VaultNormalizedEventClass.Created
                : deleteSeen ? VaultNormalizedEventClass.Reappeared
                : old.Assessment?.Source?.Sha256 != snapshot.Source!.Sha256
                    ? VaultNormalizedEventClass.ContentChanged : null;
            if (change.HasValue)
            {
                AddEvent(events, new(change.Value, file.RelativePath, null, identity, sequences,
                    snapshot.ContentSha256, null));
            }
        }

        foreach (VaultFilesystemObservation old in previousInventory.Where(item => item.Present
            && current.All(currentFile => currentFile.RelativePath != item.RelativePath)))
        {
            reasons.Add("vault_observation_inventory_omission");
        }

        if (root.Articles.Any(article => !paths.Contains(article.RelativePath, StringComparer.Ordinal)))
        {
            reasons.Add("vault_observation_manifest_projection_omitted");
        }

        foreach (VaultRawObservation fact in raw.Where(static item => item.RelativePath is not null))
        {
            if (!paths.Contains(fact.RelativePath!, StringComparer.Ordinal))
            {
                reasons.Add("vault_observation_raw_path_unobserved");
            }
        }

        AddMoveCandidates(root, raw, current, events, reasons);
        string filesystemDigest = ComputeSnapshotSha256(current);
        if (ComputeSnapshotSha256(previousInventory) != before.FilesystemSnapshotSha256)
        {
            reasons.Add("vault_observation_previous_snapshot_mismatch");
        }

        var obligations = pendingRescans.ToList();
        if (reasons.Count > 0)
        {
            obligations.Add(ArticleVaultRescanTracker.Require(binding, binding.Scope.AgentIdentity,
                before, reasons.ToArray()));
            AddEvent(events, new(VaultNormalizedEventClass.RescanRequired, null, null, null,
                coverage.Select(static item => item.Sequence).ToArray(), null,
                "vault_observation_rescan_required"));
        }

        long lastSequence = coverage.Length == 0 ? before.LastSequence : Math.Max(before.LastSequence, coverage[^1].Sequence);
        var after = new VaultObservationWatermark(binding.WatchInstanceIdentity, lastSequence,
            filesystemDigest, before.PreviousBatchSha256);
        var batch = new VaultObservationBatch(Schema, 1, binding, coverage,
            coverage.Length == 0 ? null : coverage[0].Sequence,
            coverage.Length == 0 ? null : coverage[^1].Sequence, filesystemDigest,
            current.Where(static item => item.Assessment is not null)
                .Select(static item => item.Assessment!.ContentSha256).Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal).ToArray(),
            events.Values.ToArray(),
            obligations.DistinctBy(static item => item.ContentSha256)
                .OrderBy(static item => item.ContentSha256, StringComparer.Ordinal).ToArray(),
            before, after, string.Empty);
        return batch with
        {
            ContentSha256 = ComputeContentSha256(batch)
        };
    }

    /// <summary>Independently replays coverage, normalization and snapshot references from expected inputs.</summary>
    public static ArticleVaultValidationResult Verify(
        ArticleVaultRootManifest root,
        VaultObservationBinding binding,
        VaultObservationWatermark before,
        IReadOnlyList<VaultRawObservation> rawFacts,
        IReadOnlyList<VaultFilesystemObservation> previousInventory,
        IReadOnlyList<VaultFilesystemObservation> currentInventory,
        IReadOnlyList<VaultRescanObligation> pendingRescans,
        VaultObservationBatch? batch)
    {
        try
        {
            if (batch is null || !ArticleVaultManifestValidator.IsSha256(batch.ContentSha256))
            {
                return ArticleVaultValidationResult.Invalid("vault_observation_batch_invalid");
            }

            VaultObservationBatch expected = Normalize(root, binding, before, rawFacts,
                previousInventory, currentInventory, pendingRescans);
            return batch.ContentSha256 == expected.ContentSha256
                && batch.ContentSha256 == ComputeContentSha256(batch)
                ? ArticleVaultValidationResult.Valid()
                : ArticleVaultValidationResult.Invalid("vault_observation_batch_mismatch");
        }
        catch (Exception exception) when (exception is InvalidDataException or ArgumentException
            or System.Text.Json.JsonException)
        {
            return ArticleVaultValidationResult.Invalid("vault_observation_batch_invalid");
        }
    }

    public static string ComputeContentSha256(VaultObservationBatch batch)
        => Hash(ArticleVaultManifestCodec.SerializeCanonical(batch with
        {
            ContentSha256 = string.Empty
        }));

    /// <summary>Sorts the complete finite observation inventory; no omitted leaf is inferred absent.</summary>
    public static string ComputeSnapshotSha256(IReadOnlyList<VaultFilesystemObservation> inventory)
        => Hash(ArticleVaultManifestCodec.SerializeCanonical(inventory
            .OrderBy(static item => item.RelativePath, StringComparer.Ordinal).ToArray()));

    private static void ValidateInputs(
        ArticleVaultRootManifest root,
        VaultObservationBinding binding,
        VaultObservationWatermark before,
        IReadOnlyList<VaultRawObservation> raw,
        IReadOnlyList<VaultFilesystemObservation> previous,
        IReadOnlyList<VaultFilesystemObservation> current,
        IReadOnlyList<VaultRescanObligation> pending)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(raw);
        ArgumentNullException.ThrowIfNull(previous);
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(pending);
        if (raw.Count > MaxRawFacts || previous.Count > MaxFiles || current.Count > MaxFiles
            || pending.Count > MaxFiles || root.Articles.Count > MaxFiles)
        {
            throw new InvalidDataException("vault_observation_split_required");
        }

        if (!ArticleVaultPathStructureValidator.ValidateScope(root, binding.Scope).IsValid
            || !ArticleVaultManifestValidator.IsIdentity(binding.WatchInstanceIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(before.WatchInstanceIdentity)
            || before.LastSequence < 0
            || !ArticleVaultManifestValidator.IsSha256(before.FilesystemSnapshotSha256)
            || before.PreviousBatchSha256 is not null
                && !ArticleVaultManifestValidator.IsSha256(before.PreviousBatchSha256))
        {
            throw new InvalidDataException("vault_observation_binding_invalid");
        }

        foreach (VaultRawObservation fact in raw)
        {
            if (fact is null || fact.Sequence <= 0 || !Enum.IsDefined(fact.Class)
                || !ArticleVaultManifestValidator.IsSha256(fact.NativeFactSha256)
                || fact.ReasonCode is not null && !IsReason(fact.ReasonCode)
                || fact.MoveCookie.HasValue && fact.Class is not VaultRawObservationClass.MovedFrom
                    and not VaultRawObservationClass.MovedTo)
            {
                throw new InvalidDataException("vault_observation_raw_fact_invalid");
            }

            if (fact.RelativePath is not null)
            {
                ValidatePath(fact.RelativePath);
            }
        }

        foreach (IReadOnlyList<VaultFilesystemObservation> inventory in new[] { previous, current })
        {
            if (inventory.Any(static item => item is null)
                || inventory.GroupBy(static item => item.RelativePath, StringComparer.Ordinal)
                    .Any(static group => group.Count() != 1))
            {
                throw new InvalidDataException("vault_observation_inventory_duplicate");
            }

            foreach (VaultFilesystemObservation file in inventory)
            {
                ValidatePath(file.RelativePath);
                VaultSnapshotAssessment? snapshot = file.Assessment;
                if (!file.Present && snapshot is not null
                    || snapshot is not null && (snapshot.Scope != binding.Scope
                        || snapshot.PathProjection is null
                        || snapshot.PathProjection.RelativePath != file.RelativePath
                        || snapshot.Schema != ArticleVaultSnapshotAssessor.Schema
                        || snapshot.SchemaVersion != 1 || !Enum.IsDefined(snapshot.State)
                        || snapshot.ContentSha256 != ArticleVaultSnapshotAssessor.ComputeContentSha256(snapshot)
                        || snapshot.PathProjection.ProjectionSha256 != Hash(Encoding.UTF8.GetBytes(file.RelativePath))
                        || snapshot.State == VaultSnapshotAssessmentState.StableCandidate
                            && (snapshot.Source is null || !snapshot.SamplesAgree || !snapshot.CompletionBoundaryObserved
                                || !ArticleVaultManifestValidator.IsSha256(snapshot.Source.Sha256)
                                || snapshot.Source.ByteLength is <= 0 or > ArticleVaultSnapshotAssessor.MaxSourceBytes
                                || !Enum.IsDefined(snapshot.Source.NewlineStyle)
                                || snapshot.Source.TrailingWhitespaceLineCount < 0
                                || snapshot.FirstSourceSha256 != snapshot.Source.Sha256
                                || snapshot.SecondSourceSha256 != snapshot.Source.Sha256
                                || snapshot.Metadata is null || !snapshot.Metadata.IsRegularFile || !snapshot.Metadata.IsReadable
                                || snapshot.Metadata.ByteLength != snapshot.Source.ByteLength
                                || snapshot.PortableArticleIdentityCandidate != root.Articles
                                    .SingleOrDefault(item => item.RelativePath == file.RelativePath)?.PortableArticleIdentity)))
                {
                    throw new InvalidDataException("vault_observation_snapshot_reference_invalid");
                }
            }
        }

        foreach (VaultRescanObligation obligation in pending)
        {
            if (obligation is null || obligation.Binding != binding || !ArticleVaultRescanTracker.Validate(obligation))
            {
                throw new InvalidDataException("vault_observation_rescan_binding_invalid");
            }
        }
    }

    private static void AddMoveCandidates(
        ArticleVaultRootManifest root,
        VaultRawObservation[] raw,
        VaultFilesystemObservation[] current,
        SortedDictionary<string, VaultNormalizedEvent> events,
        SortedSet<string> reasons)
    {
        foreach (IGrouping<uint?, VaultRawObservation> group in raw.Where(static item => item.MoveCookie is > 0)
            .GroupBy(static item => item.MoveCookie).OrderBy(static group => group.Key))
        {
            VaultRawObservation[] from = group.Where(static item => item.Class == VaultRawObservationClass.MovedFrom).ToArray();
            VaultRawObservation[] to = group.Where(static item => item.Class == VaultRawObservationClass.MovedTo).ToArray();
            if (from.Length != 1 || to.Length != 1 || from[0].RelativePath is null || to[0].RelativePath is null)
            {
                reasons.Add("vault_observation_move_pair_ambiguous");
                continue;
            }

            string oldPath = from[0].RelativePath!;
            string newPath = to[0].RelativePath!;
            string? candidate = root.Articles.SingleOrDefault(item => item.RelativePath == oldPath)?.PortableArticleIdentity;
            VaultFilesystemObservation? target = current.SingleOrDefault(item => item.RelativePath == newPath);
            bool sameParent = Parent(oldPath) == Parent(newPath);
            AddEvent(events, new(sameParent ? VaultNormalizedEventClass.Renamed : VaultNormalizedEventClass.Moved,
                newPath, oldPath, candidate, group.Select(static item => item.Sequence).Order().ToArray(),
                target?.Assessment?.ContentSha256, "vault_observation_identity_resolution_required"));
            reasons.Add("vault_observation_identity_resolution_required");
        }

        if (raw.Any(static item => item.Class is VaultRawObservationClass.MovedFrom or VaultRawObservationClass.MovedTo
            && item.MoveCookie is null or 0))
        {
            reasons.Add("vault_observation_move_pair_missing");
        }
    }

    private static long[] Sequences(VaultRawObservation[] raw, string path)
        => raw.Where(item => item.RelativePath == path).Select(static item => item.Sequence).Distinct().Order().ToArray();

    private static string Parent(string path)
        => path.Contains('/') ? path[..path.LastIndexOf('/')] : string.Empty;

    private static string EventKey(VaultNormalizedEvent item)
        => Encoding.UTF8.GetString(ArticleVaultManifestCodec.SerializeCanonical(item));

    private static void AddEvent(SortedDictionary<string, VaultNormalizedEvent> events, VaultNormalizedEvent item)
    {
        string key = EventKey(item);
        if (!events.ContainsKey(key) && events.Count == MaxEvents)
        {
            throw new InvalidDataException("vault_observation_split_required");
        }

        events[key] = item;
    }

    private static void ValidatePath(string path)
    {
        if (!ArticleVaultPathStructureValidator.ValidateRelativePath(path).IsValid
            || path.Count(static character => character == '/') >= MaxPathDepth)
        {
            throw new InvalidDataException("vault_observation_path_bound_or_shape_invalid");
        }
    }

    private static bool IsReason(string reason)
        => reason.Length is > 0 and <= 256 && reason.All(static character => character is >= 'a' and <= 'z'
            or >= '0' and <= '9' or '_');

    private static string Hash(ReadOnlySpan<byte> bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));
}
