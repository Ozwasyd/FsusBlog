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
    /// <summary>The parent digest before the first journal entry.</summary>
    public static string GenesisDigest { get; } = new('0', 64);
    private readonly OfflineMigrationPlan _plan;
    private readonly CurrentSchemaArtifactReference _reference;
    private readonly string _invocation;
    private readonly List<OfflineMigrationApplyJournalEntry> _proofs = [];
    private OfflineMigrationApplyJournalEntry? _last;
    private OfflineMigrationApplyJournalEntry? _unit;
    private int _attempt;
    private bool _active;
    private bool _completed;

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

    /// <summary>The last verified entry, or null before the first entry.</summary>
    public OfflineMigrationApplyJournalEntry? Last => _last;
    /// <summary>One recorded final proof per completed step, not independently verified DB facts.</summary>
    public ImmutableArray<OfflineMigrationApplyJournalEntry> StepProofs => _proofs.ToImmutableArray();
    /// <summary>The last committed batch for the unfinished step, if any.</summary>
    public OfflineMigrationApplyJournalEntry? PendingUnit => _unit;
    /// <summary>Whether the chain contains an exact all-steps terminal event.</summary>
    public bool Completed => _completed;

    private OfflineMigrationApplyJournalVerifier(OfflineMigrationApplyJournalVerifier source)
    {
        _plan = source._plan;
        _reference = source._reference;
        _invocation = source._invocation;
        _proofs.AddRange(source._proofs);
        _last = source._last;
        _unit = source._unit;
        _attempt = source._attempt;
        _active = source._active;
        _completed = source._completed;
    }

    /// <summary>Stage a bounded state copy before committing an atomic database unit.</summary>
    public OfflineMigrationApplyJournalVerifier Fork() => new(this);

    /// <summary>Validate and advance one ordered entry; rejects edits, gaps and invalid transitions.</summary>
    public void Accept(OfflineMigrationApplyJournalEntry entry)
    {
        if (_completed || entry.Format != Format || entry.Plan != _reference || entry.PlanContentDigest != _plan.ContentDigest
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
                case OfflineMigrationApplyJournalState.TransactionCommitted:
                case OfflineMigrationApplyJournalState.BatchCommitted:
                case OfflineMigrationApplyJournalState.StepVerified:
                    AcceptStep(entry);
                    break;
                case OfflineMigrationApplyJournalState.ApplyCompleted:
                    if (_proofs.Count != _plan.OrderedSteps.Length || _unit is not null || !ControlShape(entry)
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

        _last = entry;
    }

    /// <summary>Require the exact supplied immutable head after streaming its entire parent chain.</summary>
    public void Complete(OfflineMigrationApplyCheckpoint checkpoint)
    {
        if (_last is null || checkpoint.InvocationId != _invocation || checkpoint.Sequence != _last.Sequence
            || checkpoint.JournalHead != Reference(_last))
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

    private static bool ControlShape(OfflineMigrationApplyJournalEntry entry)
        => entry.StepId is null && entry.OperationReference is null && entry.Mode is null
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
        => Digest(observation with { ContentDigest = string.Empty });
    /// <summary>
    /// SHA of the canonical artifact bytes actually published by the plan writer, including
    /// its self-digest field. Admission must also hash and compare the original file bytes;
    /// this is intentionally different from the plan payload's semantic ContentDigest.
    /// </summary>
    public static string ComputePlanArtifactDigest(OfflineMigrationPlan plan)
        => Convert.ToHexStringLower(SHA256.HashData(OfflineMigrationPlanCodec.Serialize(plan)));
    /// <summary>Canonical journal entry digest, excluding the digest field itself.</summary>
    public static string ComputeEntryDigest(OfflineMigrationApplyJournalEntry entry)
        => Digest(entry with { ContentDigest = string.Empty });
    /// <summary>Semantic entry anchor, not the byte SHA of an exported artifact.</summary>
    public static OfflineMigrationJournalAnchor Reference(OfflineMigrationApplyJournalEntry entry)
        => new($"offline-apply/v1/{entry.ContentDigest}", entry.ContentDigest);
    private static string Digest<T>(T value)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value)));
}
