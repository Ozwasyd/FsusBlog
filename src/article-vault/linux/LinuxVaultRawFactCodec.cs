using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>Seals and validates deterministic privacy-safe Linux watcher facts.</summary>
public static class LinuxVaultRawFactCodec
{
    public static LinuxVaultRawFact Seal(LinuxVaultRawFact fact)
    {
        ArgumentNullException.ThrowIfNull(fact);
        return fact with
        {
            ContentSha256 = ComputeContentSha256(fact)
        };
    }

    public static string ComputeContentSha256(LinuxVaultRawFact fact)
        => Convert.ToHexStringLower(SHA256.HashData(SerializeCanonicalContent(fact)));

    public static bool Validate(LinuxVaultRawFact? fact)
    {
        if (fact is null
            || fact.Schema != LinuxVaultWatcherSchemas.RawFact
            || fact.SchemaVersion != LinuxVaultWatcherSchemas.Version
            || fact.Platform != LinuxVaultWatcherSchemas.Platform
            || string.IsNullOrWhiteSpace(fact.FileSystem)
            || string.IsNullOrWhiteSpace(fact.SiteIdentity)
            || string.IsNullOrWhiteSpace(fact.VaultIdentity)
            || string.IsNullOrWhiteSpace(fact.DeviceIdentity)
            || string.IsNullOrWhiteSpace(fact.AgentIdentity)
            || string.IsNullOrWhiteSpace(fact.RootIdentity)
            || !IsSha256(fact.RootManifestSha256)
            || string.IsNullOrWhiteSpace(fact.WatchInstanceIdentity)
            || fact.Sequence <= 0
            || fact.TimestampUnixNanoseconds <= 0
            || fact.MonotonicTimestampNanoseconds <= 0
            || !HasClosedSemantics(fact)
            || !IsSha256(fact.ContentSha256))
        {
            return false;
        }

        string expected = ComputeContentSha256(fact);
        return CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(fact.ContentSha256),
            Convert.FromHexString(expected));
    }

    private static byte[] SerializeCanonicalContent(LinuxVaultRawFact fact)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Indented = false,
            SkipValidation = false
        }))
        {
            writer.WriteStartObject();
            writer.WriteString("schema", fact.Schema);
            writer.WriteNumber("schemaVersion", fact.SchemaVersion);
            writer.WriteString("platform", fact.Platform);
            writer.WriteString("fileSystem", fact.FileSystem);
            writer.WriteString("siteIdentity", fact.SiteIdentity);
            writer.WriteString("vaultIdentity", fact.VaultIdentity);
            writer.WriteString("deviceIdentity", fact.DeviceIdentity);
            writer.WriteString("agentIdentity", fact.AgentIdentity);
            writer.WriteString("rootIdentity", fact.RootIdentity);
            writer.WriteString("rootManifestSha256", fact.RootManifestSha256);
            writer.WriteString("watchInstanceIdentity", fact.WatchInstanceIdentity);
            writer.WriteNumber("sequence", fact.Sequence);
            writer.WriteNumber("mask", fact.Mask);
            writer.WriteString("factClass", EnumName(fact.FactClass));
            WriteNullableNumber(writer, "cookieDiagnostic", fact.CookieDiagnostic);
            WriteNullableString(writer, "rawOldRelativePath", fact.RawOldRelativePath);
            WriteNullableString(writer, "rawNewRelativePath", fact.RawNewRelativePath);
            writer.WriteNumber("timestampUnixNanoseconds", fact.TimestampUnixNanoseconds);
            writer.WriteNumber("monotonicTimestampNanoseconds", fact.MonotonicTimestampNanoseconds);
            writer.WriteString("pathDisposition", EnumName(fact.PathDisposition));
            WriteNullableString(writer, "errorCode", fact.ErrorCode);
            writer.WriteBoolean("rescanRequired", fact.RescanRequired);
            writer.WriteBoolean("watermarkValid", fact.WatermarkValid);
            writer.WriteEndObject();
        }

        return stream.ToArray();
    }

    private static string EnumName<T>(T value) where T : struct, Enum
        => JsonNamingPolicy.KebabCaseLower.ConvertName(value.ToString());

    private static void WriteNullableString(Utf8JsonWriter writer, string name, string? value)
    {
        if (value is null)
        {
            writer.WriteNull(name);
        }
        else
        {
            writer.WriteString(name, value);
        }
    }

    private static void WriteNullableNumber(Utf8JsonWriter writer, string name, uint? value)
    {
        if (value.HasValue)
        {
            writer.WriteNumber(name, value.Value);
        }
        else
        {
            writer.WriteNull(name);
        }
    }

    private static bool IsSha256(string value)
        => value.Length == 64 && value.All(static character => char.IsAsciiHexDigit(character));

    private static bool HasClosedSemantics(LinuxVaultRawFact fact)
    {
        if (!Enum.IsDefined(fact.FactClass)
            || !Enum.IsDefined(fact.PathDisposition)
            || (fact.RescanRequired && (fact.WatermarkValid || !IsReasonCode(fact.ErrorCode)))
            || (fact.ErrorCode is not null && (!fact.RescanRequired || !IsReasonCode(fact.ErrorCode)))
            || (fact.PathDisposition is LinuxVaultPathDisposition.Blocked or LinuxVaultPathDisposition.ControlTree
                && (!fact.RescanRequired || fact.WatermarkValid || !IsReasonCode(fact.ErrorCode)))
            || (fact.CookieDiagnostic.HasValue
                && fact.FactClass is not LinuxVaultFactClass.MovedFrom and not LinuxVaultFactClass.MovedTo))
        {
            return false;
        }

        bool validPathShape = fact.FactClass switch
        {
            LinuxVaultFactClass.MovedFrom => IsNonRootRelativePath(fact.RawOldRelativePath)
                && fact.RawNewRelativePath is null,
            LinuxVaultFactClass.MovedTo => fact.RawOldRelativePath is null
                && IsNonRootRelativePath(fact.RawNewRelativePath),
            LinuxVaultFactClass.Created
                or LinuxVaultFactClass.Modified
                or LinuxVaultFactClass.AttributesChanged
                or LinuxVaultFactClass.ClosedAfterWrite
                or LinuxVaultFactClass.Deleted => fact.RawOldRelativePath is null
                    && IsRootRelativePath(fact.RawNewRelativePath),
            LinuxVaultFactClass.WatcherRestarted => fact.RawOldRelativePath is null
                    && fact.RawNewRelativePath is null,
            LinuxVaultFactClass.QueueOverflow => fact.RawOldRelativePath is null
                && fact.RawNewRelativePath is null
                && fact.PathDisposition == LinuxVaultPathDisposition.None,
            LinuxVaultFactClass.Unknown => fact.RawOldRelativePath is null
                && fact.RawNewRelativePath is null
                && fact.PathDisposition == LinuxVaultPathDisposition.Blocked
                && fact.RescanRequired
                && !fact.WatermarkValid
                && IsReasonCode(fact.ErrorCode),
            _ => fact.RawOldRelativePath is null
                && (fact.RawNewRelativePath is null || IsRootRelativePath(fact.RawNewRelativePath))
        };
        if (!validPathShape)
        {
            return false;
        }

        bool hasNonRootPath = IsNonRootRelativePath(fact.RawOldRelativePath)
            || IsNonRootRelativePath(fact.RawNewRelativePath);
        return !hasNonRootPath || fact.PathDisposition != LinuxVaultPathDisposition.None;
    }

    private static bool IsReasonCode(string? value)
        => !string.IsNullOrWhiteSpace(value)
            && value.Length <= 256
            && value[0] is >= 'a' and <= 'z'
            && value.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_');

    private static bool IsNonRootRelativePath(string? value)
        => value is { Length: > 0 } && IsRootRelativePath(value);

    private static bool IsRootRelativePath(string? value)
    {
        if (value is null
            || value.IndexOfAny(['\0', '\r', '\n', '\\']) >= 0
            || value.StartsWith("/", StringComparison.Ordinal))
        {
            return false;
        }

        return value.Length == 0
            || value.Split('/', StringSplitOptions.None)
                .All(static segment => segment.Length > 0 && segment is not "." and not "..");
    }
}
