using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Synthetic production DTOs prove ordinary verifier logic only, without terminal or native acceptance.</summary>
public sealed class CommentFixtureTimelineVerifierTests
{
    private const long CommentId = 41;
    private static readonly DateTime s_now = new(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ContinuousTimeline_AcceptsInitialTransitionsAndUnchangedStatusEvents()
    {
        CommentModerationEvent[] events =
        [
            Event(30, null, CommentModerationStatus.Pending, CommentModerationEventTypes.Create),
            Event(31, CommentModerationStatus.Pending, CommentModerationStatus.Approved, CommentModerationEventTypes.Approve),
            Event(32, CommentModerationStatus.Approved, CommentModerationStatus.Hidden, CommentModerationEventTypes.Hide),
            Event(33, CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, CommentModerationEventTypes.Appeal),
            Event(34, CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, CommentModerationEventTypes.AppealDecision)
        ];
        AssertBoth(true, events, CommentModerationStatus.Hidden);
        AssertBoth(true, [events[0]], CommentModerationStatus.Pending);
    }

    [Fact]
    public void MissingOrUnboundTimeline_RefusesMissingFactsAndProductionRejection()
    {
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(null, CommentId, CommentModerationStatus.Approved));
        Assert.False(CommentFixtureTimelineVerifier.IsContinuous(null, CommentModerationStatus.Approved));
        AssertBoth(false, [], CommentModerationStatus.Approved);
        CommentModerationEvent[] events = [Event(30, null, CommentModerationStatus.Approved)];
        CommentModerationTimelineResult timeline = Timeline(events, CommentModerationStatus.Approved);
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(timeline with
        {
            Consistent = false
        }, CommentId,
            CommentModerationStatus.Approved));
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(timeline with
        {
            CommentId = 42
        }, CommentId,
            CommentModerationStatus.Approved));
        events[0].CommentId = 42;
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(timeline, CommentId, CommentModerationStatus.Approved));
        AssertBoth(false, [Event(0, null, CommentModerationStatus.Approved)], CommentModerationStatus.Approved);
    }

    [Fact]
    public void InitialStatus_RefusesNonNullPredecessorDespiteConsistentFlag()
    {
        AssertBoth(false, [Event(30, CommentModerationStatus.Pending, CommentModerationStatus.Approved)],
            CommentModerationStatus.Approved);
    }

    [Fact]
    public void AdjacentStatus_RefusesBrokenNullOrReorderedPredecessors()
    {
        CommentModerationEvent first = Event(30, null, CommentModerationStatus.Approved);
        AssertBoth(false,
            [first, Event(31, CommentModerationStatus.Pending, CommentModerationStatus.Hidden)],
            CommentModerationStatus.Hidden);
        AssertBoth(false, [first, Event(31, null, CommentModerationStatus.Hidden)], CommentModerationStatus.Hidden);
        CommentModerationEvent second = Event(31, CommentModerationStatus.Approved, CommentModerationStatus.Hidden);
        AssertBoth(false, [second, first], CommentModerationStatus.Approved);
    }

    [Fact]
    public void FinalStatus_RefusesEventProjectionReadProjectionAndRowDisagreement()
    {
        CommentModerationEvent[] events = [Event(30, null, CommentModerationStatus.Approved)];
        AssertBoth(false, events, CommentModerationStatus.Hidden);
        CommentModerationTimelineResult timeline = Timeline(events, CommentModerationStatus.Approved);
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(
            timeline with
            {
                ProjectedStatus = CommentModerationStatus.Hidden
            }, CommentId, CommentModerationStatus.Approved));
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(
            timeline with
            {
                CurrentStatus = CommentModerationStatus.Hidden
            }, CommentId, CommentModerationStatus.Approved));
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(timeline, CommentId, CommentModerationStatus.Hidden));
    }

    [Fact]
    public void RepeatedIdentity_RefusesAdjacentAndNonAdjacentDuplicates()
    {
        CommentModerationEvent first = Event(30, null, CommentModerationStatus.Approved);
        AssertBoth(false,
            [first, Event(30, CommentModerationStatus.Approved, CommentModerationStatus.Hidden)],
            CommentModerationStatus.Hidden);
        AssertBoth(false,
            [first, Event(31, CommentModerationStatus.Approved, CommentModerationStatus.Hidden),
                Event(30, CommentModerationStatus.Hidden, CommentModerationStatus.Approved)],
            CommentModerationStatus.Approved);
    }

    [Fact]
    public void GrantedAppealGap_RefusesProductionShapeWithoutRepairingFacts()
    {
        CommentModerationEvent[] events =
        [
            Event(30, null, CommentModerationStatus.Approved, CommentModerationEventTypes.Create),
            Event(31, CommentModerationStatus.Approved, CommentModerationStatus.Hidden, CommentModerationEventTypes.Hide),
            Event(32, CommentModerationStatus.Hidden, CommentModerationStatus.Hidden, CommentModerationEventTypes.Appeal),
            Event(33, CommentModerationStatus.Approved, CommentModerationStatus.Approved, CommentModerationEventTypes.AppealDecision)
        ];
        events[3].ReasonCode = "appeal_granted";
        events[3].AdminPrincipalId = 92;
        events[3].AppealId = 61;
        CommentFixtureModerationEventObservation[] observations = Observe(events);
        CommentFixtureModerationEventObservation[] original = [.. observations];
        AssertBoth(false, events, CommentModerationStatus.Approved);
        Assert.False(CommentFixtureTimelineVerifier.IsConsistent(
            Timeline(events, CommentModerationStatus.Approved) with
            {
                Consistent = false
            }, CommentId,
            CommentModerationStatus.Approved));
        Assert.False(CommentFixtureTimelineVerifier.IsContinuous(observations, CommentModerationStatus.Approved));
        Assert.Equal(original, observations);
        Assert.Equal(CommentModerationStatus.Approved, events[3].PreviousStatus);
        Assert.Equal("appeal_granted", events[3].ReasonCode);
        Assert.Equal(92, events[3].AdminPrincipalId);
        Assert.Equal(61, events[3].AppealId);
    }

    private static void AssertBoth(bool expected, CommentModerationEvent[] events, CommentModerationStatus currentStatus)
    {
        Assert.Equal(expected, CommentFixtureTimelineVerifier.IsConsistent(Timeline(events, currentStatus), CommentId,
            currentStatus));
        Assert.Equal(expected, CommentFixtureTimelineVerifier.IsContinuous(Observe(events), currentStatus));
    }

    private static CommentModerationTimelineResult Timeline(CommentModerationEvent[] events,
        CommentModerationStatus currentStatus)
        => new(CommentId, currentStatus, currentStatus, true, events);

    private static CommentFixtureModerationEventObservation[] Observe(CommentModerationEvent[] events)
        => [.. events.Select(item => new CommentFixtureModerationEventObservation(item.Id, item.EventType,
            item.PreviousStatus, item.NextStatus, item.ActorType, item.ReasonCode, item.PolicyVersion, item.ModelVersion,
            item.TransitionSource, item.AdminPrincipalId, item.AppealId, item.OccurredAtUtc))];

    private static CommentModerationEvent Event(long id, CommentModerationStatus? previous, CommentModerationStatus next,
        string eventType = CommentModerationEventTypes.Create)
        => new()
        {
            Id = id,
            CommentId = CommentId,
            PreviousStatus = previous,
            NextStatus = next,
            EventType = eventType,
            OccurredAtUtc = s_now
        };
}
