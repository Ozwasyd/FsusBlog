using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed class BoundedQueueDeliveryCatalog : IBoundedQueueDrainCatalog
{
    public const string ResourceName = "FsusBlog.BoundedChannelDeliveryContracts.json";
    public const string SchemaName = "fsusblog.bounded-channel-delivery-contracts.v1";

    private static readonly Lazy<BoundedQueueDeliveryCatalog> s_embedded = new(LoadEmbedded, LazyThreadSafetyMode.ExecutionAndPublication);

    public BoundedQueueDeliveryCatalog(string digest, IReadOnlyList<BoundedChannelQueueContract> queues)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(digest);
        ArgumentNullException.ThrowIfNull(queues);
        var queueList = queues.ToArray();
        if (queueList.Length == 0)
        {
            throw new InvalidOperationException("bounded channel delivery catalog has no queues");
        }

        if (queueList.Any(static queue => string.IsNullOrWhiteSpace(queue.QueueId)))
        {
            throw new InvalidOperationException("bounded channel delivery catalog contains a queue without an id");
        }

        if (queueList.GroupBy(static queue => queue.QueueId, StringComparer.Ordinal).Any(static group => group.Count() != 1))
        {
            throw new InvalidOperationException("bounded channel delivery catalog contains duplicate queue ids");
        }

        var participantList = queueList
            .Where(static queue => queue.DrainParticipant)
            .OrderBy(static queue => queue.QueueId, StringComparer.Ordinal)
            .ToArray();
        if (participantList.Any(static queue => string.IsNullOrWhiteSpace(queue.ParticipantAdapterToken)))
        {
            throw new InvalidOperationException("bounded channel drain participant is missing its adapter token");
        }

        if (participantList
            .GroupBy(static queue => queue.ParticipantAdapterToken, StringComparer.Ordinal)
            .Any(static group => group.Count() != 1))
        {
            throw new InvalidOperationException("bounded channel delivery catalog contains duplicate drain participant adapters");
        }

        Digest = digest;
        Queues = queueList;
        DrainParticipants = participantList;
    }

    public string Digest { get; }

    public IReadOnlyList<BoundedChannelQueueContract> Queues { get; }

    public IReadOnlyList<BoundedChannelQueueContract> DrainParticipants { get; }

    public static BoundedQueueDeliveryCatalog Embedded => s_embedded.Value;

    public static BoundedQueueDeliveryCatalog LoadEmbedded()
    {
        using Stream stream = typeof(BoundedQueueDeliveryCatalog).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("bounded channel delivery catalog resource is missing");
        using var document = JsonDocument.Parse(stream);
        return Parse(document.RootElement);
    }

    public static BoundedQueueDeliveryCatalog LoadFromPath(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        return Parse(document.RootElement);
    }

    public static BoundedQueueDeliveryCatalog Parse(JsonElement root)
    {
        string schema = root.GetProperty("schema").GetString()
            ?? throw new InvalidOperationException("bounded channel catalog schema is missing");
        if (!string.Equals(schema, SchemaName, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("bounded channel catalog schema is unknown");
        }

        string digest = root.GetProperty("digest").GetString()
            ?? throw new InvalidOperationException("bounded channel catalog digest is missing");
        var queues = new List<BoundedChannelQueueContract>();
        foreach (JsonElement queue in root.GetProperty("queues").EnumerateArray())
        {
            bool drainParticipant = queue.GetProperty("drainParticipant").GetBoolean();
            string? participantAdapterToken = null;
            if (drainParticipant)
            {
                if (!queue.TryGetProperty("participantAdapter", out JsonElement adapter)
                    || !adapter.TryGetProperty("token", out JsonElement token)
                    || string.IsNullOrWhiteSpace(token.GetString()))
                {
                    throw new InvalidOperationException("bounded channel drain participant adapter is missing");
                }

                participantAdapterToken = token.GetString();
            }

            queues.Add(new BoundedChannelQueueContract(
                queue.GetProperty("queueId").GetString() ?? throw new InvalidOperationException("queueId missing"),
                queue.GetProperty("deliveryClass").GetString() ?? throw new InvalidOperationException("deliveryClass missing"),
                drainParticipant,
                participantAdapterToken,
                queue.GetProperty("failureSemantics").GetProperty("qualificationImpact").GetString()
                    ?? string.Empty));
        }

        return new BoundedQueueDeliveryCatalog(digest, queues);
    }
}
