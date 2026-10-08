using System.Collections;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only temporal envelopes, IDs and minimal transport records test
/// the actual original revision constructor and structural pairing. Minimal intent
/// records are not admitted factory output, authenticated actors, normalized-content
/// proof, complete history, allocated revision IDs, persistence or graph receipts.
/// Independent fixed UTF-8 hash goldens do not call a second expected builder.
/// </summary>
public sealed class CommentScaleRevisionGraphAdapterTests
{
    private const string UnitDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly DateTime s_time = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")]
    [InlineData("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")]
    [InlineData("  原始\r\n内容🙂  ", "f0b149f0bb3a08e498a1dda72a0b11f14150a111abd0b03fbebeca04c30c44e4")]
    public void ResolveRevision_UsesIndependentUtf8HashGoldensWithoutNormalizingSuppliedContent(string content, string hash)
    {
        CommentScaleRevisionFacts facts = Facts() with
        {
            NormalizedContent = content
        };
        CommentRevision revision = CanonicalCommentGraphFactory.ResolveRevision(facts, Temporal());

        Assert.Equal(content, revision.Content);
        Assert.Equal(hash, revision.ContentSha256);
        Assert.Equal(64, revision.ContentSha256.Length);
        Assert.Equal(0, revision.Id);
    }

    [Theory]
    [InlineData(CommentRevisionOperations.Created, 1)]
    [InlineData(CommentRevisionOperations.Edited, 7)]
    [InlineData(CommentRevisionOperations.Deleted, 11)]
    public void ResolveRevision_PreservesAllEightOriginalConstructorFactsAndLeavesNativeRevisionIdUnassigned(string operation, int version)
    {
        CommentScaleRevisionFacts facts = Facts() with
        {
            Operation = operation,
            Version = version,
            ActorMode = "synthetic-observed-actor-mode",
            ActorAccountId = -7,
            ActorAdminPrincipalId = 900009
        };
        string before = JsonSerializer.Serialize(facts);

        CommentRevision revision = CanonicalCommentGraphFactory.ResolveRevision(facts, Temporal());

        Assert.Equal(950001, revision.CommentId);
        Assert.Equal(version, revision.Version);
        Assert.Equal(operation, revision.Operation);
        Assert.Equal("synthetic unit normalized content", revision.Content);
        Assert.Equal("5db02306632b27f78a4231373196f7922e569990b2d3a7e6161c10c96dfac180", revision.ContentSha256);
        Assert.Equal(s_time.AddMilliseconds(1), revision.CreatedAtUtc);
        Assert.Equal(DateTimeKind.Utc, revision.CreatedAtUtc.Kind);
        Assert.Equal("synthetic-observed-actor-mode", revision.ActorMode);
        Assert.Equal(-7, revision.ActorAccountId);
        Assert.Equal(900009, revision.ActorAdminPrincipalId);
        Assert.Equal(0, revision.Id);
        Assert.Equal(before, JsonSerializer.Serialize(facts));
        // Preserving supplied actor values does not authenticate this actor class.
    }

    [Fact]
    public void ResolveRevision_PreservesAnonymousNullableActorFactsWithoutCreatingAnIdentity()
    {
        CommentScaleRevisionFacts facts = Facts() with
        {
            ActorMode = CommentAuthorModes.ZkAnonymous,
            ActorAccountId = null,
            ActorAdminPrincipalId = null
        };
        CommentRevision first = CanonicalCommentGraphFactory.ResolveRevision(facts, Temporal());
        CommentRevision second = CanonicalCommentGraphFactory.ResolveRevision(facts, Temporal());

        Assert.Equal(CommentAuthorModes.ZkAnonymous, first.ActorMode);
        Assert.Null(first.ActorAccountId);
        Assert.Null(first.ActorAdminPrincipalId);
        Assert.NotSame(first, second);
        Assert.Equal(first.ContentSha256, second.ContentSha256);
        Assert.Equal(0, first.Id);
        Assert.Equal(0, second.Id);
    }

    [Theory]
    [InlineData("facts")]
    [InlineData("temporal")]
    [InlineData("coordinate")]
    [InlineData("occurrence")]
    public void ResolveRevision_RejectsNullRequiredInput(string member)
    {
        CommentScaleRevisionFacts facts = Facts();
        facts = member switch
        {
            "facts" => null!,
            "coordinate" => facts with { Coordinate = null! },
            "occurrence" => facts with { Coordinate = facts.Coordinate with { Occurrence = null! } },
            _ => facts
        };
        Assert.Throws<ArgumentNullException>(() => CanonicalCommentGraphFactory.ResolveRevision(facts, member == "temporal" ? null! : Temporal()));
    }

