using System.Globalization;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Pressure;

public enum LinuxCgroupScopeReason
{
    Ready, Missing, Unavailable, InvalidFormat, BoundExceeded, Ambiguous, Unobservable
}

public sealed record LinuxCgroupScopeIdentity(int Version, int HierarchyId, ulong CgroupNamespaceInode,
    ulong MountNamespaceInode, int MountId, string DeviceIdentity, string MountRoot,
    string MembershipPath, string MountPoint);

public sealed record LinuxCgroupScope(LinuxCgroupScopeIdentity Identity, IReadOnlyList<string> ObservableDirectories)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

public sealed record LinuxCgroupScopeResolution(MemoryObservationState State, LinuxCgroupScopeReason Reason,
    LinuxCgroupScope? Scope);

/// <summary>
/// Resolves bounded captured membership/mount metadata without filesystem I/O or
/// universal mount paths. Directory inode identity, stable open handles, matching
/// usage/limit sampling and release/runtime qualification remain the sampling owner's
/// responsibility. Resolved metadata never grants headroom or growth permission.
/// </summary>
public static class LinuxCgroupScopeResolver
{
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);

    public static LinuxCgroupScopeResolution Resolve(ReadOnlySpan<byte> membership, ReadOnlySpan<byte> mountInfo,
        MemoryObservationState membershipState, MemoryObservationState mountState,
        ulong cgroupNamespaceInode, ulong mountNamespaceInode, int maximumInputBytes,
        int maximumMountRecords, int maximumAncestors)
    {
        if (!Enum.IsDefined(membershipState) || !Enum.IsDefined(mountState) || maximumInputBytes <= 0
            || maximumMountRecords <= 0 || maximumAncestors <= 0 || cgroupNamespaceInode == 0 || mountNamespaceInode == 0)
        {
            return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.InvalidFormat);
        }
        if (membershipState != MemoryObservationState.Available || mountState != MemoryObservationState.Available)
        {
            MemoryObservationState unavailable = membershipState != MemoryObservationState.Available ? membershipState : mountState;
            return Reject(unavailable, LinuxCgroupScopeReason.Unavailable);
        }
        if (membership.Length > maximumInputBytes || mountInfo.Length > maximumInputBytes)
        {
            return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.BoundExceeded);
        }
        if (membership.IsEmpty || mountInfo.IsEmpty)
        {
            return Reject(MemoryObservationState.Unknown, LinuxCgroupScopeReason.Missing);
        }
        try
        {
            var candidates = new List<(int Version, int Hierarchy, string Path)>();
            foreach (string line in s_strictUtf8.GetString(membership).Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                string[] fields = line.Split(':', 3);
                if (fields.Length != 3 || !Number(fields[0], out int hierarchy))
                {
                    return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.InvalidFormat);
                }
                bool unified = hierarchy == 0 && fields[1].Length == 0;
                bool memory = fields[1].Split(',').Contains("memory", StringComparer.Ordinal);
                if (!unified && !memory)
                {
                    continue;
                }
                if (memory && hierarchy == 0 || !CanonicalPath(fields[2]) || fields[2].EndsWith(" (deleted)", StringComparison.Ordinal))
                {
                    return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.InvalidFormat);
                }
                if (candidates.Count == maximumMountRecords)
                {
                    return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.BoundExceeded);
                }
                candidates.Add((unified ? 2 : 1, hierarchy, fields[2]));
            }
            // A v1 memory binding owns that controller even on a hybrid host.
            var relevant = candidates.Any(item => item.Version == 1)
                ? candidates.Where(item => item.Version == 1).ToArray() : candidates.ToArray();
            if (relevant.Length != 1)
            {
                return Reject(MemoryObservationState.Unknown,
                    relevant.Length == 0 ? LinuxCgroupScopeReason.Missing : LinuxCgroupScopeReason.Ambiguous);
            }
            (int version, int hierarchyId, string member) = relevant[0];
            LinuxCgroupScopeIdentity? identity = null;
            int records = 0;
            foreach (string line in s_strictUtf8.GetString(mountInfo).Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                if (++records > maximumMountRecords)
                {
                    return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.BoundExceeded);
                }
                string[] fields = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                int separator = Array.IndexOf(fields, "-");
                if (separator < 6 || fields.Length != separator + 4 || !Number(fields[0], out int mountId)
                    || mountId == 0 || !Number(fields[1], out _) || !Device(fields[2]))
                {
                    return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.InvalidFormat);
                }
                bool matching = version == 2 ? fields[separator + 1] == "cgroup2"
                    : fields[separator + 1] == "cgroup" && fields[separator + 3].Split(',').Contains("memory", StringComparer.Ordinal);
                if (!matching)
                {
                    continue;
                }
                string? root = DecodePath(fields[3]);
                string? point = DecodePath(fields[4]);
                if (root is null || point is null || !CanonicalPath(root) || !CanonicalPath(point))
                {
                    return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.InvalidFormat);
                }
                if (!Within(member, root))
                {
                    continue;
                }
                if (identity is not null)
                {
                    return Reject(MemoryObservationState.Unknown, LinuxCgroupScopeReason.Ambiguous);
                }
                identity = new(version, hierarchyId, cgroupNamespaceInode, mountNamespaceInode,
                    mountId, fields[2], root, member, point);
            }
            if (identity is null)
            {
                return Reject(MemoryObservationState.Unknown, LinuxCgroupScopeReason.Unobservable);
            }
            string relative = identity.MountRoot == "/" ? member[1..] : member[identity.MountRoot.Length..].TrimStart('/');
            string leaf = relative.Length == 0 ? identity.MountPoint
                : identity.MountPoint == "/" ? "/" + relative : identity.MountPoint + "/" + relative;
            var ancestors = new List<string>();
            string cursor = leaf;
            while (true)
            {
                if (ancestors.Count == maximumAncestors)
                {
                    return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.BoundExceeded);
                }
                ancestors.Add(cursor);
                if (cursor == identity.MountPoint)
                {
                    break;
                }
                int slash = cursor.LastIndexOf('/');
                cursor = slash == 0 ? "/" : cursor[..slash];
            }
            return new(MemoryObservationState.Available, LinuxCgroupScopeReason.Ready,
                new(identity, ancestors.AsReadOnly()));
        }
        catch (DecoderFallbackException)
        {
            return Reject(MemoryObservationState.Malformed, LinuxCgroupScopeReason.InvalidFormat);
        }
    }

    private static bool Within(string member, string root)
        => root == "/" || member == root || member.StartsWith(root + "/", StringComparison.Ordinal);

    private static bool CanonicalPath(string value)
        => value.StartsWith('/') && !value.Contains('\0') && (value == "/"
            || !value.EndsWith('/') && value[1..].Split('/').All(part => part.Length > 0 && part is not "." and not ".."));

    private static bool Number(string value, out int number)
        => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number) && number >= 0;

    private static bool Device(string value)
    {
        string[] fields = value.Split(':');
        return fields.Length == 2 && Number(fields[0], out _) && Number(fields[1], out _);
    }

    private static string? DecodePath(string value)
    {
        var result = new StringBuilder(value.Length);
        for (int index = 0; index < value.Length; index++)
        {
            if (value[index] != '\\')
            {
                result.Append(value[index]);
                continue;
            }
            if (index > value.Length - 4)
            {
                return null;
            }
            string octal = value.Substring(index + 1, 3);
            char? decoded = octal switch
            {
                "040" => ' ',
                "011" => '\t',
                "012" => '\n',
                "134" => '\\',
                _ => null
            };
            if (decoded is null)
            {
                return null;
            }
            result.Append(decoded.Value);
            index += 3;
        }
        return result.ToString();
    }

    private static LinuxCgroupScopeResolution Reject(MemoryObservationState state, LinuxCgroupScopeReason reason)
        => new(state, reason, null);
}
