using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed, bounded decoding of an already admitted payload. A future registered AEDS
/// endpoint selects the operation; this codec never authenticates or reads HTTP bytes.
/// </summary>
public static class AuthorSavedViewRequestCodec
{
    public const int MaxPayloadBytes = 1_048_576;
    private const int MaxDepth = 16;
    private const int MaxNodes = 65_536;
    private static readonly JsonSerializerOptions s_options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        MaxDepth = MaxDepth
    };

    public static AuthorSavedViewCommandRequest Decode(
        AuthorSavedViewRequestOperation operation, ReadOnlyMemory<byte> payload)
    {
        if (payload.IsEmpty || payload.Length > MaxPayloadBytes)
        {
            throw InvalidRequest();
        }
        try
        {
            using JsonDocument document = JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = MaxDepth });
            int remainingNodes = MaxNodes;
            RejectDuplicateProperties(document.RootElement, ref remainingNodes);
            return operation switch
            {
                AuthorSavedViewRequestOperation.Create => Read<AuthorSavedViewCreateRequest>(document),
                AuthorSavedViewRequestOperation.Update => Read<AuthorSavedViewUpdateRequest>(document),
                AuthorSavedViewRequestOperation.Rename => Read<AuthorSavedViewRenameRequest>(document),
                AuthorSavedViewRequestOperation.Pin => Read<AuthorSavedViewPinRequest>(document),
                AuthorSavedViewRequestOperation.Reorder => Read<AuthorSavedViewReorderRequest>(document),
                AuthorSavedViewRequestOperation.Move => Read<AuthorSavedViewMoveRequest>(document),
                AuthorSavedViewRequestOperation.Default => Read<AuthorSavedViewDefaultRequest>(document),
                AuthorSavedViewRequestOperation.Retire => Read<AuthorSavedViewRetireRequest>(document),
                AuthorSavedViewRequestOperation.Delete => Read<AuthorSavedViewDeleteRequest>(document),
                _ => throw InvalidRequest()
            };
        }
        catch (JsonException)
        {
            // Do not include rejected private values or serializer paths in the error.
            throw InvalidRequest();
        }
    }

    private static T Read<T>(JsonDocument document) where T : AuthorSavedViewCommandRequest
        => document.RootElement.Deserialize<T>(s_options) ?? throw InvalidRequest();

    private static void RejectDuplicateProperties(JsonElement element, ref int remainingNodes)
    {
        if (--remainingNodes < 0)
        {
            throw InvalidRequest();
        }
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw InvalidRequest();
                }
                RejectDuplicateProperties(property.Value, ref remainingNodes);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item, ref remainingNodes);
            }
        }
    }

    private static AuthorSavedViewValidationException InvalidRequest()
        => new("saved_view_request_invalid");
}

/// <summary>Domain selector only; these values are not AEDS frame identifiers.</summary>
public enum AuthorSavedViewRequestOperation
{
    Create,
    Update,
    Rename,
    Pin,
    Reorder,
    Move,
    Default,
    Retire,
    Delete
}
