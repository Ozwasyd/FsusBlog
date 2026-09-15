using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentThreadFixtureContractTests
{
    [Theory]
    [InlineData("approved-root", 0, "comment.thread.root")]
    [InlineData("approved-reply", 41, "comment.thread.reply")]
    [InlineData("approved-nested", 42, "comment.thread.nested")]
    [InlineData("deleted-root-child", 43, "comment.thread.reply")]
    [InlineData("depth-root", 0, "comment.thread.depth-boundary")]
    [InlineData("depth-1", 44, "comment.thread.depth-boundary")]
    public void SeederCapabilityMapping_IsSpecificToThreadShape(string role, long parentId, string expected)
    {
        Assert.Equal(
            expected,
            CommentFixtureSeeder.CapabilityForRole(role, parentId == 0 ? null : parentId));
    }

    [Fact]
    public void PlanValidation_RejectsUnpreparedOrAmbiguousParents()
    {
        CommentThreadFixtureOperation root = Create("comment.thread.root", "root");
        CommentThreadFixtureOperation child = Create(
            "comment.thread.reply",
            "reply",
            parentRole: "missing",
            parentCommentId: 41);

        Assert.Throws<InvalidOperationException>(() =>
            CommentThreadFixturePort.ValidatePlanForTests(Plan(root, child)));
    }

    [Fact]
    public void PlanValidation_RejectsConflictingPreparedParentIdentities()
    {
        CommentThreadFixtureOperation root = Create("comment.thread.root", "root");
        CommentThreadFixtureOperation child = Create(
            "comment.thread.reply",
            "reply",
            parentRole: "root",
            parentCommentId: 42);

        Assert.Throws<InvalidOperationException>(() =>
            CommentThreadFixturePort.ValidatePlanForTests(Plan(root, child)));
    }

    [Fact]
    public void PlanValidation_RejectsLegacyActorsAndReusedMutationIdentities()
    {
        CommentThreadFixtureOperation legacy = Create(
            "comment.thread.root",
            "legacy",
            actorMode: "legacy_server_visible_pseudonymous");
        Assert.Throws<InvalidOperationException>(() =>
            CommentThreadFixturePort.ValidatePlanForTests(Plan(legacy)));

        CommentThreadFixtureOperation first = new(
            "comment.version.edited",
            "edited",
            CommentThreadFixtureOperations.Edit,
            CommentAuthorModes.Public,
            11,
            "one",
            ExistingCommentId: 41);
        CommentThreadFixtureOperation second = first with
        {
            Content = "two"
        };
        Assert.Throws<InvalidOperationException>(() =>
            CommentThreadFixturePort.ValidatePlanForTests(Plan(first, second)));
    }

    [Fact]
    public void PlanValidation_AllowsOneOwnedMutationAfterACreate()
    {
        CommentThreadFixtureOperation root = Create("comment.thread.root", "edited");
        CommentThreadFixtureOperation edit = new(
            "comment.version.edited",
            "edited",
            CommentThreadFixtureOperations.Edit,
            CommentAuthorModes.Public,
            11,
            "edited content");

        CommentThreadFixturePort.ValidatePlanForTests(Plan(root, edit));
    }

    private static CommentThreadFixtureOperation Create(
        string capabilityId,
        string role,
        string actorMode = CommentAuthorModes.Public,
        string? parentRole = null,
        long? parentCommentId = null)
        => new(
            capabilityId,
            role,
            CommentThreadFixtureOperations.Create,
            actorMode,
            actorMode == CommentAuthorModes.Public ? 11 : null,
            $"fixture {role}",
            parentRole,
            parentCommentId,
            null,
            null,
            actorMode == CommentAuthorModes.ZkAnonymous ? "comment:v1:article:42:top" : null,
            actorMode == CommentAuthorModes.ZkAnonymous ? "en" : null);

    private static CommentThreadFixturePlan Plan(params CommentThreadFixtureOperation[] operations)
        => new(
            "fsusblog.comment-thread-fixture-plan.v1",
            Binding(),
            operations);

    private static CommentFixturePortBinding Binding()
    {
        const string Digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        return new(
            "run-1",
            "namespace",
            "fx-0123456789abcdef01234567",
            "comment-fixture:namespace:run-1",
            "comments-moderation",
            ["comment.moderation-matrix", "comment.threaded", "moderation.policy-matrix"],
            42,
            Digest,
            [Digest, $"sha256:{new string('b', 64)}", $"sha256:{new string('c', 64)}"],
            Digest,
            Digest,
            Digest,
            Digest,
            Digest,
            Digest,
            Digest,
            Digest);
    }
}
