using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Independent journal verifier. It replays sealed canvas facts without calling the operation
/// engine or any article, relation, property, workspace, search, or editor authority.
/// </summary>
public static class AuthoringCanvasOperationVerifier
{
    private static string NoReferenceValidationDigest
    {
        get;
    } =
        AuthoringCanvasContract.ComputeCommandDigest("canvas-operation-reference-validation-none");

    public static AuthoringCanvasOperationVerificationResult Verify(
        AuthoringCanvasOperationSnapshot initial,
        IReadOnlyList<AuthoringCanvasOperationJournalEntry> journal,
        IReadOnlyList<AuthoringCanvasOperationReceipt> receipts,
        AuthoringCanvasOperationSnapshot current)
    {
        ArgumentNullException.ThrowIfNull(initial);
        ArgumentNullException.ThrowIfNull(journal);
        ArgumentNullException.ThrowIfNull(receipts);
        ArgumentNullException.ThrowIfNull(current);
        var reasons = new List<string>();
        Dictionary<Guid, AuthoringCanvasOperationReceipt> receiptsByJournal = IndexReceipts(receipts, reasons);
        Dictionary<Guid, AuthoringCanvasNode> nodes = UniqueById(
            initial.Nodes, static node => node.Id, "initial_node_duplicate", reasons);
        Dictionary<Guid, AuthoringCanvasEdge> edges = UniqueById(
            initial.Edges, static edge => edge.Id, "initial_edge_duplicate", reasons);
        AuthoringCanvasViewport viewport = initial.Header.Viewport;
        long revision = initial.Header.Revision;
        string contentDigest = initial.Header.ContentDigest;
        Guid? parentJournalId = null;
        var entries = new Dictionary<Guid, AuthoringCanvasOperationJournalEntry>();
        var requestIds = new HashSet<Guid>();
        var undo = new List<Guid>();
        var redo = new List<Guid>();
        ValidateState(nodes, edges, viewport, "initial", reasons);

        foreach (AuthoringCanvasOperationJournalEntry entry in journal)
        {
            try
            {
                receiptsByJournal.Remove(entry.JournalId, out AuthoringCanvasOperationReceipt? receipt);
                VerifyEntry(
                    entry,
                    receipt,
                    initial.Header.Id,
                    nodes,
                    edges,
                    ref viewport,
                    ref revision,
                    ref contentDigest,
                    ref parentJournalId,
                    entries,
                    requestIds,
                    undo,
                    redo,
                    reasons);
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                reasons.Add($"journal_verifier_failure:{entry?.JournalId:D}:{exception.GetType().Name}");
            }
        }
        foreach (Guid orphanJournalId in receiptsByJournal.Keys.Order())
        {
            reasons.Add($"operation_receipt_orphan:{orphanJournalId:D}");
        }

        ValidateState(nodes, edges, viewport, "current", reasons);
        if (current.Header.Id != initial.Header.Id
            || current.Header.Revision != revision
            || !string.Equals(current.Header.ContentDigest, contentDigest, StringComparison.Ordinal)
            || current.Header.NodeCount != nodes.Count
            || current.Header.EdgeCount != edges.Count)
        {
            reasons.Add("current_header_mismatch");
        }
        if (!SameNodes(nodes.Values, current.Nodes))
        {
            reasons.Add("current_nodes_mismatch");
        }
        if (!SameEdges(edges.Values, current.Edges))
        {
            reasons.Add("current_edges_mismatch");
        }
        if (current.Header.Viewport != viewport)
        {
            reasons.Add("current_viewport_mismatch");
        }

        return new AuthoringCanvasOperationVerificationResult(
            initial.Header.Id,
            revision,
            journal.Count,
            contentDigest,
            reasons.Count == 0,
            reasons);
    }

