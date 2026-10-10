using System.Collections;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only plans, clocks, content facts, normalized comments, role
/// rosters and IDs exercise the actual original factory/native/outbox composition.
/// They are not allocation, credential, privacy, physical-graph, database, delivery
/// or canonical admission evidence. Original GUIDs and NextAttemptAt defaults
/// remain unqualified; a yielded prefix is not successful complete enumeration.
/// </summary>
public sealed class CommentScaleInitialOutboxGraphAdapterTests
{
    private const string UnitDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly DateTime s_time = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ResolveStream_PreservesOriginalOccurrenceAndCommentOrderIncludingZeroCommentMarkers()
    {
        Fixture f = Create();
        CommentScaleInitialOutboxGraphGroup[] groups = Resolve(f).ToArray();

        Assert.Equal(6, groups.Length);
        Assert.Equal(new[] { "root", "child", "root", "child", null, null }, groups.Select(group => group.Coordinate?.CommentRole));
        Assert.Equal(new[] { "thread", "thread", "thread", "thread", "empty", "empty" }, groups.Select(group => group.Intent.Occurrence.ScenarioRole));
        Assert.Equal(new long[] { 0, 0, 1, 1, 0, 1 }, groups.Select(group => group.Intent.Occurrence.Repetition));
        Assert.Equal(new[] { 42, 42, 77, 77, 88, 99 }, groups.Select(group => group.Intent.ArticleId));
        Assert.All(groups.Take(4), group =>
        {
            Assert.NotNull(group.Coordinate);
            Assert.Equal(group.Intent.Occurrence, group.Coordinate.Occurrence);
            Assert.Equal(new[] { CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged }, group.Events.Select(item => item.EventType));
        });
        Assert.All(groups.Skip(4), group =>
        {
            Assert.Null(group.Coordinate);
            Assert.Empty(group.Intent.Comments);
            Assert.Empty(group.Events);
            Assert.Equal(f.Plan.ContentDigest, group.Intent.CommentPlanDigest);
        });
        Assert.Same(groups[0].Intent, groups[1].Intent);
        Assert.NotSame(groups[1].Intent, groups[2].Intent);
    }

    [Theory]
    [InlineData(CommentModerationStatus.Pending, null, false)]
    [InlineData(CommentModerationStatus.Pending, 0, false)]
    [InlineData(CommentModerationStatus.Pending, -1, false)]
    [InlineData(CommentModerationStatus.Pending, 8, false)]
    [InlineData(CommentModerationStatus.Approved, null, false)]
    [InlineData(CommentModerationStatus.Approved, 0, false)]
    [InlineData(CommentModerationStatus.Approved, -1, false)]
    [InlineData(CommentModerationStatus.Approved, 8, true)]
    [InlineData(CommentModerationStatus.Rejected, null, false)]
    [InlineData(CommentModerationStatus.Rejected, 0, false)]
    [InlineData(CommentModerationStatus.Rejected, -1, false)]
    [InlineData(CommentModerationStatus.Rejected, 8, false)]
    [InlineData(CommentModerationStatus.Hidden, null, false)]
    [InlineData(CommentModerationStatus.Hidden, 0, false)]
    [InlineData(CommentModerationStatus.Hidden, -1, false)]
    [InlineData(CommentModerationStatus.Hidden, 8, false)]
    public void ResolveStream_RetainsOriginalStatusRecipientEventSelectionAndOrder(CommentModerationStatus status, int? recipient, bool hasReply)
    {
        Fixture f = Create();
        Comment comment = f.Outbox[0].Comments[1].NormalizedComment;
        comment.ModerationStatus = status;
        comment.ReplyToUserId = recipient;
        string before = JsonSerializer.Serialize(comment);
        CommentScaleInitialOutboxGraphGroup child = Resolve(f).ElementAt(1);

        string[] expected = hasReply
            ? [CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged, CommentMutationEventTypes.ReplyNotificationRequested]
            : [CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged];
        Assert.Equal(expected, child.Events.Select(item => item.EventType));
        Assert.All(child.Events, item =>
        {
            Assert.Equal(status, item.NextStatus);
            Assert.Equal(recipient, item.ReplyToAccountId);
            Assert.Null(item.PreviousStatus);
            Assert.Equal(s_time.AddMilliseconds(1), item.OccurredAtUtc);
            Assert.Equal(950003, item.CommentId);
            Assert.Equal(910003, item.ParentId);
            Assert.Equal(910007, item.RootId);
            Assert.Equal(7, item.AccountId);
            Assert.Equal(42, item.ArticleId);
        });
        Assert.Equal(before, JsonSerializer.Serialize(comment));
    }

