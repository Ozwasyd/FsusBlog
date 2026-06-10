using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Modules.Endpoints;

public static class TelemetryEndpoints
{
    public static IEndpointRouteBuilder MapTelemetryEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/telemetry")
            .WithTags("Telemetry")
            .AllowAnonymous();

        group.MapPost("/rum", async (
            RumMetricRequest request,
            IRumTelemetryService service,
            CancellationToken cancellationToken) =>
        {
            RumMetricIngestResponse response = await service.IngestAsync(request, cancellationToken);
            return Results.Ok(JsonApiResponse<RumMetricIngestResponse>.Ok(response));
        })
        .RequireRateLimiting("fixed_ip");

        return app;
    }
}
