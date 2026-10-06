using System.Globalization;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independent structural verifier for definition receipts and audit bindings. It replays
/// only definition facts; it intentionally has no article-value or query implementation.
/// </summary>
public sealed class ArticlePropertyDefinitionVerifier(IConfiguration? configuration = null)
{
    private readonly byte[]? _auditKey = configuration is null ? null : AuditTamperEvidence.ResolveKey(configuration);

    public ArticlePropertyDefinitionVerificationResult Verify(
        ArticlePropertyDefinitionVerificationSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var violations = new List<ArticlePropertyDefinitionVerificationViolation>();
        bool definitionValid = true;
        try
        {
            ArticlePropertyDefinitionContract.ValidateDefinition(snapshot.Definition);
        }
        catch (ArticlePropertyDefinitionValidationException exception)
        {
            definitionValid = false;
            violations.Add(new("definition_tamper", exception.Code));
        }
        catch (ArticlePropertyDefinitionBudgetExceededException exception)
        {
            definitionValid = false;
            violations.Add(new("definition_tamper", exception.Code));
        }

        if (snapshot.ReceiptLimitExceeded)
        {
            violations.Add(new("receipt_budget_exceeded", "verification receipt history is incomplete"));
        }

        var receipts = snapshot.Receipts
            .OrderBy(static receipt => receipt.SchemaRevision)
            .ThenBy(static receipt => receipt.OwnerRevision)
            .ToArray();
        var receiptIds = new HashSet<Guid>();
        var requestIds = new HashSet<(long Actor, Guid Request)>();
        var receiptsById = new Dictionary<Guid, ArticlePropertyDefinitionWriteReceipt>();
        var allowedCommands = new HashSet<string>(StringComparer.Ordinal)
        {
            "create",
            "change-settings",
            "rename",
            "deprecate",
            "delete"
        };
        foreach (ArticlePropertyDefinitionWriteReceipt receipt in receipts)
        {
            if (!receiptIds.Add(receipt.ReceiptId))
            {
                violations.Add(new("receipt_duplicate", receipt.ReceiptId.ToString("D")));
            }
            receiptsById.TryAdd(receipt.ReceiptId, receipt);
            if (!requestIds.Add((receipt.ActorAdminPrincipalId, receipt.RequestId)))
            {
                violations.Add(new("receipt_request_duplicate", receipt.RequestId.ToString("D")));
            }
            bool receiptValid = true;
            try
            {
                ArticlePropertyDefinitionContract.ValidateReceipt(receipt);
            }
            catch (ArticlePropertyDefinitionValidationException exception)
            {
                receiptValid = false;
                violations.Add(new("receipt_tamper", $"{receipt.ReceiptId:D}:{exception.Code}"));
            }
            if (receipt.Owner != snapshot.Definition.Owner
                || receipt.DefinitionId != snapshot.Definition.DefinitionId)
            {
                violations.Add(new("receipt_scope_mismatch", receipt.ReceiptId.ToString("D")));
            }
            if (!allowedCommands.Contains(receipt.CommandKind))
            {
                violations.Add(new("receipt_command_unknown", receipt.ReceiptId.ToString("D")));
            }
            if (receiptValid)
            {
                string expectedAuditDigest = ArticlePropertyDefinitionContract.ComputeReceiptAuditDigest(receipt);
                if (!string.Equals(receipt.AuditDigest, expectedAuditDigest, StringComparison.Ordinal))
                {
                    violations.Add(new("audit_digest_mismatch", receipt.ReceiptId.ToString("D")));
                }
            }
        }

        if (receipts.Length > 0 && (receipts[0].SchemaRevision != 1
            || receipts[0].PreviousSchemaRevision != 0
            || !string.Equals(receipts[0].CommandKind, "create", StringComparison.Ordinal)
            || receipts[0].Status != ArticlePropertyDefinitionStatus.Active
            || !string.Equals(receipts[0].BeforeDefinitionDigest,
                ArticlePropertyDefinitionContract.ComputeCommandDigest("absent", snapshot.Definition.DefinitionId),
                StringComparison.Ordinal)))
        {
            violations.Add(new("schema_revision_origin_invalid", receipts[0].ReceiptId.ToString("D")));
        }
        for (int index = 1; index < receipts.Length; index++)
        {
            ArticlePropertyDefinitionWriteReceipt previous = receipts[index - 1];
            ArticlePropertyDefinitionWriteReceipt current = receipts[index];
            if (current.SchemaRevision != previous.SchemaRevision + 1
                || current.PreviousSchemaRevision != previous.SchemaRevision)
            {
                violations.Add(new("schema_revision_gap", current.ReceiptId.ToString("D")));
            }
            if (!string.Equals(current.BeforeDefinitionDigest, previous.AfterDefinitionDigest, StringComparison.Ordinal))
            {
                violations.Add(new("definition_digest_chain_mismatch", current.ReceiptId.ToString("D")));
            }
            if (current.PreviousOwnerRevision < previous.OwnerRevision)
            {
                violations.Add(new("owner_revision_order_invalid", current.ReceiptId.ToString("D")));
            }
            if (string.Equals(current.CommandKind, "create", StringComparison.Ordinal))
            {
                violations.Add(new("receipt_create_repeated", current.ReceiptId.ToString("D")));
            }
            if (string.Equals(current.CommandKind, "rename", StringComparison.Ordinal)
                && current.Status != previous.Status)
            {
                violations.Add(new("rename_status_changed", current.ReceiptId.ToString("D")));
            }
            if (previous.Status == ArticlePropertyDefinitionStatus.Deleted
                || (string.Equals(current.CommandKind, "change-settings", StringComparison.Ordinal)
                    && current.Status != previous.Status))
            {
                violations.Add(new("settings_or_deleted_transition_invalid", current.ReceiptId.ToString("D")));
            }
            if ((current.CommandKind is "rename" or "deprecate" or "delete")
                && (!string.Equals(current.ConstraintDigest, previous.ConstraintDigest, StringComparison.Ordinal)
                    || !string.Equals(current.OptionsDigest, previous.OptionsDigest, StringComparison.Ordinal)
                    || !string.Equals(current.PolicyDigest, previous.PolicyDigest, StringComparison.Ordinal)
                    || !string.Equals(current.FlagsDigest, previous.FlagsDigest, StringComparison.Ordinal)))
            {
                violations.Add(new("lifecycle_settings_changed", current.ReceiptId.ToString("D")));
            }
            if (string.Equals(current.CommandKind, "deprecate", StringComparison.Ordinal)
                && (previous.Status != ArticlePropertyDefinitionStatus.Active
                    || current.Status != ArticlePropertyDefinitionStatus.Deprecated))
            {
                violations.Add(new("deprecate_transition_invalid", current.ReceiptId.ToString("D")));
            }
            if (string.Equals(current.CommandKind, "delete", StringComparison.Ordinal)
                && (previous.Status != ArticlePropertyDefinitionStatus.Deprecated
                    || current.Status != ArticlePropertyDefinitionStatus.Deleted))
            {
                violations.Add(new("delete_transition_invalid", current.ReceiptId.ToString("D")));
            }
        }

        if (receipts.Length > 0)
        {
            ArticlePropertyDefinitionWriteReceipt latest = receipts[^1];
            if (!string.Equals(latest.AfterDefinitionDigest, snapshot.Definition.ContentDigest, StringComparison.Ordinal)
                || latest.SchemaRevision != snapshot.Definition.SchemaRevision
                || latest.Status != snapshot.Definition.Status)
            {
                violations.Add(new("latest_receipt_mismatch", latest.ReceiptId.ToString("D")));
            }
            if (definitionValid
                && (!string.Equals(latest.ConstraintDigest,
                        ArticlePropertyDefinitionContract.ComputeConstraintDigest(snapshot.Definition.Constraints), StringComparison.Ordinal)
                    || !string.Equals(latest.OptionsDigest,
                        ArticlePropertyDefinitionContract.ComputeOptionsDigest(snapshot.Definition.Options), StringComparison.Ordinal)
                    || !string.Equals(latest.PolicyDigest,
                        ArticlePropertyDefinitionContract.ComputePolicyDigest(snapshot.Definition.ReferencePolicy, snapshot.Definition.UrlPolicy), StringComparison.Ordinal)
                    || !string.Equals(latest.FlagsDigest,
                        ArticlePropertyDefinitionContract.ComputeFlagsDigest(snapshot.Definition), StringComparison.Ordinal)))
            {
                violations.Add(new("latest_receipt_facts_mismatch", latest.ReceiptId.ToString("D")));
            }
        }
        else
        {
            violations.Add(new("receipt_missing", snapshot.Definition.DefinitionId.ToString("D")));
        }

        var idempotencyByReceipt = new Dictionary<Guid, ArticlePropertyDefinitionIdempotencyRecord>();
        foreach (ArticlePropertyDefinitionIdempotencyRecord record in snapshot.IdempotencyRecords)
        {
            if (record.ActorAdminPrincipalId <= 0
                || record.RequestId == Guid.Empty
                || record.ReceiptId == Guid.Empty
                || !idempotencyByReceipt.TryAdd(record.ReceiptId, record))
            {
                violations.Add(new("idempotency_tamper", record.ReceiptId.ToString("D")));
                continue;
            }
            if (!receiptsById.TryGetValue(record.ReceiptId, out ArticlePropertyDefinitionWriteReceipt? receipt)
                || receipt.RequestId != record.RequestId
                || receipt.ActorAdminPrincipalId != record.ActorAdminPrincipalId
                || !string.Equals(receipt.CommandDigest, record.CommandDigest, StringComparison.Ordinal))
            {
                violations.Add(new("idempotency_receipt_mismatch", record.ReceiptId.ToString("D")));
            }
        }

        var auditByReference = new Dictionary<Guid, ArticlePropertyDefinitionAuditLink>();
        foreach (ArticlePropertyDefinitionAuditLink link in snapshot.AuditLinks)
        {
            if (!auditByReference.TryAdd(link.AuditReference, link))
            {
                violations.Add(new("audit_link_duplicate", link.AuditReference.ToString("D")));
            }
        }
        foreach (ArticlePropertyDefinitionWriteReceipt receipt in receipts)
        {
            if (!idempotencyByReceipt.ContainsKey(receipt.ReceiptId))
            {
                violations.Add(new("idempotency_missing", receipt.ReceiptId.ToString("D")));
            }
            if (!auditByReference.TryGetValue(receipt.AuditReference, out ArticlePropertyDefinitionAuditLink? link))
            {
                violations.Add(new("audit_link_missing", receipt.AuditReference.ToString("D")));
                continue;
            }
            ArticlePropertyDefinitionJournalEntry? entry = snapshot.Replay?.Entries
                .FirstOrDefault(candidate => candidate?.Receipt?.ReceiptId == receipt.ReceiptId);
            string eventInfo;
            try
            {
                eventInfo = entry is null ? receipt.AuditDigest
                    : ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entry);
            }
            catch (ArticlePropertyDefinitionValidationException exception)
            {
                violations.Add(new("audit_link_tamper", exception.Code));
                continue;
            }
            // Bind the selected receipt to the receipt authenticated by this journal entry.
            // Recomputing a public receipt digest cannot preserve the original audit binding.
            if ((entry is not null && !string.Equals(
                    entry.Receipt.ContentDigest, receipt.ContentDigest, StringComparison.Ordinal))
                || !string.Equals(link.EventInfo, eventInfo, StringComparison.Ordinal)
                || !string.Equals(link.TargetId, receipt.AuditReference.ToString("N"), StringComparison.OrdinalIgnoreCase)
                || !string.Equals(link.Action, AdminPermissions.ArticleWrite, StringComparison.Ordinal)
                || !string.Equals(link.Outcome, "success", StringComparison.Ordinal)
                || !link.IsHighValue)
            {
                violations.Add(new("audit_link_tamper", receipt.AuditReference.ToString("D")));
            }
        }