    private static void VerifyEntry(
        AuthoringCanvasOperationJournalEntry entry,
        AuthoringCanvasOperationReceipt? receipt,
        Guid canvasId,
        Dictionary<Guid, AuthoringCanvasNode> nodes,
        Dictionary<Guid, AuthoringCanvasEdge> edges,
        ref AuthoringCanvasViewport viewport,
        ref long revision,
        ref string contentDigest,
        ref Guid? parentJournalId,
        Dictionary<Guid, AuthoringCanvasOperationJournalEntry> entries,
        ISet<Guid> requestIds,
        IList<Guid> undo,
        IList<Guid> redo,
        ICollection<string> reasons)
    {
        string entryIdentity = entry.JournalId.ToString("D");
        if (entry.JournalId == Guid.Empty || !entries.TryAdd(entry.JournalId, entry))
        {
            reasons.Add($"journal_identity_invalid:{entryIdentity}");
        }
        if (entry.RequestId == Guid.Empty || !requestIds.Add(entry.RequestId))
        {
            reasons.Add($"journal_request_identity_invalid:{entryIdentity}");
        }
        if (entry.CanvasId != canvasId
            || entry.Revision != revision + 1
            || entry.ParentJournalId != parentJournalId
            || !string.Equals(entry.PreviousContentDigest, contentDigest, StringComparison.Ordinal))
        {
            reasons.Add($"journal_chain_invalid:{entryIdentity}");
        }
        if (!Enum.IsDefined(entry.Mode)
            || entry.ActorUserId <= 0
            || entry.CommandKinds.Count is < 1 or > AuthoringCanvasOperationContract.MaxCommandsPerTransaction
            || entry.Commands.Count != entry.CommandKinds.Count
            || !entry.Commands.Select(static command => command.Kind).SequenceEqual(entry.CommandKinds))
        {
            reasons.Add($"journal_command_set_invalid:{entryIdentity}");
        }
        if (!TryComputeJournalDigest(entry, out string computedJournalDigest)
            || !string.Equals(entry.JournalDigest, computedJournalDigest, StringComparison.Ordinal))
        {
            reasons.Add($"journal_digest_mismatch:{entryIdentity}");
        }

        bool commandsValid = ValidateCommands(entry, reasons);
        ValidateReferenceEvidence(entry, reasons);
        ValidateHistoryTransition(entry, entries, undo, redo, reasons);
        ValidateReceipt(entry, receipt, canvasId, undo.Count, redo.Count, reasons);

        if (!TryFactsByKey(entry.InverseFacts, out Dictionary<FactKey, AuthoringCanvasOperationFact> inverse)
            || !TryFactsByKey(entry.ForwardFacts, out Dictionary<FactKey, AuthoringCanvasOperationFact> forward)
            || forward.Count != inverse.Count
            || forward.Count > AuthoringCanvasOperationContract.MaxFactsPerTransaction
            || !forward.Keys.Order().SequenceEqual(inverse.Keys.Order()))
        {
            reasons.Add($"journal_fact_set_invalid:{entryIdentity}");
            AdvanceCoordinates(entry, nodes.Count, edges.Count, ref revision, ref contentDigest, ref parentJournalId, reasons);
            return;
        }

        foreach (AuthoringCanvasOperationFact fact in inverse.Values.Concat(forward.Values))
        {
            try
            {
                AuthoringCanvasOperationContract.ValidateFact(fact);
            }
            catch (AuthoringCanvasValidationException exception)
            {
                reasons.Add($"journal_fact_invalid:{entryIdentity}:{exception.Code}");
            }
        }

        var commandNodes = nodes.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        var commandEdges = edges.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        AuthoringCanvasViewport commandViewport = viewport;
        if (entry.Mode == AuthoringCanvasJournalMode.Apply && commandsValid)
        {
            foreach (AuthoringCanvasClosedCommand command in entry.Commands)
            {
                foreach (AuthoringCanvasOperationFact before in command.Before)
                {
                    if (!Matches(before, commandNodes, commandEdges, commandViewport))
                    {
                        reasons.Add($"journal_command_before_mismatch:{entryIdentity}:{command.CommandId:D}:{before.Id:D}");
                    }
                }
                foreach (AuthoringCanvasOperationFact after in command.After)
                {
                    Apply(after, commandNodes, commandEdges, ref commandViewport);
                }
                ValidateState(commandNodes, commandEdges, commandViewport, $"journal_command:{entryIdentity}", reasons);
            }
        }

        foreach ((FactKey key, AuthoringCanvasOperationFact before) in inverse)
        {
            if (!Matches(before, nodes, edges, viewport))
            {
                reasons.Add($"journal_before_fact_mismatch:{entryIdentity}:{key.Id:D}");
            }
        }
        foreach (AuthoringCanvasOperationFact fact in forward.Values)
        {
            Apply(fact, nodes, edges, ref viewport);
        }
        ValidateState(nodes, edges, viewport, $"journal_result:{entryIdentity}", reasons);

        if (entry.Mode == AuthoringCanvasJournalMode.Apply && commandsValid
            && (!SameNodes(commandNodes.Values, nodes.Values)
                || !SameEdges(commandEdges.Values, edges.Values)
                || commandViewport != viewport))
        {
            reasons.Add($"journal_command_projection_mismatch:{entryIdentity}");
        }
        ValidateAffectedIds(entry, forward.Values, reasons);
        AdvanceCoordinates(entry, nodes.Count, edges.Count, ref revision, ref contentDigest, ref parentJournalId, reasons);
    }

