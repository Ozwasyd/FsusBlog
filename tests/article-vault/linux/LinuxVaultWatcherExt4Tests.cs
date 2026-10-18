using System.Diagnostics;
using System.Runtime.Versioning;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "LinuxArticleVaultWatcher")]
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultWatcherExt4Tests
{
    [Fact]
    public void RealExt4_EmitsRawCreateModifyMoveReplaceTruncateAndDeleteSequences()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open();
        Assert.Equal("ext4", session.Identity.Filesystem.FileSystemType);
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        string source = Path.Combine(root.Path, "article.md");
        File.WriteAllText(source, "first\n");
        IReadOnlyList<LinuxVaultRawFact> create = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "article.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        Assert.Contains(create, item => item.RawNewRelativePath == "article.md" && item.FactClass == LinuxVaultFactClass.Created);
        Assert.Contains(create, item => item.RawNewRelativePath == "article.md" && item.FactClass == LinuxVaultFactClass.Modified);

        File.AppendAllText(source, "second\n");
        IReadOnlyList<LinuxVaultRawFact> modify = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "article.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        Assert.Contains(modify, item => item.FactClass == LinuxVaultFactClass.Modified);

        for (int index = 0; index < 3; index++)
        {
            File.AppendAllText(source, $"duplicate-{index}\n");
        }

        IReadOnlyList<LinuxVaultRawFact> duplicateAudit = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "article.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        Assert.Equal(3, duplicateAudit.Count(item => item.RawNewRelativePath == "article.md"
            && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite));
        Assert.True(duplicateAudit.Count(item => item.RawNewRelativePath == "article.md"
            && item.FactClass == LinuxVaultFactClass.Modified) >= 3);

        string renamed = Path.Combine(root.Path, "renamed.md");
        File.Move(source, renamed);
        IReadOnlyList<LinuxVaultRawFact> move = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "renamed.md" && item.FactClass == LinuxVaultFactClass.MovedTo);
        LinuxVaultRawFact movedFrom = Assert.Single(move, item => item.RawOldRelativePath == "article.md" && item.FactClass == LinuxVaultFactClass.MovedFrom);
        LinuxVaultRawFact movedTo = Assert.Single(move, item => item.RawNewRelativePath == "renamed.md" && item.FactClass == LinuxVaultFactClass.MovedTo);
        Assert.NotNull(movedFrom.CookieDiagnostic);
        Assert.Equal(movedFrom.CookieDiagnostic, movedTo.CookieDiagnostic);

        string temporary = Path.Combine(root.Path, ".renamed.md.tmp");
        File.WriteAllText(temporary, "replacement\n");
        File.Move(temporary, renamed, overwrite: true);
        IReadOnlyList<LinuxVaultRawFact> replace = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "renamed.md" && item.FactClass == LinuxVaultFactClass.MovedTo);
        Assert.Contains(replace, item => item.RawOldRelativePath == ".renamed.md.tmp" && item.FactClass == LinuxVaultFactClass.MovedFrom);

        using (var stream = new FileStream(renamed, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
        {
            stream.SetLength(0);
            stream.Write("complete\n"u8);
            stream.Flush(flushToDisk: true);
        }

        IReadOnlyList<LinuxVaultRawFact> truncate = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "renamed.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);
        Assert.Contains(truncate, item => item.RawNewRelativePath == "renamed.md" && item.FactClass == LinuxVaultFactClass.Modified);

        File.Delete(renamed);
        IReadOnlyList<LinuxVaultRawFact> deleted = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "renamed.md" && item.FactClass == LinuxVaultFactClass.Deleted);
        Assert.Contains(deleted, item => item.PathDisposition == LinuxVaultPathDisposition.MissingEntry);

        long[] sequences = create.Concat(modify).Concat(duplicateAudit).Concat(move).Concat(replace).Concat(truncate).Concat(deleted)
            .Select(static item => item.Sequence)
            .ToArray();
        Assert.Equal(sequences.Order().Distinct(), sequences);
        Assert.All(create.Concat(modify).Concat(duplicateAudit).Concat(move).Concat(replace).Concat(truncate).Concat(deleted),
            static item => Assert.True(LinuxVaultRawFactCodec.Validate(item)));
        Assert.All(create.Concat(modify).Concat(duplicateAudit).Concat(move).Concat(replace).Concat(truncate).Concat(deleted),
            static item => Assert.False(item.WatermarkValid));
        Assert.False(session.Watermark.IsValid);
        Assert.Null(session.Watermark.RescanReceiptSha256);
    }

    [Fact]
    public void DynamicDirectoryWatch_ObservesNestedFileWithoutPollingFilesystem()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open();
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        string directory = Path.Combine(root.Path, "nested");
        Directory.CreateDirectory(directory);
        _ = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "nested" && item.FactClass == LinuxVaultFactClass.Created);

        File.WriteAllText(Path.Combine(directory, "article.md"), "nested\n");
        IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == "nested/article.md" && item.FactClass == LinuxVaultFactClass.ClosedAfterWrite);

        Assert.Contains(facts, item => item.RawNewRelativePath == "nested/article.md" && item.FactClass == LinuxVaultFactClass.Created);

        using LinuxVaultTestRoot boundedRoot = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession bounded = boundedRoot.Open(new LinuxVaultWatcherOptions(MaxFactsPerRead: 32, MaxWatches: 4));
        _ = bounded.ReadAvailable();
        _ = bounded.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
        Directory.CreateDirectory(Path.Combine(boundedRoot.Path, "bounded-nested"));
        IReadOnlyList<LinuxVaultRawFact> boundedFacts = LinuxVaultTestRoot.WaitFor(
            bounded,
            item => item.FactClass == LinuxVaultFactClass.DynamicWatchFailed);
        LinuxVaultRawFact directoryCreated = Assert.Single(
            boundedFacts,
            item => item.RawNewRelativePath == "bounded-nested" && item.FactClass == LinuxVaultFactClass.Created);
        LinuxVaultRawFact watchFailed = Assert.Single(
            boundedFacts,
            item => item.RawNewRelativePath == "bounded-nested" && item.FactClass == LinuxVaultFactClass.DynamicWatchFailed);
        Assert.Equal(directoryCreated.Sequence + 1, watchFailed.Sequence);
        Assert.Equal("linux_vault_watch_set_bound_exceeded", watchFailed.ErrorCode);
        Assert.True(watchFailed.RescanRequired);
        Assert.False(bounded.Watermark.IsValid);
    }

    [Fact]
    public void UserSpaceBound_EmitsOverflowAndInvalidatesWatermark()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open(new LinuxVaultWatcherOptions(MaxFactsPerRead: 8, MaxWatches: 32));
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        for (int index = 0; index < 32; index++)
        {
            File.WriteAllText(Path.Combine(root.Path, $"bounded-{index}.md"), "x");
        }

        IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.FactClass == LinuxVaultFactClass.QueueOverflow);

        Assert.Contains(facts, item => item.ErrorCode == "linux_vault_user_queue_bound_exceeded" && item.RescanRequired);
        Assert.False(session.Watermark.IsValid);
        Assert.True(facts.Count <= 8);
        Assert.Contains(
            facts.Zip(facts.Skip(1)),
            static pair => pair.Second.Sequence > pair.First.Sequence + 1);
        Assert.Throws<ArgumentOutOfRangeException>(() => root.Open(new LinuxVaultWatcherOptions(MaxFactsPerRead: 7, MaxWatches: 32)));
        Assert.Throws<ArgumentOutOfRangeException>(() => root.Open(new LinuxVaultWatcherOptions(MaxFactsPerRead: 16385, MaxWatches: 32)));
        Assert.Throws<ArgumentOutOfRangeException>(() => root.Open(new LinuxVaultWatcherOptions(MaxFactsPerRead: 8, MaxWatches: 0)));
        Assert.Throws<ArgumentOutOfRangeException>(() => root.Open(new LinuxVaultWatcherOptions(MaxFactsPerRead: 8, MaxWatches: 65537)));
    }

    [Fact]
    public void RealKernelQueueOverflow_EmitsRescanRequiredAndInvalidatesWatermark()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open(new LinuxVaultWatcherOptions(MaxFactsPerRead: 16384, MaxWatches: 32));
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
        int kernelLimit = int.Parse(File.ReadAllText("/proc/sys/fs/inotify/max_queued_events"), System.Globalization.CultureInfo.InvariantCulture);
        int fileCount = checked((kernelLimit / 3) + 2048);
        Assert.InRange(fileCount, 2048, 100000);

        for (int index = 0; index < fileCount; index++)
        {
            File.WriteAllText(Path.Combine(root.Path, $"overflow-{index}.md"), "x");
        }

        IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.ErrorCode == "linux_vault_inotify_queue_overflow",
            timeout: TimeSpan.FromSeconds(20));

        Assert.Contains(facts, item => item.FactClass == LinuxVaultFactClass.QueueOverflow
            && item.RescanRequired
            && !item.WatermarkValid);
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public void NestedWatchInvalidation_EmitsRescanRequired()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string nested = Path.Combine(root.Path, "nested-before-open");
        Directory.CreateDirectory(nested);
        using LinuxVaultWatcherSession session = root.Open();
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        Directory.Delete(nested);
        IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.FactClass == LinuxVaultFactClass.WatchInvalidated);

        Assert.Contains(facts, item => item.ErrorCode == "linux_vault_watch_invalidated" && item.RescanRequired);
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public void PermissionLoss_EmitsBlockedRescanFact()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string source = Path.Combine(root.Path, "permission.md");
        File.WriteAllText(source, "private\n");
        using LinuxVaultWatcherSession session = root.Open();
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        File.SetUnixFileMode(source, UnixFileMode.None);
        try
        {
            IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
                session,
                item => item.RawNewRelativePath == "permission.md" && item.ErrorCode == "linux_vault_path_permission_blocked");

            Assert.Contains(facts, item => item.PathDisposition == LinuxVaultPathDisposition.Blocked && item.RescanRequired);
            Assert.False(session.Watermark.IsValid);
        }
        finally
        {
            File.SetUnixFileMode(source, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
        UnixFileMode rootMode = File.GetUnixFileMode(root.Path);
        File.SetUnixFileMode(root.Path, UnixFileMode.None);
        try
        {
            IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
                session,
                item => item.FactClass == LinuxVaultFactClass.AttributesChanged
                    && item.RawNewRelativePath == string.Empty
                    && item.ErrorCode == "linux_vault_path_permission_blocked");

            Assert.Contains(facts, item => item.PathDisposition == LinuxVaultPathDisposition.Blocked
                && item.RescanRequired
                && !item.WatermarkValid
                && LinuxVaultRawFactCodec.Validate(item));
            Assert.False(session.Watermark.IsValid);
        }
        finally
        {
            File.SetUnixFileMode(root.Path, rootMode);
        }
    }

    [Fact]
    public void RootMove_EmitsRootLostAndInvalidatesWatermark()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string moved = root.Path + "-moved";
        using LinuxVaultWatcherSession session = root.Open();
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        Directory.Move(root.Path, moved);
        try
        {
            IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
                session,
                item => item.FactClass == LinuxVaultFactClass.RootLost);

            Assert.Contains(facts, item => item.ErrorCode == "linux_vault_root_lost" && item.RescanRequired);
            Assert.False(session.Watermark.IsValid);
        }
        finally
        {
            Directory.Move(moved, root.Path);
        }

        using LinuxVaultWatcherSession unmountSession = root.Open();
        _ = unmountSession.ReadAvailable();
        _ = unmountSession.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
        var convertRecord = typeof(LinuxVaultWatcherSession).GetMethod(
            "ConvertRecord",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var unmounted = (LinuxVaultRawFact)convertRecord.Invoke(
            unmountSession,
            [LinuxVaultBindMountProbeProgram.RootWatchDescriptor(unmountSession), 0x00002000u, 0u, null])!;
        Assert.Equal(LinuxVaultFactClass.Unmounted, unmounted.FactClass);
        Assert.Equal("linux_vault_root_unmounted", unmounted.ErrorCode);
        Assert.True(unmounted.RescanRequired);
        Assert.False(unmounted.WatermarkValid);
        Assert.False(unmountSession.Watermark.IsValid);
    }

    [Fact]
    public void BindMountedChild_IsBlockedWithoutFollowingMountedTree()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string outside = Path.Combine(Path.GetDirectoryName(root.Path)!, Guid.NewGuid().ToString("N"));
        string target = Path.Combine(root.Path, "mounted");
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(outside, "outside.md"), "must-not-be-followed\n");
        try
        {
            var start = new ProcessStartInfo("unshare")
            {
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false
            };
            start.ArgumentList.Add("--user");
            start.ArgumentList.Add("--map-root-user");
            start.ArgumentList.Add("--mount");
            start.ArgumentList.Add("--propagation");
            start.ArgumentList.Add("private");
            start.ArgumentList.Add("sh");
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add("mount --bind \"$FSUSBLOG_BIND_SOURCE\" \"$FSUSBLOG_BIND_TARGET\" && dotnet \"$FSUSBLOG_BIND_PROBE_ASSEMBLY\" --bind-probe \"$FSUSBLOG_BIND_ROOT\"");
            start.Environment["FSUSBLOG_BIND_SOURCE"] = outside;
            start.Environment["FSUSBLOG_BIND_TARGET"] = target;
            start.Environment["FSUSBLOG_BIND_ROOT"] = root.Path;
            start.Environment["FSUSBLOG_BIND_PROBE_ASSEMBLY"] = typeof(LinuxVaultWatcherExt4Tests).Assembly.Location;
            using Process process = Process.Start(start) ?? throw new InvalidOperationException("failed to start bind-mount probe");
            string standardOutput = process.StandardOutput.ReadToEnd();
            string standardError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(10000), "bind-mount probe timed out");
            Assert.True(process.ExitCode == 0, $"bind-mount probe failed exit={process.ExitCode} stdout={standardOutput} stderr={standardError}");
            Assert.Contains("linux_vault_mount_changed", standardOutput, StringComparison.Ordinal);
            Assert.Contains("linux_vault_root_mount_changed_on_attrib", standardOutput, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(outside, recursive: true);
        }

    }

    [Fact]
    public void Restart_ChangesWatchInstanceAndRequiresRescan()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string firstIdentity;
        using (LinuxVaultWatcherSession first = root.Open())
        {
            firstIdentity = first.Identity.WatchInstanceIdentity;
            _ = first.ReadAvailable();
            _ = first.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);
            Assert.False(first.Watermark.IsValid);
            Assert.Equal("linux_vault_watcher_restart", first.Watermark.InvalidatedReasonCode);
            Assert.Null(first.Watermark.RescanReceiptSha256);
        }

        using LinuxVaultWatcherSession second = root.Open();
        LinuxVaultRawFact restart = Assert.Single(second.ReadAvailable(), item => item.FactClass == LinuxVaultFactClass.WatcherRestarted);
        Assert.NotEqual(firstIdentity, second.Identity.WatchInstanceIdentity);
        Assert.True(restart.RescanRequired);
        Assert.False(second.Watermark.IsValid);
    }

    [Fact]
    public void Dispose_ReleasesInotifyDescriptor()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        int before = Directory.EnumerateFileSystemEntries("/proc/self/fd").Count();

        for (int index = 0; index < 8; index++)
        {
            using LinuxVaultWatcherSession session = root.Open();
            _ = session.ReadAvailable();
        }

        int after = Directory.EnumerateFileSystemEntries("/proc/self/fd").Count();
        Assert.True(after <= before + 1, $"inotify descriptor leak: before={before} after={after}");
    }
}

