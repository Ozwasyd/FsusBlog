using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Immutable intermediate candidate. It is not a provider receipt, permission or executable import.</summary>
public sealed class AuthoringImportProviderCandidateHandoff
{
    internal AuthoringImportProviderCandidateHandoff(
        AuthoringImportProviderContribution provider,
        AuthoringImportProviderCandidateAttempt attempt,
        ArticlePackageImportCandidatePlan plan,
        string extensionContractIdentity,
        string contentDigest,
        ArticlePackageImportZipCandidate? zipCandidate)
    {
        Provider = provider;
        Attempt = attempt;
        Plan = plan;
        ExtensionContractIdentity = extensionContractIdentity;
        ContentDigest = contentDigest;
        ZipCandidate = zipCandidate;
    }

    public AuthoringImportProviderContribution Provider
    {
        get;
    }
    public AuthoringImportProviderCandidateAttempt Attempt
    {
        get;
    }
    public ArticlePackageImportCandidatePlan Plan
    {
        get;
    }
    public string ExtensionContractIdentity
    {
        get;
    }
    public string ContentDigest
    {
        get;
    }
    public ArticlePackageImportZipCandidate? ZipCandidate
    {
        get;
    }

    /// <summary>Preserves the original owner's unconditional refusal; no candidate metadata grants execution.</summary>
    public ArticlePackageManifestCandidateResult RequireExecutionAuthority() => Plan.RequireExecutionAuthority();
}

/// <summary>
/// Adapts one explicit provider's already-read output to the actual immutable candidate/plan APIs.
/// No provider dispatch, archive intake, filesystem, network, database, grant issuer or writer is injected.
/// </summary>
public sealed class AuthoringImportProviderCandidateAdapter
{
    private readonly TimeProvider _time;

