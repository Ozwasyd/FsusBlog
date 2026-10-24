using System.Data.Common;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Unique server persistence authority for private authoring canvas documents.
/// Reads are bounded and owner/site scoped; writes use document revision CAS and request idempotency.
/// </summary>
public interface IAuthoringCanvasDocumentStore
{
    Task<AuthoringCanvasWriteReceipt> CreateAsync(
        CreateAuthoringCanvasCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasDocumentHeader?> GetAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasPage<AuthoringCanvasDocumentHeader>> ListAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasPage<AuthoringCanvasNode>> ReadNodesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasPage<AuthoringCanvasEdge>> ReadEdgesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> PutNodeAsync(
        PutAuthoringCanvasNodeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> DeleteNodeAsync(
        DeleteAuthoringCanvasNodeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> PutEdgeAsync(
        PutAuthoringCanvasEdgeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> DeleteEdgeAsync(
        DeleteAuthoringCanvasEdgeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> UpdateMetadataAsync(
        UpdateAuthoringCanvasMetadataCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> DeleteAsync(
        DeleteAuthoringCanvasCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasVerificationResult> VerifyAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// PostgreSQL implementation of <see cref="IAuthoringCanvasDocumentStore"/>.
/// It never stores article bodies, rendered HTML, arbitrary JSON, relation facts, or graph positions.
/// </summary>
public sealed class AuthoringCanvasDocumentStore(
    ISqlSugarClient db,
    TimeProvider timeProvider) : IAuthoringCanvasDocumentStore
{
    private const string CreateCommand = "create-document";
    private const string PutNodeCommand = "put-node";
    private const string DeleteNodeCommand = "delete-node";
    private const string PutEdgeCommand = "put-edge";
    private const string DeleteEdgeCommand = "delete-edge";
    private const string UpdateMetadataCommand = "update-metadata";
    private const string DeleteDocumentCommand = "delete-document";

    public async Task<AuthoringCanvasWriteReceipt> CreateAsync(
        CreateAuthoringCanvasCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCanvasIdentity(command.CanvasId, command.RequestId);
        AuthoringCanvasContract.ValidateOwner(command.Owner);
        ValidateTitle(command.Title);
        AuthoringCanvasContract.ValidateViewport(command.Viewport);
        string commandDigest = AuthoringCanvasContract.ComputeCommandDigest(
            CreateCommand,
            command.CanvasId,
            command.Owner.AdminPrincipalId,
            command.Owner.SiteScope,
            command.Title,
            command.Viewport.X,
            command.Viewport.Y,
            command.Viewport.Zoom);

        return await ExecuteTransactionAsync(async () =>
        {
            await AcquireAdvisoryLockAsync(
                $"authoring-canvas-owner:{command.Owner.AdminPrincipalId}:{command.Owner.SiteScope}").ConfigureAwait(false);
            await AcquireAdvisoryLockAsync($"authoring-canvas-document:{command.CanvasId:D}").ConfigureAwait(false);
            AuthoringCanvasWriteReceipt? replay = await TryReadReplayAsync(
                command.CanvasId,
                command.Owner,
                command.RequestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }

            int existing = await db.Ado.GetIntAsync(
                "SELECT COUNT(1) FROM authoring_canvas_document WHERE id = @CanvasId;",
                new SugarParameter("@CanvasId", command.CanvasId)).ConfigureAwait(false);
            if (existing != 0)
            {
                throw new AuthoringCanvasAccessDeniedException();
            }

            int canvasCount = await db.Ado.GetIntAsync(
                """
                SELECT COUNT(1)
                FROM authoring_canvas_document
                WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND site_scope = @SiteScope;
                """,
                new SugarParameter("@OwnerAdminPrincipalId", command.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", command.Owner.SiteScope)).ConfigureAwait(false);
            if (canvasCount >= AuthoringCanvasContract.MaxCanvasesPerOwner)
            {
                throw new AuthoringCanvasBudgetExceededException("canvas_owner_document_budget_exceeded");
            }

            DateTime now = UtcNow;
            string contentDigest = AuthoringCanvasContract.ComputeTransitionDigest(
                string.Empty,
                1,
                CreateCommand,
                commandDigest,
                0,
                0);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO authoring_canvas_document(
                    id, owner_admin_principal_id, site_scope, schema_version, revision,
                    title, viewport_x, viewport_y, viewport_zoom, node_count, edge_count,
                    created_at_utc, updated_at_utc, content_digest)
                VALUES (
                    @CanvasId, @OwnerAdminPrincipalId, @SiteScope, @SchemaVersion, 1,
                    @Title, @ViewportX, @ViewportY, @ViewportZoom, 0, 0,
                    @CreatedAtUtc, @UpdatedAtUtc, @ContentDigest);
                """,
                new SugarParameter("@CanvasId", command.CanvasId),
                new SugarParameter("@OwnerAdminPrincipalId", command.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", command.Owner.SiteScope),
                new SugarParameter("@SchemaVersion", AuthoringCanvasContract.SchemaVersion),
                new SugarParameter("@Title", command.Title),
                new SugarParameter("@ViewportX", command.Viewport.X),
                new SugarParameter("@ViewportY", command.Viewport.Y),
                new SugarParameter("@ViewportZoom", command.Viewport.Zoom),
                new SugarParameter("@CreatedAtUtc", now),
                new SugarParameter("@UpdatedAtUtc", now),
                new SugarParameter("@ContentDigest", contentDigest)).ConfigureAwait(false);

            return await PersistReceiptAsync(
                command.CanvasId,
                command.Owner,
                command.RequestId,
                1,
                CreateCommand,
                0,
                0,
                commandDigest,
                contentDigest,
                now).ConfigureAwait(false);
        }).ConfigureAwait(false);
    }

    public Task<AuthoringCanvasDocumentHeader?> GetAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        if (canvasId == Guid.Empty)
        {
            throw new AuthoringCanvasValidationException("canvas_identity_invalid");
        }
        return ReadHeaderAsync(owner, canvasId, forUpdate: false, cancellationToken);
    }

    public async Task<AuthoringCanvasPage<AuthoringCanvasDocumentHeader>> ListAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        int boundedLimit = ValidatePageSize(limit);
        string cursorPredicate = cursor is null
            ? string.Empty
            : " AND (revision > @CursorOrder OR (revision = @CursorOrder AND id > @CursorId))";
        var parameters = new List<SugarParameter>
        {
            new("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new("@SiteScope", owner.SiteScope),
            new("@Limit", boundedLimit + 1)
        };
        AddCursorParameters(parameters, cursor);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT id, owner_admin_principal_id, site_scope, schema_version, revision,
                   title, viewport_x, viewport_y, viewport_zoom, node_count, edge_count,
                   created_at_utc, updated_at_utc, content_digest
            FROM authoring_canvas_document
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope{cursorPredicate}
            ORDER BY revision, id
            LIMIT @Limit;
            """,
            parameters).ConfigureAwait(false);
        var headers = new List<AuthoringCanvasDocumentHeader>(boundedLimit + 1);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            headers.Add(ReadHeader(reader));
        }

        return Page(headers, boundedLimit, static header => new AuthoringCanvasPageCursor(
            header.Revision,
            header.Id));
    }

    public async Task<AuthoringCanvasPage<AuthoringCanvasNode>> ReadNodesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasPage<NodeRow> page = await ReadNodeRowsAsync(
            owner,
            canvasId,
            cursor,
            limit,
            cancellationToken).ConfigureAwait(false);
        return new AuthoringCanvasPage<AuthoringCanvasNode>(
            page.Items.Select(static row => row.Node).ToArray(),
            page.NextCursor);
    }

    public async Task<AuthoringCanvasPage<AuthoringCanvasEdge>> ReadEdgesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasPage<EdgeRow> page = await ReadEdgeRowsAsync(
            owner,
            canvasId,
            cursor,
            limit,
            cancellationToken).ConfigureAwait(false);
        return new AuthoringCanvasPage<AuthoringCanvasEdge>(
            page.Items.Select(static row => row.Edge).ToArray(),
            page.NextCursor);
    }

    public async Task<AuthoringCanvasWriteReceipt> PutNodeAsync(
        PutAuthoringCanvasNodeCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCanvasIdentity(command.CanvasId, command.RequestId);
        AuthoringCanvasContract.ValidateOwner(command.Owner);
        AuthoringCanvasContract.ValidateNode(command.Node);
        string nodeDigest = AuthoringCanvasContract.ComputeNodeDigest(command.Node);
        string commandDigest = AuthoringCanvasContract.ComputeCommandDigest(
            PutNodeCommand,
            command.CanvasId,
            command.ExpectedRevision,
            nodeDigest);

        return await ExecuteMutationAsync(
            command.CanvasId,
            command.Owner,
            command.ExpectedRevision,
            command.RequestId,
            PutNodeCommand,
            commandDigest,
            async header =>
            {
                bool exists = await RowExistsAsync(
                    "SELECT COUNT(1) FROM authoring_canvas_node WHERE canvas_id = @CanvasId AND node_id = @RecordId;",
                    command.CanvasId,
                    command.Node.Id).ConfigureAwait(false);
                if (!exists && header.NodeCount >= AuthoringCanvasContract.MaxNodesPerCanvas)
                {
                    throw new AuthoringCanvasBudgetExceededException("canvas_node_budget_exceeded");
                }

                await ValidateFrameMembersAsync(command.CanvasId, command.Node, cancellationToken).ConfigureAwait(false);
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO authoring_canvas_node(
                        canvas_id, node_id, node_type, node_order, position_x, position_y, width, height,
                        target_article_id, target_heading_identity, target_block_identity,
                        pinned_target_revision, display_projection_ref, reference_state,
                        note_source, frame_label, content_digest)
                    VALUES (
                        @CanvasId, @NodeId, @NodeType, @NodeOrder, @PositionX, @PositionY, @Width, @Height,
                        CAST(@TargetArticleId AS integer), @TargetHeadingIdentity, @TargetBlockIdentity,
                        CAST(@PinnedTargetRevision AS bigint), @DisplayProjectionRef, @ReferenceState,
                        @NoteSource, @FrameLabel, @ContentDigest)
                    ON CONFLICT (canvas_id, node_id) DO UPDATE
                    SET node_type = EXCLUDED.node_type,
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
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@NodeId", command.Node.Id),
                    new SugarParameter("@NodeType", ToStorage(command.Node.Type)),
                    new SugarParameter("@NodeOrder", command.Node.Order),
                    new SugarParameter("@PositionX", command.Node.Geometry.X),
                    new SugarParameter("@PositionY", command.Node.Geometry.Y),
                    new SugarParameter("@Width", command.Node.Geometry.Width),
                    new SugarParameter("@Height", command.Node.Geometry.Height),
                    new SugarParameter("@TargetArticleId", DbValue(command.Node.TargetArticleId)),
                    new SugarParameter("@TargetHeadingIdentity", DbValue(command.Node.TargetHeadingIdentity)),
                    new SugarParameter("@TargetBlockIdentity", DbValue(command.Node.TargetBlockIdentity)),
                    new SugarParameter("@PinnedTargetRevision", DbValue(command.Node.PinnedTargetRevision)),
                    new SugarParameter("@DisplayProjectionRef", DbValue(command.Node.DisplayProjectionReference)),
                    new SugarParameter("@ReferenceState", DbValue(command.Node.ReferenceState is null
                        ? null
                        : ToStorage(command.Node.ReferenceState.Value))),
                    new SugarParameter("@NoteSource", DbValue(command.Node.NoteSource)),
                    new SugarParameter("@FrameLabel", DbValue(command.Node.FrameLabel)),
                    new SugarParameter("@ContentDigest", nodeDigest)).ConfigureAwait(false);

                await db.Ado.ExecuteCommandAsync(
                    "DELETE FROM authoring_canvas_frame_member WHERE canvas_id = @CanvasId AND frame_node_id = @NodeId;",
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@NodeId", command.Node.Id)).ConfigureAwait(false);
                for (int index = 0; index < command.Node.MemberNodeIds.Count; index++)
                {
                    await db.Ado.ExecuteCommandAsync(
                        """
                        INSERT INTO authoring_canvas_frame_member(canvas_id, frame_node_id, member_node_id, member_order)
                        VALUES (@CanvasId, @FrameNodeId, @MemberNodeId, @MemberOrder);
                        """,
                        new SugarParameter("@CanvasId", command.CanvasId),
                        new SugarParameter("@FrameNodeId", command.Node.Id),
                        new SugarParameter("@MemberNodeId", command.Node.MemberNodeIds[index]),
                        new SugarParameter("@MemberOrder", index)).ConfigureAwait(false);
                }

                return (exists ? header.NodeCount : header.NodeCount + 1, header.EdgeCount);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthoringCanvasWriteReceipt> DeleteNodeAsync(
        DeleteAuthoringCanvasNodeCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCanvasIdentity(command.CanvasId, command.RequestId);
        AuthoringCanvasContract.ValidateOwner(command.Owner);
        if (command.NodeId == Guid.Empty)
        {
            throw new AuthoringCanvasValidationException("canvas_node_identity_invalid");
        }
        string commandDigest = AuthoringCanvasContract.ComputeCommandDigest(
            DeleteNodeCommand,
            command.CanvasId,
            command.ExpectedRevision,
            command.NodeId);

        return await ExecuteMutationAsync(
            command.CanvasId,
            command.Owner,
            command.ExpectedRevision,
            command.RequestId,
            DeleteNodeCommand,
            commandDigest,
            async header =>
            {
                if (!await RowExistsAsync(
                    "SELECT COUNT(1) FROM authoring_canvas_node WHERE canvas_id = @CanvasId AND node_id = @RecordId;",
                    command.CanvasId,
                    command.NodeId).ConfigureAwait(false))
                {
                    throw new AuthoringCanvasValidationException("canvas_node_not_found");
                }

                int frameMemberships = await db.Ado.GetIntAsync(
                    """
                    SELECT COUNT(1)
                    FROM authoring_canvas_frame_member
                    WHERE canvas_id = @CanvasId
                      AND member_node_id = @NodeId;
                    """,
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@NodeId", command.NodeId)).ConfigureAwait(false);
                if (frameMemberships != 0)
                {
                    throw new AuthoringCanvasValidationException("canvas_node_still_grouped");
                }

                int incidentEdges = await db.Ado.GetIntAsync(
                    """
                    SELECT COUNT(1)
                    FROM authoring_canvas_edge
                    WHERE canvas_id = @CanvasId
                      AND (source_node_id = @NodeId OR target_node_id = @NodeId);
                    """,
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@NodeId", command.NodeId)).ConfigureAwait(false);
                await db.Ado.ExecuteCommandAsync(
                    "DELETE FROM authoring_canvas_node WHERE canvas_id = @CanvasId AND node_id = @NodeId;",
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@NodeId", command.NodeId)).ConfigureAwait(false);
                return (header.NodeCount - 1, header.EdgeCount - incidentEdges);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthoringCanvasWriteReceipt> PutEdgeAsync(
        PutAuthoringCanvasEdgeCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCanvasIdentity(command.CanvasId, command.RequestId);
        AuthoringCanvasContract.ValidateOwner(command.Owner);
        AuthoringCanvasContract.ValidateEdge(command.Edge);
        string edgeDigest = AuthoringCanvasContract.ComputeEdgeDigest(command.Edge);
        string commandDigest = AuthoringCanvasContract.ComputeCommandDigest(
            PutEdgeCommand,
            command.CanvasId,
            command.ExpectedRevision,
            edgeDigest);

        return await ExecuteMutationAsync(
            command.CanvasId,
            command.Owner,
            command.ExpectedRevision,
            command.RequestId,
            PutEdgeCommand,
            commandDigest,
            async header =>
            {
                bool exists = await RowExistsAsync(
                    "SELECT COUNT(1) FROM authoring_canvas_edge WHERE canvas_id = @CanvasId AND edge_id = @RecordId;",
                    command.CanvasId,
                    command.Edge.Id).ConfigureAwait(false);
                if (!exists && header.EdgeCount >= AuthoringCanvasContract.MaxEdgesPerCanvas)
                {
                    throw new AuthoringCanvasBudgetExceededException("canvas_edge_budget_exceeded");
                }

                int endpoints = await db.Ado.GetIntAsync(
                    """
                    SELECT COUNT(1)
                    FROM authoring_canvas_node
                    WHERE canvas_id = @CanvasId
                      AND node_id IN (@SourceNodeId, @TargetNodeId);
                    """,
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@SourceNodeId", command.Edge.SourceNodeId),
                    new SugarParameter("@TargetNodeId", command.Edge.TargetNodeId)).ConfigureAwait(false);
                int expectedEndpoints = command.Edge.SourceNodeId == command.Edge.TargetNodeId ? 1 : 2;
                if (endpoints != expectedEndpoints)
                {
                    throw new AuthoringCanvasValidationException("canvas_edge_endpoint_invalid");
                }

                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO authoring_canvas_edge(
                        canvas_id, edge_id, edge_type, edge_order,
                        source_node_id, target_node_id, label, content_digest)
                    VALUES (
                        @CanvasId, @EdgeId, @EdgeType, @EdgeOrder,
                        @SourceNodeId, @TargetNodeId, @Label, @ContentDigest)
                    ON CONFLICT (canvas_id, edge_id) DO UPDATE
                    SET edge_type = EXCLUDED.edge_type,
                        edge_order = EXCLUDED.edge_order,
                        source_node_id = EXCLUDED.source_node_id,
                        target_node_id = EXCLUDED.target_node_id,
                        label = EXCLUDED.label,
                        content_digest = EXCLUDED.content_digest;
                    """,
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@EdgeId", command.Edge.Id),
                    new SugarParameter("@EdgeType", ToStorage(command.Edge.Type)),
                    new SugarParameter("@EdgeOrder", command.Edge.Order),
                    new SugarParameter("@SourceNodeId", command.Edge.SourceNodeId),
                    new SugarParameter("@TargetNodeId", command.Edge.TargetNodeId),
                    new SugarParameter("@Label", DbValue(command.Edge.Label)),
                    new SugarParameter("@ContentDigest", edgeDigest)).ConfigureAwait(false);
                return (header.NodeCount, exists ? header.EdgeCount : header.EdgeCount + 1);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthoringCanvasWriteReceipt> DeleteEdgeAsync(
        DeleteAuthoringCanvasEdgeCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCanvasIdentity(command.CanvasId, command.RequestId);
        AuthoringCanvasContract.ValidateOwner(command.Owner);
        if (command.EdgeId == Guid.Empty)
        {
            throw new AuthoringCanvasValidationException("canvas_edge_identity_invalid");
        }
        string commandDigest = AuthoringCanvasContract.ComputeCommandDigest(
            DeleteEdgeCommand,
            command.CanvasId,
            command.ExpectedRevision,
            command.EdgeId);

        return await ExecuteMutationAsync(
            command.CanvasId,
            command.Owner,
            command.ExpectedRevision,
            command.RequestId,
            DeleteEdgeCommand,
            commandDigest,
            async header =>
            {
                int affected = await db.Ado.ExecuteCommandAsync(
                    "DELETE FROM authoring_canvas_edge WHERE canvas_id = @CanvasId AND edge_id = @EdgeId;",
                    new SugarParameter("@CanvasId", command.CanvasId),
                    new SugarParameter("@EdgeId", command.EdgeId)).ConfigureAwait(false);
                if (affected != 1)
                {
                    throw new AuthoringCanvasValidationException("canvas_edge_not_found");
                }
                return (header.NodeCount, header.EdgeCount - 1);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthoringCanvasWriteReceipt> UpdateMetadataAsync(
        UpdateAuthoringCanvasMetadataCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCanvasIdentity(command.CanvasId, command.RequestId);
        AuthoringCanvasContract.ValidateOwner(command.Owner);
        ValidateTitle(command.Title);
        AuthoringCanvasContract.ValidateViewport(command.Viewport);
        string commandDigest = AuthoringCanvasContract.ComputeCommandDigest(
            UpdateMetadataCommand,
            command.CanvasId,
            command.ExpectedRevision,
            command.Title,
            command.Viewport.X,
            command.Viewport.Y,
            command.Viewport.Zoom);

        return await ExecuteMutationAsync(
            command.CanvasId,
            command.Owner,
            command.ExpectedRevision,
            command.RequestId,
            UpdateMetadataCommand,
            commandDigest,
            async header =>
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE authoring_canvas_document
                    SET title = @Title,
                        viewport_x = @ViewportX,
                        viewport_y = @ViewportY,
                        viewport_zoom = @ViewportZoom
                    WHERE id = @CanvasId;
                    """,
                    new SugarParameter("@Title", command.Title),
                    new SugarParameter("@ViewportX", command.Viewport.X),
                    new SugarParameter("@ViewportY", command.Viewport.Y),
                    new SugarParameter("@ViewportZoom", command.Viewport.Zoom),
                    new SugarParameter("@CanvasId", command.CanvasId)).ConfigureAwait(false);
                return (header.NodeCount, header.EdgeCount);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthoringCanvasWriteReceipt> DeleteAsync(
        DeleteAuthoringCanvasCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCanvasIdentity(command.CanvasId, command.RequestId);
        AuthoringCanvasContract.ValidateOwner(command.Owner);
        string commandDigest = AuthoringCanvasContract.ComputeCommandDigest(
            DeleteDocumentCommand,
            command.CanvasId,
            command.ExpectedRevision);

        return await ExecuteTransactionAsync(async () =>
        {
            AuthoringCanvasWriteReceipt? replay = await TryReadReplayAsync(
                command.CanvasId,
                command.Owner,
                command.RequestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }

            AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(
                command.Owner,
                command.CanvasId,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            replay = await TryReadReplayAsync(
                command.CanvasId,
                command.Owner,
                command.RequestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }
            EnsureExpectedRevision(command.ExpectedRevision, header.Revision);
            long deletedRevision = header.Revision + 1;
            string contentDigest = AuthoringCanvasContract.ComputeTransitionDigest(
                header.ContentDigest,
                deletedRevision,
                DeleteDocumentCommand,
                commandDigest,
                0,
                0);
            await db.Ado.ExecuteCommandAsync(
                "DELETE FROM authoring_canvas_document WHERE id = @CanvasId;",
                new SugarParameter("@CanvasId", command.CanvasId)).ConfigureAwait(false);
            return await PersistReceiptAsync(
                command.CanvasId,
                command.Owner,
                command.RequestId,
                deletedRevision,
                DeleteDocumentCommand,
                0,
                0,
                commandDigest,
                contentDigest,
                UtcNow).ConfigureAwait(false);
        }).ConfigureAwait(false);
    }

    public async Task<AuthoringCanvasVerificationResult> VerifyAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(
            owner,
            canvasId,
            forUpdate: false,
            cancellationToken).ConfigureAwait(false);
        var reasons = new List<string>();
        if (header.SchemaVersion != AuthoringCanvasContract.SchemaVersion)
        {
            reasons.Add("document_schema_version_invalid");
        }
        if (header.Revision <= 0
            || header.NodeCount is < 0 or > AuthoringCanvasContract.MaxNodesPerCanvas
            || header.EdgeCount is < 0 or > AuthoringCanvasContract.MaxEdgesPerCanvas)
        {
            reasons.Add("document_budget_or_revision_invalid");
        }
        try
        {
            AuthoringCanvasContract.ValidateOwner(header.Owner);
            AuthoringCanvasContract.ValidateViewport(header.Viewport);
            ValidateTitle(header.Title);
        }
        catch (AuthoringCanvasValidationException exception)
        {
            reasons.Add($"document_contract_invalid:{exception.Code}");
        }
        int verifiedNodes = 0;
        int verifiedEdges = 0;
        var nodeIds = new HashSet<Guid>();
        AuthoringCanvasPageCursor? cursor = null;
        do
        {
            AuthoringCanvasPage<NodeRow> page;
            try
            {
                page = await ReadNodeRowsAsync(
                    owner,
                    canvasId,
                    cursor,
                    AuthoringCanvasContract.MaxPageSize,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (AuthoringCanvasValidationException exception)
            {
                reasons.Add($"node_schema_invalid:{exception.Code}");
                break;
            }
            foreach (NodeRow row in page.Items)
            {
                AuthoringCanvasNode node = row.Node;
                nodeIds.Add(node.Id);
                try
                {
                    if (!string.Equals(
                        row.StoredDigest,
                        AuthoringCanvasContract.ComputeNodeDigest(node),
                        StringComparison.Ordinal))
                    {
                        reasons.Add($"node_digest_mismatch:{node.Id:D}");
                    }
                }
                catch (AuthoringCanvasValidationException exception)
                {
                    reasons.Add($"node_schema_invalid:{node.Id:D}:{exception.Code}");
                }
                verifiedNodes++;
            }
            cursor = page.NextCursor;
        }
        while (cursor is not null);

        cursor = null;
        do
        {
            AuthoringCanvasPage<EdgeRow> page;
            try
            {
                page = await ReadEdgeRowsAsync(
                    owner,
                    canvasId,
                    cursor,
                    AuthoringCanvasContract.MaxPageSize,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (AuthoringCanvasValidationException exception)
            {
                reasons.Add($"edge_schema_invalid:{exception.Code}");
                break;
            }
            foreach (EdgeRow row in page.Items)
            {
                AuthoringCanvasEdge edge = row.Edge;
                if (!nodeIds.Contains(edge.SourceNodeId) || !nodeIds.Contains(edge.TargetNodeId))
                {
                    reasons.Add($"edge_endpoint_missing:{edge.Id:D}");
                }
                try
                {
                    if (!string.Equals(
                        row.StoredDigest,
                        AuthoringCanvasContract.ComputeEdgeDigest(edge),
                        StringComparison.Ordinal))
                    {
                        reasons.Add($"edge_digest_mismatch:{edge.Id:D}");
                    }
                }
                catch (AuthoringCanvasValidationException exception)
                {
                    reasons.Add($"edge_schema_invalid:{edge.Id:D}:{exception.Code}");
                }
                verifiedEdges++;
            }
            cursor = page.NextCursor;
        }
        while (cursor is not null);

        if (verifiedNodes != header.NodeCount)
        {
            reasons.Add("node_count_mismatch");
        }
        if (verifiedEdges != header.EdgeCount)
        {
            reasons.Add("edge_count_mismatch");
        }
        ReceiptHead? latestReceipt = await ReadLatestReceiptAsync(owner, canvasId, cancellationToken).ConfigureAwait(false);
        if (latestReceipt is null
            || latestReceipt.Revision != header.Revision
            || !string.Equals(latestReceipt.ContentDigest, header.ContentDigest, StringComparison.Ordinal))
        {
            reasons.Add("document_receipt_digest_mismatch");
        }

        return new AuthoringCanvasVerificationResult(
            canvasId,
            header.Revision,
            verifiedNodes,
            verifiedEdges,
            header.ContentDigest,
            reasons.Count == 0,
            reasons);
    }

    private DateTime UtcNow => timeProvider.GetUtcNow().UtcDateTime;

    private async Task<AuthoringCanvasPage<NodeRow>> ReadNodeRowsAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        _ = await RequireHeaderAsync(owner, canvasId, forUpdate: false, cancellationToken).ConfigureAwait(false);
        int boundedLimit = ValidatePageSize(limit);
        string cursorPredicate = cursor is null
            ? string.Empty
            : " AND (node_order > @CursorOrder OR (node_order = @CursorOrder AND node_id > @CursorId))";
        var parameters = new List<SugarParameter>
        {
            new("@CanvasId", canvasId),
            new("@Limit", boundedLimit + 1)
        };
        AddCursorParameters(parameters, cursor);
        var rows = new List<NodeRow>(boundedLimit + 1);
        {
            using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                $"""
                SELECT node_id, node_type, node_order, position_x, position_y, width, height,
                       target_article_id, target_heading_identity, target_block_identity,
                       pinned_target_revision, display_projection_ref, reference_state,
                       note_source, frame_label, content_digest
                FROM authoring_canvas_node
                WHERE canvas_id = @CanvasId{cursorPredicate}
                ORDER BY node_order, node_id
                LIMIT @Limit;
                """,
                parameters).ConfigureAwait(false);
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rows.Add(ReadNodeRow(reader));
            }
        }

        Dictionary<Guid, IReadOnlyList<Guid>> memberships = await ReadFrameMembershipsAsync(
            canvasId,
            rows.Select(static row => row.Id).ToArray(),
            cancellationToken).ConfigureAwait(false);
        rows = rows
            .Select(row => row with
            {
                Members = memberships.GetValueOrDefault(row.Id) ?? []
            })
            .ToList();
        return Page(
            rows,
            boundedLimit,
            static row => new AuthoringCanvasPageCursor(row.Order, row.Id));
    }

    private async Task<AuthoringCanvasPage<EdgeRow>> ReadEdgeRowsAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasContract.ValidateOwner(owner);
        _ = await RequireHeaderAsync(owner, canvasId, forUpdate: false, cancellationToken).ConfigureAwait(false);
        int boundedLimit = ValidatePageSize(limit);
        string cursorPredicate = cursor is null
            ? string.Empty
            : " AND (edge_order > @CursorOrder OR (edge_order = @CursorOrder AND edge_id > @CursorId))";
        var parameters = new List<SugarParameter>
        {
            new("@CanvasId", canvasId),
            new("@Limit", boundedLimit + 1)
        };
        AddCursorParameters(parameters, cursor);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT edge_id, edge_type, edge_order, source_node_id, target_node_id, label, content_digest
            FROM authoring_canvas_edge
            WHERE canvas_id = @CanvasId{cursorPredicate}
            ORDER BY edge_order, edge_id
            LIMIT @Limit;
            """,
            parameters).ConfigureAwait(false);
        var rows = new List<EdgeRow>(boundedLimit + 1);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(ReadEdgeRow(reader));
        }

        return Page(
            rows,
            boundedLimit,
            static row => new AuthoringCanvasPageCursor(row.Edge.Order, row.Edge.Id));
    }

    private async Task<AuthoringCanvasWriteReceipt> ExecuteMutationAsync(
        Guid canvasId,
        AuthoringCanvasOwner owner,
        long expectedRevision,
        Guid requestId,
        string commandKind,
        string commandDigest,
        Func<AuthoringCanvasDocumentHeader, Task<(int NodeCount, int EdgeCount)>> mutate,
        CancellationToken cancellationToken)
        => await ExecuteTransactionAsync(async () =>
        {
            AuthoringCanvasWriteReceipt? replay = await TryReadReplayAsync(
                canvasId,
                owner,
                requestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }

            AuthoringCanvasDocumentHeader header = await RequireHeaderAsync(
                owner,
                canvasId,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            replay = await TryReadReplayAsync(
                canvasId,
                owner,
                requestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }
            EnsureExpectedRevision(expectedRevision, header.Revision);
            (int nodeCount, int edgeCount) = await mutate(header).ConfigureAwait(false);
            long revision = header.Revision + 1;
            string contentDigest = AuthoringCanvasContract.ComputeTransitionDigest(
                header.ContentDigest,
                revision,
                commandKind,
                commandDigest,
                nodeCount,
                edgeCount);
            DateTime now = UtcNow;
            int updated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE authoring_canvas_document
                SET revision = @Revision,
                    node_count = @NodeCount,
                    edge_count = @EdgeCount,
                    updated_at_utc = @UpdatedAtUtc,
                    content_digest = @ContentDigest
                WHERE id = @CanvasId
                  AND owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND site_scope = @SiteScope
                  AND revision = @ExpectedRevision;
                """,
                new SugarParameter("@Revision", revision),
                new SugarParameter("@NodeCount", nodeCount),
                new SugarParameter("@EdgeCount", edgeCount),
                new SugarParameter("@UpdatedAtUtc", now),
                new SugarParameter("@ContentDigest", contentDigest),
                new SugarParameter("@CanvasId", canvasId),
                new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", owner.SiteScope),
                new SugarParameter("@ExpectedRevision", expectedRevision)).ConfigureAwait(false);
            if (updated != 1)
            {
                throw new AuthoringCanvasRevisionConflictException(expectedRevision, header.Revision);
            }

            return await PersistReceiptAsync(
                canvasId,
                owner,
                requestId,
                revision,
                commandKind,
                nodeCount,
                edgeCount,
                commandDigest,
                contentDigest,
                now).ConfigureAwait(false);
        }).ConfigureAwait(false);

    private async Task<T> ExecuteTransactionAsync<T>(Func<Task<T>> action)
    {
        T? value = default;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            value = await action().ConfigureAwait(false);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("authoring_canvas_transaction_failed");
        }

        return value!;
    }

    private async Task AcquireAdvisoryLockAsync(string identity)
        => _ = await db.Ado.GetScalarAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
            new SugarParameter("@Identity", identity)).ConfigureAwait(false);

    private async Task<AuthoringCanvasDocumentHeader> RequireHeaderAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        bool forUpdate,
        CancellationToken cancellationToken)
        => await ReadHeaderAsync(owner, canvasId, forUpdate, cancellationToken).ConfigureAwait(false)
            ?? throw new AuthoringCanvasAccessDeniedException();

    private async Task<AuthoringCanvasDocumentHeader?> ReadHeaderAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        bool forUpdate,
        CancellationToken cancellationToken)
    {
        string lockClause = forUpdate ? " FOR UPDATE" : string.Empty;
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT id, owner_admin_principal_id, site_scope, schema_version, revision,
                   title, viewport_x, viewport_y, viewport_zoom, node_count, edge_count,
                   created_at_utc, updated_at_utc, content_digest
            FROM authoring_canvas_document
            WHERE id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope{lockClause};
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadHeader(reader)
            : null;
    }

    private async Task<AuthoringCanvasWriteReceipt?> TryReadReplayAsync(
        Guid canvasId,
        AuthoringCanvasOwner owner,
        Guid requestId,
        string commandDigest,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT receipt_id, revision, command_kind, node_count, edge_count,
                   command_digest, content_digest, created_at_utc
            FROM authoring_canvas_idempotency
            WHERE canvas_id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND request_id = @RequestId;
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@RequestId", requestId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        string storedDigest = reader.GetString(reader.GetOrdinal("command_digest"));
        if (!string.Equals(storedDigest, commandDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasIdempotencyConflictException();
        }

        return new AuthoringCanvasWriteReceipt(
            reader.GetGuid(reader.GetOrdinal("receipt_id")),
            canvasId,
            reader.GetInt64(reader.GetOrdinal("revision")),
            reader.GetString(reader.GetOrdinal("command_kind")),
            reader.GetInt32(reader.GetOrdinal("node_count")),
            reader.GetInt32(reader.GetOrdinal("edge_count")),
            true,
            storedDigest,
            reader.GetString(reader.GetOrdinal("content_digest")),
            reader.GetDateTime(reader.GetOrdinal("created_at_utc")));
    }

    private async Task<AuthoringCanvasWriteReceipt> PersistReceiptAsync(
        Guid canvasId,
        AuthoringCanvasOwner owner,
        Guid requestId,
        long revision,
        string commandKind,
        int nodeCount,
        int edgeCount,
        string commandDigest,
        string contentDigest,
        DateTime createdAtUtc)
    {
        Guid receiptId = Guid.NewGuid();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO authoring_canvas_receipt(
                receipt_id, canvas_id, owner_admin_principal_id, site_scope, revision,
                command_kind, node_count, edge_count, status, reason_code,
                command_digest, content_digest, created_at_utc)
            VALUES (
                @ReceiptId, @CanvasId, @OwnerAdminPrincipalId, @SiteScope, @Revision,
                @CommandKind, @NodeCount, @EdgeCount, 'applied', NULL,
                @CommandDigest, @ContentDigest, @CreatedAtUtc);

            INSERT INTO authoring_canvas_idempotency(
                canvas_id, owner_admin_principal_id, site_scope, request_id, receipt_id,
                revision, command_kind, node_count, edge_count, command_digest,
                content_digest, created_at_utc)
            VALUES (
                @CanvasId, @OwnerAdminPrincipalId, @SiteScope, @RequestId, @ReceiptId,
                @Revision, @CommandKind, @NodeCount, @EdgeCount, @CommandDigest,
                @ContentDigest, @CreatedAtUtc);
            """,
            new SugarParameter("@ReceiptId", receiptId),
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@RequestId", requestId),
            new SugarParameter("@Revision", revision),
            new SugarParameter("@CommandKind", commandKind),
            new SugarParameter("@NodeCount", nodeCount),
            new SugarParameter("@EdgeCount", edgeCount),
            new SugarParameter("@CommandDigest", commandDigest),
            new SugarParameter("@ContentDigest", contentDigest),
            new SugarParameter("@CreatedAtUtc", createdAtUtc)).ConfigureAwait(false);
        return new AuthoringCanvasWriteReceipt(
            receiptId,
            canvasId,
            revision,
            commandKind,
            nodeCount,
            edgeCount,
            false,
            commandDigest,
            contentDigest,
            createdAtUtc);
    }

    private async Task ValidateFrameMembersAsync(
        Guid canvasId,
        AuthoringCanvasNode node,
        CancellationToken cancellationToken)
    {
        if (node.Type != AuthoringCanvasNodeType.GroupFrame || node.MemberNodeIds.Count == 0)
        {
            return;
        }

        var parameters = new List<SugarParameter>
        {
            new("@CanvasId", canvasId)
        };
        string memberParameters = AddGuidParameters(parameters, "MemberNodeId", node.MemberNodeIds);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT node_id, node_type
            FROM authoring_canvas_node
            WHERE canvas_id = @CanvasId
              AND node_id IN ({memberParameters});
            """,
            parameters).ConfigureAwait(false);
        int count = 0;
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (string.Equals(
                reader.GetString(reader.GetOrdinal("node_type")),
                "group-frame",
                StringComparison.Ordinal))
            {
                throw new AuthoringCanvasValidationException("canvas_frame_nesting_forbidden");
            }
            count++;
        }
        if (count != node.MemberNodeIds.Count)
        {
            throw new AuthoringCanvasValidationException("canvas_frame_member_missing");
        }
    }

    private async Task<Dictionary<Guid, IReadOnlyList<Guid>>> ReadFrameMembershipsAsync(
        Guid canvasId,
        Guid[] nodeIds,
        CancellationToken cancellationToken)
    {
        var members = new Dictionary<Guid, List<Guid>>();
        if (nodeIds.Length == 0)
        {
            return [];
        }
        var parameters = new List<SugarParameter>
        {
            new("@CanvasId", canvasId)
        };
        string nodeParameters = AddGuidParameters(parameters, "NodeId", nodeIds);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT frame_node_id, member_node_id
            FROM authoring_canvas_frame_member
            WHERE canvas_id = @CanvasId
              AND frame_node_id IN ({nodeParameters})
            ORDER BY frame_node_id, member_order, member_node_id;
            """,
            parameters).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            Guid frameId = reader.GetGuid(reader.GetOrdinal("frame_node_id"));
            if (!members.TryGetValue(frameId, out List<Guid>? frameMembers))
            {
                frameMembers = [];
                members.Add(frameId, frameMembers);
            }
            frameMembers.Add(reader.GetGuid(reader.GetOrdinal("member_node_id")));
        }
        return members.ToDictionary(
            static pair => pair.Key,
            static pair => (IReadOnlyList<Guid>)pair.Value);
    }

    private async Task<bool> RowExistsAsync(string sql, Guid canvasId, Guid recordId)
        => await db.Ado.GetIntAsync(
            sql,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@RecordId", recordId)).ConfigureAwait(false) != 0;

    private async Task<ReceiptHead?> ReadLatestReceiptAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT revision, content_digest
            FROM authoring_canvas_receipt
            WHERE canvas_id = @CanvasId
              AND owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
            ORDER BY revision DESC, created_at_utc DESC, receipt_id DESC
            LIMIT 1;
            """,
            new SugarParameter("@CanvasId", canvasId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new ReceiptHead(reader.GetInt64(0), reader.GetString(1))
            : null;
    }

    private static AuthoringCanvasDocumentHeader ReadHeader(DbDataReader reader)
        => new(
            reader.GetGuid(reader.GetOrdinal("id")),
            new AuthoringCanvasOwner(
                reader.GetInt64(reader.GetOrdinal("owner_admin_principal_id")),
                reader.GetString(reader.GetOrdinal("site_scope"))),
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
            reader.GetString(reader.GetOrdinal("content_digest")));

    private static NodeRow ReadNodeRow(DbDataReader reader)
        => new(
            reader.GetGuid(reader.GetOrdinal("node_id")),
            ParseNodeType(reader.GetString(reader.GetOrdinal("node_type"))),
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
            ParseNullableReferenceState(ReadNullableString(reader, "reference_state")),
            ReadNullableString(reader, "note_source"),
            ReadNullableString(reader, "frame_label"),
            reader.GetString(reader.GetOrdinal("content_digest")));

    private static EdgeRow ReadEdgeRow(DbDataReader reader)
        => new(
            new AuthoringCanvasEdge(
                reader.GetGuid(reader.GetOrdinal("edge_id")),
                ParseEdgeType(reader.GetString(reader.GetOrdinal("edge_type"))),
                reader.GetInt32(reader.GetOrdinal("edge_order")),
                reader.GetGuid(reader.GetOrdinal("source_node_id")),
                reader.GetGuid(reader.GetOrdinal("target_node_id")),
                ReadNullableString(reader, "label")),
            reader.GetString(reader.GetOrdinal("content_digest")));

    private static AuthoringCanvasPage<T> Page<T>(
        List<T> values,
        int limit,
        Func<T, AuthoringCanvasPageCursor> cursorFactory)
    {
        bool hasMore = values.Count > limit;
        if (hasMore)
        {
            values.RemoveAt(values.Count - 1);
        }
        AuthoringCanvasPageCursor? nextCursor = hasMore && values.Count > 0
            ? cursorFactory(values[^1])
            : null;
        return new AuthoringCanvasPage<T>(values, nextCursor);
    }

    private static int ValidatePageSize(int limit)
    {
        if (limit <= 0 || limit > AuthoringCanvasContract.MaxPageSize)
        {
            throw new AuthoringCanvasValidationException("canvas_page_size_invalid");
        }
        return limit;
    }

    private static void AddCursorParameters(
        ICollection<SugarParameter> parameters,
        AuthoringCanvasPageCursor? cursor)
    {
        if (cursor is null)
        {
            return;
        }
        if (cursor.Value.Order < 0 || cursor.Value.Id == Guid.Empty)
        {
            throw new AuthoringCanvasValidationException("canvas_page_cursor_invalid");
        }
        parameters.Add(new SugarParameter("@CursorOrder", cursor.Value.Order));
        parameters.Add(new SugarParameter("@CursorId", cursor.Value.Id));
    }

    private static string AddGuidParameters(
        ICollection<SugarParameter> parameters,
        string prefix,
        IReadOnlyList<Guid> values)
    {
        var names = new string[values.Count];
        for (int index = 0; index < values.Count; index++)
        {
            string name = $"@{prefix}{index}";
            names[index] = name;
            parameters.Add(new SugarParameter(name, values[index]));
        }
        return string.Join(',', names);
    }

    private static void ValidateCanvasIdentity(Guid canvasId, Guid requestId)
    {
        if (canvasId == Guid.Empty || requestId == Guid.Empty)
        {
            throw new AuthoringCanvasValidationException("canvas_command_identity_invalid");
        }
    }

    private static void ValidateTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title)
            || title.Length > AuthoringCanvasContract.MaxTitleLength
            || title.Any(static character => char.IsControl(character))
            || title.Contains('<', StringComparison.Ordinal)
            || title.Contains('>', StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_title_invalid");
        }
    }

    private static void EnsureExpectedRevision(long expectedRevision, long actualRevision)
    {
        if (expectedRevision <= 0 || expectedRevision != actualRevision)
        {
            throw new AuthoringCanvasRevisionConflictException(expectedRevision, actualRevision);
        }
    }

    private static object DbValue(string? value)
        => value is null ? DBNull.Value : value;

    private static object DbValue(int? value)
        => value.HasValue ? value.Value : DBNull.Value;

    private static object DbValue(long? value)
        => value.HasValue ? value.Value : DBNull.Value;

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

    private static AuthoringCanvasNodeType ParseNodeType(string type)
        => type switch
        {
            "article-reference" => AuthoringCanvasNodeType.ArticleReference,
            "heading-reference" => AuthoringCanvasNodeType.HeadingReference,
            "block-reference" => AuthoringCanvasNodeType.BlockReference,
            "plain-text-note" => AuthoringCanvasNodeType.PlainTextNote,
            "group-frame" => AuthoringCanvasNodeType.GroupFrame,
            _ => throw new AuthoringCanvasValidationException("canvas_node_type_unknown")
        };

    private static string ToStorage(AuthoringCanvasEdgeType type)
        => type switch
        {
            AuthoringCanvasEdgeType.VisualOnly => "visual-only",
            AuthoringCanvasEdgeType.ExplicitReferenceNote => "explicit-reference-note",
            _ => throw new AuthoringCanvasValidationException("canvas_edge_type_unknown")
        };

    private static AuthoringCanvasEdgeType ParseEdgeType(string type)
        => type switch
        {
            "visual-only" => AuthoringCanvasEdgeType.VisualOnly,
            "explicit-reference-note" => AuthoringCanvasEdgeType.ExplicitReferenceNote,
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

    private static AuthoringCanvasReferenceState? ParseNullableReferenceState(string? state)
        => state switch
        {
            null => null,
            "unresolved" => AuthoringCanvasReferenceState.Unresolved,
            "current" => AuthoringCanvasReferenceState.Current,
            "pinned" => AuthoringCanvasReferenceState.Pinned,
            "stale" => AuthoringCanvasReferenceState.Stale,
            "missing" => AuthoringCanvasReferenceState.Missing,
            "permission-denied" => AuthoringCanvasReferenceState.PermissionDenied,
            _ => throw new AuthoringCanvasValidationException("canvas_reference_state_invalid")
        };

    private static string? ReadNullableString(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private static long? ReadNullableInt64(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt64(ordinal);
    }

    private sealed record NodeRow(
        Guid Id,
        AuthoringCanvasNodeType Type,
        int Order,
        AuthoringCanvasGeometry Geometry,
        int? TargetArticleId,
        string? TargetHeadingIdentity,
        string? TargetBlockIdentity,
        long? PinnedTargetRevision,
        string? DisplayProjectionReference,
        AuthoringCanvasReferenceState? ReferenceState,
        string? NoteSource,
        string? FrameLabel,
        string StoredDigest,
        IReadOnlyList<Guid>? Members = null)
    {
        public AuthoringCanvasNode Node
            => new(
                Id,
                Type,
                Order,
                Geometry,
                TargetArticleId,
                TargetHeadingIdentity,
                TargetBlockIdentity,
                PinnedTargetRevision,
                DisplayProjectionReference,
                ReferenceState,
                NoteSource,
                FrameLabel,
                Members ?? []);
    }

    private sealed record EdgeRow(AuthoringCanvasEdge Edge, string StoredDigest);

    private sealed record ReceiptHead(long Revision, string ContentDigest);
}