internal sealed class LinuxVaultTestRoot : IDisposable
{
    internal const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private readonly string _repositoryRoot;

    private LinuxVaultTestRoot(string repositoryRoot, string path, ArticleVaultRootManifest manifest)
    {
        _repositoryRoot = repositoryRoot;
        Path = path;
        Manifest = manifest;
    }

    internal string Path
    {
        get;
    }

    internal ArticleVaultRootManifest Manifest
    {
        get;
    }

    internal static LinuxVaultTestRoot Create()
    {
        string repository = FindRepositoryRoot();
        string parent = System.IO.Path.Combine(repository, ".tmp", "article-vault-linux-tests");
        Directory.CreateDirectory(parent);
        string root = System.IO.Path.Combine(parent, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(System.IO.Path.Combine(root, ".fsus", "articles"));
        Directory.CreateDirectory(System.IO.Path.Combine(root, ".fsus", "receipts"));

        var unsealed = new ArticleVaultRootManifest(
            ArticleVaultSchemas.RootManifest,
            ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new(
                ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory),
            "site-linux-test",
            "vault-linux-test",
            "device-linux-test",
            [],
            [],
            string.Empty);
        ArticleVaultRootManifest manifest = unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
        };
        File.WriteAllBytes(
            System.IO.Path.Combine(root, ".fsus", "vault.json"),
            ArticleVaultManifestCodec.Serialize(manifest));
        return new LinuxVaultTestRoot(repository, root, manifest);
    }

