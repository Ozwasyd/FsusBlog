using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotJsonHelpers
{
    internal static string TryGetString(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(propertyName, out JsonElement value))
        {
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString() ?? string.Empty,
                JsonValueKind.Number => value.ToString(),
                _ => string.Empty
            };
        }

        return string.Empty;
    }

    internal static int TryGetInt32(JsonElement element, string propertyName, int fallback = 0)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out JsonElement value) &&
            value.ValueKind == JsonValueKind.Number &&
            value.TryGetInt32(out int result))
        {
            return result;
        }

        return fallback;
    }

    internal static string TryGetNestedString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out JsonElement value))
        {
            return string.Empty;
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            return value.GetString() ?? string.Empty;
        }

        if (value.ValueKind == JsonValueKind.Object)
        {
            return TryGetString(value, "name");
        }

        return string.Empty;
    }

    internal static string FormatPublicTime(string raw)
    {
        if (DateTimeOffset.TryParse(raw, out DateTimeOffset timestamp))
        {
            return timestamp.ToLocalTime().ToString("yyyy-MM-dd");
        }

        return raw;
    }

    internal static string FormatFullPublicTime(string raw)
    {
        if (DateTimeOffset.TryParse(raw, out DateTimeOffset timestamp))
        {
            return timestamp.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
        }

        return raw;
    }
}
