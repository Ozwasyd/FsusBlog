using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>Explicit composition of the canonical transport and sole jobs; no default authorities or worker launch.</summary>
public static class DocumentExportServiceCollectionExtensions
{
    /// <summary>
    /// Bind HTTP transport to the original scoped permission projection and
    /// authenticated context accessor. All authorities must already be present;
    /// this entry supplies neither persisted source facts nor a worker principal.
    /// </summary>
    public static IServiceCollection AddDocumentExportHttpTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        RequireSingleScopedAuthority<IDocumentExportFrozenSourceReader>(services);
        RequireSingleScopedAuthority<IAuthorRecentArticleHistoryPermissionProjectionProvider>(services);
        ServiceDescriptor[] contexts = services.Where(descriptor =>
            descriptor.ServiceType == typeof(IHttpContextAccessor)).ToArray();
        if (contexts.Length != 1 || contexts[0].Lifetime != ServiceLifetime.Singleton)
        {
            throw new InvalidOperationException("document_export_required_authority_unregistered");
        }
        RequireTransportUnregistered(services);
        if (services.Any(descriptor => descriptor.ServiceType == typeof(IDocumentExportJobAuthorization)
            || descriptor.ServiceType == typeof(DocumentExportHttpJobAuthorization)))
        {
            throw new InvalidOperationException("document_export_transport_already_registered");
        }
        services.AddScoped<IDocumentExportJobAuthorization, DocumentExportHttpJobAuthorization>();
        return services.AddDocumentExportTransport();
    }

    /// <summary>
    /// Compose only after the host has explicitly registered the real full-source
    /// reader and live job authorization. Storage, data protection, encoder and
    /// binary request-context ports retain their original host registrations.
    /// This method is not called by the general bootstrap while those facts are missing.
    /// </summary>
    public static IServiceCollection AddDocumentExportTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        RequireSingleScopedAuthority<IDocumentExportFrozenSourceReader>(services);
        RequireSingleScopedAuthority<IDocumentExportJobAuthorization>(services);
        RequireTransportUnregistered(services);
        services.TryAddScoped<DocumentExportJobService>();
        services.AddScoped<IDocumentExportJobs>(provider => provider.GetRequiredService<DocumentExportJobService>());
        services.AddScoped<IDocumentExportRequestFreezer, DocumentExportRequestFreezer>();
        services.AddScoped<IDocumentExportEndpointBinding, DocumentExportEndpointBinding>();
        return services;
    }

    private static void RequireTransportUnregistered(IServiceCollection services)
    {
        if (services.Any(descriptor => descriptor.ServiceType == typeof(IDocumentExportJobs)
            || descriptor.ServiceType == typeof(IDocumentExportRequestFreezer)
            || descriptor.ServiceType == typeof(IDocumentExportEndpointBinding)))
        {
            throw new InvalidOperationException("document_export_transport_already_registered");
        }
    }

    private static void RequireSingleScopedAuthority<T>(IServiceCollection services)
    {
        ServiceDescriptor[] descriptors = services.Where(descriptor => descriptor.ServiceType == typeof(T)).ToArray();
        if (descriptors.Length != 1 || descriptors[0].Lifetime != ServiceLifetime.Scoped)
        {
            throw new InvalidOperationException("document_export_required_authority_unregistered");
        }
    }
}