    internal LinuxVaultWatcherSession Open(LinuxVaultWatcherOptions? options = null)
        => Open(Path, options);

    internal LinuxVaultWatcherSession Open(string path, LinuxVaultWatcherOptions? options = null)
        => LinuxVaultWatcherSession.Open(new(
            path,
            Manifest,
            "linux-watcher-test-agent",
            options ?? new LinuxVaultWatcherOptions()));

    internal static IReadOnlyList<LinuxVaultRawFact> WaitFor(
        LinuxVaultWatcherSession session,
        Func<LinuxVaultRawFact, bool> predicate,
        TimeSpan? timeout = null)
    {
        var facts = new List<LinuxVaultRawFact>();
        DateTime deadline = DateTime.UtcNow.Add(timeout ?? TimeSpan.FromSeconds(5));
        while (DateTime.UtcNow < deadline)
        {
            facts.AddRange(session.ReadAvailable());
            if (facts.Any(predicate))
            {
                return facts;
            }

            Thread.Sleep(10);
        }

        throw new Xunit.Sdk.XunitException($"Expected inotify fact was not observed. Facts: {string.Join(", ", facts.Select(static item => $"{item.FactClass}:{item.RawOldRelativePath}->{item.RawNewRelativePath}:{item.ErrorCode}"))}");
    }

