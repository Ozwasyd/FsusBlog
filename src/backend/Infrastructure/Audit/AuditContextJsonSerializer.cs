using System.Buffers;
using System.Collections;
using System.Globalization;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Infrastructure.Audit;

internal static class AuditContextJsonSerializer
{
    public static string? Serialize(byte[]? contextPayload)
    {
        if (contextPayload is not { Length: > 0 }
            || !PublicAotBinaryPayload.TryDecodeObject(contextPayload, out Dictionary<string, object?> payload))
        {
            return null;
        }

        var buffer = new ArrayBufferWriter<byte>(Math.Min(Math.Max(contextPayload.Length * 2, 256), 16 * 1024));
        using (var writer = new Utf8JsonWriter(buffer))
        {
            WriteObject(writer, payload);
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static void WriteObject(Utf8JsonWriter writer, IReadOnlyDictionary<string, object?> value)
    {
        writer.WriteStartObject();
        foreach ((string key, object? item) in value)
        {
            writer.WritePropertyName(key);
            WriteValue(writer, item);
        }

        writer.WriteEndObject();
    }

    private static void WriteArray(Utf8JsonWriter writer, IEnumerable value)
    {
        writer.WriteStartArray();
        foreach (object? item in value)
        {
            WriteValue(writer, item);
        }

        writer.WriteEndArray();
    }

    private static void WriteValue(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case string text:
                writer.WriteStringValue(text);
                break;
            case bool boolean:
                writer.WriteBooleanValue(boolean);
                break;
            case int number:
                writer.WriteNumberValue(number);
                break;
            case long number:
                writer.WriteNumberValue(number);
                break;
            case double number when double.IsFinite(number):
                writer.WriteNumberValue(number);
                break;
            case IReadOnlyDictionary<string, object?> dictionary:
                WriteObject(writer, dictionary);
                break;
            case IEnumerable enumerable:
                WriteArray(writer, enumerable);
                break;
            default:
                writer.WriteStringValue(Convert.ToString(value, CultureInfo.InvariantCulture));
                break;
        }
    }
}