    [Fact]
    public void ResolveStream_PreservesObservedAnonymousPrivacyThreadAndPremoderatedFacts()
    {
        Fixture f = Create(anonymous: true);
        Comment comment = f.Outbox[0].Comments[1].NormalizedComment;
        comment.ModerationReason = "article_policy_premoderated";
        comment.AnonymousHandle = "synthetic-unit-handle";
        comment.AnonymousNullifierHash = "synthetic-unit-only-unverified-nullifier";
        comment.AnonymousScope = "synthetic-unit-only-scope";
        comment.ManagementCapabilityHash = "synthetic-unit-only-unverified-capability";
        comment.Content = "synthetic private normalized content";
        string before = JsonSerializer.Serialize(comment);

        CommentScaleInitialOutboxGraphGroup child = Resolve(f).ElementAt(1);

        Assert.Equal(CommentScaleCredentialValidity.ScaleSyntheticTestOnly, child.Intent.Comments[1].Policies.CredentialValidity);
        Assert.All(child.Events, item =>
        {
            Assert.Null(item.AccountId);
            Assert.Null(item.ReplyToAccountId);
            Assert.Equal(910003, item.ParentId);
            Assert.Equal(910007, item.RootId);
            Assert.Equal(CommentModerationStatus.Pending, item.NextStatus);
        });
        Assert.Equal("article_policy_premoderated", comment.ModerationReason);
        Assert.Equal(before, JsonSerializer.Serialize(comment));
        // Fields not present in the original envelope stay only on supplied comments.
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("reordered")]
    [InlineData("crossed-target")]
    [InlineData("null-occurrence")]
    public void ResolveStream_RefusesMissingExtraReorderedOrCrossedOutboxOccurrences(string change)
    {
        Fixture f = Create();
        CommentScaleInitialOutboxOccurrenceFacts[] outbox = change switch
        {
            "missing" => f.Outbox.Take(3).ToArray(),
            "extra" => [.. f.Outbox, f.Outbox[0]],
            "reordered" => [f.Outbox[1], f.Outbox[0], .. f.Outbox.Skip(2)],
            "crossed-target" => [f.Outbox[0] with { Occurrence = f.Outbox[0].Occurrence with { ArticleTargetRole = "crossed" } }, .. f.Outbox.Skip(1)],
            "null-occurrence" => [f.Outbox[0] with { Occurrence = null! }, .. f.Outbox.Skip(1)],
            _ => throw new InvalidOperationException(change)
        };
        Assert.Throws<InvalidOperationException>(() => Resolve(f with { Outbox = outbox }).ToArray());
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("reordered")]
    [InlineData("crossed-comment")]
    [InlineData("crossed-article")]
    [InlineData("missing-time")]
    [InlineData("missing-entity")]
    [InlineData("null-comment")]
    [InlineData("null-normalized")]
    [InlineData("null-list")]
    public void ResolveStream_RefusesIncompleteOrCrossedPerOccurrenceCommentFacts(string change)
    {
        Fixture f = Create();
        CommentScaleInitialOutboxRequestFact[] comments = f.Outbox[0].Comments.ToArray();
        IReadOnlyList<CommentScaleInitialOutboxRequestFact> changed = change switch
        {
            "missing" => [comments[0]],
            "extra" => [.. comments, comments[0]],
            "reordered" => comments.Reverse().ToArray(),
            "crossed-comment" => [comments[0] with { CommentRole = "crossed" }, comments[1]],
            "missing-time" => [comments[0] with { OccurredAtRole = "missing" }, comments[1]],
            "missing-entity" => [comments[0] with { EntityRole = "missing" }, comments[1]],
            "null-comment" => [null!, comments[1]],
            "null-normalized" => [comments[0] with { NormalizedComment = null! }, comments[1]],
            "null-list" => null!,
            _ => comments
        };
        if (change == "crossed-article")
        {
            comments[0].NormalizedComment.ArticleId = 99;
        }
        f.Outbox[0] = f.Outbox[0] with
        {
            Comments = changed
        };
        if (change == "null-normalized")
        {
            Assert.Throws<ArgumentNullException>(() => Resolve(f).ToArray());
        }
        else
        {
            Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        }
    }

