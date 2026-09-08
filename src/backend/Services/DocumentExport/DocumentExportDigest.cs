using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Services.DocumentExport;

internal static class DocumentExportDigest
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        AllowTrailingCommas = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        MaxDepth = 64,
        WriteIndented = false
    };

    internal static string Compute<T>(T value)
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, s_json)))}";

    internal static string ComputeBytes(ReadOnlySpan<byte> bytes)
        => $"sha256:{Convert.ToHexStringLower(SHA256.HashData(bytes))}";

    internal static byte[] Serialize<T>(T value)
        => JsonSerializer.SerializeToUtf8Bytes(value, s_json);

    internal static T Deserialize<T>(ReadOnlySpan<byte> bytes)
    {
        ValidateNoDuplicateProperties(bytes);
        try
        {
            return JsonSerializer.Deserialize<T>(bytes, s_json)
                ?? throw new InvalidDataException($"Document export payload '{typeof(T).Name}' was empty.");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException(
                $"Document export payload '{typeof(T).Name}' is not a closed canonical JSON object.",
                exception);
        }
    }

    private static void ValidateNoDuplicateProperties(ReadOnlySpan<byte> bytes)
    {
        try
        {
            var reader = new Utf8JsonReader(bytes, new JsonReaderOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 64
            });
            var scopes = new Stack<HashSet<string>?>();
            while (reader.Read())
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.StartObject:
                        scopes.Push(new HashSet<string>(StringComparer.Ordinal));
                        break;
                    case JsonTokenType.EndObject:
                    case JsonTokenType.EndArray:
                        scopes.Pop();
                        break;
                    case JsonTokenType.StartArray:
                        scopes.Push(null);
                        break;
                    case JsonTokenType.PropertyName:
                        HashSet<string>? properties = scopes.Peek();
                        string propertyName = reader.GetString()
                            ?? throw new InvalidDataException("Document export JSON property name is null.");
                        if (properties is null || !properties.Add(propertyName))
                        {
                            throw new InvalidDataException(
                                $"Document export JSON property '{propertyName}' is duplicated or misplaced.");
                        }
                        break;
                }
            }
            if (scopes.Count != 0)
            {
                throw new InvalidDataException("Document export JSON scopes are incomplete.");
            }
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("Document export JSON is malformed.", exception);
        }
    }
}
