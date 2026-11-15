using System.Runtime.InteropServices;
using System.Security.Cryptography;
using FsusBlog.V2.Core;
using Microsoft.Win32.SafeHandles;

internal static partial class Migration
{
    private const string LegacyMediaManifestName = "manifest.json";
    private const int LegacyMediaManifestLimit = 16 * 1024 * 1024;
    private const int LegacyMediaDirectory = 0x4000;
    private const int LegacyMediaRegular = 0x8000;
    private const int LegacyMediaPrivate = 0x1c0; // 0700
    private const int LegacyMediaSealed = 0x140; // 0500
    private const int LegacyMediaReadOnly = 0x100; // 0400
    private const int LegacyMediaReadWrite = 0x180; // 0600
    private const int LegacyMediaParentEntryLimit = 10_000;

    private static LegacyMediaPackageWriter CreateLegacyMediaPackage(string outputParent, string name)
    {
        RequireLegacyMediaPath(outputParent);
        if (!IsLegacyMediaPackageName(name))
            throw new ArgumentException("Use a simple named directory for the offline media package.");
        var parent = OpenImportBackupDirectory(outputParent);
        try
        {
            RequireLegacyMediaNode(parent, LegacyMediaDirectory, LegacyMediaPrivate);
            return new LegacyMediaPackageWriter(parent, name);
        }
        catch { parent.Dispose(); throw; }
    }

    private static LegacyMediaPackageReader OpenLegacyMediaPackage(string path)
    {
        RequireLegacyMediaPath(path);
        var name = Path.GetFileName(path);
        if (!IsLegacyMediaPackageName(name))
            throw new ArgumentException("Use a completed named offline media package.");
        using var parent = OpenImportBackupDirectory(Path.GetDirectoryName(path)!);
        RequireLegacyMediaNode(parent, LegacyMediaDirectory, LegacyMediaPrivate);
        // Require the recorded ordinal spelling even on a case-insensitive volume.
        if (OperatingSystem.IsMacOS())
        {
            bool correctSpelling = EnumerateLegacyMediaLeaves(parent).Take(LegacyMediaParentEntryLimit)
                .Contains(name, StringComparer.Ordinal);
            if (!correctSpelling) throw new InvalidOperationException("Use the exact name of the sealed offline media package.");
        }
        var package = OpenLegacyMediaDirectory(parent, name);
        try
        {
            RequireLegacyMediaNode(package, LegacyMediaDirectory, LegacyMediaSealed);
            return new LegacyMediaPackageReader(package);
        }
        catch { package.Dispose(); throw; }
    }

    private static FileStream OpenLegacyMediaReviewFile(string path)
    {
        RequireLegacyMediaPath(path);
        using var parent = OpenImportBackupDirectory(Path.GetDirectoryName(path)!);
        return OpenLegacyMediaFile(parent, Path.GetFileName(path), allowWritable: true);
    }

