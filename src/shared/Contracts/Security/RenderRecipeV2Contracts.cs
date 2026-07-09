using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Shared.Contracts.Security;

public enum RenderRecipeV2TaskKind : byte
{
    Unknown = 0,
    Character = 1,
    Localization = 2,
    MicroInteraction = 3
}

public sealed record class RenderRecipeV2(
    string Schema,
    RenderRecipeV2TaskKind TaskKind,
    IReadOnlyList<RenderRecipeV2Layer> Layers,
    IReadOnlyDictionary<string, string> PresentationHints);

public sealed record class RenderRecipeV2Layer(
    string LayerId,
    double Opacity,
    IReadOnlyList<RenderStrokeSegmentV2> StrokeSegments,
    IReadOnlyList<RenderNoiseFieldV2> NoiseFields,
    IReadOnlyList<RenderWarpFieldV2> WarpFields,
    IReadOnlyList<RenderOccluderV2> Occluders);

public sealed record class RenderStrokeSegmentV2(
    string SegmentId,
    string Brush,
    string ColorRgba,
    double Width,
    IReadOnlyList<RenderPointV2> Points);

public sealed record class RenderNoiseFieldV2(
    string FieldId,
    string SeedHex,
    double Intensity,
    double Scale);

public sealed record class RenderWarpFieldV2(
    string FieldId,
    string SeedHex,
    double Amplitude,
    double Frequency);

public sealed record class RenderOccluderV2(
    string OccluderId,
    string Shape,
    double X,
    double Y,
    double Width,
    double Height,
    double RotationDegrees,
    string ColorRgba);

public readonly record struct RenderPointV2(double X, double Y);

public sealed record class RenderRecipeV2IssuePayload(
    RenderRecipeV2 Recipe,
    string RecipeHashHex);

public sealed record RenderRecipeV2ValidationResult(bool IsValid, string ErrorCode, string RecipeHashHex)
{
    public static RenderRecipeV2ValidationResult Valid(string recipeHashHex)
        => new(true, string.Empty, recipeHashHex);

    public static RenderRecipeV2ValidationResult Invalid(string errorCode)
        => new(false, errorCode, string.Empty);
}

public static class RenderRecipeV2Contracts
{
    public const string Schema = "fsus.challenge.render-recipe@v2";

    private const int MaxLayers = 16;
    private const int MaxPrimitivesPerLayer = 64;
    private const int MaxPointsPerStroke = 128;

    private static readonly JsonSerializerOptions JsonOptions = CreateJsonOptions();

    private static readonly HashSet<string> AllowedPresentationHints = new(StringComparer.Ordinal)
    {
        "canvasWidth",
        "canvasHeight",
        "colorScheme",
        "contrast",
        "inputMode",
        "motionProfile",
        "palette",
        "reducedMotionVariant"
    };

    private static readonly HashSet<string> AllowedBrushes = new(StringComparer.Ordinal)
    {
        "round",
        "square",
        "calligraphic",
        "texture"
    };

    private static readonly HashSet<string> AllowedOccluderShapes = new(StringComparer.Ordinal)
    {
        "rect",
        "ellipse",
        "polygon"
    };

    public static RenderRecipeV2ValidationResult ValidateRecipe(
        RenderRecipeV2? recipe,
        string? expectedRecipeHashHex = null)
    {
        if (recipe is null)
        {
            return RenderRecipeV2ValidationResult.Invalid("recipe_missing");
        }

        string recipeJson = JsonSerializer.Serialize(recipe, JsonOptions);
        return ValidateRecipeJson(recipeJson, expectedRecipeHashHex);
    }

    public static RenderRecipeV2ValidationResult ValidateIssuePayload(RenderRecipeV2IssuePayload? payload)
    {
        if (payload is null)
        {
            return RenderRecipeV2ValidationResult.Invalid("payload_missing");
        }

        if (!IsSha256Hex(payload.RecipeHashHex))
        {
            return RenderRecipeV2ValidationResult.Invalid("recipe_hash_invalid");
        }

        return ValidateRecipe(payload.Recipe, payload.RecipeHashHex);
    }

