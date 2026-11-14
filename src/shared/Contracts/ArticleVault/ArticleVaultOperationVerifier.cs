namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Content-addresses closed operation facts using the existing Vault canonical codec.</summary>
public static class ArticleVaultOperationCodec
{
    public static string ComputeContentSha256(ArticleVaultOperationIdentity identity)
        => Digest(identity with
        {
            ContentSha256 = string.Empty
        });

    public static string ComputeContentSha256(ArticleVaultOperationCheckpoint checkpoint)
        => Digest(checkpoint with
        {
            ContentSha256 = string.Empty
        });

    public static string ComputeOperationIdentity(ArticleVaultOperationIdentity identity)
        => Digest(identity with
        {
            OperationIdentity = string.Empty,
            ContentSha256 = string.Empty
        });

    public static byte[] Serialize<T>(T value)
        => ArticleVaultManifestCodec.SerializeCanonical(value);

    public static T Deserialize<T>(ReadOnlySpan<byte> bytes)
        => ArticleVaultManifestCodec.DeserializeCanonical<T>(bytes)
            ?? throw new InvalidDataException("article_vault_operation_schema_invalid");

    private static string Digest<T>(T value)
        => ArticleVaultManifestCodec.ComputeSha256(Serialize(value));
}

/// <summary>
/// Independently checks exact plan binding and immutable checkpoint history. This source capability
/// intentionally blocks Synced: no native materialization/base commit verifier is available yet.
/// A valid history is not permission to execute a server writer or access a filesystem.
/// </summary>
public static class ArticleVaultOperationVerifier
{
    public static ArticleVaultOperationIdentity Bind(
        ArticleVaultSyncPlan plan,
        string agentIdentity,
        string requestSha256,
        string idempotencySha256,
        long deadlineUnixMs)
    {
        var identity = new ArticleVaultOperationIdentity(
            ArticleVaultOperationSchemas.Identity,
            ArticleVaultOperationSchemas.Version,
            plan.SiteIdentity,
            plan.VaultIdentity,
            plan.DeviceIdentity,
            agentIdentity,
            plan.PlanCandidateIdentity,
            plan.ContentSha256,
            requestSha256,
            idempotencySha256,
            deadlineUnixMs,
            string.Empty,
            string.Empty);
        identity = identity with
        {
            OperationIdentity = ArticleVaultOperationCodec.ComputeOperationIdentity(identity)
        };
        identity = identity with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(identity)
        };
        Require(ValidateIdentity(identity, plan));
        return identity;
    }

    public static ArticleVaultValidationResult ValidateIdentity(
        ArticleVaultOperationIdentity? identity,
        ArticleVaultSyncPlan? plan)
    {
        ArticleVaultValidationResult planValidation = ArticleVaultSyncPlanVerifier.ValidateStructure(plan);
        if (!planValidation.IsValid)
        {
            return planValidation;
        }

        if (identity is null
            || identity.Schema != ArticleVaultOperationSchemas.Identity
            || identity.SchemaVersion != ArticleVaultOperationSchemas.Version
            || !ArticleVaultManifestValidator.IsIdentity(identity.AgentIdentity)
            || !ArticleVaultManifestValidator.IsSha256(identity.RequestSha256)
            || !ArticleVaultManifestValidator.IsSha256(identity.IdempotencySha256)
            || identity.SiteIdentity != plan!.SiteIdentity
            || identity.VaultIdentity != plan.VaultIdentity
            || identity.DeviceIdentity != plan.DeviceIdentity
            || identity.PlanReference != plan.PlanCandidateIdentity
            || identity.PlanSha256 != plan.ContentSha256
            || identity.DeadlineUnixMs <= plan.CreatedAtUnixMs
            || identity.DeadlineUnixMs > plan.ExpiresAtUnixMs
            || identity.OperationIdentity != ArticleVaultOperationCodec.ComputeOperationIdentity(identity)
            || identity.ContentSha256 != ArticleVaultOperationCodec.ComputeContentSha256(identity))
        {
            return Invalid("article_vault_operation_identity_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static ArticleVaultValidationResult VerifyHistory(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        IReadOnlyList<ArticleVaultOperationCheckpoint>? history,
        long expectedSequence,
        string expectedCheckpointSha256)
    {
        ArticleVaultValidationResult binding = ValidateIdentity(identity, plan);
        if (!binding.IsValid)
        {
            return binding;
        }

        if (history is null || expectedSequence < 0 || history.Count != expectedSequence + 1)
        {
            return Invalid("article_vault_operation_history_missing");
        }

        ArticleVaultOperationCheckpoint? previous = null;
        foreach (ArticleVaultOperationCheckpoint checkpoint in history)
        {
            ArticleVaultValidationResult validation = ValidateAppend(identity, plan, previous, checkpoint);
            if (!validation.IsValid)
            {
                return validation;
            }

            previous = checkpoint;
        }

        return previous?.ContentSha256 == expectedCheckpointSha256
            ? ArticleVaultValidationResult.Valid()
            : Invalid("article_vault_operation_tip_mismatch");
    }

    public static ArticleVaultValidationResult ValidateAppend(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        ArticleVaultOperationCheckpoint? previous,
        ArticleVaultOperationCheckpoint? next)
    {
        ArticleVaultValidationResult binding = ValidateIdentity(identity, plan);
        if (!binding.IsValid)
        {
            return binding;
        }

        if (next is null
            || next.Schema != ArticleVaultOperationSchemas.Checkpoint
            || next.SchemaVersion != ArticleVaultOperationSchemas.Version
            || next.OperationIdentity != identity.OperationIdentity
            || next.IdentitySha256 != identity.ContentSha256
            || !Enum.IsDefined(next.State)
            || !Enum.IsDefined(next.ServerCommit)
            || next.Sequence != (previous?.Sequence + 1 ?? 0)
            || next.PreviousCheckpointSha256 != previous?.ContentSha256
            || next.RecordedAtUnixMs < (previous?.RecordedAtUnixMs ?? plan.CreatedAtUnixMs)
            || next.ContentSha256 != ArticleVaultOperationCodec.ComputeContentSha256(next)
            || next.Articles is null)
        {
            return Invalid("article_vault_operation_checkpoint_invalid");
        }

        // A reference hash alone cannot prove files, manifests and durable base agree.
        if (next.State == VaultOperationState.Synced)
        {
            return Invalid("article_vault_operation_materialization_capability_missing");
        }

        VaultSyncPlanItem[] items = plan.Groups.SelectMany(static group => group.Items)
            .OrderBy(static item => item.PortableArticleIdentity, StringComparer.Ordinal).ToArray();
        if (next.Articles.Count != items.Length)
        {
            return Invalid("article_vault_operation_membership_mismatch");
        }

        for (int index = 0; index < items.Length; index++)
        {
            VaultOperationArticleOutcome? outcome = next.Articles[index];
            if (outcome is null
                || outcome.PortableArticleIdentity != items[index].PortableArticleIdentity
                || outcome.BaseBeforeSha256 != items[index].Base.ContentSha256
                || outcome.BaseAfterSha256 != outcome.BaseBeforeSha256)
            {
                return Invalid("article_vault_operation_base_mismatch");
            }
        }

        if (next.MaterializationReceipt is not null
            || !IsReference(next.ServerResult)
            || next.ServerResult is not null && next.ServerResult.Reference != plan.ResultCandidateIdentity
            || next.ServerCommit is VaultServerCommitDisposition.Accepted or VaultServerCommitDisposition.Rejected
                && next.ServerResult is null
            || next.ServerCommit is VaultServerCommitDisposition.NotStarted or VaultServerCommitDisposition.Unknown
                && next.ServerResult is not null)
        {
            return Invalid("article_vault_operation_stage_reference_invalid");
        }

        if (previous is null)
        {
            return next.State == VaultOperationState.Planned
                && next.ServerCommit == VaultServerCommitDisposition.NotStarted
                && !next.CancellationRequested
                && next.ReasonCode is null
                && next.RecordedAtUnixMs <= identity.DeadlineUnixMs
                    ? ArticleVaultValidationResult.Valid()
                    : Invalid("article_vault_operation_initial_state_invalid");
        }

        if (previous.OperationIdentity != identity.OperationIdentity
            || previous.IdentitySha256 != identity.ContentSha256
            || previous.ContentSha256 != ArticleVaultOperationCodec.ComputeContentSha256(previous)
            || IsTerminal(previous.State)
            || previous.CancellationRequested && !next.CancellationRequested
            || previous.ServerResult is not null && next.ServerResult != previous.ServerResult
            || !CommitTransition(previous.ServerCommit, next.ServerCommit)
            || !StateTransition(previous.State, next.State))
        {
            return Invalid("article_vault_operation_transition_invalid");
        }

        bool uncertain = next.ServerCommit is VaultServerCommitDisposition.Unknown or VaultServerCommitDisposition.Accepted;
        if (next.State == VaultOperationState.ExecutingServer
                && next.ServerCommit != VaultServerCommitDisposition.Unknown
            || next.State == VaultOperationState.MaterializingLocal
                && next.ServerCommit != VaultServerCommitDisposition.Accepted
            || next.State is VaultOperationState.Cancelled or VaultOperationState.Failed && uncertain
            || next.State == VaultOperationState.RecoveryRequired && !uncertain
            || next.State is VaultOperationState.Planned or VaultOperationState.Validating
                && next.ServerCommit != VaultServerCommitDisposition.NotStarted)
        {
            return Invalid("article_vault_operation_commit_state_mismatch");
        }

        bool interrupted = next.CancellationRequested || next.RecordedAtUnixMs > identity.DeadlineUnixMs;
        if (interrupted
            && next.State != (uncertain ? VaultOperationState.RecoveryRequired : VaultOperationState.Cancelled)
            && next.State != VaultOperationState.Blocked)
        {
            return Invalid("article_vault_operation_interruption_boundary_invalid");
        }

        bool reasonRequired = next.State is VaultOperationState.Cancelled or VaultOperationState.Failed
            or VaultOperationState.Blocked or VaultOperationState.RecoveryRequired;
        if (reasonRequired != (next.ReasonCode is not null)
            || next.ReasonCode is not null && !IsReasonCode(next.ReasonCode))
        {
            return Invalid("article_vault_operation_reason_invalid");
        }

        return ArticleVaultValidationResult.Valid();
    }

    public static bool IsTerminal(VaultOperationState state)
        => state is VaultOperationState.Cancelled or VaultOperationState.Failed
            or VaultOperationState.Synced or VaultOperationState.Blocked;

    public static VaultArticleState ArticleState(VaultOperationState state)
        => state switch
        {
            VaultOperationState.ExecutingServer or VaultOperationState.MaterializingLocal => VaultArticleState.Applying,
            VaultOperationState.Synced => VaultArticleState.Synced,
            _ => VaultArticleState.Blocked
        };

    public static void Require(ArticleVaultValidationResult validation)
    {
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }
    }

    private static bool IsReference(VaultOperationStageReference? reference)
        => reference is null || ArticleVaultManifestValidator.IsIdentity(reference.Reference)
            && ArticleVaultManifestValidator.IsSha256(reference.ContentSha256);

    private static bool IsReasonCode(string reasonCode)
        => reasonCode.Length is > 0 and <= 128
            && reasonCode.All(static character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_');

    private static bool CommitTransition(VaultServerCommitDisposition before, VaultServerCommitDisposition after)
        => before == after || (before, after) is
            (VaultServerCommitDisposition.NotStarted, VaultServerCommitDisposition.Unknown)
            or (VaultServerCommitDisposition.Unknown, VaultServerCommitDisposition.Accepted)
            or (VaultServerCommitDisposition.Unknown, VaultServerCommitDisposition.Rejected);

    private static bool StateTransition(VaultOperationState before, VaultOperationState after)
        => after == VaultOperationState.Blocked
            || (before, after) is
                (VaultOperationState.Planned, VaultOperationState.Validating)
                or (VaultOperationState.Planned, VaultOperationState.Cancelled)
                or (VaultOperationState.Validating, VaultOperationState.ExecutingServer)
                or (VaultOperationState.Validating, VaultOperationState.Cancelled)
                or (VaultOperationState.Validating, VaultOperationState.Failed)
                or (VaultOperationState.ExecutingServer, VaultOperationState.MaterializingLocal)
                or (VaultOperationState.ExecutingServer, VaultOperationState.RecoveryRequired)
                or (VaultOperationState.ExecutingServer, VaultOperationState.Failed)
                or (VaultOperationState.ExecutingServer, VaultOperationState.Cancelled)
                or (VaultOperationState.MaterializingLocal, VaultOperationState.RecoveryRequired)
                or (VaultOperationState.RecoveryRequired, VaultOperationState.MaterializingLocal)
                or (VaultOperationState.RecoveryRequired, VaultOperationState.RecoveryRequired)
                or (VaultOperationState.RecoveryRequired, VaultOperationState.Failed)
                or (VaultOperationState.RecoveryRequired, VaultOperationState.Cancelled);

    private static ArticleVaultValidationResult Invalid(string reasonCode)
        => ArticleVaultValidationResult.Invalid(reasonCode);
}
