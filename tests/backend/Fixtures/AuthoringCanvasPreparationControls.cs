#nullable enable

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Tests.Fixtures;

/// <summary>
/// Runs actual transport, resolver, reference validator, planner and semantic code over deterministic
/// fixture ports. These controls do not qualify the PostgreSQL adapter, HTTP middleware or browser.
/// </summary>
public static class AuthoringCanvasPreparationControls
{
    private static readonly Guid s_canvasId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid s_nodeId = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly AuthoringCanvasOwner s_owner = new(2147483648L, "primary-site");

    public static async Task<int> RunAsync()
    {
        int controls = 0;
        foreach (AuthoringCanvasNodeType type in new[] { AuthoringCanvasNodeType.ArticleReference,
            AuthoringCanvasNodeType.HeadingReference, AuthoringCanvasNodeType.BlockReference })
        {
            var fixture = new Fixture();
            AuthoringCanvasNode reference = Reference(type);
            AuthoringCanvasApplyRequest raw = fixture.Request(Create(reference));
            await RejectAsync<AuthoringCanvasValidationException>(() => fixture.Transport.ApplyAsync(s_owner, s_canvasId, raw, default));
            controls++;
            AuthoringCanvasApplyRequest prepared = await fixture.Transport.PrepareAsync(s_owner, s_canvasId, raw, default);
            AuthoringCanvasNode node = prepared.Commands[0].After[0].Node!;
            Require(node.ReferenceState == AuthoringCanvasReferenceState.Current && !string.IsNullOrEmpty(node.DisplayProjectionReference), "fresh projection missing");
            Require(node with { ReferenceState = reference.ReferenceState, DisplayProjectionReference = reference.DisplayProjectionReference } == reference, "intent changed");
            Require(fixture.Commits == 0, "preparation wrote state");
            await fixture.Transport.ApplyAsync(s_owner, s_canvasId, prepared, default);
            Require(fixture.Commits == 1, "actual planner did not commit once");
            controls++;
        }

        {
            var fixture = new Fixture();
            AuthoringCanvasNode reference = Reference(AuthoringCanvasNodeType.ArticleReference);
            AuthoringCanvasNode pinned = reference with { PinnedTargetRevision = 5, ReferenceState = AuthoringCanvasReferenceState.Pinned };
            AuthoringCanvasNode moved = pinned with { Geometry = pinned.Geometry with { X = 40 } };
            AuthoringCanvasNode unpinned = moved with { PinnedTargetRevision = null, ReferenceState = AuthoringCanvasReferenceState.Current };
            AuthoringCanvasNode resized = unpinned with { Geometry = unpinned.Geometry with { Width = 300 } };
            AuthoringCanvasApplyRequest raw = fixture.Request(Create(reference),
                Change(AuthoringCanvasOperationKind.PinTargetRevision, reference, pinned),
                Change(AuthoringCanvasOperationKind.Move, pinned, moved),
                Change(AuthoringCanvasOperationKind.UnpinTargetRevision, moved, unpinned),
                Change(AuthoringCanvasOperationKind.Resize, unpinned, resized));
            AuthoringCanvasApplyRequest prepared = await fixture.Transport.PrepareAsync(s_owner, s_canvasId, raw, default);
            Require(prepared.Commands[0].After[0].Node!.ReferenceState == AuthoringCanvasReferenceState.Current, "create state");
            Require(prepared.Commands[1].After[0].Node!.ReferenceState == AuthoringCanvasReferenceState.Pinned, "pin state");
            Require(prepared.Commands[3].After[0].Node!.ReferenceState == AuthoringCanvasReferenceState.Current, "unpin state");
            for (int index = 1; index < prepared.Commands.Count; index++)
            {
                Require(prepared.Commands[index].Before[0].Node == prepared.Commands[index - 1].After[0].Node, "same-batch metadata did not propagate");
            }
            Require(fixture.Commits == 0, "batch preparation wrote");
            AuthoringCanvasOperationReceipt receipt = await fixture.Transport.ApplyAsync(s_owner, s_canvasId, prepared, default);
            Require(fixture.LastPlan!.ActorUserId == s_owner.AdminPrincipalId, "journal actor was not isolated admin");
            controls++;
            fixture.AuthorityGeneration++;
            AuthoringCanvasOperationReceipt replay = await fixture.Transport.ApplyAsync(s_owner, s_canvasId, prepared, default);
            Require(replay.ReceiptId == receipt.ReceiptId && fixture.Commits == 1, "exact retry did not recover original receipt");
            controls++;
            AuthoringCanvasWireCommand changed = prepared.Commands[^1] with { CommandId = Guid.NewGuid() };
            await RejectAsync<AuthoringCanvasIdempotencyConflictException>(() => fixture.Transport.ApplyAsync(s_owner, s_canvasId,
                prepared with { Commands = [.. prepared.Commands.Take(prepared.Commands.Count - 1), changed] }, default));
            controls++;
        }

        {
            var fixture = new Fixture();
            AuthoringCanvasApplyRequest raw = fixture.Request(Create(Reference(AuthoringCanvasNodeType.ArticleReference)));
            fixture.Header = fixture.Header with { Revision = 2 };
            await RejectAsync<AuthoringCanvasRevisionConflictException>(() => fixture.Transport.PrepareAsync(s_owner, s_canvasId, raw, default));
            controls++;
        }
        {
            var fixture = new Fixture();
            AuthoringCanvasApplyRequest raw = fixture.Request(Create(Reference(AuthoringCanvasNodeType.ArticleReference)));
            await RejectAsync<AuthoringCanvasHistoryConflictException>(() => fixture.Transport.PrepareAsync(s_owner, s_canvasId,
                raw with { ExpectedHistoryDigest = new string('b', 64) }, default));
            Require(fixture.BatchReads == 0 && fixture.Commits == 0, "stale history accessed targets or committed");
            controls++;
        }
        {
            var fixture = new Fixture();
            await RejectAsync<AuthoringCanvasAccessDeniedException>(() => fixture.Transport.PrepareAsync(new AuthoringCanvasOwner(42, "primary-site"),
                s_canvasId, fixture.Request(Create(Reference(AuthoringCanvasNodeType.ArticleReference))), default));
            Require(fixture.BatchReads == 0 && fixture.Commits == 0, "foreign owner accessed targets");
            controls++;
        }
        {
            var fixture = new Fixture();
            AuthoringCanvasNode reference = Reference(AuthoringCanvasNodeType.ArticleReference) with { TargetArticleId = 999 };
            await RejectAsync<AuthoringCanvasValidationException>(() => fixture.Transport.PrepareAsync(s_owner, s_canvasId, fixture.Request(Create(reference)), default));
            Require(fixture.Commits == 0, "unauthorized reference committed");
            controls++;
        }
        {
            var fixture = new Fixture();
            AuthoringCanvasNode stored = Reference(AuthoringCanvasNodeType.ArticleReference) with
            {
                ReferenceState = AuthoringCanvasReferenceState.Current,
                DisplayProjectionReference = fixture.Projection(Reference(AuthoringCanvasNodeType.ArticleReference))
            };
            fixture.Nodes = [stored];
            fixture.Header = fixture.Header with { NodeCount = 1 };
            AuthoringCanvasNode forged = stored with { Geometry = stored.Geometry with { X = 999 } };
            AuthoringCanvasNode pinned = forged with { PinnedTargetRevision = 5, ReferenceState = AuthoringCanvasReferenceState.Pinned, DisplayProjectionReference = null };
            await RejectAsync<AuthoringCanvasRevisionConflictException>(() => fixture.Transport.PrepareAsync(s_owner, s_canvasId,
                fixture.Request(Change(AuthoringCanvasOperationKind.PinTargetRevision, forged, pinned)), default));
            Require(fixture.Commits == 0, "forged first Before committed");
            controls++;
        }
        {
            var fixture = new Fixture { DriftAuthority = true };
            await RejectAsync<AuthoringCanvasValidationException>(() => fixture.Transport.PrepareAsync(s_owner, s_canvasId,
                fixture.Request(Create(Reference(AuthoringCanvasNodeType.HeadingReference))), default));
            Require(fixture.Commits == 0, "authority drift committed");
            controls++;
        }
        {
            var fixture = new Fixture();
            AuthoringCanvasApplyRequest prepared = await fixture.Transport.PrepareAsync(s_owner, s_canvasId,
                fixture.Request(Create(Reference(AuthoringCanvasNodeType.BlockReference))), default);
            fixture.AuthorityGeneration++;
            await RejectAsync<AuthoringCanvasValidationException>(() => fixture.Transport.ApplyAsync(s_owner, s_canvasId, prepared, default));
            Require(fixture.Commits == 0, "stale prepared projection bypassed formal validator");
            controls++;
        }
        foreach (int changedIndex in new[] { 0, 1 })
        {
            var fixture = new Fixture();
            AuthoringCanvasNode reference = Reference(AuthoringCanvasNodeType.ArticleReference);
            AuthoringCanvasNode pinned = reference with { PinnedTargetRevision = 5, ReferenceState = AuthoringCanvasReferenceState.Pinned };
            AuthoringCanvasNode unpinned = pinned with { PinnedTargetRevision = null, ReferenceState = AuthoringCanvasReferenceState.Current };
            AuthoringCanvasApplyRequest prepared = await fixture.Transport.PrepareAsync(s_owner, s_canvasId,
                fixture.Request(Create(reference), Change(AuthoringCanvasOperationKind.PinTargetRevision, reference, pinned),
                    Change(AuthoringCanvasOperationKind.UnpinTargetRevision, pinned, unpinned)), default);
            AuthoringCanvasWireCommand[] commands = prepared.Commands.ToArray();
            AuthoringCanvasOperationFact forged = commands[changedIndex].After[0] with
            {
                Node = commands[changedIndex].After[0].Node! with { DisplayProjectionReference = new string('f', 64) }
            };
            commands[changedIndex] = commands[changedIndex] with { After = [forged] };
            commands[changedIndex + 1] = commands[changedIndex + 1] with { Before = [forged] };
            await RejectAsync<AuthoringCanvasValidationException>(() => fixture.Transport.ApplyAsync(s_owner, s_canvasId,
                prepared with { Commands = commands }, default));
            Require(fixture.Commits == 0, "later valid unpin concealed an invalid earlier reference fact");
            controls++;
        }
        return controls;
    }