    public static RenderRecipeV2ValidationResult ValidateRecipeJson(
        string? recipeJson,
        string? expectedRecipeHashHex = null)
    {
        if (string.IsNullOrWhiteSpace(recipeJson))
        {
            return RenderRecipeV2ValidationResult.Invalid("recipe_json_missing");
        }

        using JsonDocument document = ParseJson(recipeJson, out bool parsed);
        if (!parsed)
        {
            return RenderRecipeV2ValidationResult.Invalid("recipe_json_invalid");
        }

        return ValidateRecipeElement(document.RootElement, expectedRecipeHashHex);
    }

    public static RenderRecipeV2ValidationResult ValidateIssuePayloadJson(string? payloadJson)
    {
        if (string.IsNullOrWhiteSpace(payloadJson))
        {
            return RenderRecipeV2ValidationResult.Invalid("payload_json_missing");
        }

        using JsonDocument document = ParseJson(payloadJson, out bool parsed);
        if (!parsed)
        {
            return RenderRecipeV2ValidationResult.Invalid("payload_json_invalid");
        }

        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return RenderRecipeV2ValidationResult.Invalid("payload_object_invalid");
        }

        if (!root.TryGetProperty("recipe", out JsonElement recipe) ||
            !root.TryGetProperty("recipeHashHex", out JsonElement hashElement) ||
            hashElement.ValueKind != JsonValueKind.String)
        {
            return RenderRecipeV2ValidationResult.Invalid("payload_shape_invalid");
        }

        string? expectedHash = hashElement.GetString();
        if (!IsSha256Hex(expectedHash))
        {
            return RenderRecipeV2ValidationResult.Invalid("recipe_hash_invalid");
        }

