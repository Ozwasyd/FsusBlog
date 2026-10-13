namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Supplies original planner inputs and actual source bytes without a caller admission flag.</summary>
public sealed record ArticleVaultSourceAdmissionInput(
    ArticleVaultSyncPlan Plan,
    ArticleVaultRootManifest Root,
    IReadOnlyList<ArticleVaultArticleManifest> Articles,
    IReadOnlyList<ArticleVaultServerObservation> Observations,
    ArticleVaultPlanVerificationContext Context,
    VaultConflictBinding Binding,
    ReadOnlyMemory<byte> BaseBytes,
    ReadOnlyMemory<byte> LocalBytes,
    ReadOnlyMemory<byte> ServerBytes);

/// <summary>Returns a process-owned byte proof or a fail-closed reason without execution authority.</summary>
public sealed record ArticleVaultSourceAdmissionResult(ArticleVaultAdmittedSource? Source, string? ReasonCode);

/// <summary>
/// A process-owned source admission proof, constructed only from the original current planner and
/// three actual byte snapshots. It is not a wire DTO, parser proof, resolution or writer authority.
/// </summary>
public sealed class ArticleVaultAdmittedSource
{
    private readonly byte[] _baseBytes;
    private readonly byte[] _localBytes;
    private readonly byte[] _serverBytes;

    private ArticleVaultAdmittedSource(VaultConflictBinding binding, byte[] baseBytes, byte[] localBytes, byte[] serverBytes)
    {
        Binding = binding;
        _baseBytes = baseBytes;
        _localBytes = localBytes;
        _serverBytes = serverBytes;
    }

    public VaultConflictBinding Binding
    {
        get;
    }

    public byte[] CopyBaseBytes() => _baseBytes.ToArray();

    public byte[] CopyLocalBytes() => _localBytes.ToArray();

    public byte[] CopyServerBytes() => _serverBytes.ToArray();

    public static ArticleVaultSourceAdmissionResult AdmitCurrent(ArticleVaultSourceAdmissionInput? input)
    {
        if (input is null || input.Binding is null)
        {
            return Rejected("input_missing");
        }

        // Copy before validation: the proof never retains caller-owned mutable byte buffers.
        byte[] baseBytes = input.BaseBytes.ToArray();
        byte[] localBytes = input.LocalBytes.ToArray();
        byte[] serverBytes = input.ServerBytes.ToArray();
        ArticleVaultValidationResult current = ArticleVaultSyncPlanVerifier.VerifyCurrent(
            input.Plan, input.Root, input.Articles, input.Observations, input.Context);
        if (!current.IsValid)
        {
            return new(null, current.ReasonCode);
        }

        VaultConflictBinding binding = input.Binding;
        VaultSyncPlanItem[] items = input.Plan.Groups.Where(group => group.GroupIdentity == binding.GroupIdentity)
            .SelectMany(static group => group.Items).Where(item => item.OperationIdentity == binding.OperationIdentity).ToArray();
        if (items.Length != 1 || binding.SiteIdentity != input.Plan.SiteIdentity
            || binding.VaultIdentity != input.Plan.VaultIdentity || binding.DeviceIdentity != input.Plan.DeviceIdentity
            || binding.PlanCandidateIdentity != input.Plan.PlanCandidateIdentity || binding.PlanSha256 != input.Plan.ContentSha256)
        {
            return Rejected("plan_binding_drift");
        }

        VaultSyncPlanItem item = items[0];
        if (binding.PortableArticleIdentity != item.PortableArticleIdentity || binding.ServerArticleIdentity != item.ServerArticleIdentity
            || binding.ArticleManifestSha256 != item.Preconditions.ArticleManifestSha256
            || binding.ServerObservationSha256 != item.Preconditions.ServerObservationSha256
            || !ArticleVaultManifestCodec.SerializeCanonical(binding.Coordinates).AsSpan().SequenceEqual(
                ArticleVaultManifestCodec.SerializeCanonical(new VaultArticleCoordinates(item.Base, item.Local, item.Server))))
        {
            return Rejected("coordinate_drift");
        }

        if (!item.Base.Present || item.Base.Deleted || !item.Local.Present || item.Local.Deleted || !item.Server.Present || item.Server.Deleted)
        {
            return Rejected("base_or_snapshot_missing");
        }

        foreach ((VaultSourceByteIdentity? reference, byte[] bytes) in new[]
        {
            (item.Base.Source, baseBytes), (item.Local.Source, localBytes), (item.Server.Source, serverBytes)
        })
        {
            ArticleVaultValidationResult source = ArticleVaultManifestValidator.ValidateSourceBytes(reference, bytes);
            if (!source.IsValid)
            {
                return new(null, source.ReasonCode);
            }
        }

        return new(new(binding, baseBytes, localBytes, serverBytes), null);
    }

    private static ArticleVaultSourceAdmissionResult Rejected(string reason)
        => new(null, $"article_vault_source_admission_{reason}");
}