    private static Dictionary<Guid, AuthoringCanvasOperationReceipt> IndexReceipts(
        IReadOnlyList<AuthoringCanvasOperationReceipt> receipts,
        ICollection<string> reasons)
    {
        var byJournal = new Dictionary<Guid, AuthoringCanvasOperationReceipt>(receipts.Count);
        var receiptIds = new HashSet<Guid>();
        var requestIds = new HashSet<Guid>();
        foreach (AuthoringCanvasOperationReceipt receipt in receipts)
        {
            if (receipt is null)
            {
                reasons.Add("operation_receipt_null");
                continue;
            }
            if (receipt.ReceiptId == Guid.Empty || !receiptIds.Add(receipt.ReceiptId))
            {
                reasons.Add($"operation_receipt_identity_invalid:{receipt.ReceiptId:D}");
            }
            if (receipt.RequestId == Guid.Empty || !requestIds.Add(receipt.RequestId))
            {
                reasons.Add($"operation_receipt_request_invalid:{receipt.RequestId:D}");
            }
            if (receipt.JournalId == Guid.Empty || !byJournal.TryAdd(receipt.JournalId, receipt))
            {
                reasons.Add($"operation_receipt_journal_duplicate:{receipt.JournalId:D}");
            }
        }
        return byJournal;
    }

    private static void ValidateReceipt(
        AuthoringCanvasOperationJournalEntry entry,
        AuthoringCanvasOperationReceipt? receipt,
        Guid canvasId,
        int undoDepth,
        int redoDepth,
        ICollection<string> reasons)
    {
        if (receipt is null)
        {
            reasons.Add($"operation_receipt_missing:{entry.JournalId:D}");
            return;
        }

        bool fieldsValid = receipt.RequestId == entry.RequestId
            && receipt.CanvasId == canvasId
            && receipt.Revision == entry.Revision
            && receipt.Mode == entry.Mode
            && receipt.JournalId == entry.JournalId
            && receipt.TargetJournalId == entry.TargetJournalId
            && receipt.CommandCount == entry.CommandKinds.Count
            && receipt.CommandKinds.SequenceEqual(entry.CommandKinds)
            && receipt.AffectedNodeIds.SequenceEqual(entry.AffectedNodeIds)
            && receipt.AffectedEdgeIds.SequenceEqual(entry.AffectedEdgeIds)
            && receipt.UndoDepth == undoDepth
            && receipt.RedoDepth == redoDepth
            && receipt.Status == AuthoringCanvasOperationStatus.Committed
            && receipt.Reasons.Count == 0
            && string.Equals(receipt.TransactionDigest, entry.TransactionDigest, StringComparison.Ordinal)
            && string.Equals(receipt.JournalDigest, entry.JournalDigest, StringComparison.Ordinal)
            && string.Equals(receipt.CanvasContentDigest, entry.ContentDigest, StringComparison.Ordinal)
            && string.Equals(
                receipt.ReceiptDigest,
                AuthoringCanvasOperationContract.ComputeReceiptDigest(receipt),
                StringComparison.Ordinal);
        if (!fieldsValid)
        {
            reasons.Add($"operation_receipt_invalid:{entry.JournalId:D}");
        }
    }

    private static bool ValidateCommands(
        AuthoringCanvasOperationJournalEntry entry,
        ICollection<string> reasons)
    {
        bool valid = true;
        var commandIds = new HashSet<Guid>();
        foreach (AuthoringCanvasClosedCommand command in entry.Commands)
        {
            try
            {
                if (!commandIds.Add(command.CommandId))
                {
                    throw new AuthoringCanvasValidationException("canvas_operation_command_duplicate");
                }
                AuthoringCanvasOperationSemantics.ValidateCommand(command);
            }
            catch (AuthoringCanvasValidationException exception)
            {
                valid = false;
                reasons.Add($"journal_command_invalid:{entry.JournalId:D}:{command.CommandId:D}:{exception.Code}");
            }
        }
        return valid;
    }

