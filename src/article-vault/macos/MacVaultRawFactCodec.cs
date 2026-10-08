using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.MacOS;

/// <summary>Content-addresses closed raw observations independently of filesystem or sync authority.</summary>
public static class MacVaultRawFactCodec
{
    private static readonly JsonSerializerOptions s_options = CreateOptions();

    /// <summary>Seals the complete observation, excluding its own digest slot.</summary>
    public static MacVaultRawFact Seal(MacVaultRawFact fact)
        => fact with
        {
            ContentSha256 = ComputeContentSha256(fact)
        };

    /// <summary>Recomputes a deterministic digest; it is a fact digest, never a Markdown digest.</summary>
    public static string ComputeContentSha256(MacVaultRawFact fact)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
            fact with
            {
                ContentSha256 = string.Empty
            }, s_options)));

    /// <summary>Checks shape, privacy-safe reason codes and the independently expected watch binding.</summary>
    public static bool Validate(MacVaultRawFact? fact, MacVaultWatchIdentity expectedIdentity)
    {
        if (fact is null
            || fact.Identity != expectedIdentity
            || fact.Schema != MacVaultWatcherSchemas.RawFact
            || fact.SchemaVersion != MacVaultWatcherSchemas.Version
            || fact.Platform != "macos"
            || fact.Identity is null
            || fact.Identity.Filesystem is null
            || fact.Identity.Filesystem.FileSystem != "apfs"
            || fact.Identity.Filesystem.UnicodeComparison != "canonical-equivalence"
            || !IsIdentity(fact.Identity.SiteIdentity)
            || !IsIdentity(fact.Identity.VaultIdentity)
            || !IsIdentity(fact.Identity.DeviceIdentity)
            || !IsIdentity(fact.Identity.AgentIdentity)
            || !IsIdentity(fact.Identity.WatchInstanceIdentity)
            || !IsIdentity(fact.Identity.Filesystem.VolumeIdentity)
            || !IsSha256(fact.Identity.RootIdentitySha256)
            || !IsSha256(fact.Identity.RootManifestSha256)
            || fact.Sequence <= 0
            || fact.ObservedUnixMilliseconds <= 0
            || fact.ObservedMonotonicTicks <= 0
            || !Enum.IsDefined(fact.FactClass)
            || !Enum.IsDefined(fact.PathDisposition)
            || !fact.RescanRequired
            || fact.WatermarkValid
            || !IsReason(fact.ErrorCode)
            || !IsPath(fact.RawObservedRelativePath)
            || !IsPath(fact.RawOldRelativePath)
            || !IsPath(fact.RawNewRelativePath)
            || !HasRawShape(fact)
            || !IsSha256(fact.ContentSha256))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(fact.ContentSha256), Convert.FromHexString(ComputeContentSha256(fact)));
    }

    private static bool HasRawShape(MacVaultRawFact fact)
    {
        if (fact.FactClass != MacVaultFactClass.NativeEvent)
        {
            return (fact.RawObservedRelativePath is null || fact.FactClass == MacVaultFactClass.BlockedPath)
                && fact.RawOldRelativePath is null
                && fact.RawNewRelativePath is null
                && fact.FileIdDiagnostic is null
                && (fact.FactClass == MacVaultFactClass.BlockedPath
                    ? fact.PathDisposition == MacVaultPathDisposition.Blocked
                    : fact.PathDisposition == MacVaultPathDisposition.None);
        }

        if (fact.NativeEventId is null || fact.RawObservedRelativePath is null
            || fact.PathDisposition is MacVaultPathDisposition.None or MacVaultPathDisposition.Blocked)
        {
            return false;
        }

        // Ambiguous rename/coalesced flags have only an observed path, never an invented pair.
        bool removedOnly = (fact.NativeFlags & 0x300u) == 0x200u && (fact.NativeFlags & 0x800u) == 0;
        bool renamed = (fact.NativeFlags & 0x800u) != 0;
        return renamed
            ? fact.RawOldRelativePath is null && fact.RawNewRelativePath is null
            : removedOnly
                ? fact.RawOldRelativePath == fact.RawObservedRelativePath && fact.RawNewRelativePath is null
                : fact.RawOldRelativePath is null && fact.RawNewRelativePath == fact.RawObservedRelativePath;
    }

    internal static bool IsIdentity(string? value)
        => value is { Length: >= 3 and <= 128 }
            && !value.Any(static character => char.IsControl(character) || char.IsWhiteSpace(character)
                || character is '/' or '\\');

    private static bool IsSha256(string? value)
        => value is { Length: 64 }
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsReason(string? value)
        => value is { Length: > 0 and <= 128 }
            && value.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_');

    private static bool IsPath(string? value)
        => value is null or "" || ArticleVaultPathStructureValidator.ValidateRelativePath(value).IsValid;

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNameCaseInsensitive = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower, false));
        return options;
    }
}