    [Theory]
    [InlineData("graph-missing")]
    [InlineData("graph-extra")]
    [InlineData("graph-reordered")]
    [InlineData("graph-comment-reordered")]
    public void ResolveStream_KeepsOriginalFactoryIngressRefusals(string change)
    {
        Fixture f = Create();
        CommentScaleGraphFactBindings[] frames = change switch
        {
            "graph-missing" => f.Frames.Take(3).ToArray(),
            "graph-extra" => [.. f.Frames, f.Frames[0]],
            "graph-reordered" => [f.Frames[1], f.Frames[0], .. f.Frames.Skip(2)],
            "graph-comment-reordered" => [f.Frames[0] with { Comments = f.Frames[0].Comments.Reverse().ToArray() }, .. f.Frames.Skip(1)],
            _ => throw new InvalidOperationException(change)
        };
        Assert.Throws<InvalidOperationException>(() => Resolve(f with { Frames = frames }).ToArray());
    }

    [Theory]
    [InlineData("author")]
    [InlineData("region")]
    public void ResolveStream_OriginalPolicyRefusalCannotBecomeAnOutboxGroup(string change)
    {
        Fixture f = Create();
        CommentScaleRequestFactBinding request = f.Frames[0].Comments[0];
        CommentScalePolicyFacts facts = change == "author"
            ? request.PolicyFacts with
            {
                PublicSendExplicitlySelected = false
            }
            : request.PolicyFacts with
            {
                Region = request.PolicyFacts.Region with
                {
                    CanPublish = false
                }
            };
        f.Frames[0] = f.Frames[0] with
        {
            Comments = [request with { PolicyFacts = facts }, f.Frames[0].Comments[1]]
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        Assert.Equal("comment_native_binding_known_policy_refusal", error.Message);
    }

    [Theory]
    [InlineData("scope")]
    [InlineData("coverage")]
    [InlineData("reference")]
    public void ResolveStream_ValidatesZeroCommentOriginalNativeBindingsWithoutInventingAnId(string change)
    {
        Fixture f = Create();
        CommentScaleInitialOutboxOccurrenceFacts zero = f.Outbox[2];
        Assert.Empty(zero.Identities.Ids);
        CommentScaleNativeBindingExpectation expected = zero.Expectations;
        DataScaleNativeCommentBindings map = zero.Identities;
        if (change == "scope")
        {
            map = new(map.RunId, "crossed", map.RuntimeIdentity, map.Provider, map.CommentPlanDigest, map.ArticlePlanDigest, map.Allocation, map.Ids);
            expected = expected with
            {
                BindingReference = new(DataScaleNativeCommentBindings.Schema, map.Digest)
            };
        }
        if (change == "coverage")
        {
            expected = expected with
            {
                FactoryRoles = [new("empty", 0, "article.empty", "unplanned", DataScaleNativeCommentEntity.Comment, "unit-only")]
            };
        }
        if (change == "reference")
        {
            expected = expected with
            {
                BindingReference = expected.BindingReference with
                {
                    Schema = "unowned.v1"
                }
            };
        }
        f.Outbox[2] = zero with
        {
            Identities = map,
            Expectations = expected
        };
        Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(256)]
    public void ResolveBatches_PreservesWholeCommentEventGroupsAndReadonlyRosters(int size)
    {
        Fixture f = Create();
        f.Outbox[0].Comments[1].NormalizedComment.ModerationStatus = CommentModerationStatus.Approved;
        f.Outbox[0].Comments[1].NormalizedComment.ReplyToUserId = 8;
        IReadOnlyList<CommentScaleInitialOutboxGraphGroup>[] batches = CommentScaleInitialOutboxGraphAdapter.ResolveBatches(
            f.Plan, f.Temporal, f.Frames, f.Outbox, size).ToArray();
        Assert.Equal(6, batches.Sum(batch => batch.Count));
        Assert.All(batches, batch =>
        {
            Assert.InRange(batch.Count, 1, size);
            Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleInitialOutboxGraphGroup>)batch).Clear());
        });
        CommentScaleInitialOutboxGraphGroup[] groups = batches.SelectMany(batch => batch).ToArray();
        Assert.Equal(new[] { "root", "child", "root", "child", null, null }, groups.Select(group => group.Coordinate?.CommentRole));
        Assert.Equal(3, groups[1].Events.Count);
        Assert.All(groups, group => Assert.Throws<NotSupportedException>(() => ((IList<CommentMutationOutboxEvent>)group.Events).Clear()));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(257)]
    public void ResolveBatches_UsesTheExistingCanonicalGroupBound(int size)
    {
        Fixture f = Create();
        Assert.Throws<ArgumentOutOfRangeException>(() => CommentScaleInitialOutboxGraphAdapter.ResolveBatches(
            f.Plan, f.Temporal, f.Frames, f.Outbox, size).ToArray());
    }

    [Fact]
    public void ResolveBatches_DoesNotConsumeTheNextOccurrenceToReturnACompleteCurrentBatch()
    {
        Fixture f = Create();
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>(f.Frames);
        var outbox = new TrackedInput<CommentScaleInitialOutboxOccurrenceFacts>(f.Outbox);
        using IEnumerator<IReadOnlyList<CommentScaleInitialOutboxGraphGroup>> reader = CommentScaleInitialOutboxGraphAdapter.ResolveBatches(
            f.Plan, f.Temporal, graphs, outbox, 2).GetEnumerator();
        Assert.True(reader.MoveNext());
        Assert.Equal(new[] { "root", "child" }, reader.Current.Select(group => group.Coordinate?.CommentRole));
        Assert.Equal(1, graphs.MoveNextCalls);
        Assert.Equal(1, outbox.MoveNextCalls);
    }

    [Fact]
    public void ResolveStream_OriginalWholePlanInspectionFailureReadsNeitherFactStream()
    {
        Fixture f = Create();
        CommentScalePlan invalid = f.Plan with
        {
            GraphSchema = "unowned.v1"
        };
        invalid = invalid with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(invalid)
        };
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>(f.Frames);
        var outbox = new TrackedInput<CommentScaleInitialOutboxOccurrenceFacts>(f.Outbox);
        Assert.Throws<InvalidOperationException>(() => CommentScaleInitialOutboxGraphAdapter.ResolveStream(invalid, f.Temporal, graphs, outbox).ToArray());
        Assert.Equal(0, graphs.MoveNextCalls);
        Assert.Equal(0, outbox.MoveNextCalls);
    }

    [Theory]
    [InlineData("observation")]
    [InlineData("map")]
    [InlineData("expectations")]
    [InlineData("roster")]
    [InlineData("allocation")]
    [InlineData("reference")]
    public void ResolveStream_RejectsMissingRequiredOutboxOccurrenceHeaders(string member)
    {
        Fixture f = Create();
        CommentScaleInitialOutboxOccurrenceFacts observed = f.Outbox[0];
        f.Outbox[0] = member switch
        {
            "observation" => null!,
            "map" => observed with { Identities = null! },
            "expectations" => observed with { Expectations = null! },
            "roster" => observed with { Expectations = observed.Expectations with { FactoryRoles = null! } },
            "allocation" => observed with { Expectations = observed.Expectations with { Allocation = null! } },
            "reference" => observed with { Expectations = observed.Expectations with { BindingReference = null! } },
            _ => throw new InvalidOperationException(member)
        };
        if (member == "observation")
        {
            Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        }
        else
        {
            Assert.Throws<ArgumentNullException>(() => Resolve(f).ToArray());
        }
    }

    [Fact]
    public void ResolveStream_IsLazyAtOccurrenceBoundariesAndDisposesBothInputsOnEarlyStop()
    {
        Fixture f = Create();
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>(f.Frames);
        var outbox = new TrackedInput<CommentScaleInitialOutboxOccurrenceFacts>(f.Outbox);
        IEnumerable<CommentScaleInitialOutboxGraphGroup> stream = CommentScaleInitialOutboxGraphAdapter.ResolveStream(f.Plan, f.Temporal, graphs, outbox);
        Assert.Equal(0, graphs.MoveNextCalls);
        Assert.Equal(0, outbox.MoveNextCalls);
        using (IEnumerator<CommentScaleInitialOutboxGraphGroup> reader = stream.GetEnumerator())
        {
            Assert.True(reader.MoveNext());
            Assert.Equal("root", reader.Current.Coordinate?.CommentRole);
            Assert.Equal(1, graphs.MoveNextCalls);
            Assert.Equal(1, outbox.MoveNextCalls);
            Assert.True(reader.MoveNext());
            Assert.Equal("child", reader.Current.Coordinate?.CommentRole);
            Assert.Equal(1, graphs.MoveNextCalls);
            Assert.Equal(1, outbox.MoveNextCalls);
        }
        Assert.Equal(1, graphs.DisposeCalls);
        Assert.Equal(1, outbox.DisposeCalls);
    }

    [Theory]
    [InlineData("graph")]
    [InlineData("outbox")]
    public void ResolveStream_MidstreamOriginalInputFailurePreservesOnlyTheYieldedPrefixAndDisposes(string input)
    {
        Fixture f = Create();
        var error = new InvalidOperationException("synthetic-unit-input-failure");
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>(f.Frames, input == "graph" ? 1 : -1, error);
        var outbox = new TrackedInput<CommentScaleInitialOutboxOccurrenceFacts>(f.Outbox, input == "outbox" ? 1 : -1, error);
        var prefix = new List<CommentScaleInitialOutboxGraphGroup>();
        InvalidOperationException actual = Assert.Throws<InvalidOperationException>(() =>
        {
            foreach (CommentScaleInitialOutboxGraphGroup group in CommentScaleInitialOutboxGraphAdapter.ResolveStream(f.Plan, f.Temporal, graphs, outbox))
            {
                prefix.Add(group);
            }
        });
        Assert.Same(error, actual);
        Assert.Equal(new[] { "root", "child" }, prefix.Select(group => group.Coordinate?.CommentRole));
        Assert.Equal(1, graphs.DisposeCalls);
        Assert.Equal(1, outbox.DisposeCalls);
    }

    [Fact]
    public void ResolveStream_OriginalPlanSnapshotSurvivesCallerListMutationAfterFirstYield()
    {
        Fixture f = Create();
        var scenarios = f.Plan.Scenarios.ToList();
        CommentScalePlan plan = f.Plan with
        {
            Scenarios = scenarios
        };
        using IEnumerator<CommentScaleInitialOutboxGraphGroup> reader = CommentScaleInitialOutboxGraphAdapter.ResolveStream(plan, f.Temporal, f.Frames, f.Outbox).GetEnumerator();
        Assert.True(reader.MoveNext());
        scenarios.Clear();
        var groups = new List<CommentScaleInitialOutboxGraphGroup> { reader.Current };
        while (reader.MoveNext())
        {
            groups.Add(reader.Current);
        }
        Assert.Equal(6, groups.Count);
        Assert.Equal(f.Plan.ContentDigest, groups[^1].Intent.CommentPlanDigest);
    }

    [Fact]
    public void ResolveStream_FreezesCurrentOccurrenceRequestAndExpectedRosterContainersOnly()
    {
        Fixture f = Create();
        var comments = f.Outbox[0].Comments.ToList();
        var roster = f.Outbox[0].Expectations.FactoryRoles.ToList();
        f.Outbox[0] = f.Outbox[0] with
        {
            Comments = comments,
            Expectations = f.Outbox[0].Expectations with
            {
                FactoryRoles = roster
            }
        };
        using IEnumerator<CommentScaleInitialOutboxGraphGroup> reader = Resolve(f).GetEnumerator();
        Assert.True(reader.MoveNext());
        comments.Clear();
        roster.Clear();
        Assert.True(reader.MoveNext());
        Assert.Equal("child", reader.Current.Coordinate?.CommentRole);
        Assert.Equal(950003, reader.Current.Events[0].CommentId);
        Assert.Equal(2, reader.Current.Events.Count);
    }

    [Fact]
    public void ResolveStream_RetainsOriginalMutableNormalizedEntitiesRatherThanClaimingFactSnapshotPurity()
    {
        Fixture f = Create();
        Comment child = f.Outbox[0].Comments[1].NormalizedComment;
        using IEnumerator<CommentScaleInitialOutboxGraphGroup> reader = Resolve(f).GetEnumerator();
        Assert.True(reader.MoveNext());
        child.ModerationStatus = CommentModerationStatus.Approved;
        child.ReplyToUserId = 8;
        Assert.True(reader.MoveNext());
        Assert.Equal("child", reader.Current.Coordinate?.CommentRole);
        Assert.Equal(new[] { CommentMutationEventTypes.Created, CommentMutationEventTypes.VisibilityChanged,
            CommentMutationEventTypes.ReplyNotificationRequested }, reader.Current.Events.Select(item => item.EventType));
        Assert.All(reader.Current.Events, item => Assert.Equal(CommentModerationStatus.Approved, item.NextStatus));
    }

    [Fact]
    public void ResolveStream_FullOccurrenceRolePreflightRejectsAnInvalidFinalRoleBeforeTheFirstGroup()
    {
        Fixture f = Create();
        f.Outbox[0] = f.Outbox[0] with
        {
            Comments = [f.Outbox[0].Comments[0], f.Outbox[0].Comments[1] with { CommentRole = "crossed" }]
        };
        using IEnumerator<CommentScaleInitialOutboxGraphGroup> reader = Resolve(f).GetEnumerator();
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => reader.MoveNext());
        Assert.Equal("comment_initial_outbox_comment_roster_mismatch", error.Message);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(3)]
    public void ResolveStream_RejectsReportedCountWhichDisagreesWithTheActualRequestEnumeration(int actualCount)
    {
        Fixture f = Create();
        CommentScaleInitialOutboxRequestFact[] original = f.Outbox[0].Comments.ToArray();
        CommentScaleInitialOutboxRequestFact[] actual = actualCount == 3
            ? [.. original, original[0]] : original.Take(actualCount).ToArray();
        var mismatched = new MisreportedList<CommentScaleInitialOutboxRequestFact>(2, actual);
        Assert.Equal(2, mismatched.Count);
        Assert.Equal(actualCount, mismatched.ToArray().Length);
        f.Outbox[0] = f.Outbox[0] with
        {
            Comments = mismatched
        };
        using IEnumerator<CommentScaleInitialOutboxGraphGroup> reader = Resolve(f).GetEnumerator();
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => reader.MoveNext());
        Assert.Equal("comment_initial_outbox_occurrence_or_roster_mismatch", error.Message);
        // A shortened enumeration must not yield a zero-comment marker or prefix.
    }

    [Fact]
    public void ResolveStream_LaterCommentBindingFailureDoesNotPromoteTheEarlierCompleteGroupToGraphSuccess()
    {
        Fixture f = Create();
        f.Outbox[0].Comments[1].NormalizedComment.ArticleId = 99;
        using IEnumerator<CommentScaleInitialOutboxGraphGroup> reader = Resolve(f).GetEnumerator();
        Assert.True(reader.MoveNext());
        CommentScaleInitialOutboxGraphGroup prefix = reader.Current;
        Assert.Equal("root", prefix.Coordinate?.CommentRole);
        Assert.Equal(2, prefix.Events.Count);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => reader.MoveNext());
        Assert.Equal("comment_native_binding_plan_or_article_mismatch", error.Message);
        Assert.Equal(2, prefix.Events.Count);
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("temporal")]
    [InlineData("graphs")]
    [InlineData("outbox")]
    public void ResolveStream_RejectsNullRequiredStreamsAndContext(string member)
    {
        Fixture f = Create();
        Assert.Throws<ArgumentNullException>(() => CommentScaleInitialOutboxGraphAdapter.ResolveStream(
            member == "plan" ? null! : f.Plan, member == "temporal" ? null! : f.Temporal,
            member == "graphs" ? null! : f.Frames, member == "outbox" ? null! : f.Outbox).ToArray());
    }

    [Fact]
    public void ResolveStream_ReturnsReadonlyEventRostersContainingOriginalMutableUnpersistedEntities()
    {
        Fixture f = Create();
        CommentScaleInitialOutboxGraphGroup group = Resolve(f).First();
        Assert.Throws<NotSupportedException>(() => ((IList<CommentMutationOutboxEvent>)group.Events).Clear());
        group.Events[0].LastError = "synthetic-unit-mutation";
        Assert.Equal("synthetic-unit-mutation", group.Events[0].LastError);
        Assert.All(group.Events, item =>
        {
            Assert.Equal(0, item.Id);
            Assert.Equal(CommentMutationOutboxStatus.Pending, item.Status);
            Assert.True(Guid.TryParseExact(item.EventId, "D", out _));
        });
        // No equality/normalization of GUID or NextAttemptAt clock defaults.
    }

    [Fact]
    public void ResolveStream_EmptyOriginalPlanRequiresBothInputStreamsToBeEmpty()
    {
        Fixture f = Create();
        CommentScalePlan plan = f.Plan with
        {
            CommentCount = 0,
            ArticleCount = 0,
            Scenarios = []
        };
        plan = plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };
        Assert.Empty(CommentScaleInitialOutboxGraphAdapter.ResolveStream(plan, f.Temporal, [], []));
        Assert.Throws<InvalidOperationException>(() => CommentScaleInitialOutboxGraphAdapter.ResolveStream(plan, f.Temporal, [], [f.Outbox[0]]).ToArray());
        Assert.Throws<InvalidOperationException>(() => CommentScaleInitialOutboxGraphAdapter.ResolveStream(plan, f.Temporal, [f.Frames[0]], []).ToArray());
    }

    private static IEnumerable<CommentScaleInitialOutboxGraphGroup> Resolve(Fixture f)
        => CommentScaleInitialOutboxGraphAdapter.ResolveStream(f.Plan, f.Temporal, f.Frames, f.Outbox);

    private sealed record Fixture(CommentScalePlan Plan, ResolvedTemporalRoleContext Temporal,
        CommentScaleGraphFactBindings[] Frames, CommentScaleInitialOutboxOccurrenceFacts[] Outbox);

    private static Fixture Create(bool anonymous = false)
    {
        string mode = anonymous ? CommentAuthorModes.ZkAnonymous : CommentAuthorModes.Public;
        CommentScaleCredentialValidity credential = anonymous ? CommentScaleCredentialValidity.ScaleSyntheticTestOnly : CommentScaleCredentialValidity.PublicAuthenticated;
        CommentScaleCommentRequest Request(string role, string? parent)
            => new(role, parent, parent, mode, credential, UnitDigest, "content." + role,
                new("fsusblog.generated-content-shape.v1", UnitDigest), UnitDigest, "created",
                [new(null, CommentModerationStatus.Pending, "reason.initial", "created")]);
        CommentScaleCommentRequest[] comments = [Request("root", null), Request("child", "root")];
        var requirements = new CommentScaleGraphRequirements(Enum.GetValues<CommentScaleRelation>(),
            Enum.GetValues<CommentScaleAuthority>().Select(authority => new CommentScaleAuthorityReference(authority, new string('a', 40), UnitDigest)).ToArray());
        CommentScalePlan plan = new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema, "unit-outbox-graph", "unit-tier", 4, 4,
            new(ArticleScaleContractIds.PlanSchema, UnitDigest), new(ArticleScaleContractIds.ContentShapeCatalogSchema, UnitDigest),
            new(ArticleScaleContractIds.TemporalArtifactSchema, UnitDigest),
            [new("thread", CommentScaleThreadShape.DeepChain, "article.thread", 2, comments, requirements),
             new("empty", CommentScaleThreadShape.ZeroCommentArticle, "article.empty", 2, [], requirements)], string.Empty);
        plan = plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };
        var frames = new List<CommentScaleGraphFactBindings>();
        var outbox = new List<CommentScaleInitialOutboxOccurrenceFacts>();
        int[] articleIds = [42, 77, 88, 99];
        long[][] nativeIds = [[950001, 950003], [970007, 970011]];
        int index = 0;
        foreach (CommentScaleScenario scenario in plan.Scenarios)
        {
            for (long repetition = 0; repetition < scenario.Repetitions; repetition++)
            {
                int articleId = articleIds[index++];
                var occurrence = new CommentScaleGraphOccurrence(scenario.Role, repetition, scenario.ArticleTargetRole);
                frames.Add(new(occurrence, plan.Namespace, plan.ContentDigest, plan.ArticlePlan.ContentDigest,
                    "synthetic-original-article-role-" + articleId, articleId, new(ArticleScaleGraphIdentityBindings.Schema, UnitDigest),
                    scenario.Comments.Select(request => new CommentScaleRequestFactBinding(request.Role, request.ContentRole,
                        request.ContentArtifact, PolicyFacts(request, articleId, anonymous))).ToArray()));
                var ids = new Dictionary<DataScaleNativeCommentRole, long>();
                var requests = new List<CommentScaleInitialOutboxRequestFact>();
                for (int position = 0; position < scenario.Comments.Count; position++)
                {
                    CommentScaleCommentRequest request = scenario.Comments[position];
                    string entityRole = "initial." + request.Role;
                    // Explicit synthetic unit IDs, not native allocator evidence.
                    long id = nativeIds[index - 1][position];
                    ids.Add(new(scenario.Role, repetition, scenario.ArticleTargetRole, request.Role, DataScaleNativeCommentEntity.Comment, entityRole), id);
                    requests.Add(new(request.Role, entityRole, new Comment
                    {
                        Id = 123,
                        ArticleId = articleId,
                        Content = "synthetic normalized unit comment",
                        CreateTime = s_time,
                        AuthorMode = mode,
                        UserId = anonymous ? null : 7,
                        ParentId = position == 0 ? null : 910003,
                        RootId = position == 0 ? null : 910007,
                        ReplyToUserId = null,
                        ModerationStatus = CommentModerationStatus.Pending,
                        ModerationReason = "article_policy_premoderated"
                    }, "outbox"));
                }
                var allocation = new DataScaleNativeAllocationReference("synthetic-unit-only-owner", new string('a', 40), UnitDigest);
                var map = new DataScaleNativeCommentBindings("unit-run", plan.Namespace, "unit-runtime", "PostgreSql", plan.ContentDigest,
                    plan.ArticlePlan.ContentDigest, allocation, ids);
                var expected = new CommentScaleNativeBindingExpectation(map.RunId, map.RuntimeIdentity, map.Provider, allocation,
                    new(DataScaleNativeCommentBindings.Schema, map.Digest), ids.Keys.ToArray());
                outbox.Add(new(occurrence, map, expected, requests.ToArray()));
            }
        }
        return new(plan, Temporal(), frames.ToArray(), outbox.ToArray());
    }

    private static CommentScalePolicyFacts PolicyFacts(CommentScaleCommentRequest request, int articleId, bool anonymous)
    {
        var site = new AnonymousCommentPolicySnapshot(true, true, true, CommentAuthorModes.ZkAnonymous, ["en"])
        {
            UpdatedAtUtc = s_time,
            SnapshotHash = UnitDigest
        };
        var article = new ArticleCommentPolicy
        {
            ArticleId = articleId,
            UpdatedAtUtc = s_time,
            PolicyVersion = 2,
            ModerationMode = ArticleCommentModerationModes.RiskBased
        };
        var actor = new CommentActor(anonymous ? null : 7, request.ActorMode, anonymous ? null : "unit-handle", null,
            "unit-handle", "en", null, null, "unit-subject", "common", false);
        var region = new RegionModerationDecision(true, "GLOBAL", 1d, "synthetic-unit-only", null, [], [], [],
            "synthetic-unit-policy", "unit-reason", "unit-reason", false, false);
        long? rootId = request.ParentRole is null ? null : 910007;
        return new(articleId, rootId, site, article,
            rootId is null ? null : new CommentThreadPolicy { ArticleId = articleId, RootCommentId = rootId.Value, PolicyVersion = 3 },
            actor, UnitDigest, region, UnitDigest, true, false, false, request.ParentRole is null ? null : 8);
    }

    private static ResolvedTemporalRoleContext Temporal()
        => ResolvedTemporalRoleContext.Parse(JsonSerializer.Serialize(new
        {
            schema = "fsusblog.resolved-temporal-roles.v1",
            contextIdentity = new
            {
                producerId = "synthetic-unit-only",
                schedulerRunId = "synthetic-unit-only"
            },
            contentDigest = UnitDigest,
            roles = new[] { "created", "outbox" }.Select((role, index) => new
            {
                roleId = role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = s_time.AddMilliseconds(index).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture)
            })
        }), UnitDigest);

    private sealed class MisreportedList<T>(int reportedCount, IReadOnlyList<T> actual) : IReadOnlyList<T>
    {
        public int Count => reportedCount;
        public T this[int index] => actual[index];
        public IEnumerator<T> GetEnumerator() => actual.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class TrackedInput<T>(IReadOnlyList<T> values, int throwAt = -1, Exception? error = null) : IEnumerable<T>
    {
        public int MoveNextCalls
        {
            get; private set;
        }
        public int DisposeCalls
        {
            get; private set;
        }
        public IEnumerator<T> GetEnumerator() => Enumerate().GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        private IEnumerable<T> Enumerate()
        {
            try
            {
                for (int index = 0; index < values.Count; index++)
                {
                    MoveNextCalls++;
                    if (index == throwAt)
                    {
                        throw error!;
                    }
                    yield return values[index];
                }
                MoveNextCalls++;
            }
            finally
            {
                DisposeCalls++;
            }
        }
    }
}
