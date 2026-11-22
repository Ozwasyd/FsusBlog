using System.Runtime.InteropServices;
using FsusBlog.V2.Platform;

namespace FsusBlog.V2.Platform.Tests;

public sealed class NativeUnixFileTests
{
    [Fact]
    public void RefusesLinksAndKeepsAnAlreadyOpenedDirectory()
    {
        if (OperatingSystem.IsWindows() || !NativeUnixFile.Supported) return;
        using var scratch = new PlatformScratchDirectory("fsus-native-file-");
        var published = Directory.CreateDirectory(Path.Combine(scratch.FullName, "publish"));
        var input = Path.Combine(published.FullName, "input");
        File.WriteAllText(input, "first");
        File.SetUnixFileMode(input, UnixFileMode.UserRead);
        File.CreateSymbolicLink(Path.Combine(published.FullName, "linked-input"), input);
        Directory.CreateSymbolicLink(Path.Combine(scratch.FullName, "linked-directory"), published.FullName);

        Assert.Throws<IOException>(() => NativeUnixFile.OpenDirectory(Path.Combine(scratch.FullName, "linked-directory")));
        using var directory = NativeUnixFile.OpenDirectory(published.FullName);
        using var linked = NativeUnixFile.OpenFile(directory, "linked-input", NativeUnixFile.FileReadFlags, out var error);
        Assert.Null(linked);
        Assert.NotEqual(NativeUnixFile.NotFound, error);

        Directory.Move(published.FullName, Path.Combine(scratch.FullName, "original"));
        Directory.CreateDirectory(published.FullName);
        File.WriteAllText(input, "second");
        using var handle = NativeUnixFile.OpenFile(directory, "input", NativeUnixFile.FileReadFlags, out error);
        Assert.NotNull(handle);
        Assert.Equal(0, error);
        Assert.True(NativeUnixFile.IsRegular(handle, UnixFileMode.UserRead, owned: true));
        using var inputStream = new StreamReader(new FileStream(handle, FileAccess.Read));
        Assert.Equal("first", inputStream.ReadToEnd());
    }

    [Fact]
    public void InspectsTypeAndPermissionsEvenWhenThePathChanges()
    {
        if (OperatingSystem.IsWindows() || !NativeUnixFile.Supported) return;
        using var scratch = new PlatformScratchDirectory("fsus-native-file-");
        var input = Path.Combine(scratch.FullName, "input");
        File.WriteAllText(input, "original");
        File.SetUnixFileMode(input, UnixFileMode.UserRead);
        using var directory = NativeUnixFile.OpenDirectory(scratch.FullName);
        using var handle = NativeUnixFile.OpenFile(directory, "input", NativeUnixFile.FileReadFlags, out _);
        Assert.NotNull(handle);
        File.Move(input, Path.Combine(scratch.FullName, "original"));
        File.WriteAllText(input, "replacement");
        File.SetUnixFileMode(input, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Assert.True(NativeUnixFile.IsRegular(handle, UnixFileMode.UserRead, owned: true));

        const string pipe = "pending";
        Assert.Equal(0, MakeFifo(Path.Combine(scratch.FullName, pipe), 0x100));
        using var special = NativeUnixFile.OpenFile(directory, pipe, NativeUnixFile.FileReadFlags, out _);
        Assert.NotNull(special);
        Assert.False(NativeUnixFile.IsRegular(special));
    }

    [DllImport("libc", EntryPoint = "mkfifo", SetLastError = true)]
    private static extern int MakeFifo([MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint mode);
}
