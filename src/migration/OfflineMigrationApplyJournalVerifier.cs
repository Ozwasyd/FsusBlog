using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>
/// Streaming integrity check for an exact invocation. This checks recorded structure, not
/// database truth, artifact authenticity, or authority to start an application. Independent
/// verification must re-read the operation owner's predicates on the actual database.
/// </summary>
public sealed class OfflineMigrationApplyJournalVerifier
{
    /// <summary>The supported journal format.</summary>
    public const string Format = "fsusblog.offline-migration-apply.v1";
    internal const string MediaFormat = "fsusblog.offline-migration-apply.v2";
    /// <summary>The parent digest before the first journal entry.</summary>
    public static string GenesisDigest { get; } = new('0', 64);
    private readonly OfflineMigrationPlan _plan;
    private readonly CurrentSchemaArtifactReference _reference;
    private readonly string _invocation;
    private readonly List<OfflineMigrationApplyJournalEntry> _proofs = [];
    private OfflineMigrationApplyJournalEntry? _first;
    private OfflineMigrationApplyJournalEntry? _last;
    private OfflineMigrationApplyJournalEntry? _unit;
    private int _attempt;
    private bool _active;
    private bool _completed;
    private readonly HashSet<string> _mediaSteps = new(StringComparer.Ordinal);
    private OfflineMigrationApplyJournalEntry? _media;
    private bool _ownersBound;

    /// <summary>Bind a nonempty sealed plan, explicit artifact, and exact invocation.</summary>
    public OfflineMigrationApplyJournalVerifier(
        OfflineMigrationPlan plan, CurrentSchemaArtifactReference reference, string invocationId)
    {
        if (plan.OrderedSteps.IsDefaultOrEmpty || reference.Sha256 != ComputePlanArtifactDigest(plan)
            || plan.ContentDigest != OfflineMigrationPlanCodec.ComputeContentDigest(plan)
            || string.IsNullOrWhiteSpace(reference.Reference) || string.IsNullOrWhiteSpace(invocationId))
        {
            throw new InvalidOperationException("offline_apply_plan_binding_invalid");
        }

        _plan = plan;
        _reference = reference;
        _invocation = invocationId;
    }

    /// <summary>The first successfully accepted entry, or null before any entry is accepted.</summary>
    public OfflineMigrationApplyJournalEntry? First => _first;
    /// <summary>The last verified entry, or null before the first entry.</summary>
    public OfflineMigrationApplyJournalEntry? Last => _last;
    /// <summary>One recorded final proof per completed step, not independently verified DB facts.</summary>
    public ImmutableArray<OfflineMigrationApplyJournalEntry> StepProofs => _proofs.ToImmutableArray();
    /// <summary>The last committed batch for the unfinished step, if any.</summary>
    public OfflineMigrationApplyJournalEntry? PendingUnit => _unit;
    /// <summary>Whether the chain contains an exact all-steps terminal event.</summary>
    public bool Completed => _completed;
    internal OfflineMigrationApplyJournalEntry? PendingMedia => _media;
    internal bool RequiresMedia(string stepId) => _mediaSteps.Contains(stepId);

    // Called by apply and the independent native issuer before streaming any entry.
    // Requirements come only from the exact compiled registry, not caller flags or JSON.
    internal void BindOperationOwners(IOfflineMigrationApplyOperationRegistry registry)
    {
        if (_first is not null || _ownersBound)
            throw new InvalidOperationException("offline_apply_owner_binding_late");
        var media = new HashSet<string>(StringComparer.Ordinal);
        foreach (OfflineMigrationStep step in _plan.OrderedSteps)
            foreach (OfflineMigrationProviderOperation identity in step.Operations)
            {
                OfflineMigrationApplyOperation operation = registry.Resolve(step, identity);
                if (operation.Identity != identity)
                    throw new InvalidOperationException("offline_apply_operation_binding_changed");
                if (operation is OfflineMigrationArticleMediaOperation)
                {
                    if (identity.Mode != OfflineMigrationExecutionMode.Transaction)
                        throw new InvalidOperationException("offline_apply_media_transaction_required");
                    if (identity.Provider == _plan.Source.Database.Provider)
                        media.Add(step.StepId);
                }
            }
        _mediaSteps.UnionWith(media);
        _ownersBound = true;
    }

