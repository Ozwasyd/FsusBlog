using System.Text.Json;
using System.Text.Json.Serialization;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal readonly record struct PublicAotInvalidationMessage(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("value")] string Value)
{
    internal const string Channel = "public:aot:v2:invalidate";
    internal const string TypeKey = "key";
    internal const string TypePrefix = "prefix";
    internal const string TypeAll = "all";

    internal static PublicAotInvalidationMessage Key(string cacheKey)
        => new(TypeKey, cacheKey);

    internal static PublicAotInvalidationMessage Prefix(string prefix)
        => new(TypePrefix, prefix);

    internal static PublicAotInvalidationMessage All()
        => new(TypeAll, string.Empty);

    internal string ToPayload()
        => JsonSerializer.Serialize(this);

    internal static bool TryParse(RedisValue payload, out PublicAotInvalidationMessage message)
    {
        message = default;
        if (payload.IsNullOrEmpty)
        {
            return false;
        }

        string raw = payload.ToString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        if (raw[0] != '{')
        {
            message = string.Equals(raw, TypeAll, StringComparison.Ordinal)
                ? All()
                : Key(raw);
            return true;
        }

        try
        {
            PublicAotInvalidationMessage parsed = JsonSerializer.Deserialize<PublicAotInvalidationMessage>(raw);
            if (string.IsNullOrWhiteSpace(parsed.Type))
            {
                return false;
            }

            message = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}

internal readonly record struct PublicAotBatchInvalidationStats(
    int InvalidatedKeys,
    int DeletedFiles,
    long RegistryRemovedMembers,
    int PublishCount)
{
    public static PublicAotBatchInvalidationStats Empty => default;

    public PublicAotBatchInvalidationStats Add(PublicAotBatchInvalidationStats other)
        => new(
            InvalidatedKeys + other.InvalidatedKeys,
            DeletedFiles + other.DeletedFiles,
            RegistryRemovedMembers + other.RegistryRemovedMembers,
            PublishCount + other.PublishCount);

    public PublicAotBatchInvalidationStats WithPublish()
        => new(InvalidatedKeys, DeletedFiles, RegistryRemovedMembers, PublishCount + 1);
}
