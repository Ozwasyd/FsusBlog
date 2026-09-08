using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorArticlePinContractTests
{
    private static readonly AuthorArticlePinOwner s_owner = new(42, "primary-site");

    [Fact]
    public void ClosedSchema_UsesOnlyStableServerIdentitiesAndBoundedBudgets()
    {
        Assert.Equal(1, AuthorArticlePinContract.SchemaVersion);
        Assert.Equal(1_000, AuthorArticlePinContract.MaxPinsPerOwner);
        Assert.Equal(64, AuthorArticlePinContract.MaxReorderBatchSize);

        string[] forbiddenProperties = ["Title", "Slug", "Url", "SourceHash", "ArrayIndex", "DisplayLabel"];
        Type[] authorityTypes =
        [
            typeof(AuthorArticlePin),
            typeof(AuthorArticlePinOwner),
            typeof(AddAuthorArticlePinCommand),
            typeof(RemoveAuthorArticlePinCommand),
            typeof(ReorderAuthorArticlePinsCommand)
        ];
        Assert.All(authorityTypes, type => Assert.All(
            forbiddenProperties,
            property => Assert.Null(type.GetProperty(property))));

        Assert.Throws<AuthorArticlePinValidationException>(() => AuthorArticlePinContract.ValidateReorder([], null));
        Assert.Throws<AuthorArticlePinValidationException>(() => AuthorArticlePinContract.ValidateReorder(
            Enumerable.Range(1, AuthorArticlePinContract.MaxReorderBatchSize + 1).ToArray(),
            null));
        Assert.Throws<AuthorArticlePinValidationException>(() => AuthorArticlePinContract.ValidateReorder([1, 1], null));
        Assert.Throws<AuthorArticlePinValidationException>(() => AuthorArticlePinContract.ValidateReorder([1], 1));
    }

    [Fact]
    public void CanonicalDigests_BindOwnerIdentityOrderRevisionAndCommandPlan()
    {
        var pin = new AuthorArticlePin(
            Guid.Parse("01991f50-8850-7f63-82ab-8dbf846ef421"),
            17,
            AuthorArticlePinContract.OrderKeyGap,
            1,
            1,
            string.Empty);
        pin = pin with
        {
            ContentDigest = AuthorArticlePinContract.ComputePinDigest(
                s_owner,
                pin.PinId,
                pin.ArticleId,
                pin.OrderKey,
                pin.CreatedRevision,
                pin.UpdatedRevision)
        };

        string collection = AuthorArticlePinContract.ComputeCollectionDigest(s_owner, 1, [pin]);
        string repeated = AuthorArticlePinContract.ComputeCollectionDigest(s_owner, 1, [pin]);
        string moved = AuthorArticlePinContract.ComputeCollectionDigest(
            s_owner,
            2,
            [pin with { OrderKey = pin.OrderKey + 1 }]);
        string reorder = AuthorArticlePinContract.ComputeCommandDigest("reorder", s_owner, 1, [17], null);
        string reanchored = AuthorArticlePinContract.ComputeCommandDigest("reorder", s_owner, 1, [17], 18);

        Assert.Equal(64, collection.Length);
        Assert.Equal(collection, repeated);
        Assert.NotEqual(collection, moved);
        Assert.NotEqual(reorder, reanchored);
        Assert.NotEqual(
            collection,
            AuthorArticlePinContract.ComputeCollectionDigest(new AuthorArticlePinOwner(43, "primary-site"), 1, [pin]));
    }

    [Fact]
    public void ReorderCommand_DefensivelyCopiesCallerArray()
    {
        int[] caller = [1, 2];
        var command = new ReorderAuthorArticlePinsCommand(s_owner, 3, Guid.CreateVersion7(), caller, null);

        caller[0] = 99;

        Assert.Equal([1, 2], command.MovedArticleIds);
    }
}