    private static AuthoringCanvasNode Reference(AuthoringCanvasNodeType type)
        => new(s_nodeId, type, 0, new AuthoringCanvasGeometry(10, 20, 240, 140),
            TargetArticleId: 7, TargetHeadingIdentity: type == AuthoringCanvasNodeType.HeadingReference ? "heading-a" : null,
            TargetBlockIdentity: type == AuthoringCanvasNodeType.BlockReference ? "block-a" : null,
            ReferenceState: AuthoringCanvasReferenceState.Unresolved);

    private static AuthoringCanvasOperationFact Fact(AuthoringCanvasNode node)
        => new(AuthoringCanvasOperationFactKind.Node, node.Id, true, Node: node);

    private static AuthoringCanvasWireCommand Create(AuthoringCanvasNode node)
        => new(Guid.NewGuid(), AuthoringCanvasOperationKind.CreateReference,
            [new AuthoringCanvasOperationFact(AuthoringCanvasOperationFactKind.Node, node.Id, false)], [Fact(node)]);

    private static AuthoringCanvasWireCommand Change(AuthoringCanvasOperationKind kind, AuthoringCanvasNode before, AuthoringCanvasNode after)
        => new(Guid.NewGuid(), kind, [Fact(before)], [Fact(after)]);

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static async Task RejectAsync<T>(Func<Task> action) where T : Exception
    {
        try { await action(); }
        catch (T) { return; }
        throw new InvalidOperationException($"expected {typeof(T).Name}");
    }

