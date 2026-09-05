using System.Data.Common;
using System.Text.Json;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// PostgreSQL authority for atomic canvas fact updates, append-only journal entries, bounded
/// undo/redo heads, and request recovery. It has no dependency on article or relation writers.
/// </summary>
public sealed class PostgresAuthoringCanvasOperationTransaction(
    ISqlSugarClient db,
    IAuthoringCanvasDocumentStore documentStore,
    TimeProvider timeProvider) : IAuthoringCanvasOperationTransaction
{
    public async Task<AuthoringCanvasOperationReceipt> CommitAsync(
        AuthoringCanvasOperationPlan plan,
        CancellationToken cancellationToken = default)
    {
        ValidatePlan(plan);
        AuthoringCanvasOperationReceipt? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireLockAsync(plan.CanvasId).ConfigureAwait(false);
            AuthoringCanvasOperationReceipt? replay = await ReadReceiptAsync(
                plan.CanvasId,
                plan.Owner,
                plan.RequestId,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                if (!string.Equals(replay.TransactionDigest, plan.TransactionDigest, StringComparison.Ordinal))
                {
                    throw new AuthoringCanvasIdempotencyConflictException();
                }
                result = AsReplay(replay);
                return;
            }

            AuthoringCanvasDocumentHeader header = await ReadHeaderForUpdateAsync(
                plan.Owner,
                plan.CanvasId,
                cancellationToken).ConfigureAwait(false)
                ?? throw new AuthoringCanvasAccessDeniedException();
            if (header.Revision != plan.ExpectedRevision)
            {
                throw new AuthoringCanvasRevisionConflictException(plan.ExpectedRevision, header.Revision);
            }
            if (!string.Equals(header.ContentDigest, plan.ExpectedContentDigest, StringComparison.Ordinal))
            {
                throw new AuthoringCanvasValidationException("canvas_operation_content_digest_stale");
            }

            HistoryState history = await ReadHistoryStateForUpdateAsync(
                header,
                cancellationToken).ConfigureAwait(false);
            ValidateHistoryPlan(plan, history);
            await ValidateBeforeFactsAsync(plan, header, cancellationToken).ConfigureAwait(false);
            await ApplyFactsAsync(plan, cancellationToken).ConfigureAwait(false);

            int nodeCount = await CountAsync(
                "authoring_canvas_node",
                plan.CanvasId).ConfigureAwait(false);
            int edgeCount = await CountAsync(
                "authoring_canvas_edge",
                plan.CanvasId).ConfigureAwait(false);
            if (nodeCount != plan.ResultNodeCount || edgeCount != plan.ResultEdgeCount)
            {
                throw new AuthoringCanvasValidationException("canvas_operation_result_count_mismatch");
            }

            long revision = header.Revision + 1;
            string contentDigest = AuthoringCanvasContract.ComputeTransitionDigest(
                header.ContentDigest,
                revision,
                $"canvas-operation:{plan.Mode}",
                plan.TransactionDigest,
                nodeCount,
                edgeCount);
            Guid journalId = Guid.CreateVersion7();
            var entry = new AuthoringCanvasOperationJournalEntry(
                journalId,
                plan.CanvasId,
                revision,
                plan.Mode,
                plan.RequestId,
                plan.ActorUserId,
                history.LastJournalId,
                plan.TargetJournalId,
                header.ContentDigest,
                contentDigest,
                plan.TransactionDigest,
                plan.CommandKinds,
                plan.Commands,
                plan.ForwardFacts,
                plan.InverseFacts,
                plan.AffectedNodeIds,
                plan.AffectedEdgeIds,
                plan.TruncatedRedoJournalIds,
                plan.ReferenceValidationDigest,
                string.Empty);
            entry = entry with
            {
                JournalDigest = AuthoringCanvasOperationContract.ComputeJournalDigest(entry)
            };
            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            await InsertJournalAsync(entry, plan.Owner, nodeCount, edgeCount, now).ConfigureAwait(false);
            await InsertCommandsAsync(entry, cancellationToken).ConfigureAwait(false);
            await InsertFactsAsync(entry, cancellationToken).ConfigureAwait(false);

            (List<Guid> undo, List<Guid> redo) = AdvanceHistory(history, entry);
            string historyDigest = AuthoringCanvasContract.ComputeCommandDigest(
                "canvas-operation-history",
                revision,
                string.Join(',', undo),
                string.Join(',', redo),
                entry.JournalDigest);
            await UpdateDocumentAsync(
                plan,
                header,
                revision,
                contentDigest,
                nodeCount,
                edgeCount,
                now).ConfigureAwait(false);
            await PersistHistoryStateAsync(
                plan,
                revision,
                contentDigest,
                historyDigest,
                undo,
                redo,
                journalId,
                now).ConfigureAwait(false);

            var receipt = new AuthoringCanvasOperationReceipt(
                Guid.CreateVersion7(),
                plan.RequestId,
                plan.CanvasId,
                revision,
                plan.Mode,
                journalId,
                plan.TargetJournalId,
                plan.CommandKinds.Count,
                plan.CommandKinds,
                plan.AffectedNodeIds,
                plan.AffectedEdgeIds,
                undo.Count,
                redo.Count,
                AuthoringCanvasOperationStatus.Committed,
                [],
                plan.TransactionDigest,
                entry.JournalDigest,
                contentDigest,
                string.Empty);
            receipt = receipt with
            {
                ReceiptDigest = AuthoringCanvasOperationContract.ComputeReceiptDigest(receipt)
            };
            await InsertReceiptAsync(receipt, plan.Owner, plan.ReferenceValidationDigest, now)
                .ConfigureAwait(false);
            result = receipt;
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("authoring_canvas_operation_transaction_failed");
        }
        return result!;
    }

    public async Task<AuthoringCanvasOperationReceipt?> RecoverAsync(
        AuthoringCanvasOperationRecoveryQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        AuthoringCanvasContract.ValidateOwner(query.Owner);
        AuthoringCanvasOperationReceipt? receipt = await ReadReceiptAsync(
            query.CanvasId,
            query.Owner,
            query.RequestId,
            cancellationToken).ConfigureAwait(false);
        if (receipt is null)
        {
            return null;
        }
        if (!string.Equals(receipt.TransactionDigest, query.TransactionDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasIdempotencyConflictException();
        }
        return AsReplay(receipt);
    }

    public async Task<AuthoringCanvasHistoryWindow> ReadHistoryAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        AuthoringCanvasDocumentHeader header = await documentStore.GetAsync(
            owner,
            canvasId,
            cancellationToken).ConfigureAwait(false)
            ?? throw new AuthoringCanvasAccessDeniedException();
        HistoryState state = await ReadHistoryStateAsync(header, forUpdate: false, cancellationToken)
            .ConfigureAwait(false);
        Guid[] ids = state.Undo.Concat(state.Redo).Distinct().ToArray();
        IReadOnlyDictionary<Guid, AuthoringCanvasOperationJournalEntry> entries =
            await ReadEntriesAsync(owner, canvasId, ids, cancellationToken).ConfigureAwait(false);
        AuthoringCanvasOperationJournalEntry[] undo = state.Undo
            .AsEnumerable().Reverse().Select(id => RequireEntry(entries, id)).ToArray();
        AuthoringCanvasOperationJournalEntry[] redo = state.Redo
            .AsEnumerable().Reverse().Select(id => RequireEntry(entries, id)).ToArray();
        return new AuthoringCanvasHistoryWindow(
            canvasId,
            header.Revision,
            header.ContentDigest,
            state.HistoryDigest,
            undo,
            redo);
    }

    private async Task ValidateBeforeFactsAsync(
        AuthoringCanvasOperationPlan plan,
        AuthoringCanvasDocumentHeader lockedHeader,
        CancellationToken cancellationToken)
    {
        var actual = new Dictionary<FactKey, AuthoringCanvasOperationFact>();
        AuthoringCanvasPageCursor? cursor = null;
        do
        {
            AuthoringCanvasPage<AuthoringCanvasNode> page = await documentStore.ReadNodesAsync(
                plan.Owner,
                plan.CanvasId,
                cursor,
                AuthoringCanvasContract.MaxPageSize,
                cancellationToken).ConfigureAwait(false);
            foreach (AuthoringCanvasNode node in page.Items)
            {
                actual[new FactKey(AuthoringCanvasOperationFactKind.Node, node.Id)] =
                    AuthoringCanvasOperationContract.Present(node);
            }
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        cursor = null;
        do
        {
            AuthoringCanvasPage<AuthoringCanvasEdge> page = await documentStore.ReadEdgesAsync(
                plan.Owner,
                plan.CanvasId,
                cursor,
                AuthoringCanvasContract.MaxPageSize,
                cancellationToken).ConfigureAwait(false);
            foreach (AuthoringCanvasEdge edge in page.Items)
            {
                actual[new FactKey(AuthoringCanvasOperationFactKind.Edge, edge.Id)] =
                    AuthoringCanvasOperationContract.Present(edge);
            }
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        actual[new FactKey(AuthoringCanvasOperationFactKind.Viewport, Guid.Empty)] =
            AuthoringCanvasOperationContract.Present(lockedHeader.Viewport);

        foreach (AuthoringCanvasOperationFact expected in plan.InverseFacts)
        {
            var key = new FactKey(expected.Kind, expected.Id);
            AuthoringCanvasOperationFact observed = actual.GetValueOrDefault(
                key,
                AuthoringCanvasOperationContract.Missing(expected.Kind, expected.Id));
            if (!string.Equals(observed.ContentDigest, expected.ContentDigest, StringComparison.Ordinal))
            {
                throw new AuthoringCanvasRevisionConflictException(plan.ExpectedRevision, lockedHeader.Revision);
            }
        }
        if (actual.Keys.Count(static key => key.Kind == AuthoringCanvasOperationFactKind.Node)
                != lockedHeader.NodeCount
            || actual.Keys.Count(static key => key.Kind == AuthoringCanvasOperationFactKind.Edge)
                != lockedHeader.EdgeCount)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_snapshot_count_mismatch");
        }
    }

    private async Task ApplyFactsAsync(
        AuthoringCanvasOperationPlan plan,
        CancellationToken cancellationToken)
    {
        foreach (AuthoringCanvasOperationFact fact in plan.ForwardFacts.Where(static fact =>
            fact.Kind == AuthoringCanvasOperationFactKind.Edge && !fact.Exists))
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                "DELETE FROM authoring_canvas_edge WHERE canvas_id = @CanvasId AND edge_id = @EdgeId;",
                new SugarParameter("@CanvasId", plan.CanvasId),
                new SugarParameter("@EdgeId", fact.Id)).ConfigureAwait(false);
        }
        foreach (AuthoringCanvasOperationFact fact in plan.ForwardFacts.Where(static fact =>
            fact.Kind == AuthoringCanvasOperationFactKind.Node && !fact.Exists))
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                "DELETE FROM authoring_canvas_node WHERE canvas_id = @CanvasId AND node_id = @NodeId;",
                new SugarParameter("@CanvasId", plan.CanvasId),
                new SugarParameter("@NodeId", fact.Id)).ConfigureAwait(false);
        }
        foreach (AuthoringCanvasNode node in plan.ForwardFacts.Where(static fact =>
            fact.Kind == AuthoringCanvasOperationFactKind.Node && fact.Exists).Select(static fact => fact.Node!))
        {
            cancellationToken.ThrowIfCancellationRequested();
            await UpsertNodeAsync(plan.CanvasId, node).ConfigureAwait(false);
        }
        foreach (AuthoringCanvasNode node in plan.ForwardFacts.Where(static fact =>
            fact.Kind == AuthoringCanvasOperationFactKind.Node && fact.Exists).Select(static fact => fact.Node!))
        {
            await ReplaceFrameMembersAsync(plan.CanvasId, node, cancellationToken).ConfigureAwait(false);
        }
        foreach (AuthoringCanvasEdge edge in plan.ForwardFacts.Where(static fact =>
            fact.Kind == AuthoringCanvasOperationFactKind.Edge && fact.Exists).Select(static fact => fact.Edge!))
        {
            cancellationToken.ThrowIfCancellationRequested();
            await UpsertEdgeAsync(plan.CanvasId, edge).ConfigureAwait(false);
        }
    }

    private async Task UpsertNodeAsync(Guid canvasId, AuthoringCanvasNode node)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_node(
                canvas_id, node_id, node_type, node_order, position_x, position_y, width, height,
                target_article_id, target_heading_identity, target_block_identity,
                pinned_target_revision, display_projection_ref, reference_state,
                note_source, frame_label, content_digest)
            VALUES (
                @CanvasId, @NodeId, @NodeType, @NodeOrder, @PositionX, @PositionY, @Width, @Height,
                @TargetArticleId, @TargetHeadingIdentity, @TargetBlockIdentity,
                @PinnedTargetRevision, @DisplayProjectionRef, @ReferenceState,
                @NoteSource, @FrameLabel, @ContentDigest)
            ON CONFLICT (canvas_id, node_id) DO UPDATE SET
                node_type = EXCLUDED.node_type,
                node_order = EXCLUDED.node_order,
                position_x = EXCLUDED.position_x,
                position_y = EXCLUDED.position_y,
                width = EXCLUDED.width,
                height = EXCLUDED.height,
                target_article_id = EXCLUDED.target_article_id,
                target_heading_identity = EXCLUDED.target_heading_identity,
                target_block_identity = EXCLUDED.target_block_identity,
                pinned_target_revision = EXCLUDED.pinned_target_revision,
                display_projection_ref = EXCLUDED.display_projection_ref,
                reference_state = EXCLUDED.reference_state,
                note_source = EXCLUDED.note_source,
                frame_label = EXCLUDED.frame_label,
                content_digest = EXCLUDED.content_digest;
            """,
            NodeParameters(canvasId, node)).ConfigureAwait(false);

    private async Task ReplaceFrameMembersAsync(
        Guid canvasId,
        AuthoringCanvasNode node,
        CancellationToken cancellationToken)
    {
        await db.Ado.ExecuteCommandAsync(
            "DELETE FROM authoring_canvas_frame_member WHERE canvas_id = @CanvasId AND frame_node_id = @NodeId;",
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@NodeId", node.Id)).ConfigureAwait(false);
        if (node.Type != AuthoringCanvasNodeType.GroupFrame)
        {
            return;
        }
        for (int index = 0; index < node.MemberNodeIds.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_canvas_frame_member(
                    canvas_id, frame_node_id, member_node_id, member_order)
                VALUES (@CanvasId, @FrameNodeId, @MemberNodeId, @MemberOrder);
                """,
                new SugarParameter("@CanvasId", canvasId),
                new SugarParameter("@FrameNodeId", node.Id),
                new SugarParameter("@MemberNodeId", node.MemberNodeIds[index]),
                new SugarParameter("@MemberOrder", index)).ConfigureAwait(false);
        }
    }

    private async Task UpsertEdgeAsync(Guid canvasId, AuthoringCanvasEdge edge)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_edge(
                canvas_id, edge_id, edge_type, edge_order, source_node_id, target_node_id,
                label, content_digest)
            VALUES (
                @CanvasId, @EdgeId, @EdgeType, @EdgeOrder, @SourceNodeId, @TargetNodeId,
                @Label, @ContentDigest)
            ON CONFLICT (canvas_id, edge_id) DO UPDATE SET
                edge_type = EXCLUDED.edge_type,
                edge_order = EXCLUDED.edge_order,
                source_node_id = EXCLUDED.source_node_id,
                target_node_id = EXCLUDED.target_node_id,
                label = EXCLUDED.label,
                content_digest = EXCLUDED.content_digest;
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@EdgeId", edge.Id),
            new SugarParameter("@EdgeType", ToStorage(edge.Type)),
            new SugarParameter("@EdgeOrder", edge.Order),
            new SugarParameter("@SourceNodeId", edge.SourceNodeId),
            new SugarParameter("@TargetNodeId", edge.TargetNodeId),
            new SugarParameter("@Label", DbValue(edge.Label)),
            new SugarParameter("@ContentDigest", AuthoringCanvasContract.ComputeEdgeDigest(edge)))
            .ConfigureAwait(false);

    private async Task InsertJournalAsync(
        AuthoringCanvasOperationJournalEntry entry,
        AuthoringCanvasOwner owner,
        int nodeCount,
        int edgeCount,
        DateTime now)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_operation_journal(
                journal_id, canvas_id, owner_admin_principal_id, site_scope, revision, mode,
                request_id, actor_user_id, parent_journal_id, target_journal_id,
                previous_content_digest, content_digest, transaction_digest,
                reference_validation_digest, command_kinds, affected_node_ids, affected_edge_ids,
                truncated_redo_journal_ids, result_node_count, result_edge_count,
                journal_digest, created_at_utc)
            VALUES (
                @JournalId, @CanvasId, @OwnerAdminPrincipalId, @SiteScope, @Revision, @Mode,
                @RequestId, @ActorUserId, @ParentJournalId, @TargetJournalId,
                @PreviousContentDigest, @ContentDigest, @TransactionDigest,
                @ReferenceValidationDigest, @CommandKinds, @AffectedNodeIds, @AffectedEdgeIds,
                @TruncatedRedoJournalIds, @ResultNodeCount, @ResultEdgeCount,
                @JournalDigest, @CreatedAtUtc);
            """,
            new SugarParameter("@JournalId", entry.JournalId),
            new SugarParameter("@CanvasId", entry.CanvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@Revision", entry.Revision),
            new SugarParameter("@Mode", (short)entry.Mode),
            new SugarParameter("@RequestId", entry.RequestId),
            new SugarParameter("@ActorUserId", entry.ActorUserId),
            new SugarParameter("@ParentJournalId", DbValue(entry.ParentJournalId)),
            new SugarParameter("@TargetJournalId", DbValue(entry.TargetJournalId)),
            new SugarParameter("@PreviousContentDigest", entry.PreviousContentDigest),
            new SugarParameter("@ContentDigest", entry.ContentDigest),
            new SugarParameter("@TransactionDigest", entry.TransactionDigest),
            new SugarParameter("@ReferenceValidationDigest", entry.ReferenceValidationDigest),
            new SugarParameter("@CommandKinds", entry.CommandKinds.Select(static kind => (short)kind).ToArray()),
            new SugarParameter("@AffectedNodeIds", entry.AffectedNodeIds.ToArray()),
            new SugarParameter("@AffectedEdgeIds", entry.AffectedEdgeIds.ToArray()),
            new SugarParameter("@TruncatedRedoJournalIds", entry.TruncatedRedoJournalIds.ToArray()),
            new SugarParameter("@ResultNodeCount", nodeCount),
            new SugarParameter("@ResultEdgeCount", edgeCount),
            new SugarParameter("@JournalDigest", entry.JournalDigest),
            new SugarParameter("@CreatedAtUtc", now)).ConfigureAwait(false);

    private async Task InsertFactsAsync(
        AuthoringCanvasOperationJournalEntry entry,
        CancellationToken cancellationToken)
    {
        await InsertFactSetAsync(entry.JournalId, 0, entry.InverseFacts, cancellationToken)
            .ConfigureAwait(false);
        await InsertFactSetAsync(entry.JournalId, 1, entry.ForwardFacts, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task InsertCommandsAsync(
        AuthoringCanvasOperationJournalEntry entry,
        CancellationToken cancellationToken)
    {
        for (int commandOrdinal = 0; commandOrdinal < entry.Commands.Count; commandOrdinal++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthoringCanvasClosedCommand command = entry.Commands[commandOrdinal];
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_canvas_operation_command(
                    journal_id, command_ordinal, command_id, command_kind, command_digest)
                VALUES (@JournalId, @CommandOrdinal, @CommandId, @CommandKind, @CommandDigest);
                """,
                new SugarParameter("@JournalId", entry.JournalId),
                new SugarParameter("@CommandOrdinal", commandOrdinal),
                new SugarParameter("@CommandId", command.CommandId),
                new SugarParameter("@CommandKind", (short)command.Kind),
                new SugarParameter("@CommandDigest", command.ContentDigest)).ConfigureAwait(false);
            await InsertCommandFactSetAsync(
                entry.JournalId,
                commandOrdinal,
                0,
                command.Before,
                cancellationToken).ConfigureAwait(false);
            await InsertCommandFactSetAsync(
                entry.JournalId,
                commandOrdinal,
                1,
                command.After,
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task InsertCommandFactSetAsync(
        Guid journalId,
        int commandOrdinal,
        short direction,
        IReadOnlyList<AuthoringCanvasOperationFact> facts,
        CancellationToken cancellationToken)
    {
        for (int factOrder = 0; factOrder < facts.Count; factOrder++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthoringCanvasOperationFact fact = facts[factOrder];
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_canvas_operation_command_fact(
                    journal_id, command_ordinal, direction, fact_order, fact_payload, fact_digest)
                VALUES (
                    @JournalId, @CommandOrdinal, @Direction, @FactOrder,
                    CAST(@FactPayload AS jsonb), @FactDigest);
                """,
                new SugarParameter("@JournalId", journalId),
                new SugarParameter("@CommandOrdinal", commandOrdinal),
                new SugarParameter("@Direction", direction),
                new SugarParameter("@FactOrder", factOrder),
                new SugarParameter("@FactPayload", JsonSerializer.Serialize(fact)),
                new SugarParameter("@FactDigest", fact.ContentDigest)).ConfigureAwait(false);
        }
    }

    private async Task InsertFactSetAsync(
        Guid journalId,
        short direction,
        IReadOnlyList<AuthoringCanvasOperationFact> facts,
        CancellationToken cancellationToken)
    {
        for (int index = 0; index < facts.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthoringCanvasOperationFact fact = facts[index];
            AuthoringCanvasNode? node = fact.Node;
            AuthoringCanvasEdge? edge = fact.Edge;
            AuthoringCanvasViewport? viewport = fact.Viewport;
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_canvas_operation_fact(
                    journal_id, direction, fact_order, fact_kind, fact_id, exists,
                    node_type, node_order, position_x, position_y, width, height,
                    target_article_id, target_heading_identity, target_block_identity,
                    pinned_target_revision, display_projection_ref, reference_state,
                    note_source, frame_label, frame_member_ids,
                    edge_type, edge_order, source_node_id, target_node_id, edge_label,
                    viewport_x, viewport_y, viewport_zoom, fact_digest)
                VALUES (
                    @JournalId, @Direction, @FactOrder, @FactKind, @FactId, @Exists,
                    @NodeType, @NodeOrder, @PositionX, @PositionY, @Width, @Height,
                    @TargetArticleId, @TargetHeadingIdentity, @TargetBlockIdentity,
                    @PinnedTargetRevision, @DisplayProjectionRef, @ReferenceState,
                    @NoteSource, @FrameLabel, @FrameMemberIds,
                    @EdgeType, @EdgeOrder, @SourceNodeId, @TargetNodeId, @EdgeLabel,
                    @ViewportX, @ViewportY, @ViewportZoom, @FactDigest);
                """,
                new SugarParameter("@JournalId", journalId),
                new SugarParameter("@Direction", direction),
                new SugarParameter("@FactOrder", index),
                new SugarParameter("@FactKind", (short)fact.Kind),
                new SugarParameter("@FactId", fact.Id),
                new SugarParameter("@Exists", fact.Exists),
                new SugarParameter("@NodeType", DbValue(node is null ? null : (short)node.Type)),
                new SugarParameter("@NodeOrder", DbValue(node?.Order)),
                new SugarParameter("@PositionX", DbValue(node?.Geometry.X)),
                new SugarParameter("@PositionY", DbValue(node?.Geometry.Y)),
                new SugarParameter("@Width", DbValue(node?.Geometry.Width)),
                new SugarParameter("@Height", DbValue(node?.Geometry.Height)),
                new SugarParameter("@TargetArticleId", DbValue(node?.TargetArticleId)),
                new SugarParameter("@TargetHeadingIdentity", DbValue(node?.TargetHeadingIdentity)),
                new SugarParameter("@TargetBlockIdentity", DbValue(node?.TargetBlockIdentity)),
                new SugarParameter("@PinnedTargetRevision", DbValue(node?.PinnedTargetRevision)),
                new SugarParameter("@DisplayProjectionRef", DbValue(node?.DisplayProjectionReference)),
                new SugarParameter("@ReferenceState", DbValue(node?.ReferenceState is null
                    ? null
                    : (short)node.ReferenceState.Value)),
                new SugarParameter("@NoteSource", DbValue(node?.NoteSource)),
                new SugarParameter("@FrameLabel", DbValue(node?.FrameLabel)),
                new SugarParameter("@FrameMemberIds", DbValue(node?.MemberNodeIds.ToArray())),
                new SugarParameter("@EdgeType", DbValue(edge is null ? null : (short)edge.Type)),
                new SugarParameter("@EdgeOrder", DbValue(edge?.Order)),
                new SugarParameter("@SourceNodeId", DbValue(edge?.SourceNodeId)),
                new SugarParameter("@TargetNodeId", DbValue(edge?.TargetNodeId)),
                new SugarParameter("@EdgeLabel", DbValue(edge?.Label)),
                new SugarParameter("@ViewportX", DbValue(viewport?.X)),
                new SugarParameter("@ViewportY", DbValue(viewport?.Y)),
                new SugarParameter("@ViewportZoom", DbValue(viewport?.Zoom)),
                new SugarParameter("@FactDigest", fact.ContentDigest)).ConfigureAwait(false);
        }
    }

    private async Task UpdateDocumentAsync(
        AuthoringCanvasOperationPlan plan,
        AuthoringCanvasDocumentHeader header,
        long revision,
        string contentDigest,
        int nodeCount,
        int edgeCount,
        DateTime now)
    {
        AuthoringCanvasViewport viewport = plan.ForwardFacts
            .Where(static fact => fact.Kind == AuthoringCanvasOperationFactKind.Viewport && fact.Exists)
            .Select(static fact => fact.Viewport!.Value)
            .SingleOrDefault(header.Viewport);
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE authoring_canvas_document
            SET revision = @Revision,
                viewport_x = @ViewportX,
                viewport_y = @ViewportY,
                viewport_zoom = @ViewportZoom,
                node_count = @NodeCount,
                edge_count = @EdgeCount,
                updated_at_utc = @UpdatedAtUtc,
                content_digest = @ContentDigest
            WHERE id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND revision = @ExpectedRevision
              AND content_digest = @ExpectedContentDigest;
            """,
            new SugarParameter("@Revision", revision),
            new SugarParameter("@ViewportX", viewport.X),
            new SugarParameter("@ViewportY", viewport.Y),
            new SugarParameter("@ViewportZoom", viewport.Zoom),
            new SugarParameter("@NodeCount", nodeCount),
            new SugarParameter("@EdgeCount", edgeCount),
            new SugarParameter("@UpdatedAtUtc", now),
            new SugarParameter("@ContentDigest", contentDigest),
            new SugarParameter("@CanvasId", plan.CanvasId),
            new SugarParameter("@OwnerAdminPrincipalId", plan.Owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", plan.Owner.SiteScope),
            new SugarParameter("@ExpectedRevision", header.Revision),
            new SugarParameter("@ExpectedContentDigest", header.ContentDigest)).ConfigureAwait(false);
        if (updated != 1)
        {
            throw new AuthoringCanvasRevisionConflictException(plan.ExpectedRevision, header.Revision);
        }
    }

    private async Task PersistHistoryStateAsync(
        AuthoringCanvasOperationPlan plan,
        long revision,
        string contentDigest,
        string historyDigest,
        IReadOnlyList<Guid> undo,
        IReadOnlyList<Guid> redo,
        Guid lastJournalId,
        DateTime now)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_operation_history_state(
                canvas_id, owner_admin_principal_id, site_scope, revision,
                canvas_content_digest, history_digest, undo_journal_ids, redo_journal_ids,
                last_journal_id, updated_at_utc)
            VALUES (
                @CanvasId, @OwnerAdminPrincipalId, @SiteScope, @Revision,
                @CanvasContentDigest, @HistoryDigest, @UndoJournalIds, @RedoJournalIds,
                @LastJournalId, @UpdatedAtUtc)
            ON CONFLICT (canvas_id) DO UPDATE SET
                owner_admin_principal_id = EXCLUDED.owner_admin_principal_id,
                site_scope = EXCLUDED.site_scope,
                revision = EXCLUDED.revision,
                canvas_content_digest = EXCLUDED.canvas_content_digest,
                history_digest = EXCLUDED.history_digest,
                undo_journal_ids = EXCLUDED.undo_journal_ids,
                redo_journal_ids = EXCLUDED.redo_journal_ids,
                last_journal_id = EXCLUDED.last_journal_id,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@CanvasId", plan.CanvasId),
            new SugarParameter("@OwnerAdminPrincipalId", plan.Owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", plan.Owner.SiteScope),
            new SugarParameter("@Revision", revision),
            new SugarParameter("@CanvasContentDigest", contentDigest),
            new SugarParameter("@HistoryDigest", historyDigest),
            new SugarParameter("@UndoJournalIds", undo.ToArray()),
            new SugarParameter("@RedoJournalIds", redo.ToArray()),
            new SugarParameter("@LastJournalId", lastJournalId),
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);

    private async Task InsertReceiptAsync(
        AuthoringCanvasOperationReceipt receipt,
        AuthoringCanvasOwner owner,
        string referenceValidationDigest,
        DateTime now)
        => await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_operation_receipt(
                receipt_id, journal_id, canvas_id, owner_admin_principal_id, site_scope,
                request_id, revision, mode, target_journal_id, command_count, command_kinds,
                affected_node_ids, affected_edge_ids, undo_depth, redo_depth, status, reasons,
                transaction_digest, reference_validation_digest, journal_digest,
                canvas_content_digest, receipt_digest, created_at_utc)
            VALUES (
                @ReceiptId, @JournalId, @CanvasId, @OwnerAdminPrincipalId, @SiteScope,
                @RequestId, @Revision, @Mode, @TargetJournalId, @CommandCount, @CommandKinds,
                @AffectedNodeIds, @AffectedEdgeIds, @UndoDepth, @RedoDepth, @Status, @Reasons,
                @TransactionDigest, @ReferenceValidationDigest, @JournalDigest,
                @CanvasContentDigest, @ReceiptDigest, @CreatedAtUtc);
            """,
            new SugarParameter("@ReceiptId", receipt.ReceiptId),
            new SugarParameter("@JournalId", receipt.JournalId),
            new SugarParameter("@CanvasId", receipt.CanvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@RequestId", receipt.RequestId),
            new SugarParameter("@Revision", receipt.Revision),
            new SugarParameter("@Mode", (short)receipt.Mode),
            new SugarParameter("@TargetJournalId", DbValue(receipt.TargetJournalId)),
            new SugarParameter("@CommandCount", receipt.CommandCount),
            new SugarParameter("@CommandKinds", receipt.CommandKinds.Select(static kind => (short)kind).ToArray()),
            new SugarParameter("@AffectedNodeIds", receipt.AffectedNodeIds.ToArray()),
            new SugarParameter("@AffectedEdgeIds", receipt.AffectedEdgeIds.ToArray()),
            new SugarParameter("@UndoDepth", receipt.UndoDepth),
            new SugarParameter("@RedoDepth", receipt.RedoDepth),
            new SugarParameter("@Status", (short)receipt.Status),
            new SugarParameter("@Reasons", receipt.Reasons.ToArray()),
            new SugarParameter("@TransactionDigest", receipt.TransactionDigest),
            new SugarParameter("@ReferenceValidationDigest", referenceValidationDigest),
            new SugarParameter("@JournalDigest", receipt.JournalDigest),
            new SugarParameter("@CanvasContentDigest", receipt.CanvasContentDigest),
            new SugarParameter("@ReceiptDigest", receipt.ReceiptDigest),
            new SugarParameter("@CreatedAtUtc", now)).ConfigureAwait(false);

    private async Task<AuthoringCanvasOperationReceipt?> ReadReceiptAsync(
        Guid canvasId,
        AuthoringCanvasOwner owner,
        Guid requestId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT receipt_id, request_id, canvas_id, revision, mode, journal_id,
                   target_journal_id, command_count, command_kinds, affected_node_ids,
                   affected_edge_ids, undo_depth, redo_depth, status, reasons,
                   transaction_digest, journal_digest, canvas_content_digest, receipt_digest
            FROM authoring_canvas_operation_receipt
            WHERE canvas_id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND request_id = @RequestId;
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@RequestId", requestId)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadReceipt(reader)
            : null;
    }

    private async Task<AuthoringCanvasDocumentHeader?> ReadHeaderForUpdateAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, owner_admin_principal_id, site_scope, schema_version, revision, title,
                   viewport_x, viewport_y, viewport_zoom, node_count, edge_count,
                   created_at_utc, updated_at_utc, content_digest
            FROM authoring_canvas_document
            WHERE id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
            FOR UPDATE;
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new AuthoringCanvasDocumentHeader(
                reader.GetGuid(reader.GetOrdinal("id")),
                owner,
                reader.GetInt32(reader.GetOrdinal("schema_version")),
                reader.GetInt64(reader.GetOrdinal("revision")),
                reader.GetString(reader.GetOrdinal("title")),
                new AuthoringCanvasViewport(
                    reader.GetDouble(reader.GetOrdinal("viewport_x")),
                    reader.GetDouble(reader.GetOrdinal("viewport_y")),
                    reader.GetDouble(reader.GetOrdinal("viewport_zoom"))),
                reader.GetInt32(reader.GetOrdinal("node_count")),
                reader.GetInt32(reader.GetOrdinal("edge_count")),
                reader.GetDateTime(reader.GetOrdinal("created_at_utc")),
                reader.GetDateTime(reader.GetOrdinal("updated_at_utc")),
                reader.GetString(reader.GetOrdinal("content_digest")))
            : null;
    }

    private Task<HistoryState> ReadHistoryStateForUpdateAsync(
        AuthoringCanvasDocumentHeader header,
        CancellationToken cancellationToken)
        => ReadHistoryStateAsync(header, forUpdate: true, cancellationToken);

    private async Task<HistoryState> ReadHistoryStateAsync(
        AuthoringCanvasDocumentHeader header,
        bool forUpdate,
        CancellationToken cancellationToken)
    {
        string lockClause = forUpdate ? " FOR UPDATE" : string.Empty;
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT revision, canvas_content_digest, history_digest,
                   undo_journal_ids, redo_journal_ids, last_journal_id
            FROM authoring_canvas_operation_history_state
            WHERE canvas_id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope{lockClause};
            """,
            new SugarParameter("@CanvasId", header.Id),
            new SugarParameter("@OwnerAdminPrincipalId", header.Owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", header.Owner.SiteScope)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return new HistoryState(
                header.Revision,
                header.ContentDigest,
                AuthoringCanvasOperationContract.EmptyHistoryDigest,
                [],
                [],
                null);
        }
        var state = new HistoryState(
            reader.GetInt64(reader.GetOrdinal("revision")),
            reader.GetString(reader.GetOrdinal("canvas_content_digest")),
            reader.GetString(reader.GetOrdinal("history_digest")),
            reader.GetFieldValue<Guid[]>(reader.GetOrdinal("undo_journal_ids")),
            reader.GetFieldValue<Guid[]>(reader.GetOrdinal("redo_journal_ids")),
            ReadNullableGuid(reader, "last_journal_id"));
        if (state.Revision != header.Revision
            || !string.Equals(state.CanvasContentDigest, header.ContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasHistoryConflictException();
        }
        return state;
    }

    private async Task<IReadOnlyDictionary<Guid, AuthoringCanvasOperationJournalEntry>> ReadEntriesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        IReadOnlyList<Guid> ids,
        CancellationToken cancellationToken)
    {
        if (ids.Count == 0)
        {
            return new Dictionary<Guid, AuthoringCanvasOperationJournalEntry>();
        }
        var rows = new Dictionary<Guid, JournalRow>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT journal_id, canvas_id, revision, mode, request_id, actor_user_id,
                   parent_journal_id, target_journal_id, previous_content_digest, content_digest,
                   transaction_digest, reference_validation_digest, command_kinds,
                   affected_node_ids, affected_edge_ids, truncated_redo_journal_ids, journal_digest
            FROM authoring_canvas_operation_journal
            WHERE canvas_id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND journal_id = ANY(@JournalIds);
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@JournalIds", ids.ToArray())).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                JournalRow row = ReadJournalRow(reader);
                rows.Add(row.JournalId, row);
            }
        }
        var inverse = rows.Keys.ToDictionary(static id => id, static _ => new List<AuthoringCanvasOperationFact>());
        var forward = rows.Keys.ToDictionary(static id => id, static _ => new List<AuthoringCanvasOperationFact>());
        var commands = rows.Keys.ToDictionary(
            static id => id,
            static _ => new SortedDictionary<int, StoredCommand>());
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT journal_id, command_ordinal, command_id, command_kind, command_digest
            FROM authoring_canvas_operation_command
            WHERE journal_id = ANY(@JournalIds)
            ORDER BY journal_id, command_ordinal;
            """,
            new SugarParameter("@JournalIds", ids.ToArray())).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                Guid journalId = reader.GetGuid(reader.GetOrdinal("journal_id"));
                int ordinal = reader.GetInt32(reader.GetOrdinal("command_ordinal"));
                commands[journalId].Add(
                    ordinal,
                    new StoredCommand(
                        reader.GetGuid(reader.GetOrdinal("command_id")),
                        (AuthoringCanvasOperationKind)reader.GetInt16(reader.GetOrdinal("command_kind")),
                        reader.GetString(reader.GetOrdinal("command_digest"))));
            }
        }
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT journal_id, command_ordinal, direction, fact_payload::text AS fact_payload,
                   fact_digest
            FROM authoring_canvas_operation_command_fact
            WHERE journal_id = ANY(@JournalIds)
            ORDER BY journal_id, command_ordinal, direction, fact_order;
            """,
            new SugarParameter("@JournalIds", ids.ToArray())).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                Guid journalId = reader.GetGuid(reader.GetOrdinal("journal_id"));
                int ordinal = reader.GetInt32(reader.GetOrdinal("command_ordinal"));
                AuthoringCanvasOperationFact fact = JsonSerializer.Deserialize<AuthoringCanvasOperationFact>(
                    reader.GetString(reader.GetOrdinal("fact_payload")))
                    ?? throw new AuthoringCanvasValidationException("canvas_operation_command_fact_invalid");
                if (!string.Equals(
                    fact.ContentDigest,
                    reader.GetString(reader.GetOrdinal("fact_digest")),
                    StringComparison.Ordinal))
                {
                    throw new AuthoringCanvasValidationException("canvas_operation_command_fact_digest_invalid");
                }
                AuthoringCanvasOperationContract.ValidateFact(fact);
                (reader.GetInt16(reader.GetOrdinal("direction")) == 0
                    ? commands[journalId][ordinal].Before
                    : commands[journalId][ordinal].After).Add(fact);
            }
        }
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT journal_id, direction, fact_kind, fact_id, exists,
                   node_type, node_order, position_x, position_y, width, height,
                   target_article_id, target_heading_identity, target_block_identity,
                   pinned_target_revision, display_projection_ref, reference_state,
                   note_source, frame_label, frame_member_ids,
                   edge_type, edge_order, source_node_id, target_node_id, edge_label,
                   viewport_x, viewport_y, viewport_zoom, fact_digest
            FROM authoring_canvas_operation_fact
            WHERE journal_id = ANY(@JournalIds)
            ORDER BY journal_id, direction, fact_order;
            """,
            new SugarParameter("@JournalIds", ids.ToArray())).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                Guid journalId = reader.GetGuid(reader.GetOrdinal("journal_id"));
                AuthoringCanvasOperationFact fact = ReadFact(reader);
                (reader.GetInt16(reader.GetOrdinal("direction")) == 0
                    ? inverse[journalId]
                    : forward[journalId]).Add(fact);
            }
        }
        return rows.ToDictionary(
            static pair => pair.Key,
            pair => pair.Value.ToEntry(
                commands[pair.Key].Values.Select(static command => command.ToCommand()).ToArray(),
                forward[pair.Key],
                inverse[pair.Key]));
    }

    private static AuthoringCanvasOperationFact ReadFact(DbDataReader reader)
    {
        var kind = (AuthoringCanvasOperationFactKind)reader.GetInt16(reader.GetOrdinal("fact_kind"));
        Guid id = reader.GetGuid(reader.GetOrdinal("fact_id"));
        bool exists = reader.GetBoolean(reader.GetOrdinal("exists"));
        AuthoringCanvasOperationFact fact = !exists
            ? new AuthoringCanvasOperationFact(kind, id, false)
            : kind switch
            {
                AuthoringCanvasOperationFactKind.Node => new AuthoringCanvasOperationFact(
                    kind,
                    id,
                    true,
                    Node: new AuthoringCanvasNode(
                        id,
                        (AuthoringCanvasNodeType)reader.GetInt16(reader.GetOrdinal("node_type")),
                        reader.GetInt32(reader.GetOrdinal("node_order")),
                        new AuthoringCanvasGeometry(
                            reader.GetDouble(reader.GetOrdinal("position_x")),
                            reader.GetDouble(reader.GetOrdinal("position_y")),
                            reader.GetDouble(reader.GetOrdinal("width")),
                            reader.GetDouble(reader.GetOrdinal("height"))),
                        ReadNullableInt32(reader, "target_article_id"),
                        ReadNullableString(reader, "target_heading_identity"),
                        ReadNullableString(reader, "target_block_identity"),
                        ReadNullableInt64(reader, "pinned_target_revision"),
                        ReadNullableString(reader, "display_projection_ref"),
                        ReadNullableInt16(reader, "reference_state") is short state
                            ? (AuthoringCanvasReferenceState)state
                            : null,
                        ReadNullableString(reader, "note_source"),
                        ReadNullableString(reader, "frame_label"),
                        ReadNullableGuidArray(reader, "frame_member_ids"))),
                AuthoringCanvasOperationFactKind.Edge => new AuthoringCanvasOperationFact(
                    kind,
                    id,
                    true,
                    Edge: new AuthoringCanvasEdge(
                        id,
                        (AuthoringCanvasEdgeType)reader.GetInt16(reader.GetOrdinal("edge_type")),
                        reader.GetInt32(reader.GetOrdinal("edge_order")),
                        reader.GetGuid(reader.GetOrdinal("source_node_id")),
                        reader.GetGuid(reader.GetOrdinal("target_node_id")),
                        ReadNullableString(reader, "edge_label"))),
                AuthoringCanvasOperationFactKind.Viewport => new AuthoringCanvasOperationFact(
                    kind,
                    id,
                    true,
                    Viewport: new AuthoringCanvasViewport(
                        reader.GetDouble(reader.GetOrdinal("viewport_x")),
                        reader.GetDouble(reader.GetOrdinal("viewport_y")),
                        reader.GetDouble(reader.GetOrdinal("viewport_zoom")))),
                _ => throw new AuthoringCanvasValidationException("canvas_operation_fact_kind_invalid")
            };
        fact = fact with
        {
            ContentDigest = reader.GetString(reader.GetOrdinal("fact_digest"))
        };
        AuthoringCanvasOperationContract.ValidateFact(fact);
        return fact;
    }

    private static AuthoringCanvasOperationReceipt ReadReceipt(DbDataReader reader)
        => new(
            reader.GetGuid(reader.GetOrdinal("receipt_id")),
            reader.GetGuid(reader.GetOrdinal("request_id")),
            reader.GetGuid(reader.GetOrdinal("canvas_id")),
            reader.GetInt64(reader.GetOrdinal("revision")),
            (AuthoringCanvasJournalMode)reader.GetInt16(reader.GetOrdinal("mode")),
            reader.GetGuid(reader.GetOrdinal("journal_id")),
            ReadNullableGuid(reader, "target_journal_id"),
            reader.GetInt32(reader.GetOrdinal("command_count")),
            reader.GetFieldValue<short[]>(reader.GetOrdinal("command_kinds"))
                .Select(static value => (AuthoringCanvasOperationKind)value).ToArray(),
            reader.GetFieldValue<Guid[]>(reader.GetOrdinal("affected_node_ids")),
            reader.GetFieldValue<Guid[]>(reader.GetOrdinal("affected_edge_ids")),
            reader.GetInt32(reader.GetOrdinal("undo_depth")),
            reader.GetInt32(reader.GetOrdinal("redo_depth")),
            (AuthoringCanvasOperationStatus)reader.GetInt16(reader.GetOrdinal("status")),
            reader.GetFieldValue<string[]>(reader.GetOrdinal("reasons")),
            reader.GetString(reader.GetOrdinal("transaction_digest")),
            reader.GetString(reader.GetOrdinal("journal_digest")),
            reader.GetString(reader.GetOrdinal("canvas_content_digest")),
            reader.GetString(reader.GetOrdinal("receipt_digest")));

    private static AuthoringCanvasOperationReceipt AsReplay(AuthoringCanvasOperationReceipt receipt)
    {
        receipt = receipt with
        {
            Status = AuthoringCanvasOperationStatus.IdempotentReplay,
            ReceiptDigest = string.Empty
        };
        return receipt with
        {
            ReceiptDigest = AuthoringCanvasOperationContract.ComputeReceiptDigest(receipt)
        };
    }

    private static (List<Guid> Undo, List<Guid> Redo) AdvanceHistory(
        HistoryState state,
        AuthoringCanvasOperationJournalEntry entry)
    {
        var undo = state.Undo.ToList();
        var redo = state.Redo.ToList();
        switch (entry.Mode)
        {
            case AuthoringCanvasJournalMode.Apply:
                redo.Clear();
                undo.Add(entry.JournalId);
                break;
            case AuthoringCanvasJournalMode.Undo:
                undo.RemoveAt(undo.Count - 1);
                redo.Add(entry.TargetJournalId!.Value);
                break;
            case AuthoringCanvasJournalMode.Redo:
                redo.RemoveAt(redo.Count - 1);
                undo.Add(entry.TargetJournalId!.Value);
                break;
        }
        while (undo.Count > AuthoringCanvasOperationContract.MaxUndoDepth)
        {
            undo.RemoveAt(0);
        }
        return (undo, redo);
    }

    private static void ValidateHistoryPlan(AuthoringCanvasOperationPlan plan, HistoryState state)
    {
        switch (plan.Mode)
        {
            case AuthoringCanvasJournalMode.Apply when !plan.TruncatedRedoJournalIds.SequenceEqual(
                state.Redo.AsEnumerable().Reverse()):
                throw new AuthoringCanvasHistoryConflictException();
            case AuthoringCanvasJournalMode.Undo when state.Undo.Count == 0
                || state.Undo[^1] != plan.TargetJournalId:
                throw new AuthoringCanvasHistoryConflictException();
            case AuthoringCanvasJournalMode.Redo when state.Redo.Count == 0
                || state.Redo[^1] != plan.TargetJournalId:
                throw new AuthoringCanvasHistoryConflictException();
        }
    }

    private static void ValidatePlan(AuthoringCanvasOperationPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        AuthoringCanvasContract.ValidateOwner(plan.Owner);
        if (plan.RequestId == Guid.Empty
            || plan.CanvasId == Guid.Empty
            || plan.ActorUserId <= 0
            || plan.ExpectedRevision <= 0
            || plan.Commands.Count != plan.CommandKinds.Count
            || !plan.Commands.Select(static command => command.Kind).SequenceEqual(plan.CommandKinds)
            || plan.ForwardFacts.Count != plan.InverseFacts.Count
            || plan.ForwardFacts.Count > AuthoringCanvasOperationContract.MaxFactsPerTransaction
            || plan.ReferenceValidationDigest.Length != 64)
        {
            throw new AuthoringCanvasValidationException("canvas_operation_plan_invalid");
        }
        foreach (AuthoringCanvasOperationFact fact in plan.ForwardFacts.Concat(plan.InverseFacts))
        {
            AuthoringCanvasOperationContract.ValidateFact(fact);
        }
        foreach (AuthoringCanvasClosedCommand command in plan.Commands)
        {
            AuthoringCanvasOperationContract.ValidateCommand(command);
        }
        FactKey[] forward = plan.ForwardFacts.Select(static fact => new FactKey(fact.Kind, fact.Id)).ToArray();
        FactKey[] inverse = plan.InverseFacts.Select(static fact => new FactKey(fact.Kind, fact.Id)).ToArray();
        if (forward.Distinct().Count() != forward.Length
            || inverse.Distinct().Count() != inverse.Length
            || !forward.Order().SequenceEqual(inverse.Order()))
        {
            throw new AuthoringCanvasValidationException("canvas_operation_plan_fact_set_invalid");
        }
    }

    private async Task AcquireLockAsync(Guid canvasId)
        => _ = await db.Ado.GetScalarAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
            new SugarParameter("@Identity", $"authoring-canvas-document:{canvasId:D}"))
            .ConfigureAwait(false);

    private async Task<int> CountAsync(string table, Guid canvasId)
        => await db.Ado.GetIntAsync(
            $"SELECT COUNT(1) FROM {table} WHERE canvas_id = @CanvasId;",
            new SugarParameter("@CanvasId", canvasId)).ConfigureAwait(false);

    private static SugarParameter[] NodeParameters(Guid canvasId, AuthoringCanvasNode node)
        =>
        [
            new("@CanvasId", canvasId),
            new("@NodeId", node.Id),
            new("@NodeType", ToStorage(node.Type)),
            new("@NodeOrder", node.Order),
            new("@PositionX", node.Geometry.X),
            new("@PositionY", node.Geometry.Y),
            new("@Width", node.Geometry.Width),
            new("@Height", node.Geometry.Height),
            new("@TargetArticleId", DbValue(node.TargetArticleId)),
            new("@TargetHeadingIdentity", DbValue(node.TargetHeadingIdentity)),
            new("@TargetBlockIdentity", DbValue(node.TargetBlockIdentity)),
            new("@PinnedTargetRevision", DbValue(node.PinnedTargetRevision)),
            new("@DisplayProjectionRef", DbValue(node.DisplayProjectionReference)),
            new("@ReferenceState", DbValue(node.ReferenceState is null
                ? null
                : ToStorage(node.ReferenceState.Value))),
            new("@NoteSource", DbValue(node.NoteSource)),
            new("@FrameLabel", DbValue(node.FrameLabel)),
            new("@ContentDigest", AuthoringCanvasContract.ComputeNodeDigest(node))
        ];

    private static string ToStorage(AuthoringCanvasNodeType type)
        => type switch
        {
            AuthoringCanvasNodeType.ArticleReference => "article-reference",
            AuthoringCanvasNodeType.HeadingReference => "heading-reference",
            AuthoringCanvasNodeType.BlockReference => "block-reference",
            AuthoringCanvasNodeType.PlainTextNote => "plain-text-note",
            AuthoringCanvasNodeType.GroupFrame => "group-frame",
            _ => throw new AuthoringCanvasValidationException("canvas_node_type_unknown")
        };

    private static string ToStorage(AuthoringCanvasEdgeType type)
        => type switch
        {
            AuthoringCanvasEdgeType.VisualOnly => "visual-only",
            AuthoringCanvasEdgeType.ExplicitReferenceNote => "explicit-reference-note",
            _ => throw new AuthoringCanvasValidationException("canvas_edge_type_unknown")
        };

    private static string ToStorage(AuthoringCanvasReferenceState state)
        => state switch
        {
            AuthoringCanvasReferenceState.Unresolved => "unresolved",
            AuthoringCanvasReferenceState.Current => "current",
            AuthoringCanvasReferenceState.Pinned => "pinned",
            AuthoringCanvasReferenceState.Stale => "stale",
            AuthoringCanvasReferenceState.Missing => "missing",
            AuthoringCanvasReferenceState.PermissionDenied => "permission-denied",
            _ => throw new AuthoringCanvasValidationException("canvas_reference_state_invalid")
        };

    private static JournalRow ReadJournalRow(DbDataReader reader)
        => new(
            reader.GetGuid(reader.GetOrdinal("journal_id")),
            reader.GetGuid(reader.GetOrdinal("canvas_id")),
            reader.GetInt64(reader.GetOrdinal("revision")),
            (AuthoringCanvasJournalMode)reader.GetInt16(reader.GetOrdinal("mode")),
            reader.GetGuid(reader.GetOrdinal("request_id")),
            reader.GetInt64(reader.GetOrdinal("actor_user_id")),
            ReadNullableGuid(reader, "parent_journal_id"),
            ReadNullableGuid(reader, "target_journal_id"),
            reader.GetString(reader.GetOrdinal("previous_content_digest")),
            reader.GetString(reader.GetOrdinal("content_digest")),
            reader.GetString(reader.GetOrdinal("transaction_digest")),
            reader.GetFieldValue<short[]>(reader.GetOrdinal("command_kinds"))
                .Select(static value => (AuthoringCanvasOperationKind)value).ToArray(),
            reader.GetFieldValue<Guid[]>(reader.GetOrdinal("affected_node_ids")),
            reader.GetFieldValue<Guid[]>(reader.GetOrdinal("affected_edge_ids")),
            reader.GetFieldValue<Guid[]>(reader.GetOrdinal("truncated_redo_journal_ids")),
            reader.GetString(reader.GetOrdinal("reference_validation_digest")),
            reader.GetString(reader.GetOrdinal("journal_digest")));

    private static AuthoringCanvasOperationJournalEntry RequireEntry(
        IReadOnlyDictionary<Guid, AuthoringCanvasOperationJournalEntry> entries,
        Guid id)
        => entries.TryGetValue(id, out AuthoringCanvasOperationJournalEntry? entry)
            ? entry
            : throw new AuthoringCanvasHistoryConflictException();

    private static object DbValue(object? value) => value ?? DBNull.Value;

    private static string? ReadNullableString(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetString(reader.GetOrdinal(name));

    private static int? ReadNullableInt32(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetInt32(reader.GetOrdinal(name));

    private static long? ReadNullableInt64(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetInt64(reader.GetOrdinal(name));

    private static short? ReadNullableInt16(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetInt16(reader.GetOrdinal(name));

    private static Guid? ReadNullableGuid(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name)) ? null : reader.GetGuid(reader.GetOrdinal(name));

    private static IReadOnlyList<Guid> ReadNullableGuidArray(DbDataReader reader, string name)
        => reader.IsDBNull(reader.GetOrdinal(name))
            ? []
            : reader.GetFieldValue<Guid[]>(reader.GetOrdinal(name));

    private readonly record struct FactKey(AuthoringCanvasOperationFactKind Kind, Guid Id) : IComparable<FactKey>
    {
        public int CompareTo(FactKey other)
        {
            int kind = Kind.CompareTo(other.Kind);
            return kind != 0 ? kind : Id.CompareTo(other.Id);
        }
    }

    private sealed record HistoryState(
        long Revision,
        string CanvasContentDigest,
        string HistoryDigest,
        IReadOnlyList<Guid> Undo,
        IReadOnlyList<Guid> Redo,
        Guid? LastJournalId);

    private sealed record JournalRow(
        Guid JournalId,
        Guid CanvasId,
        long Revision,
        AuthoringCanvasJournalMode Mode,
        Guid RequestId,
        long ActorUserId,
        Guid? ParentJournalId,
        Guid? TargetJournalId,
        string PreviousContentDigest,
        string ContentDigest,
        string TransactionDigest,
        IReadOnlyList<AuthoringCanvasOperationKind> CommandKinds,
        IReadOnlyList<Guid> AffectedNodeIds,
        IReadOnlyList<Guid> AffectedEdgeIds,
        IReadOnlyList<Guid> TruncatedRedoJournalIds,
        string ReferenceValidationDigest,
        string JournalDigest)
    {
        public AuthoringCanvasOperationJournalEntry ToEntry(
            IReadOnlyList<AuthoringCanvasClosedCommand> commands,
            IReadOnlyList<AuthoringCanvasOperationFact> forward,
            IReadOnlyList<AuthoringCanvasOperationFact> inverse)
            => new(
                JournalId,
                CanvasId,
                Revision,
                Mode,
                RequestId,
                ActorUserId,
                ParentJournalId,
                TargetJournalId,
                PreviousContentDigest,
                ContentDigest,
                TransactionDigest,
                CommandKinds,
                commands,
                forward,
                inverse,
                AffectedNodeIds,
                AffectedEdgeIds,
                TruncatedRedoJournalIds,
                ReferenceValidationDigest,
                JournalDigest);
    }

    private sealed class StoredCommand(
        Guid commandId,
        AuthoringCanvasOperationKind kind,
        string contentDigest)
    {
        public List<AuthoringCanvasOperationFact> Before { get; } = [];

        public List<AuthoringCanvasOperationFact> After { get; } = [];

        public AuthoringCanvasClosedCommand ToCommand()
        {
            var command = new AuthoringCanvasClosedCommand(
                commandId,
                kind,
                Before,
                After,
                contentDigest);
            if (!string.Equals(
                command.ContentDigest,
                AuthoringCanvasOperationContract.ComputeCommandDigest(command),
                StringComparison.Ordinal))
            {
                throw new AuthoringCanvasValidationException("canvas_operation_command_digest_invalid");
            }
            return command;
        }
    }
}
