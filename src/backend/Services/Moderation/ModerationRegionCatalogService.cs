using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class ModerationRegionCatalogService(
    IWebHostEnvironment environment,
    IConfiguration configuration,
    IModerationDictionaryService dictionaryService,
    ILogger<ModerationRegionCatalogService> logger) : IModerationRegionCatalogService
{
    private readonly Lock _reloadLock = new();
    private ModerationRegionCatalogSnapshot _snapshot = EmptySnapshot();
    private string? _lastError;

    public ModerationRegionCatalogSnapshot CurrentSnapshot
    {
        get
        {
            ModerationRegionCatalogSnapshot snapshot = Volatile.Read(ref _snapshot);
            if (snapshot.Regions.Count > 0)
            {
                return snapshot;
            }

            _ = Reload();
            return Volatile.Read(ref _snapshot);
        }
    }

    public string? LastError => Volatile.Read(ref _lastError);

    public ModerationRegionCatalogSnapshot GetRuntimeSnapshot()
        => CurrentSnapshot with { LastError = LastError };

    public ModerationEffectivePolicyPreview PreviewEffectivePolicy(
        string regionCode,
        IReadOnlyList<ModerationPolicyTemplateRule>? operatorOverrides = null)
    {
        ModerationRegionCatalogSnapshot snapshot = CurrentSnapshot;
        string normalizedRegion = NormalizeCode(regionCode);
        ModerationRegionDefinition region = snapshot.Regions.FirstOrDefault(item => string.Equals(item.RegionCode, normalizedRegion, StringComparison.Ordinal))
            ?? new ModerationRegionDefinition(normalizedRegion, normalizedRegion, null, ModerationRegionGroups.Custom, null, true, false, "Ad-hoc custom region preview.");
        var warnings = new List<string>();
        var steps = new List<ModerationEffectivePolicyStep>();
        var effectiveRules = new Dictionary<string, ModerationEffectivePolicyRule>(StringComparer.Ordinal);

        ApplyTemplate(snapshot, "global-baseline", "global-baseline", "template", steps, effectiveRules, warnings);
        ApplyGroupTemplate(snapshot, region.PrimaryGroup, steps, effectiveRules, warnings);
        ApplyParentTemplates(snapshot, region, steps, effectiveRules, warnings, []);
        ApplyTemplate(snapshot, region.PolicyTemplate, "region-template", "template", steps, effectiveRules, warnings);
        ApplyRegionPolicyOverrides(region.RegionCode, steps, effectiveRules);

        if (operatorOverrides is { Count: > 0 })
        {
            ApplyRules(
                "operator-preview",
                "operator-overrides",
                "operator_override",
                operatorOverrides,
                steps,
                effectiveRules);
        }

        string checksum = BuildChecksum(string.Join('\n', effectiveRules.Values
            .OrderBy(static item => item.Category, StringComparer.Ordinal)
            .Select(static item => $"{item.Category}:{item.SubmitAction}:{item.DisplayAction}:{item.SourceId}")));
        return new ModerationEffectivePolicyPreview(
            region.RegionCode,
            region.DisplayName,
            ResolveRegionGroups(snapshot, region.RegionCode),
            steps,
            effectiveRules.Values
                .OrderBy(static item => item.Category, StringComparer.Ordinal)
                .ToArray(),
            checksum,
            warnings);
    }

    private bool Reload()
    {
        lock (_reloadLock)
        {
            try
            {
                ModerationRegionCatalogSnapshot next = BuildSnapshot();
                Volatile.Write(ref _snapshot, next);
                Volatile.Write(ref _lastError, null);
                return true;
            }
            catch (Exception ex)
            {
                Volatile.Write(ref _lastError, ex.Message);
                logger.LogWarning(ex, "moderation region catalog reload failed; keeping previous snapshot");
                return false;
            }
        }
    }

    private ModerationRegionCatalogSnapshot BuildSnapshot()
    {
        string root = ResolveCatalogRoot();
        string regionPath = Path.Combine(root, "regions.yaml");
        if (!File.Exists(regionPath))
        {
            throw new FileNotFoundException("moderation regions.yaml not found", regionPath);
        }

        string regionRaw = File.ReadAllText(regionPath);
        ModerationRegionDefinition[] regions = [.. ParseObjectList(regionRaw, "regions").Select(ParseRegion)];
        ModerationRegionGroupDefinition[] groups = [.. ParseObjectList(regionRaw, "region_groups").Select(ParseGroup)];
        string templateRoot = Path.Combine(root, "policy-templates");
        if (!Directory.Exists(templateRoot))
        {
            throw new DirectoryNotFoundException($"moderation policy template root not found: {templateRoot}");
        }

        ModerationPolicyTemplateDefinition[] templates = [.. Directory.EnumerateFiles(templateRoot, "*.yaml", SearchOption.AllDirectories)
            .OrderBy(static item => item, StringComparer.Ordinal)
            .Select(ParseTemplate)];

        ValidateSnapshot(regions, groups, templates);
        string checksum = BuildChecksum(string.Join('\n',
            regions.OrderBy(static item => item.RegionCode, StringComparer.Ordinal).Select(static item => $"{item.RegionCode}:{item.PolicyTemplate}:{item.PrimaryGroup}:{item.Enabled}"))
            + "\n"
            + string.Join('\n', groups.OrderBy(static item => item.GroupCode, StringComparer.Ordinal).Select(static item => $"{item.GroupCode}:{item.PolicyTemplate}:{string.Join(',', item.Regions)}"))
            + "\n"
            + string.Join('\n', templates.OrderBy(static item => item.TemplateId, StringComparer.Ordinal).Select(static item => $"{item.TemplateId}:{item.Checksum}")));
        string version = string.Join('+', templates.OrderBy(static item => item.TemplateId, StringComparer.Ordinal).Select(static item => $"{item.TemplateId}:{item.Version}"));
        return new ModerationRegionCatalogSnapshot(
            $"moderation-region-catalog:{checksum[..16]}",
            version,
            checksum,
            DateTime.UtcNow,
            regions.OrderBy(static item => item.RegionCode, StringComparer.Ordinal).ToArray(),
            groups.OrderBy(static item => item.GroupCode, StringComparer.Ordinal).ToArray(),
            templates.OrderBy(static item => item.TemplateId, StringComparer.Ordinal).ToArray(),
            null);
    }

    private string ResolveCatalogRoot()
    {
        string? configured = configuration["Moderation:RegionCatalogRoot"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Path.GetFullPath(configured);
        }

        string? dictionaryRoot = configuration["Moderation:DictionaryRoot"];
        if (!string.IsNullOrWhiteSpace(dictionaryRoot))
        {
            return Path.GetFullPath(dictionaryRoot);
        }

        string[] candidates =
        [
            Path.Combine(environment.ContentRootPath, "configs", "moderation"),
            Path.GetFullPath(Path.Combine(environment.ContentRootPath, "..", "..", "configs", "moderation")),
            Path.Combine(AppContext.BaseDirectory, "configs", "moderation")
        ];
        return candidates.FirstOrDefault(Directory.Exists) ?? candidates[0];
    }

    private void ApplyGroupTemplate(
        ModerationRegionCatalogSnapshot snapshot,
        string? groupCode,
        List<ModerationEffectivePolicyStep> steps,
        Dictionary<string, ModerationEffectivePolicyRule> effectiveRules,
        List<string> warnings)
    {
        string normalizedGroup = NormalizeNullableCode(groupCode) ?? string.Empty;
        if (normalizedGroup.Length == 0 || normalizedGroup == ModerationRegionGroups.Global)
        {
            return;
        }

        ModerationRegionGroupDefinition? group = snapshot.RegionGroups.FirstOrDefault(item => string.Equals(item.GroupCode, normalizedGroup, StringComparison.Ordinal));
        if (group is null)
        {
            warnings.Add($"region_group_missing:{normalizedGroup}");
            return;
        }

        ApplyTemplate(snapshot, group.PolicyTemplate, $"region-group:{group.GroupCode}", "template", steps, effectiveRules, warnings);
    }

    private void ApplyParentTemplates(
        ModerationRegionCatalogSnapshot snapshot,
        ModerationRegionDefinition region,
        List<ModerationEffectivePolicyStep> steps,
        Dictionary<string, ModerationEffectivePolicyRule> effectiveRules,
        List<string> warnings,
        HashSet<string> visited)
    {
        string? parentCode = NormalizeNullableCode(region.ParentRegion);
        if (parentCode is null)
        {
            return;
        }

        if (!visited.Add(parentCode))
        {
            warnings.Add($"region_parent_cycle:{parentCode}");
            return;
        }

        ModerationRegionDefinition? parent = snapshot.Regions.FirstOrDefault(item => string.Equals(item.RegionCode, parentCode, StringComparison.Ordinal));
        if (parent is null)
        {
            warnings.Add($"parent_region_missing:{parentCode}");
            return;
        }

        ApplyGroupTemplate(snapshot, parent.PrimaryGroup, steps, effectiveRules, warnings);
        ApplyParentTemplates(snapshot, parent, steps, effectiveRules, warnings, visited);
        ApplyTemplate(snapshot, parent.PolicyTemplate, $"parent-region:{parent.RegionCode}", "template", steps, effectiveRules, warnings);
    }

    private static void ApplyTemplate(
        ModerationRegionCatalogSnapshot snapshot,
        string? templateId,
        string step,
        string sourceType,
        List<ModerationEffectivePolicyStep> steps,
        Dictionary<string, ModerationEffectivePolicyRule> effectiveRules,
        List<string> warnings)
    {
        string normalizedTemplate = NormalizeNullableId(templateId) ?? string.Empty;
        if (normalizedTemplate.Length == 0)
        {
            return;
        }

        ModerationPolicyTemplateDefinition? template = snapshot.PolicyTemplates.FirstOrDefault(item => string.Equals(item.TemplateId, normalizedTemplate, StringComparison.Ordinal));
        if (template is null)
        {
            warnings.Add($"policy_template_missing:{normalizedTemplate}");
            return;
        }

        if (!template.Enabled)
        {
            warnings.Add($"policy_template_disabled:{normalizedTemplate}");
            return;
        }

        ApplyRules(step, template.TemplateId, sourceType, template.Rules, steps, effectiveRules);
    }

    private void ApplyRegionPolicyOverrides(
        string regionCode,
        List<ModerationEffectivePolicyStep> steps,
        Dictionary<string, ModerationEffectivePolicyRule> effectiveRules)
    {
        ModerationDictionaryRuntimeSnapshot dictionarySnapshot = dictionaryService.GetRuntimeSnapshot();
        ModerationRegionPolicyRuntimeItem? policy = dictionarySnapshot.RegionPolicies.FirstOrDefault(item => string.Equals(item.Region, regionCode, StringComparison.Ordinal));
        if (policy is null)
        {
            return;
        }

        ModerationPolicyTemplateRule[] rules = [.. policy.Rules.Select(static item => new ModerationPolicyTemplateRule(item.Category, item.SubmitAction, item.DisplayAction))];
        ApplyRules($"region-policy:{policy.Region}", policy.Region, "operator_region_policy", rules, steps, effectiveRules);
    }

    private static void ApplyRules(
        string step,
        string sourceId,
        string sourceType,
        IReadOnlyList<ModerationPolicyTemplateRule> rules,
        List<ModerationEffectivePolicyStep> steps,
        Dictionary<string, ModerationEffectivePolicyRule> effectiveRules)
    {
        if (rules.Count == 0)
        {
            return;
        }

        steps.Add(new ModerationEffectivePolicyStep(step, sourceId, sourceType, rules));
        foreach (ModerationPolicyTemplateRule rule in rules)
        {
            effectiveRules[rule.Category] = new ModerationEffectivePolicyRule(
                rule.Category,
                rule.SubmitAction,
                rule.DisplayAction,
                sourceId,
                sourceType);
        }
    }

    private static IReadOnlyList<string> ResolveRegionGroups(ModerationRegionCatalogSnapshot snapshot, string regionCode)
        => snapshot.RegionGroups
            .Where(group => group.Regions.Contains(regionCode, StringComparer.Ordinal))
            .Select(static group => group.GroupCode)
            .OrderBy(static item => item, StringComparer.Ordinal)
            .ToArray();

    private static void ValidateSnapshot(
        IReadOnlyList<ModerationRegionDefinition> regions,
        IReadOnlyList<ModerationRegionGroupDefinition> groups,
        IReadOnlyList<ModerationPolicyTemplateDefinition> templates)
    {
        RequireUnique(regions.Select(static item => item.RegionCode), "region_code");
        RequireUnique(groups.Select(static item => item.GroupCode), "group_code");
        RequireUnique(templates.Select(static item => item.TemplateId), "template_id");

        if (templates.Any(static item => string.IsNullOrWhiteSpace(item.Source)
            || string.IsNullOrWhiteSpace(item.Version)
            || string.IsNullOrWhiteSpace(item.Checksum)
            || string.IsNullOrWhiteSpace(item.ReviewedBy)))
        {
            throw new InvalidOperationException("policy templates must include source, version, checksum, reviewed_by");
        }

        if (templates.Where(static item => item.Builtin).Any(static item => !item.NotLegalAdvice))
        {
            throw new InvalidOperationException("built-in policy templates must be marked not_legal_advice");
        }

        ModerationRegionGroupDefinition greaterChina = groups.First(item => item.GroupCode == ModerationRegionGroups.GreaterChina);
        if (!string.IsNullOrWhiteSpace(greaterChina.PolicyTemplate))
        {
            throw new InvalidOperationException("GREATER_CHINA must not automatically apply CN-MAINLAND strict policy");
        }

        foreach (string regionCode in new[] { RegionCodes.HongKong, RegionCodes.Macao, RegionCodes.Taiwan })
        {
            ModerationRegionDefinition region = regions.First(item => item.RegionCode == regionCode);
            if (string.Equals(region.PolicyTemplate, "cn-mainland-strict", StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"{regionCode} must not inherit cn-mainland-strict by default");
            }
        }

        ModerationPolicyTemplateDefinition mainland = templates.First(item => item.TemplateId == "cn-mainland-strict");
        if (!string.Equals(mainland.Region, RegionCodes.MainlandChina, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("cn-mainland-strict template must be scoped to CN-MAINLAND");
        }
    }

    private static void RequireUnique(IEnumerable<string> values, string label)
    {
        string[] duplicates = [.. values
            .GroupBy(static item => item, StringComparer.Ordinal)
            .Where(static group => group.Count() > 1)
            .Select(static group => group.Key)];
        if (duplicates.Length > 0)
        {
            throw new InvalidOperationException($"{label} duplicates: {string.Join(',', duplicates)}");
        }
    }

    private static ModerationRegionDefinition ParseRegion(IReadOnlyDictionary<string, string> item)
        => new(
            NormalizeCode(Required(item, "region_code")),
            Required(item, "display_name").Trim(),
            NormalizeNullableCode(item.GetValueOrDefault("parent_region")),
            NormalizeNullableCode(item.GetValueOrDefault("primary_group")),
            NormalizeNullableId(item.GetValueOrDefault("policy_template")),
            ParseBool(item.GetValueOrDefault("enabled"), defaultValue: true),
            ParseBool(item.GetValueOrDefault("builtin"), defaultValue: false),
            NormalizeNullable(item.GetValueOrDefault("description")));

    private static ModerationRegionGroupDefinition ParseGroup(IReadOnlyDictionary<string, string> item)
        => new(
            NormalizeCode(Required(item, "group_code")),
            Required(item, "display_name").Trim(),
            NormalizeNullableId(item.GetValueOrDefault("policy_template")),
            ParseBool(item.GetValueOrDefault("builtin"), defaultValue: false),
            ParseBool(item.GetValueOrDefault("enabled"), defaultValue: true),
            ParseInlineList(item.GetValueOrDefault("regions")).Select(NormalizeCode).ToArray(),
            NormalizeNullable(item.GetValueOrDefault("description")));

    private static ModerationPolicyTemplateDefinition ParseTemplate(string path)
    {
        string raw = File.ReadAllText(path);
        Dictionary<string, string> scalars = ParseTopLevelScalars(raw);
        ModerationPolicyTemplateRule[] rules = [.. ParseObjectList(raw, "rules").Select(static item => new ModerationPolicyTemplateRule(
            Required(item, "category"),
            Required(item, "submit_action"),
            Required(item, "display_action")))];
        string checksum = BuildChecksum(raw);
        return new ModerationPolicyTemplateDefinition(
            NormalizeNullableId(Required(scalars, "template_id")) ?? throw new InvalidOperationException($"template_id invalid in {path}"),
            Required(scalars, "version"),
            Required(scalars, "scope"),
            NormalizeNullableCode(scalars.GetValueOrDefault("region")),
            NormalizeNullableCode(scalars.GetValueOrDefault("region_group")),
            Required(scalars, "source"),
            Required(scalars, "reviewed_by"),
            ParseNullableDateTime(scalars.GetValueOrDefault("reviewed_at_utc"), path),
            ParseBool(scalars.GetValueOrDefault("is_builtin"), defaultValue: false),
            ParseBool(scalars.GetValueOrDefault("is_enabled"), defaultValue: true),
            ParseBool(scalars.GetValueOrDefault("not_legal_advice"), defaultValue: false),
            NormalizeNullable(scalars.GetValueOrDefault("description")) ?? string.Empty,
            checksum,
            rules);
    }

    private static Dictionary<string, string> ParseTopLevelScalars(string raw)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string line in raw.Replace("\r\n", "\n").Split('\n'))
        {
            if (line.Length == 0 || char.IsWhiteSpace(line[0]))
            {
                continue;
            }

            string trimmed = StripComment(line).Trim();
            if (trimmed.Length == 0 || trimmed.EndsWith(":", StringComparison.Ordinal))
            {
                continue;
            }

            int separator = trimmed.IndexOf(':');
            if (separator <= 0)
            {
                continue;
            }

            values[trimmed[..separator].Trim()] = Unquote(trimmed[(separator + 1)..].Trim());
        }

        return values;
    }

    private static List<Dictionary<string, string>> ParseObjectList(string raw, string blockName)
    {
        string[] lines = raw.Replace("\r\n", "\n").Split('\n');
        int start = FindBlockStart(lines, blockName);
        var items = new List<Dictionary<string, string>>();
        if (start < 0)
        {
            return items;
        }

        Dictionary<string, string>? current = null;
        for (int i = start + 1; i < lines.Length; i++)
        {
            string line = lines[i];
            if (line.Length > 0 && !char.IsWhiteSpace(line[0]))
            {
                break;
            }

            string trimmed = StripComment(line).Trim();
            if (trimmed.Length == 0)
            {
                continue;
            }

            if (trimmed.StartsWith("- ", StringComparison.Ordinal))
            {
                current = new Dictionary<string, string>(StringComparer.Ordinal);
                items.Add(current);
                AddKeyValue(current, trimmed[2..]);
                continue;
            }

            if (current is not null)
            {
                AddKeyValue(current, trimmed);
            }
        }

        return items;
    }

    private static int FindBlockStart(string[] lines, string blockName)
    {
        for (int i = 0; i < lines.Length; i++)
        {
            if (string.Equals(StripComment(lines[i]).Trim(), $"{blockName}:", StringComparison.Ordinal))
            {
                return i;
            }
        }

        return -1;
    }

    private static void AddKeyValue(Dictionary<string, string> target, string raw)
    {
        int separator = raw.IndexOf(':');
        if (separator <= 0)
        {
            return;
        }

        target[raw[..separator].Trim()] = Unquote(raw[(separator + 1)..].Trim());
    }

    private static IReadOnlyList<string> ParseInlineList(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return [];
        }

        string trimmed = value.Trim();
        if (trimmed.StartsWith("[", StringComparison.Ordinal) && trimmed.EndsWith("]", StringComparison.Ordinal))
        {
            trimmed = trimmed[1..^1];
        }

        return trimmed.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(Unquote)
            .Where(static item => item.Length > 0)
            .ToArray();
    }

    private static DateTime? ParseNullableDateTime(string? value, string path)
    {
        string? normalized = NormalizeNullable(value);
        if (normalized is null)
        {
            return null;
        }

        return DateTime.TryParse(normalized, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out DateTime parsed)
            ? parsed.ToUniversalTime()
            : throw new InvalidOperationException($"invalid reviewed_at_utc in {path}");
    }

    private static bool ParseBool(string? value, bool defaultValue)
        => string.IsNullOrWhiteSpace(value)
            ? defaultValue
            : bool.TryParse(value.Trim(), out bool parsed) ? parsed : defaultValue;

    private static string Required(IReadOnlyDictionary<string, string> values, string key)
        => values.TryGetValue(key, out string? value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidOperationException($"missing required key {key}");

    private static string StripComment(string value)
    {
        int index = value.IndexOf('#');
        return index < 0 ? value : value[..index];
    }

    private static string Unquote(string value)
    {
        string trimmed = value.Trim();
        return trimmed.Length >= 2 && ((trimmed[0] == '"' && trimmed[^1] == '"') || (trimmed[0] == '\'' && trimmed[^1] == '\''))
            ? trimmed[1..^1]
            : trimmed;
    }

    private static string NormalizeCode(string? value)
    {
        string normalized = (value ?? string.Empty).Trim().ToUpperInvariant();
        if (normalized.Length is 0 or > 64 || normalized.Any(static c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
        {
            throw new InvalidOperationException($"invalid moderation region/group code: {value}");
        }

        return normalized;
    }

    private static string? NormalizeNullableCode(string? value)
    {
        string normalized = NormalizeNullable(value) ?? string.Empty;
        return normalized.Length == 0 ? null : NormalizeCode(normalized);
    }

    private static string? NormalizeNullableId(string? value)
    {
        string normalized = NormalizeNullable(value) ?? string.Empty;
        if (normalized.Length == 0)
        {
            return null;
        }

        if (normalized.Length > 128 || normalized.Any(static c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.')))
        {
            throw new InvalidOperationException($"invalid moderation template id: {value}");
        }

        return normalized;
    }

    private static string? NormalizeNullable(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length == 0 ? null : normalized;
    }

    private static string BuildChecksum(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static ModerationRegionCatalogSnapshot EmptySnapshot()
        => new(
            "moderation-region-catalog-empty",
            "empty",
            string.Empty,
            DateTime.UnixEpoch,
            [],
            [],
            [],
            null);
}
