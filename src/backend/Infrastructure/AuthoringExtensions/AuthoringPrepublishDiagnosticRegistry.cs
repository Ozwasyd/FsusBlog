using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// The diagnostic category join over the existing extension registry. Host policies and the complete current
/// core result set are mandatory inputs. This pure contract does not activate packages or execute plugins.
/// </summary>
public sealed partial class AuthoringPrepublishDiagnosticRegistry
{
    public const int SchemaVersion = 1;
    public const int MaximumDiagnostics = 1000;
    public const int MaximumJsonBytes = 1_048_576;

    private static readonly JsonSerializerOptions s_json = new()
    {
        MaxDepth = 16,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    private readonly ImmutableDictionary<string, Entry> _entries;
    private readonly ImmutableHashSet<string> _reservedIds;

    public AuthoringPrepublishDiagnosticRegistry(
        AuthoringExtensionRegistrySnapshot extensions,
        ImmutableArray<AuthoringPrepublishDiagnosticContribution> contributions,
        ImmutableArray<AuthoringDiagnosticHostPolicy> policies,
        ImmutableArray<AuthoringDiagnosticCoreResult> coreResults)
    {
        ArgumentNullException.ThrowIfNull(extensions);
        AuthoringExtensionRegistrySnapshot verified = AuthoringExtensionContractValidator.CreateRegistry(
            extensions.Contracts, extensions.CoreAuthorities);
        Require(extensions.RegistryVersion == verified.RegistryVersion &&
            extensions.RegistryIdentity == verified.RegistryIdentity, "Extension registry identity drifted.");
        Require(!contributions.IsDefault && contributions.Length <= MaximumDiagnostics &&
            !policies.IsDefault && policies.Length == contributions.Length &&
            !coreResults.IsDefault && coreResults.Length <= MaximumDiagnostics,
            "Diagnostic, host policy or core observation roster is missing or unbounded.");

        var reserved = ImmutableHashSet.CreateBuilder<string>(StringComparer.Ordinal);
        reserved.UnionWith(verified.CoreAuthorities.CommandIds);
        reserved.UnionWith(verified.CoreAuthorities.RouteIds);
        reserved.UnionWith(verified.CoreAuthorities.PropertyIds);
        reserved.UnionWith(verified.CoreAuthorities.SavedViewOperatorIds);
        reserved.UnionWith(verified.CoreAuthorities.SecurityPolicyIds);
        var coreIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringDiagnosticCoreResult core in coreResults)
        {
            Require(core is not null, "Core observation is null.");
            RequireReference(core.CheckId);
            RequireDigest(core.ResultSha256);
            Require(Enum.IsDefined(core.Severity) && coreIds.Add(core.CheckId),
                "Core observation severity is unknown or its identity is duplicated.");
            reserved.Add(core.CheckId);
        }

        _reservedIds = reserved.ToImmutable();
        CoreResults = [.. coreResults.OrderBy(static result => result.CheckId, StringComparer.Ordinal)];
        CoreResultsSha256 = Digest(CoreResults);
        var policyMap = new Dictionary<string, AuthoringDiagnosticHostPolicy>(StringComparer.Ordinal);
        foreach (AuthoringDiagnosticHostPolicy policy in policies)
        {
            Require(policy is not null, "Host diagnostic policy is null.");
            RequireIdentifier(policy.DiagnosticId);
            Require(policyMap.TryAdd(policy.DiagnosticId, policy), "Host policy is duplicated.");
        }

        var builder = ImmutableDictionary.CreateBuilder<string, Entry>(StringComparer.Ordinal);
        var contributionIds = new HashSet<string>(StringComparer.Ordinal);
        var manifestIds = verified.Contracts.SelectMany(static contract =>
            contract.Manifest.Contributions.Select(static declaration => declaration.Id).Append(contract.Manifest.Id))
            .ToImmutableHashSet(StringComparer.Ordinal);
        foreach (AuthoringPrepublishDiagnosticContribution contribution in contributions)
        {
            Require(contribution is not null, "Diagnostic contribution is null.");
            RequireIdentifier(contribution.DiagnosticId);
            Require(!_reservedIds.Contains(contribution.DiagnosticId), "Diagnostic cannot use a core identity.");
            Require(contribution.SchemaVersion == SchemaVersion, "Unknown diagnostic schema version.");
            RequireVersion(contribution.Version);
            RequireIdentifier(contribution.ExtensionId);
            RequireIdentifier(contribution.ContributionId);
            Require(contribution.DiagnosticId == contribution.ContributionId || !manifestIds.Contains(contribution.DiagnosticId),
                "Diagnostic identity conflicts with another manifest authority.");
            RequireDigest(contribution.ContentSha256);
            RequireReference(contribution.PolicyReference);
            VerifiedAuthoringExtensionContract? owner = verified.Contracts.SingleOrDefault(candidate =>
                candidate.Manifest.Id == contribution.ExtensionId);
            Require(owner is not null, "Diagnostic extension is not registered.");
            AuthoringContributionDeclaration? declaration = owner!.Manifest.Contributions.SingleOrDefault(candidate =>
                candidate.Id == contribution.ContributionId);
            Require(declaration is not null && declaration.Kind == AuthoringContributionKind.PrepublishDiagnostic &&
                declaration.ExecutionClass == contribution.ExecutionClass &&
                declaration.Entrypoint.ContentSha256 == contribution.ContentSha256 &&
                contribution.ExecutionClass is AuthoringExecutionClass.IsolatedWorkerWasm or
                    AuthoringExecutionClass.OutOfProcessService,
                "Diagnostic declaration, content or isolated execution class does not match its manifest.");
            ValidateScope(contribution.InputSchema);
            Require(!contribution.Permissions.IsDefault &&
                contribution.Permissions.Distinct().Count() == contribution.Permissions.Length &&
                contribution.Permissions.All(static permission => permission is
                    AuthoringCapability.DiagnosticReport or AuthoringCapability.DocumentRangeRead) &&
                contribution.Permissions.Contains(AuthoringCapability.DiagnosticReport) &&
                contribution.Permissions.Contains(AuthoringCapability.DocumentRangeRead) ==
                    (contribution.InputSchema.Scope == AuthoringDiagnosticReadScope.SourceRanges) &&
                contribution.Permissions.Order().SequenceEqual(declaration!.Capabilities.Order()),
                "Diagnostic permissions must exactly match its minimal scope and manifest; I/O is not admitted here.");
            ValidateBudget(contribution.Budget);
            RequireWithinManifest(contribution.Budget, owner.Manifest.Limits);
            Require(policyMap.TryGetValue(contribution.DiagnosticId, out AuthoringDiagnosticHostPolicy? policy),
                "Host requiredness and severity policy must be explicit.");
            ValidatePolicy(policy!, contribution);
            Require(contributionIds.Add(contribution.ContributionId) &&
                builder.TryAdd(contribution.DiagnosticId, new Entry(contribution, owner.Manifest, policy!)),
                "Diagnostic or contribution identity is duplicated.");
        }

        string[] declared = [.. verified.Contracts.SelectMany(static contract => contract.Manifest.Contributions)
            .Where(static declaration => declaration.Kind == AuthoringContributionKind.PrepublishDiagnostic)
            .Select(static declaration => declaration.Id)];
        Require(contributionIds.SetEquals(declared), "Diagnostic metadata must cover the exact manifest roster.");
        _entries = builder.ToImmutable();
        _reservedIds = _reservedIds.Union(builder.Keys).Union(manifestIds);
        RegistrySha256 = Digest(new
        {
            SchemaVersion,
            ExtensionRegistry = verified.RegistryIdentity,
            CoreResultsSha256,
            Entries = _entries.OrderBy(static pair => pair.Key, StringComparer.Ordinal).Select(static pair => pair.Value).ToArray()
        });
    }

