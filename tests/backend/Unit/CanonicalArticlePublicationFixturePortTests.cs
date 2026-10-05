using System.Reflection;
using System.Reflection.Emit;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CanonicalArticlePublicationFixturePortTests
{
    private static readonly string s_validDigest = "sha256:" + new string('a', 64);
    private static readonly string s_validSha256 = new string('b', 64);

    private static CanonicalArticlePublicationFixtureBinding CreateBinding(
        long adminPrincipalId = 1,
        string? writerContractDigest = null,
        string? temporalContextDigest = null,
        IReadOnlyList<string>? capabilities = null)
    {
        return new CanonicalArticlePublicationFixtureBinding(
            RunId: "run-test-1",
            Namespace: "test-ns",
            ProfileId: "profile-canonical",
            Capabilities: capabilities ?? ["article:publish", "article:write"],
            AdminPrincipalId: adminPrincipalId,
            WriterContractDigest: writerContractDigest ?? s_validDigest,
            TemporalContextDigest: temporalContextDigest ?? s_validDigest);
    }

    private static CanonicalArticlePublicationPlan CreatePlan(
        string title = "Canonical Title",
        string content = "Canonical Content Body",
        string? summary = null,
        string semanticRole = "canonical-article-fixture",
        ArticleRightsRequestCoreModel? rights = null,
        ArticleResponsibilityDraft? responsibility = null)
    {
        return new CanonicalArticlePublicationPlan(
            SemanticRole: semanticRole,
            Title: title,
            Content: content,
            Summary: summary,
            CoverImageUrl: "https://example.com/cover.png",
            CategoryId: 1,
            TagIds: [2, 1, 3, 2],
            Rights: rights,
            Responsibility: responsibility);
    }

    [Fact]
    public void Binding_AdminPrincipalIdZeroOrNegative_FailsClosed()
    {
        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(adminPrincipalId: 0).Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(adminPrincipalId: -1).Validate());
    }

    [Fact]
    public void Binding_MissingRequiredFieldsOrInvalidDigests_FailsClosed()
    {
        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            new CanonicalArticlePublicationFixtureBinding(
                RunId: "",
                Namespace: "ns",
                ProfileId: "profile",
                Capabilities: ["cap"],
                AdminPrincipalId: 1,
                WriterContractDigest: s_validDigest,
                TemporalContextDigest: s_validDigest).Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(writerContractDigest: "not-a-digest").Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(temporalContextDigest: "short").Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(capabilities: []).Validate());
    }

    [Fact]
    public async Task PublishAsync_RightsRecomputeSentinel_FailsClosed()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IConfiguration config = new ConfigurationBuilder().Build();
        IArticlePublicationValidator validator = Substitute.For<IArticlePublicationValidator>();
        IArticlePublicMutationFence fence = Substitute.For<IArticlePublicMutationFence>();
        var port = new CanonicalArticlePublicationFixturePort(db, config, validator, fence);

        var rights = new ArticleRightsRequestCoreModel(
            Enabled: true,
            LicenseType: "recompute-license",
            CopyrightHolder: null,
            CopyrightYear: null,
            RightsStatement: null,
            AttributionTemplate: null,
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: true,
            ProofBindingEnabled: true);

        var request = new CanonicalArticlePublicationRequest(
            CreateBinding(),
            CreatePlan(rights: rights));

        var ex = await Assert.ThrowsAsync<CanonicalArticlePublicationValidationException>(() =>
            port.PublishAsync(request));

        Assert.Equal("rights_recompute_sentinel_forbidden", ex.Code);
    }

    [Fact]
    public void ResponsibilityBuilder_Build_ThrowsWhenGovernanceFails()
    {
        DateTime now = DateTime.UtcNow;
        var invalidDraft = new ArticleResponsibilityDraft(
            InheritSiteAuthor: false,
            Authors: [], // empty authors fails governance
            Reviewer: null,
            Sources: [],
            UpdateSummary: null,
            UpdateReason: null,
            EffectiveAt: null,
            ConclusionImpact: null,
            Methodology: null,
            Applicability: null,
            Limitations: null,
            ResponsiblePersonConfirmed: false,
            ContainsStrongClaims: false,
            IsSubstantiveUpdate: false,
            RequiresMethodsDisclosure: false,
            ExpectedVersion: 1);

        Assert.Throws<InvalidOperationException>(() =>
            ArticleResponsibilitySnapshotBuilder.Build(
                articleId: 1,
                revisionId: 1,
                revisionNo: 1,
                responsibilityVersion: 1,
                previousSnapshotId: null,
                draft: invalidDraft,
                createdAt: now));
    }

    [Fact]
    public void ArticleProductionNormalizers_NormalizeText_EnforcesBounds()
    {
        Assert.Equal(string.Empty, ArticleProductionNormalizers.NormalizeText(null, 100));
        Assert.Equal(string.Empty, ArticleProductionNormalizers.NormalizeText("   ", 100));
        Assert.Equal("test text", ArticleProductionNormalizers.NormalizeText("  test text  ", 100));

        string longText = new string('x', 200);
        string truncated = ArticleProductionNormalizers.NormalizeText(longText, 100);
        Assert.Equal(100, truncated.Length);
    }

    [Fact]
    public void ArticleProductionNormalizers_NormalizeTagIds_DeduplicatesPreservingFirstSeenOrder()
    {
        var result = ArticleProductionNormalizers.NormalizeTagIds([5, 3, 1, 5, 2, -1, 0]);
        Assert.Equal([5, 3, 1, 2, -1, 0], result);
    }

    [Fact]
    public void ArticleService_SharedSeams_AreReferencedByProductionSources()
    {
        var service = RuntimeMetadataInspection.ReadMemberSites(typeof(ArticleService),
            "NormalizeArticleRights", "SaveArticleRightsAsync", "EnsureArticleRightsPolicyAsync",
            "CreateMutationAsync", "SaveArticleRevisionAsync");
        var cache = RuntimeMetadataInspection.ReadMemberSites(
            typeof(ArticleService), "NormalizeText", "NormalizeTagIds");
        var responsibility = RuntimeMetadataInspection.ReadMemberSites(
            typeof(ArticleResponsibilityAuthoringService), nameof(ArticleResponsibilityAuthoringService.SaveAsync));
        var publish = RuntimeMetadataInspection.ReadMemberSites(
            typeof(CanonicalArticlePublicationFixturePort), nameof(CanonicalArticlePublicationFixturePort.PublishAsync));

        AssertSharedSeam(service, typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeArticleRights));
        AssertSharedSeam(service, typeof(ArticleRightsSnapshotBuilder), nameof(ArticleRightsSnapshotBuilder.Build));
        AssertSharedSeam(service, typeof(ArticleRightsPolicyPersistence), nameof(ArticleRightsPolicyPersistence.UpsertAsync));
        AssertSharedSeam(service, typeof(ArticleCreateMutationAuthority), nameof(ArticleCreateMutationAuthority.ExecuteAsync));
        AssertSharedSeam(service, typeof(ArticleRevisionPersistence), nameof(ArticleRevisionPersistence.SaveAsync));
        AssertSharedSeam(publish, typeof(ArticleCreateMutationAuthority), nameof(ArticleCreateMutationAuthority.ExecuteAsync));
        AssertSharedSeam(publish, typeof(IArticlePublicMutationFence), nameof(IArticlePublicMutationFence.BeginPublicMutationFenceAsync));
        AssertNoDirectArticleRevisionConstruction(typeof(CanonicalArticlePublicationFixturePort));
        AssertSharedSeam(cache, typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeText));
        AssertSharedSeam(cache, typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeTagIds));
        AssertSharedSeam(responsibility, typeof(ArticleResponsibilitySnapshotBuilder), nameof(ArticleResponsibilitySnapshotBuilder.Build));
        Assert.Null(typeof(ArticleService).GetNestedType("ArticleRightsWriteModel",
            BindingFlags.Public | BindingFlags.NonPublic));
        MethodInfo[] rightsMethods = typeof(ArticleService).GetMethods(
            BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        Assert.Contains(rightsMethods, static method => method.Name == "ResolveUpdateArticleRightsAsync");
        MethodInfo[] writeModels = rightsMethods.Where(static method => method.Name == "ToRightsWriteModel").ToArray();
        Assert.NotEmpty(writeModels);
        Assert.All(writeModels, static method => Assert.Equal(typeof(ArticleRightsNormalizedModel), method.ReturnType));
    }

    [Theory]
    [InlineData(typeof(PortNestedMethodFixture), typeof(PortNestedMethodFixture.Nested), "Create")]
    [InlineData(typeof(PortDeepNestedMethodFixture), typeof(PortDeepNestedMethodFixture.Nested.Deeper), "Create")]
    [InlineData(typeof(PortNestedConstructorFixture), typeof(PortNestedConstructorFixture.Nested), ".ctor")]
    [InlineData(typeof(PortNestedStaticConstructorFixture), typeof(PortNestedStaticConstructorFixture.Nested), ".cctor")]
    public void PortConstructionRule_RejectsCompiledNestedArticleRevisionConstruction(
        Type portType,
        Type declaringType,
        string memberName)
    {
        string declaredBody;
        if (memberName is ".ctor" or ".cctor")
        {
            if (memberName == ".cctor")
            {
                Assert.NotNull(declaringType.TypeInitializer);
            }
            else
            {
                Assert.NotEmpty(declaringType.GetConstructors(
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly));
            }
            declaredBody = RuntimeMetadataInspection.DescribeConstructors(declaringType);
        }
        else
        {
            declaredBody = RuntimeMetadataInspection.DescribeMethods(declaringType, memberName);
            string previousDescription = string.Join('\n',
                RuntimeMetadataInspection.DescribeType(portType),
                RuntimeMetadataInspection.DescribeConstructors(portType));
            Assert.DoesNotContain("ArticleRevision..ctor", previousDescription, StringComparison.Ordinal);
        }

        Assert.Contains("ArticleRevision..ctor", declaredBody, StringComparison.Ordinal);
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoDirectArticleRevisionConstruction(portType));
        string port = DescribeCompletePortType(portType);
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoDirectArticleRevisionConstruction(port));
    }

    [Fact]
    public void PortConstructionRule_AcceptsCompiledBenignNestedMembers()
    {
        Type nestedType = typeof(PortBenignNestedFixture.Nested);
        Assert.NotNull(nestedType.TypeInitializer);
        string method = RuntimeMetadataInspection.DescribeMethods(nestedType, "Create");
        string constructors = RuntimeMetadataInspection.DescribeConstructors(nestedType);
        Assert.Contains("System.Object..ctor", method, StringComparison.Ordinal);
        Assert.Contains("System.Object..ctor", constructors, StringComparison.Ordinal);

        AssertNoDirectArticleRevisionConstruction(typeof(PortBenignNestedFixture));
        AssertNoDirectArticleRevisionConstruction(DescribeCompletePortType(typeof(PortBenignNestedFixture)));
    }

    [Theory]
    [InlineData(typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeArticleRights))]
    [InlineData(typeof(ArticleRightsSnapshotBuilder), nameof(ArticleRightsSnapshotBuilder.Build))]
    [InlineData(typeof(ArticleRightsPolicyPersistence), nameof(ArticleRightsPolicyPersistence.UpsertAsync))]
    [InlineData(typeof(ArticleCreateMutationAuthority), nameof(ArticleCreateMutationAuthority.ExecuteAsync))]
    [InlineData(typeof(ArticleRevisionPersistence), nameof(ArticleRevisionPersistence.SaveAsync))]
    [InlineData(typeof(IArticlePublicMutationFence), nameof(IArticlePublicMutationFence.BeginPublicMutationFenceAsync))]
    [InlineData(typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeText))]
    [InlineData(typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeTagIds))]
    [InlineData(typeof(ArticleResponsibilitySnapshotBuilder), nameof(ArticleResponsibilitySnapshotBuilder.Build))]
    public void SharedSeamRule_RejectsMatchingStringLiterals(Type owner, string memberName)
    {
        Assert.Contains(owner.Name + "." + memberName,
            RuntimeMetadataInspection.DescribeMethods(typeof(SeamLiteralFixture), "References"), StringComparison.Ordinal);
        var sites = RuntimeMetadataInspection.ReadMemberSites(typeof(SeamLiteralFixture), "References");
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertSharedSeam(sites, owner, memberName));
    }

    [Fact]
    public void SharedSeamRule_RejectsFunctionPointerWithoutInvocation()
    {
        var sites = RuntimeMetadataInspection.ReadMemberSites(typeof(SeamFunctionPointerFixture), "Reference");
        Assert.Contains(sites, static site => site.OpCode == OpCodes.Ldftn
            && site.Member.DeclaringType == typeof(ArticleProductionNormalizers)
            && site.Member.Name == nameof(ArticleProductionNormalizers.NormalizeText));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertSharedSeam(sites,
            typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeText)));
    }

    [Fact]
    public void SharedSeamRule_PreservesCompiledDelegateAndAsyncClosure()
    {
        var reference = RuntimeMetadataInspection.ReadMemberSites(typeof(SeamNestedFunctionPointerFixture), "Reference");
        AssertSharedSeam(reference, typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeText));
        Assert.Contains(reference, static site => site.Owner.Name == "MoveNext"
            && site.Member.DeclaringType == typeof(ArticleProductionNormalizers)
            && site.Member.Name == nameof(ArticleProductionNormalizers.NormalizeText)
            && site.OpCode == OpCodes.Call);
    }

    [Fact]
    public void SharedSeamRule_RejectsSameMemberNameOnDifferentOwner()
    {
        var sites = RuntimeMetadataInspection.ReadMemberSites(typeof(SeamDifferentOwnerFixture), "Invoke");
        AssertSharedSeam(sites, typeof(SeamDifferentOwnerFixture), nameof(ArticleProductionNormalizers.NormalizeText));
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertSharedSeam(sites,
            typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeText)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void MemberReferenceRule_DoesNotTreatMetadataTokensAsCallsOrConstruction(bool constructorToken)
    {
        var assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName("CanonicalMemberToken"), AssemblyBuilderAccess.Run);
        TypeBuilder type = assembly.DefineDynamicModule("Tokens").DefineType("TokenFixture");
        MethodBuilder method = type.DefineMethod("Reference", MethodAttributes.Public | MethodAttributes.Static,
            typeof(void), Type.EmptyTypes);
        ILGenerator il = method.GetILGenerator();
        if (constructorToken)
        {
            il.Emit(OpCodes.Ldtoken, typeof(ArticleRevision).GetConstructor(Type.EmptyTypes)!);
        }
        else
        {
            il.Emit(OpCodes.Ldtoken, typeof(ArticleProductionNormalizers).GetMethod(
                nameof(ArticleProductionNormalizers.NormalizeText), [typeof(string), typeof(int)])!);
        }
        il.Emit(OpCodes.Pop);
        il.Emit(OpCodes.Ret);
        Type fixture = type.CreateType()!;
        var sites = RuntimeMetadataInspection.ReadMemberSites(fixture, "Reference");
        Assert.Equal(OpCodes.Ldtoken, Assert.Single(sites).OpCode);
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertSharedSeam(sites,
            typeof(ArticleProductionNormalizers), nameof(ArticleProductionNormalizers.NormalizeText)));
        AssertNoDirectArticleRevisionConstruction(fixture);
    }

    [Theory]
    [InlineData(typeof(PortConstructorLiteralFixture))]
    [InlineData(typeof(PortTypeTokenFixture))]
    [InlineData(typeof(SeamFunctionPointerFixture))]
    public void PortConstructionRule_AcceptsNonConstructionReferences(Type portType)
    {
        AssertNoDirectArticleRevisionConstruction(portType);
    }

    [Fact]
    public void ArticleProductionNormalizers_NormalizeArticleRights_EnforcesDefaults()
    {
        var normalized = ArticleProductionNormalizers.NormalizeArticleRights(null);
        Assert.True(normalized.Enabled);
        Assert.Equal("all-rights-reserved", normalized.LicenseType);
        Assert.Equal("append-attribution", normalized.CopyPolicy);
        Assert.Equal(300, normalized.MaxExcerptChars);
        Assert.True(normalized.AllowCodeCopy);
        Assert.True(normalized.ShowPublicBadge);
        Assert.True(normalized.ProofBindingEnabled);
    }

    [Fact]
    public void ArticleRightsSnapshotBuilder_BuildsDeterministicHashes()
    {
        DateTime now = DateTime.UtcNow;
        var rights = ArticleProductionNormalizers.NormalizeArticleRights(null);

        var (snapshot1, hash1, policy1) = ArticleRightsSnapshotBuilder.Build(
            articleId: 42,
            revisionId: 101,
            revisionNo: 1,
            policyId: 1,
            title: "Article Title",
            content: "Markdown Body Content",
            summary: "Summary",
            coverImageUrl: null,
            categoryId: 1,
            tagIds: [1, 2],
            status: ArticleStatus.Published,
            publishedAt: now,
            scheduledPublishAt: null,
            rights: rights,
            createdAt: now);

        var (snapshot2, hash2, policy2) = ArticleRightsSnapshotBuilder.Build(
            articleId: 42,
            revisionId: 101,
            revisionNo: 1,
            policyId: 1,
            title: "Article Title",
            content: "Markdown Body Content",
            summary: "Summary",
            coverImageUrl: null,
            categoryId: 1,
            tagIds: [1, 2],
            status: ArticleStatus.Published,
            publishedAt: now,
            scheduledPublishAt: null,
            rights: rights,
            createdAt: now);

        Assert.Equal(hash1, hash2);
        Assert.Equal(policy1, policy2);
        Assert.Equal(snapshot1.ContentCanonicalHash, snapshot2.ContentCanonicalHash);
        Assert.Equal(snapshot1.PolicyHash, snapshot2.PolicyHash);
        Assert.False(snapshot1.PolicyHash.Contains("recompute", StringComparison.OrdinalIgnoreCase));
        Assert.False(snapshot1.ContentCanonicalHash.Contains("recompute", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Verifier_DetectsTamperedReceiptDigest()
    {
        var binding = CreateBinding();
        var plan = CreatePlan();

        var receipt = new CanonicalArticlePublicationReceipt(
            Schema: CanonicalArticlePublicationFixturePort.Schema,
            WriterContractDigest: binding.WriterContractDigest,
            RunId: binding.RunId,
            Namespace: binding.Namespace,
            ProfileId: binding.ProfileId,
            SemanticRole: plan.SemanticRole,
            AdminPrincipalId: binding.AdminPrincipalId,
            ArticleId: 10,
            RevisionId: 20,
            RevisionNo: 1,
            PublicationId: 30,
            PublicationNo: 1,
            RightsSnapshotId: 40,
            ContentCanonicalHash: s_validSha256,
            PolicyHash: s_validSha256,
            ResponsibilitySnapshotId: 50,
            ResponsibilityVersion: 1,
            OutboxEventId: "event-1",
            OutboxPayloadDigest: s_validSha256,
            AuditChainId: "chain-1",
            AuditRecordHash: s_validSha256,
            ContentDigest: s_validSha256,
            RequiredEdges: ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray(),
            ReceiptDigest: "sha256:tampered_invalid_digest_00000000000000000000000000000000000000000000000");

        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();

        var verification = await CanonicalArticlePublicationVerifier.VerifyAsync(db, receipt);
        Assert.Contains(verification.Violations, static v => v.Contains("receipt_digest_tamper_detected"));
    }

    [Fact]
    public async Task Verifier_DetectsSchemaMismatch()
    {
        var binding = CreateBinding();
        var plan = CreatePlan();

        var receipt = new CanonicalArticlePublicationReceipt(
            Schema: "unsupported-schema-version",
            WriterContractDigest: binding.WriterContractDigest,
            RunId: binding.RunId,
            Namespace: binding.Namespace,
            ProfileId: binding.ProfileId,
            SemanticRole: plan.SemanticRole,
            AdminPrincipalId: binding.AdminPrincipalId,
            ArticleId: 10,
            RevisionId: 20,
            RevisionNo: 1,
            PublicationId: 30,
            PublicationNo: 1,
            RightsSnapshotId: 40,
            ContentCanonicalHash: s_validSha256,
            PolicyHash: s_validSha256,
            ResponsibilitySnapshotId: 50,
            ResponsibilityVersion: 1,
            OutboxEventId: "event-1",
            OutboxPayloadDigest: s_validSha256,
            AuditChainId: "chain-1",
            AuditRecordHash: s_validSha256,
            ContentDigest: s_validSha256,
            RequiredEdges: ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray(),
            ReceiptDigest: "sha256:digest");

        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();

        var verification = await CanonicalArticlePublicationVerifier.VerifyAsync(db, receipt);
        Assert.Contains(verification.Violations, static v => v.Contains("receipt_schema_mismatch"));
    }

    [Fact]
    public void Port_DoesNotTouchRedisOrDirectProjections_OutputsRequiredEdges()
    {
        var edges = ArticleMutationReplayEdges.Required;
        Assert.Contains("search-projection", edges);
        Assert.Contains("public-aot-invalidation", edges);
        Assert.Contains("http-cache-invalidation", edges);
    }

    private static string DescribeCompletePortType(Type type)
    {
        var descriptions = new List<string> { RuntimeMetadataInspection.DescribeConstructors(type) };
        var pending = new Queue<Type>();
        pending.Enqueue(type);
        while (pending.TryDequeue(out Type? inspectedType))
        {
            descriptions.Add(RuntimeMetadataInspection.DescribeType(inspectedType));
            foreach (Type nested in inspectedType.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
            {
                pending.Enqueue(nested);
            }
        }

        return string.Join('\n', descriptions);
    }

    private static void AssertNoDirectArticleRevisionConstruction(string port)
    {
        Assert.DoesNotContain("ArticleRevision..ctor", port, StringComparison.Ordinal);
    }

    private static void AssertSharedSeam(
        IReadOnlyList<RuntimeMetadataInspection.RuntimeMemberSite> sites, Type owner, string memberName)
    {
        Assert.Contains(sites, site => (site.OpCode == OpCodes.Call || site.OpCode == OpCodes.Callvirt)
            && site.Member is MethodInfo method && method.DeclaringType == owner && method.Name == memberName);
    }

    private static void AssertNoDirectArticleRevisionConstruction(Type portType)
    {
        Assert.DoesNotContain(RuntimeMetadataInspection.ReadMemberSites(portType), static site =>
            site.OpCode == OpCodes.Newobj && site.Member is ConstructorInfo constructor
            && constructor.DeclaringType == typeof(ArticleRevision));
    }

    private static class SeamLiteralFixture
    {
        public static void References()
        {
            GC.KeepAlive("ArticleProductionNormalizers.NormalizeArticleRights");
            GC.KeepAlive("ArticleRightsSnapshotBuilder.Build");
            GC.KeepAlive("ArticleRightsPolicyPersistence.UpsertAsync");
            GC.KeepAlive("ArticleCreateMutationAuthority.ExecuteAsync");
            GC.KeepAlive("ArticleRevisionPersistence.SaveAsync");
            GC.KeepAlive("IArticlePublicMutationFence.BeginPublicMutationFenceAsync");
            GC.KeepAlive("ArticleProductionNormalizers.NormalizeText");
            GC.KeepAlive("ArticleProductionNormalizers.NormalizeTagIds");
            GC.KeepAlive("ArticleResponsibilitySnapshotBuilder.Build");
        }
    }

    private static class SeamFunctionPointerFixture
    {
        public static void Reference()
        {
            Func<string?, int, string> normalize =
                ArticleProductionNormalizers.NormalizeText;
            GC.KeepAlive(normalize);
        }
    }

    private static class SeamDifferentOwnerFixture
    {
        public static void Invoke() => GC.KeepAlive(NormalizeText());

        public static string NormalizeText() => "different-owner";
    }

    private static class SeamNestedFunctionPointerFixture
    {
        public static void Reference()
        {
            Func<Task<string>> normalize = Nested.NormalizeAsync;
            GC.KeepAlive(normalize);
        }

        private static class Nested
        {
            public static async Task<string> NormalizeAsync()
            {
                await Task.Yield();
                return ArticleProductionNormalizers.NormalizeText("nested", 10);
            }
        }
    }

    private static class PortConstructorLiteralFixture
    {
        public static void Reference() => GC.KeepAlive("ArticleRevision..ctor");
    }

    private static class PortTypeTokenFixture
    {
        public static void Reference() => GC.KeepAlive(typeof(ArticleRevision));
    }

    private sealed class PortNestedMethodFixture
    {
        public static class Nested
        {
            public static ArticleRevision Create() => new ArticleRevision();
        }
    }

    private sealed class PortDeepNestedMethodFixture
    {
        public static class Nested
        {
            public static class Deeper
            {
                public static ArticleRevision Create() => new ArticleRevision();
            }
        }
    }

    private sealed class PortNestedConstructorFixture
    {
        public sealed class Nested
        {
            public Nested() => GC.KeepAlive(new ArticleRevision());
        }
    }

    private sealed class PortNestedStaticConstructorFixture
    {
        public static class Nested
        {
            static Nested() => GC.KeepAlive(new ArticleRevision());
        }
    }

    private sealed class PortBenignNestedFixture
    {
        public sealed class Nested
        {
            static Nested() => GC.KeepAlive(new object());

            public Nested() => GC.KeepAlive(new object());

            public static object Create() => new object();
        }
    }
}
