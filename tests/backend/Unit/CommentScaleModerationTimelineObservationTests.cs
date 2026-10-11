using System.Collections;
using System.Globalization;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit-only plans, native maps, rows, temporal envelopes and timelines
/// exercise observation binding through the original verifier. They authenticate
/// no allocator, event completeness, credentials, time, actor, policy, revision,
/// transaction, database delivery or canonical receipt. Original entity references
/// remain mutable; only supplied collection membership is snapshotted.
/// </summary>
public sealed class CommentScaleModerationTimelineObservationTests
{
    private const string UnitDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly DateTime s_time = new(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ObserveStream_PreservesOriginalOccurrenceAndCommentOrderIncludingZeroMarkers()
    {
        UnitInputs input = Create();

        CommentScaleObservedModerationTimelineGroup[] groups = Observe(input).ToArray();

        Assert.Equal(new[] { "root", "child", "root", "child", null, null },
            groups.Select(group => group.Coordinate?.CommentRole));
        Assert.Equal(new[] { "thread", "thread", "thread", "thread", "empty", "empty" },
            groups.Select(group => group.Intent.Occurrence.ScenarioRole));
        Assert.Equal(new long[] { 0, 0, 1, 1, 0, 1 }, groups.Select(group => group.Intent.Occurrence.Repetition));
        Assert.Equal(new[] { 42, 42, 77, 77, 88, 99 }, groups.Select(group => group.Intent.ArticleId));
        Assert.Equal(new long[] { 950001, 950003, 970007, 970011 }, groups.Take(4).Select(group => group.CurrentComment!.Id));
        Assert.Same(groups[0].Intent, groups[1].Intent);
        Assert.NotSame(groups[1].Intent, groups[2].Intent);
        Assert.All(groups.Skip(4), group =>
        {
            Assert.Null(group.Coordinate);
            Assert.Null(group.CurrentComment);
            Assert.Null(group.Timeline);
            Assert.Empty(group.Intent.Comments);
            Assert.Equal(input.Plan.ContentDigest, group.Intent.CommentPlanDigest);
        });
    }

    [Theory]
    [InlineData(CommentModerationStatus.Pending)]
    [InlineData(CommentModerationStatus.Approved)]
    [InlineData(CommentModerationStatus.Rejected)]
    [InlineData(CommentModerationStatus.Hidden)]
    public void ObserveStream_PreservesActualFinalStatusWithoutReplacingItWithInitialPlannedStatus(CommentModerationStatus status)
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts request = input.Timelines[0].Comments[0];
        request.CurrentComment.ModerationStatus = status;
        CommentModerationEvent first = Event(8011, request.CurrentComment.Id, null, CommentModerationStatus.Pending);
        CommentModerationEvent[] events = status == CommentModerationStatus.Pending
            ? [first] : [first, Event(8023, request.CurrentComment.Id, CommentModerationStatus.Pending, status)];
        input.Timelines[0] = ReplaceFirst(input.Timelines[0], request with
        {
            Timeline = new(request.CurrentComment.Id, status, status, true, events)
        });

        CommentScaleObservedModerationTimelineGroup group = Observe(input).First();

        Assert.Equal(CommentModerationStatus.Pending, group.Intent.Comments[0].Moderation[0].Request.Next);
        Assert.Equal(status, group.CurrentComment!.ModerationStatus);
        Assert.Equal(status, group.Timeline!.CurrentStatus);
        Assert.Equal(status, group.Timeline.ProjectedStatus);
        Assert.Equal(events, group.Timeline.Events);
    }

    [Fact]
    public void ObserveStream_RetainsSameStatusAppealEventsAndEveryOriginalMetadataField()
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts request = input.Timelines[0].Comments[0];
        CommentModerationTimelineResult timeline = request.Timeline;
        string rowBefore = JsonSerializer.Serialize(request.CurrentComment);
        string eventsBefore = JsonSerializer.Serialize(timeline.Events);
        Assert.True(CommentFixtureTimelineVerifier.IsConsistent(timeline, request.CurrentComment.Id, CommentModerationStatus.Hidden));

        CommentScaleObservedModerationTimelineGroup group = Observe(input).First();

