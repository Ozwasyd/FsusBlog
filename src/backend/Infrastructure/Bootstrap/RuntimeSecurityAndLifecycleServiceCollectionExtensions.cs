using Fido2NetLib;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class RuntimeSecurityAndLifecycleServiceCollectionExtensions
{
    public static IServiceCollection AddFsusRuntimeSecurityAndLifecycleServices(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<IFido2>(_ => new Fido2(new Fido2Configuration
        {
            ServerDomain = configuration["Fido2:ServerDomain"] ?? "localhost",
            ServerName = configuration["Fido2:ServerName"] ?? "FsusBlog",
            Origins = configuration.GetSection("Fido2:Origins").Get<HashSet<string>>() ?? ["https://localhost"],
            TimestampDriftTolerance = 300000,
        }));
        services.AddScoped<IPasskeyService, PasskeyService>();
        services.AddScoped<IAdminPrincipalService, AdminPrincipalService>();
        services.AddScoped<IAdminSessionValidationService, AdminSessionValidationService>();
        services.AddScoped<IRecoveryKeyService, RecoveryKeyService>();
        services.TryAddSingleton<IZkProofVerifier, DisabledZkProofVerifier>();
        services.AddScoped<IZkAnonymousProofService, ZkAnonymousProofService>();
        services.AddSingleton<IAnonymousCommentPolicyService, AnonymousCommentPolicyService>();
        services.AddScoped<IAnonymousCredentialService, AnonymousCredentialService>();
        services.AddScoped<ICommentAnonymousNullifierService, CommentAnonymousNullifierService>();
        services.AddSingleton<ICommentAnonymousDisplayNameGenerator, CommentAnonymousDisplayNameGenerator>();
        services.AddScoped<ICommentActorResolver, CommentActorResolver>();
        services.AddScoped<ITotpService, TotpService>();
        services.AddScoped<IMfaChallengeService, MfaChallengeService>();
        services.AddScoped<IAuthRiskService, AuthRiskService>();
        services.AddScoped<IRiskControlContextFactory, RiskControlContextFactory>();
        services.AddScoped<IRiskDecisionService, RiskDecisionService>();
        services.AddScoped<ISecurityChallengePersistenceService, SecurityChallengePersistenceService>();

        services.Configure<LifecycleBootstrapOptions>(configuration.GetSection(LifecycleBootstrapOptions.SectionName));

        services.AddScoped<ICacheInitializer, CacheInitializer>();
        services.AddSingleton<ISchemaMigrationRegistry, SchemaMigrationRegistry>();
        services.AddSingleton<ISchemaModelInspector, SchemaModelInspector>();
        services.AddSingleton<ISchemaMigrationLock, SchemaMigrationLock>();
        services.AddScoped<ISchemaMigrationRunner, SchemaMigrationRunner>();
        services.AddScoped<LegacyIdentityColdStartResetOperation>();
        services.AddScoped<ILegacyIdentityColdStartResetOperation>(sp => sp.GetRequiredService<LegacyIdentityColdStartResetOperation>());
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            services.AddHostedService<ProductionStartupValidationHostedService>();
            services.AddHostedService<LifecycleHostedBootstrapService>();
        }

        return services;
    }
}