    private OfflineMigrationApplyJournalVerifier(OfflineMigrationApplyJournalVerifier source)
    {
        _plan = source._plan;
        _reference = source._reference;
        _invocation = source._invocation;
        _proofs.AddRange(source._proofs);
        _first = source._first;
        _last = source._last;
        _unit = source._unit;
        _attempt = source._attempt;
        _active = source._active;
        _completed = source._completed;
        _mediaSteps.UnionWith(source._mediaSteps);
        _media = source._media;
        _ownersBound = source._ownersBound;
    }

    /// <summary>Stage a bounded state copy before committing an atomic database unit.</summary>
    public OfflineMigrationApplyJournalVerifier Fork() => new(this);

    /// <summary>Validate and advance one ordered entry; rejects edits, gaps and invalid transitions.</summary>
    public void Accept(OfflineMigrationApplyJournalEntry entry)
    {
        if (_completed || entry.Format != (entry.Media is null ? Format : MediaFormat)
            || entry.Plan != _reference || entry.PlanContentDigest != _plan.ContentDigest
            || entry.Database != _plan.Source.Database || entry.InvocationId != _invocation
            || entry.Sequence != (_last?.Sequence ?? 0) + 1
            || entry.PreviousDigest != (_last?.ContentDigest ?? GenesisDigest)
            || entry.ContentDigest != ComputeEntryDigest(entry)
            || entry.RecordedAt.Offset != TimeSpan.Zero || entry.RowsProcessed < 0 || entry.ExpectedRows < 0
            || entry.RowsProcessed > entry.ExpectedRows)
        {
            throw new InvalidOperationException("offline_apply_journal_binding_invalid");
        }

        if (entry.State == OfflineMigrationApplyJournalState.AttemptStarted)
        {
            if (_active || entry.Attempt != _attempt + 1 || !ControlShape(entry) || entry.FailureCode is not null)
            {
                throw new InvalidOperationException("offline_apply_attempt_invalid");
            }

            _attempt = entry.Attempt;
            _active = true;
        }
        else
        {
            if (!_active || entry.Attempt != _attempt)
            {
                throw new InvalidOperationException("offline_apply_attempt_missing");
            }

            switch (entry.State)
            {
                case OfflineMigrationApplyJournalState.MediaPrepared:
                case OfflineMigrationApplyJournalState.MediaPublished:
                    AcceptMedia(entry);
                    break;
                case OfflineMigrationApplyJournalState.TransactionCommitted:
                case OfflineMigrationApplyJournalState.BatchCommitted:
                case OfflineMigrationApplyJournalState.StepVerified:
                    AcceptStep(entry);
                    break;
                case OfflineMigrationApplyJournalState.ApplyCompleted:
                    if (_proofs.Count != _plan.OrderedSteps.Length || _unit is not null || _media is not null || !ControlShape(entry)
                        || entry.FailureCode is not null)
                    {
                        throw new InvalidOperationException("offline_apply_terminal_incomplete");
                    }

                    _completed = true;
                    _active = false;
                    break;
                case OfflineMigrationApplyJournalState.AttemptFailed:
                case OfflineMigrationApplyJournalState.AttemptCancelled:
                case OfflineMigrationApplyJournalState.RecoveryRequired:
                    if (!ControlShape(entry) || entry.FailureCode is not ("offline_apply_rejected"
                        or "offline_apply_cancelled" or "offline_apply_prior_attempt_interrupted"))
                    {
                        throw new InvalidOperationException("offline_apply_failure_shape_invalid");
                    }

                    _active = false;
                    break;
                default:
                    throw new InvalidOperationException("offline_apply_journal_state_unknown");
            }
        }

        _first ??= entry;
        _last = entry;
    }