    public string RegistrySha256
    {
        get;
    }

    public string CoreResultsSha256
    {
        get;
    }

    public ImmutableArray<AuthoringDiagnosticCoreResult> CoreResults
    {
        get;
    }

    public AuthoringPrepublishDiagnosticContribution Get(string diagnosticId) => GetEntry(diagnosticId).Contribution;

    /// <summary>Parses only category metadata. Registry construction still joins manifest and host authority.</summary>
    public static AuthoringPrepublishDiagnosticContribution ParseContribution(ReadOnlySpan<byte> json) =>
        Parse<AuthoringPrepublishDiagnosticContribution>(json, MaximumJsonBytes);

    /// <summary>
    /// Constructs a content-bound input from host-admitted reads. No IO or grant issuance occurs here;
    /// the caller must obtain current read authority from the original host before calling this method.
    /// </summary>
    public AuthoringPrepublishDiagnosticInput CreateInput(
        string diagnosticId,
        AuthoringDiagnosticHostContext context,
        ImmutableArray<AuthoringDiagnosticMetadata> metadata,
        ImmutableArray<AuthoringDiagnosticSourceRange> sourceRanges,
        DateTimeOffset now) => BuildInput(diagnosticId, context, metadata, sourceRanges, now);

    private AuthoringPrepublishDiagnosticInput BuildInput(
        string diagnosticId,
        AuthoringDiagnosticHostContext context,
        ImmutableArray<AuthoringDiagnosticMetadata> metadata,
        ImmutableArray<AuthoringDiagnosticSourceRange> sourceRanges,
        DateTimeOffset? now)
    {
        Entry entry = GetEntry(diagnosticId);
        Require(context is not null, "Host context is required.");
        Require(context.ArticleId > 0 && context.DocumentEpoch > 0 && context.SourceRevision >= 0 &&
            context.DocumentLength >= 0, "Article, document epoch, source revision or length is invalid.");
        RequireReference(context.DocumentId);
        RequireReference(context.RequestId);
        RequireDigest(context.SourceSha256);
        RequireDigest(context.ConfigSha256);
        RequireDigest(context.GrantSha256);
        RequireDigest(context.RuntimeIdentity);
        RequireDigest(context.HostApiSha256);
        RequireVersion(context.RuntimeVersion);
        Require(context.Deadline > DateTimeOffset.MinValue && (now is null ||
            context.Deadline > now.Value && context.Deadline - now.Value <= entry.Policy.Budget.WallTime),
            "Diagnostic deadline is expired or exceeds the host wall budget.");
        Require(!metadata.IsDefault && metadata.Length <= entry.Contribution.InputSchema.MetadataKeys.Length &&
            !sourceRanges.IsDefault && sourceRanges.Length <= entry.Policy.Budget.MaximumRanges,
            "Diagnostic input scope is missing or exceeds its item budget.");
        var keys = new HashSet<string>(StringComparer.Ordinal);
        long inputCharacters = 0;
        foreach (AuthoringDiagnosticMetadata item in metadata)
        {
            Require(item is not null && entry.Contribution.InputSchema.MetadataKeys.Contains(item.Key) &&
                keys.Add(item.Key), "Metadata key is unknown or duplicated.");
            RequirePlainText(item!.Value, 4096, allowEmpty: true);
            inputCharacters += item.Value.Length;
        }

        Require(entry.Contribution.InputSchema.Scope == AuthoringDiagnosticReadScope.SourceRanges ||
            sourceRanges.IsEmpty, "Metadata-only diagnostic cannot read source.");
        int previousEnd = -1;
        long includedCharacters = 0;
        var nodes = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringDiagnosticSourceRange source in sourceRanges)
        {
            Require(source is not null, "Source range is null.");
            RequireReference(source.NodeId);
            ValidateRange(source.Range, context.DocumentLength);
            Require(source.Range.Start >= previousEnd && nodes.Add(source.NodeId) && source.Text is not null &&
                source.Text.Length == source.Range.End - source.Range.Start,
                "Source ranges must be ordered, unique, disjoint and exactly bound to their text.");
            Require(source.Range.Start != 0 || source.Range.End != context.DocumentLength || source.Text.Length == 0,
                "Full-document read requires a separate admitted contract; a range cannot imply it.");
            previousEnd = source.Range.End;
            RequireUnicode(source.Text!);
            includedCharacters += source.Text!.Length;
            inputCharacters += source.Text!.Length;
        }

