using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Binds a plugin-free local process without carrying credentials or paths.</summary>
public sealed record ArticleVaultAgentBinding(
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentInstanceIdentity,
    string UserSessionIdentity,
    string RootSha256,
    string BinarySha256,
    string AgentVersion,
    int ProtocolVersion);

/// <summary>Defines the single closed agent protocol and privacy-safe digest encoding.</summary>
public static class ArticleVaultAgentProtocol
{
    public const int Version = 1;
    public const int MaximumFrameBytes = 16384;
    public const string RequestSchema = "fsusblog.article-vault.agent-request.v1";
    public const string LeaseSchema = "fsusblog.article-vault.writer-lease.v1";
    public const string LifecycleSchema = "fsusblog.article-vault.agent-lifecycle.v1";

    private static readonly JsonSerializerOptions s_options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower, allowIntegerValues: false) }
    };

    public static bool IsIdentity(string? value)
        => value is { Length: >= 1 and <= 64 }
            && value.All(static character => char.IsAsciiLetterOrDigit(character) || character == '-');

    public static bool IsDigest(string? value)
        => value is { Length: 64 }
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static bool IsBinding(ArticleVaultAgentBinding? binding)
        => binding is not null
            && IsIdentity(binding.SiteIdentity) && IsIdentity(binding.VaultIdentity)
            && IsIdentity(binding.DeviceIdentity) && IsIdentity(binding.AgentInstanceIdentity)
            && IsIdentity(binding.UserSessionIdentity) && IsDigest(binding.RootSha256)
            && IsDigest(binding.BinarySha256) && binding.ProtocolVersion == Version
            && binding.AgentVersion is { Length: >= 5 and <= 32 }
            && System.Version.TryParse(binding.AgentVersion, out System.Version? version)
            && version.ToString() == binding.AgentVersion;

    public static byte[] Encode<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, s_options);

    public static string Digest<T>(T value)
        => Convert.ToHexStringLower(SHA256.HashData(Encode(value)));

    internal static T Decode<T>(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length is < 1 or > MaximumFrameBytes)
        {
            throw new InvalidDataException("agent_frame_size_invalid");
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes.ToArray(), new()
            {
                MaxDepth = 8
            });
            RejectDuplicates(document.RootElement);
            return JsonSerializer.Deserialize<T>(bytes, s_options)
                ?? throw new InvalidDataException("agent_frame_missing");
        }
        catch (JsonException)
        {
            // Never expose parser excerpts containing untrusted content in support evidence.
            throw new InvalidDataException("agent_frame_schema_invalid");
        }
    }

    private static void RejectDuplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            HashSet<string> fields = new(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!fields.Add(property.Name))
                {
                    throw new InvalidDataException("agent_frame_duplicate_field");
                }

                RejectDuplicates(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicates(item);
            }
        }
    }
}
