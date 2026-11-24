using static FsusBlog.V2.Platform.Tests.PlatformScratchDirectory;

namespace FsusBlog.V2.Platform.Tests;

public sealed class MediaObjectDirectoryTests
{
    [Fact]
    public async Task EnforcesExclusiveLockPermissionsDigestSymlinksAndCancellation()
    {
        if (OperatingSystem.IsWindows() || !NativeUnixFile.Supported) return;
        using var scratch = new PlatformScratchDirectory("fsus-media-dir-");
        var root = scratch.CreatePrivateSubdirectory("media");
        var sibling = Directory.CreateDirectory(Path.Combine(scratch.FullName, "web"));

        // Symlinked root and overlapping forbidden root must be rejected
        var linked = Path.Combine(scratch.FullName, "linked-media");
        Directory.CreateSymbolicLink(linked, root.FullName);
        Assert.Throws<InvalidOperationException>(() => new MediaObjectDirectory(linked, 1024, [sibling.FullName]));
        Assert.Throws<InvalidOperationException>(() => new MediaObjectDirectory(root.FullName, 1024, [scratch.FullName]));

        var payload = "immutable media bytes"u8.ToArray();
        var digest = SHA256.HashData(payload);
        var leaf = Convert.ToHexStringLower(digest) + ".media";

        using (var store = new MediaObjectDirectory(root.FullName, 1024, [sibling.FullName]))
        {
            Assert.Throws<InvalidOperationException>(() => new MediaObjectDirectory(root.FullName, 1024, [sibling.FullName]));
            Assert.Null(await store.Read(leaf, payload.Length, digest, CancellationToken.None));

            using var canceled = new CancellationTokenSource();
            canceled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => store.Materialize(leaf, payload, digest, canceled.Token));
            Assert.Empty(Directory.EnumerateFileSystemEntries(root.FullName));

            await store.Materialize(leaf, payload, digest, CancellationToken.None);
            var diskPath = Path.Combine(root.FullName, leaf);
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(diskPath));
            Assert.Equal(payload, await store.Read(leaf, payload.Length, digest, CancellationToken.None));
            await store.Materialize(leaf, payload, digest, CancellationToken.None);

            var badDigest = digest.ToArray();
            badDigest[0] ^= 0xff;
            await Assert.ThrowsAsync<IOException>(() => store.Read(leaf, payload.Length, badDigest, CancellationToken.None));

            File.SetUnixFileMode(diskPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await Assert.ThrowsAsync<IOException>(() => store.Read(leaf, payload.Length, digest, CancellationToken.None));
            File.SetUnixFileMode(diskPath, UnixFileMode.UserRead);

            await store.Delete(leaf, payload.Length, digest, CancellationToken.None);
            Assert.Null(await store.Read(leaf, payload.Length, digest, CancellationToken.None));
        }

        using var reopened = new MediaObjectDirectory(root.FullName, 1024, [sibling.FullName]);
        Assert.Equal(root.FullName, reopened.Root);
    }
}