        Require(includedCharacters == 0 || includedCharacters < context.DocumentLength,
            "Splitting a full document into ranges cannot bypass full-read admission.");
        Require(inputCharacters <= entry.Policy.Budget.InputBytes, "Input exceeds its payload budget.");
        var input = new AuthoringPrepublishDiagnosticInput(
            SchemaVersion, RegistrySha256, diagnosticId, entry.Contribution.Version,
            entry.Manifest.Id, entry.Manifest.Version, entry.Manifest.PackageSha256, entry.Manifest.ContentSha256,
            Digest(entry.Contribution), Digest(entry.Policy), CoreResultsSha256, context,
            entry.Contribution.InputSchema, metadata, sourceRanges, string.Empty);
        input = input with
        {
            InputSha256 = Digest(input)
        };
        Require(JsonSerializer.SerializeToUtf8Bytes(input, s_json).Length <= entry.Policy.Budget.InputBytes,
            "Serialized input exceeds the host payload budget.");
        return input;
    }

    /// <summary>Rebinds output to a host input; plugin JSON has no authority to supply host policy or core results.</summary>
    public AuthoringPrepublishDiagnosticResult ParseResult(
        AuthoringPrepublishDiagnosticInput input,
        ReadOnlySpan<byte> json,
        DateTimeOffset now) => ValidateResult(input,
            Parse<AuthoringPrepublishDiagnosticResponse>(json, GetEntry(input.DiagnosticId).Policy.Budget.OutputBytes), now);

    public AuthoringPrepublishDiagnosticResult ValidateResult(
        AuthoringPrepublishDiagnosticInput input,
        AuthoringPrepublishDiagnosticResponse response,
        DateTimeOffset now)
    {
        Entry entry = ValidateInput(input, now);
        Require(response is not null && response.SchemaVersion == SchemaVersion &&
            response.DiagnosticId == input.DiagnosticId && response.InputSha256 == input.InputSha256 &&
            Enum.IsDefined(response.Completion) && !response.Facts.IsDefault &&
            response.Facts.Length <= entry.Policy.Budget.MaximumFacts,
            "Diagnostic result version, binding, completion or fact budget is invalid.");
        Require((response.Completion == AuthoringDiagnosticCompletion.Findings) == !response.Facts.IsEmpty,
            "Findings cannot be an empty success; NoFindings must be explicit and contain no facts.");
        var factIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringDiagnosticFact fact in response.Facts)
        {
            Require(fact is not null, "Diagnostic fact is null.");
            RequireIdentifier(fact.Id);
            Require(fact.Id.StartsWith(input.DiagnosticId + ".", StringComparison.Ordinal) &&
                !_reservedIds.Contains(fact.Id) && factIds.Add(fact.Id),
                "Fact ID is duplicated, outside its diagnostic namespace or conflicts with core.");
            AuthoringDiagnosticCodePolicy? code = entry.Policy.Codes.SingleOrDefault(candidate => candidate.Code == fact.Code);
            Require(code is not null && Enum.IsDefined(fact.Severity) && fact.Severity == code.Severity,
                "Result code or runtime severity is outside host policy.");
            RequirePlainText(fact.Message, 4096);
            Require(!fact.Ranges.IsDefault && fact.Ranges.Length <= entry.Policy.Budget.MaximumRanges &&
                !fact.Evidence.IsDefault && fact.Evidence.Length <= entry.Policy.Budget.MaximumEvidence,
                "Fact ranges or evidence exceed host limits.");
            int previousEnd = -1;
            foreach (AuthoringTextRange range in fact.Ranges)
            {
                ValidateRange(range, input.Context.DocumentLength);
                Require(range.Start >= previousEnd && input.SourceRanges.Any(source =>
                    range.Start >= source.Range.Start && range.End <= source.Range.End),
                    "Fact range is duplicate, overlapping or outside the admitted source scope.");
                previousEnd = range.End;
            }

            var evidenceIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (AuthoringDiagnosticEvidence evidence in fact.Evidence)
            {
                Require(evidence is not null, "Evidence is null.");
                RequireReference(evidence.Reference);
                RequireDigest(evidence.Sha256);
                Require(evidenceIds.Add(evidence.Reference), "Evidence is duplicated.");
            }

            Require(fact.FixCommandReference is null || entry.Policy.FixCommandReferences.Contains(fact.FixCommandReference),
                "Fix command reference is not allowed by host policy.");
        }

        Require(JsonSerializer.SerializeToUtf8Bytes(response, s_json).Length <= entry.Policy.Budget.OutputBytes,
            "Serialized result exceeds the host payload budget.");
        return new AuthoringPrepublishDiagnosticResult(input, entry.Policy.Required,
            response.Completion == AuthoringDiagnosticCompletion.Findings
                ? AuthoringDiagnosticOutcomeStatus.Findings
                : AuthoringDiagnosticOutcomeStatus.NoFindings,
            response.Facts, null);
    }

    /// <summary>Host-only unavailability classification. Neither status is a completed or receiptable plugin success.</summary>
    public AuthoringPrepublishDiagnosticResult Unavailable(
        AuthoringPrepublishDiagnosticInput input,
        AuthoringDiagnosticUnavailableReason reason)
    {
        // An expired input can be identified for failure reporting, never accepted as a completed evaluation.
        Entry entry = ValidateInput(input, null);
        Require(Enum.IsDefined(reason), "Unknown diagnostic unavailability reason.");
        return new AuthoringPrepublishDiagnosticResult(input, entry.Policy.Required,
            entry.Policy.Required ? AuthoringDiagnosticOutcomeStatus.RequiredUnavailable :
                AuthoringDiagnosticOutcomeStatus.OptionalNotEvaluable, [], reason);
    }

    private Entry ValidateInput(AuthoringPrepublishDiagnosticInput input, DateTimeOffset? now)
    {
        Require(input is not null, "Host diagnostic input is required.");
        Entry entry = GetEntry(input.DiagnosticId);
        AuthoringPrepublishDiagnosticInput expected = BuildInput(
            input.DiagnosticId, input.Context, input.Metadata, input.SourceRanges, now);
        Require(input.InputSha256 == expected.InputSha256 && Digest(input) == Digest(expected),
            "Diagnostic input is stale, foreign or tampered.");
        return entry;
    }

    private Entry GetEntry(string diagnosticId)
    {
        RequireIdentifier(diagnosticId);
        return _entries.GetValueOrDefault(diagnosticId) ??
            throw new AuthoringExtensionContractException("Diagnostic is not registered.");
    }

    private void ValidatePolicy(
        AuthoringDiagnosticHostPolicy policy,
        AuthoringPrepublishDiagnosticContribution contribution)
    {
        Require(policy.PolicyReference == contribution.PolicyReference && !policy.Codes.IsDefaultOrEmpty &&
            policy.Codes.Length <= 100 && !policy.FixCommandReferences.IsDefault &&
            policy.FixCommandReferences.Length <= 100,
            "Host policy reference or result vocabulary is missing or unbounded.");
        var codes = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringDiagnosticCodePolicy code in policy.Codes)
        {
            Require(code is not null, "Host code policy is null.");
            RequireIdentifier(code.Code);
            Require(Enum.IsDefined(code.Severity) && codes.Add(code.Code) && !_reservedIds.Contains(code.Code),
                "Host code or severity is unknown, duplicated or core-owned.");
        }

        var fixes = new HashSet<string>(StringComparer.Ordinal);
        foreach (string fix in policy.FixCommandReferences)
        {
            RequireIdentifier(fix);
            Require(fixes.Add(fix), "Host fix command reference is duplicated.");
        }

        ValidateBudget(policy.Budget);
        Require(Within(policy.Budget, contribution.Budget), "Host budget cannot expand the declared diagnostic budget.");
    }

    private static void ValidateScope(AuthoringDiagnosticInputSchema scope)
    {
        Require(scope is not null && scope.SchemaVersion == SchemaVersion && Enum.IsDefined(scope.Scope) &&
            !scope.MetadataKeys.IsDefault && scope.MetadataKeys.Length <= 32,
            "Diagnostic input schema is unknown or unbounded.");
        RequireReference(scope.ReadModelReference);
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (string key in scope.MetadataKeys)
        {
            RequireIdentifier(key);
            Require(keys.Add(key), "Input metadata key is duplicated.");
        }
    }

    private static void ValidateBudget(AuthoringDiagnosticBudget budget) => Require(
        budget is not null && budget.CpuTime > TimeSpan.Zero && budget.CpuTime <= TimeSpan.FromMinutes(5) &&
        budget.WallTime > TimeSpan.Zero && budget.WallTime <= TimeSpan.FromMinutes(5) &&
        budget.MemoryBytes is > 0 and <= 536_870_912 && budget.InputBytes is > 0 and <= MaximumJsonBytes &&
        budget.OutputBytes is > 0 and <= MaximumJsonBytes && budget.ConcurrentCalls is > 0 and <= 32 &&
        budget.QueueDepth is > 0 and <= 1024 && budget.MaximumFacts is > 0 and <= 1000 &&
        budget.MaximumRanges is > 0 and <= 1000 && budget.MaximumEvidence is > 0 and <= 100,
        "Diagnostic budget is missing, unknown or outside host bounds.");

    private static bool Within(AuthoringDiagnosticBudget value, AuthoringDiagnosticBudget limit) =>
        value.CpuTime <= limit.CpuTime && value.WallTime <= limit.WallTime && value.MemoryBytes <= limit.MemoryBytes &&
        value.InputBytes <= limit.InputBytes && value.OutputBytes <= limit.OutputBytes &&
        value.ConcurrentCalls <= limit.ConcurrentCalls && value.QueueDepth <= limit.QueueDepth &&
        value.MaximumFacts <= limit.MaximumFacts && value.MaximumRanges <= limit.MaximumRanges &&
        value.MaximumEvidence <= limit.MaximumEvidence;

    private static void RequireWithinManifest(AuthoringDiagnosticBudget budget, AuthoringResourceLimits limits) => Require(
        budget.CpuTime <= limits.MaximumCpuTime && budget.WallTime <= limits.WallClock &&
        budget.MemoryBytes <= limits.MemoryBytes && budget.InputBytes <= limits.MaximumRequestBytes &&
        budget.OutputBytes <= limits.MaximumResponseBytes && budget.ConcurrentCalls <= limits.MaximumConcurrentCalls &&
        budget.QueueDepth <= limits.MaximumQueueDepth,
        "Diagnostic budget exceeds the existing manifest ceilings.");

    private static void ValidateRange(AuthoringTextRange range, int length) => Require(
        range is not null && range.Start >= 0 && range.End > range.Start && range.End <= length,
        "Range is empty, reversed or outside the exact source.");

    private static void RequirePlainText(string text, int maximumLength, bool allowEmpty = false)
    {
        Require(text is not null && text.Length <= maximumLength && (allowEmpty || !string.IsNullOrWhiteSpace(text)) &&
            !text.Any(static value => char.IsControl(value) && value is not '\n' and not '\r' and not '\t') &&
            !text.Contains('<') && !text.Contains('>'), "Diagnostic text must be bounded plain text.");
        RequireUnicode(text);
    }

    private static void RequireUnicode(string text)
    {
        try
        {
            _ = new UnicodeEncoding(false, false, true).GetByteCount(text);
        }
        catch (EncoderFallbackException)
        {
            throw new AuthoringExtensionContractException("Diagnostic text contains unpaired UTF-16 surrogates.");
        }
    }

    private static void RequireIdentifier(string value) => Require(
        value is not null && value.Length <= 128 && IdentifierPattern().IsMatch(value) &&
        !value.StartsWith("fsusblog.core.", StringComparison.Ordinal), "Diagnostic identifier is invalid or core-owned.");

    private static void RequireReference(string value) => Require(
        value is not null && value.Length <= 128 && ReferencePattern().IsMatch(value), "Diagnostic reference is invalid.");

    private static void RequireDigest(string value) => Require(
        value is not null && DigestPattern().IsMatch(value), "Diagnostic digest must be lowercase SHA-256.");

    private static void RequireVersion(string value) => Require(
        value is not null && value.Length <= 64 && VersionPattern().IsMatch(value) && Version.TryParse(value, out _),
        "Diagnostic version must be a closed numeric version.");

    private static void Require([DoesNotReturnIf(false)] bool condition, string message)
    {
        if (!condition)
        {
            throw new AuthoringExtensionContractException(message);
        }
    }

    private static string Digest<T>(T value) =>
        Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, s_json)));

    private static T Parse<T>(ReadOnlySpan<byte> json, int byteLimit)
    {
        Require(!json.IsEmpty && json.Length <= byteLimit, "Diagnostic JSON exceeds its payload budget.");
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
            RejectDuplicates(document.RootElement);
            return JsonSerializer.Deserialize<T>(json, s_json) ??
                throw new AuthoringExtensionContractException("Diagnostic JSON cannot be null.");
        }
        catch (JsonException)
        {
            throw new AuthoringExtensionContractException("Diagnostic JSON has missing, unknown or invalid members.");
        }
    }

    private static void RejectDuplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                Require(names.Add(property.Name), "Diagnostic JSON has duplicate members.");
                RejectDuplicates(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicates(item);
            }
        }
    }

    private sealed record Entry(
        AuthoringPrepublishDiagnosticContribution Contribution,
        AuthoringExtensionManifest Manifest,
        AuthoringDiagnosticHostPolicy Policy);

    [GeneratedRegex("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierPattern();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:-]*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex ReferencePattern();

    [GeneratedRegex("^[0-9a-f]{64}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex DigestPattern();

    [GeneratedRegex("^[0-9]+(?:\\.[0-9]+){1,3}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex VersionPattern();
}