    /// <summary>Require the exact supplied immutable head after streaming its entire parent chain.</summary>
    public void Complete(OfflineMigrationApplyCheckpoint checkpoint)
    {
        if (_last is null || checkpoint.InvocationId != _invocation || checkpoint.Sequence != _last.Sequence
            || checkpoint.JournalHead != Reference(_last)
            || _media?.State == OfflineMigrationApplyJournalState.MediaPublished && _unit is null)
        {
            throw new InvalidOperationException("offline_apply_checkpoint_mismatch");
        }
    }

    private void AcceptStep(OfflineMigrationApplyJournalEntry entry)
    {
        if (_proofs.Count >= _plan.OrderedSteps.Length)
        {
            throw new InvalidOperationException("offline_apply_unplanned_step");
        }

        OfflineMigrationStep step = _plan.OrderedSteps[_proofs.Count];
        OfflineMigrationProviderOperation operation = step.Operations.Single(value => value.Provider == entry.Database.Provider);
        if (entry.StepId != step.StepId || entry.OperationReference != operation.OperationReference
            || entry.Mode != operation.Mode || entry.IdempotencyKey != step.IdempotencyDefinition
            || entry.Before is null || entry.After is null || entry.FailureCode is not null
            || !ObservationValid(entry.Before, operation) || !ObservationValid(entry.After, operation))
        {
            throw new InvalidOperationException("offline_apply_step_binding_invalid");
        }

        if (_mediaSteps.Contains(step.StepId))
        {
            if (_media?.State != OfflineMigrationApplyJournalState.MediaPublished
                || entry.Media != _media.Media || entry.Media?.GenerationIdentity is null
                || entry.Mode != OfflineMigrationExecutionMode.Transaction || !entry.UnitComplete
                || entry.State != OfflineMigrationApplyJournalState.StepVerified
                    && entry.Before.ContentDigest != _media.Before!.ContentDigest)
                throw new InvalidOperationException("offline_apply_media_not_published");
        }
        else if (entry.Media is not null)
            throw new InvalidOperationException("offline_apply_media_owner_missing");

        if (entry.State == OfflineMigrationApplyJournalState.StepVerified)
        {
            if (_unit is null || !_unit.UnitComplete || !entry.UnitComplete
                || entry.After.PredicateReference != step.TargetPostcondition
                || entry.RowsProcessed != _unit.RowsProcessed || entry.ExpectedRows != _unit.ExpectedRows
                || entry.WatermarkBefore != _unit.WatermarkBefore || entry.WatermarkAfter != _unit.WatermarkAfter
                || entry.HighWatermark != _unit.HighWatermark || entry.After.ContentDigest != _unit.After!.ContentDigest)
            {
                throw new InvalidOperationException("offline_apply_step_not_committed");
            }

            bool originalBefore = entry.Before.PredicateReference == _unit.Before!.PredicateReference
                && entry.Before.ContentDigest == _unit.Before.ContentDigest;
            bool recoveredTarget = entry.Before.PredicateReference == step.TargetPostcondition
                && entry.Before.ContentDigest == _unit.After.ContentDigest;
            if (!originalBefore && !recoveredTarget)
            {
                throw new InvalidOperationException("offline_apply_step_before_changed");
            }

            _proofs.Add(entry);
            _unit = null;
            _media = null;
            return;
        }

        string beforeReference = _unit is null ? step.SourcePrecondition : step.ResumePolicy.ReplayPostcondition;
        if (entry.Before.PredicateReference != beforeReference
            || entry.After.PredicateReference != (entry.UnitComplete ? step.TargetPostcondition : step.ResumePolicy.ReplayPostcondition)
            || (_unit is not null && (_unit.UnitComplete || entry.WatermarkBefore != _unit.WatermarkAfter
                || entry.HighWatermark != _unit.HighWatermark || entry.ExpectedRows != _unit.ExpectedRows
                || entry.RowsProcessed < _unit.RowsProcessed)))
        {
            throw new InvalidOperationException("offline_apply_progress_invalid");
        }

        if (operation.Mode == OfflineMigrationExecutionMode.Transaction)
        {
            if (entry.State != OfflineMigrationApplyJournalState.TransactionCommitted || !entry.UnitComplete || _unit is not null)
            {
                throw new InvalidOperationException("offline_apply_transaction_shape_invalid");
            }
        }
        else if (entry.State != OfflineMigrationApplyJournalState.BatchCommitted
            || string.IsNullOrWhiteSpace(entry.HighWatermark)
            || (!entry.UnitComplete && entry.WatermarkAfter == entry.WatermarkBefore)
            || entry.RowsProcessed - (_unit?.RowsProcessed ?? 0) > step.ResumePolicy.MaximumBatchRows)
        {
            throw new InvalidOperationException("offline_apply_batch_shape_invalid");
        }

        if (entry.UnitComplete && entry.RowsProcessed != entry.ExpectedRows)
        {
            throw new InvalidOperationException("offline_apply_row_count_mismatch");
        }

        _unit = entry;
    }

