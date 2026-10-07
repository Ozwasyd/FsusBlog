using System.Runtime.InteropServices;

using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real file-owner controls only; fixture bytes do not establish receipt or native database qualification.</summary>
public sealed class CurrentSchemaReceiptFileTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(1024 * 1024)]
    public async Task ReadBoundedReceipt_PreservesEveryByteThroughExactMaximum(int length)
    {
        Assert.Equal(1024 * 1024, CurrentSchemaReceiptCodec.MaximumEncodedBytes);
        if (!SupportsOriginalFileOwner())
        {
            await AssertUnsupportedPlatformAsync();
            return;
        }

        await WithTemporaryDirectoryAsync(async directory =>
        {
            string path = Path.Combine(directory, "original.receipt");
            byte[] original = new byte[length];
            for (int index = 0; index < original.Length; index++)
            {
                original[index] = (byte)(index % 251);
            }
            await File.WriteAllBytesAsync(path, original);

            byte[] actual = await CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(
                path, CancellationToken.None);

            Assert.Equal(length, actual.Length);
            Assert.Equal(original, actual);
            Assert.Equal(original, await File.ReadAllBytesAsync(path));
        });
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1024 * 1024 + 1)]
    public async Task ReadBoundedReceipt_RejectsEmptyAndOversizedOriginalFiles(int length)
    {
        if (!SupportsOriginalFileOwner())
        {
            await AssertUnsupportedPlatformAsync();
            return;
        }

        await WithTemporaryDirectoryAsync(async directory =>
        {
            string path = Path.Combine(directory, "invalid-size.receipt");
            await File.WriteAllBytesAsync(path, new byte[length]);

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(path, CancellationToken.None));

            Assert.Equal("current_schema_receipt_size_invalid", error.Message);
            Assert.Equal((long)length, new FileInfo(path).Length);
        });
    }

    [Theory]
    [InlineData("leaf-symlink")]
    [InlineData("ancestor-symlink")]
    [InlineData("directory")]
    [InlineData("fifo")]
    public async Task ReadBoundedReceipt_RejectsLinkedAndNonRegularFilesBeforeReading(string variant)
    {
        if (!SupportsOriginalFileOwner())
        {
            await AssertUnsupportedPlatformAsync();
            return;
        }

        await WithTemporaryDirectoryAsync(async directory =>
        {
            string original = Path.Combine(directory, "original.receipt");
            byte[] originalBytes = "original real file bytes"u8.ToArray();
            await File.WriteAllBytesAsync(original, originalBytes);
            Assert.Equal(originalBytes, await CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(
                original, CancellationToken.None));

            string invalid = Path.Combine(directory, "invalid");
            switch (variant)
            {
                case "leaf-symlink":
                    File.CreateSymbolicLink(invalid, original);
                    break;
                case "ancestor-symlink":
                    Directory.CreateSymbolicLink(invalid, directory);
                    invalid = Path.Combine(invalid, "original.receipt");
                    break;
                case "directory":
                    Directory.CreateDirectory(invalid);
                    break;
                case "fifo":
                    Assert.Equal(0, MakeFifo(invalid, 0x180));
                    break;
                default:
                    throw new InvalidOperationException("unknown fixture variant");
            }

            // Await the real owner directly. No writer, timeout wrapper or
            // background native open can conceal a blocking FIFO open.
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(invalid, CancellationToken.None));
            Assert.Equal(originalBytes, await File.ReadAllBytesAsync(original));
        });
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("\t\r\n")]
    [InlineData("latest")]
    [InlineData("LATEST")]
    [InlineData("/unopened/latest/current.receipt")]
    [InlineData("/unopened/LaTeSt/current.receipt")]
    public async Task ReadBoundedReceipt_RejectsMissingAndLatestSelectorsBeforeFileOwner(string? path)
    {
        // These selectors are rejected before any platform-specific file owner
        // is entered; neither an existing receipt nor a native FD is required.
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(path!, CancellationToken.None));

        Assert.Equal("current_schema_explicit_receipt_required", error.Message);
    }

    [Theory]
    [InlineData("relative")]
    [InlineData("dot-segment")]
    [InlineData("parent-segment")]
    [InlineData("duplicate-separator")]
    [InlineData("line-feed")]
    [InlineData("tab")]
    public async Task ReadBoundedReceipt_RejectsNonCanonicalAndControlCharacterPaths(string variant)
    {
        if (!SupportsOriginalFileOwner())
        {
            await AssertUnsupportedPlatformAsync();
            return;
        }

        await WithTemporaryDirectoryAsync(async directory =>
        {
            string original = Path.Combine(directory, "original.receipt");
            byte[] originalBytes = "original canonical file bytes"u8.ToArray();
            await File.WriteAllBytesAsync(original, originalBytes);
            Directory.CreateDirectory(Path.Combine(directory, "child"));
            Assert.Equal(originalBytes, await CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(
                original, CancellationToken.None));

            string invalid = variant switch
            {
                "relative" => Path.GetRelativePath(Directory.GetCurrentDirectory(), original),
                "dot-segment" => Path.Combine(directory, ".", "original.receipt"),
                "parent-segment" => Path.Combine(directory, "child", "..", "original.receipt"),
                "duplicate-separator" => directory + "//original.receipt",
                "line-feed" => original + "\n",
                "tab" => original + "\t",
                _ => throw new InvalidOperationException("unknown fixture variant")
            };
            Assert.NotEqual(original, invalid);

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(invalid, CancellationToken.None));

            Assert.Equal("current_verify_original_artifact_path_required", error.Message);
            Assert.Equal(originalBytes, await File.ReadAllBytesAsync(original));
        });
    }

    [Fact]
    public async Task ReadBoundedReceipt_PreCancellationDoesNotOpenMissingFile()
    {
        await WithTemporaryDirectoryAsync(async directory =>
        {
            string missing = Path.Combine(directory, "never-created.receipt");
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(missing, cancellation.Token));

            Assert.False(File.Exists(missing));
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
        });
    }

    private static bool SupportsOriginalFileOwner()
        => OperatingSystem.IsLinux()
            && RuntimeInformation.ProcessArchitecture is Architecture.X64 or Architecture.Arm64;

    private static async Task AssertUnsupportedPlatformAsync()
    {
        string unopened = Path.GetFullPath("unopened-current-schema.receipt");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(unopened, CancellationToken.None));
        Assert.Equal("current_verify_native_file_owner_unavailable", error.Message);
    }

    private static async Task WithTemporaryDirectoryAsync(Func<string, Task> action)
    {
        string directory = Path.Combine(Path.GetTempPath(), $"fsusblog-current-receipt-file-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            await action(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [DllImport("libc", EntryPoint = "mkfifo", SetLastError = true)]
    private static extern int MakeFifo([MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint mode);
}
