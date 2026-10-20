using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

using Npgsql;

using NSubstitute;

using SqlSugar;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>
/// Supplier-gap controls, not a document-binding implementation or qualification. Drafts are
/// saved through the original CAS service; unrelated service ports are not exercised. No
/// capability grant, consent, approval receipt or production document binding is fabricated.
/// </summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionDocumentBindingSupplierPostgresTests(PostgresSchemaMigrationFixture postgres)
{
    [Theory]
    [InlineData("configured-site", 1)]
    [InlineData("primary-site", 1)]
    [InlineData("primary", 1)]
    [InlineData("https://source.invalid", 1)]
    [InlineData("configured-site", 2)]
    public async Task RealSavedDraft_DoesNotRelabelAnIssuedSiteScopeOrAuthorizeDocumentState(string configuredSite, long draftOwner)
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        host.Configuration["AuthoringExtensions:SiteId"] = configuredSite;
        using SqlSugarClient db = InitializeDraftTables(host);
        AuthoringDraftLifecycleService drafts = Drafts(db);
        ServerDraftResponse saved = await drafts.SaveDraftAsync(draftOwner, Request());
        ArticleDraft row = Assert.Single(await db.Queryable<ArticleDraft>().ToListAsync());
        Assert.Equal(draftOwner, row.OwnerAdminPrincipalId);
        Assert.Equal(saved.ServerRevision, row.ServerRevision);
        Assert.Equal(draftOwner == 1, await drafts.GetDraftAsync(1, saved.DraftKey) is not null);

        VerifiedAuthoringPackage package = AuthoringStateProcessWorker.Package("1.0.0", 1);
        VerifiedAuthoringPackage next = AuthoringStateProcessWorker.Package("2.0.0", 2);
        AuthoringExtensionScopeRegistration site = await host.BeginAsync();
        await host.CompleteAsync(site);
        Assert.Null(site.Scope.DocumentId);
        AuthoringStateScope forgedDocument = site.Scope with
        {
            DocumentId = $"draft:{saved.DraftKey}"
        };
        var issuance = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            host.Issuer.BeginAsync(host.Context, next, forgedDocument).AsTask());
        Assert.Equal("scope_site_or_document_mismatch", issuance.Message);

        // The original persistence primitive can contain opaque legacy state. Creating such a
        // row in this isolated adversarial fixture does not create server provenance for it.
        var state = new PostgresAuthoringExtensionStateStore(db);
        await state.InitializeAsync(package, forgedDocument, default);
        await using IAuthoringExtensionStateObservation custody = await state.ObserveDeletionAsync(package,
            await state.MeasureAsync(package, forgedDocument, default), default);
        var denial = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            host.Authority.AcquireWithStateCustodyAsync(host.Context, AuthoringApprovalOperation.Deletion,
                forgedDocument, null, custody, default).AsTask());
        Assert.Equal("scope_document_authority_unavailable", denial.Message);
        await custody.VerifyCurrentAsync(default);
        Assert.Equal(forgedDocument, custody.State.From.Snapshot.Scope);
        Assert.Equal(new[] { ScopeId(forgedDocument) }, custody.AcquiredScopeIds);
        await AssertOnlyOriginalSiteRegistrationAsync(host, site);
    }

    [Theory]
    [InlineData("document:article:42")]
    [InlineData("canvas:00000000-0000-0000-0000-000000000042")]
    [InlineData("unsaved-draft")]
    public async Task MissingOrUiDocumentCoordinates_DoNotEnterTheOriginalIssuer(string document)
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        AuthoringExtensionScopeRegistration site = await host.BeginAsync();
        await host.CompleteAsync(site);
        VerifiedAuthoringPackage next = AuthoringStateProcessWorker.Package("2.0.0", 2);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Issuer.BeginAsync(host.Context,
            next, site.Scope with
            {
                DocumentId = document
            }).AsTask());
        await AssertOnlyOriginalSiteRegistrationAsync(host, site);
    }

    [Fact]
    public async Task OriginalDraftReadAndStateCustody_LeaveRealDocumentWritersUnheld()
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        using SqlSugarClient db = InitializeDraftTables(host);
        AuthoringDraftLifecycleService drafts = Drafts(db);
        ServerDraftResponse captured = await drafts.SaveDraftAsync(1, Request());
        AuthoringExtensionScopeRegistration site = await host.BeginAsync();
        await host.CompleteAsync(site);
        await using IAuthoringExtensionStateObservation sameCustody = await host.ObserveAsync(site.Scope);
        using SqlSugarClient independent = host.Client();
        AuthoringDraftLifecycleService writer = Drafts(independent);
        ServerDraftResponse updated = await writer.SaveDraftAsync(1, Request(captured.ServerRevision, "next"))
            .WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(captured.ServerRevision + 1, updated.ServerRevision);
        Assert.Equal(1, captured.ServerRevision);
        await sameCustody.VerifyCurrentAsync(default);
        Assert.True(await writer.DiscardDraftAsync(1, captured.DraftKey, updated.ServerRevision)
            .WaitAsync(TimeSpan.FromSeconds(3)));
        Assert.Null(await drafts.GetDraftAsync(1, captured.DraftKey));
        await sameCustody.VerifyCurrentAsync(default);
        Assert.Null(sameCustody.State.From.Snapshot.Scope.DocumentId);
        await AssertOnlyOriginalSiteRegistrationAsync(host, site);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SqlRowShare_BlocksRealSaveAndDiscardButIsNotARegisteredDocumentAuthority(bool discard)
    {
        await using var host = await AuthoringExtensionScopeProvenancePostgresTests.CreateHarnessAsync(postgres);
        using SqlSugarClient db = InitializeDraftTables(host);
        ServerDraftResponse saved = await Drafts(db).SaveDraftAsync(1, Request());
        await using NpgsqlConnection connection = await host.DataSource.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("""
            SELECT id,owner_admin_principal_id,draft_key,server_revision,status,xmin::text
            FROM article_draft WHERE owner_admin_principal_id=1 AND draft_key=$1 FOR SHARE;
            """, connection))
        {
            command.Parameters.AddWithValue(saved.DraftKey);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
            Assert.True(await reader.ReadAsync());
            Assert.Equal(saved.ServerRevision, reader.GetInt64(3));
        }
        using SqlSugarClient other = host.Client();
        AuthoringDraftLifecycleService writer = Drafts(other);
        Task mutation = discard
            ? writer.DiscardDraftAsync(1, saved.DraftKey, saved.ServerRevision)
            : writer.SaveDraftAsync(1, Request(saved.ServerRevision, "next"));
        try
        {
            await AuthoringExtensionScopeProvenanceActivationPostgresTests.WaitForQueryLockAsync(host.DataSource,
                discard ? "%DELETE FROM article_draft%" : "%UPDATE article_draft%");
            Assert.False(mutation.IsCompleted);
        }
        finally
        {
            await transaction.RollbackAsync();
        }
        await mutation.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(discard ? 0 : 1, await db.Queryable<ArticleDraft>().CountAsync());
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT count(*) FROM authoring_extension_scope_provenance"));
    }

    private static SqlSugarClient InitializeDraftTables(AuthoringExtensionScopeProvenancePostgresTests.Harness host)
    {
        SqlSugarClient db = host.Client();
        PostgresSqlSugarTestClient.InitTables(db, typeof(ArticleDraft), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        return db;
    }

    private static AuthoringDraftLifecycleService Drafts(SqlSugarClient db) => new(db,
        Substitute.For<IArticleCoreService>(), Substitute.For<IArticlePublicationValidator>(), Substitute.For<IAuthoringAuditWriter>());

    private static ServerDraftSaveRequest Request(long? expected = null, string revision = "initial") =>
        new("binding-source-draft", null, "Source probe", "plain source", null, null, 0, [], revision,
            (int)ArticleStatus.Draft, null, ExpectedServerRevision: expected);

    private static async Task AssertOnlyOriginalSiteRegistrationAsync(
        AuthoringExtensionScopeProvenancePostgresTests.Harness host, AuthoringExtensionScopeRegistration site)
    {
        await using NpgsqlConnection connection = await host.DataSource.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("""
            SELECT registration_id,status,scope_payload FROM authoring_extension_scope_provenance;
            """, connection);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal(site.RegistrationId, reader.GetString(0));
        Assert.Equal((short)1, reader.GetInt16(1));
        Assert.Equal(Encode(site.Scope), reader.GetFieldValue<byte[]>(2));
        Assert.False(await reader.ReadAsync());
    }
}