    internal static string FindRepositoryRoot()
    {
        string? current = AppContext.BaseDirectory;
        while (current is not null)
        {
            if (File.Exists(System.IO.Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            current = Directory.GetParent(current)?.FullName;
        }

        throw new InvalidOperationException("repository root not found");
    }

    public void Dispose()
    {
        string expectedParent = System.IO.Path.Combine(_repositoryRoot, ".tmp", "article-vault-linux-tests");
        if (LinuxVaultRootVerifierForTest.IsContained(expectedParent, Path) && Directory.Exists(Path))
        {
            Directory.Delete(Path, recursive: true);
        }
    }

    private static class LinuxVaultRootVerifierForTest
    {
        internal static bool IsContained(string root, string candidate)
            => candidate.StartsWith(root + System.IO.Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }
}

public static class LinuxVaultBindMountProbeProgram
{
    public static int Main(string[] args)
    {
        if (args.Length != 2 || args[0] != "--bind-probe")
        {
            // Issue #2675 qualification probes keep this assembly's single startup object.
            return LinuxVaultAgentProbeProgram.Main(args);
        }

        try
        {
            string root = args[1];
            ArticleVaultRootManifest manifest = ArticleVaultManifestCodec.DeserializeRoot(
                File.ReadAllBytes(Path.Combine(root, ".fsus", "vault.json")));
            using LinuxVaultWatcherSession session = LinuxVaultWatcherSession.Open(new(
                root,
                manifest,
                "linux-watcher-bind-probe",
                new LinuxVaultWatcherOptions()));
            LinuxVaultRawFact? blocked = session.ReadAvailable()
                .FirstOrDefault(static item => item.ErrorCode == "linux_vault_mount_changed");
            if (blocked is null || !blocked.RescanRequired || blocked.PathDisposition != LinuxVaultPathDisposition.Blocked)
            {
                return 2;
            }

            Console.WriteLine(blocked.ErrorCode);

            int rootWatchDescriptor = RootWatchDescriptor(session);
            string replacement = Environment.GetEnvironmentVariable("FSUSBLOG_BIND_SOURCE")
                ?? throw new InvalidOperationException("bind source is missing");
            var mountStart = new ProcessStartInfo("mount")
            {
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false
            };
            mountStart.ArgumentList.Add("--bind");
            mountStart.ArgumentList.Add(replacement);
            mountStart.ArgumentList.Add(root);
            using Process mount = Process.Start(mountStart)
                ?? throw new InvalidOperationException("failed to start root mount-drift probe");
            string mountOutput = mount.StandardOutput.ReadToEnd();
            string mountError = mount.StandardError.ReadToEnd();
            if (!mount.WaitForExit(5000) || mount.ExitCode != 0)
            {
                Console.Error.WriteLine($"root mount-drift setup failed stdout={mountOutput} stderr={mountError}");
                return 3;
            }

            var convertRecord = typeof(LinuxVaultWatcherSession).GetMethod(
                "ConvertRecord",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("raw conversion entrypoint is missing");
            var drift = (LinuxVaultRawFact?)convertRecord.Invoke(
                session,
                [rootWatchDescriptor, 0x00000004u, 0u, null]);
            if (drift is null
                || drift.ErrorCode != "linux_vault_mount_changed"
                || drift.PathDisposition != LinuxVaultPathDisposition.Blocked
                || !drift.RescanRequired
                || drift.WatermarkValid
                || !LinuxVaultRawFactCodec.Validate(drift))
            {
                return 4;
            }

            Console.WriteLine("linux_vault_root_mount_changed_on_attrib");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return 1;
        }
    }

    internal static int RootWatchDescriptor(LinuxVaultWatcherSession session)
    {
        var watches = (System.Collections.IEnumerable?)typeof(LinuxVaultWatcherSession)
            .GetField("_watches", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
            ?.GetValue(session)
            ?? throw new InvalidOperationException("watch registry is missing");
        foreach (object pair in watches)
        {
            Type pairType = pair.GetType();
            object value = pairType.GetProperty("Value")!.GetValue(pair)!;
            string relativePath = (string)value.GetType().GetProperty("RelativePath")!.GetValue(value)!;
            if (relativePath.Length == 0)
            {
                return (int)pairType.GetProperty("Key")!.GetValue(pair)!;
            }
        }

        throw new InvalidOperationException("root watch descriptor is missing");
    }
}