        return ValidateRecipeElement(recipe, expectedHash);
    }

    public static string ComputeRecipeHashHex(RenderRecipeV2 recipe)
    {
        ArgumentNullException.ThrowIfNull(recipe);

        string recipeJson = JsonSerializer.Serialize(recipe, JsonOptions);
        return ComputeRecipeHashHex(recipeJson);
    }

    public static string ComputeRecipeHashHex(string recipeJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(recipeJson);

        using JsonDocument document = JsonDocument.Parse(recipeJson);
        return ComputeRecipeHashHex(document.RootElement);
    }

    private static RenderRecipeV2ValidationResult ValidateRecipeElement(
        JsonElement recipe,
        string? expectedRecipeHashHex)
    {
        if (recipe.ValueKind != JsonValueKind.Object)
        {
            return RenderRecipeV2ValidationResult.Invalid("recipe_object_invalid");
        }

        if (ContainsForbiddenSemanticField(recipe))
        {
            return RenderRecipeV2ValidationResult.Invalid("semantic_field_forbidden");
        }

        if (!TryGetString(recipe, "schema", out string schema) ||
            !string.Equals(schema, Schema, StringComparison.Ordinal))
        {
            return RenderRecipeV2ValidationResult.Invalid("schema_invalid");
        }

        if (!TryGetString(recipe, "taskKind", out string taskKind) ||
            !IsSupportedTaskKind(taskKind))
        {
            return RenderRecipeV2ValidationResult.Invalid("task_kind_invalid");
        }

        if (!recipe.TryGetProperty("layers", out JsonElement layers) ||
            layers.ValueKind != JsonValueKind.Array ||
            layers.GetArrayLength() is <= 0 or > MaxLayers)
        {
            return RenderRecipeV2ValidationResult.Invalid("layers_invalid");
        }

        bool hasDrawingPrimitive = false;
        foreach (JsonElement layer in layers.EnumerateArray())
        {
            string? error = ValidateLayer(layer, ref hasDrawingPrimitive);
            if (error is not null)
            {
                return RenderRecipeV2ValidationResult.Invalid(error);
            }
        }

        if (!hasDrawingPrimitive)
        {
            return RenderRecipeV2ValidationResult.Invalid("primitive_missing");
        }

        if (!recipe.TryGetProperty("presentationHints", out JsonElement hints) ||
            !ValidatePresentationHints(hints))
        {
            return RenderRecipeV2ValidationResult.Invalid("presentation_hints_invalid");
        }

        string recipeHashHex = ComputeRecipeHashHex(recipe);
        if (expectedRecipeHashHex is not null &&
            (!IsSha256Hex(expectedRecipeHashHex) ||
             !FixedTimeEqualsHex(recipeHashHex, expectedRecipeHashHex)))
        {
            return RenderRecipeV2ValidationResult.Invalid("recipe_hash_mismatch");
        }

        return RenderRecipeV2ValidationResult.Valid(recipeHashHex);
    }

    private static string? ValidateLayer(JsonElement layer, ref bool hasDrawingPrimitive)
    {
        if (layer.ValueKind != JsonValueKind.Object)
        {
            return "layer_invalid";
        }

        if (!TryGetString(layer, "layerId", out string layerId) ||
            !IsSafeToken(layerId) ||
            !TryGetDouble(layer, "opacity", out double opacity) ||
            !IsInRange(opacity, 0, 1))
        {
            return "layer_invalid";
        }

        if (!layer.TryGetProperty("strokeSegments", out JsonElement strokes) ||
            !layer.TryGetProperty("noiseFields", out JsonElement noiseFields) ||
            !layer.TryGetProperty("warpFields", out JsonElement warpFields) ||
            !layer.TryGetProperty("occluders", out JsonElement occluders))
        {
            return "layer_primitives_missing";
        }

        string? error = ValidateStrokeSegments(strokes, ref hasDrawingPrimitive)
            ?? ValidateNoiseFields(noiseFields, ref hasDrawingPrimitive)
            ?? ValidateWarpFields(warpFields, ref hasDrawingPrimitive)
            ?? ValidateOccluders(occluders, ref hasDrawingPrimitive);

        return error;
    }

    private static string? ValidateStrokeSegments(JsonElement strokes, ref bool hasDrawingPrimitive)
    {
        if (strokes.ValueKind != JsonValueKind.Array ||
            strokes.GetArrayLength() > MaxPrimitivesPerLayer)
        {
            return "stroke_segments_invalid";
        }

        foreach (JsonElement stroke in strokes.EnumerateArray())
        {
            if (stroke.ValueKind != JsonValueKind.Object ||
                !TryGetString(stroke, "segmentId", out string segmentId) ||
                !IsSafeToken(segmentId) ||
                !TryGetString(stroke, "brush", out string brush) ||
                !AllowedBrushes.Contains(brush) ||
                !TryGetString(stroke, "colorRgba", out string colorRgba) ||
                !IsColorRgba(colorRgba) ||
                !TryGetDouble(stroke, "width", out double width) ||
                !IsInRange(width, double.Epsilon, 1) ||
                !stroke.TryGetProperty("points", out JsonElement points) ||
                points.ValueKind != JsonValueKind.Array ||
                points.GetArrayLength() is < 2 or > MaxPointsPerStroke)
            {
                return "stroke_segment_invalid";
            }

            foreach (JsonElement point in points.EnumerateArray())
            {
                if (!TryGetDouble(point, "x", out double x) ||
                    !TryGetDouble(point, "y", out double y) ||
                    !IsInRange(x, 0, 1) ||
                    !IsInRange(y, 0, 1))
                {
                    return "stroke_point_invalid";
                }
            }

            hasDrawingPrimitive = true;
        }

        return null;
    }

    private static string? ValidateNoiseFields(JsonElement fields, ref bool hasDrawingPrimitive)
    {
        if (fields.ValueKind != JsonValueKind.Array ||
            fields.GetArrayLength() > MaxPrimitivesPerLayer)
        {
            return "noise_fields_invalid";
        }

        foreach (JsonElement field in fields.EnumerateArray())
        {
            if (field.ValueKind != JsonValueKind.Object ||
                !TryGetString(field, "fieldId", out string fieldId) ||
                !IsSafeToken(fieldId) ||
                !TryGetString(field, "seedHex", out string seedHex) ||
                !IsHex(seedHex, 64) ||
                !TryGetDouble(field, "intensity", out double intensity) ||
                !IsInRange(intensity, 0, 1) ||
                !TryGetDouble(field, "scale", out double scale) ||
                !IsInRange(scale, double.Epsilon, 10))
            {
                return "noise_field_invalid";
            }

            hasDrawingPrimitive = true;
        }

        return null;
    }

    private static string? ValidateWarpFields(JsonElement fields, ref bool hasDrawingPrimitive)
    {
        if (fields.ValueKind != JsonValueKind.Array ||
            fields.GetArrayLength() > MaxPrimitivesPerLayer)
        {
            return "warp_fields_invalid";
        }

        foreach (JsonElement field in fields.EnumerateArray())
        {
            if (field.ValueKind != JsonValueKind.Object ||
                !TryGetString(field, "fieldId", out string fieldId) ||
                !IsSafeToken(fieldId) ||
                !TryGetString(field, "seedHex", out string seedHex) ||
                !IsHex(seedHex, 64) ||
                !TryGetDouble(field, "amplitude", out double amplitude) ||
                !IsInRange(amplitude, 0, 1) ||
                !TryGetDouble(field, "frequency", out double frequency) ||
                !IsInRange(frequency, double.Epsilon, 100))
            {
                return "warp_field_invalid";
            }

            hasDrawingPrimitive = true;
        }

        return null;
    }

    private static string? ValidateOccluders(JsonElement occluders, ref bool hasDrawingPrimitive)
    {
        if (occluders.ValueKind != JsonValueKind.Array ||
            occluders.GetArrayLength() > MaxPrimitivesPerLayer)
        {
            return "occluders_invalid";
        }

        foreach (JsonElement occluder in occluders.EnumerateArray())
        {
            if (occluder.ValueKind != JsonValueKind.Object ||
                !TryGetString(occluder, "occluderId", out string occluderId) ||
                !IsSafeToken(occluderId) ||
                !TryGetString(occluder, "shape", out string shape) ||
                !AllowedOccluderShapes.Contains(shape) ||
                !TryGetString(occluder, "colorRgba", out string colorRgba) ||
                !IsColorRgba(colorRgba) ||
                !TryGetDouble(occluder, "x", out double x) ||
                !TryGetDouble(occluder, "y", out double y) ||
                !TryGetDouble(occluder, "width", out double width) ||
                !TryGetDouble(occluder, "height", out double height) ||
                !TryGetDouble(occluder, "rotationDegrees", out double rotation) ||
                !IsInRange(x, 0, 1) ||
                !IsInRange(y, 0, 1) ||
                !IsInRange(width, double.Epsilon, 1) ||
                !IsInRange(height, double.Epsilon, 1) ||
                !double.IsFinite(rotation))
            {
                return "occluder_invalid";
            }

            hasDrawingPrimitive = true;
        }

        return null;
    }

    private static bool ValidatePresentationHints(JsonElement hints)
    {
        if (hints.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (JsonProperty property in hints.EnumerateObject())
        {
            if (!AllowedPresentationHints.Contains(property.Name) ||
                property.Value.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(property.Value.GetString()) ||
                property.Value.GetString()!.Length > 64)
            {
                return false;
            }
        }

        return true;
    }

    private static string ComputeRecipeHashHex(JsonElement recipe)
    {
        var canonical = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(canonical))
        {
            WriteCanonicalJson(writer, recipe);
        }

        return Convert.ToHexStringLower(SHA256.HashData(canonical.WrittenSpan));
    }

    private static void WriteCanonicalJson(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (JsonProperty property in element.EnumerateObject().OrderBy(static property => property.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonicalJson(writer, property.Value);
                }

                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement item in element.EnumerateArray())
                {
                    WriteCanonicalJson(writer, item);
                }

                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(element.GetString());
                break;
            case JsonValueKind.Number:
                writer.WriteRawValue(element.GetRawText(), skipInputValidation: true);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new InvalidOperationException("Unsupported JSON token in render recipe.");
        }
    }

    private static bool ContainsForbiddenSemanticField(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (JsonProperty property in element.EnumerateObject())
                {
                    if (IsForbiddenSemanticFieldName(property.Name) ||
                        ContainsForbiddenSemanticField(property.Value))
                    {
                        return true;
                    }
                }

                return false;
            case JsonValueKind.Array:
                foreach (JsonElement item in element.EnumerateArray())
                {
                    if (ContainsForbiddenSemanticField(item))
                    {
                        return true;
                    }
                }

                return false;
            default:
                return false;
        }
    }

    private static bool IsForbiddenSemanticFieldName(string fieldName)
    {
        string normalized = NormalizeFieldName(fieldName);
        return normalized.Contains("answer", StringComparison.Ordinal) ||
               normalized.Contains("glyph", StringComparison.Ordinal) ||
               normalized.Contains("charid", StringComparison.Ordinal) ||
               normalized.Contains("expected", StringComparison.Ordinal) ||
               normalized.Contains("target", StringComparison.Ordinal) ||
               normalized.Contains("semantic", StringComparison.Ordinal) ||
               normalized is "text" or "plaintext" or "character";
    }

    private static string NormalizeFieldName(string value)
    {
        Span<char> buffer = stackalloc char[value.Length];
        int written = 0;
        foreach (char ch in value)
        {
            if (IsAsciiAlphanumeric(ch))
            {
                buffer[written++] = char.ToLowerInvariant(ch);
            }
        }

        return new string(buffer[..written]);
    }

    private static bool IsAsciiAlphanumeric(char value)
        => value is >= '0' and <= '9'
            or >= 'A' and <= 'Z'
            or >= 'a' and <= 'z';

    private static bool IsSupportedTaskKind(string value)
        => string.Equals(value, "character", StringComparison.Ordinal) ||
           string.Equals(value, "localization", StringComparison.Ordinal) ||
           string.Equals(value, "microInteraction", StringComparison.Ordinal);

    private static bool TryGetString(JsonElement element, string propertyName, out string value)
    {
        value = string.Empty;
        if (!element.TryGetProperty(propertyName, out JsonElement property) ||
            property.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = property.GetString() ?? string.Empty;
        return !string.IsNullOrWhiteSpace(value);
    }

    private static bool TryGetDouble(JsonElement element, string propertyName, out double value)
    {
        value = default;
        return element.TryGetProperty(propertyName, out JsonElement property) &&
               property.ValueKind == JsonValueKind.Number &&
               property.TryGetDouble(out value) &&
               double.IsFinite(value);
    }

    private static bool IsInRange(double value, double minInclusive, double maxInclusive)
        => double.IsFinite(value) && value >= minInclusive && value <= maxInclusive;

    private static bool IsSafeToken(string value)
    {
        if (value.Length is <= 0 or > 64)
        {
            return false;
        }

        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (!((ch >= 'a' && ch <= 'z') ||
                  (ch >= '0' && ch <= '9') ||
                  ch is '-' or '_' or ':' or '.'))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsColorRgba(string value)
    {
        if (value.Length != 9 || value[0] != '#')
        {
            return false;
        }

        return IsHex(value.AsSpan(1), 8);
    }

    private static bool IsSha256Hex(string? value)
        => value is not null && IsHex(value.AsSpan(), 64);

    private static bool IsHex(string value, int expectedLength)
        => IsHex(value.AsSpan(), expectedLength);

    private static bool IsHex(ReadOnlySpan<char> value, int expectedLength)
    {
        if (value.Length != expectedLength)
        {
            return false;
        }

        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (!((ch >= '0' && ch <= '9') ||
                  (ch >= 'a' && ch <= 'f') ||
                  (ch >= 'A' && ch <= 'F')))
            {
                return false;
            }
        }

        return true;
    }

    private static bool FixedTimeEqualsHex(string left, string right)
        => left.Length == right.Length &&
           CryptographicOperations.FixedTimeEquals(
               Encoding.ASCII.GetBytes(left),
               Encoding.ASCII.GetBytes(right));

    private static JsonDocument ParseJson(string json, out bool parsed)
    {
        try
        {
            JsonDocument document = JsonDocument.Parse(json);
            parsed = true;
            return document;
        }
        catch (JsonException)
        {
            parsed = false;
            return JsonDocument.Parse("{}");
        }
    }

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        return options;
    }
}
