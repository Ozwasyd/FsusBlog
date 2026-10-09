using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

using Microsoft.Extensions.DependencyInjection.Extensions;

using SqlSugar;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>Explicit composition of the canonical transport and sole jobs; no default authorities or worker launch.</summary>
public static class DocumentExportServiceCollectionExtensions
{
    /// <summary>
    /// Compose the original persisted source catalog after its database/schema authorities are supplied.
    /// Registration performs no query, migration, transport activation or worker launch.
    /// </summary>
    public static IServiceCollection AddDocumentExportSourceCatalog(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        RequireSingleScopedAuthority<ISqlSugarClient>(services);
        RequireSingleScopedAuthority<IAuthoringDraftLifecycle>(services);
        RequireSingleScopedAuthority<IAuthorRecentArticleHistoryPersistedPermissionReader>(services);
        RequireSingleScopedAuthority<SqlAuthorRecentArticleHistoryPermissionAuthority>(services);
        RequireSingleSingletonAuthority<IHttpContextAccessor>(services);
        RequireSingleSingletonAuthority<IConfiguration>(services);
        if (services.Any(descriptor => descriptor.ServiceType == typeof(IDocumentExportSourceCatalog)
            || descriptor.ServiceType == typeof(DocumentExportSourceCatalog)
            || descriptor.ServiceType == typeof(DocumentExportSourceCatalogStore)))
        {
            throw new InvalidOperationException("document_export_source_catalog_already_registered");
        }
        services.AddScoped<DocumentExportSourceCatalogStore>();
        services.AddScoped<IDocumentExportSourceCatalog, DocumentExportSourceCatalog>();
        return services;
    }

    /// <summary>
    /// Bind HTTP transport to the original scoped permission projection and
    /// authenticated context accessor. All authorities must already be present;
    /// this entry supplies neither persisted source facts nor a worker principal.
    /// </summary>
    public static IServiceCollection AddDocumentExportHttpTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        RequireHttpAuthorities(services);
        RequireTransportUnregistered(services);
        RequireAuthorizationUnregistered(services);
        services.AddScoped<IDocumentExportJobAuthorization, DocumentExportHttpJobAuthorization>();
        return services.AddDocumentExportTransport();
    }

    /// <summary>
    /// Explicitly compose transport with the canonical persisted session reader.
    /// HTTP token admission remains in the original host; workers recheck the
    /// stored actor's live session through the same scoped permission reader.
    /// </summary>
    public static IServiceCollection AddDocumentExportSessionTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        RequireHttpAuthorities(services);
        RequireSingleScopedAuthority<IAuthorRecentArticleHistoryPersistedPermissionReader>(services);
        RequireTransportUnregistered(services);
        RequireAuthorizationUnregistered(services);
        services.AddScoped<IDocumentExportJobAuthorization, DocumentExportSessionJobAuthorization>();
        return services.AddDocumentExportTransport();
    }

    private static void RequireHttpAuthorities(IServiceCollection services)
    {
        RequireSelectionAuthorities(services);
        RequireSingleScopedAuthority<IDocumentExportFrozenSourceReader>(services);
        RequireSingleScopedAuthority<IAuthorRecentArticleHistoryPermissionProjectionProvider>(services);
        RequireSingleSingletonAuthority<IHttpContextAccessor>(services);
    }

    private static void RequireAuthorizationUnregistered(IServiceCollection services)
    {
        if (services.Any(descriptor => descriptor.ServiceType == typeof(IDocumentExportJobAuthorization)
            || descriptor.ServiceType == typeof(DocumentExportHttpJobAuthorization)
            || descriptor.ServiceType == typeof(DocumentExportSessionJobAuthorization)))
        {
            throw new InvalidOperationException("document_export_transport_already_registered");
        }
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
        RequireSelectionAuthorities(services);
        RequireTransportUnregistered(services);
        services.TryAddScoped<DocumentExportJobService>();
        services.AddScoped<IDocumentExportJobs>(provider => provider.GetRequiredService<DocumentExportJobService>());
        services.AddScoped<IDocumentExportRequestFreezer, DocumentExportRequestFreezer>();
        services.AddScoped<IDocumentExportEndpointBinding, DocumentExportEndpointBinding>();
        services.AddScoped<DocumentExportSourceSelectionAdapter>();
        return services;
    }

    private static void RequireSelectionAuthorities(IServiceCollection services)
    {
        RequireSingleScopedAuthority<IDocumentExportSourceCatalog>(services);
        RequireSingleScopedAuthority<IBinaryEndpointRequestContext>(services);
    }

    private static void RequireTransportUnregistered(IServiceCollection services)
    {
        if (services.Any(descriptor => descriptor.ServiceType == typeof(IDocumentExportJobs)
            || descriptor.ServiceType == typeof(IDocumentExportRequestFreezer)
            || descriptor.ServiceType == typeof(IDocumentExportEndpointBinding)
            || descriptor.ServiceType == typeof(DocumentExportSourceSelectionAdapter)))
        {
            throw new InvalidOperationException("document_export_transport_already_registered");
        }
        ServiceDescriptor[] jobs = services.Where(descriptor =>
            descriptor.ServiceType == typeof(DocumentExportJobService)).ToArray();
        if (jobs.Length > 1 || jobs.Any(descriptor => descriptor.IsKeyedService
            || descriptor.Lifetime != ServiceLifetime.Scoped))
        {
            throw new InvalidOperationException("document_export_required_authority_unregistered");
        }
    }

    private static void RequireSingleScopedAuthority<T>(IServiceCollection services)
    {
        ServiceDescriptor[] descriptors = services.Where(descriptor => descriptor.ServiceType == typeof(T)).ToArray();
        if (descriptors.Length != 1 || descriptors[0].IsKeyedService
            || descriptors[0].Lifetime != ServiceLifetime.Scoped)
        {
            throw new InvalidOperationException("document_export_required_authority_unregistered");
        }
    }

    private static void RequireSingleSingletonAuthority<T>(IServiceCollection services)
    {
        ServiceDescriptor[] descriptors = services.Where(descriptor => descriptor.ServiceType == typeof(T)).ToArray();
        if (descriptors.Length != 1 || descriptors[0].IsKeyedService
            || descriptors[0].Lifetime != ServiceLifetime.Singleton)
        {
            throw new InvalidOperationException("document_export_required_authority_unregistered");
        }
    }
}
