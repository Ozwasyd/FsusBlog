using System.Runtime.InteropServices;

using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real file-owner controls only; fixture bytes do not establish receipt or native database qualification.</summary>
public sealed class CurrentSchemaReceiptFileTests
{
    [Theory]
    [InlineData("replace")]
    [InlineData("rewrite")]
    public async Task OwnedReceiptScope_RejectsPhysicalChangeAfterCallback(string variant)
    {
        if (!SupportsOriginalFileOwner())
        {
            await AssertUnsupportedPlatformAsync();
            return;
        }
        await WithTemporaryDirectoryAsync(async directory =>
        {
            string path = Path.Combine(directory, "held.receipt");
            byte[] original = "original held bytes"u8.ToArray();
            await File.WriteAllBytesAsync(path, original);
            AggregateException error = await Assert.ThrowsAsync<AggregateException>(() =>
                CurrentSchemaStartupVerifier.WithBoundedReceiptAsync(path, async bytes =>
                {
                    Assert.Equal(original, bytes);
                    if (variant == "replace")
                    {
                        string replacement = Path.Combine(directory, "replacement.receipt");
                        await File.WriteAllBytesAsync(replacement, original);
                        File.Move(replacement, path, overwrite: true);
                    }
                    else
                    {
                        await File.WriteAllBytesAsync(path, "changed held bytes"u8.ToArray());
                    }
                    return "cannot-publish";
                }, CancellationToken.None));
            Assert.Equal("current_schema_receipt_scope_failed", error.Message.Split(" (")[0]);
            Assert.Contains(error.InnerExceptions, failure => failure is InvalidOperationException);
        });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OwnedReceiptScope_RetainsFirstCauseAndIndependentEpochFailure(bool cancel)
    {
        if (!SupportsOriginalFileOwner())
        {
            await AssertUnsupportedPlatformAsync();
            return;
        }
        await WithTemporaryDirectoryAsync(async directory =>
        {
            string path = Path.Combine(directory, "held.receipt");
            await File.WriteAllTextAsync(path, "unchanged bytes");
            using var cancellation = new CancellationTokenSource();
            Exception original = cancel ? new OperationCanceledException(cancellation.Token)
                : new InvalidOperationException("original-observation-failed");
            AggregateException error = await Assert.ThrowsAsync<AggregateException>(() =>
                CurrentSchemaStartupVerifier.WithBoundedReceiptAsync<string>(path, async _ =>
                {
                    string replacement = Path.Combine(directory, "replacement.receipt");
                    await File.WriteAllTextAsync(replacement, "unchanged bytes");
                    File.Move(replacement, path, overwrite: true);
                    if (cancel)
                    {
                        cancellation.Cancel();
                    }
                    throw original;
                }, cancellation.Token));
            Assert.Same(original, error.InnerExceptions[0]);
            Assert.True(error.InnerExceptions.Count >= 2);
            Assert.Contains(error.InnerExceptions.Skip(1), failure => failure is InvalidOperationException);
        });
    }

    [Fact]
    public async Task OwnedReceiptScope_UnchangedFilePreservesExactCallbackCancellation()
    {
        if (!SupportsOriginalFileOwner())
        {
            await AssertUnsupportedPlatformAsync();
            return;
        }
        await WithTemporaryDirectoryAsync(async directory =>
        {
            string path = Path.Combine(directory, "held.receipt");
            await File.WriteAllTextAsync(path, "unchanged bytes");
            using var cancellation = new CancellationTokenSource();
            var original = new OperationCanceledException(cancellation.Token);
            OperationCanceledException error = await Assert.ThrowsAsync<OperationCanceledException>(() =>
                CurrentSchemaStartupVerifier.WithBoundedReceiptAsync<string>(path, _ =>
                {
                    cancellation.Cancel();
                    return Task.FromException<string>(original);
                }, cancellation.Token));
            Assert.Same(original, error);
            Assert.Equal("unchanged bytes", await File.ReadAllTextAsync(path));
        });
    }

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
