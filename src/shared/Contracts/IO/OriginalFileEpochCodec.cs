using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Contracts.IO;

/// <summary>Comparison data only; these fields cannot construct a native file identity or parent capability.</summary>
public readonly record struct OriginalFileEpochData(
    uint DeviceMajor, uint DeviceMinor, ulong Inode, ushort Mode, uint Links,
    uint Uid, uint Gid, ulong Size, long ModifiedSeconds, uint ModifiedNanoseconds,
    long ChangedSeconds, uint ChangedNanoseconds);

/// <summary>The original guard's directory incarnation projection, in root-to-parent order.</summary>
public readonly record struct OriginalDirectoryEpochData(uint DeviceMajor, uint DeviceMinor, ulong Inode, ushort Mode);

/// <summary>Versioned exact cross-runtime comparison encoding; it never imports native identity or authority.</summary>
public static class OriginalFileEpochCodec
{
    private static readonly Encoding s_utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    /// <summary>UTF8 without BOM, invariant decimal fields and final LF; no atime or inferred identity fields.</summary>
    public static byte[] Encode(string canonicalPath, OriginalFileEpochData leaf,
        IReadOnlyList<OriginalDirectoryEpochData> ancestors)
    {
        ArgumentNullException.ThrowIfNull(ancestors);
        if (string.IsNullOrEmpty(canonicalPath) || !canonicalPath.StartsWith('/') || canonicalPath.EndsWith('/')
            || canonicalPath.Any(char.IsControl)
            || canonicalPath[1..].Split('/').Any(component => component.Length == 0 || component is "." or "..")
            || ancestors.Count != canonicalPath.Split('/', StringSplitOptions.RemoveEmptyEntries).Length
            || leaf.ModifiedNanoseconds >= 1000000000 || leaf.ChangedNanoseconds >= 1000000000)
            throw new InvalidOperationException("original_file_epoch_observation_invalid");
        int pathBytes;
        try
        {
            pathBytes = s_utf8.GetByteCount(canonicalPath);
        }
        catch (EncoderFallbackException)
        {
            throw new InvalidOperationException("original_file_epoch_observation_invalid");
        }
        if (pathBytes > 4095)
            throw new InvalidOperationException("original_file_epoch_observation_invalid");
        var text = new StringBuilder("fsus-original-file-epoch-v1\n");
        text.Append("path:").Append(pathBytes.ToString(CultureInfo.InvariantCulture))
            .Append(':').Append(canonicalPath).Append('\n');
        text.Append(FormattableString.Invariant(
            $"leaf:{leaf.DeviceMajor}:{leaf.DeviceMinor}:{leaf.Inode}:{leaf.Mode}:{leaf.Links}:{leaf.Uid}:{leaf.Gid}:{leaf.Size}:{leaf.ModifiedSeconds}:{leaf.ModifiedNanoseconds}:{leaf.ChangedSeconds}:{leaf.ChangedNanoseconds}\n"));
        text.Append("ancestors:").Append(ancestors.Count.ToString(CultureInfo.InvariantCulture)).Append('\n');
        foreach (OriginalDirectoryEpochData directory in ancestors)
        {
            text.Append(FormattableString.Invariant(
                $"ancestor:{directory.DeviceMajor}:{directory.DeviceMinor}:{directory.Inode}:{directory.Mode}\n"));
        }
        return s_utf8.GetBytes(text.ToString());
    }

    /// <summary>Lowercase SHA256 comparison data of the complete versioned encoding.</summary>
    public static string Hash(string canonicalPath, OriginalFileEpochData leaf,
        IReadOnlyList<OriginalDirectoryEpochData> ancestors)
        => Convert.ToHexStringLower(SHA256.HashData(Encode(canonicalPath, leaf, ancestors)));
}
