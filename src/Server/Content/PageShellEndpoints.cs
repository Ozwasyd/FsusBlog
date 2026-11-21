namespace FsusBlog.V2.Server.Content;

internal static class PageShellEndpoints
{
    private static readonly string[] ReaderWorkspaceRoutes = ["/user/identity/mfa", "/user/messagebox"];

    internal static void Map(WebApplication app, Publications publications, bool publicMediaEnabled)
    {
        var webPages = app.Services.GetRequiredService<WebPages>();
        var shell = webPages.Page();
        var archiveShell = webPages.PublicListingPage("page.archive", SiteLocale.Default, "/archive");
        var englishArchiveShell = webPages.PublicListingPage("page.archive", "en", "/archive");
        var searchShell = webPages.PublicListingPage("page.search", SiteLocale.Default, "/search");
        var englishSearchShell = webPages.PublicListingPage("page.search", "en", "/search");
        var loginShell = webPages.SiteLoginPage();
        var englishLoginShell = webPages.SiteLoginPage("en");
        var registerShell = webPages.ReaderRegistrationPage();
        var englishRegisterShell = webPages.ReaderRegistrationPage("en");

        app.MapGet("/", (HttpContext ctx) =>
        {
            var snapshot = ServerHttp.Snapshot(ctx, publications);
            var body = SiteLocale.Select(ctx) == "en" ? snapshot.EnglishHome : snapshot.Home;
            ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot);
            return PublicResponse.Write(ctx, body, ServerHttp.HtmlContentType);
        });
        app.MapGet("/article/{id:int}", (HttpContext ctx, int id) =>
            PublicReadEndpoints.PublicDetail(ctx, publications, publicMediaEnabled, id, asHtml: true));
        app.MapGet("/archive", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.Bytes(SiteLocale.Select(ctx) == "en" ? englishArchiveShell : archiveShell, ServerHttp.HtmlContentType);
        });
        app.MapGet("/user/comments", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            ctx.Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
            return Results.Bytes(shell, ServerHttp.HtmlContentType);
        });
        app.MapGet("/search", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.Bytes(SiteLocale.Select(ctx) == "en" ? englishSearchShell : searchShell, ServerHttp.HtmlContentType);
        });
        app.MapGet("/login", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.Bytes(SiteLocale.Select(ctx) == "en" ? englishLoginShell : loginShell, ServerHttp.HtmlContentType);
        });
        app.MapGet("/register", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.Bytes(SiteLocale.Select(ctx) == "en" ? englishRegisterShell : registerShell, ServerHttp.HtmlContentType);
        });
        app.MapGet("/user", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.Redirect("/user/identity/mfa");
        });
        foreach (var route in ReaderWorkspaceRoutes)
        {
            app.MapGet(route, (HttpContext ctx) =>
            {
                ServerHttp.NoStore(ctx);
                return Results.Bytes(shell, ServerHttp.HtmlContentType);
            });
        }
        app.MapGet("/health/ready", (HttpContext ctx) =>
        {
            ServerHttp.NoStore(ctx);
            return Results.StatusCode(publications.Snapshot is null ? 503 : 204);
        });
        app.MapFallback("/api/{**rest}", ctx => ServerHttp.Error(ctx, 404, "Unknown API route.").ExecuteAsync(ctx));
    }
}
