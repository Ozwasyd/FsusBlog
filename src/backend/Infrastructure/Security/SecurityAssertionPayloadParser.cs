using System.Text.Json;
using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Server.Infrastructure.Security;

internal static class SecurityAssertionPayloadParser
{
    internal const int MaxAssertionJsonChars = 64 * 1024;
    internal const int MaxAssertionJsonDepth = 32;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = MaxAssertionJsonDepth
    };

    internal static bool TryParse(string? raw, out PasskeyLoginCompleteCoreModel assertion)
    {
        assertion = new PasskeyLoginCompleteCoreModel();
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > MaxAssertionJsonChars)
        {
            return false;
        }

        try
        {
            PasskeyLoginCompleteCoreModel? parsed = JsonSerializer.Deserialize<PasskeyLoginCompleteCoreModel>(raw, JsonOptions);
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.ChallengeToken) || string.IsNullOrWhiteSpace(parsed.Id))
            {
                return false;
            }

            assertion = parsed;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}

