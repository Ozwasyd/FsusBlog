using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Projects the sole private document and operation authorities into bounded wire reads.</summary>
public sealed class AuthoringCanvasTransport(
    IAuthoringCanvasDocumentStore store,
    IAuthoringCanvasOperationTransaction transaction,
    AuthoringCanvasOperationEngine operations,
    AuthoringCanvasReferenceResolver references)
{
    public async Task<AuthoringCanvasDocumentHeader> CreateAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasCreateRequest request,
        CancellationToken cancellationToken)
    {
        await store.CreateAsync(new CreateAuthoringCanvasCommand(
            request.CanvasId, owner, request.Title, request.Viewport, request.RequestId), cancellationToken);
        return await RequireHeaderAsync(owner, request.CanvasId, cancellationToken);
    }

    public async Task<AuthoringCanvasListResponse> ListAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasPage<AuthoringCanvasDocumentHeader> page = await store.ListAsync(
            owner, cursor, limit, cancellationToken);
        return new AuthoringCanvasListResponse(owner, page.Items, page.NextCursor);
    }

    public Task<AuthoringCanvasDocumentHeader> GetAsync(
        AuthoringCanvasOwner owner, Guid canvasId, CancellationToken cancellationToken)
        => RequireHeaderAsync(owner, canvasId, cancellationToken);

    public async Task<AuthoringCanvasNodesResponse> ReadNodesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(owner, canvasId, cancellationToken);
        AuthoringCanvasPage<AuthoringCanvasNode> page = await store.ReadNodesAsync(
            owner, canvasId, cursor, limit, cancellationToken);
        EnsureCoordinate(header, await RequireHeaderAsync(owner, canvasId, cancellationToken));
        return new AuthoringCanvasNodesResponse(canvasId, header.Revision, header.ContentDigest, page.Items, page.NextCursor);
    }

    public async Task<AuthoringCanvasEdgesResponse> ReadEdgesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(owner, canvasId, cancellationToken);
        AuthoringCanvasPage<AuthoringCanvasEdge> page = await store.ReadEdgesAsync(
            owner, canvasId, cursor, limit, cancellationToken);
        EnsureCoordinate(header, await RequireHeaderAsync(owner, canvasId, cancellationToken));
        return new AuthoringCanvasEdgesResponse(canvasId, header.Revision, header.ContentDigest, page.Items, page.NextCursor);
    }

    public async Task<AuthoringCanvasHistoryResponse> ReadHistoryAsync(
        AuthoringCanvasOwner owner, Guid canvasId, CancellationToken cancellationToken)
    {
        AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(owner, canvasId, cancellationToken);
        AuthoringCanvasHistoryWindow history = await transaction.ReadHistoryAsync(owner, canvasId, cancellationToken);
        EnsureCoordinate(header, await RequireHeaderAsync(owner, canvasId, cancellationToken));
        if (history.CanvasId != canvasId || history.Revision != header.Revision
            || !string.Equals(history.CanvasContentDigest, header.ContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasHistoryConflictException();
        }
        return new AuthoringCanvasHistoryResponse(canvasId, history.Revision,
            history.CanvasContentDigest, history.HistoryDigest,
            history.UndoEntries.Select(Summarize).ToArray(), history.RedoEntries.Select(Summarize).ToArray());
    }

    public Task<AuthoringCanvasOperationReceipt> ApplyAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasApplyRequest request,
        CancellationToken cancellationToken)
    {
        ValidateOperationBudget(request);
        return operations.ApplyAsync(ToOperationRequest(owner, canvasId, request), cancellationToken);
    }

    /// <summary>Prepares only server-owned reference metadata; it does not write or issue an operation receipt.</summary>
    public async Task<AuthoringCanvasApplyRequest> PrepareAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasApplyRequest request,
        CancellationToken cancellationToken)
    {
        ValidateOperationBudget(request);
        AuthoringCanvasOperationContract.ValidateRequest(ToOperationRequest(owner, canvasId, request));
        AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(owner, canvasId, cancellationToken);
        if (header.Revision != request.ExpectedRevision
            || !string.Equals(header.ContentDigest, request.ExpectedContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasRevisionConflictException(request.ExpectedRevision, header.Revision);
        }
        AuthoringCanvasHistoryWindow history = await transaction.ReadHistoryAsync(owner, canvasId, cancellationToken);
        if (history.CanvasId != canvasId || history.Revision != header.Revision
            || !string.Equals(history.CanvasContentDigest, header.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(history.HistoryDigest, request.ExpectedHistoryDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasHistoryConflictException();
        }

        // This request-local roster carries only metadata produced earlier in this same intention batch.
        // The sole operation planner below still compares the first Before with persisted server facts.
        var versions = new Dictionary<Guid, (AuthoringCanvasNode Raw, AuthoringCanvasNode Prepared)>();
        var prepared = new List<AuthoringCanvasWireCommand>(request.Commands.Count);
        foreach (AuthoringCanvasWireCommand command in request.Commands)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthoringCanvasOperationFact[] before = command.Before.Select(fact => Propagate(fact, versions)).ToArray();
            var after = new List<AuthoringCanvasOperationFact>(command.After.Count);
            foreach (AuthoringCanvasOperationFact fact in command.After)
            {
                AuthoringCanvasOperationFact value = Propagate(fact, versions);
                if (fact is { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null }
                    && IsReference(fact.Node))
                {
                    if (command.Kind is AuthoringCanvasOperationKind.CreateReference
                        or AuthoringCanvasOperationKind.PinTargetRevision
                        or AuthoringCanvasOperationKind.UnpinTargetRevision)
                    {
                        value = fact with
                        {
                            Node = await PrepareReferenceAsync(owner, canvasId, request,
                            fact.Node, cancellationToken)
                        };
                    }
                    versions[fact.Id] = (fact.Node, value.Node!);
                }
                else if (fact.Kind == AuthoringCanvasOperationFactKind.Node && !fact.Exists)
                {
                    versions.Remove(fact.Id);
                }
                after.Add(value);
            }
            prepared.Add(command with
            {
                Before = before,
                After = after
            });
        }
        AuthoringCanvasApplyRequest result = request with
        {
            Commands = prepared
        };
        await operations.ValidatePreparationAsync(ToOperationRequest(owner, canvasId, result), cancellationToken);
        EnsureCoordinate(header, await RequireHeaderAsync(owner, canvasId, cancellationToken));
        AuthoringCanvasHistoryWindow finalHistory = await transaction.ReadHistoryAsync(owner, canvasId, cancellationToken);
        if (finalHistory.CanvasId != canvasId || finalHistory.Revision != history.Revision
            || !string.Equals(finalHistory.CanvasContentDigest, history.CanvasContentDigest, StringComparison.Ordinal)
            || !string.Equals(finalHistory.HistoryDigest, history.HistoryDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasHistoryConflictException();
        }
        EnsureCoordinate(header, await RequireHeaderAsync(owner, canvasId, cancellationToken));
        return result;
    }

    private async Task<AuthoringCanvasNode> PrepareReferenceAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasApplyRequest request,
        AuthoringCanvasNode node,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasReferenceResolutionBatch batch = await references.ResolveAsync(
            new AuthoringCanvasReferenceResolutionRequest(request.RequestId, canvasId,
                request.ExpectedRevision, request.ExpectedContentDigest, owner,
                AuthoringCanvasReferencePermission.ArticleRead, [node]), cancellationToken);
        if (batch.Projections.Count != 1)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_reference_unavailable");
        }
        AuthoringCanvasReferenceProjection projection = batch.Projections[0];
        if (projection.NodeId != node.Id || projection.NodeType != node.Type
            || projection.TargetArticleId != node.TargetArticleId
            || projection.TargetHeadingIdentity != node.TargetHeadingIdentity
            || projection.TargetBlockIdentity != node.TargetBlockIdentity
            || projection.TargetRevision != (node.PinnedTargetRevision ?? projection.CurrentTargetRevision)
            || string.IsNullOrEmpty(projection.DisplayProjectionReference))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_reference_unavailable");
        }
        AuthoringCanvasReferenceState state = projection.Status switch
        {
            AuthoringCanvasReferenceProjectionStatus.Current => AuthoringCanvasReferenceState.Current,
            AuthoringCanvasReferenceProjectionStatus.PinnedCurrent
                or AuthoringCanvasReferenceProjectionStatus.PinnedStale => AuthoringCanvasReferenceState.Pinned,
            _ => throw new AuthoringCanvasValidationException("canvas_operation_reference_unavailable")
        };
        return node with
        {
            DisplayProjectionReference = projection.DisplayProjectionReference,
            ReferenceState = state
        };
    }

    private static bool IsReference(AuthoringCanvasNode node)
        => node.Type is AuthoringCanvasNodeType.ArticleReference
            or AuthoringCanvasNodeType.HeadingReference or AuthoringCanvasNodeType.BlockReference;

    private static AuthoringCanvasOperationFact Propagate(
        AuthoringCanvasOperationFact fact,
        IReadOnlyDictionary<Guid, (AuthoringCanvasNode Raw, AuthoringCanvasNode Prepared)> versions)
    {
        if (fact is not { Kind: AuthoringCanvasOperationFactKind.Node, Exists: true, Node: not null }
            || !versions.TryGetValue(fact.Id, out var previous))
        {
            return fact;
        }
        // Changes to intent fields are preserved for the canonical planner to admit or reject.
        // Only metadata still matching the client's prior intention may inherit server preparation.
        if (fact.Node.DisplayProjectionReference != previous.Raw.DisplayProjectionReference
            || fact.Node.ReferenceState != previous.Raw.ReferenceState
            || fact.Node.PinnedTargetRevision != previous.Raw.PinnedTargetRevision)
        {
            return fact;
        }
        return fact with
        {
            Node = fact.Node with
            {
                DisplayProjectionReference = previous.Prepared.DisplayProjectionReference,
                ReferenceState = previous.Prepared.ReferenceState
            }
        };
    }

    private static void ValidateOperationBudget(AuthoringCanvasApplyRequest request)
    {
        if (request.Commands.Count is < 1 or > AuthoringCanvasOperationContract.MaxCommandsPerTransaction)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_command_budget_invalid");
        }
        int factCount = 0;
        foreach (AuthoringCanvasWireCommand command in request.Commands)
        {
            factCount = checked(factCount + command.Before.Count + command.After.Count);
            if (factCount > AuthoringCanvasOperationContract.MaxFactsPerTransaction * 2)
            {
                throw new AuthoringCanvasBudgetExceededException("canvas_operation_fact_budget_exceeded");
            }
        }
    }

    private static AuthoringCanvasOperationRequest ToOperationRequest(
        AuthoringCanvasOwner owner, Guid canvasId, AuthoringCanvasApplyRequest request)
    {
        AuthoringCanvasClosedCommand[] commands = request.Commands.Select(command =>
            AuthoringCanvasOperationContract.SealCommand(command.CommandId, command.Kind,
                command.Before.Select(SealFact).ToArray(), command.After.Select(SealFact).ToArray())).ToArray();
        return new AuthoringCanvasOperationRequest(request.RequestId, canvasId,
            owner, owner.AdminPrincipalId, request.ExpectedRevision, request.ExpectedContentDigest,
            request.ExpectedHistoryDigest, commands);
    }

    public Task<AuthoringCanvasOperationReceipt> ApplyHistoryAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasUndoRedoRequest request,
        CancellationToken cancellationToken)
    {
        var history = new AuthoringCanvasHistoryRequest(request.RequestId, canvasId, owner,
            owner.AdminPrincipalId, request.ExpectedRevision, request.ExpectedContentDigest,
            request.ExpectedHistoryDigest, request.TargetJournalId, request.Mode);
        return request.Mode switch
        {
            AuthoringCanvasJournalMode.Undo => operations.UndoAsync(history, cancellationToken),
            AuthoringCanvasJournalMode.Redo => operations.RedoAsync(history, cancellationToken),
            _ => throw new AuthoringCanvasValidationException("canvas_history_mode_invalid")
        };
    }

    public Task<AuthoringCanvasWriteReceipt> DeleteAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasDeleteRequest request,
        CancellationToken cancellationToken)
        => store.DeleteAsync(new DeleteAuthoringCanvasCommand(canvasId, owner,
            request.ExpectedRevision, request.RequestId), cancellationToken);

    public async Task<AuthoringCanvasReferenceResolutionBatch> ResolveAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasResolveRequest request,
        CancellationToken cancellationToken)
    {
        if (request.NodeIds.Count is < 1 or > AuthoringCanvasContract.MaxPageSize
            || request.NodeIds.Any(static id => id == Guid.Empty)
            || request.NodeIds.Distinct().Count() != request.NodeIds.Count)
        {
            throw new AuthoringCanvasValidationException("canvas_reference_node_ids_invalid");
        }
        AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(owner, canvasId, cancellationToken);
        if (header.Revision != request.CanvasRevision
            || !string.Equals(header.ContentDigest, request.CanvasContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasRevisionConflictException(request.CanvasRevision, header.Revision);
        }
        var remaining = request.NodeIds.ToHashSet();
        var nodes = new Dictionary<Guid, AuthoringCanvasNode>(request.NodeIds.Count);
        AuthoringCanvasPageCursor? cursor = null;
        int visited = 0;
        do
        {
            AuthoringCanvasPage<AuthoringCanvasNode> page = await store.ReadNodesAsync(
                owner, canvasId, cursor, AuthoringCanvasContract.MaxPageSize, cancellationToken);
            visited = checked(visited + page.Items.Count);
            if (visited > AuthoringCanvasContract.MaxNodesPerCanvas || page.Items.Count == 0 && page.NextCursor is not null)
            {
                throw new AuthoringCanvasValidationException("canvas_reference_page_invalid");
            }
            foreach (AuthoringCanvasNode node in page.Items)
            {
                if (remaining.Remove(node.Id))
                {
                    nodes.Add(node.Id, node);
                }
            }
            if (page.NextCursor is not null && page.NextCursor == cursor)
            {
                throw new AuthoringCanvasValidationException("canvas_reference_cursor_invalid");
            }
            cursor = page.NextCursor;
        }
        while (remaining.Count != 0 && cursor is not null);
        EnsureCoordinate(header, await RequireHeaderAsync(owner, canvasId, cancellationToken));
        if (remaining.Count != 0)
        {
            throw new AuthoringCanvasAccessDeniedException();
        }
        return await references.ResolveAsync(new AuthoringCanvasReferenceResolutionRequest(request.RequestId,
            canvasId, request.CanvasRevision, request.CanvasContentDigest, owner,
            AuthoringCanvasReferencePermission.ArticleRead,
            request.NodeIds.Select(id => nodes[id]).ToArray(), request.TargetWorkspaceGroupId), cancellationToken);
    }

    private async Task<AuthoringCanvasDocumentHeader> RequireHeaderAsync(
        AuthoringCanvasOwner owner, Guid canvasId, CancellationToken cancellationToken)
        => await store.GetAsync(owner, canvasId, cancellationToken) ?? throw new AuthoringCanvasAccessDeniedException();

    private static void EnsureCoordinate(AuthoringCanvasDocumentHeader expected, AuthoringCanvasDocumentHeader actual)
    {
        if (expected.Revision != actual.Revision
            || !string.Equals(expected.ContentDigest, actual.ContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasRevisionConflictException(expected.Revision, actual.Revision);
        }
    }

    private static AuthoringCanvasJournalSummary Summarize(AuthoringCanvasOperationJournalEntry entry)
        => new(entry.JournalId, entry.Revision, entry.Mode, entry.RequestId, entry.TargetJournalId);

    private static AuthoringCanvasOperationFact SealFact(AuthoringCanvasOperationFact fact)
    {
        AuthoringCanvasOperationContract.ValidateFact(fact, validateDigest: false);
        if (!fact.Exists)
        {
            return AuthoringCanvasOperationContract.Missing(fact.Kind, fact.Id);
        }
        return fact.Kind switch
        {
            AuthoringCanvasOperationFactKind.Node => AuthoringCanvasOperationContract.Present(fact.Node!),
            AuthoringCanvasOperationFactKind.Edge => AuthoringCanvasOperationContract.Present(fact.Edge!),
            AuthoringCanvasOperationFactKind.Viewport => AuthoringCanvasOperationContract.Present(fact.Viewport!.Value),
            _ => throw new AuthoringCanvasValidationException("canvas_operation_fact_kind_invalid")
        };
    }
}
