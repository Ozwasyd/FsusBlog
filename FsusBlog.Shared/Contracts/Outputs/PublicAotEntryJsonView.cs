using System.Text.Json;

namespace FsusBlog.Shared.Contracts.Outputs;

internal sealed class PublicAotEntryJsonView : IDisposable
{
    private readonly JsonDocument _bootstrapDocument;
    private readonly JsonDocument _hydrationDocument;
    private readonly JsonDocument? _islandsDocument;

    private PublicAotEntryJsonView(JsonDocument bootstrapDocument, JsonDocument hydrationDocument, JsonDocument? islandsDocument)
    {
        _bootstrapDocument = bootstrapDocument;
        _hydrationDocument = hydrationDocument;
        _islandsDocument = islandsDocument;
    }

    public JsonElement Bootstrap => _bootstrapDocument.RootElement;

    public JsonElement Hydration => _hydrationDocument.RootElement;

    public bool HasIslands => _islandsDocument is not null;

    public JsonElement Islands => _islandsDocument?.RootElement ?? default;

    public static bool TryCreate(PublicAotShellEntryContract entry, out PublicAotEntryJsonView? view, out string error)
    {
        view = null;

        if (!TryParse(entry.BootstrapJson!, "AOT bootstrap 不是合法 JSON", out JsonDocument bootstrapDocument, out error))
        {
            return false;
        }

        if (!TryParse(entry.HydrationPropsJson!, "AOT hydration props 不是合法 JSON", out JsonDocument hydrationDocument, out error))
        {
            bootstrapDocument.Dispose();
            return false;
        }

        JsonDocument? islandsDocument = null;
        if (!string.IsNullOrWhiteSpace(entry.IslandsJson) &&
            !TryParse(entry.IslandsJson!, "AOT islands 不是合法 JSON", out islandsDocument, out error))
        {
            bootstrapDocument.Dispose();
            hydrationDocument.Dispose();
            return false;
        }

        view = new PublicAotEntryJsonView(bootstrapDocument, hydrationDocument, islandsDocument);
        error = string.Empty;
        return true;
    }

    public void Dispose()
    {
        _bootstrapDocument.Dispose();
        _hydrationDocument.Dispose();
        _islandsDocument?.Dispose();
    }

    private static bool TryParse(string json, string errorMessage, out JsonDocument document, out string error)
    {
        try
        {
            document = JsonDocument.Parse(json);
            error = string.Empty;
            return true;
        }
        catch (JsonException)
        {
            document = null!;
            error = errorMessage;
            return false;
        }
    }
}