    public AuthoringImportProviderCandidateAdapter(TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(time);
        _time = time;
    }
    public ArticlePackageManifestCandidateResult TryPrepareCandidate(
        VerifiedAuthoringExtensionContract owner,
        AuthoringImportProviderContribution provider,
        AuthoringImportProviderCandidateAttempt attempt,
        ArticlePackageImportCandidateRequest intent,
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        IReadOnlyList<ArticlePackageFileBytes>? files,
        out AuthoringImportProviderCandidateHandoff? handoff,
        CancellationToken cancellationToken = default)
    {
        handoff = null;
        cancellationToken.ThrowIfCancellationRequested();
        if (!ValidProvider(owner, provider) || !ValidAttempt(provider, attempt)
            || provider.InputKind != AuthoringImportProviderCandidateInput.PackageFileBytes)
        {
            return Invalid("authoring_import_provider_candidate_invalid");
        }
        if (!CurrentInterval(owner, intent))
        {
            return Invalid("authoring_import_provider_candidate_stale");
        }
        ArticlePackageManifestCandidateResult bytes = ArticlePackageImportCandidateBytes.Validate(
            inventory, files, out ArticlePackageValidatedImportCandidate? candidate, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (!bytes.IsValid)
        {
            return bytes;
        }
        return PreparePlan(owner, provider, attempt, intent, candidate!, null, out handoff, cancellationToken);
    }

    public ArticlePackageManifestCandidateResult TryPrepareZipCandidate(
        VerifiedAuthoringExtensionContract owner,
        AuthoringImportProviderContribution provider,
        AuthoringImportProviderCandidateAttempt attempt,
        ArticlePackageImportCandidateRequest intent,
        ReadOnlySpan<byte> archiveBytes,
        out AuthoringImportProviderCandidateHandoff? handoff,
        CancellationToken cancellationToken = default)
    {
        handoff = null;
        cancellationToken.ThrowIfCancellationRequested();
        if (!ValidProvider(owner, provider) || !ValidAttempt(provider, attempt)
            || provider.InputKind != AuthoringImportProviderCandidateInput.ZipBytes)
        {
            return Invalid("authoring_import_provider_candidate_invalid");
        }
        if (!CurrentInterval(owner, intent))
        {
            return Invalid("authoring_import_provider_candidate_stale");
        }
        ArticlePackageManifestCandidateResult result = ArticlePackageImportZipCandidateReader.TryReadCandidate(
            archiveBytes, out ArticlePackageImportZipCandidate? zip, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (!result.IsValid)
        {
            return result;
        }
        if (zip!.ArchiveSha256 != attempt.ExpectedArchiveSha256)
        {
            return Invalid("authoring_import_provider_input_drift");
        }
        return PreparePlan(owner, provider, attempt, intent, zip.Candidate, zip, out handoff, cancellationToken);
    }

    private ArticlePackageManifestCandidateResult PreparePlan(
        VerifiedAuthoringExtensionContract owner,
        AuthoringImportProviderContribution provider,
        AuthoringImportProviderCandidateAttempt attempt,
        ArticlePackageImportCandidateRequest intent,
        ArticlePackageValidatedImportCandidate candidate,
        ArticlePackageImportZipCandidate? zipCandidate,
        out AuthoringImportProviderCandidateHandoff? handoff,
        CancellationToken cancellationToken)
    {
        handoff = null;
        if (candidate.PackageBytesDigest != attempt.ExpectedPackageBytesDigest)
        {
            return Invalid("authoring_import_provider_input_drift");
        }
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidatePlanner.TryCreatePlan(
            candidate, intent, out ArticlePackageImportCandidatePlan? plan, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (!result.IsValid)
        {
            return result;
        }
        // The actual planner owns requested-target freezing, canonical order and all plan semantics.
        string digest = ComputeDigest(provider, attempt, plan!, owner.ContractIdentity);
        cancellationToken.ThrowIfCancellationRequested();
        if (!CurrentInterval(owner, intent))
        {
            return Invalid("authoring_import_provider_candidate_stale");
        }
        handoff = new(provider, attempt, plan!, owner.ContractIdentity, digest, zipCandidate);
        return new(true, null);
    }

    /// <summary>Compares fresh caller assertions only; a matching result is not current package/grant authority.</summary>
    public ArticlePackageManifestCandidateResult ValidateRequestBinding(
        AuthoringImportProviderCandidateHandoff handoff,
        VerifiedAuthoringExtensionContract owner,
        AuthoringImportProviderContribution provider,
        AuthoringImportProviderCandidateAttempt attempt,
        ArticlePackageImportCandidateRequest intent,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(handoff);
        cancellationToken.ThrowIfCancellationRequested();
        if (!ValidProvider(owner, provider) || !ValidAttempt(provider, attempt) || !CurrentInterval(owner, intent)
            || handoff.Provider != provider || handoff.Attempt != attempt
            || handoff.ExtensionContractIdentity != owner.ContractIdentity
            || handoff.ContentDigest != ComputeDigest(provider, attempt, handoff.Plan, owner.ContractIdentity))
        {
            return Invalid("authoring_import_provider_candidate_stale");
        }
        ArticlePackageManifestCandidateResult result = handoff.Plan.ValidateRequestBinding(
            intent, attempt.ExpectedPackageBytesDigest, _time.GetUtcNow().UtcDateTime);
        cancellationToken.ThrowIfCancellationRequested();
        if (!CurrentInterval(owner, intent))
        {
            return Invalid("authoring_import_provider_candidate_stale");
        }
        return result;
    }

    private bool CurrentInterval(VerifiedAuthoringExtensionContract owner, ArticlePackageImportCandidateRequest? intent)
    {
        DateTime now = _time.GetUtcNow().UtcDateTime;
        return intent is not null && intent.CreatedAtUtc.Kind == DateTimeKind.Utc && intent.ExpiresAtUtc.Kind == DateTimeKind.Utc
            && intent.CreatedAtUtc <= now && now < intent.ExpiresAtUtc
            && intent.ExpiresAtUtc - intent.CreatedAtUtc <= owner.Manifest.Limits.WallClock;
    }

    private static bool ValidProvider(VerifiedAuthoringExtensionContract? owner, AuthoringImportProviderContribution? provider)
    {
        if (owner is null || provider is null || owner.Manifest is null || provider.SchemaVersion != 1
            || provider.InputSchemaVersion != 1 || provider.CandidateSchemaVersion != 1 || provider.SupportsStreaming
            || provider.InputKind is not (AuthoringImportProviderCandidateInput.PackageFileBytes or AuthoringImportProviderCandidateInput.ZipBytes)
            || provider.ExtensionId != owner.Manifest.Id || provider.ExtensionVersion != owner.Manifest.Version
            || provider.PackageSha256 != owner.Manifest.PackageSha256)
        {
            return false;
        }
        try
        {
            VerifiedAuthoringExtensionContract verified = AuthoringExtensionContractValidator.Verify(owner.Manifest);
            if (verified.ContractIdentity != owner.ContractIdentity || verified.RegistryIdentity != owner.RegistryIdentity)
            {
                return false;
            }
            AuthoringContributionDeclaration? declaration = owner.Manifest.Contributions.FirstOrDefault(item => item.Id == provider.ProviderId);
            return declaration?.Kind == AuthoringContributionKind.ImportProvider
                && declaration.ExecutionClass is AuthoringExecutionClass.IsolatedWorkerWasm or AuthoringExecutionClass.OutOfProcessService;
        }
        catch (AuthoringExtensionContractException)
        {
            return false;
        }
    }

    private static bool ValidAttempt(AuthoringImportProviderContribution provider, AuthoringImportProviderCandidateAttempt? attempt)
        => attempt is not null && Identifier(attempt.RuntimeIdentity) && Identifier(attempt.RequestId) && Identifier(attempt.AttemptId)
            && Digest(attempt.DeclaredGrantDigest) && Digest(attempt.ExpectedPackageBytesDigest)
            && (provider.InputKind == AuthoringImportProviderCandidateInput.ZipBytes
                ? Digest(attempt.ExpectedArchiveSha256) : attempt.ExpectedArchiveSha256 is null);

    private static bool Identifier(string? value) => value is { Length: > 0 and <= 128 }
        && value.All(static c => char.IsAsciiLetterOrDigit(c) || c is '.' or ':' or '-' or '_');

    private static bool Digest(string? value) => value is { Length: 64 }
        && value.All(static c => c is (>= 'a' and <= 'f') or (>= '0' and <= '9'));

    private static string ComputeDigest(AuthoringImportProviderContribution provider, AuthoringImportProviderCandidateAttempt attempt,
        ArticlePackageImportCandidatePlan plan, string extensionIdentity)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        foreach (string value in new[] { "fsusblog.authoring-import-provider-candidate.v1", provider.ProviderId,
            extensionIdentity, attempt.RuntimeIdentity, attempt.RequestId, attempt.AttemptId, attempt.DeclaredGrantDigest,
            attempt.ExpectedPackageBytesDigest, attempt.ExpectedArchiveSha256 ?? string.Empty, plan.PlanDigest })
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            writer.Write(bytes.Length);
            writer.Write(bytes);
        }
        writer.Flush();
        return Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
