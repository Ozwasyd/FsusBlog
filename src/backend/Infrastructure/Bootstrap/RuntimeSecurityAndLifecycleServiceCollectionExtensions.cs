using Fido2NetLib;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public static class RuntimeSecurityAndLifecycleServiceCollectionExtensions
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
        services.AddScoped<IPasskeyProjectionConsistencyService, PasskeyProjectionConsistencyService>();
        services.AddScoped<IUserSecurityStepUpService, UserSecurityStepUpService>();
        services.AddScoped<AdminPrincipalService>();
        services.AddScoped<IAdminPrincipalService>(provider => provider.GetRequiredService<AdminPrincipalService>());
        services.AddScoped<IAdminSessionIssuancePort>(provider => provider.GetRequiredService<AdminPrincipalService>());
        AdminSessionProjectionRuntimeOptions adminSessionProjectionOptions =
            AdminSessionProjectionRuntimeOptions.FromConfiguration(configuration);
        services.AddSingleton(adminSessionProjectionOptions);
        services.AddSingleton(provider => new AdminSessionProjection(
            adminSessionProjectionOptions.ProjectionLimits,
            provider.GetRequiredService<TimeProvider>()));
        services.AddScoped<IAdminSessionProjectionAuthorityReader, AdminSessionProjectionAuthorityReader>();
        services.AddScoped<IAdminSessionProjectionMutationCoordinator, AdminSessionProjectionMutationCoordinator>();
        services.AddSingleton<AdminSessionTouchScheduler>();
        services.AddSingleton<IAdminSessionTouchScheduler>(provider =>
            provider.GetRequiredService<AdminSessionTouchScheduler>());
        services.AddScoped<IAdminSessionValidationService, AdminSessionValidationService>();
        services.AddSingleton<IUserSessionValidationCache, UserSessionValidationCache>();
        services.AddSingleton<IUserSessionDbFallbackGate, UserSessionDbFallbackGate>();
        services.AddScoped<IUserSessionValidationService, UserSessionValidationService>();
        services.AddScoped<IRecoveryKeyService, RecoveryKeyService>();
        if (ShouldUseLocalDevZkProofBackend(configuration))
        {
            services.TryAddSingleton<IProductionZkProofBackend, LocalDevZkProofBackend>();
        }
        else if (ShouldUseNativeGroth16ZkProofBackend(configuration))
        {
            services.TryAddSingleton<IProductionZkProofBackend, NativeGroth16ZkProofBackend>();
        }
        else
        {
            services.TryAddSingleton<IProductionZkProofBackend, UnavailableProductionZkProofBackend>();
        }

        _ = ZkCommentPolicyOptions.FromConfiguration(configuration);
        services.AddSingleton<IZkCommentPolicyAuthority, ZkCommentPolicyAuthority>();
        services.AddSingleton(ZkVerifierOptions.FromConfiguration(configuration));
        services.AddSingleton<IZkVerifierReadiness, ZkVerifierReadiness>();
        if (ProductionZkProofVerifier.IsEnabled(configuration))
        {
            services.TryAddSingleton<IZkProofVerifier, ProductionZkProofVerifier>();
        }
        else
        {
            services.TryAddSingleton<IZkProofVerifier, DisabledZkProofVerifier>();
        }

        services.AddScoped<IZkAnonymousProofService, ZkAnonymousProofService>();
        services.AddSingleton<AnonymousCommentPolicyService>();
        services.AddSingleton<IAnonymousCommentPolicyService>(provider => provider.GetRequiredService<AnonymousCommentPolicyService>());
        services.AddSingleton<IAnonymousCommentPolicyInvalidationSink>(provider => provider.GetRequiredService<AnonymousCommentPolicyService>());
        services.AddScoped<IAnonymousCredentialService, AnonymousCredentialService>();
        services.AddScoped<IAnonymousCredentialIssuanceAuditStore, AnonymousCredentialIssuanceAuditStore>();
        services.Configure<BlindCredentialRuntimeOptions>(
            configuration.GetSection(BlindCredentialRuntimeOptions.SectionName));
        services.TryAddSingleton<IBlindCredentialRuntimeGate, BlindCredentialRuntimeGate>();
        if (configuration.GetValue("AnonymousCredentialIssuer:BlindRsa:Enabled", false))
        {
            services.TryAddSingleton<IRfc9474BlindCredentialSigner, ProductionRfc9474BlindCredentialSigner>();
        }
        else
        {
            services.TryAddSingleton<IRfc9474BlindCredentialSigner, UnavailableRfc9474BlindCredentialSigner>();
        }
        services.AddScoped<IBlindCredentialIssuanceService, BlindCredentialIssuanceService>();
        services.AddScoped<IAnonymousCredentialRootStore, AnonymousCredentialRootStore>();
        services.AddSingleton<IAnonymousCredentialRootService, AnonymousCredentialRootService>();
        services.AddScoped<IAnonymousCredentialRevocationArtifactService, AnonymousCredentialRevocationArtifactService>();
        services.AddScoped<IAnonymousGovernanceService, AnonymousGovernanceService>();
        services.AddScoped<IAnonymousCommentTicketService, AnonymousCommentTicketService>();
        services.AddSingleton<AnonymousCredentialRootLifecycleService>();
        services.AddSingleton<IAnonymousCredentialRootReader>(sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddSingleton<IAnonymousCredentialRootWriter>(sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddSingleton<IAnonymousCredentialRevocationService>(sp => sp.GetRequiredService<AnonymousCredentialRootLifecycleService>());
        services.AddScoped<ICommentAnonymousNullifierService, CommentAnonymousNullifierService>();
        if (configuration.GetValue<bool>(LocalSecurityFixtureEndpoints.AllowLocalSecurityFixtureConfigurationKey))
        {
            services.AddScoped<ISecurityFixtureCompositionRoot, SecurityFixtureCompositionRoot>();
        }
        services.AddSingleton<ICommentAnonymousDisplayNameGenerator, CommentAnonymousDisplayNameGenerator>();
        services.AddScoped<ICommentActorResolver, CommentActorResolver>();
        services.AddScoped<ITotpService, TotpService>();
        services.AddScoped<IMfaChallengeService, MfaChallengeService>();
        services.AddScoped<IAuthRiskService, AuthRiskService>();
        services.AddSingleton<IUserSessionMetadataProtector, UserSessionMetadataProtector>();
        services.AddScoped<IRiskControlContextFactory, RiskControlContextFactory>();
        services.AddScoped<IRiskDecisionService, RiskDecisionService>();
        services.AddScoped<ISecurityPolicySnapshotService, SecurityPolicySnapshotService>();
        services.AddScoped<ISecurityChallengePersistenceService, SecurityChallengePersistenceService>();
        services.AddScoped<IPoSpaceUnsupportedAssignmentStore, SqlPoSpaceUnsupportedAssignmentStore>();
        services.AddScoped<IPoSpaceUnsupportedReissueService, PoSpaceUnsupportedReissueService>();
        services.AddScoped<ISecurityChallengeProofService, SecurityChallengeProofService>();
        services.AddScoped<ISecurityChallengeEnvelopeStateService, SecurityChallengeEnvelopeStateService>();
        services.AddScoped<ISecurityChallengeVerifyRateLimiter, SecurityChallengeVerifyRateLimiter>();
        services.Configure<ChallengeV2EventWriterOptions>(configuration.GetSection(ChallengeV2EventWriterOptions.SectionName));
        services.AddSingleton(sp =>
        {
            _ = ChallengeV2FallbackWriter.ValidateConfiguration(configuration);
            return new ChallengeV2FallbackWriter(configuration, sp.GetRequiredService<IAuditRetentionEpochKeyStore>());
        });
        services.AddSingleton(sp => new ChallengeV2AuditEventQueue(
            sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<ChallengeV2EventWriterOptions>>(),
            sp.GetRequiredService<ILogger<ChallengeV2AuditEventQueue>>(),
            sp.GetRequiredService<ChallengeV2FallbackWriter>()));
        services.AddSingleton<IChallengeV2AuditEventWriter>(sp => sp.GetRequiredService<ChallengeV2AuditEventQueue>());
        services.Configure<PerceptionSealedTokenOptions>(configuration.GetSection(PerceptionSealedTokenOptions.SectionName));
        services.AddSingleton<IPerceptionSealedTokenService, PerceptionSealedTokenService>();
        services.TryAddScoped<IPerceptionChallengeV2TaskSource, DefaultPerceptionChallengeV2TaskSource>();
        services.AddScoped<IPerceptionChallengeV2TokenProtector, PerceptionChallengeV2TokenProtector>();
        services.AddScoped<IPerceptionChallengeV2RedisGate, RedisPerceptionChallengeV2Gate>();
        services.AddScoped<IPerceptionChallengeV2IssueService, PerceptionChallengeV2IssueService>();
        services.AddScoped<IPerceptionChallengeV2VerifyService, PerceptionChallengeV2VerifyService>();
        services.AddScoped<ISecurityChallengeProvider, Sha256PowChallengeProvider>();
        services.AddScoped<ISecurityChallengeProvider, Argon2idPoSpaceV1ChallengeProvider>();
        services.AddScoped<ISecurityChallengeProvider, HumanReadProofV1ChallengeProvider>();
        services.AddScoped<ISecurityChallengeProvider, PasskeyStepUpV1ChallengeProvider>();
        services.AddScoped<ISecurityChallengeProvider, AdminPasskeyStepUpV1ChallengeProvider>();
        services.AddScoped<ISecurityChallengeProvider, PerceptionLocalizationV2Provider>();
        services.AddScoped<ISecurityChallengeProvider, PerceptionMicroInteractionV2Provider>();
        bool perceptionV3Enabled = SecuritySystemModes.IsEnforcing(
            SecuritySystemModes.Normalize(configuration["Security:PerceptionCharacterV3:Enabled"] ?? SecuritySystemModes.Disabled));
        services.AddScoped<IPerceptionCharacterV3StateStore, RedisPerceptionCharacterV3StateStore>();
        services.AddScoped<IPerceptionCharacterV3DeviceAuthority, RedisPerceptionCharacterV3DeviceAuthority>();
        if (perceptionV3Enabled)
        {
            services.AddSingleton<IPerceptionCharacterV3KeyRing, PerceptionCharacterV3KeyRing>();
            services.AddSingleton<IPerceptionCharacterV3NonceSource, PerceptionCharacterV3RandomNonceSource>();
            services.AddSingleton<IPerceptionCharacterV3ArtifactPool, RedisPerceptionCharacterV3ArtifactPool>();
            services.AddSingleton<IPerceptionCharacterV3ResourcePlanner, PerceptionCharacterV3ResourcePlanner>();
            services.AddSingleton<IPerceptionCharacterV3AuditSink, PerceptionCharacterV3AuditSink>();
            services.AddScoped<ISecurityChallengeProvider, PerceptionCharacterV3Provider>();
        }
        services.AddScoped<ISecurityChallengeOrchestrator, SecurityChallengeOrchestrator>();

        services.Configure<LifecycleBootstrapOptions>(configuration.GetSection(LifecycleBootstrapOptions.SectionName));
        services.Configure<AuditDetachedCheckpointRuntimeOptions>(
            configuration.GetSection(AuditDetachedCheckpointRuntimeOptions.SectionName));
        services.AddScoped<IAuditCheckpointRecordSource, SqlAuditCheckpointRecordSource>();

        services.AddScoped<ICacheInitializer, CacheInitializer>();
        services.AddSingleton<ISchemaModelInspector, SchemaModelInspector>();
        services.AddSingleton<ISchemaMigrationLock, SchemaMigrationLock>();
        services.AddSingleton<CurrentSchemaAdmissionState>();
        services.AddScoped<ISchemaMigrationRunner, CurrentSchemaStartupVerifier>();
        services.AddScoped<IAccountSubjectHashInvariantGate, AccountSubjectHashInvariantGate>();
        if (!OpenApiExportMode.IsEnabled(configuration))
        {
            if (perceptionV3Enabled)
                services.AddHostedService<PerceptionCharacterV3StartupGate>();
            services.AddHostedService(provider => provider.GetRequiredService<AdminSessionTouchScheduler>());
            services.AddHostedService<AdminSessionProjectionColdStartWorker>();
            services.AddHostedService<ProductionStartupValidationHostedService>();
            services.AddHostedService<LifecycleHostedBootstrapService>();
            services.AddHostedService<SecurityPolicySnapshotHostedService>();
            services.AddHostedService<AnonymousCredentialRootRefreshHostedService>();
            services.AddHostedService<ChallengeV2AuditEventWriterWorker>();
            services.AddHostedService<AuditDetachedCheckpointHostedService>();
        }

        return services;
    }

    private static bool ShouldUseNativeGroth16ZkProofBackend(IConfiguration configuration)
    {
        ZkVerifierOptions options = ZkVerifierOptions.FromConfiguration(configuration);
        return options.Enabled && string.Equals(options.Backend, ZkVerifierOptions.NativeGroth16Backend, StringComparison.Ordinal);
    }

    private static bool ShouldUseLocalDevZkProofBackend(IConfiguration configuration)
        => LocalDevZkProofBackend.IsEnabled(configuration);

}
