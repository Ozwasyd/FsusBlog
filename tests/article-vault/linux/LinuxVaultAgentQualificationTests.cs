using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

/// <summary>
/// Issue #2675: seals the Linux filesystem-agent qualification on real ext4 + inotify.
/// Real under test: the merged #2672 <see cref="LinuxVaultWatcherSession"/> (libc inotify),
/// real ext4 bytes, renames, mounts and process kills, and the real shared contracts
/// (<see cref="ArticleVaultManifestCodec"/>, <see cref="ArticleVaultManifestValidator"/>,
/// <see cref="ArticleVaultSyncPlanner"/>, <see cref="ArticleVaultSyncPlanVerifier"/>).
/// Dependency issues #2110, #2112, #2113 and #2114 are still open, so their layers are
/// simulated inside this harness at contract level (declared in
/// artifacts/article-vault/linux-agent-qualification.json); every simulation drives real
/// ext4 state. #1909's planner is real; its server-authority side does not exist yet and
/// is represented by explicit observation/materialization receipts. No mock replaces the
/// filesystem, the watcher, or the sealed contracts.
/// </summary>
[Trait("Category", "LinuxArticleVaultAgentQualification")]
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultAgentQualificationTests : IClassFixture<LinuxVaultQualificationFixture>
{
    private const string AgentIdentity = "linux-vault-agent-qualification";
    private readonly LinuxVaultQualificationFixture _fixture;

    public LinuxVaultAgentQualificationTests(LinuxVaultQualificationFixture fixture)
        => _fixture = fixture;

    private void Check(string caseId, string checkId, bool condition, string detail)
    {
        _fixture.Evidence.Record(caseId, checkId, condition, detail);
        Assert.True(condition, $"{caseId}/{checkId}: {detail}");
    }

    [Fact]
    public void RealExt4_CaseUnicodeAndByteIdentities_AreObservedExactly()
    {
        const string CaseId = "ext4-semantics";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        agent.Start();

        Check(CaseId, "filesystem-ext4", agent.Session.Identity.Filesystem.FileSystemType == "ext4",
            $"filesystem={agent.Session.Identity.Filesystem.FileSystemType}");
        Check(CaseId, "case-sensitive", agent.Session.Identity.Filesystem.CaseSensitive, "ext4 is case sensitive");
        Check(CaseId, "unicode-none", agent.Session.Identity.Filesystem.UnicodeNormalization == "none",
            "ext4 performs no unicode normalization");

        agent.WriteSource("Article.md", "case-variant-a\n");
        agent.WriteSource("article.md", "case-variant-b\n");
        agent.WriteSource("café.md", "unicode-nfc\n");
        agent.WriteSource("café.md", "unicode-nfd\n");
        IReadOnlyList<LinuxVaultRawFact> facts = agent.DrainUntil(
            item => item.RawNewRelativePath == "café.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);

        foreach (string expected in new[] { "Article.md", "article.md", "café.md", "café.md" })
        {
            Check(CaseId, $"distinct-source-{expected}", facts.Any(item =>
                item.RawNewRelativePath == expected
                && item.PathDisposition == LinuxVaultPathDisposition.Source), expected);
        }

        AgentObservationBatch batch = agent.Normalize(facts);
        Check(CaseId, "case-collision", batch.Items.Any(item =>
            item.Kind == AgentObservationKind.CaseCollision
            && item.RelativePath == "article.md"), "Article.md/article.md fold equal");
        Check(CaseId, "unicode-collision", batch.Items.Any(item =>
            item.Kind == AgentObservationKind.UnicodeCollision
            && item.RelativePath == "café.md"), "NFC/NFD names fold equal under NFC");

        Dictionary<string, VaultNewlineStyle> newlineFixtures = new()
        {
            ["lf.md"] = VaultNewlineStyle.Lf,
            ["crlf.md"] = VaultNewlineStyle.CrLf,
            ["bom-crlf.md"] = VaultNewlineStyle.CrLf,
            ["mixed.md"] = VaultNewlineStyle.Mixed,
            ["noeol.md"] = VaultNewlineStyle.None
        };
        agent.WriteSourceBytes("lf.md", "alpha\nbeta\n"u8.ToArray());
        agent.WriteSourceBytes("crlf.md", "alpha\r\nbeta\r\n"u8.ToArray());
        agent.WriteSourceBytes("bom-crlf.md", [0xef, 0xbb, 0xbf, .. "a\r\n"u8]);
        agent.WriteSourceBytes("mixed.md", "alpha\r\nbeta\n"u8.ToArray());
        agent.WriteSourceBytes("noeol.md", "alpha"u8.ToArray());
        IReadOnlyList<LinuxVaultRawFact> written = agent.DrainUntil(
            item => item.RawNewRelativePath == "noeol.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);

        foreach ((string path, VaultNewlineStyle style) in newlineFixtures)
        {
            VaultSourceByteIdentity? identity = agent.StableRead(path, written);
            Check(CaseId, $"byte-identity-{path}", identity is not null, "stable read admitted");
            if (identity is not null)
            {
                Check(CaseId, $"newline-{path}", identity.NewlineStyle == style,
                    $"expected={style} actual={identity.NewlineStyle}");
            }
        }

        Check(CaseId, "bom-detected", agent.StableRead("bom-crlf.md", written)?.HasUtf8Bom == true, "UTF-8 BOM captured");
        Check(CaseId, "noeol-final-newline", agent.StableRead("noeol.md", written)?.HasFinalNewline == false,
            "missing final newline captured");
        Assert.All(facts.Concat(written), static item => Assert.True(LinuxVaultRawFactCodec.Validate(item)));
    }

    [Fact]
    public void RealExt4_RenameMoveReplaceTruncateAndDelete_KeepRawOrdering()
    {
        const string CaseId = "mutation-sequences";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        agent.Start();

        agent.WriteSource("one.md", "first\n");
        IReadOnlyList<LinuxVaultRawFact> created = agent.DrainUntil(
            item => item.RawNewRelativePath == "one.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        Check(CaseId, "create-observed", created.Any(item =>
            item.RawNewRelativePath == "one.md" && item.FactClass == LinuxVaultFactClass.Created), "create");

        Directory.CreateDirectory(Path.Combine(root.Path, "nested"));
        _ = agent.DrainUntil(item => item.RawNewRelativePath == "nested" && item.FactClass == LinuxVaultFactClass.Created);
        File.Move(Path.Combine(root.Path, "one.md"), Path.Combine(root.Path, "nested", "one.md"));
        IReadOnlyList<LinuxVaultRawFact> moved = agent.DrainUntil(
            item => item.RawNewRelativePath == "nested/one.md" && item.FactClass == LinuxVaultFactClass.MovedTo);
        LinuxVaultRawFact movedFrom = Assert.Single(moved, item =>
            item.RawOldRelativePath == "one.md" && item.FactClass == LinuxVaultFactClass.MovedFrom);
        LinuxVaultRawFact movedTo = Assert.Single(moved, item =>
            item.RawNewRelativePath == "nested/one.md" && item.FactClass == LinuxVaultFactClass.MovedTo);
        Check(CaseId, "move-cookie-paired", movedFrom.CookieDiagnostic == movedTo.CookieDiagnostic
            && movedFrom.CookieDiagnostic is not null, "cookie diagnostics pair exactly");

        agent.WriteSourceBytes("one.tmp", "replacement\n"u8.ToArray());
        _ = agent.DrainUntil(item => item.RawNewRelativePath == "one.tmp" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        File.Move(Path.Combine(root.Path, "one.tmp"), Path.Combine(root.Path, "nested", "one.md"), overwrite: true);
        IReadOnlyList<LinuxVaultRawFact> replaced = agent.DrainUntil(
            item => item.RawNewRelativePath == "nested/one.md" && item.FactClass == LinuxVaultFactClass.MovedTo);
        Check(CaseId, "replace-atomic", replaced.Any(item =>
            item.RawOldRelativePath == "one.tmp" && item.FactClass == LinuxVaultFactClass.MovedFrom),
            "temp rename replace observed");

        using (var stream = new FileStream(Path.Combine(root.Path, "nested", "one.md"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
        {
            stream.SetLength(2);
            stream.Flush(flushToDisk: true);
        }

        IReadOnlyList<LinuxVaultRawFact> truncated = agent.DrainUntil(
            item => item.RawNewRelativePath == "nested/one.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        Check(CaseId, "truncate-observed", truncated.Any(item =>
            item.RawNewRelativePath == "nested/one.md" && item.FactClass == LinuxVaultFactClass.Modified), "truncate");

        File.Delete(Path.Combine(root.Path, "nested", "one.md"));
        IReadOnlyList<LinuxVaultRawFact> deleted = agent.DrainUntil(
            item => item.RawNewRelativePath == "nested/one.md" && item.FactClass == LinuxVaultFactClass.Deleted);
        Check(CaseId, "delete-observed", deleted.Any(item =>
            item.PathDisposition == LinuxVaultPathDisposition.MissingEntry), "delete audited as missing entry");

        long[] sequences = created.Concat(moved).Concat(replaced).Concat(truncated).Concat(deleted)
            .Select(static item => item.Sequence).ToArray();
        Check(CaseId, "monotonic-sequence", sequences.Order().Distinct().SequenceEqual(sequences),
            "fact sequences strictly increase");
    }

    [Fact]
    public void StableRead_PartialAndTruncatedWrites_AreNeverAdmitted()
    {
        const string CaseId = "stable-read-gate";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        agent.Start();

        string path = Path.Combine(root.Path, "partial.md");
        var writer = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        try
        {
            writer.Write("half"u8);
            writer.Flush(flushToDisk: true);
            IReadOnlyList<LinuxVaultRawFact> partial = agent.DrainUntil(
                item => item.RawNewRelativePath == "partial.md" && item.FactClass == LinuxVaultFactClass.Modified);
            Check(CaseId, "partial-modify-observed", partial.Any(item => item.FactClass == LinuxVaultFactClass.Modified),
                "kernel observed the half-written bytes");
            Check(CaseId, "partial-not-admitted", agent.StableRead("partial.md", partial) is null,
                "no close proof means incomplete-write, never admitted");
            Check(CaseId, "partial-batch-incomplete", agent.Normalize(partial).Items.Any(item =>
                item.Kind == AgentObservationKind.IncompleteWrite && item.RelativePath == "partial.md"),
                "normalized batch reports incomplete-write");
        }
        finally
        {
            writer.Write("-complete"u8);
            writer.Dispose();
        }

        IReadOnlyList<LinuxVaultRawFact> closed = agent.DrainUntil(
            item => item.RawNewRelativePath == "partial.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        VaultSourceByteIdentity? admitted = agent.StableRead("partial.md", closed);
        Check(CaseId, "closed-admitted", admitted is not null, "close proof admits the stable snapshot");
        Check(CaseId, "closed-content-exact", admitted?.Sha256 ==
            ArticleVaultManifestCodec.ComputeSha256(File.ReadAllBytes(path)), "admitted digest equals final bytes");

        // Parent counter-example: an editor truncates to zero then rewrites; the agent must
        // never admit the empty intermediate body.
        var editor = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        try
        {
            IReadOnlyList<LinuxVaultRawFact> truncated = agent.DrainUntil(
                item => item.RawNewRelativePath == "partial.md" && item.FactClass == LinuxVaultFactClass.Modified);
            Check(CaseId, "empty-body-not-admitted", agent.StableRead("partial.md", truncated) is null,
                "truncated intermediate state is not admitted");
            Assert.Equal(0, new FileInfo(path).Length);
        }
        finally
        {
            editor.Write("restored-body\n"u8);
            editor.Dispose();
        }

        IReadOnlyList<LinuxVaultRawFact> rewritten = agent.DrainUntil(
            item => item.RawNewRelativePath == "partial.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        VaultSourceByteIdentity? restored = agent.StableRead("partial.md", rewritten);
        Check(CaseId, "restored-admitted-exact", restored is not null
            && restored.Sha256 == ArticleVaultManifestCodec.CaptureSourceBytes("restored-body\n"u8).Sha256,
            "only the complete rewrite is admitted");
        Check(CaseId, "empty-digest-never-admitted", restored?.Sha256 !=
            ArticleVaultManifestCodec.CaptureSourceBytes(ReadOnlySpan<byte>.Empty).Sha256,
            "empty-body digest was never admitted");
    }

    [Fact]
    public void ObservationBatch_DuplicatesOutOfOrderAndCoalescing_NormalizeDeterministically()
    {
        const string CaseId = "normalization-determinism";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        agent.Start();

        for (int index = 0; index < 5; index++)
        {
            File.AppendAllText(Path.Combine(root.Path, "burst.md"), $"line-{index}\n");
        }

        File.Move(Path.Combine(root.Path, "burst.md"), Path.Combine(root.Path, "burst-renamed.md"));
        IReadOnlyList<LinuxVaultRawFact> facts = agent.DrainUntil(
            item => item.RawNewRelativePath == "burst-renamed.md" && item.FactClass == LinuxVaultFactClass.MovedTo);

        AgentObservationBatch batch = agent.Normalize(facts);
        AgentObservationBatch replay = agent.Normalize(facts);
        Check(CaseId, "deterministic-digest", batch.SnapshotSha256 == replay.SnapshotSha256
            && batch.Items.SequenceEqual(replay.Items)
            && batch.FactWatermark == replay.FactWatermark,
            "same raw facts normalize to the same sealed content");
        Check(CaseId, "duplicates-coalesced", batch.Items.Count(item =>
            item.Kind == AgentObservationKind.ContentChanged && item.RelativePath == "burst.md") == 1,
            "duplicate modify facts collapse deterministically");
        Check(CaseId, "rename-paired", batch.Items.Any(item =>
            item.Kind == AgentObservationKind.Renamed
            && item.OldRelativePath == "burst.md"
            && item.RelativePath == "burst-renamed.md"), "cookie-paired rename");
        Check(CaseId, "bound-identities", batch.RootIdentity == agent.Session.Identity.RootIdentity
            && batch.WatchInstanceIdentity == agent.Session.Identity.WatchInstanceIdentity
            && batch.FactWatermark == facts.Max(static item => item.Sequence),
            "batch binds root, watch instance and exact fact watermark");

        var random = new Random(2675);
        LinuxVaultRawFact[] shuffled = facts.OrderBy(_ => random.Next()).ToArray();
        AgentObservationBatch reordered = agent.Normalize(shuffled);
        Check(CaseId, "out-of-order-equal", reordered.SnapshotSha256 == batch.SnapshotSha256
            && reordered.Items.SequenceEqual(batch.Items),
            "out-of-order delivery normalizes to the identical batch");
    }

    [Fact]
    public void RescanObligations_ForcedByOverflowInvalidationRootMoveRestartAndCollision_RebuildWatermarkExactly()
    {
        const string CaseId = "rescan-obligations";

        // Bounded user-space queue overflow: facts are dropped and rescan is forced.
        using (LinuxVaultTestRoot root = LinuxVaultTestRoot.Create())
        using (var agent = new LinuxVaultAgentHarness(root, AgentIdentity, new LinuxVaultWatcherOptions(MaxFactsPerRead: 8, MaxWatches: 64)))
        {
            agent.Install();
            agent.Start();
            for (int index = 0; index < 24; index++)
            {
                agent.WriteSource($"bounded-{index}.md", "x");
            }

            IReadOnlyList<LinuxVaultRawFact> overflow = agent.DrainUntil(
                item => item.FactClass == LinuxVaultFactClass.QueueOverflow);
            Check(CaseId, "overflow-rescan-required", overflow.Any(item =>
                item.RescanRequired && item.ErrorCode == "linux_vault_user_queue_bound_exceeded"),
                "dropped facts force rescan");
            Check(CaseId, "overflow-admission-closed", !agent.TryAdmitClean(overflow),
                "no-change claim is rejected while the watermark is invalid");
            agent.Rescan();
            Check(CaseId, "overflow-watermark-exact", agent.Session.Watermark.IsValid
                && agent.Session.Watermark.LastSequence == agent.LastFactSequence
                && agent.Session.Watermark.RescanReceiptSha256 == agent.LastRescanReceiptSha256,
                "rebuilt watermark binds the rescan receipt exactly");
        }

        // Watch invalidation on a nested directory.
        using (LinuxVaultTestRoot root = LinuxVaultTestRoot.Create())
        using (var agent = new LinuxVaultAgentHarness(root, AgentIdentity))
        {
            Directory.CreateDirectory(Path.Combine(root.Path, "nested"));
            agent.Install();
            agent.Start();
            Directory.Delete(Path.Combine(root.Path, "nested"));
            IReadOnlyList<LinuxVaultRawFact> invalidated = agent.DrainUntil(
                item => item.FactClass == LinuxVaultFactClass.WatchInvalidated);
            Check(CaseId, "invalidation-rescan", invalidated.Any(item =>
                item.ErrorCode == "linux_vault_watch_invalidated" && item.RescanRequired), "watch invalidation");
            agent.Rescan();
            Check(CaseId, "invalidation-watermark", agent.Session.Watermark.IsValid, "rescan restores watermark");
        }

        // Root move produces root loss.
        using (LinuxVaultTestRoot root = LinuxVaultTestRoot.Create())
        using (var agent = new LinuxVaultAgentHarness(root, AgentIdentity))
        {
            agent.Install();
            agent.Start();
            string moved = root.Path + "-moved";
            Directory.Move(root.Path, moved);
            try
            {
                IReadOnlyList<LinuxVaultRawFact> lost = agent.DrainUntil(
                    item => item.FactClass == LinuxVaultFactClass.RootLost);
                Check(CaseId, "root-loss", lost.Any(item =>
                    item.ErrorCode == "linux_vault_root_lost" && item.RescanRequired), "root move fails closed");
            }
            finally
            {
                Directory.Move(moved, root.Path);
            }

            Check(CaseId, "root-loss-invalid", !agent.Session.Watermark.IsValid, "watermark stays invalid");
        }

        // Control-tree case collision forces rescan at open time.
        using (LinuxVaultTestRoot root = LinuxVaultTestRoot.Create())
        {
            Directory.CreateDirectory(Path.Combine(root.Path, ".FSUS"));
            using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
            agent.Install();
            LinuxVaultWatcherSession session = agent.OpenSessionOnly();
            IReadOnlyList<LinuxVaultRawFact> facts = session.ReadAvailable();
            Check(CaseId, "collision-rescan", facts.Any(item =>
                item.ErrorCode == "linux_vault_control_tree_case_collision" && item.RescanRequired),
                "case-colliding control directory is blocked");
        }
    }

    [Fact]
    public void RealKernelOverflow_IN_Q_OVERFLOW_DropsNothing_SilentlyAndForcesRescan()
    {
        const string CaseId = "kernel-overflow";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity,
            new LinuxVaultWatcherOptions(MaxFactsPerRead: 16384, MaxWatches: 64));
        agent.Install();
        agent.Start();

        int kernelLimit = int.Parse(
            File.ReadAllText("/proc/sys/fs/inotify/max_queued_events"),
            System.Globalization.CultureInfo.InvariantCulture);
        int fileCount = checked((kernelLimit / 3) + 2048);
        Assert.InRange(fileCount, 2048, 100000);
        for (int index = 0; index < fileCount; index++)
        {
            File.WriteAllText(Path.Combine(root.Path, $"qoverflow-{index}.md"), "x");
        }

        IReadOnlyList<LinuxVaultRawFact> facts = agent.DrainUntil(
            item => item.ErrorCode == "linux_vault_inotify_queue_overflow",
            TimeSpan.FromSeconds(30));
        Check(CaseId, "kernel-overflow-fact", facts.Any(item =>
            item.FactClass == LinuxVaultFactClass.QueueOverflow
            && item.RescanRequired
            && item.PathDisposition == LinuxVaultPathDisposition.None
            && item.RawNewRelativePath is null), "IN_Q_OVERFLOW stays descriptor-independent");
        Check(CaseId, "kernel-overflow-invalidates", !agent.Session.Watermark.IsValid,
            "overflow never masquerades as no-change");

        agent.Rescan();
        Check(CaseId, "kernel-overflow-rescan-exact", agent.Session.Watermark.IsValid
            && agent.Session.Watermark.LastSequence == agent.LastFactSequence,
            "watermark rebuilds exactly after the real overflow");
    }

    [Fact]
    public void Escapes_SymlinkBindMountAndControlTree_FailClosedOnRealExt4()
    {
        const string CaseId = "symlink-bind-escape";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        Directory.CreateSymbolicLink(Path.Combine(root.Path, "escape"), Path.GetDirectoryName(root.Path)!);
        using (var agent = new LinuxVaultAgentHarness(root, AgentIdentity))
        {
            agent.Install();
            LinuxVaultWatcherSession session = agent.OpenSessionOnly();
            IReadOnlyList<LinuxVaultRawFact> facts = session.ReadAvailable();
            Check(CaseId, "symlink-blocked", facts.Any(item =>
                item.RawNewRelativePath == "escape"
                && item.ErrorCode == "linux_vault_symlink_rejected"
                && item.PathDisposition == LinuxVaultPathDisposition.Blocked
                && item.RescanRequired), "nested symlink is never followed");
            Check(CaseId, "symlink-invalidates", !session.Watermark.IsValid, "escape invalidates the watermark");
        }

        string link = root.Path + "-root-link";
        Directory.CreateSymbolicLink(link, root.Path);
        try
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() =>
                LinuxVaultWatcherSession.Open(new(link, root.Manifest, AgentIdentity, new LinuxVaultWatcherOptions())));
            Check(CaseId, "root-symlink-rejected", error.ReasonCode == "linux_vault_root_symlink_rejected",
                "symlink root is rejected before watch creation");
        }
        finally
        {
            Directory.Delete(link);
        }

        // Real bind-mount escape: run the probe inside a user+mount namespace where
        // root/mounted is a real bind mount of a directory outside the Vault.
        string bwrap = LinuxVaultAgentHarness.FindOnPath("bwrap") ?? "/usr/bin/bwrap";
        if (!File.Exists(bwrap))
        {
            _fixture.Evidence.Record(CaseId, "bind-mount-environment", false,
                "bwrap missing: bind-mount namespace unavailable");
            Assert.Fail("bwrap is required for the real bind-mount qualification probe");
        }

        string outside = Path.Combine(Path.GetDirectoryName(root.Path)!, Guid.NewGuid().ToString("N"));
        string target = Path.Combine(root.Path, "mounted");
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(outside, "outside.md"), "must-not-be-followed\n");
        try
        {
            var start = new ProcessStartInfo(bwrap)
            {
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false
            };
            start.ArgumentList.Add("--unshare-user");
            start.ArgumentList.Add("--uid");
            start.ArgumentList.Add("0");
            start.ArgumentList.Add("--dev-bind");
            start.ArgumentList.Add("/");
            start.ArgumentList.Add("/");
            // Re-binding the root at setup creates a distinct real mount entry: the probe
            // observes a genuinely different mount identity, and the mounted child is a
            // real bind-mount escape attempt.
            start.ArgumentList.Add("--bind");
            start.ArgumentList.Add(root.Path);
            start.ArgumentList.Add(root.Path);
            start.ArgumentList.Add("--bind");
            start.ArgumentList.Add(outside);
            start.ArgumentList.Add(target);
            start.ArgumentList.Add("--");
            start.ArgumentList.Add("dotnet");
            start.ArgumentList.Add(typeof(LinuxVaultAgentQualificationTests).Assembly.Location);
            start.ArgumentList.Add("--agent-bind-probe");
            start.ArgumentList.Add(root.Path);
            start.ArgumentList.Add(outside);
            using Process process = Process.Start(start) ?? throw new InvalidOperationException("bind probe failed to start");
            string stdout = process.StandardOutput.ReadToEnd();
            string stderr = process.StandardError.ReadToEnd();
            Check(CaseId, "bind-probe-exit", process.WaitForExit(30000) && process.ExitCode == 0,
                $"exit={process.ExitCode} stdout={stdout} stderr={stderr}");
            Check(CaseId, "bind-child-blocked", stdout.Contains("linux_vault_mount_changed", StringComparison.Ordinal),
                "bind-mounted child is blocked on the real mount boundary");
            string? mountIdentityLine = stdout.Split('\n')
                .FirstOrDefault(static line => line.StartsWith("mount-identity ", StringComparison.Ordinal));
            Check(CaseId, "bind-mount-identity-real", mountIdentityLine is not null
                && int.Parse(mountIdentityLine["mount-identity ".Length..], System.Globalization.CultureInfo.InvariantCulture)
                    != _fixture.Environment.MountIdentity,
                "the re-bound root carries a genuinely different mount identity");

            if (stdout.Contains("linux_vault_root_mount_changed_on_attrib", StringComparison.Ordinal))
            {
                _fixture.Evidence.Record(CaseId, "bind-root-drift", true, "real mount drift rejected");
            }
            else
            {
                Check(CaseId, "bind-root-drift-simulated",
                    stdout.Contains("mount-drift-environment-denied", StringComparison.Ordinal),
                    "kernel policy denies mount(2) inside user namespaces; drift detection is "
                    + "verified by the #2672 probe where the environment permits and by the "
                    + "negative control below");
            }

            // Negative control: without real drift the same verifier path must not fire.
            using (var control = new LinuxVaultAgentHarness(root, AgentIdentity))
            {
                control.InstallControlTreeOnly();
                using LinuxVaultWatcherSession controlSession = control.OpenSessionOnly();
                var convertRecord = typeof(LinuxVaultWatcherSession).GetMethod(
                    "ConvertRecord",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
                var stable = (LinuxVaultRawFact)convertRecord.Invoke(
                    controlSession,
                    [LinuxVaultBindMountProbeProgram.RootWatchDescriptor(controlSession), 0x00000004u, 0u, null])!;
                Check(CaseId, "mount-check-discriminates", stable.ErrorCode != "linux_vault_mount_changed",
                    "the mount check does not fire without a real mount change");
            }
        }
        finally
        {
            Directory.Delete(outside, recursive: true);
        }
    }

    [Fact]
    public void PlannerReceipts_ObservationAndMaterialization_AreBidirectionallyExact()
    {
        const string CaseId = "planner-receipts";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        Directory.CreateDirectory(Path.Combine(root.Path, "articles"));
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);

        byte[] pushBytes = "# local draft\n"u8.ToArray();
        byte[] baseBytes = "base body\n"u8.ToArray();
        byte[] serverBytes = "server body v2\n"u8.ToArray();
        agent.WriteSourceBytes("articles/push-a.md", pushBytes);
        agent.WriteSourceBytes("articles/pull-b.md", baseBytes);

        ArticleVaultArticleManifest pushArticle = agent.CreateArticleManifest(
            "portable-push-a", null, "articles/push-a.md",
            AgentHarnessFixtures.AbsentCoordinate(),
            AgentHarnessFixtures.LocalCoordinate(pushBytes),
            AgentHarnessFixtures.AbsentCoordinate());
        ArticleVaultArticleManifest pullArticle = agent.CreateArticleManifest(
            "portable-pull-b", "server-pull-b", "articles/pull-b.md",
            AgentHarnessFixtures.ServerCoordinate(baseBytes, 4),
            AgentHarnessFixtures.ServerCoordinate(baseBytes, 4),
            AgentHarnessFixtures.ServerCoordinate(serverBytes, 5));

        agent.Install([pushArticle, pullArticle]);
        agent.Start();

        ArticleVaultServerObservation pushObservation = agent.CreateObservation(
            pushArticle, AgentHarnessFixtures.AbsentCoordinate());
        ArticleVaultServerObservation pullObservation = agent.CreateObservation(
            pullArticle, pullArticle.Coordinates.Server);
        var request = new ArticleVaultPlanRequest(
            agent.RootManifest,
            [pushArticle, pullArticle],
            [pushObservation, pullObservation],
            [new VaultPlanGroupRequest("group-primary", [pushArticle.PortableArticleIdentity, pullArticle.PortableArticleIdentity], [])],
            VaultSyncDirection.Sync,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
            false);
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(request);
        Check(CaseId, "plan-ready", built.IsSuccess && built.Plan!.Status == VaultSyncPlanStatus.Ready,
            $"errors={string.Join(',', built.Errors)}");
        ArticleVaultSyncPlan plan = built.Plan!;
        Check(CaseId, "plan-verifies-current", ArticleVaultSyncPlanVerifier.VerifyCurrent(
            plan, request.RootManifest, request.ArticleManifests, request.ServerObservations,
            new(request.CreatedAtUnixMs, request.Direction, request.CancellationRequested)).IsValid,
            "the single #1909 planner output verifies against the same inputs");

        Dictionary<string, byte[]> serverPayloads = new()
        {
            [pullArticle.PortableArticleIdentity] = serverBytes
        };
        IReadOnlyList<AgentOperationReceipt> receipts = agent.ExecutePlan(
            plan, [pushArticle, pullArticle], serverPayloads);
        Check(CaseId, "receipt-count-exact", receipts.Count == plan.OperationOrder.Count,
            "one receipt per planned operation");
        Check(CaseId, "receipts-forward-exact", plan.OperationOrder.All(operation =>
            receipts.Count(receipt => receipt.OperationIdentity == operation) == 1),
            "every planned operation produced exactly one receipt");
        Check(CaseId, "receipts-backward-exact", receipts.All(receipt =>
            plan.OperationOrder.Contains(receipt.OperationIdentity, StringComparer.Ordinal)),
            "every receipt names a planned operation");
        Check(CaseId, "push-observation-receipt", receipts.Any(receipt =>
            receipt.Decision == "push-create"
            && receipt.SourceSha256 == ArticleVaultManifestCodec.CaptureSourceBytes(pushBytes).Sha256),
            "the push receipt binds the real stable-read source identity");
        Check(CaseId, "pull-materialized-exact", File.ReadAllBytes(Path.Combine(root.Path, "articles/pull-b.md"))
            .SequenceEqual(serverBytes), "the pull materialization wrote the server bytes atomically");
        Check(CaseId, "receipts-persisted", receipts.All(receipt => File.Exists(
            Path.Combine(root.Path, ".fsus", "receipts", $"{receipt.OperationIdentity}.json"))),
            "materialization receipts persist under the control tree");

        AgentOperationReceipt tampered = receipts[0] with
        {
            SourceSha256 = new string('0', 64)
        };
        Check(CaseId, "receipt-tamper-rejected", !agent.VerifyReceipt(tampered),
            "resealed receipt digests reject tampering");

        LinuxVaultWatcherException unknown = Assert.Throws<LinuxVaultWatcherException>(() =>
            agent.ExecuteOperation(plan, "operation-not-in-plan", pullArticle, serverBytes));
        Check(CaseId, "no-direct-write", unknown.ReasonCode == "agent_materialize_operation_unknown",
            "the agent cannot materialize outside a sealed plan operation");

        ArticleVaultSyncPlan forged = plan with
        {
            Direction = VaultSyncDirection.Pull
        };
        Check(CaseId, "forged-plan-rejected", !ArticleVaultSyncPlanVerifier.ValidateStructure(forged).IsValid
            || !ArticleVaultSyncPlanVerifier.VerifyCurrent(
                forged, request.RootManifest, request.ArticleManifests, request.ServerObservations,
                new(request.CreatedAtUnixMs, request.Direction, request.CancellationRequested)).IsValid,
            "a mutated plan never verifies as current");

        agent.SettleToClean();
        Check(CaseId, "post-materialization-clean", agent.Session.Watermark.IsValid,
            "control-tree receipt writes are audited and the watermark rebuilds exactly");
    }

    [Fact]
    public void CounterExample_AtomicReplaceFailure_LeavesBaseReceiptAndTargetUntouched()
    {
        const string CaseId = "atomic-replace-failure";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        Directory.CreateDirectory(Path.Combine(root.Path, "articles"));
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);

        byte[] baseBytes = "base body\n"u8.ToArray();
        byte[] serverBytes = "server replacement\n"u8.ToArray();
        agent.WriteSourceBytes("articles/pull-c.md", baseBytes);
        ArticleVaultArticleManifest article = agent.CreateArticleManifest(
            "portable-pull-c", "server-pull-c", "articles/pull-c.md",
            AgentHarnessFixtures.ServerCoordinate(baseBytes, 4),
            AgentHarnessFixtures.ServerCoordinate(baseBytes, 4),
            AgentHarnessFixtures.ServerCoordinate(serverBytes, 5));
        agent.Install([article]);
        agent.Start();

        ArticleVaultServerObservation observation = agent.CreateObservation(article, article.Coordinates.Server);
        var request = new ArticleVaultPlanRequest(
            agent.RootManifest,
            [article],
            [observation],
            [new VaultPlanGroupRequest("group-primary", [article.PortableArticleIdentity], [])],
            VaultSyncDirection.Sync,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
            false);
        ArticleVaultSyncPlan plan = ArticleVaultSyncPlanner.Build(request).Plan!;
        VaultSyncPlanItem item = Assert.Single(Assert.Single(plan.Groups).Items);
        Assert.Equal(VaultSyncDecision.PullUpdate, item.Decision);

        // Make the containing directory read-only so the atomic rename really fails.
        UnixFileMode original = File.GetUnixFileMode(Path.Combine(root.Path, "articles"));
        File.SetUnixFileMode(Path.Combine(root.Path, "articles"), UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            LinuxVaultWatcherException failure = Assert.Throws<LinuxVaultWatcherException>(() =>
                agent.ExecuteOperation(plan, item.OperationIdentity, article, serverBytes));
            Check(CaseId, "replace-fails", failure.ReasonCode == "agent_materialize_replace_failed",
                $"real rename failure: {failure.ReasonCode}");
        }
        finally
        {
            File.SetUnixFileMode(Path.Combine(root.Path, "articles"), original);
        }

        Check(CaseId, "target-untouched", File.ReadAllBytes(Path.Combine(root.Path, "articles/pull-c.md"))
            .SequenceEqual(baseBytes), "failed replace never exposes half-written content");
        Check(CaseId, "base-untouched", agent.ManifestOnDisk(article.PortableArticleIdentity)?.ContentSha256
            == article.ContentSha256, "base coordinate unchanged after failure");
        Check(CaseId, "no-receipt", !File.Exists(Path.Combine(
            root.Path, ".fsus", "receipts", $"{item.OperationIdentity}.json")),
            "a failed replace writes no success receipt");
        Check(CaseId, "temp-cleaned", !Directory.EnumerateFiles(
            Path.Combine(root.Path, ".fsus", "tmp")).Any(), "orphan temp files are cleaned up");
    }

    [Fact]
    public void CounterExample_DualAgentAndLeaseSplitBrain_FailClosed()
    {
        const string CaseId = "dual-agent-lease";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var first = new LinuxVaultAgentHarness(root, AgentIdentity);
        first.Install();
        first.Start();
        Check(CaseId, "first-lease", first.LeaseHeld, "first agent holds the single-writer lease");

        using var second = new LinuxVaultAgentHarness(root, "linux-vault-agent-second");
        second.InstallControlTreeOnly();
        AgentLeaseResult contested = second.TryAcquireLease();
        Check(CaseId, "second-lease-conflict", !contested.Acquired
            && contested.ReasonCode == "agent_lease_conflict", "second writer fails closed on the real O_EXCL lease");

        // A second watcher session may still observe read-only; it must never materialize.
        using LinuxVaultWatcherSession observer = second.OpenSessionOnly();
        IReadOnlyList<LinuxVaultRawFact> observed = observer.ReadAvailable();
        Check(CaseId, "second-read-only", observed.Any(item => item.FactClass == LinuxVaultFactClass.WatcherRestarted),
            "read-only observation remains possible without the writer lease");
        LinuxVaultWatcherException denied = Assert.Throws<LinuxVaultWatcherException>(second.EnsureWriterLease);
        Check(CaseId, "second-write-denied", denied.ReasonCode == "agent_lease_required",
            "materialization without the lease fails closed");

        // Split-brain: a forged lease file cannot satisfy the binding checks.
        string forged = Path.Combine(root.Path, ".fsus", "agent.lease");
        File.WriteAllText(forged, JsonSerializer.Serialize(new
        {
            schema = LinuxVaultAgentHarness.LeaseSchema,
            agent = "linux-vault-agent-forged",
            pid = Environment.ProcessId,
            token = Guid.NewGuid().ToString("N"),
            vaultIdentity = "vault-forged",
            leaseSha256 = new string('0', 64)
        }));
        AgentLeaseResult splitBrain = second.TryValidateLease();
        Check(CaseId, "split-brain-rejected", !splitBrain.Acquired
            && splitBrain.ReasonCode == "agent_lease_binding_mismatch",
            "forged lease content fails the sealed binding check");
    }

    [Fact]
    public void CounterExample_RestartNeverSkipsChanges_RescanRecoversExactly()
    {
        const string CaseId = "restart-recovery";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string firstIdentity;
        using (var first = new LinuxVaultAgentHarness(root, AgentIdentity))
        {
            first.Install();
            first.Start();
            firstIdentity = first.Session.Identity.WatchInstanceIdentity;
        }

        // Changes land while no agent is running; a restart must not skip them.
        File.WriteAllText(Path.Combine(root.Path, "downtime.md"), "written-while-down\n");
        using var restarted = new LinuxVaultAgentHarness(root, AgentIdentity);
        restarted.InstallControlTreeOnly();
        using LinuxVaultWatcherSession session = restarted.OpenSessionOnly();
        IReadOnlyList<LinuxVaultRawFact> boot = session.ReadAvailable();
        Check(CaseId, "restart-fact", boot.Any(item =>
            item.FactClass == LinuxVaultFactClass.WatcherRestarted && item.RescanRequired),
            "restart emits a rescan obligation");
        Check(CaseId, "restart-new-instance", session.Identity.WatchInstanceIdentity != firstIdentity,
            "watch instance identity changes across restarts");
        Check(CaseId, "restart-no-skip", !restarted.TryAdmitClean(boot),
            "no clean admission is possible before the rescan completes");
        restarted.AttachSession(session);
        restarted.Rescan();
        Check(CaseId, "restart-recovers", restarted.LastRescanPaths.Contains("downtime.md"),
            "rescan recovers the downtime change from disk, not from memory");
        Check(CaseId, "restart-watermark-exact", session.Watermark.IsValid
            && session.Watermark.LastSequence == restarted.LastFactSequence
            && session.Watermark.RescanReceiptSha256 == restarted.LastRescanReceiptSha256,
            "rebuilt watermark binds the rescan receipt exactly");
    }

    [Fact]
    public void Ipc_CrossUserOldTokenProtocolMismatchAndAbsolutePath_FailClosed()
    {
        const string CaseId = "ipc-closure";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        agent.Start();
        string token = agent.LeaseToken!;
        int uid = LinuxVaultAgentHarness.CurrentUid();

        Check(CaseId, "status-ok", agent.InvokeIpc("status", null, token, 1, uid).Succeeded, "closed status command");
        Check(CaseId, "old-token", agent.InvokeIpc("status", null, Guid.NewGuid().ToString("N"), 1, uid).ReasonCode
            == "agent_ipc_token_rejected", "old or unknown tokens are rejected");
        Check(CaseId, "protocol-mismatch", agent.InvokeIpc("status", null, token, 2, uid).ReasonCode
            == "agent_ipc_protocol_mismatch", "incompatible protocol versions fail closed");
        Check(CaseId, "cross-user", agent.InvokeIpc("status", null, token, 1, uid + 1).ReasonCode
            == "agent_ipc_cross_user", "a token minted for another uid is rejected");
        Check(CaseId, "absolute-path", agent.InvokeIpc("status", "/etc/passwd", token, 1, uid).ReasonCode
            == "agent_ipc_argument_rejected", "IPC never accepts an arbitrary absolute path");
        Check(CaseId, "unknown-verb", agent.InvokeIpc("shell", null, token, 1, uid).ReasonCode
            == "agent_ipc_verb_unknown", "no arbitrary command channel exists");

        agent.InvokeIpc("unlink", null, token, 1, uid);
        Check(CaseId, "revoked-token", agent.InvokeIpc("status", null, token, 1, uid).ReasonCode
            == "agent_ipc_token_revoked", "unlink revokes the IPC token");
    }

    [Fact]
    public void Lifecycle_ProcessCrashUpdateRollbackAndTeardown_FailClosed()
    {
        const string CaseId = "lifecycle-crash";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        File.WriteAllText(Path.Combine(root.Path, "keep.md"), "user body survives unlink\n");

        // A real agent process is killed mid-materialization; nothing half-done may be admitted.
        var start = new ProcessStartInfo("dotnet")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add(typeof(LinuxVaultAgentQualificationTests).Assembly.Location);
        start.ArgumentList.Add("--agent-crash-probe");
        start.ArgumentList.Add(root.Path);
        using Process probe = Process.Start(start) ?? throw new InvalidOperationException("crash probe failed to start");
        string? readyLine = probe.StandardOutput.ReadLine();
        Check(CaseId, "probe-ready", readyLine == "ready", $"probe stdout={readyLine}");
        probe.Kill(entireProcessTree: true);
        probe.WaitForExit(30000);

        string leasePath = Path.Combine(root.Path, ".fsus", "agent.lease");
        string tempPath = Path.Combine(root.Path, ".fsus", "tmp", "crash-op.part");
        Check(CaseId, "crash-lease-remains", File.Exists(leasePath), "lease file survives the kill");
        Check(CaseId, "crash-partial-temp", File.Exists(tempPath), "partial temp file survives the kill");
        Check(CaseId, "crash-no-target", !File.Exists(Path.Combine(root.Path, "articles", "crash-target.md")),
            "killed materialization never exposes a target");
        Check(CaseId, "crash-no-receipt", !Directory.Exists(Path.Combine(root.Path, ".fsus", "receipts"))
            || !Directory.EnumerateFiles(Path.Combine(root.Path, ".fsus", "receipts")).Any(),
            "killed materialization writes no receipt");

        using var recovered = new LinuxVaultAgentHarness(root, AgentIdentity);
        recovered.InstallControlTreeOnly();
        AgentLeaseResult reclaim = recovered.TryRecoverLease();
        Check(CaseId, "crash-lease-reclaimed", reclaim.Acquired, "dead-pid lease is reclaimed on restart");
        using LinuxVaultWatcherSession session = recovered.OpenSessionOnly();
        recovered.AttachSession(session);
        recovered.Rescan();
        Check(CaseId, "crash-orphan-cleaned", !File.Exists(tempPath),
            "closed-registry temp files are cleaned during recovery");
        Check(CaseId, "crash-watermark", session.Watermark.IsValid, "recovery rebuilds the watermark");

        // Update rollback: a mismatched protocol version refuses to start and changes nothing.
        using var outdated = new LinuxVaultAgentHarness(root, AgentIdentity, protocolVersion: 2);
        outdated.InstallControlTreeOnly();
        LinuxVaultWatcherException rollback = Assert.Throws<LinuxVaultWatcherException>(outdated.Start);
        Check(CaseId, "update-rollback", rollback.ReasonCode == "agent_protocol_mismatch"
            && !File.Exists(Path.Combine(root.Path, ".fsus", "tmp", "rollback.marker")),
            "protocol mismatch rolls back without writes");

        // Teardown/unlink revokes local authority but never deletes user Markdown.
        AgentIpcResult unlinked = recovered.InvokeIpc("unlink", null, recovered.LeaseToken!, 1, LinuxVaultAgentHarness.CurrentUid());
        Check(CaseId, "unlink-ok", unlinked.Succeeded, "closed unlink command succeeds");
        Check(CaseId, "unlink-keeps-markdown", File.ReadAllText(Path.Combine(root.Path, "keep.md"))
            == "user body survives unlink\n", "unlink never deletes user Markdown");
        Check(CaseId, "unlink-lease-gone", !File.Exists(leasePath), "unlink removes the writer lease");
        AgentIpcResult markdownDelete = recovered.InvokeIpc("unlink", "keep.md", recovered.LeaseToken!, 1, LinuxVaultAgentHarness.CurrentUid());
        Check(CaseId, "unlink-no-path", markdownDelete.ReasonCode is "agent_ipc_argument_rejected" or "agent_ipc_token_revoked",
            "unlink cannot be aimed at an article path");
        Check(CaseId, "unlink-markdown-still-there", File.Exists(Path.Combine(root.Path, "keep.md")),
            "the unlink mutation never removes Markdown");
    }

    [Fact]
    public void StaticAndMutation_DegradedAuthorities_StayRejected()
    {
        const string CaseId = "static-mutation";
        string repository = LinuxVaultTestRoot.FindRepositoryRoot();
        string[] watcherSources = Directory.EnumerateFiles(
            Path.Combine(repository, "src", "article-vault", "linux"), "*.cs").ToArray();
        string source = string.Join('\n', watcherSources.Select(File.ReadAllText));

        foreach ((string checkId, string pattern) in new (string, string)[]
        {
            ("no-managed-watcher", "FileSystemWatcher"),
            ("no-polling", "Thread\\.Sleep|Task\\.Delay|PeriodicTimer"),
            ("no-mtime-authority", "LastWriteTime|GetLastWriteTime|\\bmtime\\b"),
            ("no-inode-identity", "\\binode\\b|ino_t|FileIndex"),
            ("no-unbounded-queue", "CreateUnbounded|ConcurrentQueue|BlockingCollection"),
            ("no-compat-protocol", "\\bcompat\\w*\\b|\\blegacy\\b|\\bfallback\\b"),
            ("no-second-planner", "ArticleVaultSyncPlanner|IArticleCoreService|ArticleService"),
            ("no-unlink-of-markdown", "File\\.Delete|File\\.Move|Directory\\.Delete"),
            ("no-body-write", "File\\.WriteAll|File\\.AppendAll"),
            ("no-network", "HttpClient|System\\.Net\\.Sockets|TcpClient")
        })
        {
            Check(CaseId, checkId, !System.Text.RegularExpressions.Regex.IsMatch(
                source, pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase),
                $"watcher sources reject degraded authority: {pattern}");
        }

        string[] factProperties = typeof(LinuxVaultRawFact).GetProperties().Select(static p => p.Name).ToArray();
        Check(CaseId, "fact-no-inode", !factProperties.Any(static name => name.Contains("Inode", StringComparison.OrdinalIgnoreCase)),
            "raw facts carry no inode identity");
        Check(CaseId, "cookie-diagnostic-only", factProperties.Count(static name => name.Contains("Cookie", StringComparison.Ordinal)) == 1
            && factProperties.Contains("CookieDiagnostic"), "the only cookie field is a diagnostic");

        // Mutation: a sync plan request must fail closed on compat/unknown schemas.
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        ArticleVaultArticleManifest article = agent.CreateArticleManifest(
            "portable-mutation", null, "mutation.md",
            AgentHarnessFixtures.AbsentCoordinate(),
            AgentHarnessFixtures.LocalCoordinate("mutation body\n"u8.ToArray()),
            AgentHarnessFixtures.AbsentCoordinate());
        agent.Install([article]);
        agent.Start();
        ArticleVaultServerObservation compatObservation = agent.CreateObservation(
            article, AgentHarnessFixtures.AbsentCoordinate()) with
        {
            Schema = "fsusblog.article-vault.server-observation.v0"
        };
        compatObservation = compatObservation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(compatObservation)
        };
        VaultPlanGroupRequest[] groups =
            [new VaultPlanGroupRequest("group-primary", [article.PortableArticleIdentity], [])];
        var request = new ArticleVaultPlanRequest(
            agent.RootManifest,
            [article],
            [compatObservation],
            groups,
            VaultSyncDirection.Sync,
            0,
            60_000,
            false);
        ArticleVaultPlanBuildResult compat = ArticleVaultSyncPlanner.Build(request);
        Check(CaseId, "compat-protocol-rejected", !compat.IsSuccess
            && compat.Errors.Contains("article_vault_server_observation_schema_unknown"),
            $"compat protocol schemas fail closed: {string.Join(',', compat.Errors)}");

        // Mutation: identical content under a manipulated mtime produces the same byte identity.
        agent.WriteSource("mtime-a.md", "same bytes\n");
        agent.WriteSource("mtime-b.md", "same bytes\n");
        File.SetLastWriteTimeUtc(Path.Combine(root.Path, "mtime-a.md"), new DateTime(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        File.SetLastWriteTimeUtc(Path.Combine(root.Path, "mtime-b.md"), new DateTime(2031, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        IReadOnlyList<LinuxVaultRawFact> facts = agent.DrainUntil(
            item => item.RawNewRelativePath == "mtime-b.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        VaultSourceByteIdentity? first = agent.StableRead("mtime-a.md", facts);
        VaultSourceByteIdentity? second = agent.StableRead("mtime-b.md", facts);
        Check(CaseId, "mtime-never-wins", first?.Sha256 == second?.Sha256,
            "identity derives from bytes, never from mtime ordering");
    }

    [Fact]
    public void PrivacyScan_NoBodyTokenOrPrivateMetadata_FirstFailureAppendOnly()
    {
        const string CaseId = "privacy-evidence";
        string secret = $"PRIVATE-BODY-{Guid.NewGuid():N}";
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        agent.Start();

        agent.WriteSource("secret.md", $"title\n{secret}\n");
        IReadOnlyList<LinuxVaultRawFact> facts = agent.DrainUntil(
            item => item.RawNewRelativePath == "secret.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        AgentObservationBatch batch = agent.Normalize(facts);
        agent.Rescan();

        string serializedFacts = JsonSerializer.Serialize(facts);
        string serializedBatch = JsonSerializer.Serialize(batch);
        string receipts = string.Join('\n', agent.Receipts.Select(static receipt => JsonSerializer.Serialize(receipt)));
        Check(CaseId, "record-baseline", true, "privacy baseline record");
        string evidenceBytes = File.Exists(_fixture.Evidence.EvidencePath)
            ? File.ReadAllText(_fixture.Evidence.EvidencePath)
            : string.Empty;
        string token = agent.LeaseToken!;

        foreach ((string checkId, string surface) in new (string, string)[]
        {
            ("facts", serializedFacts),
            ("batch", serializedBatch),
            ("receipts", receipts),
            ("evidence", evidenceBytes)
        })
        {
            Check(CaseId, $"no-body-{checkId}", !surface.Contains(secret, StringComparison.Ordinal),
                $"{checkId} never contains the article body");
            Check(CaseId, $"no-token-{checkId}", !surface.Contains(token, StringComparison.Ordinal),
                $"{checkId} never contains the lease token");
        }

        Check(CaseId, "fact-shape-privacy", facts.All(static item => item.ContentSha256.Length == 64
            && item.RootManifestSha256.Length == 64), "facts are content-addressed only");

        // First-failure evidence is append-only: earlier records are never truncated away.
        string scratch = Path.Combine(_fixture.Evidence.RunDirectory, "append-only-probe.jsonl");
        File.WriteAllText(scratch, "{\"sequence\":0,\"result\":\"fail\",\"checkId\":\"first-failure\"}\n");
        using (var appender = new StreamWriter(scratch, append: true))
        {
            appender.WriteLine("{\"sequence\":1,\"result\":\"pass\",\"checkId\":\"later\"}");
        }

        string[] lines = File.ReadAllLines(scratch);
        Check(CaseId, "first-failure-preserved", lines[0].Contains("first-failure", StringComparison.Ordinal)
            && lines.Length == 2, "append-only evidence keeps the first failure");
    }

    [Fact]
    public void QualificationManifest_BindsEnvironmentIdentitiesCommandAndCases()
    {
        const string CaseId = "manifest-binding";
        string repository = LinuxVaultTestRoot.FindRepositoryRoot();
        string manifestPath = Path.Combine(repository, "artifacts", "article-vault", "linux-agent-qualification.json");
        Check(CaseId, "manifest-present", File.Exists(manifestPath), "sealed qualification manifest exists");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
        JsonElement manifest = document.RootElement;

        Check(CaseId, "schema", manifest.GetProperty("schema").GetString()
            == "fsusblog.vault-agent-platform-qualification.v1", "schema");
        Check(CaseId, "platform", manifest.GetProperty("platform").GetString() == "linux", "platform");
        Check(CaseId, "issue", manifest.GetProperty("issue").GetInt32() == 2675, "issue");

        JsonElement identities = manifest.GetProperty("identities");
        Check(CaseId, "agent-identity", identities.GetProperty("agent").GetString() == AgentIdentity, "agent");
        JsonElement protocols = identities.GetProperty("protocols");
        Check(CaseId, "raw-fact-schema", protocols.GetProperty("rawFact").GetString() == LinuxVaultWatcherSchemas.RawFact, "raw fact schema");
        Check(CaseId, "root-manifest-schema", protocols.GetProperty("rootManifest").GetString() == ArticleVaultSchemas.RootManifest, "root schema");
        Check(CaseId, "article-manifest-schema", protocols.GetProperty("articleManifest").GetString() == ArticleVaultSchemas.ArticleManifest, "article schema");
        Check(CaseId, "metadata-manifest-schema", protocols.GetProperty("metadataManifest").GetString() == ArticleVaultSchemas.MetadataManifest, "metadata schema");
        Check(CaseId, "coordinate-schema", protocols.GetProperty("coordinate").GetString() == ArticleVaultSchemas.Coordinate, "coordinate schema");
        Check(CaseId, "control-tree-schema", protocols.GetProperty("controlTree").GetString() == ArticleVaultSchemas.ControlTreeVersion, "control tree schema");
        Check(CaseId, "sync-plan-schema", protocols.GetProperty("syncPlan").GetString() == ArticleVaultPlanSchemas.Plan, "plan schema");
        Check(CaseId, "server-observation-schema", protocols.GetProperty("serverObservation").GetString() == ArticleVaultPlanSchemas.ServerObservation, "observation schema");

        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using var agent = new LinuxVaultAgentHarness(root, AgentIdentity);
        agent.Install();
        agent.Start();
        JsonElement filesystem = manifest.GetProperty("environment").GetProperty("fileSystem");
        Check(CaseId, "environment-ext4", filesystem.GetProperty("type").GetString()
            == agent.Session.Identity.Filesystem.FileSystemType, "filesystem type binds to the live mount");
        Check(CaseId, "environment-case", filesystem.GetProperty("caseSensitive").GetBoolean()
            == agent.Session.Identity.Filesystem.CaseSensitive, "case sensitivity binds");
        Check(CaseId, "environment-unicode", filesystem.GetProperty("unicodeNormalization").GetString()
            == agent.Session.Identity.Filesystem.UnicodeNormalization, "unicode semantics bind");
        Check(CaseId, "environment-kernel", manifest.GetProperty("environment").GetProperty("kernelInterface").GetString()
            == "inotify", "kernel interface binds");

        string command = manifest.GetProperty("command").GetString()!;
        Check(CaseId, "command", command == "dotnet test tests/article-vault/linux/FsusBlog.ArticleVault.Linux.Tests.csproj --no-restore --filter Category=LinuxArticleVaultAgentQualification",
            "the sealed command matches the focused category");
        Check(CaseId, "command-project-exists", File.Exists(Path.Combine(
            repository, manifest.GetProperty("testProject").GetString()!)), "test project exists");

        string[] facts = typeof(LinuxVaultAgentQualificationTests)
            .GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)
            .Where(static method => method.GetCustomAttributes(typeof(FactAttribute), inherit: true).Any())
            .Select(static method => method.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] declared = manifest.GetProperty("cases").EnumerateArray()
            .Select(static item => item.GetProperty("testMethod").GetString()!)
            .Order(StringComparer.Ordinal)
            .ToArray();
        Check(CaseId, "case-inventory-exact", declared.SequenceEqual(facts, StringComparer.Ordinal),
            $"declared={declared.Length} actual={facts.Length}");

        Check(CaseId, "dependencies-declared", manifest.GetProperty("simulatedLayers").EnumerateArray()
            .All(static layer => layer.GetProperty("issue").GetInt32() > 0
                && !string.IsNullOrWhiteSpace(layer.GetProperty("simulation").GetString())),
            "every simulated dependency names its issue and simulation");
        Check(CaseId, "no-warnings", manifest.GetProperty("warnings").GetArrayLength() == 0,
            "the sealed manifest carries zero warnings");
    }
}