    private void AcceptMedia(OfflineMigrationApplyJournalEntry entry)
    {
        if (!_ownersBound || _proofs.Count >= _plan.OrderedSteps.Length || _unit is not null)
            throw new InvalidOperationException("offline_apply_media_owner_missing");
        OfflineMigrationStep step = _plan.OrderedSteps[_proofs.Count];
        OfflineMigrationProviderOperation operation = step.Operations.Single(value => value.Provider == entry.Database.Provider);
        if (!_mediaSteps.Contains(step.StepId) || entry.StepId != step.StepId || entry.OperationReference != operation.OperationReference
            || entry.Mode != OfflineMigrationExecutionMode.Transaction || entry.IdempotencyKey != step.IdempotencyDefinition
            || entry.RowsProcessed != 0 || entry.ExpectedRows != 0 || entry.UnitComplete
            || entry.WatermarkBefore is not null || entry.WatermarkAfter is not null || entry.HighWatermark is not null
            || entry.FailureCode is not null || entry.Before is null || entry.After is not null
            || entry.Before.PredicateReference != step.SourcePrecondition || !ObservationValid(entry.Before, operation)
            || !MediaBindingValid(entry.Media))
            throw new InvalidOperationException("offline_apply_media_binding_invalid");
        if (entry.State == OfflineMigrationApplyJournalState.MediaPrepared)
        {
            if (_media is not null || entry.Media!.GenerationIdentity is not null)
                throw new InvalidOperationException("offline_apply_media_preparation_repeated");
        }
        else if (_media?.State != OfflineMigrationApplyJournalState.MediaPrepared
            || (entry.Media! with
            {
                GenerationIdentity = null
            }) != _media.Media
            || entry.Before.ContentDigest != _media.Before!.ContentDigest
            || string.IsNullOrWhiteSpace(entry.Media.GenerationIdentity) || entry.Media.GenerationIdentity.Length > 4096
            || entry.Media.GenerationIdentity.Any(char.IsControl))
            throw new InvalidOperationException("offline_apply_media_publication_cas_invalid");
        _media = entry;
    }

