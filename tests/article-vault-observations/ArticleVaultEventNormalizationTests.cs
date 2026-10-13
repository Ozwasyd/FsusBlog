using System.Text;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.ArticleVault.Observations;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "ArticleVaultEventNormalization")]
public sealed class ArticleVaultEventNormalizationTests
{
    private const string PathA = "articles/first.md";
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public void DuplicateOutOfOrderFactsAndInventoryOrder_ProduceIdenticalBatch()
    {
        ArticleVaultRootManifest root = Root();
        VaultFilesystemObservation[] current = [Present(root, "complete")];
        VaultRawObservation first = Fact(1, VaultRawObservationClass.Created);
        VaultRawObservation second = Fact(2, VaultRawObservationClass.ClosedAfterWrite);
        VaultObservationBatch ordered = Normalize(root, [first, second], [], current);
        VaultObservationBatch reordered = Normalize(root, [second, first, first], [], current);
        Assert.Equal(ordered.ContentSha256, reordered.ContentSha256);
        Assert.Equal([1L, 2L], ordered.RawCoverage.Select(static item => item.Sequence));
        Assert.Single(ordered.Events, static item => item.Class == VaultNormalizedEventClass.Created);
        Assert.Empty(ordered.RescanObligations);
        Assert.False(ordered.CanAdmitSynchronization);
    }

