using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlogV2.Storage;

internal static class PropertyStorageJson
{
    internal const int SchemaByteBudget = 8 * 1024 * 1024;

    internal static readonly JsonSerializerOptions Options = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        AllowOutOfOrderMetadataProperties = true,
        IgnoreReadOnlyProperties = true,
    };
}
