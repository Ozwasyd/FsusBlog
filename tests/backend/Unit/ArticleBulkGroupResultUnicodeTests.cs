using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkGroupResultUnicodeTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void BindingRejectsHashConsistentLossyFrozenStrings(int malformedKind)
    {
        // Construct in the method so attribute metadata cannot replace an unpaired surrogate.
        string malformed = malformedKind switch
        {
            0 => new string((char)0xd800, 1),
            1 => new string((char)0xdc00, 1),
            2 => "x" + (char)0xd800 + "y",
            _ => new string((char)0xd800, 2)
        };
        ArticleBulkPlanItem item = Item();
        ArticleBulkPlanItem[] variants =
        [
            item with { ArticleId = malformed },
            item with { ReasonCode = malformed },
            item with { ExpectedRevision = malformed },
            item with { Lifecycle = malformed },
            item with { PermissionDigest = malformed },
            item with { StateDigest = malformed },
            item with { DependencyDigests = [malformed] },
            item with { ProposedChangeDigest = malformed }
        ];
        foreach (ArticleBulkPlanItem variant in variants)
        {
            ArticleBulkOriginalGroupResult result = Result(Binding(variant));
            AssertLossy(() => ArticleBulkGroupResultStorageContract.ValidateResult(result));
        }
    }

    [Fact]
    public void BindingPreservesValidScalarPairsAndNullableFields()
    {
        ArticleBulkPlanItem item = Item() with
        {
            ArticleId = "article-\ud83d\ude80",
            ExpectedRevision = "revision-\ud83d\ude80",
            Lifecycle = null,
            PermissionDigest = null,
            StateDigest = null
        };
        ArticleBulkOriginalGroupResult result = Result(Binding(item));
        ArticleBulkGroupResultStorageContract.ValidateResult(result);
        Assert.Equal(item.ArticleId, Assert.Single(result.Binding.FrozenItems).ArticleId);
        Assert.Equal(item.ExpectedRevision, Assert.Single(result.Binding.FrozenItems).ExpectedRevision);
        Assert.Empty(result.ItemReceipts);
        Assert.Empty(result.Commands);
        Assert.Equal(ArticleBulkGroupCommitOutcome.UnknownRecovery, result.OriginalOutcome);
    }

    [Fact]
    public void ResultRejectsLossyCommandBeforeHashOrCoordinateAdmission()
    {
        ArticleBulkOriginalGroupResult result = Result(Binding(Item())) with
        {
            Commands = [new("article-1", Digest, Digest, "transition", new('a', 64),
                Guid.NewGuid().ToString(), "chain-\ud800", new('a', 64))]
        };
        result = result with
        {
            ContentDigest = ArticleBulkDigest.Of(result with
            {
                ContentDigest = string.Empty
            })
        };
        AssertLossy(() => ArticleBulkGroupResultStorageContract.ValidateResult(result));
    }

    [Fact]
    public void RecoveryRejectsLossyNullableMemberRevisionAndSideEffectText()
    {
        ArticleBulkOriginalGroupResult original = Result(Binding(Item()));
        var receipt = new ArticleBulkItemReceipt("attempt", Digest, Digest, "lifecycle.archive", "article-1",
            "revision-1", null, null, ArticleBulkPlanItemStatus.Eligible, ArticleBulkItemStatus.RecoveryRequired,
            "recovery", "owner", Digest, [], Digest, string.Empty);
        ArticleBulkItemReceipt[] variants =
        [
            receipt with { ObservedRevision = "observed-\udc00" },
            receipt with { NewRevision = "new-\ud800" },
            receipt with { ReasonCode = "reason-\ud800" },
            receipt with { CanonicalCommandOwner = "owner-\ud800" },
            receipt with { SideEffects = [new("effect-\ud800", Digest)] }
        ];
        foreach (ArticleBulkItemReceipt variant in variants)
        {
            ArticleBulkItemReceipt sealedItem = variant with
            {
                ContentDigest = ArticleBulkDigest.Of(variant)
            };
            var facts = new ArticleBulkGroupRecoveryObservationFacts(Digest, Digest,
                original.Binding.Request.FrozenSetDigest, ArticleBulkGroupCommitOutcome.UnknownRecovery,
                null, null, Digest, [sealedItem]);
            var observation = new ArticleBulkStoredRecoveryObservation(
                ArticleBulkGroupResultStorageContract.ObservationSchema, Guid.NewGuid(), 1,
                original.ContentDigest, original.ContentDigest, facts, DateTimeOffset.UnixEpoch, string.Empty);
            observation = observation with
            {
                ContentDigest = ArticleBulkDigest.Of(observation)
            };
            AssertLossy(() => ArticleBulkGroupResultStorageContract.ValidateObservation(original, observation));
        }
    }

    private static string Digest => ArticleBulkDigest.Of("unicode-source-control");

    private static ArticleBulkPlanItem Item()
        => new("article-1", ArticleBulkPlanItemStatus.Eligible, "eligible", "revision-1", "draft",
            Digest, Digest, [], Digest, string.Empty);

    private static ArticleBulkGroupResultBinding Binding(ArticleBulkPlanItem item)
    {
        item = item with
        {
            ContentDigest = ArticleBulkDigest.Of(item with
            {
                ContentDigest = string.Empty
            })
        };
        var request = new ArticleBulkExecutionRequest("attempt", "idempotency", "plan-reference", Digest, Digest,
            "lifecycle.archive", ArticleBulkExecutionStrategy.AllOrNothing, Digest,
            ArticleBulkDigest.Of(new[] { item.ArticleId }), Digest, Digest, new("actor", "site", Digest),
            new(new('a', 40), Digest), Digest, Digest, DateTimeOffset.UnixEpoch, Digest, string.Empty);
        request = request with
        {
            ContentDigest = ArticleBulkDigest.Of(request)
        };
        var binding = new ArticleBulkGroupResultBinding(Digest, request, [item], string.Empty);
        return binding with
        {
            ContentDigest = ArticleBulkDigest.Of(binding)
        };
    }

    private static ArticleBulkOriginalGroupResult Result(ArticleBulkGroupResultBinding binding)
    {
        var result = new ArticleBulkOriginalGroupResult(ArticleBulkGroupResultStorageContract.ResultSchema,
            binding, ArticleBulkGroupCommitOutcome.UnknownRecovery, null, null, [], [], DateTimeOffset.UnixEpoch, string.Empty);
        return result with
        {
            ContentDigest = ArticleBulkDigest.Of(result)
        };
    }

    private static void AssertLossy(Action action)
        => Assert.Equal("article-bulk.result-text-lossy", Assert.Throws<ArticleBulkContractException>(action).Code);
}