    [Fact]
    public void SameFilesystemState_IgnoresNativeTimestampForNormalizedMeaning()
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBinding binding = Binding(root);
        LinuxVaultRawFact original = NativeFact(binding, 1, LinuxVaultFactClass.Modified);
        LinuxVaultRawFact later = LinuxVaultRawFactCodec.Seal(original with
        {
            TimestampUnixNanoseconds = 99999,
            MonotonicTimestampNanoseconds = 88888
        });
        VaultFilesystemObservation[] previous = [Present(root, "before")];
        VaultFilesystemObservation[] current = [Present(root, "after")];
        VaultObservationBatch first = Normalize(root, LinuxVaultObservationAdapter.Convert(binding, [original]), previous, current);
        VaultObservationBatch second = Normalize(root, LinuxVaultObservationAdapter.Convert(binding, [later]), previous, current);
        Assert.Equal(first.FilesystemSnapshotSha256, second.FilesystemSnapshotSha256);
        Assert.Equal(first.Events.Select(static item => (item.Class, item.RelativePath)),
            second.Events.Select(static item => (item.Class, item.RelativePath)));
        Assert.NotEqual(first.RawCoverage[0].NativeFactSha256s[0], second.RawCoverage[0].NativeFactSha256s[0]);
    }

    [Theory]
    [InlineData(VaultRawObservationClass.Overflow)]
    [InlineData(VaultRawObservationClass.Restarted)]
    [InlineData(VaultRawObservationClass.RootLost)]
    [InlineData(VaultRawObservationClass.WatchInvalidated)]
    [InlineData(VaultRawObservationClass.Unknown)]
    [InlineData(VaultRawObservationClass.PermissionBlocked)]
    public void NativeInterruption_AlwaysCreatesRootRescanAndBlocksAdmission(VaultRawObservationClass kind)
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBatch batch = Normalize(root, [Fact(1, kind) with { RelativePath = null }], [],
            [Present(root, "complete")]);
        VaultRescanObligation obligation = Assert.Single(batch.RescanObligations);
        Assert.Equal(string.Empty, obligation.ScopeRelativePath);
        Assert.Equal("agent", obligation.OwnerIdentity);
        Assert.Equal(Binding(root), obligation.Binding);
        Assert.True(obligation.BlocksSynchronization);
        Assert.True(ArticleVaultRescanTracker.Validate(obligation));
        Assert.Contains(batch.Events, static item => item.Class == VaultNormalizedEventClass.RescanRequired);
        Assert.False(batch.CanAdmitSynchronization);
    }

    [Fact]
    public void SequenceGapAndConflictingDuplicate_AreNeverSilentlyDropped()
    {
        ArticleVaultRootManifest root = Root();
        VaultRawObservation[] facts = [Fact(1, VaultRawObservationClass.Modified),
            Fact(3, VaultRawObservationClass.Modified), Fact(3, VaultRawObservationClass.Created)
                with { NativeFactSha256 = new string('b', 64) }];
        VaultObservationBatch batch = Normalize(root, facts, [], [Present(root, "complete")]);
        VaultRescanObligation rescan = Assert.Single(batch.RescanObligations);
        Assert.Contains("vault_observation_sequence_gap", rescan.ReasonCodes);
        Assert.Contains("vault_observation_sequence_conflict", rescan.ReasonCodes);
        Assert.Equal(2, batch.RawCoverage[1].NativeFactSha256s.Count);
    }

    [Fact]
    public void WatchInstanceRestartAndLostRawWatermark_CreateExactObligation()
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBinding binding = Binding(root);
        VaultRawObservation[] raw = [Fact(1, VaultRawObservationClass.Modified) with
        {
            WatermarkValid = false,
            RescanRequired = true,
            ReasonCode = "native_permission_drift"
        }];
        VaultObservationWatermark before = Watermark(binding, []) with
        {
            WatchInstanceIdentity = "previous-watch"
        };
        VaultObservationBatch batch = ArticleVaultEventNormalizer.Normalize(root, binding, before,
            raw, [], [Present(root, "complete")], []);
        VaultRescanObligation rescan = Assert.Single(batch.RescanObligations);
        Assert.Contains("vault_observation_watch_restart", rescan.ReasonCodes);
        Assert.Contains("native_permission_drift", rescan.ReasonCodes);
    }

    [Fact]
    public void TruncatePartialComplete_OnlyCompletedCandidateCanDescribeContentChange()
    {
        ArticleVaultRootManifest root = Root();
        VaultFilesystemObservation[] before = [Present(root, "old")];
        foreach (string partial in new[] { "", "first chunk" })
        {
            VaultObservationBatch batch = Normalize(root, [Fact(1, VaultRawObservationClass.Modified)], before,
                [Present(root, partial, completion: false)]);
            Assert.DoesNotContain(batch.Events, static item => item.Class == VaultNormalizedEventClass.ContentChanged);
            Assert.Contains(batch.Events, static item => item.Class == VaultNormalizedEventClass.IncompleteWrite);
            Assert.NotEmpty(batch.RescanObligations);
        }

        VaultObservationBatch complete = Normalize(root, [Fact(1, VaultRawObservationClass.ClosedAfterWrite)], before,
            [Present(root, "full complete")]);
        Assert.Contains(complete.Events, static item => item.Class == VaultNormalizedEventClass.ContentChanged);
        Assert.False(complete.CanAdmitSynchronization);
    }

    [Fact]
    public void TempSaveReplaceRenameStormAndMovedFile_RetainCandidateWithoutChoosingIdentity()
    {
        ArticleVaultRootManifest root = Root();
        VaultRawObservation[] raw =
        [
            Fact(1, VaultRawObservationClass.MovedFrom) with { MoveCookie = 3 },
            Fact(2, VaultRawObservationClass.MovedTo, "articles/temporary.md") with { MoveCookie = 3 },
            Fact(3, VaultRawObservationClass.MovedFrom, "articles/temporary.md") with { MoveCookie = 4 },
            Fact(4, VaultRawObservationClass.MovedTo, "elsewhere/final.md") with { MoveCookie = 4 }
        ];
        VaultFilesystemObservation[] current = [Missing(PathA), Missing("articles/temporary.md"),
            new("elsewhere/final.md", true, null)];
        VaultObservationBatch batch = Normalize(root, raw, [Present(root, "before")], current);
        VaultNormalizedEvent rename = Assert.Single(batch.Events, static item => item.Class == VaultNormalizedEventClass.Renamed);
        VaultNormalizedEvent move = Assert.Single(batch.Events, static item => item.Class == VaultNormalizedEventClass.Moved);
        Assert.Equal("portable-a", rename.PortableArticleIdentityCandidate);
        Assert.Null(move.PortableArticleIdentityCandidate);
        Assert.Equal("vault_observation_identity_resolution_required", rename.ReasonCode);
        Assert.NotEmpty(batch.RescanObligations);
        Assert.False(batch.CanAdmitSynchronization);
    }

    [Fact]
    public void AmbiguousAndUnpairedMoveCookies_RequireRescan()
    {
        ArticleVaultRootManifest root = Root();
        VaultRawObservation[] facts =
        [
            Fact(1, VaultRawObservationClass.MovedFrom) with { MoveCookie = 3 },
            Fact(2, VaultRawObservationClass.MovedFrom) with { MoveCookie = 3 },
            Fact(3, VaultRawObservationClass.MovedTo) with { MoveCookie = 3 },
            Fact(4, VaultRawObservationClass.MovedTo)
        ];
        VaultObservationBatch batch = Normalize(root, facts, [], [Present(root, "complete")]);
        VaultRescanObligation rescan = Assert.Single(batch.RescanObligations);
        Assert.Contains("vault_observation_move_pair_ambiguous", rescan.ReasonCodes);
        Assert.Contains("vault_observation_move_pair_missing", rescan.ReasonCodes);
        Assert.DoesNotContain(batch.Events, static item => item.Class is VaultNormalizedEventClass.Renamed or VaultNormalizedEventClass.Moved);
    }

    [Fact]
    public void DeleteReappear_UsesCurrentCompleteStateRatherThanArrivalOrder()
    {
        ArticleVaultRootManifest root = Root();
        VaultFilesystemObservation[] previous = [Present(root, "before")];
        VaultRawObservation deleted = Fact(1, VaultRawObservationClass.Deleted);
        VaultRawObservation created = Fact(2, VaultRawObservationClass.Created);
        VaultObservationBatch batch = Normalize(root, [created, deleted], previous, [Present(root, "after")]);
        Assert.Contains(batch.Events, static item => item.Class == VaultNormalizedEventClass.Reappeared);
        Assert.DoesNotContain(batch.Events, static item => item.Class == VaultNormalizedEventClass.Removed);
        VaultObservationBatch removed = Normalize(root, [deleted], previous, [Missing(PathA)]);
        Assert.Contains(removed.Events, static item => item.Class == VaultNormalizedEventClass.Removed);
    }

    [Fact]
    public void MissingUnreadableAndControlTreeChanges_RequireRescan()
    {
        ArticleVaultRootManifest root = Root();
        VaultFilesystemObservation blocked = Present(root, "complete", readable: false);
        VaultObservationBatch permission = Normalize(root, [Fact(1, VaultRawObservationClass.Modified)], [], [blocked]);
        Assert.Contains(permission.Events, static item => item.Class == VaultNormalizedEventClass.PermissionBlocked);
        VaultObservationBatch missing = Normalize(root, [], [Present(root, "before")], []);
        Assert.NotEmpty(missing.RescanObligations);
        VaultObservationBatch control = Normalize(root,
            [Fact(1, VaultRawObservationClass.Modified, ArticleVaultSchemas.RootManifestPath)], [],
            [Present(root, "complete"), new(ArticleVaultSchemas.RootManifestPath, true, null)]);
        Assert.Contains(control.Events, static item => item.Class == VaultNormalizedEventClass.MetadataSidecarChanged);
        Assert.NotEmpty(control.RescanObligations);
    }

    [Theory]
    [InlineData("articles/FIRST.md", VaultNormalizedEventClass.CaseCollision)]
    [InlineData("articles/cafe\u0301.md", VaultNormalizedEventClass.UnicodeCollision)]
    public void PortableCaseAndUnicodeCollisions_RequireRescanEvenOnOrdinalLinux(
        string collision, VaultNormalizedEventClass expected)
    {
        string canonical = expected == VaultNormalizedEventClass.UnicodeCollision ? "articles/café.md" : PathA;
        ArticleVaultRootManifest root = Root(canonical);
        VaultFilesystemObservation[] current = [new(canonical, true, null), new(collision, true, null)];
        VaultObservationBatch batch = Normalize(root, [], [], current);
        Assert.Contains(batch.Events, item => item.Class == expected);
        Assert.NotEmpty(batch.RescanObligations);
    }

    [Fact]
    public void IndependentReplay_RejectsResealedCoverageWatermarkScopeSnapshotAndEventTamper()
    {
        ArticleVaultRootManifest root = Root();
        VaultRawObservation[] raw = [Fact(1, VaultRawObservationClass.Created)];
        VaultFilesystemObservation[] current = [Present(root, "complete")];
        VaultObservationBatch batch = Normalize(root, raw, [], current);
        Assert.True(Verify(batch));
        foreach (VaultObservationBatch changed in new[]
        {
            batch with { RawCoverage = [] },
            batch with { Events = [] },
            batch with { FilesystemSnapshotSha256 = new string('b', 64) },
            batch with { SnapshotAssessmentSha256s = [] },
            batch with { WatermarkAfter = batch.WatermarkAfter with { LastSequence = 22 } },
            batch with { Binding = Binding(root) with { WatchInstanceIdentity = "other" } }
        })
        {
            VaultObservationBatch resealed = changed with
            {
                ContentSha256 = ArticleVaultEventNormalizer.ComputeContentSha256(changed)
            };
            Assert.False(Verify(resealed));
        }

        bool Verify(VaultObservationBatch value)
            => ArticleVaultEventNormalizer.Verify(root, Binding(root), Watermark(Binding(root), []),
                raw, [], current, [], value).IsValid;
    }

    [Fact]
    public void BoundDuplicateInventoryAndDeepPaths_AreRefusedWithoutDiscardingCallerFacts()
    {
        ArticleVaultRootManifest root = Root();
        VaultRawObservation[] facts = Enumerable.Range(1, ArticleVaultEventNormalizer.MaxRawFacts + 1)
            .Select(static sequence => Fact(sequence, VaultRawObservationClass.Modified)).ToArray();
        Assert.Equal("vault_observation_split_required", Assert.Throws<InvalidDataException>(() =>
            Normalize(root, facts, [], [Present(root, "complete")])).Message);
        Assert.Equal(ArticleVaultEventNormalizer.MaxRawFacts + 1, facts.Length);
        VaultFilesystemObservation file = Present(root, "complete");
        Assert.Throws<InvalidDataException>(() => Normalize(root, [], [], [file, file]));
        string deep = string.Join('/', Enumerable.Repeat("segment", ArticleVaultEventNormalizer.MaxPathDepth + 1));
        Assert.Throws<InvalidDataException>(() => Normalize(root,
            [Fact(1, VaultRawObservationClass.Modified, deep)], [], [file]));
    }

    [Fact]
    public void NativeAdapter_RejectsTamperAndCrossScopeRatherThanInventingValidFacts()
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBinding binding = Binding(root);
        LinuxVaultRawFact fact = NativeFact(binding, 1, LinuxVaultFactClass.Modified);
        Assert.Single(LinuxVaultObservationAdapter.Convert(binding, [fact]));
        Assert.Throws<InvalidDataException>(() => LinuxVaultObservationAdapter.Convert(binding,
            [fact with { AgentIdentity = "other" }]));
        Assert.Throws<InvalidDataException>(() => LinuxVaultObservationAdapter.Convert(binding,
            [fact with { RootManifestSha256 = null! }]));
        Assert.Throws<InvalidDataException>(() => LinuxVaultObservationAdapter.Convert(binding,
            [LinuxVaultRawFactCodec.Seal(fact with { AgentIdentity = "other" })]));
        LinuxVaultRawFact rootEvent = LinuxVaultRawFactCodec.Seal(fact with
        {
            RawNewRelativePath = string.Empty,
            PathDisposition = LinuxVaultPathDisposition.None,
            FactClass = LinuxVaultFactClass.AttributesChanged
        });
        VaultRawObservation projected = Assert.Single(LinuxVaultObservationAdapter.Convert(binding, [rootEvent]));
        Assert.True(projected.RescanRequired);
        Assert.False(projected.WatermarkValid);
        Assert.Null(projected.RelativePath);
    }

    [Fact]
    public void RescanAttempt_RequiresCompleteManifestTreeAndRemainsBlockedAfterStructuralCompletion()
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBinding binding = Binding(root);
        VaultRescanObligation required = ArticleVaultRescanTracker.Require(binding, "agent",
            Watermark(binding, []), ["native_overflow"]);
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.Begin(required, "other"));
        VaultRescanObligation running = ArticleVaultRescanTracker.Begin(required, "agent");
        Assert.Equal(1, running.Attempt);
        VaultFilesystemObservation[] current = [Present(root, "complete")];
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.CompleteStructuralScan(
            root, running, "agent", [PathA], [], []));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.CompleteStructuralScan(
            root, running, "agent", [PathA, PathA], current, []));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.CompleteStructuralScan(
            root, running, "agent", [PathA, "unknown.md"], [.. current, new("unknown.md", true, null)], []));
        VaultRescanObligation complete = ArticleVaultRescanTracker.CompleteStructuralScan(root, running,
            "agent", [PathA], current, []);
        Assert.Equal(VaultRescanState.AwaitingNativeVerification, complete.State);
        Assert.True(complete.BlocksSynchronization);
        Assert.Null(complete.NativeTerminalReceiptSha256);
        Assert.Equal(ArticleVaultEventNormalizer.ComputeSnapshotSha256(current), complete.ResultSnapshotSha256);
        Assert.True(ArticleVaultRescanTracker.VerifyStructuralScan(root, running, "agent", [PathA],
            current, [], complete).IsValid);
        VaultRescanObligation changed = complete with
        {
            ResultSnapshotSha256 = new string('b', 64)
        };
        changed = changed with
        {
            ContentSha256 = ArticleVaultRescanTracker.ComputeContentSha256(changed)
        };
        Assert.False(ArticleVaultRescanTracker.VerifyStructuralScan(root, running, "agent", [PathA],
            current, [], changed).IsValid);
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.Begin(complete, "agent"));
        VaultObservationBatch successor = Normalize(root, [], [], current, [complete]);
        Assert.Single(successor.RescanObligations);
        Assert.False(successor.CanAdmitSynchronization);
    }

    [Fact]
    public void OneFailedNativeScanRetainsEveryExactDenialWithoutTerminalPromotion()
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBinding binding = Binding(root);
        VaultRescanObligation running = ArticleVaultRescanTracker.Begin(
            ArticleVaultRescanTracker.Require(binding, "agent", Watermark(binding, []), ["native_overflow"]), "agent");
        VaultRescanObligation failed = ArticleVaultRescanTracker.Fail(running, "agent",
            ["vault_snapshot_permission_blocked", "vault_path_unknown_artifact", "vault_snapshot_permission_blocked"]);
        Assert.Equal(["native_overflow", "vault_path_unknown_artifact", "vault_snapshot_permission_blocked"], failed.ReasonCodes);
        Assert.Equal(VaultRescanState.Failed, failed.State);
        Assert.True(failed.BlocksSynchronization);
        Assert.Null(failed.NativeTerminalReceiptSha256);
        Assert.True(ArticleVaultRescanTracker.Validate(failed));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.Fail(running, "other", ["native_unreadable"]));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.Fail(running, "agent", Array.Empty<string>()));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.Fail(running, "agent", ["private source body"]));
        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.Fail(running, "agent",
            Enumerable.Repeat("native_unreadable", ArticleVaultEventNormalizer.MaxRawFacts + 1).ToArray()));
    }

    [Fact]
    public void RescanFailureRetriesAreBoundedAndNativeTerminalReceiptCannotBeForged()
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBinding binding = Binding(root);
        VaultRescanObligation receipt = ArticleVaultRescanTracker.Require(binding, "agent",
            Watermark(binding, []), ["native_overflow"]);
        for (int attempt = 0; attempt < ArticleVaultRescanTracker.MaxAttempts; attempt++)
        {
            receipt = ArticleVaultRescanTracker.Begin(receipt, "agent");
            receipt = ArticleVaultRescanTracker.Fail(receipt, "agent", "native_unreadable");
            Assert.True(receipt.BlocksSynchronization);
        }

        Assert.Throws<InvalidDataException>(() => ArticleVaultRescanTracker.Begin(receipt, "agent"));
        VaultRescanObligation forged = receipt with
        {
            NativeTerminalReceiptSha256 = Digest
        };
        forged = forged with
        {
            ContentSha256 = ArticleVaultRescanTracker.ComputeContentSha256(forged)
        };
        Assert.False(ArticleVaultRescanTracker.Validate(forged));
    }

    [Fact]
    public void ReplayedOldSequence_DoesNotMoveWatermarkBackward()
    {
        ArticleVaultRootManifest root = Root();
        VaultObservationBinding binding = Binding(root);
        VaultObservationWatermark before = Watermark(binding, []) with
        {
            LastSequence = 10
        };
        VaultObservationBatch batch = ArticleVaultEventNormalizer.Normalize(root, binding, before,
            [Fact(1, VaultRawObservationClass.Created)], [], [Present(root, "complete")], []);
        Assert.Equal(10, batch.WatermarkAfter.LastSequence);
        Assert.Contains(Assert.Single(batch.RescanObligations).ReasonCodes,
            static item => item == "vault_observation_sequence_gap");
    }

    [Theory]
    [InlineData("linux_vault_descriptor_permission_denied", VaultNormalizedEventClass.PermissionBlocked)]
    [InlineData("vault_snapshot_native_metadata_changed", VaultNormalizedEventClass.IncompleteWrite)]
    public void NativeReadDenials_RetainExactRescanReasonAndCannotBecomeRemovalOrOldContentChange(
        string reason, VaultNormalizedEventClass expected)
    {
        ArticleVaultRootManifest root = Root();
        VaultFilesystemObservation denied = new(PathA, false, null, reason);
        VaultObservationBatch batch = Normalize(root, [Fact(1, VaultRawObservationClass.Modified)],
            [Present(root, "old")], [denied]);
        Assert.Contains(batch.Events, item => item.Class == expected && item.ReasonCode == reason);
        Assert.Contains(reason, Assert.Single(batch.RescanObligations).ReasonCodes);
        Assert.DoesNotContain(batch.Events, static item => item.Class is VaultNormalizedEventClass.Removed
            or VaultNormalizedEventClass.ContentChanged);
        Assert.False(batch.CanAdmitSynchronization);
    }

    private static ArticleVaultRootManifest Root(params string[] paths)
        => ArticleVaultSnapshotAssessmentTests.CreateRoot(paths);

    private static VaultObservationBinding Binding(ArticleVaultRootManifest root)
        => new(ArticleVaultSnapshotAssessmentTests.Scope(root), "watch");

    private static VaultObservationWatermark Watermark(VaultObservationBinding binding,
        IReadOnlyList<VaultFilesystemObservation> previous)
        => new(binding.WatchInstanceIdentity, 0, ArticleVaultEventNormalizer.ComputeSnapshotSha256(previous), null);

    private static VaultRawObservation Fact(long sequence, VaultRawObservationClass kind, string path = PathA)
        => new(sequence, kind, path, null, false, true, null, Digest);

    private static VaultFilesystemObservation Missing(string path)
        => new(path, false, null);

    private static VaultFilesystemObservation Present(ArticleVaultRootManifest root, string source,
        bool completion = true, bool readable = true)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(source);
        VaultFileMetadataObservation metadata = ArticleVaultSnapshotAssessmentTests.Metadata(bytes.Length)
            with
        {
            IsReadable = readable
        };
        string path = root.Articles[0].RelativePath;
        VaultSnapshotAssessment assessment = ArticleVaultSnapshotAssessor.Assess(root,
            Binding(root).Scope, path, [], metadata, bytes, metadata, bytes, completion);
        return new(path, true, assessment);
    }

    private static VaultObservationBatch Normalize(ArticleVaultRootManifest root,
        IReadOnlyList<VaultRawObservation> raw, IReadOnlyList<VaultFilesystemObservation> previous,
        IReadOnlyList<VaultFilesystemObservation> current, IReadOnlyList<VaultRescanObligation>? pending = null)
        => ArticleVaultEventNormalizer.Normalize(root, Binding(root), Watermark(Binding(root), previous),
            raw, previous, current, pending ?? []);

    private static LinuxVaultRawFact NativeFact(VaultObservationBinding binding, long sequence, LinuxVaultFactClass kind)
        => LinuxVaultRawFactCodec.Seal(new LinuxVaultRawFact(LinuxVaultWatcherSchemas.RawFact, 1, "linux", "ext4",
            binding.Scope.SiteIdentity, binding.Scope.VaultIdentity, binding.Scope.DeviceIdentity,
            binding.Scope.AgentIdentity, binding.Scope.RootIdentitySha256, binding.Scope.RootManifestSha256,
            binding.WatchInstanceIdentity, sequence, 2, kind, null, null, PathA, 1, 1,
            LinuxVaultPathDisposition.Source, null, false, true, string.Empty));
}