    private sealed class Fixture : IAuthoringCanvasDocumentStore, IAuthoringCanvasOperationTransaction, IAuthoringCanvasReferenceFactSource
    {
        public AuthoringCanvasDocumentHeader Header { get; set; } = new(s_canvasId, s_owner, 1, 1, "Fixture",
            new AuthoringCanvasViewport(0, 0, 1), 0, 0, DateTime.UnixEpoch, DateTime.UnixEpoch, new string('a', 64));
        public IReadOnlyList<AuthoringCanvasNode> Nodes { get; set; } = [];
        public long AuthorityGeneration { get; set; } = 1;
        public bool DriftAuthority { get; init; }
        public int BatchReads { get; private set; }
        public int Commits { get; private set; }
        public AuthoringCanvasOperationPlan? LastPlan { get; private set; }
        public AuthoringCanvasTransport Transport { get; }
        private AuthoringCanvasOperationReceipt? _receipt;
        private int _authorityReads;

        public Fixture()
        {
            var resolver = new AuthoringCanvasReferenceResolver(this, this, new AuthoringCanvasReferenceProjectionCache(), TimeProvider.System);
            var validator = new AuthoringCanvasOperationReferenceValidator(resolver);
            var engine = new AuthoringCanvasOperationEngine(this, this, validator);
            Transport = new AuthoringCanvasTransport(this, this, engine, resolver);
        }

