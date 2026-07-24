using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Infrastructure.Fonts;

public static class FontLoadingPlanRoutes
{
    public const string Shell = "shell";
    public const string Article = "article";
    public const string Admin = "admin";
}

public static class FontLoadingPlanTriggers
{
    public const string Critical = "critical";
    public const string Idle = "idle";
    public const string Route = "route";
    public const string Locale = "locale";
    public const string Content = "content";
}

public sealed record FontLoadingPlanRequest(
    string Scope,
    string Route,
    string? Locale = null,
    string? Script = null,
    bool HasCode = false,
    bool HasEmoji = false,
    FontThemeTypographyPreferences? Theme = null,
    int MaxPreloads = FontLoadingPlanner.DefaultMaxPreloads);

public sealed record FontLoadingPlanFace(
    string FontId,
    string FaceId,
    string Category,
    int Weight,
    string Style,
    string AssetUrl,
    string ContentHash,
    long SizeBytes,
    string FontDisplay,
    string? UnicodeRange,
    string Trigger);

public sealed record FontLoadingPlanEvidence(
    string Schema,
    string Status,
    string PlanHash,
    long ConfigVersion,
    int CriticalFaceCount,
    int DeferredFaceCount,
    int PreloadCount,
    int DuplicateFaceCount,
    bool UsedSafeFallback);

public sealed record FontLoadingPlan(
    string Schema,
    long ConfigVersion,
    string Scope,
    string Route,
    string Locale,
    string Script,
    IReadOnlyList<FontLoadingPlanFace> Critical,
    IReadOnlyList<FontLoadingPlanFace> Deferred,
    IReadOnlyDictionary<string, IReadOnlyList<string>> RouteFaces,
    IReadOnlyDictionary<string, IReadOnlyList<string>> LocaleFaces,
    IReadOnlyList<string> Preloads,
    IReadOnlyDictionary<string, string> FallbackStacks,
    bool UsedSafeFallback,
    FontLoadingPlanEvidence Evidence);

public sealed class FontLoadingPlanException(string code, string message) : InvalidOperationException(message)
{
    public string Code { get; } = code;
}

public interface IFontLoadingPlanner
{
    Task<FontLoadingPlan> CreateAsync(
        FontLoadingPlanRequest request,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Compiles enabled registry faces and scoped activation into a deterministic,
/// content-addressed loading plan. It never fetches or probes a font asset.
/// </summary>
public sealed class FontLoadingPlanner(
    IFontRegistry registry,
    IFontStackRuntime stackRuntime) : IFontLoadingPlanner
{
    public const int DefaultMaxPreloads = 4;
    public const int AbsoluteMaxPreloads = 8;
    public const string Schema = "fsusblog.font.loading-plan.v1";
    public const string EvidenceSchema = "fsusblog.font.loading-evidence.v1";

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    public async Task<FontLoadingPlan> CreateAsync(
        FontLoadingPlanRequest request,
        CancellationToken cancellationToken = default)
    {
        ValidateRequest(request);
        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken).ConfigureAwait(false);
        FontTokenResolution stacks = await stackRuntime.ResolveAsync(
            new FontStackResolutionRequest(
                request.Scope,
                request.Locale,
                request.Script,
                request.Theme),
            cancellationToken).ConfigureAwait(false);

        ActivationResolution activation = ResolveActivation(snapshot, request.Scope);
        var usedSafeFallback = activation.UsedSafeFallback || stacks.UsedSafeFallback;
        IReadOnlyDictionary<string, SelectedFont> roles = ResolveRoles(
            snapshot,
            activation.Activation,
            ref usedSafeFallback);
        string locale = NormalizeLocale(request.Locale);
        string script = ResolveScript(locale, request.Script);

        IReadOnlyList<PlannedFace> allFaces = CollectFaces(roles);
        IReadOnlySet<string> selectedRoles = ResolveSelectedRoles(request.Route, script, request.HasCode, request.HasEmoji);
        var critical = new List<FontLoadingPlanFace>();
        var deferred = new List<FontLoadingPlanFace>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        int duplicateCount = 0;

        foreach (PlannedFace candidate in allFaces.OrderByDescending(
            static item => item.Face.Critical
                && (item.Role == FontRole.Ui || item.Role == FontRole.Cjk)))
        {
            bool coreCritical = candidate.Face.Critical
                && (candidate.Role == FontRole.Ui || candidate.Role == FontRole.Cjk);
            bool selected = coreCritical || selectedRoles.Contains(candidate.Role);
            if (!selected)
            {
                continue;
            }

            string identity = $"{candidate.Face.ContentHash}:{candidate.Face.Weight}:{candidate.Face.Style}";
            if (!seen.Add(identity))
            {
                duplicateCount++;
                if (coreCritical)
                {
                    int deferredIndex = deferred.FindIndex(
                        item => string.Equals(item.ContentHash, candidate.Face.ContentHash, StringComparison.Ordinal)
                            && item.Weight == candidate.Face.Weight
                            && string.Equals(item.Style, candidate.Face.Style, StringComparison.Ordinal));
                    if (deferredIndex >= 0)
                    {
                        deferred.RemoveAt(deferredIndex);
                        critical.Add(ToPlanFace(candidate, FontLoadingPlanTriggers.Critical));
                    }
                }
                continue;
            }

            string trigger = ResolveTrigger(candidate.Role, coreCritical, request.Route, script, request.HasCode, request.HasEmoji);
            FontLoadingPlanFace face = ToPlanFace(candidate, trigger);
            if (coreCritical)
            {
                critical.Add(face);
            }
            else
            {
                deferred.Add(face);
            }
        }

        critical.Sort(CompareFaces);
        deferred.Sort(CompareFaces);
        IReadOnlyList<string> preloads = ResolvePreloads(critical, roles, request.MaxPreloads);
        IReadOnlyDictionary<string, IReadOnlyList<string>> routeFaces = BuildRouteFaces(allFaces);
        IReadOnlyDictionary<string, IReadOnlyList<string>> localeFaces = BuildLocaleFaces(allFaces);
        long configVersion = activation.Activation?.ConfigVersion ?? 0;
        PlanHashInput hashInput = new(
            Schema,
            configVersion,
            request.Scope,
            request.Route,
            locale,
            script,
            critical,
            deferred,
            routeFaces,
            localeFaces,
            preloads,
            stacks.FamilyStacks,
            usedSafeFallback);
        string planHash = Convert.ToHexStringLower(
            SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(hashInput, s_jsonOptions)));
        var evidence = new FontLoadingPlanEvidence(
            EvidenceSchema,
            "ok",
            planHash,
            configVersion,
            critical.Count,
            deferred.Count,
            preloads.Count,
            duplicateCount,
            usedSafeFallback);

        return new FontLoadingPlan(
            Schema,
            configVersion,
            request.Scope,
            request.Route,
            locale,
            script,
            critical,
            deferred,
            routeFaces,
            localeFaces,
            preloads,
            stacks.FamilyStacks,
            usedSafeFallback,
            evidence);
    }

