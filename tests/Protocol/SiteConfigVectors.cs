using FsusBlog.V2.Contracts;

internal static class SiteConfigVectors
{
    internal static void Run(string fixtures)
    {
        Equal("seo-config-v1.hex", SiteConfigWire.EncodeSeo(new()
        {
            Title = "A️⃣ 公开 · Site", Description = "独立描述 & café\nLine two 🐈", Keywords = "k=α", Author = "Fsu🐈",
            OgImage = "https://cdn.example.test/og.png", BaseUrl = "https://scope.example.test:8443", FaviconSvgUrl = "/assets/site.svg",
            FaviconIcoUrl = "/favicon.ico", FaviconPngUrl = "/fav.png", AppleTouchIconUrl = "/apple.png", ManifestName = "测试清单",
            ManifestShortName = "名字", PwaIcon192Url = "/pwa192.png", PwaIcon512Url = "/pwa512.png", PwaMaskableIconUrl = "/maskable.png",
            ThemeColor = "#112233", BackgroundColor = "#445566", SiteLogoUrl = "/light.svg", SiteLogoDarkUrl = "/dark.svg",
            SiteWordmarkUrl = "/wordmark.svg", AdminLogoUrl = "/backoffice.svg", AdminCollapsedIconUrl = "/compact.svg", LoginLogoUrl = "/login.svg",
            LoginIconUrl = new string('x', 252) + "🧪"
        }));
        Equal("site-compliance-v1.hex", SiteConfigWire.EncodeCompliance(new()
        {
            Enabled = true, RegionMode = "mainland-cn", CopyrightStartYear = 2024, CopyrightOwner = "站点所有者", CopyrightText = "©保留 · 独立\nRésumé 🧭",
            ContentLicenseName = "CC BY 4.0", ContentLicenseUrl = "https://creativecommons.org/licenses/by/4.0/", IcpRecordNumber = "示例ICP备123号",
            IcpRecordUrl = "https://icp.example.test/check", PoliceRecordNumber = "示例网安备012号", PoliceRecordUrl = "https://police.example.test/check",
            PoliceBadgeIconUrl = "/badge.svg", OperatorName = "测试 Operator", ContactEmail = "public@example.test"
        }));
        Reject(() => SiteConfigWire.EncodeSeo(new() { Title = new string('x', 253) + "🧪" }));
        Reject(() => SiteConfigWire.EncodeSeo(new() { Description = new string('x', WireLimits.SiteConfigBlobBytes) + "🙂" }));
        Reject(() => SiteConfigWire.EncodeSeo(new() { Keywords = "Null\0padding" }));
        Reject(() => SiteConfigWire.EncodeSeo(new() { ManifestShortName = "\ud800" }));
        Reject(() => SiteConfigWire.EncodeCompliance(new() { RegionMode = "unknown" }));
        Reject(() => SiteConfigWire.EncodeCompliance(new() { CopyrightStartYear = -1 }));
        var compliance = Aeds.Decode(SiteConfigWire.EncodeCompliance(new()), FrameType.SiteComplianceConfig);
        if (compliance.Length != WireLayouts.SiteComplianceBlobOffset || compliance[0] != 0)
            throw new InvalidOperationException("Disabled compliance does not retain the v1 POD shape");

        void Equal(string name, byte[] actual) =>
            VectorFixture.Equal(VectorFixture.MultilineHex(fixtures, name), actual, $"Site config bytes differ for {name}");

        static void Reject(Action encode) =>
            ProtocolRejection.Assert(encode, "Invalid site config encoded");
    }
}
