using System.Diagnostics;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

using Xunit;

namespace FsusBlog.ArticleVault.Observations.Tests;

[Trait("Category", "LinuxArticleVaultSnapshotNative")]
public sealed class LinuxVaultSnapshotReaderNativeTests
{
    [Fact]
    public void RealRootBoundRead_EqualSamplesWithoutCompletionReturnNoBodyOrAdmission()
    {
        using TestRoot root = new();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        var reader = new LinuxVaultSnapshotReader(scope, root.Manifest);
        LinuxVaultSnapshotReadResult result = reader.Read("articles/first.md", ["articles/first.md"]);
        Assert.Equal(VaultSnapshotAssessmentState.IncompleteWrite, result.Assessment?.State);
        Assert.Equal("vault_snapshot_completion_unproven", result.ReasonCode);
        Assert.Empty(result.CandidateBytes);
        Assert.False(result.CanAdmitSynchronization);
        Assert.True(result.RequiresRetry);
    }

    [Fact]
    public void RealRootDisposedAndControlPath_ReturnStructuredDenialWithoutCachedBody()
    {
        using TestRoot root = new();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        var reader = new LinuxVaultSnapshotReader(scope, root.Manifest);
        LinuxVaultSnapshotReadResult control = reader.Read(ArticleVaultSchemas.RootManifestPath, []);
        Assert.Null(control.Assessment);
        Assert.Empty(control.CandidateBytes);
        scope.Dispose();
        LinuxVaultSnapshotReadResult closed = reader.Read("articles/first.md", []);
        Assert.Equal("vault_snapshot_scope_or_descriptor_closed", closed.ReasonCode);
        Assert.Empty(closed.CandidateBytes);
        Assert.False(closed.CanAdmitSynchronization);
    }

