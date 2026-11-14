namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string SiteSubscriptionRelation = "public.site_subscription";

    private static readonly string[] SiteSubscriptionColumns =
    [
        "site_subscription email_key:bytea channel:int2 enabled:bool created_at:timestamptz unsubscribed_at:timestamptz? proof_digest:bytea? proof_expires_at:timestamptz?"
    ];

    private static readonly string[] SiteSubscriptionConstraints =
    [
        "site_subscription p email_key",
        "site_subscription c email_key octet_length(email_key)=32",
        "site_subscription c channel channel>=1ANDchannel<=2",
        "site_subscription c enabled,unsubscribed_at enabled=(unsubscribed_atISNULL)",
        "site_subscription c proof_digest octet_length(proof_digest)=32",
        "site_subscription c proof_digest,proof_expires_at (proof_digestISNULL)=(proof_expires_atISNULL)",
        "site_subscription c enabled,proof_digest enabledORproof_digestISNULL"
    ];
}
