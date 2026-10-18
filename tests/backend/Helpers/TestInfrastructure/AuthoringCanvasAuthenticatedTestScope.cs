using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests.TestInfrastructure;

// Uses the actual frozen validation/registration producer and PostgreSQL authority rows.
// The ambient context is installed synchronously, so async fixture setup mutates that
// original request object rather than losing an AsyncLocal assignment at an await boundary.
internal sealed class AuthoringCanvasAuthenticatedTestScope : IDisposable
{
    private readonly HttpContext? _previous;
    private readonly DefaultHttpContext _context = new();
    private readonly List<IDisposable> _owned = [];

    internal AuthoringCanvasAuthenticatedTestScope()
    {
        var accessor = new HttpContextAccessor();
        _previous = accessor.HttpContext;
        accessor.HttpContext = _context;
    }

    internal static AuthoringCanvasAuthenticatedTestScope Standalone(PostgresSchemaMigrationFixture fixture, long owner)
    {
        var scope = new AuthoringCanvasAuthenticatedTestScope();
        SqlSugarClient db = PostgresSqlSugarTestClient.CreateAsync(fixture).GetAwaiter().GetResult();
        scope._owned.Add(db);
        db.Ado.ExecuteCommand("CREATE TABLE admin_principal(id bigint PRIMARY KEY, status text NOT NULL, validationversion bigint NOT NULL DEFAULT 1);");
        db.Ado.ExecuteCommand("INSERT INTO admin_principal(id, status) VALUES (@Owner, 'active');", new SugarParameter("@Owner", owner));
        AttachAsync(db, owner).GetAwaiter().GetResult();
        return scope;
    }

    internal static async Task AttachAsync(SqlSugarClient db, long owner)
    {
        HttpContext context = new HttpContextAccessor().HttpContext
            ?? throw new InvalidOperationException("Canvas test request context missing.");
        await db.Ado.ExecuteCommandAsync("ALTER TABLE admin_principal ADD COLUMN IF NOT EXISTS validationversion bigint NOT NULL DEFAULT 1;");
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminSession));
        DateTime now = DateTime.UtcNow;
        string sessionId = Guid.CreateVersion7().ToString("N");
        string token = Guid.CreateVersion7().ToString("N");
        await db.Insertable(new AdminSession
        {
            SessionId = sessionId,
            AdminPrincipalId = owner,
            AccessTokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))),
            ValidationVersion = 1,
            CreatedAtUtc = now.AddMinutes(-1),
            IdleExpiresAtUtc = now.AddHours(1),
            AbsoluteExpiresAtUtc = now.AddHours(2)
        }).ExecuteCommandAsync();
        var options = AdminSessionProjectionRuntimeOptions.FromConfiguration(new ConfigurationBuilder().Build());
        var projection = new AdminSessionProjection(options.ProjectionLimits, TimeProvider.System);
        var authority = new AdminSessionProjectionAuthorityReader(db, projection, options, TimeProvider.System);
        if (!projection.MarkReady(await authority.LoadColdStartAsync()))
        {
            throw new InvalidOperationException("Canvas test projection not ready.");
        }
        ServiceProvider services = new ServiceCollection().AddSingleton<ISqlSugarClient>(db).BuildServiceProvider();
        var touches = new AdminSessionTouchScheduler(services.GetRequiredService<IServiceScopeFactory>(), options,
            TimeProvider.System, NullLogger<AdminSessionTouchScheduler>.Instance);
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", owner.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("admin_sid", sessionId)
        ], "canvas-original-fixture"));
        var validator = new AdminSessionValidationService(projection, touches);
        AdminSessionValidationResult admitted = await validator.ValidateAsync(principal, token, context.RequestAborted);
        if (!admitted.IsValid || admitted.RequestLifetime is not { } lifetime)
        {
            touches.Dispose();
            services.Dispose();
            throw new InvalidOperationException("Canvas test genuine admission failed.");
        }
        lifetime.BindRequest(context.RequestAborted);
        context.Items["canvas-auth-fixture-token"] = token;
        context.Items[typeof(AdminSessionProjection)] = projection;
        context.Items[typeof(AdminSessionValidationService)] = validator;
        context.User = principal;
        context.RequestServices = services;
        context.Features.Set<IAdminAuthenticatedRequestFeature>(new AdminAuthenticatedRequestFeature(lifetime));
        if (context.Items[typeof(AuthoringCanvasAuthenticatedTestScope)] is not List<IDisposable> owned)
        {
            owned = [];
            context.Items[typeof(AuthoringCanvasAuthenticatedTestScope)] = owned;
        }
        owned.Add(services);
        owned.Add(touches);
        owned.Add(lifetime);
    }

    internal static async Task<IDisposable> SwitchOwnerAsync(SqlSugarClient db, long owner)
    {
        HttpContext context = new HttpContextAccessor().HttpContext!;
        var restore = new RestoreOwner(context, context.User, context.RequestServices,
            context.Features.Get<IAdminAuthenticatedRequestFeature>());
        await AttachAsync(db, owner);
        return restore;
    }

    private sealed class RestoreOwner(HttpContext context, ClaimsPrincipal principal, IServiceProvider services,
        IAdminAuthenticatedRequestFeature? feature) : IDisposable
    {
        public void Dispose()
        {
            context.User = principal;
            context.RequestServices = services;
            context.Features.Set(feature);
        }
    }

    public void Dispose()
    {
        if (_context.Items[typeof(AuthoringCanvasAuthenticatedTestScope)] is List<IDisposable> owned)
        {
            for (int index = owned.Count - 1; index >= 0; index--)
            {
                owned[index].Dispose();
            }
        }
        for (int index = _owned.Count - 1; index >= 0; index--)
        {
            _owned[index].Dispose();
        }
        new HttpContextAccessor().HttpContext = _previous;
    }
}
