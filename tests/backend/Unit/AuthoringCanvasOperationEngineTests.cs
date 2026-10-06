using System.Text.Json;

using FsusBlog.Shared.Contracts.AuthoringCanvas;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasOperationEngineTests
{
    private const string InitialDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string ReceiptCanary = "PRIVATE-NOTE-CANARY";
    private static readonly Guid s_canvasId = Guid.Parse("018f5f93-2997-7c8a-9a47-0242ac120101");
    private static readonly AuthoringCanvasOwner s_owner = new(51, "primary-site");
    private static readonly AuthoringCanvasGeometry s_geometry = new(10, 20, 240, 120);

    [Fact]
    public async Task ApplyAsync_ExecutesExactlyAllClosedKindsAsOneCanvasOnlyTransaction()
    {
        var authority = new DeterministicCanvasAuthority();
        Guid referenceId = Guid.CreateVersion7();
        Guid noteId = Guid.CreateVersion7();
        Guid frameId = Guid.CreateVersion7();
        Guid edgeId = Guid.CreateVersion7();
        AuthoringCanvasNode reference = Reference(referenceId);
        AuthoringCanvasNode note = Note(noteId, "initial note");
        AuthoringCanvasNode frame = Frame(frameId, []);
        AuthoringCanvasNode moved = reference with
        {
            Geometry = reference.Geometry with
            {
                X = 400,
                Y = 500
            }
        };
        AuthoringCanvasNode resized = note with
        {
            Geometry = note.Geometry with
            {
                Width = 600,
                Height = 300
            }
        };
        AuthoringCanvasNode grouped = Frame(frameId, [referenceId, noteId]);
        AuthoringCanvasNode ungrouped = Frame(frameId, [referenceId]);
        var edge = new AuthoringCanvasEdge(
            edgeId,
            AuthoringCanvasEdgeType.VisualOnly,
            0,
            referenceId,
            noteId);
        AuthoringCanvasEdge labeled = edge with
        {
            Label = "supports"
        };
        AuthoringCanvasNode edited = resized with
        {
            NoteSource = ReceiptCanary
        };
        AuthoringCanvasNode pinned = moved with
        {
            PinnedTargetRevision = 9,
            ReferenceState = AuthoringCanvasReferenceState.Pinned
        };
        AuthoringCanvasNode unpinned = pinned with
        {
            PinnedTargetRevision = null,
            ReferenceState = AuthoringCanvasReferenceState.Current
        };
        var viewport = new AuthoringCanvasViewport(900, 700, 1.5);
        AuthoringCanvasClosedCommand[] commands =
        [
            Command(AuthoringCanvasOperationKind.CreateReference, MissingNode(referenceId), Present(reference)),
            Command(AuthoringCanvasOperationKind.CreateNote, MissingNode(noteId), Present(note)),
            Command(AuthoringCanvasOperationKind.CreateFrame, MissingNode(frameId), Present(frame)),
            Command(AuthoringCanvasOperationKind.Move, Present(reference), Present(moved)),
            Command(AuthoringCanvasOperationKind.Resize, Present(note), Present(resized)),
            Command(AuthoringCanvasOperationKind.Group, Present(frame), Present(grouped)),
            Command(AuthoringCanvasOperationKind.Ungroup, Present(grouped), Present(ungrouped)),
            Command(AuthoringCanvasOperationKind.Connect, MissingEdge(edgeId), Present(edge)),
            Command(AuthoringCanvasOperationKind.EditEdgeLabel, Present(edge), Present(labeled)),
            Command(AuthoringCanvasOperationKind.Disconnect, Present(labeled), MissingEdge(edgeId)),
            Command(AuthoringCanvasOperationKind.EditNote, Present(resized), Present(edited)),
            Command(AuthoringCanvasOperationKind.PinTargetRevision, Present(moved), Present(pinned)),
            Command(AuthoringCanvasOperationKind.UnpinTargetRevision, Present(pinned), Present(unpinned)),
            Command(
                AuthoringCanvasOperationKind.SetViewport,
                AuthoringCanvasOperationContract.Present(authority.Header.Viewport),
                AuthoringCanvasOperationContract.Present(viewport)),
            Command(AuthoringCanvasOperationKind.Delete, Present(edited), MissingNode(noteId))
        ];

        AuthoringCanvasOperationReceipt receipt = await authority.Engine.ApplyAsync(authority.Request(commands));

        Assert.Equal(
            Enum.GetValues<AuthoringCanvasOperationKind>().Order(),
            receipt.CommandKinds.Distinct().Order());
        Assert.Equal(15, receipt.CommandCount);
        Assert.Equal(1, authority.CommitCount);
        Assert.Equal(0, authority.ArticleMutationCount);
        Assert.Equal(0, authority.RelationMutationCount);
        Assert.Equal(new[] { frameId, noteId, referenceId }.Order(), receipt.AffectedNodeIds);
        Assert.Equal([edgeId], receipt.AffectedEdgeIds);
        Assert.DoesNotContain(noteId, authority.Nodes.Keys);
        Assert.Equal(unpinned, authority.Nodes[referenceId]);
        Assert.Equal(ungrouped, authority.Nodes[frameId]);
        Assert.Empty(authority.Edges);
        Assert.Equal(viewport, authority.Header.Viewport);
        Assert.Equal(unpinned, Assert.Single(authority.LastValidatedReferences));
        Assert.Equal(3, authority.ReferenceValidationCount);

        string receiptJson = JsonSerializer.Serialize(receipt);
        Assert.DoesNotContain(ReceiptCanary, receiptJson, StringComparison.Ordinal);
        Assert.Equal(
            [
                "ReceiptId", "RequestId", "CanvasId", "Revision", "Mode", "JournalId",
                "TargetJournalId", "CommandCount", "CommandKinds", "AffectedNodeIds",
                "AffectedEdgeIds", "UndoDepth", "RedoDepth", "Status", "Reasons",
                "TransactionDigest", "JournalDigest", "CanvasContentDigest", "ReceiptDigest"
            ],
            PropertyNames(receiptJson));

        AuthoringCanvasOperationVerificationResult verified = AuthoringCanvasOperationVerifier.Verify(
            authority.InitialSnapshot,
            authority.Audit,
            authority.Receipts,
            authority.Snapshot());
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task ApplyAsync_RejectsDependencyBeforeCreationButReplaysOrderedBatchAndHistory(int dependentKind)
    {
        Guid firstId = Guid.CreateVersion7();
        Guid secondId = Guid.CreateVersion7();
        Guid frameId = Guid.CreateVersion7();
        Guid edgeId = Guid.CreateVersion7();
        AuthoringCanvasNode first = Note(firstId, "first");
        AuthoringCanvasNode second = Note(secondId, "second");
        AuthoringCanvasNode emptyFrame = Frame(frameId, []);
        AuthoringCanvasNode populatedFrame = Frame(frameId, [firstId, secondId]);
        AuthoringCanvasNode[] initialNodes = dependentKind == 2 ? [emptyFrame] : [];
        AuthoringCanvasClosedCommand dependent = dependentKind switch
        {
            0 => Command(
                AuthoringCanvasOperationKind.Connect,
                MissingEdge(edgeId),
                Present(new AuthoringCanvasEdge(edgeId, AuthoringCanvasEdgeType.VisualOnly, 0, firstId, secondId))),
            1 => Command(AuthoringCanvasOperationKind.CreateFrame, MissingNode(frameId), Present(populatedFrame)),
            2 => Command(AuthoringCanvasOperationKind.Group, Present(emptyFrame), Present(populatedFrame)),
            _ => throw new ArgumentOutOfRangeException(nameof(dependentKind))
        };
        AuthoringCanvasClosedCommand createFirst = Command(
            AuthoringCanvasOperationKind.CreateNote, MissingNode(firstId), Present(first));
        AuthoringCanvasClosedCommand createSecond = Command(
            AuthoringCanvasOperationKind.CreateNote, MissingNode(secondId), Present(second));
        AuthoringCanvasClosedCommand[] malordered = [dependent, createFirst, createSecond];
        Assert.All(malordered, AuthoringCanvasOperationSemantics.ValidateCommand);
        var rejected = new DeterministicCanvasAuthority(initialNodes);

        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => rejected.Engine.ApplyAsync(rejected.Request(malordered)));

        Assert.Equal(dependentKind == 0
            ? "canvas_operation_incident_edge_not_deleted"
            : "canvas_operation_frame_member_missing", exception.Code);
        Assert.Equal(0, rejected.CommitCount);
        Assert.Equal(rejected.InitialSnapshot.Header, rejected.Header);
        Assert.Equal(initialNodes, rejected.Nodes.Values.ToArray());
        Assert.Empty(rejected.Edges);
        Assert.Empty(rejected.Audit);
        Assert.Empty(rejected.Receipts);
        Assert.Equal(0, rejected.ArticleMutationCount);
        Assert.Equal(0, rejected.RelationMutationCount);

        var accepted = new DeterministicCanvasAuthority(initialNodes);
        AuthoringCanvasOperationReceipt applied = await accepted.Engine.ApplyAsync(
            accepted.Request([createFirst, createSecond, dependent]));

        Assert.Equal(AuthoringCanvasOperationStatus.Committed, applied.Status);
        Assert.Equal(3, applied.CommandCount);
        Assert.Equal(1, accepted.CommitCount);
        Assert.Equal(first, accepted.Nodes[firstId]);
        Assert.Equal(second, accepted.Nodes[secondId]);
        if (dependentKind == 0)
        {
            Assert.Equal(edgeId, Assert.Single(accepted.Edges.Values).Id);
        }
        else
        {
            Assert.Equal([firstId, secondId], accepted.Nodes[frameId].MemberNodeIds);
        }
        AuthoringCanvasOperationVerificationResult verified = AuthoringCanvasOperationVerifier.Verify(
            accepted.InitialSnapshot, accepted.Audit, accepted.Receipts, accepted.Snapshot());
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));

        await accepted.Engine.UndoAsync(accepted.HistoryRequest(applied.JournalId, AuthoringCanvasJournalMode.Undo));
        Assert.Equal(initialNodes, accepted.Nodes.Values.ToArray());
        Assert.Empty(accepted.Edges);
        await accepted.Engine.RedoAsync(accepted.HistoryRequest(applied.JournalId, AuthoringCanvasJournalMode.Redo));
        AuthoringCanvasOperationVerificationResult historyVerified = AuthoringCanvasOperationVerifier.Verify(
            accepted.InitialSnapshot, accepted.Audit, accepted.Receipts, accepted.Snapshot());
        Assert.True(historyVerified.Valid, string.Join(',', historyVerified.Reasons));
        Assert.Equal(3, accepted.CommitCount);
        Assert.Equal(0, accepted.ArticleMutationCount);
        Assert.Equal(0, accepted.RelationMutationCount);
    }

    [Fact]
    public async Task ApplyAsync_DeletesIncidentEdgesAndFrameMembershipWithoutTargetMutation()
    {
        Guid firstId = Guid.CreateVersion7();
        Guid secondId = Guid.CreateVersion7();
        Guid frameId = Guid.CreateVersion7();
        Guid edgeId = Guid.CreateVersion7();
        AuthoringCanvasNode first = Reference(firstId);
        AuthoringCanvasNode second = Note(secondId, "keep");
        AuthoringCanvasNode frame = Frame(frameId, [firstId, secondId]);
        var edge = new AuthoringCanvasEdge(
            edgeId,
            AuthoringCanvasEdgeType.ExplicitReferenceNote,
            0,
            firstId,
            secondId,
            "private canvas edge");
        var authority = new DeterministicCanvasAuthority([first, second, frame], [edge]);
        AuthoringCanvasNode cleanedFrame = Frame(frameId, [secondId]);
        AuthoringCanvasClosedCommand delete = AuthoringCanvasOperationContract.SealCommand(
            Guid.CreateVersion7(),
            AuthoringCanvasOperationKind.Delete,
            [Present(first), Present(edge), Present(frame)],
            [MissingNode(firstId), MissingEdge(edgeId), Present(cleanedFrame)]);

        await authority.Engine.ApplyAsync(authority.Request([delete]));

        Assert.DoesNotContain(firstId, authority.Nodes.Keys);
        Assert.Empty(authority.Edges);
        Assert.Equal([secondId], authority.Nodes[frameId].MemberNodeIds);
        Assert.Equal(0, authority.ArticleMutationCount);
        Assert.Equal(0, authority.RelationMutationCount);

        AuthoringCanvasOperationVerificationResult verified = AuthoringCanvasOperationVerifier.Verify(
            authority.InitialSnapshot,
            authority.Audit,
            authority.Receipts,
            authority.Snapshot());
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));

        var incomplete = new DeterministicCanvasAuthority([first, second, frame], [edge]);
        AuthoringCanvasClosedCommand unsafeDelete = Command(
            AuthoringCanvasOperationKind.Delete,
            Present(first),
            MissingNode(firstId));
        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => incomplete.Engine.ApplyAsync(incomplete.Request([unsafeDelete])));
        Assert.Equal("canvas_operation_frame_member_missing", exception.Code);
        Assert.Equal(0, incomplete.CommitCount);
    }

    [Fact]
    public async Task ApplyAsync_UsesCasAndRecoversIdempotentRetriesWithoutLastWriteWins()
    {
        Guid nodeId = Guid.CreateVersion7();
        AuthoringCanvasNode node = Note(nodeId, "note");
        var authority = new DeterministicCanvasAuthority([node]);
        AuthoringCanvasNode moved = node with
        {
            Geometry = node.Geometry with
            {
                X = 300,
                Y = 400
            }
        };
        AuthoringCanvasOperationRequest request = authority.Request(
            [Command(AuthoringCanvasOperationKind.Move, Present(node), Present(moved))]);

        AuthoringCanvasOperationReceipt first = await authority.Engine.ApplyAsync(request);
        AuthoringCanvasOperationReceipt replay = await authority.Engine.ApplyAsync(request);

        Assert.Equal(AuthoringCanvasOperationStatus.Committed, first.Status);
        Assert.Equal(AuthoringCanvasOperationStatus.IdempotentReplay, replay.Status);
        Assert.Equal(first.JournalId, replay.JournalId);
        Assert.Equal(1, authority.CommitCount);

        AuthoringCanvasOperationRequest staleOtherDevice = request with
        {
            RequestId = Guid.CreateVersion7()
        };
        await Assert.ThrowsAsync<AuthoringCanvasRevisionConflictException>(
            () => authority.Engine.ApplyAsync(staleOtherDevice));
        Assert.Equal(1, authority.CommitCount);
    }

    [Fact]
    public async Task ApplyAsync_DoesNotTrustCallerReferenceStateWithoutResolverEvidence()
    {
        Guid referenceId = Guid.CreateVersion7();
        var authority = new DeterministicCanvasAuthority
        {
            RejectReferences = true
        };
        AuthoringCanvasNode callerClaimedValid = Reference(referenceId) with
        {
            ReferenceState = AuthoringCanvasReferenceState.Current
        };

        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.Engine.ApplyAsync(authority.Request(
                [Command(AuthoringCanvasOperationKind.CreateReference, MissingNode(referenceId), Present(callerClaimedValid))])));

        Assert.Equal("canvas_reference_target_unavailable", exception.Code);
        Assert.Equal(1, authority.ReferenceValidationCount);
        Assert.Equal(0, authority.CommitCount);
        Assert.DoesNotContain(referenceId, authority.Nodes.Keys);
    }

    [Fact]
    public async Task ApplyAsync_UnpinRequiresFreshReferenceEvidence()
    {
        Guid referenceId = Guid.CreateVersion7();
        AuthoringCanvasNode pinned = Reference(referenceId) with
        {
            PinnedTargetRevision = 9,
            ReferenceState = AuthoringCanvasReferenceState.Pinned
        };
        var authority = new DeterministicCanvasAuthority([pinned])
        {
            RejectReferences = true
        };
        AuthoringCanvasNode unpinned = pinned with
        {
            PinnedTargetRevision = null,
            ReferenceState = AuthoringCanvasReferenceState.Current
        };

        await Assert.ThrowsAsync<AuthoringCanvasValidationException>(() => authority.Engine.ApplyAsync(
            authority.Request(
                [Command(AuthoringCanvasOperationKind.UnpinTargetRevision, Present(pinned), Present(unpinned))])));

        Assert.Equal(1, authority.ReferenceValidationCount);
        Assert.Equal(0, authority.CommitCount);
        Assert.Equal(pinned, authority.Nodes[referenceId]);
    }

    [Fact]
    public async Task UndoRedo_BindsHistoryHeadAndCutsRedoBranchWhilePreservingAudit()
    {
        Guid nodeId = Guid.CreateVersion7();
        AuthoringCanvasNode first = Note(nodeId, "first");
        var authority = new DeterministicCanvasAuthority([first]);
        AuthoringCanvasNode second = first with
        {
            NoteSource = "second"
        };
        AuthoringCanvasOperationReceipt applied = await authority.Engine.ApplyAsync(authority.Request(
            [Command(AuthoringCanvasOperationKind.EditNote, Present(first), Present(second))]));

        AuthoringCanvasOperationReceipt undone = await authority.Engine.UndoAsync(
            authority.HistoryRequest(applied.JournalId, AuthoringCanvasJournalMode.Undo));
        Assert.Equal("first", authority.Nodes[nodeId].NoteSource);
        Assert.Equal(0, undone.UndoDepth);
        Assert.Equal(1, undone.RedoDepth);

        AuthoringCanvasOperationReceipt redone = await authority.Engine.RedoAsync(
            authority.HistoryRequest(applied.JournalId, AuthoringCanvasJournalMode.Redo));
        Assert.Equal("second", authority.Nodes[nodeId].NoteSource);
        Assert.Equal(1, redone.UndoDepth);
        Assert.Equal(0, redone.RedoDepth);

        _ = await authority.Engine.UndoAsync(
            authority.HistoryRequest(applied.JournalId, AuthoringCanvasJournalMode.Undo));
        string staleHistoryDigest = authority.HistoryDigest;
        AuthoringCanvasNode branch = first with
        {
            NoteSource = "branch"
        };
        AuthoringCanvasOperationReceipt branchReceipt = await authority.Engine.ApplyAsync(authority.Request(
            [Command(AuthoringCanvasOperationKind.EditNote, Present(first), Present(branch))]));

        Assert.Equal("branch", authority.Nodes[nodeId].NoteSource);
        Assert.Contains(applied.JournalId, authority.Audit[^1].TruncatedRedoJournalIds);
        Assert.Equal(0, branchReceipt.RedoDepth);
        Assert.Equal(5, authority.Audit.Count);

        AuthoringCanvasOperationVerificationResult verified = AuthoringCanvasOperationVerifier.Verify(
            authority.InitialSnapshot,
            authority.Audit,
            authority.Receipts,
            authority.Snapshot());
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));

        AuthoringCanvasOperationJournalEntry targetTamper = authority.Audit[1] with
        {
            TargetJournalId = Guid.CreateVersion7(),
            JournalDigest = string.Empty
        };
        targetTamper = SealJournal(targetTamper);
        AuthoringCanvasOperationJournalEntry[] historyTamper = authority.Audit.ToArray();
        historyTamper[1] = targetTamper;
        AuthoringCanvasOperationVerificationResult invalidHistory = AuthoringCanvasOperationVerifier.Verify(
            authority.InitialSnapshot,
            historyTamper,
            authority.Receipts,
            authority.Snapshot());
        Assert.False(invalidHistory.Valid);
        Assert.Contains(
            invalidHistory.Reasons,
            static reason => reason.StartsWith("journal_history_transition_invalid:", StringComparison.Ordinal));

        AuthoringCanvasHistoryRequest staleDevice = authority.HistoryRequest(
            branchReceipt.JournalId,
            AuthoringCanvasJournalMode.Undo) with
        {
            ExpectedHistoryDigest = staleHistoryDigest
        };
        await Assert.ThrowsAsync<AuthoringCanvasHistoryConflictException>(
            () => authority.Engine.UndoAsync(staleDevice));
    }

    [Fact]
    public async Task ApplyAsync_RecoversUnknownCommitAndHonorsPreCommitCancellation()
    {
        Guid nodeId = Guid.CreateVersion7();
        AuthoringCanvasNode node = Note(nodeId, "before");
        var authority = new DeterministicCanvasAuthority([node])
        {
            ThrowUnknownAfterNextCommit = true
        };
        AuthoringCanvasNode changed = node with
        {
            NoteSource = "after"
        };

        AuthoringCanvasOperationReceipt recovered = await authority.Engine.ApplyAsync(authority.Request(
            [Command(AuthoringCanvasOperationKind.EditNote, Present(node), Present(changed))]));

        Assert.Equal(AuthoringCanvasOperationStatus.RecoveredAfterUnknownCommit, recovered.Status);
        Assert.Equal(1, authority.CommitCount);
        Assert.Equal("after", authority.Nodes[nodeId].NoteSource);

        var cancelledAuthority = new DeterministicCanvasAuthority([node]);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelledAuthority.Engine.ApplyAsync(
            cancelledAuthority.Request(
                [Command(AuthoringCanvasOperationKind.EditNote, Present(node), Present(changed))]),
            cancelled.Token));
        Assert.Equal(0, cancelledAuthority.CommitCount);
        Assert.Equal("before", cancelledAuthority.Nodes[nodeId].NoteSource);
    }

    [Fact]
    public void PostgresTransaction_UsesCancelableTryLockAndClassifiesOnlyPreparedFailuresAsUnknown()
    {
        Assert.Contains(
            "pg_try_advisory_xact_lock",
            PostgresAuthoringCanvasOperationTransaction.TryAcquireLockSql,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "pg_advisory_xact_lock(",
            PostgresAuthoringCanvasOperationTransaction.TryAcquireLockSql,
            StringComparison.Ordinal);
        var failure = new InvalidOperationException("transport-failed");

        Exception beforePrepared = PostgresAuthoringCanvasOperationTransaction.ClassifyTransactionFailure(
            failure,
            preparedForCommit: false);
        Exception afterPrepared = PostgresAuthoringCanvasOperationTransaction.ClassifyTransactionFailure(
            failure,
            preparedForCommit: true);

        Assert.Same(failure, beforePrepared);
        AuthoringCanvasUnknownCommitResultException unknown =
            Assert.IsType<AuthoringCanvasUnknownCommitResultException>(afterPrepared);
        Assert.Same(failure, unknown.InnerException);
    }

    [Fact]
    public async Task DeleteBatch_ProcessesTenThousandRecordsInOneBoundedAtomicPlan()
    {
        AuthoringCanvasNode[] nodes = Enumerable.Range(0, AuthoringCanvasContract.MaxNodesPerCanvas)
            .Select(index => Note(Guid.CreateVersion7(), $"note {index}"))
            .ToArray();
        var authority = new DeterministicCanvasAuthority(nodes);
        AuthoringCanvasClosedCommand delete = AuthoringCanvasOperationContract.SealCommand(
            Guid.CreateVersion7(),
            AuthoringCanvasOperationKind.Delete,
            nodes.Select(Present).ToArray(),
            nodes.Select(static node => MissingNode(node.Id)).ToArray());

        AuthoringCanvasOperationReceipt receipt = await authority.Engine.ApplyAsync(authority.Request([delete]));

        Assert.Equal(AuthoringCanvasContract.MaxNodesPerCanvas, receipt.AffectedNodeIds.Count);
        Assert.Equal(0, authority.Header.NodeCount);
        Assert.Empty(authority.Nodes);
        Assert.Equal(1, authority.CommitCount);
        Assert.InRange(authority.NodePageReads, 40, 41);
    }

    [Fact]
    public async Task Contracts_RejectClientSideMixedMutationsAndExecutableNotePayloads()
    {
        Guid nodeId = Guid.CreateVersion7();
        AuthoringCanvasNode note = Note(nodeId, "before");
        var authority = new DeterministicCanvasAuthority([note]);
        AuthoringCanvasNode illicitMove = note with
        {
            Geometry = note.Geometry with
            {
                X = 90
            },
            NoteSource = "changed outside edit-note"
        };
        AuthoringCanvasClosedCommand mixed = Command(
            AuthoringCanvasOperationKind.Move,
            Present(note),
            Present(illicitMove));

        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.Engine.ApplyAsync(authority.Request([mixed])));
        Assert.Equal("canvas_operation_node_change_invalid", exception.Code);
        Assert.Equal(0, authority.CommitCount);

        Assert.Throws<AuthoringCanvasValidationException>(() => Present(Note(
            Guid.CreateVersion7(),
            "<article>copied target body</article>")));
        Assert.Equal(15, Enum.GetValues<AuthoringCanvasOperationKind>().Length);
        Assert.Throws<AuthoringCanvasValidationException>(() =>
            AuthoringCanvasOperationContract.SealCommand(
                Guid.CreateVersion7(),
                (AuthoringCanvasOperationKind)99,
                [Present(note)],
                [Present(note)]));
    }

    [Fact]
    public async Task Verifier_ReplaysJournalAndDetectsFactAndReceiptTamperIndependently()
    {
        Guid nodeId = Guid.CreateVersion7();
        AuthoringCanvasNode before = Note(nodeId, "before");
        var authority = new DeterministicCanvasAuthority([before]);
        AuthoringCanvasOperationSnapshot initial = authority.Snapshot();
        AuthoringCanvasNode after = before with
        {
            NoteSource = "after"
        };
        AuthoringCanvasOperationReceipt receipt = await authority.Engine.ApplyAsync(authority.Request(
            [Command(AuthoringCanvasOperationKind.EditNote, Present(before), Present(after))]));

        AuthoringCanvasOperationVerificationResult valid = AuthoringCanvasOperationVerifier.Verify(
            initial,
            authority.Audit,
            authority.Receipts,
            authority.Snapshot());
        Assert.True(valid.Valid, string.Join(',', valid.Reasons));

        AuthoringCanvasOperationJournalEntry entry = authority.Audit.Single();
        AuthoringCanvasOperationJournalEntry tampered = entry with
        {
            ForwardFacts = [Present(after with { NoteSource = "tampered" })]
        };
        AuthoringCanvasOperationVerificationResult invalid = AuthoringCanvasOperationVerifier.Verify(
            initial,
            [tampered],
            authority.Receipts,
            authority.Snapshot());
        Assert.False(invalid.Valid);
        Assert.Contains(invalid.Reasons, static reason => reason.StartsWith("journal_digest_mismatch:", StringComparison.Ordinal));
        Assert.Contains("current_nodes_mismatch", invalid.Reasons);

        AuthoringCanvasOperationJournalEntry duplicateInverse = entry with
        {
            InverseFacts = [entry.InverseFacts[0], entry.InverseFacts[0]],
            JournalDigest = string.Empty
        };
        duplicateInverse = SealJournal(duplicateInverse);
        AuthoringCanvasOperationVerificationResult duplicateResult = AuthoringCanvasOperationVerifier.Verify(
            initial,
            [duplicateInverse],
            authority.Receipts,
            authority.Snapshot());
        Assert.False(duplicateResult.Valid);
        Assert.Contains(
            duplicateResult.Reasons,
            static reason => reason.StartsWith("journal_fact_set_invalid:", StringComparison.Ordinal));

        AuthoringCanvasClosedCommand invalidSemanticCommand = entry.Commands.Single() with
        {
            Kind = AuthoringCanvasOperationKind.Move,
            ContentDigest = string.Empty
        };
        invalidSemanticCommand = invalidSemanticCommand with
        {
            ContentDigest = AuthoringCanvasOperationContract.ComputeCommandDigest(invalidSemanticCommand)
        };
        AuthoringCanvasOperationJournalEntry semanticTamper = entry with
        {
            CommandKinds = [AuthoringCanvasOperationKind.Move],
            Commands = [invalidSemanticCommand],
            JournalDigest = string.Empty
        };
        semanticTamper = SealJournal(semanticTamper);
        AuthoringCanvasOperationVerificationResult semanticResult = AuthoringCanvasOperationVerifier.Verify(
            initial,
            [semanticTamper],
            authority.Receipts,
            authority.Snapshot());
        Assert.False(semanticResult.Valid);
        Assert.Contains(
            semanticResult.Reasons,
            static reason => reason.StartsWith("journal_command_invalid:", StringComparison.Ordinal));

        AuthoringCanvasOperationJournalEntry contentDigestTamper = entry with
        {
            ContentDigest = new string('a', 64),
            JournalDigest = string.Empty
        };
        contentDigestTamper = SealJournal(contentDigestTamper);
        AuthoringCanvasOperationVerificationResult contentDigestResult = AuthoringCanvasOperationVerifier.Verify(
            initial,
            [contentDigestTamper],
            authority.Receipts,
            authority.Snapshot());
        Assert.False(contentDigestResult.Valid);
        Assert.Contains(
            contentDigestResult.Reasons,
            static reason => reason.StartsWith("journal_content_digest_mismatch:", StringComparison.Ordinal));

        AuthoringCanvasOperationReceipt receiptTamper = receipt with
        {
            UndoDepth = 99
        };
        AuthoringCanvasOperationVerificationResult receiptResult = AuthoringCanvasOperationVerifier.Verify(
            initial,
            authority.Audit,
            [receiptTamper],
            authority.Snapshot());
        Assert.False(receiptResult.Valid);
        Assert.Contains(
            receiptResult.Reasons,
            static reason => reason.StartsWith("operation_receipt_invalid:", StringComparison.Ordinal));
    }

    private static AuthoringCanvasClosedCommand Command(
        AuthoringCanvasOperationKind kind,
        AuthoringCanvasOperationFact before,
        AuthoringCanvasOperationFact after)
        => AuthoringCanvasOperationContract.SealCommand(Guid.CreateVersion7(), kind, [before], [after]);

    private static AuthoringCanvasOperationFact Present(AuthoringCanvasNode node)
        => AuthoringCanvasOperationContract.Present(node);

    private static AuthoringCanvasOperationFact Present(AuthoringCanvasEdge edge)
        => AuthoringCanvasOperationContract.Present(edge);

    private static AuthoringCanvasOperationFact MissingNode(Guid id)
        => AuthoringCanvasOperationContract.Missing(AuthoringCanvasOperationFactKind.Node, id);

    private static AuthoringCanvasOperationFact MissingEdge(Guid id)
        => AuthoringCanvasOperationContract.Missing(AuthoringCanvasOperationFactKind.Edge, id);

    private static AuthoringCanvasOperationJournalEntry SealJournal(AuthoringCanvasOperationJournalEntry entry)
        => entry with
        {
            JournalDigest = AuthoringCanvasOperationContract.ComputeJournalDigest(entry)
        };

    private static AuthoringCanvasNode Reference(Guid id)
        => new(
            id,
            AuthoringCanvasNodeType.ArticleReference,
            0,
            s_geometry,
            TargetArticleId: 42,
            DisplayProjectionReference: "projection-42",
            ReferenceState: AuthoringCanvasReferenceState.Unresolved);

    private static AuthoringCanvasNode Note(Guid id, string source)
        => new(
            id,
            AuthoringCanvasNodeType.PlainTextNote,
            0,
            s_geometry,
            NoteSource: source);

    private static AuthoringCanvasNode Frame(Guid id, IReadOnlyList<Guid> members)
        => new(
            id,
            AuthoringCanvasNodeType.GroupFrame,
            0,
            s_geometry,
            FrameLabel: "group",
            Members: members);

    private static string[] PropertyNames(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.EnumerateObject().Select(static property => property.Name).ToArray();
    }

    private sealed class DeterministicCanvasAuthority :
        IAuthoringCanvasDocumentStore,
        IAuthoringCanvasOperationTransaction,
        IAuthoringCanvasOperationReferenceValidator
    {
        private readonly Dictionary<Guid, AuthoringCanvasOperationJournalEntry> _entries = [];
        private readonly Dictionary<Guid, (string Digest, AuthoringCanvasOperationReceipt Receipt)> _receipts = [];
        private readonly List<Guid> _undo = [];
        private readonly List<Guid> _redo = [];

        public DeterministicCanvasAuthority(
            IReadOnlyList<AuthoringCanvasNode>? nodes = null,
            IReadOnlyList<AuthoringCanvasEdge>? edges = null)
        {
            Nodes = (nodes ?? []).ToDictionary(static node => node.Id);
            Edges = (edges ?? []).ToDictionary(static edge => edge.Id);
            Header = new AuthoringCanvasDocumentHeader(
                s_canvasId,
                s_owner,
                AuthoringCanvasContract.SchemaVersion,
                7,
                "Research",
                new AuthoringCanvasViewport(0, 0, 1),
                Nodes.Count,
                Edges.Count,
                DateTime.UnixEpoch,
                DateTime.UnixEpoch,
                InitialDigest);
            InitialSnapshot = Snapshot();
            Engine = new AuthoringCanvasOperationEngine(this, this, this);
        }

        public AuthoringCanvasOperationEngine Engine
        {
            get;
        }

        public AuthoringCanvasDocumentHeader Header
        {
            get; private set;
        }

        public Dictionary<Guid, AuthoringCanvasNode> Nodes
        {
            get;
        }

        public Dictionary<Guid, AuthoringCanvasEdge> Edges
        {
            get;
        }

        public IReadOnlyList<AuthoringCanvasOperationJournalEntry> Audit { get; private set; } = [];

        public IReadOnlyList<AuthoringCanvasOperationReceipt> Receipts
            => _receipts.Values.Select(static stored => stored.Receipt)
                .OrderBy(static receipt => receipt.Revision)
                .ToArray();

        public AuthoringCanvasOperationSnapshot InitialSnapshot
        {
            get;
        }

        public int CommitCount
        {
            get; private set;
        }

        public int NodePageReads
        {
            get; private set;
        }

        public int ArticleMutationCount => 0;

        public int RelationMutationCount => 0;

        public bool ThrowUnknownAfterNextCommit
        {
            get; set;
        }

        public bool RejectReferences
        {
            get; set;
        }

        public int ReferenceValidationCount
        {
            get; private set;
        }

        public IReadOnlyList<AuthoringCanvasNode> LastValidatedReferences
        {
            get; private set;
        } = [];

        public string HistoryDigest => Audit.Count == 0
            ? AuthoringCanvasOperationContract.EmptyHistoryDigest
            : AuthoringCanvasContract.ComputeCommandDigest(
                "canvas-operation-history",
                Header.Revision,
                string.Join(',', _undo),
                string.Join(',', _redo),
                Audit[^1].JournalDigest);

        public AuthoringCanvasOperationRequest Request(
            IReadOnlyList<AuthoringCanvasClosedCommand> commands,
            Guid? requestId = null)
            => new(
                requestId ?? Guid.CreateVersion7(),
                s_canvasId,
                s_owner,
                51,
                Header.Revision,
                Header.ContentDigest,
                HistoryDigest,
                commands);

        public AuthoringCanvasHistoryRequest HistoryRequest(
            Guid targetJournalId,
            AuthoringCanvasJournalMode mode)
            => new(
                Guid.CreateVersion7(),
                s_canvasId,
                s_owner,
                51,
                Header.Revision,
                Header.ContentDigest,
                HistoryDigest,
                targetJournalId,
                mode);

        public AuthoringCanvasOperationSnapshot Snapshot()
            => new(Header, Nodes.Values.ToArray(), Edges.Values.ToArray());

        public Task<AuthoringCanvasDocumentHeader?> GetAsync(
            AuthoringCanvasOwner owner,
            Guid canvasId,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult<AuthoringCanvasDocumentHeader?>(
                owner == s_owner && canvasId == s_canvasId ? Header : null);
        }

        public Task<AuthoringCanvasPage<AuthoringCanvasNode>> ReadNodesAsync(
            AuthoringCanvasOwner owner,
            Guid canvasId,
            AuthoringCanvasPageCursor? cursor,
            int limit,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            NodePageReads++;
            return Task.FromResult(Page(
                Nodes.Values.OrderBy(static node => node.Order).ThenBy(static node => node.Id),
                cursor,
                limit,
                static node => node.Order,
                static node => node.Id));
        }

        public Task<AuthoringCanvasPage<AuthoringCanvasEdge>> ReadEdgesAsync(
            AuthoringCanvasOwner owner,
            Guid canvasId,
            AuthoringCanvasPageCursor? cursor,
            int limit,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(Page(
                Edges.Values.OrderBy(static edge => edge.Order).ThenBy(static edge => edge.Id),
                cursor,
                limit,
                static edge => edge.Order,
                static edge => edge.Id));
        }

        public Task<AuthoringCanvasHistoryWindow> ReadHistoryAsync(
            AuthoringCanvasOwner owner,
            Guid canvasId,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new AuthoringCanvasHistoryWindow(
                canvasId,
                Header.Revision,
                Header.ContentDigest,
                HistoryDigest,
                _undo.AsEnumerable().Reverse().Select(id => _entries[id]).ToArray(),
                _redo.AsEnumerable().Reverse().Select(id => _entries[id]).ToArray()));
        }

        public Task<IReadOnlyList<AuthoringCanvasOperationJournalEntry>> ReadJournalAsync(
            AuthoringCanvasOwner owner,
            Guid canvasId,
            long afterRevision,
            int limit,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult<IReadOnlyList<AuthoringCanvasOperationJournalEntry>>(
                Audit.Where(entry => entry.Revision > afterRevision).Take(limit).ToArray());
        }

        public Task<IReadOnlyList<AuthoringCanvasOperationReceipt>> ReadReceiptsAsync(
            AuthoringCanvasOwner owner,
            Guid canvasId,
            long afterRevision,
            int limit,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult<IReadOnlyList<AuthoringCanvasOperationReceipt>>(
                Receipts.Where(receipt => receipt.Revision > afterRevision).Take(limit).ToArray());
        }

        public Task<AuthoringCanvasOperationReceipt?> RecoverAsync(
            AuthoringCanvasOperationRecoveryQuery query,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!_receipts.TryGetValue(query.RequestId, out var stored))
            {
                return Task.FromResult<AuthoringCanvasOperationReceipt?>(null);
            }
            if (!string.Equals(stored.Digest, query.TransactionDigest, StringComparison.Ordinal))
            {
                throw new AuthoringCanvasIdempotencyConflictException();
            }
            AuthoringCanvasOperationStatus status = ThrowUnknownAfterNextCommit
                ? AuthoringCanvasOperationStatus.RecoveredAfterUnknownCommit
                : AuthoringCanvasOperationStatus.IdempotentReplay;
            ThrowUnknownAfterNextCommit = false;
            AuthoringCanvasOperationReceipt replay = stored.Receipt with
            {
                Status = status,
                ReceiptDigest = string.Empty
            };
            replay = replay with
            {
                ReceiptDigest = AuthoringCanvasOperationContract.ComputeReceiptDigest(replay)
            };
            return Task.FromResult<AuthoringCanvasOperationReceipt?>(replay);
        }

        public Task<AuthoringCanvasOperationReceipt> CommitAsync(
            AuthoringCanvasOperationPlan plan,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (plan.ExpectedRevision != Header.Revision
                || !string.Equals(plan.ExpectedContentDigest, Header.ContentDigest, StringComparison.Ordinal))
            {
                throw new AuthoringCanvasRevisionConflictException(plan.ExpectedRevision, Header.Revision);
            }
            if (plan.Mode == AuthoringCanvasJournalMode.Apply
                && !plan.TruncatedRedoJournalIds.SequenceEqual(_redo.AsEnumerable().Reverse()))
            {
                throw new AuthoringCanvasHistoryConflictException();
            }

            foreach (AuthoringCanvasOperationFact fact in plan.ForwardFacts)
            {
                Apply(fact);
            }
            if (Nodes.Count != plan.ResultNodeCount || Edges.Count != plan.ResultEdgeCount)
            {
                throw new InvalidOperationException("deterministic_canvas_plan_count_mismatch");
            }

            CommitCount++;
            long revision = Header.Revision + 1;
            string contentDigest = AuthoringCanvasContract.ComputeTransitionDigest(
                Header.ContentDigest,
                revision,
                $"canvas-operation:{plan.Mode}",
                plan.TransactionDigest,
                Nodes.Count,
                Edges.Count);
            Guid journalId = Guid.CreateVersion7();
            var entry = new AuthoringCanvasOperationJournalEntry(
                journalId,
                s_canvasId,
                revision,
                plan.Mode,
                plan.RequestId,
                plan.ActorUserId,
                Audit.Count == 0 ? null : Audit[^1].JournalId,
                plan.TargetJournalId,
                Header.ContentDigest,
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
            _entries.Add(journalId, entry);
            Audit = [.. Audit, entry];
            ApplyHistory(plan, entry);
            Header = Header with
            {
                Revision = revision,
                Viewport = CurrentViewport(plan),
                NodeCount = Nodes.Count,
                EdgeCount = Edges.Count,
                UpdatedAtUtc = DateTime.UnixEpoch.AddSeconds(revision),
                ContentDigest = contentDigest
            };
            var receipt = new AuthoringCanvasOperationReceipt(
                Guid.CreateVersion7(),
                plan.RequestId,
                s_canvasId,
                revision,
                plan.Mode,
                journalId,
                plan.TargetJournalId,
                plan.CommandKinds.Count,
                plan.CommandKinds,
                plan.AffectedNodeIds,
                plan.AffectedEdgeIds,
                _undo.Count,
                _redo.Count,
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
            _receipts.Add(plan.RequestId, (plan.TransactionDigest, receipt));
            if (ThrowUnknownAfterNextCommit)
            {
                throw new AuthoringCanvasUnknownCommitResultException();
            }
            return Task.FromResult(receipt);
        }

        public Task<string> ValidateAsync(
            AuthoringCanvasOperationReferenceValidationRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReferenceValidationCount++;
            LastValidatedReferences = request.References.ToArray();
            if (RejectReferences)
            {
                throw new AuthoringCanvasValidationException("canvas_reference_target_unavailable");
            }
            Assert.All(request.References, static node => Assert.True(node.TargetArticleId > 0));
            return Task.FromResult(AuthoringCanvasContract.ComputeCommandDigest(
                "deterministic-reference-validation",
                request.CanvasId,
                request.CanvasRevision,
                request.CanvasContentDigest,
                string.Join(',', request.References.Select(AuthoringCanvasContract.ComputeNodeDigest))));
        }

        public Task<AuthoringCanvasWriteReceipt> CreateAsync(
            CreateAuthoringCanvasCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasPage<AuthoringCanvasDocumentHeader>> ListAsync(
            AuthoringCanvasOwner owner,
            AuthoringCanvasPageCursor? cursor,
            int limit,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasWriteReceipt> PutNodeAsync(
            PutAuthoringCanvasNodeCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasWriteReceipt> DeleteNodeAsync(
            DeleteAuthoringCanvasNodeCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasWriteReceipt> PutEdgeAsync(
            PutAuthoringCanvasEdgeCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasWriteReceipt> DeleteEdgeAsync(
            DeleteAuthoringCanvasEdgeCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasWriteReceipt> UpdateMetadataAsync(
            UpdateAuthoringCanvasMetadataCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasWriteReceipt> DeleteAsync(
            DeleteAuthoringCanvasCommand command,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthoringCanvasVerificationResult> VerifyAsync(
            AuthoringCanvasOwner owner,
            Guid canvasId,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        private static AuthoringCanvasPage<T> Page<T>(
            IEnumerable<T> source,
            AuthoringCanvasPageCursor? cursor,
            int limit,
            Func<T, long> order,
            Func<T, Guid> id)
        {
            T[] filtered = source.Where(item => cursor is null
                || order(item) > cursor.Value.Order
                || (order(item) == cursor.Value.Order && id(item).CompareTo(cursor.Value.Id) > 0))
                .Take(limit + 1)
                .ToArray();
            bool hasMore = filtered.Length > limit;
            T[] items = filtered.Take(limit).ToArray();
            AuthoringCanvasPageCursor? next = hasMore
                ? new AuthoringCanvasPageCursor(order(items[^1]), id(items[^1]))
                : null;
            return new AuthoringCanvasPage<T>(items, next);
        }

        private void Apply(AuthoringCanvasOperationFact fact)
        {
            switch (fact.Kind)
            {
                case AuthoringCanvasOperationFactKind.Node when fact.Exists:
                    Nodes[fact.Id] = fact.Node!;
                    break;
                case AuthoringCanvasOperationFactKind.Node:
                    Nodes.Remove(fact.Id);
                    break;
                case AuthoringCanvasOperationFactKind.Edge when fact.Exists:
                    Edges[fact.Id] = fact.Edge!;
                    break;
                case AuthoringCanvasOperationFactKind.Edge:
                    Edges.Remove(fact.Id);
                    break;
            }
        }

        private void ApplyHistory(
            AuthoringCanvasOperationPlan plan,
            AuthoringCanvasOperationJournalEntry entry)
        {
            switch (plan.Mode)
            {
                case AuthoringCanvasJournalMode.Apply:
                    _redo.Clear();
                    _undo.Add(entry.JournalId);
                    if (_undo.Count > AuthoringCanvasOperationContract.MaxUndoDepth)
                    {
                        _undo.RemoveAt(0);
                    }
                    break;
                case AuthoringCanvasJournalMode.Undo:
                    if (_undo.Count == 0 || _undo[^1] != plan.TargetJournalId)
                    {
                        throw new AuthoringCanvasHistoryConflictException();
                    }
                    _undo.RemoveAt(_undo.Count - 1);
                    _redo.Add(plan.TargetJournalId.Value);
                    break;
                case AuthoringCanvasJournalMode.Redo:
                    if (_redo.Count == 0 || _redo[^1] != plan.TargetJournalId)
                    {
                        throw new AuthoringCanvasHistoryConflictException();
                    }
                    _redo.RemoveAt(_redo.Count - 1);
                    _undo.Add(plan.TargetJournalId.Value);
                    break;
            }
        }

        private AuthoringCanvasViewport CurrentViewport(AuthoringCanvasOperationPlan plan)
            => plan.ForwardFacts.LastOrDefault(static fact => fact.Kind == AuthoringCanvasOperationFactKind.Viewport)
                ?.Viewport ?? Header.Viewport;
    }
}