    private bool MediaBindingValid(OfflineMigrationMediaJournalEvidence? evidence)
    {
        if (evidence?.Binding is not { } binding)
            return false;
        return evidence.InvocationId == _invocation && binding.RunId != Guid.Empty
            && binding.PlanArtifactSha256 == _reference.Sha256 && binding.PlanContentDigest == _plan.ContentDigest
            && binding.SourceContentDigest == _plan.Source.ContentDigest && DigestValid(binding.ManifestDigest)
            && !string.IsNullOrWhiteSpace(binding.SourceRootIdentity) && binding.SourceRootIdentity.Length <= 4096
            && !binding.SourceRootIdentity.Any(char.IsControl)
            && !string.IsNullOrWhiteSpace(binding.TargetRootIdentity) && binding.TargetRootIdentity.Length <= 4096
            && !binding.TargetRootIdentity.Any(char.IsControl)
            && !string.IsNullOrWhiteSpace(binding.TargetDirectoryName) && binding.TargetDirectoryName.Length <= 255
            && binding.TargetDirectoryName is not ("." or "..") && !binding.TargetDirectoryName.Any(char.IsControl)
            && !binding.TargetDirectoryName.Contains('/') && !binding.TargetDirectoryName.Contains('\\')
            && !binding.TargetDirectoryName.StartsWith(".media-", StringComparison.Ordinal);
    }

    private static bool DigestValid(string value)
        => value is { Length: 64 } && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool ControlShape(OfflineMigrationApplyJournalEntry entry)
        => entry.Media is null && entry.StepId is null && entry.OperationReference is null && entry.Mode is null
            && entry.IdempotencyKey is null && entry.Before is null && entry.After is null
            && entry.WatermarkBefore is null && entry.WatermarkAfter is null && entry.HighWatermark is null
            && entry.RowsProcessed == 0 && entry.ExpectedRows == 0 && !entry.UnitComplete;

    private static bool ObservationValid(OfflineMigrationPredicateObservation observation, OfflineMigrationProviderOperation operation)
        => observation.OperationReference == operation.OperationReference
            && observation.OperationSourceDigest == operation.OperationSourceDigest
            && observation.SemanticDigest == operation.SemanticDigest
            && observation.ContentDigest == ComputeObservationDigest(observation)
            && FactsValid(observation.ExpectedFacts) && FactsValid(observation.ActualFacts)
            && observation.ExpectedFacts.SequenceEqual(observation.ActualFacts);

    private static bool FactsValid(ImmutableArray<OfflineMigrationFact> facts)
        => !facts.IsDefault && facts.Length <= 256
            && facts.All(value => !string.IsNullOrWhiteSpace(value.Name) && value.Name.Length <= 160
                && value.Value is not null && value.Value.Length <= 4096)
            && facts.Select(value => value.Name).SequenceEqual(facts.Select(value => value.Name).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal));

    /// <summary>Canonical observation digest; expected facts still require independent owner admission.</summary>
    public static string ComputeObservationDigest(OfflineMigrationPredicateObservation observation)
        => Digest(observation with
        {
            ContentDigest = string.Empty
        });
    /// <summary>
    /// SHA of the canonical artifact bytes actually published by the plan writer, including
    /// its self-digest field. Admission must also hash and compare the original file bytes;
    /// this is intentionally different from the plan payload's semantic ContentDigest.
    /// </summary>
    public static string ComputePlanArtifactDigest(OfflineMigrationPlan plan)
        => Convert.ToHexStringLower(SHA256.HashData(OfflineMigrationPlanCodec.Serialize(plan)));
    /// <summary>Canonical journal entry digest, excluding the digest field itself.</summary>
    public static string ComputeEntryDigest(OfflineMigrationApplyJournalEntry entry)
        => Digest(entry with
        {
            ContentDigest = string.Empty
        });
    /// <summary>Semantic entry anchor, not the byte SHA of an exported artifact.</summary>
    public static OfflineMigrationJournalAnchor Reference(OfflineMigrationApplyJournalEntry entry)
        => new($"offline-apply/{(entry.Format == MediaFormat ? "v2" : "v1")}/{entry.ContentDigest}", entry.ContentDigest);
    private static string Digest<T>(T value)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value)));
}
