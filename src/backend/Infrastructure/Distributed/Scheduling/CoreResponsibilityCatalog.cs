using FsusBlog.Server.Infrastructure.Distributed.Cluster;

namespace FsusBlog.Server.Infrastructure.Distributed.Scheduling;

public static class CoreResponsibilityCatalog
{
    private static readonly ResponsibilityResourceProfile s_balanced =
        new(0.24, 0.20, 0.12, 0.18, 0.16, 0.10);
    private static readonly SchedulingPolicy s_defaultPolicy =
        new(
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(20),
            0.08,
            0.04,
            0.72,
            0.42);

    public static readonly ResponsibilityDescriptor WebApiListener =
        Descriptor("web.api.listener", ClusterCapabilities.WebApi, ResponsibilityKind.Listener, 1, 8);
    public static readonly ResponsibilityDescriptor CommentAuditConsumer =
        Descriptor("comment.audit.consumer", ClusterCapabilities.CommentAudit, ResponsibilityKind.Consumer, 1, 8);
    public static readonly ResponsibilityDescriptor AntispamInferenceWorker =
        Descriptor("antispam.inference.worker", ClusterCapabilities.AntispamInference, ResponsibilityKind.Worker, 1, 8);
    public static readonly ResponsibilityDescriptor SearchIndexerWorker =
        Descriptor("search.indexer.worker", ClusterCapabilities.SearchIndexer, ResponsibilityKind.Worker, 1, 8);
    public static readonly ResponsibilityDescriptor MediaProcessorWorker =
        Descriptor("media.processor.worker", ClusterCapabilities.MediaProcessor, ResponsibilityKind.Worker, 1, 8);
    public static readonly ResponsibilityDescriptor SchedulerBackgroundWorker =
        Descriptor("scheduler.background.worker", ClusterCapabilities.SchedulerWorker, ResponsibilityKind.Worker, 1, 4);
    public static readonly ResponsibilityDescriptor SseFanoutWorker =
        Descriptor("sse.fanout.worker", ClusterCapabilities.WebApi, ResponsibilityKind.Fanout, 1, 8);

    public static IReadOnlyList<ResponsibilityDescriptor> All
    {
        get;
    } =
    [
        WebApiListener,
        CommentAuditConsumer,
        AntispamInferenceWorker,
        SearchIndexerWorker,
        MediaProcessorWorker,
        SchedulerBackgroundWorker,
        SseFanoutWorker
    ];

    public static ResponsibilityDescriptor Get(ResponsibilityId id)
        => All.SingleOrDefault(descriptor => descriptor.Id == id)
            ?? throw new InvalidOperationException($"responsibility_unknown:{id}");

    private static ResponsibilityDescriptor Descriptor(
        string id,
        CapabilityId capability,
        ResponsibilityKind kind,
        int minReplicas,
        int maxReplicas)
        => new ResponsibilityDescriptor(
            new ResponsibilityId(id),
            capability,
            kind,
            minReplicas,
            maxReplicas,
            s_balanced,
            s_defaultPolicy).Validate();
}
