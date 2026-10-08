using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Exact-one canvas-local operation planner. Persistence remains in the existing canvas database
/// authority through <see cref="IAuthoringCanvasOperationTransaction"/>.
/// </summary>
public sealed class AuthoringCanvasOperationEngine(
    IAuthoringCanvasDocumentStore documentStore,
    IAuthoringCanvasOperationTransaction transaction,
    IAuthoringCanvasOperationReferenceValidator referenceValidator)
{
    public async Task<AuthoringCanvasOperationReceipt> ApplyAsync(
        AuthoringCanvasOperationRequest request,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasOperationContract.ValidateRequest(request);
        string transactionDigest = AuthoringCanvasOperationContract.ComputeTransactionDigest(request);
        AuthoringCanvasOperationReceipt? replay = await transaction.RecoverAsync(
            new AuthoringCanvasOperationRecoveryQuery(
                request.CanvasId,
                request.Owner,
                request.RequestId,
                transactionDigest),
            cancellationToken).ConfigureAwait(false);
        if (replay is not null)
        {
            ValidateReplay(
                replay,
                request.RequestId,
                request.CanvasId,
                AuthoringCanvasJournalMode.Apply,
                null,
                transactionDigest,
                request.Commands.Select(static command => command.Kind).ToArray());
            return replay;
        }
        AuthoringCanvasOperationPlan plan = await PlanAsync(request, transactionDigest, cancellationToken).ConfigureAwait(false);
        return await CommitWithRecoveryAsync(plan, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Validates prepared intentions through the same planner without committing or issuing a receipt.</summary>
    public async Task ValidatePreparationAsync(
        AuthoringCanvasOperationRequest request,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasOperationContract.ValidateRequest(request);
        await PlanAsync(request, AuthoringCanvasOperationContract.ComputeTransactionDigest(request),
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<AuthoringCanvasOperationPlan> PlanAsync(
        AuthoringCanvasOperationRequest request,
        string transactionDigest,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasOperationSnapshot snapshot = await ReadSnapshotAsync(
            request.Owner,
            request.CanvasId,
            cancellationToken).ConfigureAwait(false);
        EnsureCoordinate(
            snapshot.Header,
            request.ExpectedRevision,
            request.ExpectedContentDigest);
        AuthoringCanvasHistoryWindow history = await transaction.ReadHistoryAsync(
            request.Owner,
            request.CanvasId,
            cancellationToken).ConfigureAwait(false);
        EnsureHistoryCoordinate(
            history,
            request.CanvasId,
            request.ExpectedRevision,
            request.ExpectedContentDigest,
            request.ExpectedHistoryDigest);
        string referenceValidationDigest = await ValidateReferencesAsync(
            request,
            cancellationToken).ConfigureAwait(false);

        var state = new OperationState(snapshot);
        var initialFacts = new Dictionary<FactKey, AuthoringCanvasOperationFact>();
        var finalFacts = new Dictionary<FactKey, AuthoringCanvasOperationFact>();
        foreach (AuthoringCanvasClosedCommand command in request.Commands)
        {
            AuthoringCanvasOperationSemantics.ValidateCommand(command);
            foreach (AuthoringCanvasOperationFact before in command.Before)
            {
                state.EnsureMatches(before);
                FactKey key = new(before.Kind, before.Id);
                initialFacts.TryAdd(key, before);
            }
            foreach (AuthoringCanvasOperationFact after in command.After)
            {
                state.Apply(after);
                finalFacts[new FactKey(after.Kind, after.Id)] = after;
            }
            // Journal replay validates complete commands, not only the final batch projection.
            state.ValidateGlobal();
        }

        AuthoringCanvasOperationFact[] forwardFacts = finalFacts
            .OrderBy(static pair => pair.Key.Kind)
            .ThenBy(static pair => pair.Key.Id)
            .Select(static pair => pair.Value)
            .ToArray();
        AuthoringCanvasOperationFact[] inverseFacts = forwardFacts
            .Select(fact => initialFacts[new FactKey(fact.Kind, fact.Id)])
            .ToArray();
        Guid[] affectedNodeIds = AffectedIds(forwardFacts, AuthoringCanvasOperationFactKind.Node);
        Guid[] affectedEdgeIds = AffectedIds(forwardFacts, AuthoringCanvasOperationFactKind.Edge);
        var plan = new AuthoringCanvasOperationPlan(
            request.RequestId,
            request.CanvasId,
            request.Owner,
            request.ActorUserId,
            request.ExpectedRevision,
            request.ExpectedContentDigest,
            AuthoringCanvasJournalMode.Apply,
            null,
            request.Commands,
            request.Commands.Select(static command => command.Kind).ToArray(),
            forwardFacts,
            inverseFacts,
            affectedNodeIds,
            affectedEdgeIds,
            history.RedoEntries.Select(static entry => entry.JournalId).ToArray(),
            state.NodeCount,
            state.EdgeCount,
            transactionDigest,
            referenceValidationDigest);
        return plan;
    }

    public Task<AuthoringCanvasOperationReceipt> UndoAsync(
        AuthoringCanvasHistoryRequest request,
        CancellationToken cancellationToken = default)
        => ApplyHistoryAsync((request with
        {
            Mode = AuthoringCanvasJournalMode.Undo
        }), cancellationToken);

    public Task<AuthoringCanvasOperationReceipt> RedoAsync(
        AuthoringCanvasHistoryRequest request,
        CancellationToken cancellationToken = default)
        => ApplyHistoryAsync((request with
        {
            Mode = AuthoringCanvasJournalMode.Redo
        }), cancellationToken);

    public async Task<AuthoringCanvasOperationReceipt?> RecoverAsync(
        AuthoringCanvasOperationRecoveryQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (query.CanvasId == Guid.Empty
            || query.RequestId == Guid.Empty
            || query.TransactionDigest.Length != 64)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_recovery_query_invalid");
        }
        AuthoringCanvasContract.ValidateOwner(query.Owner);
        return await transaction.RecoverAsync(query, cancellationToken).ConfigureAwait(false);
    }

    private async Task<AuthoringCanvasOperationReceipt> ApplyHistoryAsync(
        AuthoringCanvasHistoryRequest request,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasOperationContract.ValidateHistoryRequest(request);
        if (request.Mode is not (AuthoringCanvasJournalMode.Undo or AuthoringCanvasJournalMode.Redo))
        {
            throw new AuthoringCanvasValidationException("canvas_history_mode_invalid");
        }
        string transactionDigest = ComputeHistoryTransactionDigest(request);
        AuthoringCanvasOperationReceipt? replay = await transaction.RecoverAsync(
            new AuthoringCanvasOperationRecoveryQuery(
                request.CanvasId,
                request.Owner,
                request.RequestId,
                transactionDigest),
            cancellationToken).ConfigureAwait(false);
        if (replay is not null)
        {
            ValidateReplay(
                replay,
                request.RequestId,
                request.CanvasId,
                request.Mode,
                request.TargetJournalId,
                transactionDigest,
                expectedCommandKinds: null);
            return replay;
        }
        AuthoringCanvasOperationSnapshot snapshot = await ReadSnapshotAsync(
            request.Owner,
            request.CanvasId,
            cancellationToken).ConfigureAwait(false);
        EnsureCoordinate(snapshot.Header, request.ExpectedRevision, request.ExpectedContentDigest);
        AuthoringCanvasHistoryWindow history = await transaction.ReadHistoryAsync(
            request.Owner,
            request.CanvasId,
            cancellationToken).ConfigureAwait(false);
        EnsureHistoryCoordinate(
            history,
            request.CanvasId,
            request.ExpectedRevision,
            request.ExpectedContentDigest,
            request.ExpectedHistoryDigest);
        IReadOnlyList<AuthoringCanvasOperationJournalEntry> candidates = request.Mode == AuthoringCanvasJournalMode.Undo
            ? history.UndoEntries
            : history.RedoEntries;
        if (candidates.Count == 0 || candidates[0].JournalId != request.TargetJournalId)
        {
            throw new AuthoringCanvasHistoryConflictException();
        }

        AuthoringCanvasOperationJournalEntry target = candidates[0];
        ValidateJournalEntry(target);
        IReadOnlyList<AuthoringCanvasOperationFact> desired = request.Mode == AuthoringCanvasJournalMode.Undo
            ? target.InverseFacts
            : target.ForwardFacts;
        IReadOnlyList<AuthoringCanvasOperationFact> expected = request.Mode == AuthoringCanvasJournalMode.Undo
            ? target.ForwardFacts
            : target.InverseFacts;
        var state = new OperationState(snapshot);
        foreach (AuthoringCanvasOperationFact fact in expected)
        {
            state.EnsureMatches(fact);
        }
        foreach (AuthoringCanvasOperationFact fact in desired)
        {
            state.Apply(fact);
        }
        state.ValidateGlobal();

        var plan = new AuthoringCanvasOperationPlan(
            request.RequestId,
            request.CanvasId,
            request.Owner,
            request.ActorUserId,
            request.ExpectedRevision,
            request.ExpectedContentDigest,
            request.Mode,
            target.JournalId,
            target.Commands,
            target.CommandKinds,
            desired,
            expected,
            AffectedIds(desired, AuthoringCanvasOperationFactKind.Node),
            AffectedIds(desired, AuthoringCanvasOperationFactKind.Edge),
            [],
            state.NodeCount,
            state.EdgeCount,
            transactionDigest,
            AuthoringCanvasContract.ComputeCommandDigest("canvas-operation-reference-validation-none"));
        return await CommitWithRecoveryAsync(plan, cancellationToken).ConfigureAwait(false);
    }

    private async Task<AuthoringCanvasOperationReceipt> CommitWithRecoveryAsync(
        AuthoringCanvasOperationPlan plan,
        CancellationToken cancellationToken)
    {
        try
        {
            AuthoringCanvasOperationReceipt receipt = await transaction.CommitAsync(
                plan,
                cancellationToken).ConfigureAwait(false);
            ValidateReceipt(plan, receipt);
            return receipt;
        }
        catch (AuthoringCanvasUnknownCommitResultException)
        {
            AuthoringCanvasOperationReceipt? recovered = await transaction.RecoverAsync(
                new AuthoringCanvasOperationRecoveryQuery(
                    plan.CanvasId,
                    plan.Owner,
                    plan.RequestId,
                    plan.TransactionDigest),
                CancellationToken.None).ConfigureAwait(false);
            if (recovered is null)
            {
                throw;
            }
            recovered = recovered with
            {
                Status = AuthoringCanvasOperationStatus.RecoveredAfterUnknownCommit,
                ReceiptDigest = string.Empty
            };
            recovered = recovered with
            {
                ReceiptDigest = AuthoringCanvasOperationContract.ComputeReceiptDigest(recovered)
            };
            ValidateReceipt(plan, recovered);
            return recovered;
        }
    }

    private async Task<string> ValidateReferencesAsync(
        AuthoringCanvasOperationRequest request,
        CancellationToken cancellationToken)
    {
        var validationDigests = new List<string>();
        foreach (AuthoringCanvasClosedCommand command in request.Commands)
        {
            if (command.Kind is not (AuthoringCanvasOperationKind.CreateReference
                or AuthoringCanvasOperationKind.PinTargetRevision
                or AuthoringCanvasOperationKind.UnpinTargetRevision))
            {
                continue;
            }
            AuthoringCanvasNode[] references = command.After
                .Where(static fact => fact is { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null })
                .Select(static fact => fact.Node!)
                .ToArray();
            if (references.Length == 0)
                continue;
            // Each closed command is validated separately: a later fact for the same node cannot
            // replace an earlier create/pin/unpin fact in the sealed journal's authority evidence.
            validationDigests.Add(await referenceValidator.ValidateAsync(
                new AuthoringCanvasOperationReferenceValidationRequest(request.RequestId, request.CanvasId,
                    request.ExpectedRevision, request.ExpectedContentDigest, request.Owner, references),
                cancellationToken).ConfigureAwait(false));
        }
        return validationDigests.Count switch
        {
            0 => AuthoringCanvasContract.ComputeCommandDigest("canvas-operation-reference-validation-none"),
            1 => validationDigests[0],
            _ => AuthoringCanvasContract.ComputeCommandDigest("canvas-operation-reference-validation-ordered",
                request.CanvasId, request.ExpectedRevision, request.ExpectedContentDigest,
                string.Join(',', validationDigests))
        };
    }

    private async Task<AuthoringCanvasOperationSnapshot> ReadSnapshotAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasDocumentHeader header = await documentStore.GetAsync(
            owner,
            canvasId,
            cancellationToken).ConfigureAwait(false)
            ?? throw new AuthoringCanvasAccessDeniedException();
        IReadOnlyList<AuthoringCanvasNode> nodes = await ReadAllAsync(
            (cursor, limit, token) => documentStore.ReadNodesAsync(owner, canvasId, cursor, limit, token),
            AuthoringCanvasContract.MaxNodesPerCanvas,
            cancellationToken).ConfigureAwait(false);
        IReadOnlyList<AuthoringCanvasEdge> edges = await ReadAllAsync(
            (cursor, limit, token) => documentStore.ReadEdgesAsync(owner, canvasId, cursor, limit, token),
            AuthoringCanvasContract.MaxEdgesPerCanvas,
            cancellationToken).ConfigureAwait(false);
        if (nodes.Count != header.NodeCount || edges.Count != header.EdgeCount)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_snapshot_count_mismatch");
        }
        return new AuthoringCanvasOperationSnapshot(header, nodes, edges);
    }

    private static async Task<IReadOnlyList<T>> ReadAllAsync<T>(
        Func<AuthoringCanvasPageCursor?, int, CancellationToken, Task<AuthoringCanvasPage<T>>> read,
        int maximum,
        CancellationToken cancellationToken)
    {
        var items = new List<T>();
        AuthoringCanvasPageCursor? cursor = null;
        do
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthoringCanvasPage<T> page = await read(
                cursor,
                AuthoringCanvasContract.MaxPageSize,
                cancellationToken).ConfigureAwait(false);
            items.AddRange(page.Items);
            if (items.Count > maximum
                || (page.NextCursor is not null && page.NextCursor == cursor))
            {
                throw new AuthoringCanvasBudgetExceededException("canvas_operation_snapshot_budget_exceeded");
            }
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        return items;
    }

    private static Guid[] AffectedIds(
        IEnumerable<AuthoringCanvasOperationFact> facts,
        AuthoringCanvasOperationFactKind kind)
        => facts.Where(fact => fact.Kind == kind).Select(static fact => fact.Id).Distinct().Order().ToArray();

    private static void EnsureCoordinate(
        AuthoringCanvasDocumentHeader header,
        long expectedRevision,
        string expectedContentDigest)
    {
        if (header.Revision != expectedRevision)
        {
            throw new AuthoringCanvasRevisionConflictException(expectedRevision, header.Revision);
        }
        if (!string.Equals(header.ContentDigest, expectedContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_content_digest_stale");
        }
    }

    private static void EnsureHistoryCoordinate(
        AuthoringCanvasHistoryWindow history,
        Guid canvasId,
        long expectedRevision,
        string expectedContentDigest,
        string expectedHistoryDigest)
    {
        if (history.CanvasId != canvasId
            || history.Revision != expectedRevision
            || !string.Equals(history.CanvasContentDigest, expectedContentDigest, StringComparison.Ordinal)
            || !string.Equals(history.HistoryDigest, expectedHistoryDigest, StringComparison.Ordinal)
            || history.UndoEntries.Count > AuthoringCanvasOperationContract.MaxUndoDepth
            || history.RedoEntries.Count > AuthoringCanvasOperationContract.MaxUndoDepth)
        {
            throw new AuthoringCanvasHistoryConflictException();
        }
    }

    private static void ValidateJournalEntry(AuthoringCanvasOperationJournalEntry entry)
    {
        if (entry.Commands.Count != entry.CommandKinds.Count
            || !entry.Commands.Select(static command => command.Kind).SequenceEqual(entry.CommandKinds))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_journal_command_set_invalid");
        }
        foreach (AuthoringCanvasClosedCommand command in entry.Commands)
        {
            AuthoringCanvasOperationSemantics.ValidateCommand(command);
        }
        foreach (AuthoringCanvasOperationFact fact in entry.ForwardFacts.Concat(entry.InverseFacts))
        {
            AuthoringCanvasOperationContract.ValidateFact(fact);
        }
        if (!string.Equals(
            entry.JournalDigest,
            AuthoringCanvasOperationContract.ComputeJournalDigest((entry with
            {
                JournalDigest = string.Empty
            })),
            StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_journal_digest_invalid");
        }
    }

    private static void ValidateReceipt(
        AuthoringCanvasOperationPlan plan,
        AuthoringCanvasOperationReceipt receipt)
    {
        if (receipt.RequestId != plan.RequestId
            || receipt.CanvasId != plan.CanvasId
            || receipt.Revision != plan.ExpectedRevision + 1
            || receipt.Mode != plan.Mode
            || receipt.TargetJournalId != plan.TargetJournalId
            || !string.Equals(receipt.TransactionDigest, plan.TransactionDigest, StringComparison.Ordinal)
            || !receipt.AffectedNodeIds.SequenceEqual(plan.AffectedNodeIds)
            || !receipt.AffectedEdgeIds.SequenceEqual(plan.AffectedEdgeIds)
            || !receipt.CommandKinds.SequenceEqual(plan.CommandKinds)
            || receipt.CommandCount != plan.CommandKinds.Count
            || !string.Equals(
                receipt.ReceiptDigest,
                AuthoringCanvasOperationContract.ComputeReceiptDigest((receipt with
                {
                    ReceiptDigest = string.Empty
                })),
                StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_receipt_invalid");
        }
    }

    private static string ComputeHistoryTransactionDigest(AuthoringCanvasHistoryRequest request)
        => AuthoringCanvasContract.ComputeCommandDigest(
            AuthoringCanvasOperationContract.SchemaVersion,
            request.RequestId,
            request.CanvasId,
            request.ExpectedRevision,
            request.ExpectedContentDigest,
            request.ExpectedHistoryDigest,
            request.ActorUserId,
            request.Mode,
            request.TargetJournalId);

    private static void ValidateReplay(
        AuthoringCanvasOperationReceipt receipt,
        Guid requestId,
        Guid canvasId,
        AuthoringCanvasJournalMode mode,
        Guid? targetJournalId,
        string transactionDigest,
        IReadOnlyList<AuthoringCanvasOperationKind>? expectedCommandKinds)
    {
        if (receipt.RequestId != requestId
            || receipt.CanvasId != canvasId
            || receipt.Mode != mode
            || receipt.TargetJournalId != targetJournalId
            || !string.Equals(receipt.TransactionDigest, transactionDigest, StringComparison.Ordinal)
            || (expectedCommandKinds is not null
                && !receipt.CommandKinds.SequenceEqual(expectedCommandKinds))
            || !string.Equals(
                receipt.ReceiptDigest,
                AuthoringCanvasOperationContract.ComputeReceiptDigest((receipt with
                {
                    ReceiptDigest = string.Empty
                })),
                StringComparison.Ordinal))
        {
            throw new AuthoringCanvasIdempotencyConflictException();
        }
    }

    private readonly record struct FactKey(AuthoringCanvasOperationFactKind Kind, Guid Id);

    private sealed class OperationState
    {
        private readonly Dictionary<Guid, AuthoringCanvasNode> _nodes;
        private readonly Dictionary<Guid, AuthoringCanvasEdge> _edges;
        private AuthoringCanvasViewport _viewport;

        public OperationState(AuthoringCanvasOperationSnapshot snapshot)
        {
            _nodes = snapshot.Nodes.ToDictionary(static node => node.Id);
            _edges = snapshot.Edges.ToDictionary(static edge => edge.Id);
            _viewport = snapshot.Header.Viewport;
        }

        public int NodeCount => _nodes.Count;

        public int EdgeCount => _edges.Count;

        public void EnsureMatches(AuthoringCanvasOperationFact expected)
        {
            AuthoringCanvasOperationFact actual = Read(expected.Kind, expected.Id);
            if (!string.Equals(actual.ContentDigest, expected.ContentDigest, StringComparison.Ordinal))
            {
                throw new AuthoringCanvasRevisionConflictException(0, 0);
            }
        }

        public void Apply(AuthoringCanvasOperationFact fact)
        {
            switch (fact.Kind)
            {
                case AuthoringCanvasOperationFactKind.Node:
                    if (fact.Exists)
                    {
                        _nodes[fact.Id] = fact.Node!;
                    }
                    else
                    {
                        _nodes.Remove(fact.Id);
                    }
                    break;
                case AuthoringCanvasOperationFactKind.Edge:
                    if (fact.Exists)
                    {
                        _edges[fact.Id] = fact.Edge!;
                    }
                    else
                    {
                        _edges.Remove(fact.Id);
                    }
                    break;
                case AuthoringCanvasOperationFactKind.Viewport:
                    _viewport = fact.Viewport!.Value;
                    break;
            }
        }

        public void ValidateGlobal()
        {
            if (_nodes.Count > AuthoringCanvasContract.MaxNodesPerCanvas
                || _edges.Count > AuthoringCanvasContract.MaxEdgesPerCanvas)
            {
                throw new AuthoringCanvasBudgetExceededException("canvas_operation_result_budget_exceeded");
            }
            AuthoringCanvasContract.ValidateViewport(_viewport);
            foreach (AuthoringCanvasNode node in _nodes.Values)
            {
                AuthoringCanvasContract.ValidateNode(node);
                if (node.Type == AuthoringCanvasNodeType.GroupFrame
                    && node.MemberNodeIds.Any(member => !_nodes.ContainsKey(member)))
                {
                    throw new AuthoringCanvasValidationException("canvas_operation_frame_member_missing");
                }
            }
            foreach (AuthoringCanvasEdge edge in _edges.Values)
            {
                AuthoringCanvasContract.ValidateEdge(edge);
                if (!_nodes.ContainsKey(edge.SourceNodeId) || !_nodes.ContainsKey(edge.TargetNodeId))
                {
                    throw new AuthoringCanvasValidationException("canvas_operation_incident_edge_not_deleted");
                }
            }
        }

        private AuthoringCanvasOperationFact Read(AuthoringCanvasOperationFactKind kind, Guid id)
            => kind switch
            {
                AuthoringCanvasOperationFactKind.Node when _nodes.TryGetValue(id, out AuthoringCanvasNode? node) =>
                    AuthoringCanvasOperationContract.Present(node),
                AuthoringCanvasOperationFactKind.Edge when _edges.TryGetValue(id, out AuthoringCanvasEdge? edge) =>
                    AuthoringCanvasOperationContract.Present(edge),
                AuthoringCanvasOperationFactKind.Viewport => AuthoringCanvasOperationContract.Present(_viewport),
                _ => AuthoringCanvasOperationContract.Missing(kind, id)
            };
    }
}