        Assert.Same(request.CurrentComment, group.CurrentComment);
        Assert.NotSame(timeline, group.Timeline);
        Assert.Equal(timeline.CommentId, group.Timeline!.CommentId);
        Assert.Equal(timeline.ProjectedStatus, group.Timeline.ProjectedStatus);
        Assert.Equal(timeline.CurrentStatus, group.Timeline.CurrentStatus);
        Assert.Equal(timeline.Consistent, group.Timeline.Consistent);
        Assert.Equal(new long[] { 8011, 8023, 8057, 8099, 8121 }, group.Timeline.Events.Select(item => item.Id));
        Assert.Equal(new[] { "create", "approve", "hide", "appeal", "appeal_decision" },
            group.Timeline.Events.Select(item => item.EventType));
        Assert.Equal(eventsBefore, JsonSerializer.Serialize(group.Timeline.Events));
        Assert.Equal(rowBefore, JsonSerializer.Serialize(group.CurrentComment));
        for (int index = 0; index < timeline.Events.Count; index++)
        {
            Assert.Same(timeline.Events[index], group.Timeline.Events[index]);
        }
        CommentModerationEvent appeal = group.Timeline.Events[3];
        Assert.Equal(CommentModerationStatus.Hidden, appeal.PreviousStatus);
        Assert.Equal(CommentModerationStatus.Hidden, appeal.NextStatus);
        Assert.Equal("synthetic-unit-actor", appeal.ActorType);
        Assert.Equal("synthetic-unit-reason", appeal.ReasonCode);
        Assert.Equal("synthetic-unit-policy", appeal.PolicyVersion);
        Assert.Equal("synthetic-unit-model", appeal.ModelVersion);
        Assert.Equal("synthetic-unit-transition-source", appeal.TransitionSource);
        Assert.Equal(91, appeal.AdminPrincipalId);
        Assert.Equal(61, appeal.AppealId);
        Assert.Equal(s_time.AddDays(2).AddMilliseconds(8099), appeal.OccurredAtUtc);
    }

    [Fact]
    public void ObserveStream_PreservesFullAnonymousRowWithoutClaimingCredentialOrCapabilityValidity()
    {
        UnitInputs input = Create(anonymous: true);
        Comment row = input.Timelines[0].Comments[1].CurrentComment;
        row.AnonymousHandle = "synthetic-unit-handle";
        row.AnonymousDisplayName = "synthetic unit display";
        row.AnonymousDisplayLanguage = "en";
        row.AnonymousNullifierHash = "synthetic-unverified-nullifier";
        row.AnonymousScope = "synthetic-unit-scope";
        row.ModerationSubjectHash = "synthetic-unverified-subject";
        row.ManagementCapabilityHash = "synthetic-unverified-capability";
        row.AnonymousTicketHash = "synthetic-unverified-ticket";
        row.MutationRequestHash = "synthetic-unverified-request";
        row.MutationExpiresAtUtc = s_time.AddDays(7);
        row.CredentialLevel = "synthetic-unit-level";
        row.ReputationBucket = "synthetic-unit-reputation";
        row.AccountAgeBucket = "synthetic-unit-age";
        row.AnonymousRateClass = "synthetic-unit-rate";
        row.AnonymousRequiresModeration = true;
        row.Content = "owner supplied synthetic private content";
        row.CurrentVersion = 19;
        row.RowVersion = "synthetic-unit-row-version";
        row.EditedAtUtc = s_time.AddDays(1);
        row.IsDeleted = true;
        row.DeleteReason = "synthetic-unit-delete";
        row.DeleteTime = s_time.AddDays(2);
        row.ModerationReason = "owner supplied synthetic reason";
        row.ModeratedByAdminPrincipalId = 91;
        row.ModeratedAt = s_time.AddDays(2);
        string before = JsonSerializer.Serialize(row);

        CommentScaleObservedModerationTimelineGroup child = Observe(input).ElementAt(1);

        Assert.Same(row, child.CurrentComment);
        Assert.Null(child.CurrentComment!.UserId);
        Assert.Equal(CommentScaleCredentialValidity.ScaleSyntheticTestOnly, child.Intent.Comments[1].Policies.CredentialValidity);
        Assert.Equal(before, JsonSerializer.Serialize(child.CurrentComment));
        Assert.Equal(950001, child.CurrentComment.ParentId);
        Assert.Equal(950001, child.CurrentComment.RootId);
        Assert.Equal(1, child.CurrentComment.Depth);
        // Observation preserves supplied fields; none of these synthetic strings is a proof.
    }

    [Fact]
    public void ObserveStream_DoesNotPromoteSuppliedTimeOrOpaqueMetadataToQualifiedFacts()
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts request = input.Timelines[0].Comments[0];
        request.CurrentComment.CreateTime = s_time.AddYears(3);
        request.Timeline.Events[0].OccurredAtUtc = s_time.AddYears(5);
        request.Timeline.Events[1].OccurredAtUtc = DateTime.SpecifyKind(s_time.AddYears(-1), DateTimeKind.Unspecified);
        request.Timeline.Events[2].EventType = "future-opaque-event";
        request.Timeline.Events[2].ActorType = "future-opaque-actor";
        request.Timeline.Events[2].PolicyVersion = null;
        request.Timeline.Events[2].ModelVersion = null;

        CommentScaleObservedModerationTimelineGroup group = Observe(input).First();

        Assert.Equal(s_time.AddYears(3), group.CurrentComment!.CreateTime);
        Assert.Equal(s_time.AddYears(5), group.Timeline!.Events[0].OccurredAtUtc);
        Assert.Equal(DateTimeKind.Unspecified, group.Timeline.Events[1].OccurredAtUtc.Kind);
        Assert.Equal("future-opaque-event", group.Timeline.Events[2].EventType);
        Assert.Equal("future-opaque-actor", group.Timeline.Events[2].ActorType);
        Assert.Null(group.Timeline.Events[2].PolicyVersion);
        Assert.Null(group.Timeline.Events[2].ModelVersion);
        Assert.Equal(s_time, group.Intent.Comments[0].Policies.CreatedAtUtc);
        // The verifier checks supplied-order status continuity, not clock ordering,
        // event metadata authority or an admitted complete native graph.
    }

    [Theory]
    [InlineData("false-consistent")]
    [InlineData("timeline-comment")]
    [InlineData("current-status")]
    [InlineData("projected-status")]
    [InlineData("foreign-event")]
    [InlineData("empty-events")]
    [InlineData("null-events")]
    [InlineData("null-event")]
    [InlineData("zero-event-id")]
    [InlineData("negative-event-id")]
    [InlineData("duplicate-adjacent-id")]
    [InlineData("duplicate-nonadjacent-id")]
    [InlineData("initial-predecessor")]
    [InlineData("broken-predecessor")]
    [InlineData("second-null-predecessor")]
    [InlineData("reordered-events")]
    [InlineData("wrong-last-status")]
    [InlineData("future-previous")]
    [InlineData("future-next")]
    [InlineData("future-timeline-current")]
    [InlineData("future-timeline-projected")]
    public void ObserveStream_RefusesMalformedOrInconsistentOriginalTimelineBeforeOccurrenceYield(string drift)
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts request = input.Timelines[0].Comments[0];
        CommentModerationTimelineResult timeline = request.Timeline;
        switch (drift)
        {
            case "false-consistent":
                timeline = timeline with
                {
                    Consistent = false
                };
                break;
            case "timeline-comment":
                timeline = timeline with
                {
                    CommentId = 999
                };
                break;
            case "current-status":
                timeline = timeline with
                {
                    CurrentStatus = CommentModerationStatus.Approved
                };
                break;
            case "projected-status":
                timeline = timeline with
                {
                    ProjectedStatus = CommentModerationStatus.Approved
                };
                break;
            case "foreign-event":
                timeline.Events[2].CommentId = 999;
                break;
            case "empty-events":
                timeline = timeline with
                {
                    Events = []
                };
                break;
            case "null-events":
                timeline = timeline with
                {
                    Events = null!
                };
                break;
            case "null-event":
                timeline = timeline with
                {
                    Events = [timeline.Events[0], null!, .. timeline.Events.Skip(2)]
                };
                break;
            case "zero-event-id":
                timeline.Events[2].Id = 0;
                break;
            case "negative-event-id":
                timeline.Events[2].Id = -1;
                break;
            case "duplicate-adjacent-id":
                timeline.Events[2].Id = timeline.Events[1].Id;
                break;
            case "duplicate-nonadjacent-id":
                timeline.Events[4].Id = timeline.Events[0].Id;
                break;
            case "initial-predecessor":
                timeline.Events[0].PreviousStatus = CommentModerationStatus.Pending;
                break;
            case "broken-predecessor":
                timeline.Events[2].PreviousStatus = CommentModerationStatus.Pending;
                break;
            case "second-null-predecessor":
                timeline.Events[1].PreviousStatus = null;
                break;
            case "reordered-events":
                timeline = timeline with
                {
                    Events = [timeline.Events[1], timeline.Events[0], .. timeline.Events.Skip(2)]
                };
                break;
            case "wrong-last-status":
                timeline.Events[4].NextStatus = CommentModerationStatus.Rejected;
                break;
            case "future-previous":
                timeline.Events[2].PreviousStatus = (CommentModerationStatus)999;
                break;
            case "future-next":
                timeline.Events[2].NextStatus = (CommentModerationStatus)999;
                break;
            case "future-timeline-current":
                timeline = timeline with
                {
                    CurrentStatus = (CommentModerationStatus)999
                };
                break;
            case "future-timeline-projected":
                timeline = timeline with
                {
                    ProjectedStatus = (CommentModerationStatus)999
                };
                break;
        }
        input.Timelines[0] = ReplaceFirst(input.Timelines[0], request with
        {
            Timeline = timeline
        });
        using IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input).GetEnumerator();

        Assert.Throws<InvalidOperationException>(() => output.MoveNext());
    }

    [Fact]
    public void ObserveStream_RefusesGrantedAppealGapWithoutRepairingOriginalEvents()
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts request = input.Timelines[0].Comments[0];
        request.CurrentComment.ModerationStatus = CommentModerationStatus.Approved;
        request.Timeline.Events[4].PreviousStatus = CommentModerationStatus.Approved;
        request.Timeline.Events[4].NextStatus = CommentModerationStatus.Approved;
        request.Timeline.Events[4].ReasonCode = "appeal_granted";
        CommentModerationTimelineResult timeline = request.Timeline with
        {
            CurrentStatus = CommentModerationStatus.Approved,
            ProjectedStatus = CommentModerationStatus.Approved
        };
        input.Timelines[0] = ReplaceFirst(input.Timelines[0], request with
        {
            Timeline = timeline
        });
        string before = JsonSerializer.Serialize(timeline);

        Assert.Throws<InvalidOperationException>(() => Observe(input).ToArray());

        Assert.Equal(before, JsonSerializer.Serialize(timeline));
        Assert.Equal(CommentModerationStatus.Approved, timeline.Events[4].PreviousStatus);
        Assert.Equal("appeal_granted", timeline.Events[4].ReasonCode);
    }

    [Theory]
    [InlineData("null-request")]
    [InlineData("unknown-comment")]
    [InlineData("missing-entity-role")]
    [InlineData("null-current-comment")]
    [InlineData("null-timeline")]
    [InlineData("wrong-native-id")]
    [InlineData("zero-native-id")]
    [InlineData("negative-native-id")]
    [InlineData("wrong-article")]
    [InlineData("future-row-status")]
    public void ObserveStream_RefusesCrossedOrMissingPerCommentFacts(string drift)
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts request = input.Timelines[0].Comments[0];
        switch (drift)
        {
            case "null-request":
                request = null!;
                break;
            case "unknown-comment":
                request = request with
                {
                    CommentRole = "other"
                };
                break;
            case "missing-entity-role":
                request = request with
                {
                    EntityRole = "other"
                };
                break;
            case "null-current-comment":
                request = request with
                {
                    CurrentComment = null!
                };
                break;
            case "null-timeline":
                request = request with
                {
                    Timeline = null!
                };
                break;
            case "wrong-native-id":
                request.CurrentComment.Id++;
                break;
            case "zero-native-id":
                request.CurrentComment.Id = 0;
                break;
            case "negative-native-id":
                request.CurrentComment.Id = -1;
                break;
            case "wrong-article":
                request.CurrentComment.ArticleId = 999;
                break;
            case "future-row-status":
                request.CurrentComment.ModerationStatus = (CommentModerationStatus)999;
                break;
        }
        input.Timelines[0] = ReplaceFirst(input.Timelines[0], request);

        Assert.Throws<InvalidOperationException>(() => Observe(input).ToArray());
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("reordered")]
    [InlineData("duplicate")]
    [InlineData("null-roster")]
    public void ObserveStream_RequiresCompleteExactOrderedCommentRoster(string drift)
    {
        UnitInputs input = Create();
        CommentScaleTimelineOccurrenceFacts frame = input.Timelines[0];
        input.Timelines[0] = frame with
        {
            Comments = drift switch
            {
                "missing" => [frame.Comments[0]],
                "extra" => [.. frame.Comments, frame.Comments[0]],
                "reordered" => [frame.Comments[1], frame.Comments[0]],
                "duplicate" => [frame.Comments[0], frame.Comments[0]],
                _ => null!
            }
        };

        Assert.Throws<InvalidOperationException>(() => Observe(input).ToArray());
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("reordered")]
    [InlineData("duplicate")]
    [InlineData("cross-scenario")]
    [InlineData("cross-repetition")]
    [InlineData("cross-target")]
    [InlineData("null-frame")]
    public void ObserveStream_RequiresCompleteExactOrderedOccurrenceFrames(string drift)
    {
        UnitInputs input = Create();
        CommentScaleTimelineOccurrenceFacts[] frames = input.Timelines;
        input = input with
        {
            Timelines = drift switch
            {
                "missing" => frames.Take(3).ToArray(),
                "extra" => [.. frames, frames[0]],
                "reordered" => [frames[1], frames[0], .. frames.Skip(2)],
                "duplicate" => [frames[0], frames[0], .. frames.Skip(2)],
                "cross-scenario" => [frames[0] with
                {
                    Occurrence = frames[0].Occurrence with
                    {
                        ScenarioRole = "other"
                    }
                }, .. frames.Skip(1)],
                "cross-repetition" => [frames[0] with
                {
                    Occurrence = frames[0].Occurrence with
                    {
                        Repetition = 7
                    }
                }, .. frames.Skip(1)],
                "cross-target" => [frames[0] with
                {
                    Occurrence = frames[0].Occurrence with
                    {
                        ArticleTargetRole = "other"
                    }
                }, .. frames.Skip(1)],
                _ => [null!, .. frames.Skip(1)]
            }
        };

        Assert.Throws<InvalidOperationException>(() => Observe(input).ToArray());
    }

    [Theory]
    [InlineData("run")]
    [InlineData("runtime")]
    [InlineData("provider")]
    [InlineData("namespace")]
    [InlineData("comment-plan")]
    [InlineData("article-plan")]
    [InlineData("allocation")]
    [InlineData("binding-schema")]
    [InlineData("binding-digest")]
    [InlineData("missing-roster-role")]
    [InlineData("extra-roster-role")]
    [InlineData("duplicate-roster-role")]
    [InlineData("wrong-entity-kind")]
    public void ObserveStream_RequiresExactOriginalNativeScopeReferencesAndRoleCoverage(string drift)
    {
        UnitInputs input = Create();
        CommentScaleTimelineOccurrenceFacts frame = input.Timelines[0];
        CommentScaleNativeBindingExpectation expected = frame.Expectations;
        DataScaleNativeCommentBindings map = frame.Identities;
        switch (drift)
        {
            case "run":
                expected = expected with
                {
                    RunId = "other-run"
                };
                break;
            case "runtime":
                expected = expected with
                {
                    RuntimeIdentity = "other-runtime"
                };
                break;
            case "provider":
                expected = expected with
                {
                    Provider = "MySql"
                };
                break;
            case "namespace":
            case "comment-plan":
            case "article-plan":
                map = new(map.RunId, drift == "namespace" ? "other-namespace" : map.Namespace,
                    map.RuntimeIdentity, map.Provider, drift == "comment-plan" ? OtherDigest : map.CommentPlanDigest,
                    drift == "article-plan" ? OtherDigest : map.ArticlePlanDigest, map.Allocation, map.Ids);
                expected = Expected(map);
                break;
            case "allocation":
                expected = expected with
                {
                    Allocation = expected.Allocation with
                    {
                        OwnerContractId = "other-owner"
                    }
                };
                break;
            case "binding-schema":
                expected = expected with
                {
                    BindingReference = expected.BindingReference with
                    {
                        Schema = "other-schema"
                    }
                };
                break;
            case "binding-digest":
                expected = expected with
                {
                    BindingReference = expected.BindingReference with
                    {
                        ContentDigest = OtherDigest
                    }
                };
                break;
            case "missing-roster-role":
                expected = expected with
                {
                    FactoryRoles = expected.FactoryRoles.Take(1).ToArray()
                };
                break;
            case "extra-roster-role":
                expected = expected with
                {
                    FactoryRoles = [.. expected.FactoryRoles, expected.FactoryRoles[0] with
                    {
                        EntityRole = "extra"
                    }]
                };
                break;
            case "duplicate-roster-role":
                expected = expected with
                {
                    FactoryRoles = [expected.FactoryRoles[0], expected.FactoryRoles[0]]
                };
                break;
            case "wrong-entity-kind":
                var ids = map.Ids.ToDictionary(pair => pair.Key, pair => pair.Value);
                DataScaleNativeCommentRole original = expected.FactoryRoles[0];
                long id = ids[original];
                ids.Remove(original);
                ids.Add(original with
                {
                    Entity = DataScaleNativeCommentEntity.Revision
                }, id);
                map = new(map.RunId, map.Namespace, map.RuntimeIdentity, map.Provider,
                    map.CommentPlanDigest, map.ArticlePlanDigest, map.Allocation, ids);
                expected = Expected(map);
                break;
        }
        input.Timelines[0] = frame with
        {
            Identities = map,
            Expectations = expected
        };

        Assert.Throws<InvalidOperationException>(() => Observe(input).ToArray());
    }

    [Theory]
    [InlineData("native-scope")]
    [InlineData("native-roster")]
    [InlineData("nonempty-comments")]
    public void ObserveStream_ZeroCommentOccurrenceStillRequiresItsActualScopeAndEmptyRoster(string drift)
    {
        UnitInputs input = Create();
        CommentScaleTimelineOccurrenceFacts empty = input.Timelines[2];
        input.Timelines[2] = drift switch
        {
            "native-scope" => empty with
            {
                Expectations = empty.Expectations with
                {
                    RuntimeIdentity = "other"
                }
            },
            "native-roster" => empty with
            {
                Expectations = empty.Expectations with
                {
                    FactoryRoles = input.Timelines[0].Expectations.FactoryRoles
                }
            },
            _ => empty with
            {
                Comments = [input.Timelines[0].Comments[0]]
            }
        };
        using IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input).GetEnumerator();
        for (int index = 0; index < 4; index++)
        {
            Assert.True(output.MoveNext());
        }

        Assert.Throws<InvalidOperationException>(() => output.MoveNext());
    }

    [Theory]
    [InlineData(2, 0)]
    [InlineData(2, 1)]
    [InlineData(2, 3)]
    [InlineData(0, 2)]
    [InlineData(-1, 2)]
    [InlineData(3, 2)]
    public void ObserveStream_RejectsCommentRosterDeclaredCountOrEnumerationDrift(int declaredCount, int actualCount)
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts[] original = input.Timelines[0].Comments.ToArray();
        var roster = new MisreportedList<CommentScaleTimelineRequestFacts>
        {
            ReportedCount = declaredCount,
            Items = actualCount > original.Length ? [.. original, original[0]] : original.Take(actualCount).ToArray()
        };
        input.Timelines[0] = input.Timelines[0] with
        {
            Comments = roster
        };
        using IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input).GetEnumerator();

        Assert.Throws<InvalidOperationException>(() => output.MoveNext());
    }

    [Theory]
    [InlineData(5, 4)]
    [InlineData(5, 6)]
    [InlineData(0, 5)]
    [InlineData(-1, 5)]
    public void ObserveStream_RejectsEventRosterDeclaredCountOrEnumerationDrift(int declaredCount, int actualCount)
    {
        UnitInputs input = Create();
        CommentScaleTimelineRequestFacts request = input.Timelines[0].Comments[0];
        CommentModerationEvent[] original = request.Timeline.Events.ToArray();
        var events = new MisreportedList<CommentModerationEvent>
        {
            ReportedCount = declaredCount,
            Items = actualCount > original.Length ? [.. original, original[0]] : original.Take(actualCount).ToArray()
        };
        input.Timelines[0] = ReplaceFirst(input.Timelines[0], request with
        {
            Timeline = request.Timeline with
            {
                Events = events
            }
        });
        using IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input).GetEnumerator();

        Assert.Throws<InvalidOperationException>(() => output.MoveNext());
    }

    [Fact]
    public void ObserveStream_ValidatesFinalCommentTimelineBeforeYieldingAnyPartOfOccurrence()
    {
        UnitInputs input = Create();
        input.Timelines[0].Comments[1].Timeline.Events[2].PreviousStatus = CommentModerationStatus.Pending;
        using IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input).GetEnumerator();

        Assert.Throws<InvalidOperationException>(() => output.MoveNext());
    }

    [Fact]
    public void ObserveStream_LaterOccurrenceFailureRetainsOnlyObservedPrefixAndDisposesOwners()
    {
        UnitInputs input = Create();
        input.Timelines[1].Comments[1].Timeline.Events[2].PreviousStatus = CommentModerationStatus.Pending;
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>
        {
            Values = input.Graphs
        };
        var timelines = new TrackedInput<CommentScaleTimelineOccurrenceFacts>
        {
            Values = input.Timelines
        };
        using (IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input, graphs, timelines).GetEnumerator())
        {
            Assert.True(output.MoveNext());
            CommentScaleObservedModerationTimelineGroup root = output.Current;
            Assert.True(output.MoveNext());
            Assert.Equal("child", output.Current.Coordinate?.CommentRole);
            Assert.Throws<InvalidOperationException>(() => output.MoveNext());
            Assert.Equal("root", root.Coordinate?.CommentRole);
            Assert.Equal(5, root.Timeline!.Events.Count);
        }
        Assert.Equal(1, graphs.DisposeCalls);
        Assert.Equal(1, timelines.DisposeCalls);
        Assert.Equal(2, graphs.MoveNextCalls);
        Assert.Equal(2, timelines.MoveNextCalls);
        // No full-enumeration, admission or native-success claim follows this prefix.
    }

    [Theory]
    [InlineData("graph")]
    [InlineData("timeline")]
    public void ObserveStream_PropagatesOwnerEnumerationExceptionAndDisposesBothInputs(string owner)
    {
        UnitInputs input = Create();
        var failure = new InvalidOperationException("synthetic-unit-owner-failure");
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>
        {
            Values = input.Graphs,
            ThrowAt = owner == "graph" ? 1 : null,
            Error = failure
        };
        var timelines = new TrackedInput<CommentScaleTimelineOccurrenceFacts>
        {
            Values = input.Timelines,
            ThrowAt = owner == "timeline" ? 1 : null,
            Error = failure
        };
        using (IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input, graphs, timelines).GetEnumerator())
        {
            Assert.True(output.MoveNext());
            Assert.True(output.MoveNext());
            Assert.Same(failure, Assert.Throws<InvalidOperationException>(() => output.MoveNext()));
        }
        Assert.Equal(1, graphs.DisposeCalls);
        Assert.Equal(1, timelines.DisposeCalls);
    }

    [Fact]
    public void ObserveStream_IsLazyAndDoesNotReadFutureOccurrencesForCurrentCommentGroups()
    {
        UnitInputs input = Create();
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>
        {
            Values = input.Graphs
        };
        var timelines = new TrackedInput<CommentScaleTimelineOccurrenceFacts>
        {
            Values = input.Timelines
        };
        IEnumerable<CommentScaleObservedModerationTimelineGroup> groups = Observe(input, graphs, timelines);
        Assert.Equal(0, graphs.GetEnumeratorCalls);
        Assert.Equal(0, timelines.GetEnumeratorCalls);
        using (IEnumerator<CommentScaleObservedModerationTimelineGroup> output = groups.GetEnumerator())
        {
            Assert.Equal(0, graphs.GetEnumeratorCalls);
            Assert.Equal(0, timelines.GetEnumeratorCalls);
            Assert.True(output.MoveNext());
            Assert.Equal(1, graphs.MoveNextCalls);
            Assert.Equal(1, timelines.MoveNextCalls);
            Assert.True(output.MoveNext());
            Assert.Equal(1, graphs.MoveNextCalls);
            Assert.Equal(1, timelines.MoveNextCalls);
        }
        Assert.Equal(1, graphs.DisposeCalls);
        Assert.Equal(1, timelines.DisposeCalls);
    }

    [Fact]
    public void ObserveStream_SnapshotsOccurrenceCollectionsAndKeepsReadonlyEventMembership()
    {
        UnitInputs input = Create();
        var comments = input.Timelines[0].Comments.ToList();
        var childEvents = comments[1].Timeline.Events.ToList();
        comments[1] = comments[1] with
        {
            Timeline = comments[1].Timeline with
            {
                Events = childEvents
            }
        };
        var roles = input.Timelines[0].Expectations.FactoryRoles.ToList();
        input.Timelines[0] = input.Timelines[0] with
        {
            Comments = comments,
            Expectations = input.Timelines[0].Expectations with
            {
                FactoryRoles = roles
            }
        };
        using IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input).GetEnumerator();
        Assert.True(output.MoveNext());
        Assert.Throws<NotSupportedException>(() => ((IList<CommentModerationEvent>)output.Current.Timeline!.Events).Clear());
        comments.Clear();
        roles.Clear();
        childEvents.Clear();

        Assert.True(output.MoveNext());

        Assert.Equal("child", output.Current.Coordinate?.CommentRole);
        Assert.Equal(5, output.Current.Timeline!.Events.Count);
    }

    [Fact]
    public void ObserveStream_DoesNotClaimDeepImmutabilityOfOriginalCommentOrEventEntities()
    {
        UnitInputs input = Create();
        CommentScaleObservedModerationTimelineGroup group = Observe(input).First();
        Comment originalRow = input.Timelines[0].Comments[0].CurrentComment;
        CommentModerationEvent originalEvent = input.Timelines[0].Comments[0].Timeline.Events[3];
        originalRow.ModerationReason = "synthetic-unit-later-mutation";
        originalEvent.ReasonCode = "synthetic-unit-later-event-mutation";

        Assert.Same(originalRow, group.CurrentComment);
        Assert.Same(originalEvent, group.Timeline!.Events[3]);
        Assert.Equal("synthetic-unit-later-mutation", group.CurrentComment!.ModerationReason);
        Assert.Equal("synthetic-unit-later-event-mutation", group.Timeline.Events[3].ReasonCode);
    }

    [Fact]
    public void ObserveStream_SnapshotsSolePlanBeforeConsumerMutatesOriginalScenarioLists()
    {
        UnitInputs input = Create();
        var requests = input.Plan.Scenarios[0].Comments.ToList();
        var scenarios = input.Plan.Scenarios.ToList();
        scenarios[0] = scenarios[0] with
        {
            Comments = requests
        };
        input = input with
        {
            Plan = input.Plan with
            {
                Scenarios = scenarios
            }
        };
        using IEnumerator<CommentScaleObservedModerationTimelineGroup> output = Observe(input).GetEnumerator();
        Assert.True(output.MoveNext());
        requests.Clear();
        scenarios.Clear();
        var remaining = new List<CommentScaleObservedModerationTimelineGroup>();

        while (output.MoveNext())
        {
            remaining.Add(output.Current);
        }

        Assert.Equal(new[] { "child", "root", "child", null, null }, remaining.Select(group => group.Coordinate?.CommentRole));
        Assert.All(remaining, group => Assert.Equal(input.Plan.ContentDigest, group.Intent.CommentPlanDigest));
    }

    [Theory]
    [InlineData("plan-schema")]
    [InlineData("plan-digest")]
    [InlineData("graph-namespace")]
    [InlineData("graph-comment-plan")]
    [InlineData("graph-article-plan")]
    public void ObserveStream_RefusesPlanOrOriginalGraphIngressDrift(string drift)
    {
        UnitInputs input = Create();
        if (drift == "plan-schema")
        {
            CommentScalePlan invalid = input.Plan with
            {
                Schema = "fsusblog.comment-scale-plan.v1"
            };
            input = input with
            {
                Plan = invalid with
                {
                    ContentDigest = CommentScalePlanContract.ComputeDigest(invalid)
                }
            };
        }
        else if (drift == "plan-digest")
        {
            input = input with
            {
                Plan = input.Plan with
                {
                    ContentDigest = OtherDigest
                }
            };
        }
        else
        {
            input.Graphs[0] = drift switch
            {
                "graph-namespace" => input.Graphs[0] with
                {
                    Namespace = "other"
                },
                "graph-comment-plan" => input.Graphs[0] with
                {
                    CommentPlanDigest = OtherDigest
                },
                _ => input.Graphs[0] with
                {
                    ArticlePlanDigest = OtherDigest
                }
            };
        }

        Assert.Throws<InvalidOperationException>(() => Observe(input).ToArray());
    }

    [Fact]
    public void ObserveStream_InvalidPlanFailsBeforeReadingOwnerFrames()
    {
        UnitInputs input = Create();
        input = input with
        {
            Plan = input.Plan with
            {
                ContentDigest = OtherDigest
            }
        };
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>();
        var timelines = new TrackedInput<CommentScaleTimelineOccurrenceFacts>();

        Assert.Throws<InvalidOperationException>(() => Observe(input, graphs, timelines).ToArray());

        Assert.Equal(0, graphs.MoveNextCalls);
        Assert.Equal(0, timelines.MoveNextCalls);
    }

    [Fact]
    public void ObserveStream_EmptySolePlanRequiresBothInputStreamsEmpty()
    {
        UnitInputs input = Create();
        CommentScalePlan empty = input.Plan with
        {
            Scenarios = [],
            CommentCount = 0,
            ArticleCount = 0
        };
        empty = empty with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(empty)
        };
        Assert.Empty(CanonicalCommentGraphFactory.ObserveModerationTimelineStream(empty, input.Temporal, [], []));
        Assert.Empty(CanonicalCommentGraphFactory.ObserveModerationTimelineBatches(empty, input.Temporal, [], [], 256));
        Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory.ObserveModerationTimelineStream(
            empty, input.Temporal, [input.Graphs[0]], []).ToArray());
        Assert.Throws<InvalidOperationException>(() => CanonicalCommentGraphFactory.ObserveModerationTimelineStream(
            empty, input.Temporal, [], [input.Timelines[0]]).ToArray());
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(4)]
    [InlineData(256)]
    public void ObserveBatches_BoundsCommentGroupsAndPreservesTheirWholeTimelineRosters(int batchSize)
    {
        UnitInputs input = Create();

        IReadOnlyList<CommentScaleObservedModerationTimelineGroup>[] batches = CanonicalCommentGraphFactory
            .ObserveModerationTimelineBatches(input.Plan, input.Temporal, input.Graphs, input.Timelines, batchSize).ToArray();

        Assert.Equal((6 + batchSize - 1) / batchSize, batches.Length);
        Assert.Equal(new[] { "root", "child", "root", "child", null, null },
            batches.SelectMany(batch => batch).Select(group => group.Coordinate?.CommentRole));
        Assert.All(batches, batch =>
        {
            Assert.InRange(batch.Count, 1, batchSize);
            Assert.Throws<NotSupportedException>(() => ((IList<CommentScaleObservedModerationTimelineGroup>)batch).Clear());
            Assert.All(batch.Where(group => group.Coordinate is not null), group => Assert.Equal(5, group.Timeline!.Events.Count));
        });
    }

    [Fact]
    public void ObserveBatches_UsesExactMaximumAndRetainsFinalPartialBatch()
    {
        UnitInputs input = Create(repetitions: 129, includeZero: false);

        IReadOnlyList<CommentScaleObservedModerationTimelineGroup>[] batches = CanonicalCommentGraphFactory
            .ObserveModerationTimelineBatches(input.Plan, input.Temporal, input.Graphs, input.Timelines, 256).ToArray();

        Assert.Equal(256, CanonicalCommentGraphFactory.MaximumIntentsPerBatch);
        Assert.Equal(new[] { 256, 2 }, batches.Select(batch => batch.Count));
        Assert.Equal(input.Graphs.SelectMany(frame => frame.Comments.Select(request =>
            new CommentScaleRequestCoordinate(frame.Occurrence, request.CommentRole))),
            batches.SelectMany(batch => batch).Select(group => group.Coordinate));
    }

    [Fact]
    public void ObserveBatches_StoppedConsumerDoesNotReadBeyondCurrentCompleteOccurrence()
    {
        UnitInputs input = Create();
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>
        {
            Values = input.Graphs
        };
        var timelines = new TrackedInput<CommentScaleTimelineOccurrenceFacts>
        {
            Values = input.Timelines
        };
        using (IEnumerator<IReadOnlyList<CommentScaleObservedModerationTimelineGroup>> output = CanonicalCommentGraphFactory
            .ObserveModerationTimelineBatches(input.Plan, input.Temporal, graphs, timelines, 2).GetEnumerator())
        {
            Assert.True(output.MoveNext());
            Assert.Equal(2, output.Current.Count);
            Assert.Equal(1, graphs.MoveNextCalls);
            Assert.Equal(1, timelines.MoveNextCalls);
        }
        Assert.Equal(1, graphs.DisposeCalls);
        Assert.Equal(1, timelines.DisposeCalls);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(257)]
    public void ObserveBatches_RefusesInvalidBoundsBeforeOpeningOwnerInputs(int batchSize)
    {
        UnitInputs input = Create();
        var graphs = new TrackedInput<CommentScaleGraphFactBindings>();
        var timelines = new TrackedInput<CommentScaleTimelineOccurrenceFacts>();

        Assert.Throws<ArgumentOutOfRangeException>(() => CanonicalCommentGraphFactory.ObserveModerationTimelineBatches(
            input.Plan, input.Temporal, graphs, timelines, batchSize).ToArray());

        Assert.Equal(0, graphs.GetEnumeratorCalls);
        Assert.Equal(0, timelines.GetEnumeratorCalls);
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("temporal")]
    [InlineData("graphs")]
    [InlineData("timelines")]
    public void ObserveStream_RefusesNullRequiredDependencies(string missing)
    {
        UnitInputs input = Create();

        Assert.Throws<ArgumentNullException>(() => CanonicalCommentGraphFactory.ObserveModerationTimelineStream(
            missing == "plan" ? null! : input.Plan, missing == "temporal" ? null! : input.Temporal,
            missing == "graphs" ? null! : input.Graphs, missing == "timelines" ? null! : input.Timelines).ToArray());
    }

    private static IEnumerable<CommentScaleObservedModerationTimelineGroup> Observe(UnitInputs input,
        IEnumerable<CommentScaleGraphFactBindings>? graphs = null,
        IEnumerable<CommentScaleTimelineOccurrenceFacts>? timelines = null)
        => CanonicalCommentGraphFactory.ObserveModerationTimelineStream(input.Plan, input.Temporal,
            graphs ?? input.Graphs, timelines ?? input.Timelines);

    private static CommentScaleTimelineOccurrenceFacts ReplaceFirst(CommentScaleTimelineOccurrenceFacts frame, CommentScaleTimelineRequestFacts first)
        => frame with
        {
            Comments = [first, .. frame.Comments.Skip(1)]
        };

    private static CommentScaleNativeBindingExpectation Expected(DataScaleNativeCommentBindings map)
        => new(map.RunId, map.RuntimeIdentity, map.Provider, map.Allocation,
            new(DataScaleNativeCommentBindings.Schema, map.Digest), map.Ids.Keys.ToArray());

    private static UnitInputs Create(bool anonymous = false, int repetitions = 2, bool includeZero = true)
    {
        string mode = anonymous ? CommentAuthorModes.ZkAnonymous : CommentAuthorModes.Public;
        CommentScaleCredentialValidity credential = anonymous
            ? CommentScaleCredentialValidity.ScaleSyntheticTestOnly : CommentScaleCredentialValidity.PublicAuthenticated;
        CommentScaleCommentRequest Request(string role, string? parent)
            => new(role, parent, parent, mode, credential, UnitDigest, "content." + role,
                new("fsusblog.generated-content-shape.v1", UnitDigest), UnitDigest, "created",
                [new(null, CommentModerationStatus.Pending, "reason.initial", "created")]);
        CommentScaleCommentRequest[] comments = [Request("root", null), Request("child", "root")];
        var requirements = new CommentScaleGraphRequirements(Enum.GetValues<CommentScaleRelation>(),
            Enum.GetValues<CommentScaleAuthority>().Select(authority => new CommentScaleAuthorityReference(
                authority, new string('a', 40), UnitDigest)).ToArray());
        var scenarios = new List<CommentScaleScenario>
        {
            new("thread", CommentScaleThreadShape.DeepChain, "article.thread", repetitions, comments, requirements)
        };
        if (includeZero)
        {
            scenarios.Add(new("empty", CommentScaleThreadShape.ZeroCommentArticle, "article.empty", 2, [], requirements));
        }
        CommentScalePlan plan = new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema,
            "synthetic-unit-timeline", "unit-tier", repetitions * 2, repetitions + (includeZero ? 2 : 0),
            new(ArticleScaleContractIds.PlanSchema, UnitDigest), new(ArticleScaleContractIds.ContentShapeCatalogSchema, UnitDigest),
            new(ArticleScaleContractIds.TemporalArtifactSchema, UnitDigest), scenarios, string.Empty);
        plan = plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };
        var graphs = new List<CommentScaleGraphFactBindings>();
        var timelines = new List<CommentScaleTimelineOccurrenceFacts>();
        foreach (CommentScaleScenario scenario in plan.Scenarios)
        {
            for (long repetition = 0; repetition < scenario.Repetitions; repetition++)
            {
                int index = graphs.Count;
                // Local synthetic test data, never a claimed production allocation algorithm.
                int articleId = index switch
                {
                    0 => 42,
                    1 => 77,
                    2 => 88,
                    3 => 99,
                    _ => 101 + index * 17
                };
                long[] nativeIds = repetition switch
                {
                    0 => [950001, 950003],
                    1 => [970007, 970011],
                    _ => [1100001 + repetition * 101, 1100003 + repetition * 101]
                };
                var occurrence = new CommentScaleGraphOccurrence(scenario.Role, repetition, scenario.ArticleTargetRole);
                graphs.Add(new(occurrence, plan.Namespace, plan.ContentDigest, plan.ArticlePlan.ContentDigest,
                    "synthetic-original-article." + articleId, articleId, new(ArticleScaleGraphIdentityBindings.Schema, UnitDigest),
                    scenario.Comments.Select(request => new CommentScaleRequestFactBinding(request.Role, request.ContentRole,
                        request.ContentArtifact, PolicyFacts(request, articleId, nativeIds[0], anonymous))).ToArray()));
                var ids = new Dictionary<DataScaleNativeCommentRole, long>();
                var requests = new List<CommentScaleTimelineRequestFacts>();
                for (int position = 0; position < scenario.Comments.Count; position++)
                {
                    CommentScaleCommentRequest request = scenario.Comments[position];
                    string entityRole = "current." + request.Role;
                    long commentId = nativeIds[position];
                    ids.Add(new(scenario.Role, repetition, scenario.ArticleTargetRole, request.Role,
                        DataScaleNativeCommentEntity.Comment, entityRole), commentId);
                    var row = new Comment
                    {
                        Id = commentId,
                        ArticleId = articleId,
                        Content = "synthetic owner observed content",
                        CreateTime = s_time,
                        AuthorMode = mode,
                        UserId = anonymous ? null : 7,
                        ParentId = position == 0 ? null : nativeIds[0],
                        RootId = position == 0 ? null : nativeIds[0],
                        ReplyToCommentId = position == 0 ? null : nativeIds[0],
                        ReplyToUserId = position == 0 || anonymous ? null : 8,
                        Depth = position,
                        ModerationStatus = CommentModerationStatus.Hidden,
                        ModerationReason = "synthetic-unit-owner-reason",
                        AnonymousRequiresModeration = false
                    };
                    requests.Add(new(request.Role, entityRole, row, Timeline(commentId)));
                }
                var allocation = new DataScaleNativeAllocationReference("synthetic-unit-only-owner", new string('a', 40), UnitDigest);
                var map = new DataScaleNativeCommentBindings("synthetic-unit-run", plan.Namespace, "synthetic-unit-runtime", "PostgreSql",
                    plan.ContentDigest, plan.ArticlePlan.ContentDigest, allocation, ids);
                timelines.Add(new(occurrence, map, Expected(map), requests.ToArray()));
            }
        }
        return new UnitInputs
        {
            Plan = plan,
            Temporal = Temporal(),
            Graphs = graphs.ToArray(),
            Timelines = timelines.ToArray()
        };
    }

    private static CommentModerationTimelineResult Timeline(long commentId)
        => new(commentId, CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, true,
            [Event(8011, commentId, null, CommentModerationStatus.Pending, "create"),
             Event(8023, commentId, CommentModerationStatus.Pending, CommentModerationStatus.Approved, "approve"),
             Event(8057, commentId, CommentModerationStatus.Approved, CommentModerationStatus.Hidden, "hide"),
             Event(8099, commentId, CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, "appeal"),
             Event(8121, commentId, CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, "appeal_decision")]);

    private static CommentModerationEvent Event(long id, long commentId, CommentModerationStatus? previous,
        CommentModerationStatus next, string eventType = "synthetic-unit-event")
        => new()
        {
            Id = id,
            CommentId = commentId,
            EventType = eventType,
            PreviousStatus = previous,
            NextStatus = next,
            ActorType = "synthetic-unit-actor",
            ReasonCode = "synthetic-unit-reason",
            PolicyVersion = "synthetic-unit-policy",
            ModelVersion = "synthetic-unit-model",
            TransitionSource = "synthetic-unit-transition-source",
            AdminPrincipalId = 91,
            AppealId = 61,
            OccurredAtUtc = s_time.AddDays(2).AddMilliseconds(id)
        };

    private static CommentScalePolicyFacts PolicyFacts(CommentScaleCommentRequest request, int articleId, long rootId, bool anonymous)
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
        long? observedRoot = request.ParentRole is null ? null : rootId;
        return new(articleId, observedRoot, site, article,
            observedRoot is null ? null : new CommentThreadPolicy
            {
                ArticleId = articleId,
                RootCommentId = observedRoot.Value,
                PolicyVersion = 3
            }, actor, UnitDigest, region, UnitDigest, true, false, false, request.ParentRole is null ? null : 8);
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
            roles = new[] { "created" }.Select(role => new
            {
                roleId = role,
                clockKind = "business-wall",
                semanticEffect = "included",
                precision = "millisecond",
                instantUtc = s_time.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
            })
        }), UnitDigest);

    private sealed record UnitInputs
    {
        public required CommentScalePlan Plan
        {
            get; init;
        }
        public required ResolvedTemporalRoleContext Temporal
        {
            get; init;
        }
        public required CommentScaleGraphFactBindings[] Graphs
        {
            get; init;
        }
        public required CommentScaleTimelineOccurrenceFacts[] Timelines
        {
            get; init;
        }
    }

    private sealed class MisreportedList<T> : IReadOnlyList<T>
    {
        public IReadOnlyList<T> Items { get; init; } = [];
        public int ReportedCount
        {
            get; init;
        }
        public int Count => ReportedCount;
        public T this[int index] => Items[index];
        public IEnumerator<T> GetEnumerator() => Items.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class TrackedInput<T> : IEnumerable<T>
    {
        public IReadOnlyList<T> Values { get; init; } = [];
        public int? ThrowAt
        {
            get; init;
        }
        public Exception? Error
        {
            get; init;
        }
        public int GetEnumeratorCalls
        {
            get; private set;
        }
        public int MoveNextCalls
        {
            get; private set;
        }
        public int DisposeCalls
        {
            get; private set;
        }

        public IEnumerator<T> GetEnumerator()
        {
            GetEnumeratorCalls++;
            return Enumerate().GetEnumerator();
        }

        private IEnumerable<T> Enumerate()
        {
            try
            {
                for (int index = 0; index <= Values.Count; index++)
                {
                    MoveNextCalls++;
                    if (index == ThrowAt)
                    {
                        throw Error!;
                    }
                    if (index == Values.Count)
                    {
                        yield break;
                    }
                    yield return Values[index];
                }
            }
            finally
            {
                DisposeCalls++;
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
