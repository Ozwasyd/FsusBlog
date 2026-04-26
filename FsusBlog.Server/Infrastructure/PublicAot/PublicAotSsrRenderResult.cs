namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record class PublicAotSsrRenderResult(
    string Html,
    string RendererVersion);
