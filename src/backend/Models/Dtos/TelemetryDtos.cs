namespace FsusBlog.Server.Models.Dtos;

public sealed record class RumMetricRequest(
    string Name,
    string PageType,
    string AotSource,
    double? Value,
    IReadOnlyDictionary<string, double>? Metrics,
    DateTime? Timestamp);

public sealed record class RumMetricIngestResponse(bool Accepted);
