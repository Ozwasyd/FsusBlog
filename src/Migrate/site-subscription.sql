CREATE TABLE public.site_subscription (
    email_key bytea PRIMARY KEY CHECK (octet_length(email_key) = 32),
    channel smallint NOT NULL CHECK (channel >= 1 AND channel <= 2),
    enabled boolean NOT NULL,
    created_at timestamptz NOT NULL,
    unsubscribed_at timestamptz,
    proof_digest bytea CHECK (octet_length(proof_digest) = 32),
    proof_expires_at timestamptz,
    CHECK (enabled = (unsubscribed_at IS NULL)),
    CHECK ((proof_digest IS NULL) = (proof_expires_at IS NULL)),
    CHECK (enabled OR proof_digest IS NULL)
);