    private static void ValidateReferenceEvidence(
        AuthoringCanvasOperationJournalEntry entry,
        ICollection<string> reasons)
    {
        bool requiresEvidence = entry.Mode == AuthoringCanvasJournalMode.Apply
            && entry.CommandKinds.Any(static kind => kind is AuthoringCanvasOperationKind.CreateReference
                or AuthoringCanvasOperationKind.PinTargetRevision
                or AuthoringCanvasOperationKind.UnpinTargetRevision);
        bool digestShapeValid = entry.ReferenceValidationDigest.Length == 64
            && entry.ReferenceValidationDigest.All(static character => character is >= '0' and <= '9'
                or >= 'a' and <= 'f');
        if (!digestShapeValid
            || (requiresEvidence && string.Equals(
                entry.ReferenceValidationDigest,
                NoReferenceValidationDigest,
                StringComparison.Ordinal)))
        {
            reasons.Add($"journal_reference_evidence_invalid:{entry.JournalId:D}");
        }
    }

    private static void ValidateHistoryTransition(
        AuthoringCanvasOperationJournalEntry entry,
        IReadOnlyDictionary<Guid, AuthoringCanvasOperationJournalEntry> entries,
        IList<Guid> undo,
        IList<Guid> redo,
        ICollection<string> reasons)
    {
        bool invalid = false;
        switch (entry.Mode)
        {
            case AuthoringCanvasJournalMode.Apply:
                invalid = entry.TargetJournalId is not null
                    || !entry.TruncatedRedoJournalIds.SequenceEqual(redo.Reverse());
                redo.Clear();
                undo.Add(entry.JournalId);
                break;
            case AuthoringCanvasJournalMode.Undo:
                Guid undoTarget = entry.TargetJournalId ?? Guid.Empty;
                invalid = undoTarget == Guid.Empty
                    || undo.Count == 0
                    || undo[^1] != undoTarget
                    || !ValidateHistoryTarget(entry, undoTarget, entries, undoing: true);
                if (!invalid)
                {
                    undo.RemoveAt(undo.Count - 1);
                    redo.Add(undoTarget);
                }
                break;
            case AuthoringCanvasJournalMode.Redo:
                Guid redoTarget = entry.TargetJournalId ?? Guid.Empty;
                invalid = redoTarget == Guid.Empty
                    || redo.Count == 0
                    || redo[^1] != redoTarget
                    || !ValidateHistoryTarget(entry, redoTarget, entries, undoing: false);
                if (!invalid)
                {
                    redo.RemoveAt(redo.Count - 1);
                    undo.Add(redoTarget);
                }
                break;
            default:
                invalid = true;
                break;
        }
        while (undo.Count > AuthoringCanvasOperationContract.MaxUndoDepth)
        {
            undo.RemoveAt(0);
        }
        if (entry.Mode != AuthoringCanvasJournalMode.Apply && entry.TruncatedRedoJournalIds.Count != 0)
        {
            invalid = true;
        }
        if (invalid)
        {
            reasons.Add($"journal_history_transition_invalid:{entry.JournalId:D}");
        }
    }

    private static bool ValidateHistoryTarget(
        AuthoringCanvasOperationJournalEntry entry,
        Guid targetId,
        IReadOnlyDictionary<Guid, AuthoringCanvasOperationJournalEntry> entries,
        bool undoing)
    {
        if (!entries.TryGetValue(targetId, out AuthoringCanvasOperationJournalEntry? target)
            || target.Mode != AuthoringCanvasJournalMode.Apply
            || !entry.CommandKinds.SequenceEqual(target.CommandKinds)
            || !entry.Commands.Select(static command => command.ContentDigest)
                .SequenceEqual(target.Commands.Select(static command => command.ContentDigest)))
        {
            return false;
        }
        return undoing
            ? SameFacts(entry.ForwardFacts, target.InverseFacts)
                && SameFacts(entry.InverseFacts, target.ForwardFacts)
            : SameFacts(entry.ForwardFacts, target.ForwardFacts)
                && SameFacts(entry.InverseFacts, target.InverseFacts);
    }