    [Fact]
    public void RealEmptySourceAndPreCancelledRead_CannotYieldPartialSnapshot()
    {
        using TestRoot root = new();
        File.WriteAllBytes(System.IO.Path.Combine(root.Path, "articles/first.md"), []);
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        var reader = new LinuxVaultSnapshotReader(scope, root.Manifest);
        LinuxVaultSnapshotReadResult empty = reader.Read("articles/first.md", []);
        Assert.Equal(VaultSnapshotAssessmentState.IncompleteWrite, empty.Assessment?.State);
        Assert.Empty(empty.CandidateBytes);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => reader.Read("articles/first.md", [], cancellationToken: cancelled.Token));
    }

    [Fact]
    public void KernelGuardedRead_ProducesOnlyImmutableInodeBytesAndPreservesLegacyRefusal()
    {
        using TestRoot root = new();
        string source = System.IO.Path.Combine(root.Path, "articles/first.md");
        byte[] expected = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes("synthetic  \r\nsecond\n")).ToArray();
        File.WriteAllBytes(source, expected);
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        var reader = new LinuxVaultSnapshotReader(scope, root.Manifest);
        LinuxVaultStableByteReadResult result = reader.ReadKernelGuarded("articles/first.md", ["articles/first.md"]);
        Assert.True(result.HasStableInodeBytes, result.ReasonCode);
        Assert.Equal(expected, result.Bytes.ToArray());
        Assert.Equal(ArticleVaultManifestCodec.CaptureSourceBytes(expected), result.ByteIdentity);
        Assert.True(result.RequiresNativeCompletionVerification);
        Assert.False(result.CanAdmitSynchronization);
        Assert.False(result.CanCommitBase);
        Assert.False(result.CanExecuteConditionalReplacement);
        Assert.False(result.CanClearWatermark);
        Assert.Empty(reader.Read("articles/first.md", []).CandidateBytes);
        using FileStream writer = File.OpenWrite(source);
        writer.WriteByte(42);
        Assert.Equal(expected, result.Bytes.ToArray());
        Assert.Empty(reader.ReadKernelGuarded("articles/first.md", []).Bytes);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void KernelGuardedRead_RejectsExistingOrPausedWriter(bool truncate)
    {
        using TestRoot root = new();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        using FileStream writer = File.OpenWrite(System.IO.Path.Combine(root.Path, "articles/first.md"));
        if (truncate)
        {
            writer.SetLength(0);
            writer.Write(Encoding.UTF8.GetBytes("paused chunk"));
            writer.Flush();
        }

        LinuxVaultStableByteReadResult result = new LinuxVaultSnapshotReader(scope, root.Manifest)
            .ReadKernelGuarded("articles/first.md", []);
        Assert.Equal("vault_snapshot_lease_writer_present", result.ReasonCode);
        Assert.False(result.HasStableInodeBytes);
        Assert.Empty(result.Bytes);
    }

    [Fact]
    public void KernelGuardedBoundary_RenamePathDriftIsRejectedByOriginalRootOwner()
    {
        using TestRoot root = new();
        using LinuxVaultRootPathScope scope = LinuxVaultRootPathScope.Open(root.Path, root.Manifest, "agent");
        string source = System.IO.Path.Combine(root.Path, "articles/first.md");
        LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() =>
            LinuxVaultSnapshotLeaseNativeTests.WithLease(() => scope.OpenSourceFile("articles/first.md"), (descriptor, check) =>
            {
                File.Move(source, source + ".moved");
                File.WriteAllBytes(source, Encoding.UTF8.GetBytes("synthetic replacement"));
                check();
                scope.RevalidateForUse(descriptor);
            }));
        Assert.Equal("linux_vault_descriptor_path_identity_changed", error.ReasonCode);
        Assert.Empty(new LinuxVaultSnapshotReader(scope, root.Manifest).Read("articles/first.md", []).CandidateBytes);
    }

    private sealed class TestRoot : IDisposable
    {
        internal TestRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsus-vault-snapshot-{Guid.NewGuid():N}");
            Manifest = ArticleVaultSnapshotAssessmentTests.CreateRoot();
            Directory.CreateDirectory(System.IO.Path.Combine(Path, ".fsus"));
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "articles"));
            File.WriteAllBytes(System.IO.Path.Combine(Path, ArticleVaultSchemas.RootManifestPath), ArticleVaultManifestCodec.Serialize(Manifest));
            File.WriteAllBytes(System.IO.Path.Combine(Path, "articles/first.md"), Encoding.UTF8.GetBytes("private source  \r\n"));
        }

        internal string Path
        {
            get;
        }

        internal ArticleVaultRootManifest Manifest
        {
            get;
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}

[Trait("Category", "ArticleVaultSnapshotAssessment")]
public sealed class LinuxVaultSnapshotReaderBoundaryTests
{
    [Fact]
    public void ReaderAcceptsCanonicalScopeAndRelativeProjectionsOnlyAndResultBodyIsNotSerialized()
    {
        Assert.Equal([typeof(LinuxVaultRootPathScope), typeof(ArticleVaultRootManifest)],
            Assert.Single(typeof(LinuxVaultSnapshotReader).GetConstructors()).GetParameters()
                .Select(static parameter => parameter.ParameterType));
        Assert.Empty(typeof(LinuxVaultSnapshotReadResult).GetConstructors());
        Assert.Empty(typeof(LinuxVaultStableByteReadResult).GetConstructors());
        PropertyInfo stableBody = typeof(LinuxVaultStableByteReadResult).GetProperty(nameof(LinuxVaultStableByteReadResult.Bytes))!;
        Assert.NotNull(stableBody.GetCustomAttribute<System.Text.Json.Serialization.JsonIgnoreAttribute>());
        Assert.Null(stableBody.SetMethod);
        PropertyInfo body = typeof(LinuxVaultSnapshotReadResult).GetProperty(nameof(LinuxVaultSnapshotReadResult.CandidateBytes))!;
        Assert.NotNull(body.GetCustomAttribute<System.Text.Json.Serialization.JsonIgnoreAttribute>());
        Assert.Null(body.SetMethod);
        Assert.DoesNotContain(typeof(LinuxVaultSnapshotReader).GetMethods(BindingFlags.Public | BindingFlags.DeclaredOnly | BindingFlags.Instance),
            static method => method.Name is "Write" or "Open" or "Materialize" or "CommitBase");
    }
}

