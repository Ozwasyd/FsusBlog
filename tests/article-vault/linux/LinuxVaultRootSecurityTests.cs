using System.Reflection;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "LinuxArticleVaultWatcher")]
public sealed class LinuxVaultRootSecurityTests
{
    private const int ManifestLimit = 1024 * 1024;
    private const long ManifestAllocationBudget = 4 * 1024 * 1024;
    private static readonly Action<string, ArticleVaultRootManifest> s_verifyControlManifest = typeof(LinuxVaultWatcherSession)
        .Assembly.GetType("FsusBlog.ArticleVault.Linux.LinuxVaultRootVerifier", throwOnError: true)!
        .GetMethod("VerifyControlManifest", BindingFlags.NonPublic | BindingFlags.Static)!
        .CreateDelegate<Action<string, ArticleVaultRootManifest>>();

    [Theory]
    [InlineData(0, "linux_vault_root_manifest_unreadable")]
    [InlineData(ManifestLimit - 1, null)]
    [InlineData(ManifestLimit, null)]
    [InlineData(ManifestLimit + 1, "linux_vault_root_manifest_too_large")]
    public void ControlManifest_EnforcesOriginalByteBoundary(int length, string? reason)
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        WritePaddedManifest(root, length);

        if (reason is null)
        {
            s_verifyControlManifest(root.Path, root.Manifest);
        }
        else
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(
                () => s_verifyControlManifest(root.Path, root.Manifest));
            Assert.Equal(reason, error.ReasonCode);
        }
    }

    [Fact]
    public void ControlManifest_OversizeAllocationStaysWithinFixedBudget()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        WritePaddedManifest(root, ManifestLimit + 1);
        Assert.Throws<LinuxVaultWatcherException>(() => s_verifyControlManifest(root.Path, root.Manifest));
        using (var writer = new FileStream(ManifestPath(root), FileMode.Open, FileAccess.Write))
        {
            // A sparse file makes the allocation regression observable without a large test payload.
            writer.SetLength(32 * 1024 * 1024);
        }

        long before = GC.GetAllocatedBytesForCurrentThread();
        LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(
            () => s_verifyControlManifest(root.Path, root.Manifest));
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal("linux_vault_root_manifest_too_large", error.ReasonCode);
        Assert.True(allocated < ManifestAllocationBudget, $"manifest allocated {allocated} bytes; budget={ManifestAllocationBudget}");
    }

    [Fact]
    public void ControlManifest_PreservesSealedIdentityBinding()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        ArticleVaultRootManifest changed = root.Manifest with
        {
            SiteIdentity = "other-site",
            ContentSha256 = string.Empty
        };
        changed = changed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(changed)
        };
        File.WriteAllBytes(ManifestPath(root), ArticleVaultManifestCodec.Serialize(changed));

        LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(
            () => s_verifyControlManifest(root.Path, root.Manifest));
        Assert.Equal("linux_vault_root_manifest_binding_mismatch", error.ReasonCode);
    }

    [Fact]
    public void ControlManifest_PreservesMalformedInputAndDigestRejection()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string valid = File.ReadAllText(ManifestPath(root));
        foreach (string invalid in new[] { "{", valid.Replace(root.Manifest.ContentSha256, LinuxVaultTestRoot.DigestA, StringComparison.Ordinal) })
        {
            File.WriteAllText(ManifestPath(root), invalid);
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(
                () => s_verifyControlManifest(root.Path, root.Manifest));
            Assert.Equal("linux_vault_root_manifest_unreadable", error.ReasonCode);
        }
    }

    [Fact]
    public void ControlManifest_SymlinkRemainsRejected()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string saved = Path.Combine(root.Path, "saved-manifest.json");
        File.Move(ManifestPath(root), saved);
        File.CreateSymbolicLink(ManifestPath(root), saved);

        LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(
            () => s_verifyControlManifest(root.Path, root.Manifest));
        Assert.Equal("linux_vault_control_tree_missing_or_unsafe", error.ReasonCode);
    }

    [Fact]
    public void ControlManifest_FailedReadsReleaseFileDescriptors()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        WritePaddedManifest(root, ManifestLimit + 1);
        for (int attempt = 0; attempt < 20; attempt++)
        {
            Assert.Throws<LinuxVaultWatcherException>(() => s_verifyControlManifest(root.Path, root.Manifest));
            Assert.DoesNotContain(Directory.EnumerateFileSystemEntries("/proc/self/fd"),
                descriptor => new FileInfo(descriptor).LinkTarget == ManifestPath(root));
        }

        File.WriteAllText(ManifestPath(root), "{");
        Assert.Throws<LinuxVaultWatcherException>(() => s_verifyControlManifest(root.Path, root.Manifest));
        Assert.DoesNotContain(Directory.EnumerateFileSystemEntries("/proc/self/fd"),
            descriptor => new FileInfo(descriptor).LinkTarget == ManifestPath(root));
        File.WriteAllBytes(ManifestPath(root), ArticleVaultManifestCodec.Serialize(root.Manifest));
        s_verifyControlManifest(root.Path, root.Manifest);
    }

    [Theory]
    [InlineData(ManifestLimit - 1)]
    [InlineData(ManifestLimit)]
    [InlineData(ManifestLimit + 1)]
    [InlineData(32 * 1024 * 1024)]
    public void ControlManifest_BoundsActualReadsWhenFileGrows(int finalLength)
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        WritePaddedManifest(root, ManifestLimit - 1);
        Func<Stream, ArticleVaultRootManifest> read = ControlManifestReader();
        using var stream = new ChunkedManifestStream(
            new FileStream(ManifestPath(root), FileMode.Open, FileAccess.Read, FileShare.ReadWrite),
            afterFirstRead: () =>
            {
                using var writer = new FileStream(ManifestPath(root), FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
                writer.SetLength(finalLength);
                if (finalLength == ManifestLimit)
                {
                    writer.Position = ManifestLimit - 1;
                    writer.WriteByte((byte)' ');
                }
            });

        Assert.Equal(ManifestLimit - 1, stream.Length);
        long before = GC.GetAllocatedBytesForCurrentThread();
        if (finalLength <= ManifestLimit)
        {
            Assert.Equal(root.Manifest.ContentSha256, read(stream).ContentSha256);
        }
        else
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() => read(stream));
            Assert.Equal("linux_vault_root_manifest_too_large", error.ReasonCode);
        }

        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.True(allocated < ManifestAllocationBudget, $"growing manifest allocated {allocated} bytes; budget={ManifestAllocationBudget}");
        Assert.Equal(Math.Min(finalLength, ManifestLimit + 1), stream.BytesRead);
        Assert.Equal(finalLength, new FileInfo(ManifestPath(root)).Length);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ControlManifest_InterruptedReadPropagatesAndOwnerClosesStream(bool canceled)
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        WritePaddedManifest(root, ManifestLimit);
        Func<Stream, ArticleVaultRootManifest> read = ControlManifestReader();
        Exception failure = canceled ? new OperationCanceledException() : new IOException("read interrupted");
        var stream = new ChunkedManifestStream(File.OpenRead(ManifestPath(root)), failure: failure);
        using (stream)
        {
            Assert.Same(failure, Record.Exception(() => read(stream)));
            Assert.Equal(4096, stream.BytesRead);
        }

        Assert.True(stream.Disposed);
        Assert.DoesNotContain(Directory.EnumerateFileSystemEntries("/proc/self/fd"),
            descriptor => new FileInfo(descriptor).LinkTarget == ManifestPath(root));
    }

    private static Func<Stream, ArticleVaultRootManifest> ControlManifestReader()
        => typeof(LinuxVaultWatcherSession).Assembly
            .GetType("FsusBlog.ArticleVault.Linux.LinuxVaultRootVerifier", throwOnError: true)!
            .GetMethod("ReadControlManifest", BindingFlags.NonPublic | BindingFlags.Static)!
            .CreateDelegate<Func<Stream, ArticleVaultRootManifest>>();

    private static string ManifestPath(LinuxVaultTestRoot root)
        => Path.Combine(root.Path, ".fsus", "vault.json");

    private static void WritePaddedManifest(LinuxVaultTestRoot root, int length)
    {
        byte[] payload = ArticleVaultManifestCodec.Serialize(root.Manifest);
        byte[] bytes = new byte[length];
        bytes.AsSpan().Fill((byte)' ');
        payload.AsSpan(0, Math.Min(payload.Length, length)).CopyTo(bytes);
        File.WriteAllBytes(ManifestPath(root), bytes);
    }

    private sealed class ChunkedManifestStream(Stream inner, Action? afterFirstRead = null, Exception? failure = null) : Stream
    {
        internal int BytesRead
        {
            get; private set;
        }
        internal bool Disposed
        {
            get; private set;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(Span<byte> buffer)
        {
            if (BytesRead > 0 && failure is not null)
            {
                throw failure;
            }

            int count = inner.Read(buffer[..Math.Min(buffer.Length, 4096)]);
            bool firstRead = BytesRead == 0;
            BytesRead += count;
            if (firstRead)
            {
                afterFirstRead?.Invoke();
            }

            return count;
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                Disposed = true;
            }

            base.Dispose(disposing);
        }
    }

    [Fact]
    public void RootSymlink_IsRejectedBeforeWatchCreation()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string link = root.Path + "-link";
        Directory.CreateSymbolicLink(link, root.Path);
        try
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() => root.Open(link));
            Assert.Equal("linux_vault_root_symlink_rejected", error.ReasonCode);
        }
        finally
        {
            Directory.Delete(link);
        }
    }

    [Fact]
    public void NestedSymlink_ProducesBlockedRescanFactWithoutFollowingIt()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        Directory.CreateSymbolicLink(Path.Combine(root.Path, "escape"), Path.GetDirectoryName(root.Path)!);

        using LinuxVaultWatcherSession session = root.Open();
        IReadOnlyList<LinuxVaultRawFact> facts = session.ReadAvailable();

        LinuxVaultRawFact blocked = Assert.Single(facts, item => item.ErrorCode == "linux_vault_symlink_rejected");
        Assert.Equal("escape", blocked.RawNewRelativePath);
        Assert.Equal(LinuxVaultPathDisposition.Blocked, blocked.PathDisposition);
        Assert.True(blocked.RescanRequired);
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public void ControlTreeMutation_IsAuditedAndInvalidatesWatermark()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = root.Open();
        _ = session.ReadAvailable();
        _ = session.AcknowledgeRescan(LinuxVaultTestRoot.DigestA);

        string receipt = Path.Combine(root.Path, ".fsus", "receipts", "operation.json");
        File.WriteAllBytes(receipt, [1, 2, 3]);
        IReadOnlyList<LinuxVaultRawFact> facts = LinuxVaultTestRoot.WaitFor(
            session,
            item => item.RawNewRelativePath == ".fsus/receipts/operation.json");

        Assert.Contains(facts, item => item.PathDisposition == LinuxVaultPathDisposition.ControlTree && item.RescanRequired);
        Assert.False(session.Watermark.IsValid);
    }

    [Fact]
    public void CaseCollidingControlDirectory_IsBlocked()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        Directory.CreateDirectory(Path.Combine(root.Path, ".FSUS"));

        using LinuxVaultWatcherSession session = root.Open();
        IReadOnlyList<LinuxVaultRawFact> facts = session.ReadAvailable();

        Assert.Contains(facts, item => item.ErrorCode == "linux_vault_control_tree_case_collision"
            && item.PathDisposition == LinuxVaultPathDisposition.Blocked
            && item.RescanRequired);
    }
}