    [Theory]
    [InlineData("comment-role")]
    [InlineData("scenario-role")]
    [InlineData("article-role")]
    [InlineData("repetition")]
    [InlineData("article-id")]
    [InlineData("comment-id")]
    [InlineData("version-zero")]
    [InlineData("version-negative")]
    [InlineData("operation-unknown")]
    [InlineData("operation-case")]
    [InlineData("content-null")]
    [InlineData("time-blank")]
    [InlineData("actor-blank")]
    public void ResolveRevision_RefusesInvalidStructuralBindings(string change)
    {
        CommentScaleRevisionFacts facts = Facts();
        facts = change switch
        {
            "comment-role" => facts with { Coordinate = facts.Coordinate with { CommentRole = " " } },
            "scenario-role" => facts with { Coordinate = facts.Coordinate with { Occurrence = facts.Coordinate.Occurrence with { ScenarioRole = " " } } },
            "article-role" => facts with { Coordinate = facts.Coordinate with { Occurrence = facts.Coordinate.Occurrence with { ArticleTargetRole = " " } } },
            "repetition" => facts with { Coordinate = facts.Coordinate with { Occurrence = facts.Coordinate.Occurrence with { Repetition = -1 } } },
            "article-id" => facts with { ArticleId = 0 },
            "comment-id" => facts with { AllocatedCommentId = 0 },
            "version-zero" => facts with { Version = 0 },
            "version-negative" => facts with { Version = -1 },
            "operation-unknown" => facts with { Operation = "invented-operation" },
            "operation-case" => facts with { Operation = "Created" },
            "content-null" => facts with { NormalizedContent = null! },
            "time-blank" => facts with { CreatedAtRole = " " },
            "actor-blank" => facts with { ActorMode = " " },
            _ => throw new InvalidOperationException(change)
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory.ResolveRevision(facts, Temporal()));
        Assert.Equal("comment_revision_structural_binding_invalid", error.Message);
    }