    public static string SerializeEvidence(FontLoadingPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        return JsonSerializer.Serialize(plan.Evidence, s_jsonOptions);
    }

    private static void ValidateRequest(FontLoadingPlanRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Scope);
        if (request.Route is not (FontLoadingPlanRoutes.Shell or FontLoadingPlanRoutes.Article or FontLoadingPlanRoutes.Admin))
        {
            throw new FontLoadingPlanException("font_loading_route_invalid", "Font loading route is not supported.");
        }

        if (request.MaxPreloads is < 0 or > AbsoluteMaxPreloads)
        {
            throw new FontLoadingPlanException(
                "font_preload_budget_invalid",
                $"Font preload budget must be between 0 and {AbsoluteMaxPreloads}.");
        }
    }

    private static ActivationResolution ResolveActivation(FontRegistrySnapshot snapshot, string scope)
    {
        FontActivation? activation = snapshot.Activations.FirstOrDefault(
            item => string.Equals(item.Scope, scope, StringComparison.Ordinal));
        bool usedSafeFallback = false;
        if (activation is null && !string.Equals(scope, FontActivation.DefaultScope, StringComparison.Ordinal))
        {
            activation = snapshot.Activations.FirstOrDefault(
                item => string.Equals(item.Scope, FontActivation.DefaultScope, StringComparison.Ordinal));
            usedSafeFallback = true;
        }

        return new ActivationResolution(activation, usedSafeFallback);
    }

    private static IReadOnlyDictionary<string, SelectedFont> ResolveRoles(
        FontRegistrySnapshot snapshot,
        FontActivation? activation,
        ref bool usedSafeFallback)
    {
        var roles = new Dictionary<string, SelectedFont>(StringComparer.Ordinal)
        {
            [FontRole.Ui] = ResolveRole(snapshot, activation?.UiFontId, FontCategories.UiSans, FontBuiltIns.UiSans, ref usedSafeFallback),
            [FontRole.Prose] = ResolveRole(snapshot, activation?.ProseFontId, FontCategories.ProseSans, FontBuiltIns.ProseSans, ref usedSafeFallback),
            [FontRole.Code] = ResolveRole(snapshot, activation?.CodeFontId, FontCategories.CodeMono, FontBuiltIns.CodeMono, ref usedSafeFallback),
            [FontRole.Cjk] = ResolveRole(snapshot, activation?.CjkFontId, FontCategories.CjkSans, FontBuiltIns.CjkSans, ref usedSafeFallback),
            [FontRole.Emoji] = ResolveRole(snapshot, activation?.EmojiFontId, FontCategories.Emoji, FontBuiltIns.Emoji, ref usedSafeFallback)
        };
        return roles;
    }

    private static SelectedFont ResolveRole(
        FontRegistrySnapshot snapshot,
        string? id,
        string category,
        FontRegistryEntry fallback,
        ref bool usedSafeFallback)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            return new SelectedFont(fallback, null);
        }

        FontRegistryEntry? selected = snapshot.Fonts.FirstOrDefault(
            item => string.Equals(item.Id, id, StringComparison.Ordinal));
        if (selected is null
            || !selected.Enabled
            || !string.Equals(selected.Category, category, StringComparison.Ordinal))
        {
            usedSafeFallback = true;
            return new SelectedFont(fallback, null);
        }

        if (selected.BuiltIn)
        {
            return new SelectedFont(selected, null);
        }

        try
        {
            FontManifest? manifest = JsonSerializer.Deserialize<FontManifest>(
                selected.ManifestJson,
                s_jsonOptions);
            if (manifest is null
                || !string.Equals(manifest.Id, selected.Id, StringComparison.Ordinal)
                || !string.Equals(manifest.Category, selected.Category, StringComparison.Ordinal))
            {
                usedSafeFallback = true;
                return new SelectedFont(fallback, null);
            }

            return new SelectedFont(selected, manifest);
        }
        catch (JsonException)
        {
            usedSafeFallback = true;
            return new SelectedFont(fallback, null);
        }
    }

    private static IReadOnlyList<PlannedFace> CollectFaces(IReadOnlyDictionary<string, SelectedFont> roles)
        =>
        [
            .. roles
                .OrderBy(static item => item.Key, StringComparer.Ordinal)
                .SelectMany(item => item.Value.Entry.Faces.Select(face => new PlannedFace(item.Key, item.Value, face)))
                .OrderBy(static item => item.Font.Entry.Id, StringComparer.Ordinal)
                .ThenBy(static item => item.Face.Weight)
                .ThenBy(static item => item.Face.Style, StringComparer.Ordinal)
                .ThenBy(static item => item.Face.ContentHash, StringComparer.Ordinal)
        ];

    private static IReadOnlySet<string> ResolveSelectedRoles(
        string route,
        string script,
        bool hasCode,
        bool hasEmoji)
    {
        var roles = new HashSet<string>(StringComparer.Ordinal)
        {
            FontRole.Ui,
            FontRole.Cjk
        };
        if (route == FontLoadingPlanRoutes.Article)
        {
            roles.Add(FontRole.Prose);
        }
        else if (route == FontLoadingPlanRoutes.Admin)
        {
            roles.Add(FontRole.Code);
        }

        if (script is "Hans" or "Hant" or "Jpan")
        {
            roles.Add(FontRole.Cjk);
        }

        if (hasCode)
        {
            roles.Add(FontRole.Code);
        }

        if (hasEmoji)
        {
            roles.Add(FontRole.Emoji);
        }

        return roles;
    }

    private static string ResolveTrigger(
        string role,
        bool critical,
        string route,
        string script,
        bool hasCode,
        bool hasEmoji)
    {
        if (critical)
        {
            return FontLoadingPlanTriggers.Critical;
        }

        if ((role == FontRole.Code && hasCode) || (role == FontRole.Emoji && hasEmoji))
        {
            return FontLoadingPlanTriggers.Content;
        }

        if (role == FontRole.Cjk && script is "Hans" or "Hant" or "Jpan")
        {
            return FontLoadingPlanTriggers.Locale;
        }

        if ((route == FontLoadingPlanRoutes.Article && role == FontRole.Prose)
            || (route == FontLoadingPlanRoutes.Admin && role == FontRole.Code))
        {
            return FontLoadingPlanTriggers.Route;
        }

        return FontLoadingPlanTriggers.Idle;
    }

    private static FontLoadingPlanFace ToPlanFace(PlannedFace candidate, string trigger)
    {
        string faceId = $"{candidate.Font.Entry.Id}:{candidate.Face.Weight}:{candidate.Face.Style}";
        return new FontLoadingPlanFace(
            candidate.Font.Entry.Id,
            faceId,
            candidate.Font.Entry.Category,
            candidate.Face.Weight,
            candidate.Face.Style,
            $"/font-assets/{candidate.Face.ContentHash}.woff2",
            candidate.Face.ContentHash,
            candidate.Face.SizeBytes,
            candidate.Face.FontDisplay,
            candidate.Face.UnicodeRange,
            trigger);
    }

    private static IReadOnlyList<string> ResolvePreloads(
        IReadOnlyList<FontLoadingPlanFace> critical,
        IReadOnlyDictionary<string, SelectedFont> roles,
        int maxPreloads)
    {
        var preload = new List<string>();
        foreach (FontLoadingPlanFace face in critical)
        {
            SelectedFont selected = roles.Values.First(item => item.Entry.Id == face.FontId);
            bool declared = selected.Manifest?.Loading.Preload.Contains(
                face.Weight.ToString(System.Globalization.CultureInfo.InvariantCulture),
                StringComparer.Ordinal) ?? false;
            if (declared)
            {
                preload.Add(face.AssetUrl);
            }
        }

        preload.Sort(StringComparer.Ordinal);
        if (preload.Count > maxPreloads)
        {
            throw new FontLoadingPlanException(
                "font_preload_budget_exceeded",
                $"Font loading plan declares {preload.Count} preloads, exceeding budget {maxPreloads}.");
        }

        return preload;
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> BuildRouteFaces(
        IReadOnlyList<PlannedFace> faces)
        => new SortedDictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            [FontLoadingPlanRoutes.Admin] = FaceIdsForRoles(faces, FontRole.Ui, FontRole.Code),
            [FontLoadingPlanRoutes.Article] = FaceIdsForRoles(faces, FontRole.Prose, FontRole.Cjk),
            [FontLoadingPlanRoutes.Shell] = FaceIdsForRoles(faces, FontRole.Ui, FontRole.Cjk)
        };

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> BuildLocaleFaces(
        IReadOnlyList<PlannedFace> faces)
    {
        IReadOnlyList<string> cjk = FaceIdsForRoles(faces, FontRole.Cjk);
        return new SortedDictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            ["ja-JP"] = cjk,
            ["zh-CN"] = cjk,
            ["zh-TW"] = cjk
        };
    }

    private static IReadOnlyList<string> FaceIdsForRoles(
        IReadOnlyList<PlannedFace> faces,
        params string[] roles)
        =>
        [
            .. faces
                .Where(item => roles.Contains(item.Role, StringComparer.Ordinal))
                .Select(item => $"{item.Font.Entry.Id}:{item.Face.Weight}:{item.Face.Style}")
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
        ];

    private static int CompareFaces(FontLoadingPlanFace left, FontLoadingPlanFace right)
    {
        int font = string.Compare(left.FontId, right.FontId, StringComparison.Ordinal);
        if (font != 0)
        {
            return font;
        }

        int weight = left.Weight.CompareTo(right.Weight);
        return weight != 0
            ? weight
            : string.Compare(left.Style, right.Style, StringComparison.Ordinal);
    }

    private static string NormalizeLocale(string? locale)
        => string.IsNullOrWhiteSpace(locale) ? "und" : locale.Trim();

    private static string ResolveScript(string locale, string? explicitScript)
    {
        if (!string.IsNullOrWhiteSpace(explicitScript))
        {
            return explicitScript.Trim() switch
            {
                "Hans" => "Hans",
                "Hant" => "Hant",
                "Jpan" => "Jpan",
                _ => "Latn"
            };
        }

        if (locale.StartsWith("ja", StringComparison.OrdinalIgnoreCase))
        {
            return "Jpan";
        }

        if (locale.StartsWith("zh-TW", StringComparison.OrdinalIgnoreCase)
            || locale.StartsWith("zh-HK", StringComparison.OrdinalIgnoreCase)
            || locale.StartsWith("zh-MO", StringComparison.OrdinalIgnoreCase))
        {
            return "Hant";
        }

        return locale.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? "Hans" : "Latn";
    }

    private sealed record ActivationResolution(FontActivation? Activation, bool UsedSafeFallback);

    private sealed record SelectedFont(FontRegistryEntry Entry, FontManifest? Manifest);

    private sealed record PlannedFace(string Role, SelectedFont Font, FontRegistryFace Face);

    private sealed record PlanHashInput(
        string Schema,
        long ConfigVersion,
        string Scope,
        string Route,
        string Locale,
        string Script,
        IReadOnlyList<FontLoadingPlanFace> Critical,
        IReadOnlyList<FontLoadingPlanFace> Deferred,
        IReadOnlyDictionary<string, IReadOnlyList<string>> RouteFaces,
        IReadOnlyDictionary<string, IReadOnlyList<string>> LocaleFaces,
        IReadOnlyList<string> Preloads,
        IReadOnlyDictionary<string, string> FallbackStacks,
        bool UsedSafeFallback);

    private static class FontRole
    {
        public const string Ui = "ui";
        public const string Prose = "prose";
        public const string Code = "code";
        public const string Cjk = "cjk";
        public const string Emoji = "emoji";
    }
}
