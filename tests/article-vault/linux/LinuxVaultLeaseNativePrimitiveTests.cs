using System.Net.Sockets;
using System.Reflection;
using System.Runtime.Versioning;

using FsusBlog.ArticleVault.Linux;

using Microsoft.Win32.SafeHandles;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

/// <summary>Exercises actual compiled Linux syscalls; this does not bypass the runtime namespace gate.</summary>
[Trait("Category", "LinuxArticleVaultAgentNativePrimitives")]
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultLeaseNativePrimitiveTests
{
    private static readonly Type s_native = typeof(LinuxVaultWriterLeaseScope).Assembly
        .GetType("FsusBlog.ArticleVault.Linux.LinuxVaultLeaseNative", throwOnError: true)!;

    [Fact]
    public void ActualKernelLockPrimitive_ExcludesHandlesWithoutClaimingFilesystemAdmission()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string path = Path.Combine(root.Path, "native-lock-primitive");
        File.WriteAllText(path, string.Empty);
        using SafeFileHandle first = Open(path);
        using SafeFileHandle second = Open(path);
        Assert.Equal(0, Call("Lock", Descriptor(first), 2 | 4));
        Assert.NotEqual(0, Call("Lock", Descriptor(second), 2 | 4));
        first.Dispose();
        Assert.Equal(0, Call("Lock", Descriptor(second), 2 | 4));
        // The separate admission test retains RequirePrivate and its supported-filesystem gate.
    }

    [Fact]
    public void ActualKernelFlock_ExcludesIndependentHandlesAndReleasesOnClose()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string path = Path.Combine(root.Path, "native-lease-control");
        File.WriteAllText(path, string.Empty);
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        using SafeFileHandle first = Open(path);
        using SafeFileHandle second = Open(path);
        Call("RequirePrivate", first, false);
        Assert.Equal(0, Call("Lock", Descriptor(first), 2 | 4));
        Assert.NotEqual(0, Call("Lock", Descriptor(second), 2 | 4));
        first.Dispose();
        Assert.Equal(0, Call("Lock", Descriptor(second), 2 | 4));
        Assert.True(File.Exists(path));
        long before = (long)Call("BootMilliseconds")!;
        long after = (long)Call("BootMilliseconds")!;
        Assert.True(after >= before);
    }

    [Fact]
    public void ActualNativeLeasePermissionGuard_RejectsBroadModeAndSymlink()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string path = Path.Combine(root.Path, "native-lease-control");
        File.WriteAllText(path, string.Empty);
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead);
        using SafeFileHandle file = Open(path);
        InvalidDataException error = Assert.Throws<InvalidDataException>(() => Call("RequirePrivate", file, false));
        Assert.Equal("writer_lease_permissions_blocked", error.Message);
        string link = path + "-link";
        File.CreateSymbolicLink(link, path);
        Assert.True((int)Call("OpenAt", -100, link, 2 | 0x800 | 0x20000 | 0x80000)! < 0);
    }

    [Fact]
    public async Task ActualUnixPeerAndOwnedDisposal_KeepReplacedUserFile()
    {
        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        string path = Path.Combine(root.Path, "native.socket");
        using Socket listener = (Socket)Call("CreateLocalListener", path)!;
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        _ = Call("RequirePrivateSocket", path);
        listener.Listen(1);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        Task<Socket> accepting = listener.AcceptAsync(cancellation.Token).AsTask();
        using var client = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        await client.ConnectAsync(new UnixDomainSocketEndPoint(path), cancellation.Token);
        using Socket peer = await accepting;
        Call("RequireCurrentUserPeer", peer);
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead);
        Assert.Throws<InvalidDataException>(() => Call("RequirePrivateSocket", path));
        File.Move(path, path + "-retained");
        File.WriteAllText(path, "owned-user-content\n");
        listener.Dispose();
        Assert.Equal("owned-user-content\n", File.ReadAllText(path));
    }

    private static int Descriptor(SafeFileHandle handle) => checked((int)handle.DangerousGetHandle());

    private static SafeFileHandle Open(string path)
        => (SafeFileHandle)Call("Own", Call("OpenAt", -100, path, 2 | 0x800 | 0x20000 | 0x80000))!;

    private static object? Call(string method, params object?[] arguments)
    {
        try
        {
            return s_native.GetMethod(method, BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, arguments);
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(exception.InnerException).Throw();
            throw;
        }
    }
}