    [Fact]
    public void ResolveRevision_RequiresAnExistingOriginalTemporalRoleWithoutReadingAClock()
    {
        Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory.ResolveRevision(Facts() with { CreatedAtRole = "missing" }, Temporal()));
        CommentRevision revision = CanonicalCommentGraphFactory.ResolveRevision(Facts() with
        {
            CreatedAtRole = "earlier"
        }, Temporal());
        Assert.Equal(s_time, revision.CreatedAtUtc);
    }

    [Fact]
    public void ResolveStream_PairsInOriginalOrderAndPreservesZeroMarkersWithoutConsumingRevisionFacts()
    {
        Fixture f = Create();
        var facts = new TrackedInput<CommentScaleRevisionFacts>(f.Facts);
        CommentScaleRevisionGraphGroup[] result = CommentScaleRevisionGraphAdapter.ResolveStream(f.Groups, facts, Temporal()).ToArray();

        Assert.Equal(4, result.Length);
        Assert.Equal(new[] { null, "root", "child", null }, result.Select(group => group.InitialOutbox.Coordinate?.CommentRole));
        Assert.Null(result[0].Revision);
        Assert.Null(result[3].Revision);
        Assert.Equal(950001, result[1].Revision!.CommentId);
        Assert.Equal(950003, result[2].Revision!.CommentId);
        Assert.All(result.Where(group => group.Revision is not null), group =>
        {
            Assert.Equal(1, group.Revision!.Version);
            Assert.Equal(CommentRevisionOperations.Created, group.Revision!.Operation);
            Assert.Equal(0, group.Revision!.Id);
        });
        for (int index = 0; index < f.Groups.Length; index++)
        {
            Assert.Same(f.Groups[index], result[index].InitialOutbox);
        }
        Assert.Equal(3, facts.MoveNextCalls); // Two facts and the terminal extra-input check.
        Assert.Equal(1, facts.DisposeCalls);
    }

    [Theory]
    [InlineData(CommentModerationStatus.Pending)]
    [InlineData(CommentModerationStatus.Approved)]
    [InlineData(CommentModerationStatus.Rejected)]
    [InlineData(CommentModerationStatus.Hidden)]
    public void ResolveStream_DoesNotDeriveInitialRevisionFromModerationOrOutboxDefaults(CommentModerationStatus status)
    {
        Fixture f = Create();
        foreach (CommentMutationOutboxEvent item in f.Groups[1].Events)
        {
            item.NextStatus = status;
        }
        string before = JsonSerializer.Serialize(f.Groups[1]);
        CommentScaleRevisionGraphGroup result = Resolve(f).ElementAt(1);

        Assert.Equal(1, result.Revision!.Version);
        Assert.Equal(CommentRevisionOperations.Created, result.Revision!.Operation);
        Assert.Equal(f.Facts[0].NormalizedContent, result.Revision!.Content);
        Assert.Equal(before, JsonSerializer.Serialize(f.Groups[1]));
        Assert.Same(f.Groups[1], result.InitialOutbox);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("reordered")]
    [InlineData("null-fact")]
    public void ResolveStream_RefusesMissingExtraOrReorderedRevisionFacts(string change)
    {
        Fixture f = Create();
        CommentScaleRevisionFacts[] facts = change switch
        {
            "missing" => [f.Facts[0]],
            "extra" => [.. f.Facts, f.Facts[0]],
            "reordered" => f.Facts.Reverse().ToArray(),
            "null-fact" => [null!, f.Facts[1]],
            _ => throw new InvalidOperationException(change)
        };
        Assert.Throws<InvalidOperationException>(() => Resolve(f with { Facts = facts }).ToArray());
    }

    [Theory]
    [InlineData("coordinate")]
    [InlineData("article")]
    [InlineData("version")]
    [InlineData("edited")]
    [InlineData("deleted")]
    [InlineData("initial-admin")]
    [InlineData("intent-occurrence")]
    [InlineData("intent-comment")]
    public void ResolveStream_RefusesCrossedInitialBindingsRatherThanInventingAnInitialVersion(string change)
    {
        Fixture f = Create();
        CommentScaleRevisionFacts facts = change switch
        {
            "coordinate" => f.Facts[0] with { Coordinate = f.Facts[0].Coordinate with { CommentRole = "crossed" } },
            "article" => f.Facts[0] with { ArticleId = 43 },
            "version" => f.Facts[0] with { Version = 2 },
            "edited" => f.Facts[0] with { Operation = CommentRevisionOperations.Edited },
            "deleted" => f.Facts[0] with { Operation = CommentRevisionOperations.Deleted },
            "initial-admin" => f.Facts[0] with { ActorAdminPrincipalId = 900009 },
            _ => f.Facts[0]
        };
        if (change == "intent-occurrence")
        {
            f.Groups[1] = f.Groups[1] with
            {
                Intent = f.Groups[1].Intent with
                {
                    Occurrence = new("crossed", 0, "article.thread")
                }
            };
        }
        if (change == "intent-comment")
        {
            f.Groups[1] = f.Groups[1] with
            {
                Intent = f.Groups[1].Intent with
                {
                    Comments = []
                }
            };
        }
        f.Facts[0] = facts;
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        Assert.Equal("comment_revision_initial_binding_mismatch", error.Message);
    }

    [Theory]
    [InlineData("id-first")]
    [InlineData("id-final")]
    [InlineData("article-final")]
    [InlineData("time-final")]
    [InlineData("actor-final")]
    [InlineData("time-kind-unspecified")]
    [InlineData("time-kind-local")]
    [InlineData("null-event")]
    [InlineData("empty-events")]
    public void ResolveStream_ChecksEveryOriginalEventBindingBeforeYieldingThePair(string change)
    {
        Fixture f = Create();
        CommentMutationOutboxEvent[] events = f.Groups[1].Events.ToArray();
        switch (change)
        {
            case "id-first":
                events[0].CommentId = 99;
                break;
            case "id-final":
                events[^1].CommentId = 99;
                break;
            case "article-final":
                events[^1].ArticleId = 99;
                break;
            case "time-final":
                events[^1].OccurredAtUtc = s_time;
                break;
            case "actor-final":
                events[^1].AccountId = 8;
                break;
            case "time-kind-unspecified":
                events[^1].OccurredAtUtc = DateTime.SpecifyKind(s_time.AddMilliseconds(2), DateTimeKind.Unspecified);
                break;
            case "time-kind-local":
                events[^1].OccurredAtUtc = DateTime.SpecifyKind(s_time.AddMilliseconds(2), DateTimeKind.Local);
                break;
            case "null-event":
                events[^1] = null!;
                break;
            case "empty-events":
                events = [];
                break;
        }
        f.Groups[1] = f.Groups[1] with
        {
            Events = events
        };
        using IEnumerator<CommentScaleRevisionGraphGroup> reader = Resolve(f).GetEnumerator();
        Assert.True(reader.MoveNext()); // Existing zero marker only.
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => reader.MoveNext());
        Assert.Equal("comment_revision_initial_event_binding_mismatch", error.Message);
    }

    [Theory]
    [InlineData("comment-id")]
    [InlineData("missing-time")]
    [InlineData("actor-account")]
    public void ResolveStream_IndependentlySuppliedRevisionFactsMustMatchTheOriginalEventGroup(string change)
    {
        Fixture f = Create();
        f.Facts[0] = change switch
        {
            "comment-id" => f.Facts[0] with { AllocatedCommentId = 999999 },
            "missing-time" => f.Facts[0] with { CreatedAtRole = "missing" },
            "actor-account" => f.Facts[0] with { ActorAccountId = null },
            _ => throw new InvalidOperationException(change)
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        if (change != "missing-time")
        {
            Assert.Equal("comment_revision_initial_event_binding_mismatch", error.Message);
        }
    }

    [Theory]
    [InlineData("earlier", 0)]
    [InlineData("revision", 1)]
    public void ResolveStream_BindsRevisionToItsOwnRoleAndRetainsTheSeparateOriginalOutboxInstant(string role, int milliseconds)
    {
        Fixture f = Create();
        f.Facts[0] = f.Facts[0] with
        {
            CreatedAtRole = role
        };
        CommentScaleRevisionGraphGroup result = Resolve(f).ElementAt(1);
        Assert.Equal(s_time.AddMilliseconds(milliseconds), result.Revision!.CreatedAtUtc);
        Assert.All(result.InitialOutbox.Events, item => Assert.Equal(s_time.AddMilliseconds(2), item.OccurredAtUtc));
        Assert.NotEqual(result.Revision!.CreatedAtUtc, result.InitialOutbox.Events[0].OccurredAtUtc);
        // Production creation and outbox each read their own time; no equality is inferred.
    }

    [Fact]
    public void ResolveStream_PreservesSuppliedAnonymousInitialRevisionWhenOriginalEventsHaveNoAccount()
    {
        Fixture f = Create();
        f.Facts[0] = f.Facts[0] with
        {
            ActorMode = CommentAuthorModes.ZkAnonymous,
            ActorAccountId = null
        };
        foreach (CommentMutationOutboxEvent item in f.Groups[1].Events)
        {
            item.AccountId = null;
        }
        CommentScaleRevisionGraphGroup result = Resolve(f).ElementAt(1);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, result.Revision!.ActorMode);
        Assert.Null(result.Revision!.ActorAccountId);
        Assert.Null(result.Revision!.ActorAdminPrincipalId);
        Assert.Equal(0, result.Revision!.Id);
    }

    [Theory]
    [InlineData("missing-event")]
    [InlineData("reordered")]
    [InlineData("edited-only")]
    [InlineData("duplicate")]
    [InlineData("status-null")]
    [InlineData("status-undefined")]
    [InlineData("status-final")]
    [InlineData("admin-final")]
    [InlineData("all-times-local")]
    [InlineData("previous-final")]
    [InlineData("root-final")]
    [InlineData("parent-final")]
    [InlineData("recipient-final")]
    [InlineData("missing-required-reply")]
    [InlineData("invented-reply")]
    public void ResolveStream_ConsumesTheCompleteOriginalSelectorRosterAndCommonEnvelopeBindings(string change)
    {
        Fixture f = Create();
        CommentMutationOutboxEvent[] events = f.Groups[1].Events.ToArray();
        switch (change)
        {
            case "missing-event":
                events = [events[0]];
                break;
            case "reordered":
                events = events.Reverse().ToArray();
                break;
            case "edited-only":
                events = [events[0]];
                events[0].EventType = CommentMutationEventTypes.Edited;
                break;
            case "duplicate":
                events = [events[0], events[0]];
                break;
            case "status-null":
                events[0].NextStatus = null;
                break;
            case "status-undefined":
                events[0].NextStatus = (CommentModerationStatus)999;
                break;
            case "status-final":
                events[^1].NextStatus = CommentModerationStatus.Rejected;
                break;
            case "admin-final":
                events[^1].ActorAdminPrincipalId = 900009;
                break;
            case "all-times-local":
                foreach (CommentMutationOutboxEvent item in events)
                {
                    item.OccurredAtUtc = DateTime.SpecifyKind(item.OccurredAtUtc, DateTimeKind.Local);
                }
                break;
            case "previous-final":
                events[^1].PreviousStatus = CommentModerationStatus.Pending;
                break;
            case "root-final":
                events[^1].RootId = 99;
                break;
            case "parent-final":
                events[^1].ParentId = 99;
                break;
            case "recipient-final":
                events[^1].ReplyToAccountId = 8;
                break;
            case "missing-required-reply":
                foreach (CommentMutationOutboxEvent item in events)
                {
                    item.NextStatus = CommentModerationStatus.Approved;
                    item.ReplyToAccountId = 8;
                }
                break;
            case "invented-reply":
                events = [.. events, Event(CommentMutationEventTypes.ReplyNotificationRequested, 950001)];
                break;
        }
        f.Groups[1] = f.Groups[1] with
        {
            Events = events
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        Assert.Equal("comment_revision_initial_event_binding_mismatch", error.Message);
    }

    [Theory]
    [InlineData("group")]
    [InlineData("intent")]
    [InlineData("intent-comments")]
    [InlineData("events")]
    public void ResolveStream_RefusesNullRequiredOriginalGroupStructure(string member)
    {
        Fixture f = Create();
        f.Groups[1] = member switch
        {
            "group" => null!,
            "intent" => f.Groups[1] with { Intent = null! },
            "intent-comments" => f.Groups[1] with { Intent = f.Groups[1].Intent with { Comments = null! } },
            "events" => f.Groups[1] with { Events = null! },
            _ => throw new InvalidOperationException(member)
        };
        Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
    }

    [Theory]
    [InlineData("nonempty-intent")]
    [InlineData("nonempty-events")]
    [InlineData("null-comments")]
    public void ResolveStream_RejectsAnInvalidZeroMarkerWithoutConsumingFacts(string change)
    {
        Fixture f = Create();
        f.Groups[0] = change switch
        {
            "nonempty-intent" => f.Groups[0] with { Intent = f.Groups[1].Intent },
            "nonempty-events" => f.Groups[0] with { Events = f.Groups[1].Events },
            "null-comments" => f.Groups[0] with { Intent = f.Groups[0].Intent with { Comments = null! } },
            _ => throw new InvalidOperationException(change)
        };
        var facts = new TrackedInput<CommentScaleRevisionFacts>(f.Facts);
        Assert.Throws<InvalidOperationException>(() => CommentScaleRevisionGraphAdapter.ResolveStream(f.Groups, facts, Temporal()).ToArray());
        Assert.Equal(0, facts.MoveNextCalls);
    }

    [Fact]
    public void ResolveStream_NullIntentCommentMemberFailsClosedRatherThanThrowingDuringMembershipLookup()
    {
        Fixture f = Create();
        f.Groups[1] = f.Groups[1] with
        {
            Intent = f.Groups[1].Intent with
            {
                Comments = [null!]
            }
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        Assert.Equal("comment_revision_initial_group_invalid", error.Message);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(3)]
    public void ResolveStream_RejectsIntentRosterCountDriftBeforeConsumingRevisionFacts(int actualCount)
    {
        Fixture f = Create();
        CommentScaleResolvedRequestIntent[] actual = actualCount == 3
            ? [.. f.Groups[1].Intent.Comments, f.Groups[1].Intent.Comments[0]] : f.Groups[1].Intent.Comments.Take(actualCount).ToArray();
        var requests = new MisreportedList<CommentScaleResolvedRequestIntent>(2, actual);
        Assert.Equal(2, requests.Count);
        Assert.Equal(actualCount, requests.ToArray().Length);
        f.Groups[1] = f.Groups[1] with
        {
            Intent = f.Groups[1].Intent with
            {
                Comments = requests
            }
        };
        var facts = new TrackedInput<CommentScaleRevisionFacts>(f.Facts);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => CommentScaleRevisionGraphAdapter.ResolveStream(f.Groups, facts, Temporal()).ToArray());
        Assert.Equal("comment_revision_initial_group_invalid", error.Message);
        Assert.Equal(0, facts.MoveNextCalls);
    }

    [Fact]
    public void ResolveStream_RequiresExactlyOneIntentMembershipForTheSelectedCoordinate()
    {
        Fixture f = Create();
        CommentScaleResolvedRequestIntent root = f.Groups[1].Intent.Comments[0];
        f.Groups[1] = f.Groups[1] with
        {
            Intent = f.Groups[1].Intent with
            {
                Comments = [root, root]
            }
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        Assert.Equal("comment_revision_initial_binding_mismatch", error.Message);
    }

    [Fact]
    public void ResolveStream_ZeroMarkerRejectsAnEventEnumeratorHiddenBehindReportedZeroCount()
    {
        Fixture f = Create();
        var events = new MisreportedList<CommentMutationOutboxEvent>(0, [f.Groups[1].Events[0]]);
        Assert.Equal(0, events.Count);
        Assert.Single(events.ToArray());
        f.Groups[0] = f.Groups[0] with
        {
            Events = events
        };
        var facts = new TrackedInput<CommentScaleRevisionFacts>(f.Facts);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => CommentScaleRevisionGraphAdapter.ResolveStream(f.Groups, facts, Temporal()).ToArray());
        Assert.Equal("comment_revision_empty_marker_invalid", error.Message);
        Assert.Equal(0, facts.MoveNextCalls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(3)]
    public void ResolveStream_RefusesEventRosterReportedCountWhichDiffersFromActualEnumeration(int actualCount)
    {
        Fixture f = Create();
        CommentMutationOutboxEvent[] actual = actualCount == 3
            ? [.. f.Groups[1].Events, f.Groups[1].Events[0]] : f.Groups[1].Events.Take(actualCount).ToArray();
        var events = new MisreportedList<CommentMutationOutboxEvent>(2, actual);
        Assert.Equal(2, events.Count);
        Assert.Equal(actualCount, events.ToArray().Length);
        f.Groups[1] = f.Groups[1] with
        {
            Events = events
        };
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => Resolve(f).ToArray());
        Assert.Equal("comment_revision_initial_event_binding_mismatch", error.Message);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(256)]
    public void ResolveBatches_PreservesWholeOriginalGroupsAndReturnsReadonlyBoundedRosters(int size)
    {
        Fixture f = Create();
        IReadOnlyList<CommentScaleRevisionGraphGroup>[] batches = CommentScaleRevisionGraphAdapter.ResolveBatches(f.Groups, f.Facts, Temporal(), size).ToArray();
        Assert.Equal(4, batches.Sum(batch => batch.Count));
        Assert.All(batches, batch =>
        {
            Assert.InRange(batch.Count, 1, size);
            Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleRevisionGraphGroup>)batch).Clear());
        });
        CommentScaleRevisionGraphGroup[] result = batches.SelectMany(batch => batch).ToArray();
        Assert.Equal(3, result[2].InitialOutbox.Events.Count);
        Assert.Equal(new[] { null, "root", "child", null }, result.Select(group => group.InitialOutbox.Coordinate?.CommentRole));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(257)]
    public void ResolveBatches_UsesTheExistingCanonicalBatchBound(int size)
    {
        Fixture f = Create();
        Assert.Throws<ArgumentOutOfRangeException>(() => CommentScaleRevisionGraphAdapter.ResolveBatches(f.Groups, f.Facts, Temporal(), size).ToArray());
    }

    [Fact]
    public void ResolveStream_IsLazyAndZeroMarkersDoNotPrefetchOrConsumeRevisionFacts()
    {
        Fixture f = Create();
        var groups = new TrackedInput<CommentScaleInitialOutboxGraphGroup>(f.Groups);
        var facts = new TrackedInput<CommentScaleRevisionFacts>(f.Facts);
        IEnumerable<CommentScaleRevisionGraphGroup> stream = CommentScaleRevisionGraphAdapter.ResolveStream(groups, facts, Temporal());
        Assert.Equal(0, groups.MoveNextCalls);
        Assert.Equal(0, facts.MoveNextCalls);
        using (IEnumerator<CommentScaleRevisionGraphGroup> reader = stream.GetEnumerator())
        {
            Assert.True(reader.MoveNext());
            Assert.Null(reader.Current.Revision);
            Assert.Equal(1, groups.MoveNextCalls);
            Assert.Equal(0, facts.MoveNextCalls);
            Assert.True(reader.MoveNext());
            Assert.Equal(950001, reader.Current.Revision!.CommentId);
            Assert.Equal(2, groups.MoveNextCalls);
            Assert.Equal(1, facts.MoveNextCalls);
        }
        Assert.Equal(1, groups.DisposeCalls);
        Assert.Equal(1, facts.DisposeCalls);
    }

    [Fact]
    public void ResolveBatches_DoesNotReadTheNextGroupToYieldTheCurrentFullBatch()
    {
        Fixture f = Create();
        var groups = new TrackedInput<CommentScaleInitialOutboxGraphGroup>(f.Groups);
        var facts = new TrackedInput<CommentScaleRevisionFacts>(f.Facts);
        using IEnumerator<IReadOnlyList<CommentScaleRevisionGraphGroup>> reader = CommentScaleRevisionGraphAdapter.ResolveBatches(groups, facts, Temporal(), 2).GetEnumerator();
        Assert.True(reader.MoveNext());
        Assert.Equal(2, reader.Current.Count);
        Assert.Equal(2, groups.MoveNextCalls);
        Assert.Equal(1, facts.MoveNextCalls);
    }

    [Theory]
    [InlineData("groups")]
    [InlineData("facts")]
    public void ResolveStream_PreservesOriginalMidstreamFailureAndOnlyTheEarlierYieldedPrefix(string input)
    {
        Fixture f = Create();
        var failure = new InvalidOperationException("synthetic-unit-original-input-failure");
        var groups = new TrackedInput<CommentScaleInitialOutboxGraphGroup>(f.Groups, input == "groups" ? 2 : -1, failure);
        var facts = new TrackedInput<CommentScaleRevisionFacts>(f.Facts, input == "facts" ? 1 : -1, failure);
        var prefix = new List<CommentScaleRevisionGraphGroup>();
        InvalidOperationException actual = Assert.Throws<InvalidOperationException>(() =>
        {
            foreach (CommentScaleRevisionGraphGroup group in CommentScaleRevisionGraphAdapter.ResolveStream(groups, facts, Temporal()))
            {
                prefix.Add(group);
            }
        });
        Assert.Same(failure, actual);
        Assert.Equal(new[] { null, "root" }, prefix.Select(group => group.InitialOutbox.Coordinate?.CommentRole));
        Assert.Equal(1, groups.DisposeCalls);
        Assert.Equal(1, facts.DisposeCalls);
    }

    [Fact]
    public void ResolveStream_ExtraFactsAreDetectedOnlyByCompleteEnumeration()
    {
        Fixture f = Create();
        using IEnumerator<CommentScaleRevisionGraphGroup> reader = Resolve(f with
        {
            Facts = [.. f.Facts, f.Facts[0]]
        }).GetEnumerator();
        var prefix = new List<CommentScaleRevisionGraphGroup>();
        for (int index = 0; index < 4; index++)
        {
            Assert.True(reader.MoveNext());
            prefix.Add(reader.Current);
        }
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => reader.MoveNext());
        Assert.Equal("comment_revision_facts_extra", error.Message);
        Assert.Equal(4, prefix.Count);
    }

    [Fact]
    public void ResolveStream_EmptyInputsAndOnlyZeroMarkersDoNotInventRevisionFacts()
    {
        Fixture f = Create();
        Assert.Empty(CommentScaleRevisionGraphAdapter.ResolveStream([], [], Temporal()));
        CommentScaleRevisionGraphGroup[] result = CommentScaleRevisionGraphAdapter.ResolveStream([f.Groups[0], f.Groups[3]], [], Temporal()).ToArray();
        Assert.Equal(2, result.Length);
        Assert.All(result, group => Assert.Null(group.Revision));
        Assert.Throws<InvalidOperationException>(() => CommentScaleRevisionGraphAdapter.ResolveStream([], [f.Facts[0]], Temporal()).ToArray());
    }

    [Fact]
    public void ResolveStream_RetainsOriginalMutableOutboxAndRevisionEntitiesWithoutClaimingSnapshotAdmission()
    {
        Fixture f = Create();
        CommentScaleRevisionGraphGroup result = Resolve(f).ElementAt(1);
        Assert.Same(f.Groups[1], result.InitialOutbox);
        f.Groups[1].Events[0].LastError = "synthetic-unit-mutation";
        result.Revision!.Content = "synthetic later entity mutation";
        Assert.Equal("synthetic-unit-mutation", result.InitialOutbox.Events[0].LastError);
        Assert.Equal("synthetic later entity mutation", result.Revision!.Content);
        Assert.Equal(0, result.Revision!.Id);
    }

    [Theory]
    [InlineData("groups")]
    [InlineData("facts")]
    [InlineData("temporal")]
    public void ResolveStream_RejectsNullRequiredStreamsOrContext(string member)
    {
        Fixture f = Create();
        Assert.Throws<ArgumentNullException>(() => CommentScaleRevisionGraphAdapter.ResolveStream(
            member == "groups" ? null! : f.Groups, member == "facts" ? null! : f.Facts,
            member == "temporal" ? null! : Temporal()).ToArray());
    }

    private static IEnumerable<CommentScaleRevisionGraphGroup> Resolve(Fixture f)
        => CommentScaleRevisionGraphAdapter.ResolveStream(f.Groups, f.Facts, Temporal());

    private sealed record Fixture(CommentScaleInitialOutboxGraphGroup[] Groups, CommentScaleRevisionFacts[] Facts);

    private static CommentScaleRevisionFacts Facts(string role = "root", long id = 950001)
        => new(new(new("thread", 0, "article.thread"), role), 42, id, 1, CommentRevisionOperations.Created,
            "synthetic unit normalized content", "revision", CommentAuthorModes.Public, 7, null);

    private static Fixture Create()
    {
        CommentScaleRevisionFacts[] facts = [Facts(), Facts("child", 950003)];
        CommentScaleResolvedGraphIntent intent = Intent(facts[0].Coordinate.Occurrence, 42,
            facts.Select(item => item.Coordinate).ToArray());
        var root = new CommentScaleInitialOutboxGraphGroup(intent, facts[0].Coordinate,
            Array.AsReadOnly(new[] { Event(CommentMutationEventTypes.Created, 950001), Event(CommentMutationEventTypes.VisibilityChanged, 950001) }));
        var child = new CommentScaleInitialOutboxGraphGroup(intent, facts[1].Coordinate,
            Array.AsReadOnly(new[] { Event(CommentMutationEventTypes.Created, 950003, CommentModerationStatus.Approved, 8), Event(CommentMutationEventTypes.VisibilityChanged, 950003, CommentModerationStatus.Approved, 8),
                Event(CommentMutationEventTypes.ReplyNotificationRequested, 950003, CommentModerationStatus.Approved, 8) }));
        var firstZero = new CommentScaleInitialOutboxGraphGroup(Intent(new("empty", 0, "article.empty"), 88, []), null,
            Array.AsReadOnly(Array.Empty<CommentMutationOutboxEvent>()));
        var lastZero = new CommentScaleInitialOutboxGraphGroup(Intent(new("empty", 1, "article.empty"), 99, []), null,
            Array.AsReadOnly(Array.Empty<CommentMutationOutboxEvent>()));
        return new([firstZero, root, child, lastZero], facts);
    }

    private static CommentScaleResolvedGraphIntent Intent(CommentScaleGraphOccurrence occurrence, int articleId,
        IReadOnlyList<CommentScaleRequestCoordinate> coordinates)
        => new(occurrence, UnitDigest, UnitDigest, "synthetic-minimal-transport-article", articleId,
            new(ArticleScaleGraphIdentityBindings.Schema, UnitDigest), new([], []),
            coordinates.Select(coordinate => new CommentScaleResolvedRequestIntent(coordinate, null, null,
                "synthetic-content-role", new("fsusblog.generated-content-shape.v1", UnitDigest), null!, [])).ToArray());

    private static CommentMutationOutboxEvent Event(string type, long id,
        CommentModerationStatus status = CommentModerationStatus.Pending, int? recipient = null)
        => new()
        {
            EventType = type,
            CommentId = id,
            ArticleId = 42,
            RootId = 910007,
            ParentId = 910003,
            AccountId = 7,
            OccurredAtUtc = s_time.AddMilliseconds(2),
            NextStatus = status,
            ReplyToAccountId = recipient
        };

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
            roles = new[] { "earlier", "revision" }.Select((role, index) => new
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