// These real-kernel primitive tests do not reconstruct a root grant. The public producer's
// root/FS admission remains exercised above, and is required independently of these tests.
[Trait("Category", "LinuxArticleVaultSnapshotNative")]
public sealed class LinuxVaultSnapshotLeaseNativeTests
{
    private static readonly MethodInfo s_withLease = typeof(LinuxVaultSnapshotReader).Assembly
        .GetType("FsusBlog.ArticleVault.Observations.LinuxVaultSnapshotNative")!
        .GetMethod("WithReadLease", BindingFlags.Static | BindingFlags.NonPublic)!;

    [Fact]
    public void Lease_NoWriterPreservesBytesCallerSignalMaskAndReleasesDescriptor()
    {
        using SyntheticFile file = new();
        string mask = CallerSignalMask();
        SafeFileHandle? issued = null;
        WithLease(() => issued = File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), (descriptor, check) =>
        {
            Assert.Equal(0, Control(descriptor, 1025, 0));
            byte[] bytes = new byte[file.Bytes.Length];
            Assert.Equal(bytes.Length, RandomAccess.Read(descriptor, bytes, 0));
            Assert.Equal(file.Bytes, bytes);
            check();
        });
        Assert.True(issued!.IsClosed);
        Assert.Equal(mask, CallerSignalMask());
        using FileStream writer = new(file.Path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        writer.WriteByte(42);
    }

