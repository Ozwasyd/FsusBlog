using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Algorithms.IO;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Original-file and parser controls; not parent custody or database qualification.</summary>
public sealed class ServerCommandEnvironmentFileTests
{
    [Fact]
    public void OriginalFile_PreservesBomLineAndLiteralParserSemantics()
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "original.env");
            byte[] bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(
                "# comment\r\nexport Connection__Name = ' ${UNCHANGED} ' \rFirst-Flag=one=two\nMixed:Key=\"literal#hash\"\r\nEmpty=\n")).ToArray();
            File.WriteAllBytes(path, bytes);
            using OriginalEnvironmentFile original = ServerCommandEnvironmentFile.OpenOriginal(path);

            Assert.Equal(path, original.CanonicalPath);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), original.ArtifactSha256);
            Assert.Equal(" ${UNCHANGED} ", original.Values["connection:name"]);
            Assert.Equal("one=two", original.Values["First-Flag"]);
            Assert.Equal("literal#hash", original.Values["Mixed:Key"]);
            Assert.Equal("", original.Values["Empty"]);
            Assert.Equal(4, original.Values.Count);
            original.ValidateUnchanged();
            Assert.Equal(bytes, File.ReadAllBytes(path));
            IDictionary<string, string?> dictionary = Assert.IsAssignableFrom<IDictionary<string, string?>>(original.Values);
            Assert.Throws<NotSupportedException>(() => dictionary.Add("forged", "value"));
        });
    }

    [Theory]
    [InlineData("utf16-le")]
    [InlineData("utf16-be")]
    [InlineData("utf32-le")]
    [InlineData("invalid-utf8")]
    public void Read_MatchesOriginalStreamReaderEncodingSemantics(string encoding)
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "encoded.env");
            Encoding selected = encoding switch
            {
                "utf16-le" => Encoding.Unicode,
                "utf16-be" => Encoding.BigEndianUnicode,
                "utf32-le" => Encoding.UTF32,
                _ => Encoding.UTF8
            };
            byte[] bytes = encoding == "invalid-utf8"
                ? [.. "Name="u8.ToArray(), 0xff, (byte)'\n']
                : [.. selected.GetPreamble(), .. selected.GetBytes("Name=literal\n")];
            File.WriteAllBytes(path, bytes);
            string originalLine = File.ReadLines(path).Single();
            Assert.Equal(originalLine[5..], ServerCommandEnvironmentFile.Read(path)["Name"]);
        });
    }

    [Theory]
    [InlineData("broken", "server_env_file_line_invalid")]
    [InlineData(" =value", "server_env_file_line_invalid")]
    [InlineData("invalid.key=value", "server_env_file_key_invalid")]
    [InlineData("Name__Part=one\nname:part=two", "server_env_file_key_duplicate")]
    public void Read_RetainsParserRefusals(string contents, string expected)
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "invalid.env");
            File.WriteAllText(path, contents);
            Assert.Equal(expected, Assert.Throws<InvalidOperationException>(() =>
                ServerCommandEnvironmentFile.Read(path)).Message);
        });
    }

    [Fact]
    public void Read_PreservesEmptyAndRelativeInput()
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "empty.env");
            File.WriteAllBytes(path, []);
            string relative = Path.GetRelativePath(Directory.GetCurrentDirectory(), path);
            Assert.Empty(ServerCommandEnvironmentFile.Read(relative));
        });
    }

    [Theory]
    [InlineData(1024 * 1024, false)]
    [InlineData(1024 * 1024 + 1, true)]
    public void Read_EnforcesEncodedByteBudget(int length, bool refused)
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "bounded.env");
            byte[] bytes = Enumerable.Repeat((byte)' ', length).ToArray();
            File.WriteAllBytes(path, bytes);
            if (refused)
                Assert.Equal("server_env_file_size_invalid", Assert.Throws<InvalidOperationException>(() =>
                    ServerCommandEnvironmentFile.Read(path)).Message);
            else
                Assert.Empty(ServerCommandEnvironmentFile.Read(path));
            Assert.Equal((long)length, new FileInfo(path).Length);
        });
    }

    [Theory]
    [InlineData("leaf-symlink")]
    [InlineData("ancestor-symlink")]
    [InlineData("directory")]
    [InlineData("fifo")]
    public void Read_RefusesLinkedOrNonRegularInputBeforeReading(string variant)
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string original = Path.Combine(directory, "original.env");
            File.WriteAllText(original, "Name=original");
            string input = Path.Combine(directory, "invalid");
            switch (variant)
            {
                case "leaf-symlink":
                    File.CreateSymbolicLink(input, original);
                    break;
                case "ancestor-symlink":
                    Directory.CreateSymbolicLink(input, directory);
                    input = Path.Combine(input, "original.env");
                    break;
                case "directory":
                    Directory.CreateDirectory(input);
                    break;
                case "fifo":
                    Assert.Equal(0, MakeFifo(input, 0x180));
                    break;
            }
            Assert.Throws<InvalidOperationException>(() => ServerCommandEnvironmentFile.Read(input));
            Assert.Equal("Name=original", File.ReadAllText(original));
        });
    }

    [Theory]
    [InlineData("same-byte-new-inode")]
    [InlineData("in-place-change")]
    [InlineData("ancestor-replacement")]
    public void Lease_RefusesOriginalIdentityChanges(string variant)
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string parent = Path.Combine(directory, "parent");
            Directory.CreateDirectory(parent);
            string path = Path.Combine(parent, "original.env");
            File.WriteAllText(path, "Name=original");
            using OriginalEnvironmentFile original = ServerCommandEnvironmentFile.OpenOriginal(path);
            switch (variant)
            {
                case "same-byte-new-inode":
                    string replacement = Path.Combine(parent, "replacement.env");
                    File.WriteAllBytes(replacement, File.ReadAllBytes(path));
                    File.Move(replacement, path, overwrite: true);
                    break;
                case "in-place-change":
                    File.WriteAllText(path, "Name=modified");
                    break;
                case "ancestor-replacement":
                    Directory.Move(parent, parent + "-held");
                    Directory.CreateDirectory(parent);
                    File.Move(Path.Combine(parent + "-held", "original.env"), path);
                    break;
            }
            Assert.Throws<InvalidOperationException>(() => original.ValidateUnchanged());
            Assert.Equal("original", original.Values["Name"]);
        });
    }

    [Fact]
    public void Lease_RefusesAfterDisposeAndPreCancellationDoesNotOpenInput()
    {
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "original.env");
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            Assert.Throws<OperationCanceledException>(() =>
                ServerCommandEnvironmentFile.OpenOriginal(path, cancellation.Token));
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
            if (!SupportsOriginalOwner())
            {
                Assert.Equal("current_verify_native_file_owner_unavailable", Assert.Throws<InvalidOperationException>(() =>
                    ServerCommandEnvironmentFile.Read(path)).Message);
                return;
            }
            File.WriteAllText(path, "Name=original");
            OriginalEnvironmentFile original = ServerCommandEnvironmentFile.OpenOriginal(path);
            original.Dispose();
            original.Dispose();
            Assert.Throws<ObjectDisposedException>(() => original.ValidateUnchanged());
        });
    }

    [Fact]
    public void InheritedOriginal_ReadsWithoutChangingCarrierOffsetAndClosesOnlyDuplicate()
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "inherited.env");
            byte[] bytes = "Name=original"u8.ToArray();
            File.WriteAllBytes(path, bytes);
            using SafeFileHandle carrier = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            int descriptor = carrier.DangerousGetHandle().ToInt32();
            var parentEpoch = NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, carrier, CancellationToken.None);
            Assert.Equal(3L, SeekDescriptor(descriptor, 3, 0));

            OriginalEnvironmentFile imported = ServerCommandEnvironmentFile.OpenOriginalFromInheritedDescriptor(
                path, descriptor, Convert.ToHexStringLower(SHA256.HashData(bytes)), parentEpoch.ObservationSha256);
            Assert.Equal("original", imported.Values["Name"]);
            Assert.Equal(parentEpoch.ObservationSha256, imported.ObservationSha256);
            Assert.Equal(3L, SeekDescriptor(descriptor, 0, 1));
            imported.ValidateUnchanged();
            imported.ValidateUnchanged();
            Assert.Equal(3L, SeekDescriptor(descriptor, 0, 1));
            imported.Dispose();
            Assert.False(carrier.IsClosed);
            byte[] actual = new byte[bytes.Length];
            Assert.Equal(bytes.Length, RandomAccess.Read(carrier, actual, 0));
            Assert.Equal(bytes, actual);
            Assert.Equal(3L, SeekDescriptor(descriptor, 0, 1));
        });
    }

    [Theory]
    [InlineData("wrong-bytes", "server_env_file_original_bytes_changed")]
    [InlineData("wrong-epoch", "current_verify_artifact_epoch_changed")]
    [InlineData("same-byte-new-epoch", "current_verify_artifact_epoch_changed")]
    [InlineData("same-byte-new-inode", "current_verify_artifact_identity_changed")]
    public void InheritedOriginal_RejectsExpectedMismatchBeforeParser(string variant, string expected)
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "inherited-invalid.env");
            // The original literal is malformed: expectation failure must take
            // precedence before the parser can expose server_env_file_line_invalid.
            byte[] bytes = "malformed literal"u8.ToArray();
            File.WriteAllBytes(path, bytes);
            using SafeFileHandle carrier = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            var epoch = NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, carrier, CancellationToken.None);
            string artifactSha = Convert.ToHexStringLower(SHA256.HashData(bytes));
            string observationSha = epoch.ObservationSha256;
            if (variant == "wrong-bytes")
                artifactSha = new string('0', 64);
            else if (variant == "wrong-epoch")
                observationSha = new string('0', 64);
            else if (variant == "same-byte-new-epoch")
                File.SetLastWriteTimeUtc(path, File.GetLastWriteTimeUtc(path).AddSeconds(1));
            else
            {
                string replacement = Path.Combine(directory, "replacement.env");
                File.WriteAllBytes(replacement, bytes);
                File.Move(replacement, path, overwrite: true);
            }
            Assert.Equal(expected, Assert.Throws<InvalidOperationException>(() =>
                ServerCommandEnvironmentFile.OpenOriginalFromInheritedDescriptor(path,
                    carrier.DangerousGetHandle().ToInt32(), artifactSha, observationSha)).Message);
            Assert.False(carrier.IsClosed);
            byte[] actual = new byte[bytes.Length];
            Assert.Equal(bytes.Length, RandomAccess.Read(carrier, actual, 0));
            Assert.Equal(bytes, actual);
        });
    }

    [Theory]
    [InlineData("read-write")]
    [InlineData("path-only")]
    [InlineData("directory")]
    public void InheritedOriginal_RefusesActualWritablePathOnlyAndNonRegularDescriptors(string variant)
    {
        if (!SupportsOriginalOwner())
            return;
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "descriptor.env");
            File.WriteAllText(path, "Name=original");
            using SafeFileHandle original = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            var epoch = NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, original, CancellationToken.None);
            using SafeFileHandle invalid = variant == "read-write"
                ? File.OpenHandle(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)
                : new SafeFileHandle((IntPtr)OpenDescriptor(-100, variant == "directory" ? directory : path,
                    0x80000 | (variant == "directory" ? 0x10000 : 0x200000)), ownsHandle: true);
            Assert.False(invalid.IsInvalid);
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                ServerCommandEnvironmentFile.OpenOriginalFromInheritedDescriptor(path,
                    invalid.DangerousGetHandle().ToInt32(), Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path))),
                    epoch.ObservationSha256));
            Assert.Equal(variant == "directory" ? "current_verify_regular_artifact_required"
                : "current_verify_readonly_original_descriptor_required", error.Message);
            Assert.False(invalid.IsClosed);
        });
    }

    [Theory]
    [InlineData("", "server_env_file_artifact_digest_invalid")]
    [InlineData("uppercase", "server_env_file_artifact_digest_invalid")]
    [InlineData("epoch", "server_env_file_epoch_digest_invalid")]
    public void InheritedOriginal_RejectsMalformedExpectedDataBeforeDescriptor(string variant, string expected)
    {
        string valid = new('0', 64);
        string artifact = variant == "epoch" ? valid : variant == "uppercase" ? new string('A', 64) : "";
        string observation = variant == "epoch" ? "" : valid;
        Assert.Equal(expected, Assert.Throws<InvalidOperationException>(() =>
            ServerCommandEnvironmentFile.OpenOriginalFromInheritedDescriptor(
                "/unopened/original.env", -1, artifact, observation)).Message);
    }

    [Fact]
    public void InheritedOriginal_RefusesOldEpochBeforeOversizedByteReadAndSupportsPreCancellation()
    {
        WithDirectory(directory =>
        {
            string path = Path.Combine(directory, "unopened.env");
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            Assert.Throws<OperationCanceledException>(() =>
                ServerCommandEnvironmentFile.OpenOriginalFromInheritedDescriptor(path, -1,
                    new string('0', 64), new string('0', 64), cancellation.Token));
            Assert.False(File.Exists(path));
            if (!SupportsOriginalOwner())
                return;
            File.WriteAllBytes(path, new byte[OriginalEnvironmentFile.MaximumEncodedBytes + 1]);
            using SafeFileHandle carrier = File.OpenHandle(path);
            Assert.Equal("current_verify_artifact_epoch_changed", Assert.Throws<InvalidOperationException>(() =>
                ServerCommandEnvironmentFile.OpenOriginalFromInheritedDescriptor(path,
                    carrier.DangerousGetHandle().ToInt32(), new string('0', 64), new string('0', 64))).Message);
        });
    }

    [DllImport("libc", EntryPoint = "lseek", SetLastError = true)]
    private static extern long SeekDescriptor(int descriptor, long offset, int origin);

    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenDescriptor(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    private static bool SupportsOriginalOwner()
        => OperatingSystem.IsLinux()
            && RuntimeInformation.ProcessArchitecture is Architecture.X64 or Architecture.Arm64;

    private static void WithDirectory(Action<string> action)
    {
        string directory = Path.Combine(Path.GetTempPath(), $"fsusblog-original-env-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            action(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [DllImport("libc", EntryPoint = "mkfifo", SetLastError = true)]
    private static extern int MakeFifo([MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint mode);
}