    private static void RequireLegacyMediaPath(string path)
    {
        if ((!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) ||
            RuntimeInformation.ProcessArchitecture is not (Architecture.Arm64 or Architecture.X64) ||
            !Path.IsPathFullyQualified(path) || path == "/" || path != Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)))
            throw new ArgumentException("Offline media packages require a canonical absolute directory or file on 64-bit macOS or Linux.");
    }

    private static bool IsLegacyMediaPackageName(string name) =>
        name.Length is >= 1 and <= 128 && char.IsAsciiLetterOrDigit(name[0]) &&
        name.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-');

    private static string LegacyMediaPayloadName(Guid id) => id == Guid.Empty
        ? throw new ArgumentException("A media payload requires a nonempty asset identity.")
        : $"{id:N}.blob";

    private sealed class LegacyMediaPackageWriter : IDisposable
    {
        private readonly SafeFileHandle parent;
        private readonly SafeFileHandle package;
        private readonly string name;
        private readonly string temporary = $".legacy-media-{Guid.NewGuid():N}.pending";
        private readonly HashSet<string> leaves = new(StringComparer.Ordinal);
        private FileStream? active;
        private bool failed;
        private bool published;

        internal LegacyMediaPackageWriter(SafeFileHandle parent, string name)
        {
            this.parent = parent;
            this.name = name;
            using (var existing = new SafeFileHandle((nint)OpenImportChild(parent, name, ImportFileFlags), ownsHandle: true))
                if (!existing.IsInvalid || Marshal.GetLastPInvokeError() != 2) // ENOENT
                    throw new IOException("An offline package output already exists or is inaccessible. Use a new package name.");
            if (NativeUnixFile.MakeDirectoryAt(parent, temporary, LegacyMediaPrivate) != 0)
                throw new IOException("Could not reserve a new offline media package.");
            try
            {
                package = OpenLegacyMediaDirectory(parent, temporary);
                try { RequireLegacyMediaNode(package, LegacyMediaDirectory, LegacyMediaPrivate); }
                catch { package.Dispose(); throw; }
            }
            catch
            {
                LegacyMediaUnlinkAt(parent, temporary, LegacyMediaRemoveDirectory);
                throw;
            }
        }

        internal FileStream CreatePayload(Guid id) => CreateMember(LegacyMediaPayloadName(id));

        internal void Seal(byte[] manifest)
        {
            RequireClosedPayload();
            if (manifest.Length is < 1 or > LegacyMediaManifestLimit)
                throw new InvalidOperationException("The offline media manifest exceeds its input bound.");

            foreach (var leaf in leaves)
            {
                using var payload = OpenLegacyMediaFile(package, leaf);
                if (NativeUnixFile.Sync(payload.SafeFileHandle) != 0)
                    throw new IOException("Could not synchronize an offline media payload.");
            }
            using (var output = CreateMember(LegacyMediaManifestName))
            {
                output.Write(manifest);
                output.Flush(flushToDisk: true);
            }
            RequireLegacyMediaLeaves(package, leaves);
            if (NativeUnixFile.SetMode(package, LegacyMediaSealed) != 0 || NativeUnixFile.Sync(package) != 0)
                throw new IOException("Could not seal the offline media package.");

            if (NativeUnixFile.RenameExclusiveAt(parent, temporary, name) != 0)
                throw new IOException("Could not publish the package exclusively. Use a new package name on storage that supports an atomic rename.");
            published = true;
            if (NativeUnixFile.Sync(parent) != 0)
                throw new IOException("Could not synchronize the sealed package directory entry.");
        }

        private FileStream CreateMember(string leaf)
        {
            RequireClosedPayload();
            if (leaves.Contains(leaf))
                throw new InvalidOperationException("The offline media package contains a duplicate member.");
            var fd = NativeUnixFile.CreateExclusiveAt(package, leaf, ImportFileFlags, LegacyMediaReadOnly);
            var handle = new SafeFileHandle((nint)fd, ownsHandle: true);
            try
            {
                if (handle.IsInvalid)
                    throw new IOException("Could not create a new owner-private package member.");
                leaves.Add(leaf);
                if (NativeUnixFile.SetMode(handle, LegacyMediaReadOnly) != 0)
                    throw new IOException("Could not restrict a new offline media package member.");
                RequireLegacyMediaNode(handle, LegacyMediaRegular, LegacyMediaReadOnly);
                active = new FileStream(handle, FileAccess.Write);
                return active;
            }
            catch { failed = true; handle.Dispose(); throw; }
        }

        private void RequireClosedPayload()
        {
            ObjectDisposedException.ThrowIf(package.IsClosed, this);
            if (failed || published || active?.CanWrite == true)
                throw new InvalidOperationException("Close the active payload and publish each package only once.");
        }

        public void Dispose()
        {
            if (package.IsClosed) return;
            try { active?.Dispose(); }
            finally
            {
                try
                {
                    if (!published && NativeUnixFile.SetMode(package, LegacyMediaPrivate) == 0)
                    {
                        foreach (var leaf in leaves) LegacyMediaUnlinkAt(package, leaf, 0);
                        LegacyMediaUnlinkAt(parent, temporary, LegacyMediaRemoveDirectory);
                    }
                }
                finally
                {
                    package.Dispose();
                    parent.Dispose();
                }
            }
        }
    }

    private sealed class LegacyMediaPackageReader(SafeFileHandle package) : IDisposable
    {
        internal async Task<byte[]> ReadManifestAsync(string approvedManifestSha256, CancellationToken token)
        {
            if (!IsSha256(approvedManifestSha256))
                throw new ArgumentException("Provide the approved lowercase package manifest SHA-256.");
            await using var file = OpenLegacyMediaFile(package, LegacyMediaManifestName);
            if (file.Length is < 1 or > LegacyMediaManifestLimit)
                throw new InvalidOperationException("The offline media manifest exceeds its input bound.");
            var bytes = new byte[(int)file.Length];
            await file.ReadExactlyAsync(bytes, token);
            if (file.ReadByte() != -1 ||
                !CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), Convert.FromHexString(approvedManifestSha256)))
                throw new InvalidOperationException("The offline media manifest does not match its approved SHA-256.");
            return bytes;
        }

        internal FileStream OpenPayload(Guid id) => OpenLegacyMediaFile(package, LegacyMediaPayloadName(id));

        internal void RequireExactFiles(IEnumerable<Guid> assetIds)
        {
            var expected = new HashSet<string>(StringComparer.Ordinal) { LegacyMediaManifestName };
            foreach (var id in assetIds)
                if (!expected.Add(LegacyMediaPayloadName(id)))
                    throw new InvalidOperationException("The offline media manifest contains a duplicate payload.");
            RequireLegacyMediaLeaves(package, expected);
        }

        public void Dispose() => package.Dispose();
    }

    private static SafeFileHandle OpenLegacyMediaDirectory(SafeFileHandle parent, string leaf)
    {
        var handle = new SafeFileHandle((nint)OpenImportChild(parent, leaf, ImportDirectoryFlags), ownsHandle: true);
        if (!handle.IsInvalid) return handle;
        handle.Dispose();
        throw new IOException("The offline media directory is unavailable or linked.");
    }

    private static FileStream OpenLegacyMediaFile(SafeFileHandle parent, string leaf, bool allowWritable = false)
    {
        var handle = new SafeFileHandle((nint)OpenImportChild(parent, leaf, ImportFileFlags), ownsHandle: true);
        try
        {
            if (handle.IsInvalid) throw new IOException("The offline media input is unavailable or linked.");
            RequireLegacyMediaNode(handle, LegacyMediaRegular, LegacyMediaReadOnly, allowWritable);
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }

    private static void RequireLegacyMediaLeaves(SafeFileHandle directory, HashSet<string> expected)
    {
        var found = 0;
        foreach (var leaf in EnumerateLegacyMediaLeaves(directory))
        {
            if (!expected.Contains(leaf) || ++found > expected.Count)
                throw new InvalidOperationException("The offline media package contains missing or extra entries.");
        }
        if (found != expected.Count)
            throw new InvalidOperationException("The offline media package contains missing or extra entries.");
    }

    private static IEnumerable<string> EnumerateLegacyMediaLeaves(SafeFileHandle directory)
    {
        using var scan = OpenLegacyMediaDirectory(directory, ".");
        bool oldDarwin = OperatingSystem.IsMacOS() && RuntimeInformation.ProcessArchitecture == Architecture.X64;
        var entries = oldDarwin ? LegacyMediaFdOpenDirMac(scan) : LegacyMediaFdOpenDir(scan);
        if (entries == 0) throw new IOException("Could not enumerate the offline media directory.");
        scan.SetHandleAsInvalid(); // fdopendir owns it now.
        try
        {
            while (true)
            {
                var entry = oldDarwin ? LegacyMediaReadDirMac(entries) : LegacyMediaReadDir(entries);
                if (entry == 0)
                {
                    if (Marshal.GetLastPInvokeError() != 0) throw new IOException("Could not read the offline media directory.");
                    yield break;
                }
                // Darwin inode64 and Linux 64-bit ABI layouts for d_name.
                var name = Marshal.PtrToStringUTF8(entry + (OperatingSystem.IsMacOS() ? 21 : 19));
                if (name is not (null or "." or "..")) yield return name;
            }
        }
        finally { LegacyMediaCloseDir(entries); }
    }

    private static void RequireLegacyMediaNode(SafeFileHandle handle, int type, int expected, bool allowWritable = false)
    {
        (ushort mode, uint uid, uint links) metadata;
        try { metadata = NativeUnixFile.Inspect(handle, includeLinks: true); }
        catch (IOException) { throw new IOException("Could not inspect the offline media input."); }
        var (mode, uid, links) = metadata;
        int permissions = mode & 0xfff;
        if (uid != NativeUnixFile.EffectiveUid() || (mode & 0xf000) != type || type == LegacyMediaRegular && links != 1 ||
            permissions != expected && !(allowWritable && permissions == LegacyMediaReadWrite))
            throw new InvalidOperationException("Offline media requires exact owner-private permissions and regular files with one link.");
        if (OperatingSystem.IsMacOS())
        {
            const int extendedAcl = 0x100;
            var acl = LegacyMediaExtendedAcl(handle, extendedAcl);
            if (acl != 0)
            {
                LegacyMediaFreeAcl(acl);
                throw new InvalidOperationException("Offline media inputs and outputs require no inherited or extended access list.");
            }
            if (Marshal.GetLastPInvokeError() != 2) // ENOENT means no extended ACL.
                throw new IOException("Could not inspect access to the offline media input.");
        }
    }

    private static int LegacyMediaRemoveDirectory => OperatingSystem.IsMacOS() ? 0x80 : 0x200;

    [DllImport("libc", EntryPoint = "unlinkat", SetLastError = true)]
    private static extern int LegacyMediaUnlinkAt(SafeFileHandle parent, [MarshalAs(UnmanagedType.LPUTF8Str)] string leaf, int flags);
    [DllImport("libc", EntryPoint = "fdopendir", SetLastError = true)]
    private static extern nint LegacyMediaFdOpenDir(SafeFileHandle fd);
    [DllImport("libc", EntryPoint = "fdopendir$INODE64", SetLastError = true)]
    private static extern nint LegacyMediaFdOpenDirMac(SafeFileHandle fd);
    [DllImport("libc", EntryPoint = "readdir", SetLastError = true)]
    private static extern nint LegacyMediaReadDir(nint directory);
    [DllImport("libc", EntryPoint = "readdir$INODE64", SetLastError = true)]
    private static extern nint LegacyMediaReadDirMac(nint directory);
    [DllImport("libc", EntryPoint = "closedir")]
    private static extern int LegacyMediaCloseDir(nint directory);
    [DllImport("libc", EntryPoint = "acl_get_fd_np", SetLastError = true)]
    private static extern nint LegacyMediaExtendedAcl(SafeFileHandle handle, int type);
    [DllImport("libc", EntryPoint = "acl_free")]
    private static extern int LegacyMediaFreeAcl(nint acl);
}