    [Theory]
    [InlineData("existing")]
    [InlineData("paused-chunk")]
    [InlineData("same-size")]
    [InlineData("truncate")]
    public void Lease_ExistingWriterCannotAdmitAnyBytes(string operation)
    {
        using SyntheticFile file = new();
        using FileStream writer = new(file.Path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        if (operation == "truncate")
        {
            writer.SetLength(0);
        }
        else if (operation != "existing")
        {
            writer.Write(Encoding.UTF8.GetBytes(operation == "same-size" ? "MUTATION!" : "chunk"));
            writer.Flush();
        }

        bool read = false;
        LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() =>
            WithLease(() => File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), (_, _) => read = true));
        Assert.Equal("vault_snapshot_lease_writer_present", error.ReasonCode);
        Assert.False(read);
    }

    [Theory]
    [InlineData("printf 'MUTATION!' > \"$1\"")]
    [InlineData(": > \"$1\"")]
    public void Lease_NewWriterOrTruncateBreakAbortsAndReleasesWithoutKillingHost(string command)
    {
        using SyntheticFile file = new();
        Process? writer = null;
        try
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() =>
                WithLease(() => File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), (descriptor, check) =>
                {
                    writer = StartWriter(file.Path, command);
                    Assert.True(SpinWait.SpinUntil(() => Control(descriptor, 1025, 0) == 2, TimeSpan.FromSeconds(5)));
                    Assert.False(writer.HasExited);
                    check();
                }));
            Assert.Equal("vault_snapshot_lease_broken", error.ReasonCode);
            Assert.True(writer!.WaitForExit(5000));
            Assert.Equal(0, writer.ExitCode);
        }
        finally
        {
            StopWriter(writer);
        }
    }

    [Fact]
    public void Lease_ForcedKernelExpiryFailsEvenWhenNotificationWasConsumed()
    {
        using SyntheticFile file = new();
        int breakSeconds = int.Parse(File.ReadAllText("/proc/sys/fs/lease-break-time"), System.Globalization.CultureInfo.InvariantCulture);
        Process? writer = null;
        try
        {
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() =>
                WithLease(() => File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), (descriptor, check) =>
                {
                    writer = StartWriter(file.Path, "printf 'MUTATION!' > \"$1\"");
                    Assert.True(SpinWait.SpinUntil(() => Control(descriptor, 1025, 0) == 2, TimeSpan.FromSeconds(5)));
                    // Only this test deliberately drains its dedicated thread's notification.
                    // Production never consumes SIGIO. The kernel status must still reject.
                    var signals = new SignalSet();
                    Assert.Equal(0, EmptySignalSet(ref signals));
                    Assert.Equal(0, AddSignal(ref signals, 29));
                    var zero = new SignalTimeout();
                    Assert.Equal(29, WaitSignal(ref signals, IntPtr.Zero, ref zero));
                    Assert.True(writer.WaitForExit(checked((breakSeconds + 10) * 1000)));
                    Assert.Equal(0, writer.ExitCode);
                    Assert.Equal(2, Control(descriptor, 1025, 0));
                    check();
                }));
            Assert.Equal("vault_snapshot_lease_broken", error.ReasonCode);
        }
        finally
        {
            StopWriter(writer);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Lease_CancellationAndExceptionReleaseOwnedFd(bool cancel)
    {
        using SyntheticFile file = new();
        using var cancellation = new CancellationTokenSource();
        SafeFileHandle? issued = null;
        Exception? error = Record.Exception(() => WithLease(() => issued = File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), (_, check) =>
        {
            if (cancel)
            {
                cancellation.Cancel();
                check();
            }

            throw new InvalidDataException("synthetic interruption");
        }, cancellation.Token));
        Assert.IsType(cancel ? typeof(OperationCanceledException) : typeof(InvalidDataException), error);
        Assert.True(issued!.IsClosed);
        using FileStream writer = new(file.Path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
    }

    [Fact]
    public void Lease_ConcurrentDescriptorDisposalDoesNotUnlockReusedFd()
    {
        using SyntheticFile file = new();
        WithLease(() => File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), (descriptor, _) =>
        {
            descriptor.Dispose();
            using SafeFileHandle unrelated = File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            Assert.Equal(2, Control(unrelated, 1025, 0));
        });
        using FileStream writer = new(file.Path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
    }

    [Fact]
    public void Lease_RenamePreservesInodeBytesWithoutProvidingNamespaceCas()
    {
        using SyntheticFile file = new();
        string moved = file.Path + ".moved";
        try
        {
            WithLease(() => File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete), (descriptor, check) =>
            {
                File.Move(file.Path, moved);
                File.WriteAllBytes(file.Path, Encoding.UTF8.GetBytes("replacement"));
                byte[] bytes = new byte[file.Bytes.Length];
                Assert.Equal(bytes.Length, RandomAccess.Read(descriptor, bytes, 0));
                Assert.Equal(file.Bytes, bytes);
                check();
            });
            Assert.Equal("replacement", File.ReadAllText(file.Path));
        }
        finally
        {
            File.Delete(moved);
        }
    }

    [Fact]
    public void Lease_DoesNotConsumeAnotherComponentsProcessPendingNotification()
    {
        const string ChildMarker = "FSUSBLOG_SYNTHETIC_SIGIO_CHILD";
        if (Environment.GetEnvironmentVariable(ChildMarker) == "1")
        {
            using SyntheticFile file = new();
            Assert.Equal(0, SendProcessSignal(Environment.ProcessId, 29));
            LinuxVaultWatcherException error = Assert.Throws<LinuxVaultWatcherException>(() =>
                WithLease(() => File.OpenHandle(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite), (_, _) =>
                    throw new InvalidOperationException("pending notification must deny before reading")));
            Assert.Equal("vault_snapshot_lease_broken", error.ReasonCode);
            var pending = new SignalSet();
            Assert.Equal(0, PendingSignals(ref pending));
            Assert.Equal(1, ContainsSignal(ref pending, 29));
            return;
        }

        // Launch a separate test host with SIGIO blocked before any CLR thread exists. This
        // models a different component owning a process-pending notification without changing
        // this host's global disposition, masking other threads, or installing SIG_IGN.
        var start = new ProcessStartInfo("python3")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add("import os,signal,sys; signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGIO}); os.execvp(sys.argv[1],sys.argv[1:])");
        start.ArgumentList.Add(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet");
        start.ArgumentList.Add("vstest");
        start.ArgumentList.Add(typeof(LinuxVaultSnapshotLeaseNativeTests).Assembly.Location);
        start.ArgumentList.Add("--TestCaseFilter:FullyQualifiedName=" + typeof(LinuxVaultSnapshotLeaseNativeTests).FullName
            + "." + nameof(Lease_DoesNotConsumeAnotherComponentsProcessPendingNotification));
        start.Environment[ChildMarker] = "1";
        using Process child = Process.Start(start)!;
        try
        {
            Assert.True(child.WaitForExit(30000));
            Assert.True(child.ExitCode == 0, child.StandardOutput.ReadToEnd() + child.StandardError.ReadToEnd());
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                Assert.True(child.WaitForExit(5000));
            }
        }
    }

    internal static void WithLease(Func<SafeFileHandle> open, Action<SafeFileHandle, Action> read,
        CancellationToken cancellationToken = default)
    {
        try
        {
            s_withLease.Invoke(null, [open, read, cancellationToken]);
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(exception.InnerException).Throw();
        }
    }

    private static string CallerSignalMask() => File.ReadLines("/proc/thread-self/status")
        .Single(static line => line.StartsWith("SigBlk:", StringComparison.Ordinal));

    private static Process StartWriter(string path, string command)
    {
        var start = new ProcessStartInfo("/bin/sh") { UseShellExecute = false };
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add(command);
        start.ArgumentList.Add("synthetic-vault-writer");
        start.ArgumentList.Add(path);
        return Process.Start(start)!;
    }

    private static void StopWriter(Process? writer)
    {
        if (writer is null)
        {
            return;
        }

        if (!writer.HasExited)
        {
            writer.Kill(entireProcessTree: true);
            Assert.True(writer.WaitForExit(5000));
        }

        writer.Dispose();
    }

    private sealed class SyntheticFile : IDisposable
    {
        internal SyntheticFile()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"fsus-inode-lease-{Guid.NewGuid():N}");
            Bytes = Encoding.UTF8.GetBytes("synthetic");
            File.WriteAllBytes(Path, Bytes);
        }

        internal string Path
        {
            get;
        }

        internal byte[] Bytes
        {
            get;
        }

        public void Dispose() => File.Delete(Path);
    }

    [StructLayout(LayoutKind.Sequential, Size = 128)]
    private struct SignalSet
    {
        private ulong _bits;
    }

    [StructLayout(LayoutKind.Sequential, Size = 16)]
    private struct SignalTimeout
    {
        private long _seconds;
        private long _nanoseconds;
    }

    [DllImport("libc", EntryPoint = "fcntl", SetLastError = true)]
    private static extern int Control(SafeFileHandle descriptor, int command, int argument);

    [DllImport("libc", EntryPoint = "sigemptyset")]
    private static extern int EmptySignalSet(ref SignalSet signals);

    [DllImport("libc", EntryPoint = "sigaddset")]
    private static extern int AddSignal(ref SignalSet signals, int signal);

    [DllImport("libc", EntryPoint = "kill")]
    private static extern int SendProcessSignal(int process, int signal);

    [DllImport("libc", EntryPoint = "sigpending")]
    private static extern int PendingSignals(ref SignalSet signals);

    [DllImport("libc", EntryPoint = "sigismember")]
    private static extern int ContainsSignal(ref SignalSet signals, int signal);

    [DllImport("libc", EntryPoint = "sigtimedwait", SetLastError = true)]
    private static extern int WaitSignal(ref SignalSet signals, IntPtr information, ref SignalTimeout timeout);
}