        VerifyReplay(snapshot, violations);
        return new(
            violations.Count == 0,
            Array.AsReadOnly(violations.ToArray()));
    }

    private void VerifyReplay(
        ArticlePropertyDefinitionVerificationSnapshot snapshot,
        List<ArticlePropertyDefinitionVerificationViolation> violations)
    {
        ArticlePropertyDefinitionReplaySnapshot? replay = snapshot.Replay;
        if (replay is null)
        {
            violations.Add(new("history_unavailable", "original typed commands and authenticated empty genesis are unavailable"));
            return;
        }
        if (replay.Entries is null || replay.Definitions is null || replay.IdempotencyRecords is null
            || replay.AuditRecords is null || replay.HistoryLimitExceeded || replay.AuditLimitExceeded
            || replay.Definitions.Any(static definition => definition is null)
            || replay.IdempotencyRecords.Any(static binding => binding is null)
            || replay.AuditRecords.Any(static record => record is null)
            || replay.ResourceLimitExceeded
            || replay.Entries.Count > ArticlePropertyDefinitionContract.MaxVerificationReceipts
            || replay.Definitions.Count > ArticlePropertyDefinitionContract.MaxVerificationReceipts
            || replay.IdempotencyRecords.Count > ArticlePropertyDefinitionContract.MaxVerificationReceipts
            || replay.AuditRecords.Count > ArticlePropertyDefinitionContract.MaxVerificationReceipts)
        {
            violations.Add(new("history_incomplete", "complete owner command and authenticated audit history exceeds verification admission"));
            return;
        }
        if (replay.HistoryVersion != ArticlePropertyDefinitionCommandHistory.Version
            || replay.Owner != snapshot.Definition.Owner || replay.OwnerRevision <= 0
            || replay.Entries.Count != replay.OwnerRevision
            || replay.GenesisDigest != ArticlePropertyDefinitionCommandHistory.ComputeGenesisDigest(snapshot.Definition.Owner))
        {
            violations.Add(new("history_genesis_or_head_invalid", "owner history must start from the authenticated empty revision-zero genesis"));
            return;
        }
        if (!AdmitReplayResource(replay, violations))
        {
            return;
        }
        Dictionary<Guid, AuditLog> audit = VerifyAuditChains(replay.AuditRecords, violations);
        var bindings = new Dictionary<Guid, ArticlePropertyDefinitionIdempotencyRecord>();
        var requests = new HashSet<(long Actor, Guid Request)>();
        foreach (ArticlePropertyDefinitionIdempotencyRecord binding in replay.IdempotencyRecords)
        {
            if (!bindings.TryAdd(binding.ReceiptId, binding)
                || !requests.Add((binding.ActorAdminPrincipalId, binding.RequestId)))
            {
                violations.Add(new("history_idempotency_duplicate", binding.ReceiptId.ToString("D")));
            }
        }
        var state = new Dictionary<Guid, ArticlePropertyDefinition>();
        var receiptIds = new HashSet<Guid>();
        string previousDigest = replay.GenesisDigest;
        for (int index = 0; index < replay.Entries.Count; index++)
        {
            ArticlePropertyDefinitionJournalEntry entry = replay.Entries[index];
            try
            {
                if (entry is null || entry.Command is null || entry.Impact is null || entry.Receipt is null
                    || entry.Impact.Obligations is null)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_structure_invalid");
                }
                ArticlePropertyDefinitionCommandHistory.Validate(entry.Command);
                ArticlePropertyDefinitionContract.ValidateReceipt(entry.Receipt);
                ArticlePropertyDefinitionWriteReceipt receipt = entry.Receipt;
                ArticlePropertyDefinitionRecordedCommand command = entry.Command;
                if (entry.HistoryVersion != ArticlePropertyDefinitionCommandHistory.Version
                    || entry.Owner != replay.Owner || command.Owner != replay.Owner || receipt.Owner != replay.Owner
                    || entry.Sequence != index + 1 || entry.PreviousDigest != previousDigest
                    || command.ExpectedOwnerRevision != index || receipt.PreviousOwnerRevision != index
                    || receipt.OwnerRevision != entry.Sequence || receipt.CommandKind != command.CommandKind
                    || receipt.DefinitionId != command.DefinitionId || receipt.RequestId != command.RequestId
                    || receipt.ActorAdminPrincipalId != command.Actor.AdminPrincipalId
                    || !receiptIds.Add(receipt.ReceiptId)
                    || entry.ContentDigest != ArticlePropertyDefinitionCommandHistory.ComputeEntryDigest(entry))
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_sequence_or_binding_invalid");
                }
                new ArticlePropertyDefinitionPermissionAuthority().EnsureAllowed(command.Actor, replay.Owner, manage: true);
                state.TryGetValue(command.DefinitionId, out ArticlePropertyDefinition? before);
                if (command.ExpectedSchemaRevision != (before?.SchemaRevision ?? 0)
                    || receipt.PreviousSchemaRevision != (before?.SchemaRevision ?? 0))
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_schema_cas_invalid");
                }
                ArticlePropertyDefinition after = ReplayCommand(command, before, receipt.OccurredAtUtc, state);
                string expectedCommandDigest = ComputeReplayCommandDigest(command, after);
                if (receipt.CommandDigest != expectedCommandDigest
                    || receipt.BeforeDefinitionDigest != (before?.ContentDigest
                        ?? ArticlePropertyDefinitionContract.ComputeCommandDigest("absent", command.DefinitionId))
                    || receipt.AfterDefinitionDigest != after.ContentDigest || receipt.SchemaRevision != after.SchemaRevision
                    || receipt.Status != after.Status
                    || receipt.ConstraintDigest != ArticlePropertyDefinitionContract.ComputeConstraintDigest(after.Constraints)
                    || receipt.OptionsDigest != ArticlePropertyDefinitionContract.ComputeOptionsDigest(after.Options)
                    || receipt.PolicyDigest != ArticlePropertyDefinitionContract.ComputePolicyDigest(after.ReferencePolicy, after.UrlPolicy)
                    || receipt.FlagsDigest != ArticlePropertyDefinitionContract.ComputeFlagsDigest(after)
                    || receipt.AuditDigest != ArticlePropertyDefinitionContract.ComputeReceiptAuditDigest(receipt)
                    || entry.Impact.AffectedValueCount is < 0
                    || ArticlePropertyDefinitionContract.ComputeObligationsDigest(entry.Impact.Obligations)
                        != ArticlePropertyDefinitionContract.ComputeObligationsDigest(receipt.Obligations)
                    || command.CommandKind == "delete" && entry.Impact.AffectedValueCount is null
                    || command.CommandKind is "create" or "rename" && entry.Impact.AffectedValueCount != 0
                    || command.CommandKind is "change-settings" or "deprecate"
                        && entry.Impact.AffectedValueCount is null
                        && !entry.Impact.Obligations.Any(static obligation => obligation.RequiresReconciliation))
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_replayed_facts_invalid");
                }
                if (!bindings.TryGetValue(receipt.ReceiptId, out ArticlePropertyDefinitionIdempotencyRecord? binding)
                    || binding.ActorAdminPrincipalId != receipt.ActorAdminPrincipalId
                    || binding.RequestId != receipt.RequestId || binding.CommandDigest != expectedCommandDigest)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_idempotency_invalid");
                }
                if (!audit.TryGetValue(receipt.AuditReference, out AuditLog? record)
                    || record.EventInfo != ArticlePropertyDefinitionCommandHistory.ComputeAuditEventInfo(entry)
                    || record.ActorId != command.Actor.AdminPrincipalId.ToString(CultureInfo.InvariantCulture)
                    || record.ActorType != AuditActorTypeCatalog.Admin || record.Action != AdminPermissions.ArticleWrite
                    || record.Outcome != AuditOutcomeCatalog.Success || !record.IsHighValue
                    || record.TargetType != "article-property-definition-receipt"
                    || record.TargetId != receipt.AuditReference.ToString("N")
                    || record.ReasonCode != command.CommandKind || record.OccurredAtUtc != receipt.OccurredAtUtc)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_authenticated_audit_binding_invalid");
                }
                state[command.DefinitionId] = after;
                previousDigest = entry.ContentDigest;
            }
            catch (ArticlePropertyDefinitionValidationException exception)
            {
                violations.Add(new("history_replay_invalid", $"{index + 1}:{exception.Code}"));
                return; // Never use a malformed command/receipt as the next replay state.
            }
            catch (ArticlePropertyDefinitionAccessDeniedException)
            {
                violations.Add(new("history_permission_invalid", (index + 1).ToString(CultureInfo.InvariantCulture)));
                return;
            }
            catch (ArticlePropertyDefinitionBudgetExceededException exception)
            {
                violations.Add(new("history_replay_invalid", $"{index + 1}:{exception.Code}"));
                return;
            }
        }
        if (previousDigest != replay.HeadDigest || bindings.Count != replay.Entries.Count
            || state.Count != replay.Definitions.Count)
        {
            violations.Add(new("history_final_projection_invalid", "owner head, bindings or definition/tombstone count differs from replay"));
        }
        var seen = new HashSet<Guid>();
        foreach (ArticlePropertyDefinition actual in replay.Definitions)
        {
            try
            {
                ArticlePropertyDefinitionContract.ValidateDefinition(actual);
                if (actual.Owner != replay.Owner || !seen.Add(actual.DefinitionId)
                    || !state.TryGetValue(actual.DefinitionId, out ArticlePropertyDefinition? expected)
                    || actual.ContentDigest != expected.ContentDigest)
                {
                    violations.Add(new("history_current_fact_mismatch", actual.DefinitionId.ToString("D")));
                }
            }
            catch (ArticlePropertyDefinitionValidationException exception)
            {
                violations.Add(new("history_current_fact_invalid", exception.Code));
            }
        }
        if (!state.TryGetValue(snapshot.Definition.DefinitionId, out ArticlePropertyDefinition? target)
            || target.ContentDigest != snapshot.Definition.ContentDigest)
        {
            violations.Add(new("history_target_projection_invalid", snapshot.Definition.DefinitionId.ToString("D")));
        }
    }

    private Dictionary<Guid, AuditLog> VerifyAuditChains(
        IReadOnlyList<AuditLog> rows,
        List<ArticlePropertyDefinitionVerificationViolation> violations)
    {
        var byReference = new Dictionary<Guid, AuditLog>();
        var ids = new HashSet<long>();
        foreach (IGrouping<string?, AuditLog> chain in rows.GroupBy(static row => row.ChainId))
        {
            AuditLog? previous = null;
            foreach (AuditLog row in chain.OrderBy(static row => row.Id))
            {
                AuditTamperVerificationResult verification = AuditTamperEvidence.VerifyDetailed(row, _auditKey, previous?.RecordHash);
                if (row.Id <= 0 || !ids.Add(row.Id) || !verification.IsValid
                    || previous is null && !string.IsNullOrEmpty(row.PrevHash)
                    || previous is not null && row.Id <= previous.Id)
                {
                    violations.Add(new("history_audit_mac_or_chain_invalid", $"{row.Id}:{verification.Reason}"));
                }
                if (row.TargetType == "article-property-definition-receipt"
                    && Guid.TryParseExact(row.TargetId, "N", out Guid reference)
                    && !byReference.TryAdd(reference, row))
                {
                    violations.Add(new("history_audit_reference_duplicate", reference.ToString("D")));
                }
                previous = row;
            }
        }
        return byReference;
    }

    internal static bool IsReplayResourceAdmitted(ArticlePropertyDefinitionReplaySnapshot replay)
        => AdmitReplayResource(replay, []);

    private static bool AdmitReplayResource(
        ArticlePropertyDefinitionReplaySnapshot replay,
        List<ArticlePropertyDefinitionVerificationViolation> violations)
    {
        long cost = 0;
        try
        {
            foreach (ArticlePropertyDefinitionJournalEntry entry in replay.Entries)
            {
                if (entry is null || entry.Command is null || entry.Receipt is null || entry.Receipt.Obligations is null
                    || entry.Receipt.Obligations.Any(static obligation => obligation is null)
                    || entry.Impact is null || entry.Impact.Obligations is null
                    || entry.Impact.Obligations.Any(static obligation => obligation is null))
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_structure_invalid");
                }
                cost += 4096L + 8L * ArticlePropertyDefinitionCommandHistory.Encode(entry.Command).Length;
                ArticlePropertyDefinitionWriteReceipt receipt = entry.Receipt;
                cost += 2048L + 4L * Encoding.UTF8.GetByteCount(receipt.Owner.SiteScope + receipt.CommandKind
                    + receipt.CommandDigest + receipt.BeforeDefinitionDigest + receipt.AfterDefinitionDigest
                    + receipt.ConstraintDigest + receipt.OptionsDigest + receipt.PolicyDigest + receipt.FlagsDigest
                    + receipt.AuditDigest + receipt.ContentDigest);
                cost += receipt.Obligations.Sum(static obligation => 256L
                    + 4L * Encoding.UTF8.GetByteCount(obligation.Kind + obligation.ReasonCode));
            }
            foreach (ArticlePropertyDefinition definition in replay.Definitions)
            {
                ArticlePropertyDefinitionContract.ValidateDefinition(definition);
                cost += 2048L + 4L * Encoding.UTF8.GetByteCount(definition.MachineKey + definition.Owner.SiteScope
                    + definition.DefaultValue?.Scalar + string.Join(',', definition.DefaultValue?.OptionIds ?? [])
                    + string.Join(',', definition.DefaultValue?.ArticleIds ?? [])
                    + string.Join(',', definition.UrlPolicy?.AllowedSchemes ?? []));
                cost += definition.DisplayNames.Sum(static name => 256L + 4L * Encoding.UTF8.GetByteCount(name.Locale + name.Value));
                cost += definition.Options.Sum(static option => 256L + 4L * Encoding.UTF8.GetByteCount(option.Label)
                    + option.LocalizedLabels.Sum(static name => 256L + 4L * Encoding.UTF8.GetByteCount(name.Locale + name.Value)));
            }
            cost += replay.IdempotencyRecords.Sum(static binding => 256L + 4L * Encoding.UTF8.GetByteCount(binding.CommandDigest));
            foreach (AuditLog row in replay.AuditRecords)
            {
                cost += 2048L + 4L * Encoding.UTF8.GetByteCount(row.Source + row.Type + row.Action + row.Outcome
                    + row.Severity + row.EventInfo + row.ActorType + row.ActorId + row.ActorRole + row.TargetType
                    + row.TargetId + row.TraceId + row.RequestPath + row.RequestMethod + row.IpHash + row.UserAgentHash
                    + row.SessionIdHash + row.DeviceFingerprintHash + row.ReasonCode + row.ContextJson
                    + row.ChainId + row.PrevHash + row.RecordHash + row.RecordMac)
                    + 2L * (row.ContextPayload?.Length ?? 0);
            }
        }
        catch (ArticlePropertyDefinitionValidationException exception)
        {
            violations.Add(new("history_resource_or_shape_invalid", exception.Code));
            return false;
        }
        catch (ArticlePropertyDefinitionBudgetExceededException exception)
        {
            violations.Add(new("history_resource_or_shape_invalid", exception.Code));
            return false;
        }
        if (cost > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
        {
            violations.Add(new("verification_resource_budget_exceeded", "complete owner replay exceeds aggregate resource admission"));
            return false;
        }
        return true;
    }

    private static ArticlePropertyDefinition ReplayCommand(
        ArticlePropertyDefinitionRecordedCommand recorded,
        ArticlePropertyDefinition? before,
        DateTime now,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> state)
    {
        ArticlePropertyDefinition after;
        if (recorded.Create is { } create)
        {
            if (before is not null || state.Values.Count(static item => item.Status != ArticlePropertyDefinitionStatus.Deleted)
                >= ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_history_create_identity_or_budget_invalid");
            }
            after = new(ArticlePropertyDefinitionContract.SchemaVersion, create.DefinitionId, create.Owner,
                create.MachineKey, create.DisplayNames, create.ValueType, create.Cardinality, create.Required,
                create.Presence, create.DefaultValue, create.Constraints, create.Options, create.ReferencePolicy,
                create.UrlPolicy, create.SearchEligible, create.Filterable, create.Sortable, create.DisplayPlacement,
                create.VisibilityScope, ArticlePropertyDefinitionStatus.Active, 1, now, now, string.Empty);
            after = NormalizeReplayDefinition(after);
            if (state.Values.Any(item => item.Status != ArticlePropertyDefinitionStatus.Deleted && item.MachineKey == after.MachineKey))
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_history_machine_key_conflict");
            }
        }
        else
        {
            if (before is null || before.Status == ArticlePropertyDefinitionStatus.Deleted)
            {
                throw new ArticlePropertyDefinitionValidationException("article_property_history_existing_definition_missing_or_deleted");
            }
            after = before with
            {
                SchemaRevision = before.SchemaRevision + 1,
                UpdatedAtUtc = now,
                ContentDigest = string.Empty
            };
            if (recorded.Update is { } update)
            {
                if (update.ValueType != before.ValueType)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_type_change_invalid");
                }
                after = NormalizeReplayDefinition(after with
                {
                    ValueType = update.ValueType,
                    Cardinality = update.Cardinality,
                    Required = update.Required,
                    Presence = update.Presence,
                    DefaultValue = update.DefaultValue,
                    Constraints = update.Constraints,
                    Options = update.Options,
                    ReferencePolicy = update.ReferencePolicy,
                    UrlPolicy = update.UrlPolicy,
                    SearchEligible = update.SearchEligible,
                    Filterable = update.Filterable,
                    Sortable = update.Sortable,
                    DisplayPlacement = update.DisplayPlacement,
                    VisibilityScope = update.VisibilityScope
                });
                foreach (ArticlePropertyOption previous in before.Options)
                {
                    ArticlePropertyOption? next = after.Options.FirstOrDefault(option => option.OptionId == previous.OptionId);
                    if (next is null || previous.Status == ArticlePropertyOptionStatus.Deprecated && next.Status == ArticlePropertyOptionStatus.Active
                        || previous.Status == ArticlePropertyOptionStatus.Deleted
                            && (next.Status != previous.Status || next.Label != previous.Label || next.Order != previous.Order
                                || !next.LocalizedLabels.SequenceEqual(previous.LocalizedLabels)))
                    {
                        throw new ArticlePropertyDefinitionValidationException("article_property_history_option_lifecycle_invalid");
                    }
                }
            }
            else if (recorded.Rename is { } rename)
            {
                after = after with
                {
                    DisplayNames = ArticlePropertyDefinitionContract.NormalizeDisplayNames(rename.DisplayNames)
                };
            }
            else if (recorded.Deprecate is not null)
            {
                if (before.Status != ArticlePropertyDefinitionStatus.Active)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_deprecate_invalid");
                }
                after = after with
                {
                    Status = ArticlePropertyDefinitionStatus.Deprecated
                };
            }
            else if (recorded.Delete is not null)
            {
                if (before.Status != ArticlePropertyDefinitionStatus.Deprecated)
                {
                    throw new ArticlePropertyDefinitionValidationException("article_property_history_delete_invalid");
                }
                after = after with
                {
                    Status = ArticlePropertyDefinitionStatus.Deleted
                };
            }
        }
        after = after with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(after)
        };
        ArticlePropertyDefinitionContract.ValidateDefinition(after);
        return after;
    }

    private static ArticlePropertyDefinition NormalizeReplayDefinition(ArticlePropertyDefinition definition)
    {
        ArticlePropertyDefinitionContract.ValidateCommandPayloadShape(definition.Presence, definition.DefaultValue,
            definition.Constraints, definition.Options, definition.UrlPolicy);
        if (definition.ValueType == ArticlePropertyValueType.Url && definition.UrlPolicy is null)
        {
            throw new ArticlePropertyDefinitionValidationException("article_property_history_url_policy_missing");
        }
        ArticlePropertyDefaultValue? value = definition.DefaultValue;
        if (value?.Kind == ArticlePropertyDefaultKind.None)
        {
            value = null;
        }
        if (value is not null)
        {
            value = value.Kind == ArticlePropertyDefaultKind.Scalar && value.Scalar is not null
                ? new(ArticlePropertyDefaultKind.Scalar, definition.ValueType == ArticlePropertyValueType.Url
                    ? ArticlePropertyDefinitionContract.NormalizeUrl(value.Scalar, definition.UrlPolicy!)
                    : ArticlePropertyDefinitionContract.NormalizeScalar(definition.ValueType, value.Scalar))
                : value with
                {
                    OptionIds = value.OptionIds.Order().ToArray(),
                    ArticleIds = value.ArticleIds.Order().ToArray()
                };
        }
        ArticlePropertyUrlPolicy? url = definition.UrlPolicy is null ? null : definition.UrlPolicy with
        {
            AllowedSchemes = definition.UrlPolicy.AllowedSchemes.Select(static scheme => scheme.Trim().ToLowerInvariant())
                .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray()
        };
        return definition with
        {
            MachineKey = ArticlePropertyDefinitionContract.NormalizeMachineKey(definition.MachineKey),
            DisplayNames = ArticlePropertyDefinitionContract.NormalizeDisplayNames(definition.DisplayNames),
            DefaultValue = value,
            UrlPolicy = url,
            Options = Array.AsReadOnly(definition.Options.Select(option => option with
            {
                Label = option.Label.Trim().Normalize(NormalizationForm.FormC),
                LocalizedLabels = ArticlePropertyDefinitionContract.NormalizeDisplayNames(option.LocalizedLabels.Count == 0
                    ? [new ArticlePropertyLocalizedName("en", option.Label)] : option.LocalizedLabels)
            }).OrderBy(static option => option.Order).ThenBy(static option => option.OptionId).ToArray())
        };
    }

    private static string ComputeReplayCommandDigest(
        ArticlePropertyDefinitionRecordedCommand recorded,
        ArticlePropertyDefinition after)
    {
        if (recorded.Create is { } create)
        {
            return ArticlePropertyDefinitionContract.ComputeCommandDigest("create", create.Actor.AdminPrincipalId,
                create.Owner.UserId, create.Owner.SiteScope, create.DefinitionId, create.ExpectedOwnerRevision,
                after.MachineKey, ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest(after.DisplayNames),
                (int)after.ValueType, (int)after.Cardinality, after.Required, (int)after.Presence.Missing,
                (int)after.Presence.Null, (int)after.Presence.Empty,
                ArticlePropertyDefinitionContract.ComputeDefaultDigest(after.DefaultValue),
                ArticlePropertyDefinitionContract.ComputeConstraintDigest(after.Constraints),
                ArticlePropertyDefinitionContract.ComputeOptionsDigest(after.Options),
                ArticlePropertyDefinitionContract.ComputePolicyDigest(after.ReferencePolicy, after.UrlPolicy),
                after.SearchEligible, after.Filterable, after.Sortable, (int)after.DisplayPlacement, (int)after.VisibilityScope);
        }
        if (recorded.Update is { } update)
        {
            return ArticlePropertyDefinitionContract.ComputeCommandDigest("change-settings", update.Actor.AdminPrincipalId,
                update.Owner.UserId, update.Owner.SiteScope, update.DefinitionId, update.ExpectedOwnerRevision,
                update.ExpectedSchemaRevision, (int)update.ValueType, (int)update.Cardinality, update.Required,
                (int)update.Presence.Missing, (int)update.Presence.Null, (int)update.Presence.Empty,
                ArticlePropertyDefinitionContract.ComputeDefaultDigest(update.DefaultValue),
                ArticlePropertyDefinitionContract.ComputeConstraintDigest(update.Constraints),
                ArticlePropertyDefinitionContract.ComputeOptionsDigest(update.Options),
                ArticlePropertyDefinitionContract.ComputePolicyDigest(update.ReferencePolicy, update.UrlPolicy),
                update.SearchEligible, update.Filterable, update.Sortable, (int)update.DisplayPlacement, (int)update.VisibilityScope);
        }
        object?[] common = [recorded.Actor.AdminPrincipalId, recorded.Owner.UserId,
            recorded.Owner.SiteScope, recorded.DefinitionId, recorded.ExpectedOwnerRevision, recorded.ExpectedSchemaRevision];
        return recorded.Rename is { } rename
            ? ArticlePropertyDefinitionContract.ComputeCommandDigest(recorded.CommandKind, [.. common,
                ArticlePropertyDefinitionContract.ComputeDisplayNamesDigest(ArticlePropertyDefinitionContract.NormalizeDisplayNames(rename.DisplayNames))])
            : ArticlePropertyDefinitionContract.ComputeCommandDigest(recorded.CommandKind, common);
    }
}
