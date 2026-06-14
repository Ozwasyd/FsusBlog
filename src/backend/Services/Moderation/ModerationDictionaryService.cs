using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class ModerationDictionaryService(
    IWebHostEnvironment environment,
    IConfiguration configuration,
    ILogger<ModerationDictionaryService> logger,
    AuditLogChannel? auditLogChannel = null,
    IModerationRuntimeStateService? runtimeState = null) : IModerationDictionaryService
{
    private static readonly string[] MainlandMandatoryDictionaryIds =
    [
        "cn-mainland.political-sensitive",
        "cn-mainland.porn-strict",
        "cn-mainland.public-order",
        "cn-mainland.national-security"
    ];

    private readonly Lock _reloadLock = new();
    private ModerationDictionarySnapshot _snapshot = ModerationDictionarySnapshot.Empty;
    private ModerationDictionarySnapshot? _previousSnapshot;
    private string? _lastError;

    public ModerationDictionarySnapshot CurrentSnapshot
    {
        get
        {
            ModerationDictionarySnapshot snapshot = Volatile.Read(ref _snapshot);
            if (!ReferenceEquals(snapshot, ModerationDictionarySnapshot.Empty))
            {
                return snapshot;
            }

            _ = Reload();
            return Volatile.Read(ref _snapshot);
        }
    }
    public string? LastError => Volatile.Read(ref _lastError);

    public Result Reload()
    {
        lock (_reloadLock)
        {
            Result<ModerationDictionarySnapshot> result = BuildSnapshot();
            if (result.IsFailure)
            {
                Volatile.Write(ref _lastError, result.Error.Message);
                WriteAudit(
                    "dictionary_reload_failed",
                    AuditOutcomeCatalog.Failure,
                    AuditSeverityCatalog.Error,
                    "moderation_dictionary_snapshot",
                    "current",
                    new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["message"] = result.Error.Message,
                        ["previousSnapshotId"] = _snapshot.SnapshotId,
                        ["previousChecksum"] = _snapshot.Checksum
                    });
                WriteAudit(
                    "region_policy_reload_failed",
                    AuditOutcomeCatalog.Failure,
                    AuditSeverityCatalog.Error,
                    "moderation_region_policy",
                    "current",
                    new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["message"] = result.Error.Message,
                        ["previousSnapshotId"] = _snapshot.SnapshotId,
                        ["previousChecksum"] = _snapshot.Checksum
                    });
                logger.LogWarning("moderation dictionary reload failed; keeping previous snapshot: {Message}", result.Error.Message);
                return Result.Failure(result.Error);
            }

            ModerationDictionarySnapshot next = result.Value!;
            ModerationDictionarySnapshot previous = Volatile.Read(ref _snapshot);
            if (!ReferenceEquals(previous, ModerationDictionarySnapshot.Empty))
            {
                _previousSnapshot = previous;
            }

            Volatile.Write(ref _snapshot, next);
            Volatile.Write(ref _lastError, null);
            WriteLoadedAudit(next);
            if (!ReferenceEquals(previous, ModerationDictionarySnapshot.Empty)
                && !string.Equals(previous.Checksum, next.Checksum, StringComparison.Ordinal))
            {
                WriteAudit(
                    "dictionary_checksum_changed",
                    AuditOutcomeCatalog.Success,
                    AuditSeverityCatalog.Warning,
                    "moderation_dictionary_snapshot",
                    next.SnapshotId,
                    new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["previousChecksum"] = previous.Checksum,
                        ["nextChecksum"] = next.Checksum,
                        ["previousSnapshotId"] = previous.SnapshotId,
                        ["nextSnapshotId"] = next.SnapshotId
                    });
            }
            logger.LogInformation("moderation dictionary snapshot loaded | SnapshotId: {SnapshotId} | Dictionaries: {DictionaryCount} | Policies: {PolicyCount}",
                next.SnapshotId,
                next.Dictionaries.Count,
                next.RegionPolicies.Count);
            return Result.Success();
        }
    }

    public Result Rollback()
    {
        lock (_reloadLock)
        {
            if (_previousSnapshot is null)
            {
                return Result.Failure(ErrorCode.Conflict, "moderation_dictionary_rollback_snapshot_missing");
            }

            ModerationDictionarySnapshot current = Volatile.Read(ref _snapshot);
            ModerationDictionarySnapshot rollback = _previousSnapshot;
            _previousSnapshot = ReferenceEquals(current, ModerationDictionarySnapshot.Empty) ? null : current;
            Volatile.Write(ref _snapshot, rollback);
            Volatile.Write(ref _lastError, null);
            WriteAudit(
                "dictionary_rollback",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Warning,
                "moderation_dictionary_snapshot",
                rollback.SnapshotId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["snapshotId"] = rollback.SnapshotId,
                    ["checksum"] = rollback.Checksum,
                    ["previousSnapshotId"] = current.SnapshotId,
                    ["previousChecksum"] = current.Checksum
                });
            return Result.Success();
        }
    }

    public IReadOnlyList<ModerationDictionaryMatch> Match(string content, string region)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return [];
        }

        ModerationDictionarySnapshot snapshot = CurrentSnapshot;
        string normalizedRegion = NormalizeRegion(region);
        string[] dictionaryIds = ResolveRuntimeDictionaryIds(snapshot, normalizedRegion);
        if (dictionaryIds.Length == 0 && normalizedRegion != RegionCodes.Global)
        {
            dictionaryIds = ResolveRuntimeDictionaryIds(snapshot, RegionCodes.Global);
        }

        var matches = new List<ModerationDictionaryMatch>();
        foreach (string dictionaryId in dictionaryIds)
        {
            if (!snapshot.Dictionaries.TryGetValue(dictionaryId, out ModerationDictionaryDefinition? dictionary))
            {
                continue;
            }

            foreach (ModerationDictionaryTerm term in dictionary.Terms)
            {
                string? evidence = MatchTerm(content, term);
                if (evidence is null)
                {
                    continue;
                }

                matches.Add(new ModerationDictionaryMatch(
                    dictionary.DictionaryId,
                    term.Category,
                    term.Severity,
                    term.Reason,
                    term.EvidencePolicy,
                    term.EvidencePolicy == ModerationEvidencePolicies.Redact ? null : evidence,
                    normalizedRegion));
            }
        }

        return matches
            .GroupBy(static item => $"{item.DictionaryId}:{item.Category}:{item.Reason}", StringComparer.Ordinal)
            .Select(static group => group.First())
            .OrderBy(static item => item.DictionaryId, StringComparer.Ordinal)
            .ThenBy(static item => item.Category, StringComparer.Ordinal)
            .ToArray();
    }

    public ModerationPolicyAction ResolveAction(string region, string category)
    {
        ModerationDictionarySnapshot snapshot = CurrentSnapshot;
        string normalizedRegion = NormalizeRegion(region);
        string effectiveRegion = runtimeState?.IsRegionPolicyDisabled(normalizedRegion) == true
            ? RegionCodes.Global
            : normalizedRegion;
        ModerationRegionPolicyRule? rule = ResolvePolicyRules(snapshot, effectiveRegion)
            .LastOrDefault(item => string.Equals(item.Category, category, StringComparison.Ordinal));
        return rule is null
            ? new ModerationPolicyAction(ModerationDictionaryActions.Allow, ModerationDictionaryActions.Allow)
            : new ModerationPolicyAction(rule.SubmitAction, rule.DisplayAction);
    }

    public IReadOnlyList<ModerationDictionaryTerm> GetGlobalHardFilterTerms()
    {
        ModerationDictionarySnapshot snapshot = CurrentSnapshot;
        return snapshot.Dictionaries.Values
            .Where(static item => string.Equals(item.Scope, "global", StringComparison.OrdinalIgnoreCase))
            .SelectMany(static item => item.Terms)
            .ToArray();
    }

    public ModerationDictionaryRuntimeSnapshot GetRuntimeSnapshot()
    {
        ModerationDictionarySnapshot snapshot = CurrentSnapshot;
        return new ModerationDictionaryRuntimeSnapshot(
            snapshot.SnapshotId,
            snapshot.Version,
            snapshot.Checksum,
            snapshot.CreatedAtUtc,
            snapshot.Dictionaries.Values
                .OrderBy(static item => item.DictionaryId, StringComparer.Ordinal)
                .Select(static item => new ModerationDictionaryRuntimeItem(
                    item.DictionaryId,
                    item.Version,
                    item.Scope,
                    item.Region,
                    item.Category,
                    item.Source,
                    item.ReviewedBy,
                    item.UpdatedAtUtc,
                    item.Checksum,
                    ResolveEvidencePolicy(item.Terms),
                    item.Terms.Count))
                .ToArray(),
            snapshot.RegionPolicies.Values
                .OrderBy(static item => item.Region, StringComparer.Ordinal)
                .Select(static item => new ModerationRegionPolicyRuntimeItem(
                    item.Region,
                    item.Version,
                    item.Inherits,
                    item.DictionaryIds,
                    item.Checksum,
                    item.Rules.Count,
                    item.Rules))
                .ToArray(),
            LastError);
    }

    private static string ResolveEvidencePolicy(IReadOnlyList<ModerationDictionaryTerm> terms)
    {
        if (terms.Any(static item => item.EvidencePolicy == ModerationEvidencePolicies.Redact))
        {
            return ModerationEvidencePolicies.Redact;
        }

        if (terms.Any(static item => item.EvidencePolicy == ModerationEvidencePolicies.ShowCategoryOnly))
        {
            return ModerationEvidencePolicies.ShowCategoryOnly;
        }

        return ModerationEvidencePolicies.ShowFull;
    }

    private Result<ModerationDictionarySnapshot> BuildSnapshot()
    {
        string root = ResolveDictionaryRoot();
        if (!Directory.Exists(root))
        {
            return Result<ModerationDictionarySnapshot>.Failure(
                ErrorCode.InfraFailure,
                $"moderation dictionary root not found: {root}");
        }

        try
        {
            var dictionaries = new Dictionary<string, ModerationDictionaryDefinition>(StringComparer.Ordinal);
            foreach (string file in Directory.EnumerateFiles(Path.Combine(root, "dictionaries"), "*.yaml", SearchOption.AllDirectories))
            {
                ModerationDictionaryDefinition dictionary = ParseDictionary(file);
                dictionaries.Add(dictionary.DictionaryId, dictionary);
            }

            var policies = new Dictionary<string, ModerationRegionPolicyDefinition>(StringComparer.Ordinal);
            string policyRoot = Path.Combine(root, "region-policies");
            foreach (string file in Directory.EnumerateFiles(policyRoot, "*.yaml", SearchOption.TopDirectoryOnly))
            {
                ModerationRegionPolicyDefinition policy = ParseRegionPolicy(file);
                policies.Add(policy.Region, policy);
            }

            ValidateSnapshot(dictionaries, policies);
            string checksum = ComputeSnapshotChecksum(dictionaries.Values, policies.Values);
            string version = string.Join('+', policies.Values.OrderBy(static item => item.Region, StringComparer.Ordinal).Select(static item => item.Version));
            return Result<ModerationDictionarySnapshot>.Success(new ModerationDictionarySnapshot(
                $"moderation-dictionaries:{checksum[..Math.Min(16, checksum.Length)]}",
                version,
                dictionaries,
                policies,
                checksum,
                DateTime.UtcNow));
        }
        catch (Exception ex)
        {
            return Result<ModerationDictionarySnapshot>.Failure(ErrorDetail.Create(
                ErrorCode.InfraFailure,
                "moderation dictionary snapshot build failed",
                $"{root}: {ex.Message}"));
        }
    }

    private string ResolveDictionaryRoot()
    {
        string? configured = configuration["Moderation:DictionaryRoot"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Path.GetFullPath(configured);
        }

        string[] candidates =
        [
            Path.Combine(environment.ContentRootPath, "configs", "moderation"),
            Path.GetFullPath(Path.Combine(environment.ContentRootPath, "..", "..", "configs", "moderation")),
            Path.Combine(AppContext.BaseDirectory, "configs", "moderation")
        ];

        return candidates.FirstOrDefault(Directory.Exists) ?? candidates[0];
    }

    private void WriteLoadedAudit(ModerationDictionarySnapshot snapshot)
    {
        foreach (ModerationDictionaryDefinition dictionary in snapshot.Dictionaries.Values)
        {
            WriteAudit(
                "dictionary_loaded",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "moderation_dictionary",
                dictionary.DictionaryId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["dictionary_id"] = dictionary.DictionaryId,
                    ["version"] = dictionary.Version,
                    ["checksum"] = dictionary.Checksum,
                    ["term_count"] = dictionary.Terms.Count,
                    ["region"] = dictionary.Region,
                    ["scope"] = dictionary.Scope,
                    ["category"] = dictionary.Category,
                    ["source"] = dictionary.Source,
                    ["reviewed_by"] = dictionary.ReviewedBy,
                    ["updated_at"] = dictionary.UpdatedAtUtc
                });
        }

        foreach (ModerationRegionPolicyDefinition policy in snapshot.RegionPolicies.Values)
        {
            WriteAudit(
                "region_policy_loaded",
                AuditOutcomeCatalog.Success,
                AuditSeverityCatalog.Info,
                "moderation_region_policy",
                policy.Region,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["region"] = policy.Region,
                    ["policy_version"] = policy.Version,
                    ["checksum"] = policy.Checksum,
                    ["dictionary_count"] = policy.DictionaryIds.Count,
                    ["rule_count"] = policy.Rules.Count,
                    ["inherits"] = policy.Inherits
                });
        }
    }

    private void WriteAudit(
        string eventInfo,
        string outcome,
        string severity,
        string targetType,
        string targetId,
        IReadOnlyDictionary<string, object?> context)
    {
        if (auditLogChannel is null)
        {
            return;
        }

        string contextJson = JsonSerializer.Serialize(context);
        auditLogChannel.TryWrite(new AuditRecord(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Audit,
            DateTime.UtcNow,
            eventInfo,
            Encoding.UTF8.GetBytes(contextJson),
            Action: eventInfo,
            Outcome: outcome,
            Severity: severity,
            ActorType: AuditActorTypeCatalog.System,
            TargetType: targetType,
            TargetId: targetId,
            IsHighValue: true,
            ReasonCode: eventInfo,
            ContextJson: contextJson));
    }

    private static ModerationDictionaryDefinition ParseDictionary(string path)
    {
        string raw = File.ReadAllText(path);
        string checksum = ComputeSha256(raw);
        Dictionary<string, string> scalars = ParseTopLevelScalars(raw);
        List<Dictionary<string, string>> termMaps = ParseObjectList(raw, "terms");
        string category = Required(scalars, "category", path);
        string severityDefault = Required(scalars, "severity_default", path);
        var terms = termMaps.Select(term => new ModerationDictionaryTerm(
                Required(term, "value", path),
                ParseInlineList(term.GetValueOrDefault("aliases")),
                term.GetValueOrDefault("category_override") ?? category,
                term.GetValueOrDefault("severity") ?? severityDefault,
                Required(term, "reason", path),
                term.GetValueOrDefault("evidence_policy") ?? ModerationEvidencePolicies.ShowCategoryOnly))
            .ToArray();

        return new ModerationDictionaryDefinition(
            Required(scalars, "dictionary_id", path),
            Required(scalars, "version", path),
            Required(scalars, "scope", path),
            scalars.GetValueOrDefault("region"),
            category,
            scalars.GetValueOrDefault("match_mode") ?? "normalized",
            scalars.GetValueOrDefault("normalization") ?? "default",
            severityDefault,
            Required(scalars, "source", path),
            Required(scalars, "reviewed_by", path),
            ParseDateTime(Required(scalars, "updated_at", path), path),
            checksum,
            terms);
    }

    private static ModerationRegionPolicyDefinition ParseRegionPolicy(string path)
    {
        string raw = File.ReadAllText(path);
        Dictionary<string, string> scalars = ParseTopLevelScalars(raw);
        return new ModerationRegionPolicyDefinition(
            NormalizeRegion(Required(scalars, "region", path)),
            Required(scalars, "version", path),
            ParseBlockList(raw, "inherits").Select(NormalizeRegion).ToArray(),
            ParseBlockList(raw, "dictionaries").ToArray(),
            ParseObjectList(raw, "rules")
                .Select(rule => new ModerationRegionPolicyRule(
                    Required(rule, "category", path),
                    Required(rule, "submit_action", path),
                    Required(rule, "display_action", path)))
                .ToArray(),
            ComputeSha256(raw),
            DateTime.UtcNow);
    }

    private static void ValidateSnapshot(
        IReadOnlyDictionary<string, ModerationDictionaryDefinition> dictionaries,
        IReadOnlyDictionary<string, ModerationRegionPolicyDefinition> policies)
    {
        foreach (ModerationDictionaryDefinition dictionary in dictionaries.Values)
        {
            if (string.Equals(dictionary.Scope, "regional", StringComparison.OrdinalIgnoreCase)
                && string.IsNullOrWhiteSpace(dictionary.Region))
            {
                throw new InvalidOperationException($"regional dictionary missing region: {dictionary.DictionaryId}");
            }
        }

        foreach (ModerationRegionPolicyDefinition policy in policies.Values)
        {
            foreach (string dictionaryId in policy.DictionaryIds)
            {
                if (!dictionaries.ContainsKey(dictionaryId))
                {
                    throw new InvalidOperationException($"policy {policy.Region} references missing dictionary {dictionaryId}");
                }
            }
        }

        if (!policies.TryGetValue(RegionCodes.MainlandChina, out ModerationRegionPolicyDefinition? mainlandPolicy))
        {
            throw new InvalidOperationException("CN-MAINLAND moderation policy is required");
        }

        string[] mainlandDictionaryIds = ResolveDictionaryIds(dictionaries, policies, mainlandPolicy.Region);
        foreach (string required in MainlandMandatoryDictionaryIds)
        {
            if (!mainlandDictionaryIds.Contains(required, StringComparer.Ordinal))
            {
                throw new InvalidOperationException($"CN-MAINLAND policy must include mandatory dictionary {required}");
            }
        }
    }

    private static string[] ResolveDictionaryIds(ModerationDictionarySnapshot snapshot, string region)
        => ResolveDictionaryIds(snapshot.Dictionaries, snapshot.RegionPolicies, region);

    private string[] ResolveRuntimeDictionaryIds(ModerationDictionarySnapshot snapshot, string region)
    {
        string effectiveRegion = runtimeState?.IsRegionPolicyDisabled(region) == true
            ? RegionCodes.Global
            : region;
        return ResolveDictionaryIds(snapshot, effectiveRegion)
            .Where(id => runtimeState?.IsDictionaryEnabled(id) != false)
            .ToArray();
    }

    private static string[] ResolveDictionaryIds(
        IReadOnlyDictionary<string, ModerationDictionaryDefinition> dictionaries,
        IReadOnlyDictionary<string, ModerationRegionPolicyDefinition> policies,
        string region)
    {
        return ResolvePolicyChain(policies, region)
            .SelectMany(static policy => policy.DictionaryIds)
            .Where(dictionaries.ContainsKey)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static IReadOnlyList<ModerationRegionPolicyRule> ResolvePolicyRules(ModerationDictionarySnapshot snapshot, string region)
        => ResolvePolicyChain(snapshot.RegionPolicies, region)
            .SelectMany(static policy => policy.Rules)
            .ToArray();

    private static IReadOnlyList<ModerationRegionPolicyDefinition> ResolvePolicyChain(
        IReadOnlyDictionary<string, ModerationRegionPolicyDefinition> policies,
        string region)
    {
        if (!policies.TryGetValue(region, out ModerationRegionPolicyDefinition? policy))
        {
            return policies.TryGetValue(RegionCodes.Global, out ModerationRegionPolicyDefinition? global)
                ? [global]
                : [];
        }

        var chain = new List<ModerationRegionPolicyDefinition>();
        foreach (string parent in policy.Inherits)
        {
            chain.AddRange(ResolvePolicyChain(policies, parent));
        }

        chain.Add(policy);
        return chain
            .GroupBy(static item => item.Region, StringComparer.Ordinal)
            .Select(static item => item.Last())
            .ToArray();
    }

    private static string? MatchTerm(string content, ModerationDictionaryTerm term)
    {
        if (content.Contains(term.Value, StringComparison.OrdinalIgnoreCase))
        {
            return term.Value;
        }

        foreach (string alias in term.Aliases)
        {
            if (content.Contains(alias, StringComparison.OrdinalIgnoreCase))
            {
                return alias;
            }
        }

        return null;
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
            if (trimmed.Length == 0 || trimmed.EndsWith(':'))
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

    private static IReadOnlyList<string> ParseBlockList(string raw, string blockName)
    {
        string[] lines = raw.Replace("\r\n", "\n").Split('\n');
        int start = FindBlockStart(lines, blockName);
        if (start < 0)
        {
            return [];
        }

        var values = new List<string>();
        for (int i = start + 1; i < lines.Length; i++)
        {
            string line = lines[i];
            if (line.Length > 0 && !char.IsWhiteSpace(line[0]))
            {
                break;
            }

            string trimmed = StripComment(line).Trim();
            if (!trimmed.StartsWith("- ", StringComparison.Ordinal))
            {
                continue;
            }

            values.Add(Unquote(trimmed[2..].Trim()));
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

    private static string StripComment(string value)
    {
        int index = value.IndexOf('#');
        return index < 0 ? value : value[..index];
    }

    private static IReadOnlyList<string> ParseInlineList(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return [];
        }

        string trimmed = value.Trim();
        if (trimmed.StartsWith('[') && trimmed.EndsWith(']'))
        {
            trimmed = trimmed[1..^1];
        }

        return trimmed.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(Unquote)
            .Where(static item => item.Length > 0)
            .ToArray();
    }

    private static string Required(IReadOnlyDictionary<string, string> values, string key, string path)
        => values.TryGetValue(key, out string? value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidOperationException($"missing required key {key} in {path}");

    private static DateTime ParseDateTime(string value, string path)
        => DateTime.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out DateTime parsed)
            ? parsed.ToUniversalTime()
            : throw new InvalidOperationException($"invalid updated_at in {path}");

    private static string Unquote(string value)
    {
        string trimmed = value.Trim();
        return trimmed.Length >= 2 && ((trimmed[0] == '"' && trimmed[^1] == '"') || (trimmed[0] == '\'' && trimmed[^1] == '\''))
            ? trimmed[1..^1]
            : trimmed;
    }

    private static string ComputeSnapshotChecksum(
        IEnumerable<ModerationDictionaryDefinition> dictionaries,
        IEnumerable<ModerationRegionPolicyDefinition> policies)
    {
        string canonical = string.Join('\n', dictionaries.OrderBy(static item => item.DictionaryId, StringComparer.Ordinal).Select(static item => $"{item.DictionaryId}:{item.Checksum}"))
            + "\n"
            + string.Join('\n', policies.OrderBy(static item => item.Region, StringComparer.Ordinal).Select(static item => $"{item.Region}:{item.Checksum}"));
        return ComputeSha256(canonical);
    }

    private static string ComputeSha256(string value)
    {
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }

    private static string NormalizeRegion(string? region)
        => (region ?? string.Empty).Trim().ToUpperInvariant() switch
        {
            "GLOBAL" => RegionCodes.Global,
            "CN" or "CN-MAINLAND" or "MAINLAND" => RegionCodes.MainlandChina,
            "HK" or "CN-HK" => RegionCodes.HongKong,
            "MO" or "CN-MO" => RegionCodes.Macao,
            "TW" or "CN-TW" => RegionCodes.Taiwan,
            "SG" => RegionCodes.Singapore,
            "US" => RegionCodes.UnitedStates,
            "DE" or "EU-DE" => RegionCodes.Germany,
            "EU" => RegionCodes.EuropeanUnion,
            "JP" => RegionCodes.Japan,
            "KR" => RegionCodes.Korea,
            "UNKNOWN" or "" => RegionCodes.Unknown,
            var value => value
        };
}
