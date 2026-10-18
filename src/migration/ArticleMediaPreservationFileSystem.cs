using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Migration;

// Linux anchored filesystem capability. No fallback to path-only opens or overwrite rename.
// This owns offline staging mechanics, not runtime asset identity or a second DB journal.
internal sealed class ArticleMediaDirectory : IDisposable
{
    private const int CloseOnExec = 0x80000;
    private const int DirectoryFlag = 0x10000;
    private const int NoFollow = 0x20000;
    private const int NonBlock = 0x800;
    private const int TemporaryFile = 0x410000;
    private const uint DirectoryMode = 0x1c0;
    private const uint FileMode = 0x180;
    private const uint BasicStats = 0x7ff;
    private const uint MountId = 0x1000;
    private const int AtEmptyPath = 0x1000;
    private const int AtNoFollow = 0x100;
    private const int BufferBytes = 128 * 1024;
    private readonly SafeFileHandle _handle;
    private readonly bool _writable;
    private readonly ImmutableArray<string> _ancestors;
    private readonly FileIdentity _identity;

    private ArticleMediaDirectory(SafeFileHandle handle, bool writable, ImmutableArray<string> ancestors)
    {
        _handle = handle;
        _writable = writable;
        _ancestors = ancestors;
        try
        {
            _identity = ReadIdentity(handle, directory: true);
            if (writable && (_identity.UserId != GetEffectiveUserId() || (_identity.Mode & 0x12) != 0))
                throw new ArticleMediaException("target_directory_ownership");
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public string Identity => _identity.Stable;
    private int FileDescriptor => checked((int)_handle.DangerousGetHandle());

    public static ArticleMediaDirectory Open(string path, bool writable)
    {
        if (!OperatingSystem.IsLinux() || !Path.IsPathFullyQualified(path))
            throw new ArticleMediaException("filesystem_capability_unavailable");
        // Do not normalize away traversal or trust symlinked ancestors of the supplied root.
        var components = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (components.Length == 0)
            throw new ArticleMediaException("unsafe_root");
        foreach (var component in components)
            ValidateSegment(component);
        var current = OpenHandle(-100, "/", CloseOnExec | DirectoryFlag | NoFollow);
        var lineage = ImmutableArray.CreateBuilder<string>();
        try
        {
            lineage.Add(ReadIdentity(current, directory: true).Stable);
            foreach (var component in components)
            {
                var next = OpenHandle(checked((int)current.DangerousGetHandle()), component, CloseOnExec | DirectoryFlag | NoFollow);
                current.Dispose();
                current = next;
                lineage.Add(ReadIdentity(current, directory: true).Stable);
            }
            return new ArticleMediaDirectory(current, writable, lineage.ToImmutable());
        }
        catch
        {
            current.Dispose();
            throw;
        }
    }

    public bool Overlaps(ArticleMediaDirectory other) => _ancestors.Contains(other.Identity) || other._ancestors.Contains(Identity);

    public ArticleMediaDirectory? TryOpenDirectory(string name)
    {
        ValidateSegment(name);
        var fd = OpenAt(FileDescriptor, name, CloseOnExec | DirectoryFlag | NoFollow, 0);
        if (fd < 0)
        {
            if (Marshal.GetLastPInvokeError() == 2)
                return null;
            throw new ArticleMediaException("unsafe_or_unavailable_directory");
        }
        var child = new ArticleMediaDirectory(new SafeFileHandle(fd, true), _writable, _ancestors.Add(Identity));
        if (child._identity.Device != _identity.Device || child._identity.Mount != _identity.Mount)
        {
            child.Dispose();
            throw new ArticleMediaException("cross_mount_directory");
        }
        return child;
    }

    public ArticleMediaDirectory OpenOrCreateDirectory(string name)
    {
        RequireWritable();
        ValidateSegment(name);
        if (MakeDirectoryAt(FileDescriptor, name, DirectoryMode) != 0 && Marshal.GetLastPInvokeError() != 17)
            throw new ArticleMediaException("stage_directory_create");
        Sync(_handle);
        return TryOpenDirectory(name) ?? throw new ArticleMediaException("stage_directory_missing");
    }

    public async Task<(long Bytes, string Sha256)> HashFileAsync(string path, long maximumBytes, CancellationToken token)
    {
        using var file = OpenFile(path);
        var before = ReadIdentity(file, directory: false);
        if (before.Bytes > maximumBytes)
            throw new ArticleMediaException("file_byte_budget");
        using var stream = new FileStream(file, FileAccess.Read, BufferBytes, isAsync: false);
        var result = await HashStreamAsync(stream, before.Bytes, maximumBytes, token);
        var after = ReadIdentity(file, directory: false);
        if (before != after)
            throw new ArticleMediaException("source_file_changed");
        using var reopened = OpenFile(path);
        if (ReadIdentity(reopened, directory: false) != after)
            throw new ArticleMediaException("source_path_changed");
        return result;
    }

    public async Task CopyVerifiedAsync(ArticleMediaDirectory source, ArticleMediaFile expected, long maximumBytes, CancellationToken token)
    {
        RequireWritable();
        ValidateRelativePath(expected.RelativePath);
        using var destination = WalkParent(expected.RelativePath, create: true, out var name);
        using var existing = destination.TryOpenFile(name);
        if (existing is not null)
        {
            var actual = await HashFileAsync(expected.RelativePath, maximumBytes, token);
            if (actual.Bytes != expected.Bytes || actual.Sha256 != expected.Sha256)
                throw new ArticleMediaException("stage_file_conflict");
            // Resumption still proves source readset, not merely stale cached staged bytes.
            var original = await source.HashFileAsync(expected.RelativePath, maximumBytes, token);
            if (original != actual)
                throw new ArticleMediaException("source_file_changed");
            return;
        }
        using var input = source.OpenFile(expected.RelativePath);
        var before = ReadIdentity(input, directory: false);
        if (before.Bytes != expected.Bytes || before.Bytes > maximumBytes)
            throw new ArticleMediaException("source_file_changed");
        using var temporary = OpenHandle(destination.FileDescriptor, ".", 2 | CloseOnExec | TemporaryFile, FileMode);
        using var reader = new FileStream(input, FileAccess.Read, BufferBytes, isAsync: false);
        using var writer = new FileStream(temporary, FileAccess.ReadWrite, BufferBytes, isAsync: false);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[BufferBytes];
        long copied = 0;
        while (true)
        {
            var read = await reader.ReadAsync(buffer, token);
            if (read == 0)
                break;
            copied = checked(copied + read);
            if (copied > expected.Bytes || copied > maximumBytes)
                throw new ArticleMediaException("source_file_changed");
            hash.AppendData(buffer, 0, read);
            await writer.WriteAsync(buffer.AsMemory(0, read), token);
        }
        if (copied != expected.Bytes || Hex(hash.GetHashAndReset()) != expected.Sha256 || ReadIdentity(input, false) != before)
            throw new ArticleMediaException("source_file_changed");
        using (var reopened = source.OpenFile(expected.RelativePath))
            if (ReadIdentity(reopened, false) != before)
                throw new ArticleMediaException("source_path_changed");
        await writer.FlushAsync(token);
        writer.Flush(flushToDisk: true);
        writer.Position = 0;
        var copiedEvidence = await HashStreamAsync(writer, copied, maximumBytes, token);
        if (copiedEvidence.Bytes != expected.Bytes || copiedEvidence.Sha256 != expected.Sha256)
            throw new ArticleMediaException("stage_hash_mismatch");
        // The unnamed temporary has no partial pathname. Link creates the final staged file exclusively.
        // /proc/self/fd source is this held descriptor, not caller-controlled input. This
        // also works for the ordinary unprivileged task owner without CAP_DAC_READ_SEARCH.
        if (LinkAt(-100, "/proc/self/fd/" + checked((int)temporary.DangerousGetHandle()), destination.FileDescriptor, name, 0x400) != 0)
            throw new ArticleMediaException("stage_file_link");
        Sync(destination._handle);
    }

    public async Task VerifyAsync(ImmutableArray<ArticleMediaFile> expected, long maximumBytes, long maximumMetadataBytes, CancellationToken token)
    {
        var files = expected.ToDictionary(file => file.RelativePath, StringComparer.Ordinal);
        var directories = CollectDirectories(expected, maximumMetadataBytes, out _);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Stack<string>();
        pending.Push("");
        while (pending.TryPop(out var prefix))
        {
            using var directory = OpenRelativeDirectory(prefix);
            // Enumerating the anchored fd, never the original path. Reject unknown entries immediately.
            foreach (var entry in Directory.EnumerateFileSystemEntries("/proc/self/fd/" + directory.FileDescriptor))
            {
                token.ThrowIfCancellationRequested();
                var name = Path.GetFileName(entry);
                ValidateSegment(name);
                var relative = prefix.Length == 0 ? name : prefix + "/" + name;
                if (files.TryGetValue(relative, out var file))
                {
                    if (!seen.Add(relative))
                        throw new ArticleMediaException("generation_duplicate");
                    var actual = await directory.HashFileAsync(name, maximumBytes, token);
                    if (actual.Bytes != file.Bytes || actual.Sha256 != file.Sha256)
                        throw new ArticleMediaException("generation_hash_mismatch");
                }
                else if (directories.Remove(relative))
                    pending.Push(relative);
                else
                    throw new ArticleMediaException("generation_readset_extra");
            }
        }
        if (seen.Count != files.Count)
            throw new ArticleMediaException("generation_readset_missing");
    }

    internal static long CountDirectoryMetadataBytes(ImmutableArray<ArticleMediaFile> files, long budget)
    {
        CollectDirectories(files, budget, out var bytes);
        return bytes;
    }

    private static HashSet<string> CollectDirectories(ImmutableArray<ArticleMediaFile> files, long budget, out long bytes)
    {
        var directories = new HashSet<string>(StringComparer.Ordinal);
        bytes = 0;
        foreach (var file in files)
        {
            var path = file.RelativePath;
            var slash = path.IndexOf('/');
            while (slash >= 0)
            {
                var prefix = path[..slash];
                if (directories.Add(prefix))
                {
                    bytes = checked(bytes + System.Text.Encoding.UTF8.GetByteCount(prefix) + 64);
                    if (bytes > budget)
                        throw new ArticleMediaException("directory_metadata_budget");
                }
                slash = path.IndexOf('/', slash + 1);
            }
        }
        return directories;
    }

    private ArticleMediaDirectory OpenRelativeDirectory(string path)
    {
        var current = new ArticleMediaDirectory(OpenHandle(FileDescriptor, ".", CloseOnExec | DirectoryFlag | NoFollow), _writable, _ancestors);
        try
        {
            if (path.Length != 0)
            {
                ValidateRelativePath(path);
                foreach (var segment in path.Split('/'))
                {
                    var next = current.TryOpenDirectory(segment) ?? throw new ArticleMediaException("generation_directory_missing");
                    current.Dispose();
                    current = next;
                }
            }
            return current;
        }
        catch
        {
            current.Dispose();
            throw;
        }
    }

    public void Publish(string stage, string target)
    {
        RequireWritable();
        ValidateSegment(stage);
        ValidateSegment(target);
        if (RenameAt2(FileDescriptor, stage, FileDescriptor, target, 1) != 0)
            throw new ArticleMediaException("generation_publish_conflict");
        Sync(_handle);
    }

    private SafeFileHandle OpenFile(string path)
    {
        using var parent = WalkParent(path, create: false, out var name);
        return parent.TryOpenFile(name) ?? throw new ArticleMediaException("missing_file");
    }

    private SafeFileHandle? TryOpenFile(string name)
    {
        ValidateSegment(name);
        var fd = OpenAt(FileDescriptor, name, CloseOnExec | NoFollow | NonBlock, 0);
        if (fd < 0)
        {
            if (Marshal.GetLastPInvokeError() == 2)
                return null;
            throw new ArticleMediaException("unsafe_or_unavailable_file");
        }
        var file = new SafeFileHandle(fd, true);
        try
        {
            var info = ReadIdentity(file, directory: false);
            if (info.Device != _identity.Device || info.Mount != _identity.Mount)
                throw new ArticleMediaException("cross_mount_file");
            return file;
        }
        catch
        {
            file.Dispose();
            throw;
        }
    }

    private ArticleMediaDirectory WalkParent(string path, bool create, out string name)
    {
        ValidateRelativePath(path);
        var parts = path.Split('/');
        name = parts[^1];
        var current = new ArticleMediaDirectory(OpenHandle(FileDescriptor, ".", CloseOnExec | DirectoryFlag | NoFollow), _writable, _ancestors);
        try
        {
            foreach (var part in parts[..^1])
            {
                var next = create ? current.OpenOrCreateDirectory(part)
                    : current.TryOpenDirectory(part) ?? throw new ArticleMediaException("missing_file");
                current.Dispose();
                current = next;
            }
            return current;
        }
        catch
        {
            current.Dispose();
            throw;
        }
    }

    internal static void ValidateRelativePath(string path)
    {
        if (path.Length == 0 || path.StartsWith('/') || path.Length > 4096)
            throw new ArticleMediaException("invalid_media_path");
        foreach (var part in path.Split('/'))
            ValidateSegment(part);
    }
    internal static void ValidateSegment(string segment)
    {
        if (segment.Length == 0 || segment is "." or ".." || segment.Any(c => c is '/' or '\\' or '\0' || char.IsControl(c))
            || System.Text.Encoding.UTF8.GetByteCount(segment) > 255)
            throw new ArticleMediaException("invalid_media_path");
    }

    private static async Task<(long Bytes, string Sha256)> HashStreamAsync(Stream stream, long expectedBytes, long maximumBytes, CancellationToken token)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[BufferBytes];
        long count = 0;
        while (true)
        {
            var read = await stream.ReadAsync(buffer, token);
            if (read == 0)
                break;
            count = checked(count + read);
            if (count > maximumBytes || count > expectedBytes)
                throw new ArticleMediaException("file_changed_or_budget");
            hash.AppendData(buffer, 0, read);
        }
        if (count != expectedBytes)
            throw new ArticleMediaException("file_changed_or_budget");
        return (count, Hex(hash.GetHashAndReset()));
    }

    private void RequireWritable()
    {
        if (!_writable)
            throw new ArticleMediaException("readonly_media_root");
    }
    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();
    private static SafeFileHandle OpenHandle(int parent, string name, int flags, uint mode = 0)
    {
        var fd = OpenAt(parent, name, flags, mode);
        if (fd < 0)
            throw new ArticleMediaException("anchored_filesystem_capability");
        return new SafeFileHandle(fd, true);
    }
    private static void Sync(SafeFileHandle fd)
    {
        if (FileSync(checked((int)fd.DangerousGetHandle())) != 0)
            throw new ArticleMediaException("media_durability_failure");
    }
    private static FileIdentity ReadIdentity(SafeFileHandle handle, bool directory)
    {
        if (Statx(checked((int)handle.DangerousGetHandle()), "", AtEmptyPath | AtNoFollow, BasicStats | MountId, out var stat) != 0
            || (stat.Mask & 0x13c1) != 0x13c1 || (stat.Mode & 0xf000) != (directory ? 0x4000 : 0x8000) || stat.Size > long.MaxValue)
            throw new ArticleMediaException("physical_identity_unavailable");
        return new(stat.DeviceMajor, stat.DeviceMinor, stat.Mount, stat.Inode, stat.UserId, stat.Mode, (long)stat.Size,
            stat.ModificationSeconds, stat.ModificationNanoseconds, stat.ChangeSeconds, stat.ChangeNanoseconds);
    }

    public void Dispose() => _handle.Dispose();
    private sealed record FileIdentity(uint Major, uint Minor, ulong Mount, ulong Inode, uint UserId, ushort Mode,
        long Bytes, long ModifiedSeconds, uint ModifiedNanoseconds, long ChangedSeconds, uint ChangedNanoseconds)
    {
        public (uint Major, uint Minor) Device => (Major, Minor);
        public string Stable => $"linux:{Major}:{Minor}:{Mount}:{Inode}";
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct NativeStat
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(20)] public uint UserId;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(40)] public ulong Size;
        [FieldOffset(96)] public long ChangeSeconds;
        [FieldOffset(104)] public uint ChangeNanoseconds;
        [FieldOffset(112)] public long ModificationSeconds;
        [FieldOffset(120)] public uint ModificationNanoseconds;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
        [FieldOffset(144)] public ulong Mount;
    }

    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(int directory, string path, int flags, uint mode);
    [DllImport("libc", EntryPoint = "mkdirat", SetLastError = true)]
    private static extern int MakeDirectoryAt(int directory, string path, uint mode);
    [DllImport("libc", EntryPoint = "linkat", SetLastError = true)]
    private static extern int LinkAt(int sourceDirectory, string source, int targetDirectory, string target, int flags);
    [DllImport("libc", EntryPoint = "renameat2", SetLastError = true)]
    private static extern int RenameAt2(int sourceDirectory, string source, int targetDirectory, string target, uint flags);
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, string path, int flags, uint mask, out NativeStat result);
    [DllImport("libc", EntryPoint = "fsync", SetLastError = true)]
    private static extern int FileSync(int descriptor);
    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern uint GetEffectiveUserId();
}
