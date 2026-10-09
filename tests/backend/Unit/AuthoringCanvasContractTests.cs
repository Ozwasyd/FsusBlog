using FsusBlog.Shared.Contracts.AuthoringCanvas;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasContractTests
{
    private static readonly AuthoringCanvasGeometry s_geometry = new(10, -20, 240, 120);

    [Fact]
    public void ClosedSchema_AcceptsExactlyFiveNodeTypesAndTwoEdgeTypes()
    {
        Guid articleNodeId = Guid.CreateVersion7();
        Guid noteNodeId = Guid.CreateVersion7();
        AuthoringCanvasNode[] nodes =
        [
            new(articleNodeId, AuthoringCanvasNodeType.ArticleReference, 0, s_geometry,
                TargetArticleId: 42, ReferenceState: AuthoringCanvasReferenceState.Current),
            new(Guid.CreateVersion7(), AuthoringCanvasNodeType.HeadingReference, 1, s_geometry,
                TargetArticleId: 42, TargetHeadingIdentity: "heading-1",
                ReferenceState: AuthoringCanvasReferenceState.Pinned, PinnedTargetRevision: 9),
            new(Guid.CreateVersion7(), AuthoringCanvasNodeType.BlockReference, 2, s_geometry,
                TargetArticleId: 42, TargetBlockIdentity: "block-1",
                ReferenceState: AuthoringCanvasReferenceState.Stale),
            new(noteNodeId, AuthoringCanvasNodeType.PlainTextNote, 3, s_geometry,
                NoteSource: "A bounded private note."),
            new(Guid.CreateVersion7(), AuthoringCanvasNodeType.GroupFrame, 4, s_geometry,
                FrameLabel: "Sources", Members: [articleNodeId, noteNodeId])
        ];
        AuthoringCanvasEdge[] edges =
        [
            new(Guid.CreateVersion7(), AuthoringCanvasEdgeType.VisualOnly, 0, articleNodeId, noteNodeId),
            new(Guid.CreateVersion7(), AuthoringCanvasEdgeType.ExplicitReferenceNote, 1,
                noteNodeId, articleNodeId, "supports")
        ];

        Assert.All(nodes, AuthoringCanvasContract.ValidateNode);
        Assert.All(edges, AuthoringCanvasContract.ValidateEdge);
        Assert.Equal(5, Enum.GetValues<AuthoringCanvasNodeType>().Length);
        Assert.Equal(2, Enum.GetValues<AuthoringCanvasEdgeType>().Length);
    }

    [Fact]
    public void ClosedSchema_RejectsUnknownArbitraryAndExecutablePayloadShapes()
    {
        AuthoringCanvasNode arbitrary = new(
            Guid.CreateVersion7(),
            (AuthoringCanvasNodeType)99,
            0,
            s_geometry,
            NoteSource: "plugin payload");
        AuthoringCanvasNode bodyCopy = new(
            Guid.CreateVersion7(),
            AuthoringCanvasNodeType.ArticleReference,
            0,
            s_geometry,
            TargetArticleId: 42,
            ReferenceState: AuthoringCanvasReferenceState.Current,
            NoteSource: "copied article source");
        string[] executableNotes =
        [
            "<script>alert(1)</script>",
            "<iframe src='https://example.invalid'></iframe>",
            "<svg onload='alert(1)'></svg>",
            "<component is='plugin-node'></component>"
        ];

        Assert.Throws<AuthoringCanvasValidationException>(() => AuthoringCanvasContract.ValidateNode(arbitrary));
        Assert.Throws<AuthoringCanvasValidationException>(() => AuthoringCanvasContract.ValidateNode(bodyCopy));
        foreach (string note in executableNotes)
        {
            var node = new AuthoringCanvasNode(
                Guid.CreateVersion7(),
                AuthoringCanvasNodeType.PlainTextNote,
                0,
                s_geometry,
                NoteSource: note);
            Assert.Throws<AuthoringCanvasValidationException>(() => AuthoringCanvasContract.ValidateNode(node));
        }
    }

    [Fact]
    public void BudgetsAndCanonicalDigest_AreClosedAndDeterministic()
    {
        Assert.Equal(100, AuthoringCanvasContract.MaxCanvasesPerOwner);
        Assert.Equal(10_000, AuthoringCanvasContract.MaxNodesPerCanvas);
        Assert.Equal(10_000, AuthoringCanvasContract.MaxEdgesPerCanvas);
        Assert.Equal(256, AuthoringCanvasContract.MaxPageSize);

        var node = new AuthoringCanvasNode(
            Guid.Parse("018f5f93-2997-7c8a-9a47-0242ac120002"),
            AuthoringCanvasNodeType.PlainTextNote,
            0,
            s_geometry,
            NoteSource: "digest fixture");
        string first = AuthoringCanvasContract.ComputeNodeDigest(node);
        string second = AuthoringCanvasContract.ComputeNodeDigest(node);

        Assert.Equal(first, second);
        Assert.Equal(64, first.Length);
        Assert.Throws<AuthoringCanvasValidationException>(() => AuthoringCanvasContract.ValidateNode(
            node with
            {
                NoteSource = new string('x', AuthoringCanvasContract.MaxNoteSourceLength + 1)
            }));
        Assert.Throws<AuthoringCanvasValidationException>(() => AuthoringCanvasContract.ValidateViewport(
            new AuthoringCanvasViewport(0, 0, AuthoringCanvasContract.MaxZoom + 0.01)));
    }
}
