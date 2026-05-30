using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Helpers;

internal static class JsonDecodeHelper
{
    public static T? DeserializeOrNull<T>(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(json);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    public static T? DeserializeOrNull<T>(ReadOnlySpan<byte> utf8Json)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(utf8Json);
        }
        catch (JsonException)
        {
            return default;
        }
    }
}
