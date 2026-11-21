using System.Security.Cryptography;
using FsusBlog.V2.Core.Extensions;

namespace FsusBlog.V2.Platform.Extensions;

internal sealed record WorkerPayloadLimits(int ManifestBytes, int Files, int Entries, int Depth, long ContentBytes, int MinimumFileBytes);

internal sealed class VerifiedWorkerPayload(string prefix, WorkerPayloadLimits limits)
{
    private const string FileManifest = "payload.sha256";

    internal void Verify(string root, string expected, Func<string, bool> validPath,
        IReadOnlyDictionary<string, string?> required, CancellationToken ct)
    {
        try { Read(root, expected, validPath, required, ct); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw Deny("untrusted"); }
    }

    private void Read(string root, string expected, Func<string, bool> validPath, IReadOnlyDictionary<string, string?> required,
        CancellationToken ct)
    {
        for (DirectoryInfo? current = new(root); current is not null; current = current.Parent)
        {
            using var parent = NativeUnixFile.OpenDirectory(current.FullName);
            if (!NativeUnixFile.IsRootControlled(parent, regular: false)) throw Deny("untrusted");
        }
        using var manifest = Open(root, FileManifest);
        var manifestLength = manifest.Length;
        if (manifestLength < 1 || manifestLength > limits.ManifestBytes) throw Deny("manifest");
        var bytes = new byte[(int)manifestLength];
        manifest.ReadExactly(bytes);
        if (manifest.ReadByte() != -1 || Convert.ToHexStringLower(SHA256.HashData(bytes)) != expected)
            throw Deny("digest");
        var listed = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var entry in System.Text.Encoding.ASCII.GetString(bytes).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (entry.Length < 67 || entry[64..66] != "  " || !ExtensionManifestReader.IsDigest(entry[..64]) ||
                !validPath(entry[66..]) || !listed.TryAdd(entry[66..], entry[..64]))
                throw Deny("manifest");
        }
        if (listed.Count < 5 || listed.Count > limits.Files || required.Any(pair =>
            !listed.TryGetValue(pair.Key, out var digest) || (pair.Value is not null && pair.Value != digest))) throw Deny("manifest");
        var remaining = limits.ContentBytes;
        var entryCount = 0;
        VerifyDirectory(new(root), 0);

        void VerifyDirectory(DirectoryInfo directory, int depth)
        {
            if (depth > limits.Depth) throw Deny("size");
            using var handle = NativeUnixFile.OpenDirectory(directory.FullName);
            if (!NativeUnixFile.IsRootControlled(handle, regular: false)) throw Deny("untrusted");
            foreach (var entry in directory.EnumerateFileSystemInfos())
            {
                ct.ThrowIfCancellationRequested();
                if (++entryCount > limits.Entries) throw Deny("size");
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) throw Deny("untrusted");
                if (entry is DirectoryInfo child) { VerifyDirectory(child, depth + 1); continue; }
                var relative = Path.GetRelativePath(root, entry.FullName);
                if (relative == FileManifest) continue;
                if (!listed.Remove(relative, out var digest)) throw Deny("manifest");
                using var file = Open(directory.FullName, entry.Name);
                var length = file.Length;
                if (length < limits.MinimumFileBytes || length > remaining) throw Deny("size");
                remaining -= length;
                if (Convert.ToHexStringLower(SHA256.HashData(file)) != digest) throw Deny("digest");
            }
            if (directory.FullName == root && listed.Count != 0) throw Deny("manifest");
        }
    }

    private FileStream Open(string path, string name)
    {
        using var directory = NativeUnixFile.OpenDirectory(path);
        var handle = NativeUnixFile.OpenFile(directory, name, NativeUnixFile.FileReadFlags, out _) ??
            throw Deny("untrusted");
        try
        {
            if (!NativeUnixFile.IsRootControlled(handle, regular: true)) throw Deny("untrusted");
            return new FileStream(handle, FileAccess.Read);
        }
        catch { handle.Dispose(); throw; }
    }

    private ExtensionRejectedException Deny(string code) => new($"{prefix}-install-{code}");
}