        public AuthoringCanvasApplyRequest Request(params AuthoringCanvasWireCommand[] commands)
            => new(Guid.NewGuid(), Header.Revision, Header.ContentDigest, AuthoringCanvasOperationContract.EmptyHistoryDigest, commands);

        public string Projection(AuthoringCanvasNode node)
            => AuthoringCanvasContract.ComputeCommandDigest("fixture-projection", AuthorityGeneration, node.Id, node.Type,
                node.TargetArticleId, node.TargetHeadingIdentity, node.TargetBlockIdentity, node.PinnedTargetRevision ?? 9);

        public Task<AuthoringCanvasDocumentHeader?> GetAsync(AuthoringCanvasOwner owner, Guid canvasId, CancellationToken cancellationToken = default)
            => Task.FromResult<AuthoringCanvasDocumentHeader?>(owner == s_owner && canvasId == s_canvasId ? Header : null);
        public Task<AuthoringCanvasPage<AuthoringCanvasNode>> ReadNodesAsync(AuthoringCanvasOwner owner, Guid canvasId, AuthoringCanvasPageCursor? cursor, int limit, CancellationToken cancellationToken = default)
            => Task.FromResult(new AuthoringCanvasPage<AuthoringCanvasNode>(Nodes, null));
        public Task<AuthoringCanvasPage<AuthoringCanvasEdge>> ReadEdgesAsync(AuthoringCanvasOwner owner, Guid canvasId, AuthoringCanvasPageCursor? cursor, int limit, CancellationToken cancellationToken = default)
            => Task.FromResult(new AuthoringCanvasPage<AuthoringCanvasEdge>([], null));
        public Task<AuthoringCanvasHistoryWindow> ReadHistoryAsync(AuthoringCanvasOwner owner, Guid canvasId, CancellationToken cancellationToken = default)
            => Task.FromResult(new AuthoringCanvasHistoryWindow(canvasId, Header.Revision, Header.ContentDigest,
                AuthoringCanvasOperationContract.EmptyHistoryDigest, [], []));

        public Task<AuthoringCanvasReferenceAuthorityCoordinate> ReadAuthorityCoordinateAsync(AuthoringCanvasOwner owner, AuthoringCanvasReferencePermission permission, CancellationToken cancellationToken = default)
        {
            Require(owner == s_owner, "reference owner");
            if (DriftAuthority && ++_authorityReads == 2) AuthorityGeneration++;
            return Task.FromResult(new AuthoringCanvasReferenceAuthorityCoordinate(AuthorityGeneration,
                AuthoringCanvasContract.ComputeCommandDigest("fixture-generation", AuthorityGeneration), "fixture-article-write"));
        }