    private static void ValidateAffectedIds(
        AuthoringCanvasOperationJournalEntry entry,
        IEnumerable<AuthoringCanvasOperationFact> facts,
        ICollection<string> reasons)
    {
        Guid[] nodes = facts.Where(static fact => fact.Kind == AuthoringCanvasOperationFactKind.Node)
            .Select(static fact => fact.Id).Distinct().Order().ToArray();
        Guid[] edges = facts.Where(static fact => fact.Kind == AuthoringCanvasOperationFactKind.Edge)
            .Select(static fact => fact.Id).Distinct().Order().ToArray();
        if (!entry.AffectedNodeIds.SequenceEqual(nodes) || !entry.AffectedEdgeIds.SequenceEqual(edges))
        {
            reasons.Add($"journal_affected_ids_invalid:{entry.JournalId:D}");
        }
    }

    private static void AdvanceCoordinates(
        AuthoringCanvasOperationJournalEntry entry,
        int nodeCount,
        int edgeCount,
        ref long revision,
        ref string contentDigest,
        ref Guid? parentJournalId,
        ICollection<string> reasons)
    {
        string computedContentDigest = AuthoringCanvasContract.ComputeTransitionDigest(
            contentDigest,
            entry.Revision,
            $"canvas-operation:{entry.Mode}",
            entry.TransactionDigest,
            nodeCount,
            edgeCount);
        if (!string.Equals(entry.ContentDigest, computedContentDigest, StringComparison.Ordinal))
        {
            reasons.Add($"journal_content_digest_mismatch:{entry.JournalId:D}");
        }
        revision = entry.Revision;
        contentDigest = computedContentDigest;
        parentJournalId = entry.JournalId;
    }

    private static bool TryComputeJournalDigest(
        AuthoringCanvasOperationJournalEntry entry,
        out string digest)
    {
        try
        {
            digest = AuthoringCanvasOperationContract.ComputeJournalDigest(entry with
            {
                JournalDigest = string.Empty
            });
            return true;
        }
        catch
        {
            digest = string.Empty;
            return false;
        }
    }

    private static bool TryFactsByKey(
        IReadOnlyList<AuthoringCanvasOperationFact> facts,
        out Dictionary<FactKey, AuthoringCanvasOperationFact> result)
    {
        result = new Dictionary<FactKey, AuthoringCanvasOperationFact>();
        foreach (AuthoringCanvasOperationFact fact in facts)
        {
            if (fact is null || !result.TryAdd(new FactKey(fact.Kind, fact.Id), fact))
            {
                return false;
            }
        }
        return result.Count > 0;
    }

    private static bool Matches(
        AuthoringCanvasOperationFact expected,
        IReadOnlyDictionary<Guid, AuthoringCanvasNode> nodes,
        IReadOnlyDictionary<Guid, AuthoringCanvasEdge> edges,
        AuthoringCanvasViewport viewport)
    {
        AuthoringCanvasOperationFact actual = expected.Kind switch
        {
            AuthoringCanvasOperationFactKind.Node when nodes.TryGetValue(expected.Id, out AuthoringCanvasNode? node) =>
                AuthoringCanvasOperationContract.Present(node),
            AuthoringCanvasOperationFactKind.Edge when edges.TryGetValue(expected.Id, out AuthoringCanvasEdge? edge) =>
                AuthoringCanvasOperationContract.Present(edge),
            AuthoringCanvasOperationFactKind.Viewport => AuthoringCanvasOperationContract.Present(viewport),
            _ => AuthoringCanvasOperationContract.Missing(expected.Kind, expected.Id)
        };
        return string.Equals(actual.ContentDigest, expected.ContentDigest, StringComparison.Ordinal);
    }

    private static void Apply(
        AuthoringCanvasOperationFact fact,
        IDictionary<Guid, AuthoringCanvasNode> nodes,
        IDictionary<Guid, AuthoringCanvasEdge> edges,
        ref AuthoringCanvasViewport viewport)
    {
        switch (fact.Kind)
        {
            case AuthoringCanvasOperationFactKind.Node when fact.Exists && fact.Node is not null:
                nodes[fact.Id] = fact.Node;
                break;
            case AuthoringCanvasOperationFactKind.Node:
                nodes.Remove(fact.Id);
                break;
            case AuthoringCanvasOperationFactKind.Edge when fact.Exists && fact.Edge is not null:
                edges[fact.Id] = fact.Edge;
                break;
            case AuthoringCanvasOperationFactKind.Edge:
                edges.Remove(fact.Id);
                break;
            case AuthoringCanvasOperationFactKind.Viewport when fact.Exists && fact.Viewport is not null:
                viewport = fact.Viewport.Value;
                break;
        }
    }

