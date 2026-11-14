CREATE TABLE public.site_recovery_key (
    user_id uuid PRIMARY KEY REFERENCES public.passkey_subject (user_id),
    lookup_digest bytea NOT NULL UNIQUE CHECK (octet_length(lookup_digest) = 32),
    salt bytea NOT NULL CHECK (octet_length(salt) = 16),
    verifier bytea NOT NULL CHECK (octet_length(verifier) = 32),
    version bigint NOT NULL CHECK (version > 0),
    created_at timestamptz NOT NULL,
    used_at timestamptz,
    failed_count smallint NOT NULL CHECK (failed_count BETWEEN 0 AND 8),
    failure_until timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.site_recovery_flow (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    user_id uuid NOT NULL REFERENCES public.passkey_subject (user_id),
    generation bigint NOT NULL CHECK (generation > 0),
    session_digest bytea NOT NULL CHECK (octet_length(session_digest) = 32),
    purpose smallint NOT NULL CHECK (purpose BETWEEN 1 AND 2),
    kind smallint NOT NULL,
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    expires_at timestamptz NOT NULL,
    UNIQUE (user_id, purpose, kind),
    CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
);

CREATE TABLE public.site_recovery_rebind (
    user_id uuid PRIMARY KEY REFERENCES public.passkey_subject (user_id),
    generation bigint NOT NULL CHECK (generation > 0),
    ticket_digest bytea NOT NULL UNIQUE CHECK (octet_length(ticket_digest) = 32),
    expires_at timestamptz NOT NULL,
    challenge_digest bytea CHECK (octet_length(challenge_digest) = 32),
    options text CHECK (octet_length(options) BETWEEN 1 AND 8192),
    challenge_expires_at timestamptz,
    request_digest bytea CHECK (octet_length(request_digest) = 32),
    completed_at timestamptz,
    CHECK ((challenge_digest IS NULL) = (options IS NULL)),
    CHECK ((challenge_digest IS NULL) = (challenge_expires_at IS NULL)),
    CHECK ((request_digest IS NULL) = (completed_at IS NULL))
);