        public Task<IReadOnlyList<AuthoringCanvasReferenceFact>> ReadBatchAsync(AuthoringCanvasReferenceFactQuery query, CancellationToken cancellationToken = default)
        {
            BatchReads++;
            IReadOnlyList<AuthoringCanvasReferenceFact> facts = query.Targets.Select(target =>
            {
                if (target.TargetArticleId == 999)
                    return new AuthoringCanvasReferenceFact(target.NodeId, 999, AuthoringCanvasArticleState.PermissionDeniedOrUnknown,
                        AuthoringCanvasReferenceCoordinateState.Missing, 0, 0, false, null, null, null);
                var node = Reference(target.NodeType) with { PinnedTargetRevision = target.PinnedTargetRevision };
                return new AuthoringCanvasReferenceFact(target.NodeId, target.TargetArticleId, AuthoringCanvasArticleState.Current,
                    AuthoringCanvasReferenceCoordinateState.Current, 9, target.PinnedTargetRevision ?? 9, false,
                    "Authorized fixture title", "Bounded fixture context", "/article/7") { DisplayProjectionReference = Projection(node) };
            }).ToArray();
            return Task.FromResult(facts);
        }

        public Task<AuthoringCanvasOperationReceipt> CommitAsync(AuthoringCanvasOperationPlan plan, CancellationToken cancellationToken = default)
        {
            Require(plan.ExpectedRevision == Header.Revision && plan.ExpectedContentDigest == Header.ContentDigest, "fixture CAS");
            LastPlan = plan;
            Commits++;
            Header = Header with { Revision = Header.Revision + 1 };
            var receipt = new AuthoringCanvasOperationReceipt(Guid.NewGuid(), plan.RequestId, plan.CanvasId, Header.Revision,
                plan.Mode, Guid.NewGuid(), plan.TargetJournalId, plan.CommandKinds.Count, plan.CommandKinds,
                plan.AffectedNodeIds, plan.AffectedEdgeIds, 1, 0, AuthoringCanvasOperationStatus.Committed, [],
                plan.TransactionDigest, new string('c', 64), Header.ContentDigest, string.Empty);
            _receipt = receipt with { ReceiptDigest = AuthoringCanvasOperationContract.ComputeReceiptDigest(receipt) };
            return Task.FromResult(_receipt);
        }

        public Task<AuthoringCanvasOperationReceipt?> RecoverAsync(AuthoringCanvasOperationRecoveryQuery query, CancellationToken cancellationToken = default)
        {
            if (_receipt is not null && _receipt.RequestId == query.RequestId && _receipt.TransactionDigest != query.TransactionDigest)
                throw new AuthoringCanvasIdempotencyConflictException();
            return Task.FromResult(_receipt?.RequestId == query.RequestId ? _receipt : null);
        }

        public Task<IReadOnlyList<AuthoringCanvasOperationJournalEntry>> ReadJournalAsync(AuthoringCanvasOwner owner, Guid canvasId, long afterRevision, int limit, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IReadOnlyList<AuthoringCanvasOperationReceipt>> ReadReceiptsAsync(AuthoringCanvasOwner owner, Guid canvasId, long afterRevision, int limit, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasPage<AuthoringCanvasDocumentHeader>> ListAsync(AuthoringCanvasOwner owner, AuthoringCanvasPageCursor? cursor, int limit, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasWriteReceipt> CreateAsync(CreateAuthoringCanvasCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasWriteReceipt> PutNodeAsync(PutAuthoringCanvasNodeCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasWriteReceipt> DeleteNodeAsync(DeleteAuthoringCanvasNodeCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasWriteReceipt> PutEdgeAsync(PutAuthoringCanvasEdgeCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasWriteReceipt> DeleteEdgeAsync(DeleteAuthoringCanvasEdgeCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasWriteReceipt> UpdateMetadataAsync(UpdateAuthoringCanvasMetadataCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasWriteReceipt> DeleteAsync(DeleteAuthoringCanvasCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<AuthoringCanvasVerificationResult> VerifyAsync(AuthoringCanvasOwner owner, Guid canvasId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
