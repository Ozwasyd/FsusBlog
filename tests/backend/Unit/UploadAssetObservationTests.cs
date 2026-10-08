using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UploadAssetObservationTests(PostgresSchemaMigrationFixture fixture)
{
    [Theory]
    [InlineData(68)]
    [InlineData(20_971_520)]
    public async Task VaultUploadBinding_ReusesRealNativeObservationAndCanonicalRevisionReference(int size)
    {
        FsusBlog.Server.Services.ArticleVault.ArticleVaultCurrentUploadAssetObservation bound;
        string root;
        string nativeSha256;
        string inputSha256;
        await using (var upload = await CreateAsync(size == 68 ? null : CreateOriginalPng(size)))
        {
            root = upload.Root;
            Guid assetId = Guid.ParseExact(upload.Access.UploadId, "N");
            await upload.Db.Insertable(new ContentAssetReference
            {
                AssetId = assetId,
                SourceKind = ContentAssetSourceKinds.Revision,
                SourceKey = "4",
                ArticleId = 42,
                ReferenceCount = 1,
                UpdatedAtUtc = DateTime.UtcNow
            }).ExecuteCommandAsync();
            // Bytes/session/ledger are real; plan/article authority fixtures grant no Vault operation.
            var setup = ArticleVaultUploadAssetBindingTests.Create(upload.Service, upload.Access, upload.Sha256);
            var input = await setup.ReadInputAsync();
            bound = input.Observation;
            Assert.Equal(upload.Bytes, input.Bytes.ToArray());
            inputSha256 = Convert.ToHexStringLower(SHA256.HashData(input.Bytes.Span));
            Assert.Equal(upload.Sha256, inputSha256);
            var wrongToken = await upload.Service.ReadCommittedUploadInputAsync(upload.Access with
            {
                UploadToken = "wrong-token"
            }, upload.Sha256);
            Assert.False(wrongToken.IsSuccess);
            Assert.Equal(ErrorCode.NotFound, wrongToken.Error.Code);
            var wrongOwner = await upload.Service.ReadCommittedUploadInputAsync(upload.Access with
            {
                OwnerAdminPrincipalId = 8
            }, upload.Sha256);
            Assert.False(wrongOwner.IsSuccess);
            Assert.Equal(ErrorCode.NotFound, wrongOwner.Error.Code);
            Assert.Equal(assetId, bound.Asset.Id.Value);
            Assert.Equal(upload.Bytes.Length, bound.Asset.SizeBytes);
            Assert.Equal(upload.Sha256, bound.Asset.Sha256);
            Assert.False(bound.CanExecute);
            Assert.False(bound.CanMaterialize);
            Assert.False(bound.CanUpload);
            Assert.False(bound.CanCommitBase);
            Assert.Equal("4", bound.RevisionReferenceSourceKey);
            string path = Path.Combine(ReleaseStorageTestPaths.Create(root).PublicAssetRoot,
                bound.Asset.StorageKey.Value.Replace('/', Path.DirectorySeparatorChar));
            nativeSha256 = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(path)));
            Assert.Equal(bound.Asset.Sha256, nativeSha256);
            var repeated = await setup.ReadInputAsync();
            Assert.Equal(bound.ContentSha256, repeated.Observation.ContentSha256);
            Assert.Equal(inputSha256, Convert.ToHexStringLower(SHA256.HashData(repeated.Bytes.Span)));
            var observed = await setup.ReadAsync();
            Assert.Equal(bound.ContentSha256, observed.ContentSha256);
            Assert.Equal(1, await upload.Db.Queryable<ContentAsset>().CountAsync());
            Assert.Equal(1, await upload.Db.Queryable<ContentAssetReference>().CountAsync());
            await upload.Db.Deleteable<ContentAssetReference>().Where(row => row.AssetId == assetId).ExecuteCommandAsync();
            var refusal = await Assert.ThrowsAsync<FsusBlog.Server.Services.ArticleVault.ArticleVaultExecutionRejectedException>(setup.ReadInputAsync);
            Assert.Equal("article_vault_upload_asset_upload_or_revision_reference_unavailable", refusal.ReasonCode);
            Assert.Equal(1, await upload.Db.Queryable<ContentAsset>().CountAsync());
        }
        Assert.False(Directory.Exists(root));
        string? directory = Environment.GetEnvironmentVariable("FSUSBLOG_VAULT_UPLOAD_BINDING_ARTIFACTS");
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
            string json = System.Text.Json.JsonSerializer.Serialize(new
            {
                SourceCommit = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SOURCE_SHA"),
                RunId = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUN_ID"),
                TestedAtUtc = DateTimeOffset.UtcNow,
                BoundObservation = bound,
                NativeSha256 = nativeSha256,
                InputByteSha256 = inputSha256,
                InputBytesMatchOriginalUpload = true,
                WrongSessionTokenRefused = true,
                WrongOwnerRefused = true,
                RepeatAssetRows = 1,
                RepeatReferenceRows = 1,
                MissingRevisionReferenceRefused = true,
                OwnedRoot = root,
                OwnedRootRemoved = !Directory.Exists(root),
                AuthorityInputKind = "controlled-plan-article-permission-oracle",
                RealAssetObservation = "original-file-service-native-bytes-postgresql-ledger",
                VaultResourceQualification = false
            }, new System.Text.Json.JsonSerializerOptions
            {
                WriteIndented = true
            });
            await File.WriteAllTextAsync(Path.Combine(directory, $"native-upload-{size}.json"), json);
        }
    }

    [Theory]
    [InlineData(8_387_832, true)]
    [InlineData(8_387_833, false)]
    [InlineData(20_971_520, false)]
    public async Task PreviewBudget_DoesNotReduceOriginalUploadOrLedgerObservation(int size, bool previewAllowed)
    {
        await using var context = await CreateAsync(CreateOriginalPng(size));
        var observed = await context.ObserveAsync();
        Assert.True(observed.IsSuccess, observed.Error.Message);
        Assert.Equal(size, observed.Value!.Asset.SizeBytes);
        Assert.Equal(context.Sha256, observed.Value.Asset.Sha256);
        var preview = await context.Service.ReadCommittedUploadPreviewAsync(context.Access, context.Sha256);
        Assert.Equal(previewAllowed, preview.IsSuccess);
        var http = CreatePreviewRequest(context);
        var aeds = new AedsEncoder();
        var response = await BinaryEndpoints.HandleUploadAssetPreviewAsync(context.Access.UploadId, http, context.Service, aeds, default);
        await response.ExecuteAsync(http);
        await ((ServiceProvider)http.RequestServices).DisposeAsync();
        byte[] responseBytes = ((MemoryStream)http.Response.Body).ToArray();
        var decoded = aeds.TryDecode(responseBytes);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(previewAllowed ? AedsFrameType.UploadAssetPreview : AedsFrameType.ApiError, decoded.Value.FrameType);
        if (previewAllowed)
        {
            Assert.Equal(8_388_608, responseBytes.Length);
            Assert.Equal(context.Bytes, preview.Value!.Bytes.ToArray());
            Assert.Equal(context.Sha256, Convert.ToHexStringLower(SHA256.HashData(preview.Value.Bytes.Span)));
            string? evidence = Environment.GetEnvironmentVariable("FSUSBLOG_PREVIEW_BUDGET_TEST_FRAME");
            if (!string.IsNullOrWhiteSpace(evidence))
                await File.WriteAllBytesAsync(evidence, responseBytes);
        }
        else
        {
            Assert.Null(preview.Value);
            Assert.Equal(ErrorCode.Validation, preview.Error.Code);
            Assert.Equal("upload_asset_preview_too_large", preview.Error.Message);
            var unauthorized = await context.Service.ReadCommittedUploadPreviewAsync(context.Access with
            {
                UploadToken = "wrong-token"
            }, context.Sha256);
            Assert.Equal("UPLOAD_SESSION_NOT_FOUND", unauthorized.Error.Message);
        }
        var status = await context.Service.GetUploadStatusAsync(context.Access);
        Assert.True(status.IsSuccess, status.Error.Message);
        Assert.Equal("completed", status.Value!.Status);
        var repeated = await context.ObserveAsync();
        Assert.Equal(observed.Value.AssetVersionSha256, repeated.Value!.AssetVersionSha256);
        Assert.Equal(observed.Value.ReferenceLedgerSha256, repeated.Value.ReferenceLedgerSha256);
    }

    [Fact]
    public async Task OriginalUploadAndLedger_ProduceStableBytesAndVersionObservation()
    {
        await using var context = await CreateAsync();
        Result<UploadAssetObservation> result = await context.ObserveAsync();
        Assert.True(result.IsSuccess, result.Error.Message);
        UploadAssetObservation observed = result.Value!;
        Assert.Equal(AssetId.FromGuid(Guid.ParseExact(context.Access.UploadId, "N")), observed.Asset.Id);
        Assert.Equal(context.Bytes.Length, observed.Asset.SizeBytes);
        Assert.Equal(context.Sha256, observed.Asset.Sha256);
        Assert.Equal(7L, observed.Asset.OwnerAdminPrincipalId);
        Assert.Equal("/uploads/" + observed.Asset.StorageKey.Value, observed.PublicUrl);
        Assert.Empty(observed.References);
        Assert.Equal(64, observed.AssetVersionSha256.Length);
        Assert.Equal(64, observed.ReferenceLedgerSha256.Length);
        Result<UploadAssetObservation> repeat = await context.ObserveAsync();
        Assert.Equal(observed.Asset, repeat.Value!.Asset);
        Assert.Equal(observed.AssetVersionSha256, repeat.Value.AssetVersionSha256);
        Assert.Equal(observed.ReferenceLedgerSha256, repeat.Value.ReferenceLedgerSha256);

        DateTime updated = DateTime.UtcNow.AddSeconds(1);
        await context.Db.Updateable<ContentAsset>()
            .SetColumns(asset => asset.UpdatedAtUtc == updated)
            .Where(asset => asset.AssetId == observed.Asset.Id.Value)
            .ExecuteCommandAsync();
        Result<UploadAssetObservation> newer = await context.ObserveAsync();
        Assert.True(newer.IsSuccess, newer.Error.Message);
        Assert.NotEqual(observed.AssetVersionSha256, newer.Value!.AssetVersionSha256);
        Assert.Equal(observed.ReferenceLedgerSha256, newer.Value.ReferenceLedgerSha256);
    }

    [Fact]
    public async Task CanonicalReferenceChange_ChangesOnlyItsObservedDigest()
    {
        await using var context = await CreateAsync();
        UploadAssetObservation before = (await context.ObserveAsync()).Value!;
        await context.Db.Insertable(new ContentAssetReference
        {
            AssetId = before.Asset.Id.Value,
            SourceKind = ContentAssetSourceKinds.Revision,
            SourceKey = "revision:42",
            ArticleId = 1,
            ReferenceCount = 2
        }).ExecuteCommandAsync();
        Result<UploadAssetObservation> after = await context.ObserveAsync();
        Assert.True(after.IsSuccess, after.Error.Message);
        Assert.Equal(before.AssetVersionSha256, after.Value!.AssetVersionSha256);
        Assert.NotEqual(before.ReferenceLedgerSha256, after.Value.ReferenceLedgerSha256);
        AssetReference reference = Assert.Single(after.Value.References);
        Assert.Equal(2, reference.ReferenceCount);
        Assert.Equal("revision:42", reference.SourceKey);
    }

    [Theory]
    [InlineData("wrong-owner")]
    [InlineData("wrong-token")]
    [InlineData("wrong-digest")]
    [InlineData("missing-ledger")]
    [InlineData("pending-delete")]
    [InlineData("ledger-owner-drift")]
    [InlineData("bytes-drift")]
    [InlineData("missing-bytes")]
    [InlineData("linked-bytes")]
    public async Task UnqualifiedCurrentFacts_NeverProduceObservation(string mutation)
    {
        await using var context = await CreateAsync();
        AssetId assetId = AssetId.FromGuid(Guid.ParseExact(context.Access.UploadId, "N"));
        string path = Path.Combine(context.Service.StoragePaths.PublicAssetRoot, "illustration", context.Access.UploadId + ".png");
        UploadSessionAccess access = context.Access;
        string digest = context.Sha256;
        switch (mutation)
        {
            case "wrong-owner":
                access = access with
                {
                    OwnerAdminPrincipalId = 8
                };
                break;
            case "wrong-token":
                access = access with
                {
                    UploadToken = "incorrect-token"
                };
                break;
            case "wrong-digest":
                digest = new string('a', 64);
                break;
            case "missing-ledger":
                await context.Db.Deleteable<ContentAsset>().Where(asset => asset.AssetId == assetId.Value).ExecuteCommandAsync();
                break;
            case "pending-delete":
                await context.Db.Updateable<ContentAsset>().SetColumns(asset => asset.State == ContentAssetStates.PendingDelete)
                    .Where(asset => asset.AssetId == assetId.Value).ExecuteCommandAsync();
                break;
            case "ledger-owner-drift":
                await context.Db.Updateable<ContentAsset>().SetColumns(asset => asset.OwnerAdminPrincipalId == 8)
                    .Where(asset => asset.AssetId == assetId.Value).ExecuteCommandAsync();
                break;
            case "bytes-drift":
                byte[] changed = (byte[])context.Bytes.Clone();
                changed[^1] ^= 1;
                await File.WriteAllBytesAsync(path, changed);
                break;
            case "missing-bytes":
                File.Delete(path);
                break;
            case "linked-bytes":
                string outside = Path.Combine(context.Root, "outside.png");
                File.Move(path, outside);
                File.CreateSymbolicLink(path, outside);
                break;
            default:
                throw new InvalidOperationException("unknown_mutation");
        }
        Result<UploadAssetObservation> result = await context.Service.ObserveCommittedUploadAsync(access, digest);
        Assert.False(result.IsSuccess);
        Assert.Null(result.Value);
        Result<UploadAssetPreview> preview = await context.Service.ReadCommittedUploadPreviewAsync(access, digest);
        Assert.False(preview.IsSuccess);
        Assert.Null(preview.Value);
        Result<UploadAssetPreview> input = await context.Service.ReadCommittedUploadInputAsync(access, digest);
        Assert.False(input.IsSuccess);
        Assert.Null(input.Value);
        Assert.Equal(result.Error.Code, input.Error.Code);
        Assert.Equal(result.Error.Message, input.Error.Message);
    }

    [Fact]
    public async Task OriginalFilesystemOnlyConstructor_CannotClaimLedgerObservation()
    {
        await using var context = await CreateAsync();
        var service = new FileService(context.Service.StoragePaths, NullLogger<FileService>.Instance);
        Result<UploadAssetObservation> result = await service.ObserveCommittedUploadAsync(context.Access, context.Sha256);
        Assert.False(result.IsSuccess);
        Assert.Equal("upload_asset_ledger_unavailable", result.Error.Message);
        var input = await service.ReadCommittedUploadInputAsync(context.Access, context.Sha256);
        Assert.False(input.IsSuccess);
        Assert.Equal(result.Error.Message, input.Error.Message);
    }

    [Fact]
    public async Task Cancellation_PrecedesAnySessionOrAssetObservation()
    {
        await using var context = await CreateAsync();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => context.Service.ObserveCommittedUploadAsync(
            default, "invalid", cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => context.Service.ReadCommittedUploadPreviewAsync(
            default, "invalid", cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => context.Service.ReadCommittedUploadInputAsync(
            default, "invalid", cancellation.Token));
    }

    [Fact]
    public async Task ProtectedPreview_ReadsOriginalBytesAndSerializesActualLedgerFacts()
    {
        await using var upload = await CreateAsync();
        var context = CreatePreviewRequest(upload);
        var aeds = new AedsEncoder();
        var result = await BinaryEndpoints.HandleUploadAssetPreviewAsync(upload.Access.UploadId, context, upload.Service, aeds, default);
        await result.ExecuteAsync(context);
        await ((ServiceProvider)context.RequestServices).DisposeAsync();
        var frameResult = aeds.TryDecode(((MemoryStream)context.Response.Body).ToArray());
        Assert.True(frameResult.IsSuccess, frameResult.Error.Message);
        var frame = frameResult.Value;
        Assert.Equal(AedsFrameType.UploadAssetPreview, frame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeUploadAssetPreview(frame.Payload, out var preview));
        var observation = (await upload.ObserveAsync()).Value!;
        Assert.Equal(observation.Asset.Id.ToString(), preview.AssetId);
        Assert.Equal(upload.Bytes, preview.Bytes.ToArray());
        Assert.Equal(upload.Sha256, Convert.ToHexStringLower(SHA256.HashData(preview.Bytes.Span)));
        Assert.Equal(observation.AssetVersionSha256, preview.AssetVersionSha256);
        Assert.Equal(observation.ReferenceLedgerSha256, preview.ReferenceLedgerSha256);
        Assert.Equal("private, no-store", context.Response.Headers.CacheControl);
        var repeatedContext = CreatePreviewRequest(upload);
        var repeatedResult = await BinaryEndpoints.HandleUploadAssetPreviewAsync(upload.Access.UploadId, repeatedContext, upload.Service, aeds, default);
        await repeatedResult.ExecuteAsync(repeatedContext);
        await ((ServiceProvider)repeatedContext.RequestServices).DisposeAsync();
        Assert.Equal(((MemoryStream)context.Response.Body).ToArray(), ((MemoryStream)repeatedContext.Response.Body).ToArray());
        string? evidence = Environment.GetEnvironmentVariable("FSUSBLOG_PREVIEW_TEST_FRAME");
        if (!string.IsNullOrWhiteSpace(evidence))
            await File.WriteAllBytesAsync(evidence, ((MemoryStream)context.Response.Body).ToArray());
        string text = System.Text.Encoding.ASCII.GetString(frame.Payload.Span[..760]);
        Assert.DoesNotContain(upload.Access.UploadToken!, text);
        Assert.DoesNotContain(upload.Root, text);
        Assert.DoesNotContain("article.write", text);
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("wrong-identity")]
    [InlineData("no-permission")]
    [InlineData("wrong-owner")]
    [InlineData("wrong-token")]
    [InlineData("missing-token")]
    [InlineData("wrong-digest")]
    [InlineData("bad-media")]
    [InlineData("wrong-frame")]
    [InlineData("bad-crc")]
    [InlineData("extra-bytes")]
    public async Task ProtectedPreview_NegativeRequestsNeverExposeBytes(string mutation)
    {
        await using var upload = await CreateAsync();
        var context = CreatePreviewRequest(upload, mutation);
        var aeds = new AedsEncoder();
        var result = await BinaryEndpoints.HandleUploadAssetPreviewAsync(upload.Access.UploadId, context, upload.Service, aeds, default);
        await result.ExecuteAsync(context);
        await ((ServiceProvider)context.RequestServices).DisposeAsync();
        var decodedResult = aeds.TryDecode(((MemoryStream)context.Response.Body).ToArray());
        Assert.True(decodedResult.IsSuccess, decodedResult.Error.Message);
        var decoded = decodedResult.Value;
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.NotEqual(200, context.Response.StatusCode);
        Assert.Equal("private, no-store", context.Response.Headers.CacheControl);
    }

    private static DefaultHttpContext CreatePreviewRequest(UploadContext upload, string? mutation = null)
    {
        var aeds = new AedsEncoder();
        byte[] request = aeds.Encode(mutation == "wrong-frame" ? AedsFrameType.UploadInitRequest : AedsFrameType.UploadCompleteRequest,
            PodBinaryCodec.EncodeUploadCompleteRequest(new UploadCompleteRequestCoreModel(mutation == "wrong-digest" ? new string('a', 64) : upload.Sha256)));
        if (mutation == "bad-crc")
            request[^1] ^= 1;
        if (mutation == "extra-bytes")
            request = [.. request, 1];
        var binder = new BinaryRequestBinder();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        requestContext.ReadFrameAsync(Arg.Any<HttpContext>(), Arg.Any<IAedsEncoder>(), AedsFrameType.UploadCompleteRequest,
            Arg.Any<CancellationToken>(), Arg.Any<int?>()).Returns(call => binder.ReadFrameAsync(
                call.ArgAt<HttpContext>(0), call.ArgAt<IAedsEncoder>(1), call.ArgAt<AedsFrameType>(2),
                call.ArgAt<CancellationToken>(3), call.ArgAt<int?>(4)));
        var context = new DefaultHttpContext
        {
            RequestServices = upload.Services,
            User = new ClaimsPrincipal(new ClaimsIdentity(new[]
            {
                new Claim("identity_kind", mutation == "wrong-identity" ? "account" : AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", mutation == "wrong-owner" ? "8" : "7"),
                new Claim(AdminPermissions.PermissionClaimType, mutation == "no-permission" ? AdminPermissions.AuditRead : AdminPermissions.ArticleWrite)
            }, mutation == "anonymous" ? null : "preview-test"))
        };
        context.RequestServices = new ServiceCollection().AddSingleton(requestContext).BuildServiceProvider();
        context.Request.ContentType = mutation == "bad-media" ? "application/json" : "application/octet-stream";
        context.Request.ContentLength = request.Length;
        context.Request.Body = new MemoryStream(request);
        context.Response.Body = new MemoryStream();
        if (mutation != "missing-token")
            context.Request.Headers["X-Fsus-Upload-Token"] = mutation == "wrong-token" ? "invalid" : upload.Access.UploadToken;
        return context;
    }

    [Fact]
    public async Task RealKestrel_OriginalUploadGroupEnforcesSignedClaimsPowSessionAndPreviewBytes()
    {
        await using var upload = await CreateAsync();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var key = new SymmetricSecurityKey(Encoding.ASCII.GetBytes("isolated-preview-test-jwt-key-64-bytes-not-a-production-credential!"));
        // Signed fixture issuer exercises ASP.NET token validation and the original route policies.
        // It does not qualify production admin-session/revocation validation or distributed Redis.
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
        {
            options.MapInboundClaims = false;
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidIssuer = "isolated-preview-test",
                ValidAudience = "isolated-preview-test",
                IssuerSigningKey = key,
                ValidateIssuerSigningKey = true,
                ValidateLifetime = true
            };
        });
        builder.Services.AddAuthorization();
        var governor = new AdaptivePowGovernor(Substitute.For<ICacheStringReader>());
        var pow = new RedisPowService(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Security:Pow:SigningKey"] = "isolated-preview-test-pow-signing-key-not-production"
        }).Build(), NullLogger<RedisPowService>.Instance, governor, new PreviewPowLeases());
        builder.Services.AddSingleton(governor).AddSingleton<IPowService>(pow);
        builder.Services.AddSingleton<IFileService>(upload.Service).AddSingleton<IAedsEncoder>(new AedsEncoder());
        var binder = new BinaryRequestBinder();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        requestContext.ReadFrameAsync(Arg.Any<HttpContext>(), Arg.Any<IAedsEncoder>(), AedsFrameType.UploadCompleteRequest,
            Arg.Any<CancellationToken>(), Arg.Any<int?>()).Returns(call => binder.ReadFrameAsync(
                call.ArgAt<HttpContext>(0), call.ArgAt<IAedsEncoder>(1), call.ArgAt<AedsFrameType>(2),
                call.ArgAt<CancellationToken>(3), call.ArgAt<int?>(4)));
        builder.Services.AddSingleton(requestContext);
        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        // Invoke the real mapper; no test route, missing filter, or product visibility change.
        typeof(BinaryEndpoints).GetMethod("MapBinaryUploadEndpoints", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [app.MapGroup("/api/binary")]);
        await app.StartAsync();
        try
        {
            var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            using var client = new HttpClient(new HttpClientHandler
            {
                UseProxy = false
            })
            {
                BaseAddress = new Uri(address)
            };
            client.DefaultRequestHeaders.Host = "fsus.blog";
            string Token(bool permission) => new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(
                issuer: "isolated-preview-test", audience: "isolated-preview-test", expires: DateTime.UtcNow.AddMinutes(5),
                claims: [new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind), new Claim("admin_id", "7"),
                    new Claim(AdminPermissions.PermissionClaimType, permission ? AdminPermissions.ArticleWrite : AdminPermissions.AuditRead)],
                signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256)));
            async Task<HttpResponseMessage> SendAsync(string? bearer, string? proof, string? uploadToken)
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/binary/upload/{upload.Access.UploadId}/preview");
                request.Content = new ByteArrayContent(new AedsEncoder().Encode(AedsFrameType.UploadCompleteRequest,
                    PodBinaryCodec.EncodeUploadCompleteRequest(new UploadCompleteRequestCoreModel(upload.Sha256))));
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                if (bearer is not null)
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
                if (proof is not null)
                    request.Headers.Add(PowProofCodec.HeaderName, proof);
                if (uploadToken is not null)
                    request.Headers.Add("X-Fsus-Upload-Token", uploadToken);
                return await client.SendAsync(request);
            }
            using var anonymous = await SendAsync(null, null, upload.Access.UploadToken);
            Assert.True(anonymous.StatusCode == HttpStatusCode.Unauthorized, $"anonymous_status={anonymous.StatusCode}; body={await anonymous.Content.ReadAsStringAsync()}");
            using var forbidden = await SendAsync(Token(false), null, upload.Access.UploadToken);
            Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
            string bearer = Token(true);
            using var missingPow = await SendAsync(bearer, null, upload.Access.UploadToken);
            Assert.Equal(HttpStatusCode.Unauthorized, missingPow.StatusCode);
            string proof = await SolvePreviewPowAsync(pow);
            using var success = await SendAsync(bearer, proof, upload.Access.UploadToken);
            Assert.Equal(HttpStatusCode.OK, success.StatusCode);
            Assert.Equal("application/octet-stream", success.Content.Headers.ContentType!.MediaType);
            Assert.True(success.Headers.CacheControl!.NoStore);
            var decoded = new AedsEncoder().TryDecode(await success.Content.ReadAsByteArrayAsync());
            Assert.True(decoded.IsSuccess, decoded.Error.Message);
            Assert.Equal(AedsFrameType.UploadAssetPreview, decoded.Value.FrameType);
            Assert.True(PodBinaryCodec.TryDecodeUploadAssetPreview(decoded.Value.Payload, out var preview));
            Assert.Equal(upload.Bytes, preview.Bytes.ToArray());
            using var replay = await SendAsync(bearer, proof, upload.Access.UploadToken);
            Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
            using var wrongSession = await SendAsync(bearer, await SolvePreviewPowAsync(pow), "incorrect-upload-token");
            Assert.Equal(HttpStatusCode.NotFound, wrongSession.StatusCode);
            using var invalidSignature = await SendAsync(bearer[..^12] + "aaaaaaaaaaaa", null, upload.Access.UploadToken);
            Assert.Equal(HttpStatusCode.Unauthorized, invalidSignature.StatusCode);
        }
        finally
        {
            await app.StopAsync();
        }
    }

    private static async Task<string> SolvePreviewPowAsync(IPowService service)
    {
        var challenge = await service.GenerateChallengeAsync("127.0.0.1");
        const string Fingerprint = "isolated-preview-test";
        for (int nonce = 0; nonce < 5_000_000; nonce++)
        {
            string candidate = nonce.ToString(System.Globalization.CultureInfo.InvariantCulture);
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{challenge.Salt}:{candidate}:{Fingerprint}"));
            int full = challenge.Difficulty / 8;
            if (hash.Take(full).Any(static value => value != 0)
                || (challenge.Difficulty % 8 != 0 && hash[full] >> (8 - challenge.Difficulty % 8) != 0))
                continue;
            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
            writer.Write(new byte[] { (byte)'F', (byte)'P', (byte)'O', (byte)'W', 1 });
            writer.Write(challenge.Difficulty);
            writer.Write(challenge.Timestamp);
            foreach (string field in new[] { challenge.Salt, candidate, challenge.Signature, Fingerprint })
            {
                byte[] value = Encoding.UTF8.GetBytes(field);
                writer.Write(checked((ushort)value.Length));
                writer.Write(value);
            }
            writer.Flush();
            return Convert.ToBase64String(stream.ToArray());
        }
        throw new InvalidOperationException("isolated_preview_pow_solver_exhausted");
    }

    private sealed class PreviewPowLeases : ICacheLeaseStore
    {
        private readonly ConcurrentDictionary<string, string> _leases = new(StringComparer.Ordinal);
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_leases.TryAdd($"{policyId}:{identity}", value));
        }
    }

    private async Task<UploadContext> CreateAsync(byte[]? sourceBytes = null)
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(ContentAsset), typeof(ContentAssetReference), typeof(ContentAssetCleanupQueueItem));
        string root = Path.Combine(Path.GetTempPath(), "fsus-upload-observation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        ServiceProvider services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        try
        {
            var service = new FileService(ReleaseStorageTestPaths.Create(root), NullLogger<FileService>.Instance,
                services.GetRequiredService<IServiceScopeFactory>());
            byte[] bytes = sourceBytes ?? Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB14AAAAASUVORK5CYII=");
            string sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
            Result<FsusBlog.Shared.Contracts.Outputs.UploadInitDto> initialized = await service.InitUploadSessionAsync(7, new UploadInitRequestDto
            {
                FileName = "source.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = bytes.Length,
                ChunkSize = 512 * 1024,
                Sha256 = sha256
            });
            Assert.True(initialized.IsSuccess, initialized.Error.Message);
            var access = new UploadSessionAccess(initialized.Value!.UploadId, 7, initialized.Value.UploadToken);
            for (int offset = 0, part = 0; offset < bytes.Length; offset += initialized.Value.ChunkSize, part++)
            {
                int count = Math.Min(initialized.Value.ChunkSize, bytes.Length - offset);
                using var stream = new MemoryStream(bytes, offset, count);
                var file = new FormFile(stream, 0, count, "file", "source.png");
                string partDigest = Convert.ToHexStringLower(SHA256.HashData(bytes.AsSpan(offset, count)));
                var uploaded = await service.UploadPartAsync(access, part, offset, file, partDigest);
                Assert.True(uploaded.IsSuccess, uploaded.Error.Message);
            }
            var complete = await service.CompleteUploadAsync(access, sha256);
            Assert.True(complete.IsSuccess, complete.Error.Message);
            return new UploadContext(root, db, services, service, access, bytes, sha256);
        }
        catch
        {
            await services.DisposeAsync();
            db.Dispose();
            Directory.Delete(root, recursive: true);
            throw;
        }
    }

    // Test-only valid RGB PNGs, not a product image conversion or preview fallback.
    private static byte[] CreateOriginalPng(int size)
    {
        const int Width = 2048;
        int height = (size - 4096) / (Width * 3 + 1);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.NoCompression, leaveOpen: true))
            zlib.Write(new byte[height * (Width * 3 + 1)]);
        using var image = new MemoryStream(size);
        image.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        byte[] header = new byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header, Width);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
        header[8] = 8;
        header[9] = 2;
        WritePngChunk(image, "IHDR"u8, header);
        WritePngChunk(image, "IDAT"u8, compressed.ToArray());
        int padding = checked(size - (int)image.Length - 24);
        Assert.InRange(padding, 5, 16 * 1024);
        byte[] text = new byte[padding];
        "fsus\0"u8.CopyTo(text);
        text.AsSpan(5).Fill((byte)'a');
        WritePngChunk(image, "tEXt"u8, text);
        WritePngChunk(image, "IEND"u8, []);
        Assert.Equal(size, image.Length);
        return image.ToArray();
    }

    private static void WritePngChunk(Stream image, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> word = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(word, data.Length);
        image.Write(word);
        image.Write(type);
        image.Write(data);
        uint crc = uint.MaxValue;
        foreach (byte value in type)
            Update(value);
        foreach (byte value in data)
            Update(value);
        BinaryPrimitives.WriteUInt32BigEndian(word, ~crc);
        image.Write(word);
        void Update(byte value)
        {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++)
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xedb88320u : crc >> 1;
        }
    }

    private sealed record UploadContext(string Root, SqlSugarClient Db, ServiceProvider Services, FileService Service,
        UploadSessionAccess Access, byte[] Bytes, string Sha256) : IAsyncDisposable
    {
        public Task<Result<UploadAssetObservation>> ObserveAsync()
            => Service.ObserveCommittedUploadAsync(Access, Sha256);

        public async ValueTask DisposeAsync()
        {
            await Services.DisposeAsync();
            Db.Dispose();
            Directory.Delete(Root, recursive: true);
        }
    }
}