    private static void ValidateState(
        IReadOnlyDictionary<Guid, AuthoringCanvasNode> nodes,
        IReadOnlyDictionary<Guid, AuthoringCanvasEdge> edges,
        AuthoringCanvasViewport viewport,
        string scope,
        ICollection<string> reasons)
    {
        try
        {
            AuthoringCanvasContract.ValidateViewport(viewport);
        }
        catch (AuthoringCanvasValidationException exception)
        {
            reasons.Add($"{scope}_viewport_invalid:{exception.Code}");
        }
        foreach (AuthoringCanvasNode node in nodes.Values)
        {
            try
            {
                AuthoringCanvasContract.ValidateNode(node);
            }
            catch (AuthoringCanvasValidationException exception)
            {
                reasons.Add($"{scope}_node_invalid:{node.Id:D}:{exception.Code}");
            }
            if (node.Type != AuthoringCanvasNodeType.GroupFrame)
            {
                continue;
            }
            bool memberMissing = false;
            bool nestedFrame = false;
            foreach (Guid memberId in node.MemberNodeIds)
            {
                if (!nodes.TryGetValue(memberId, out AuthoringCanvasNode? member))
                {
                    memberMissing = true;
                }
                else if (member.Type == AuthoringCanvasNodeType.GroupFrame)
                {
                    nestedFrame = true;
                }
            }
            if (memberMissing)
            {
                reasons.Add($"{scope}_frame_member_missing:{node.Id:D}");
            }
            if (nestedFrame)
            {
                reasons.Add($"{scope}_frame_nesting_forbidden:{node.Id:D}");
            }
        }
        foreach (AuthoringCanvasEdge edge in edges.Values)
        {
            try
            {
                AuthoringCanvasContract.ValidateEdge(edge);
            }
            catch (AuthoringCanvasValidationException exception)
            {
                reasons.Add($"{scope}_edge_invalid:{edge.Id:D}:{exception.Code}");
            }
            if (!nodes.ContainsKey(edge.SourceNodeId) || !nodes.ContainsKey(edge.TargetNodeId))
            {
                reasons.Add($"{scope}_edge_endpoint_missing:{edge.Id:D}");
            }
        }
    }

    private static Dictionary<Guid, T> UniqueById<T>(
        IEnumerable<T> source,
        Func<T, Guid> id,
        string reason,
        ICollection<string> reasons)
    {
        var result = new Dictionary<Guid, T>();
        foreach (T item in source)
        {
            if (!result.TryAdd(id(item), item))
            {
                reasons.Add($"{reason}:{id(item):D}");
            }
        }
        return result;
    }

    private static bool SameFacts(
        IReadOnlyList<AuthoringCanvasOperationFact> left,
        IReadOnlyList<AuthoringCanvasOperationFact> right)
        => left.Select(static fact => fact.ContentDigest).SequenceEqual(
            right.Select(static fact => fact.ContentDigest));

    private static bool SameNodes(IEnumerable<AuthoringCanvasNode> expected, IEnumerable<AuthoringCanvasNode> actual)
        => expected.Select(AuthoringCanvasContract.ComputeNodeDigest).Order()
            .SequenceEqual(actual.Select(AuthoringCanvasContract.ComputeNodeDigest).Order());

    private static bool SameEdges(IEnumerable<AuthoringCanvasEdge> expected, IEnumerable<AuthoringCanvasEdge> actual)
        => expected.Select(AuthoringCanvasContract.ComputeEdgeDigest).Order()
            .SequenceEqual(actual.Select(AuthoringCanvasContract.ComputeEdgeDigest).Order());

    private readonly record struct FactKey(AuthoringCanvasOperationFactKind Kind, Guid Id) : IComparable<FactKey>
    {
        public int CompareTo(FactKey other)
        {
            int kind = Kind.CompareTo(other.Kind);
            return kind != 0 ? kind : Id.CompareTo(other.Id);
        }
    }
}
