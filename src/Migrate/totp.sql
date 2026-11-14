CREATE TABLE public.mfa_totp (
    user_id uuid PRIMARY KEY REFERENCES public.passkey_subject (user_id),
    sealed_seed bytea NOT NULL CHECK (octet_length(sealed_seed) = 49),
    last_step bigint NOT NULL CHECK (last_step >= 0),
    verified_at timestamptz NOT NULL,
    retry_after timestamptz NOT NULL,
    failed_count integer NOT NULL CHECK (failed_count >= 0 AND failed_count <= 5)
);

CREATE TABLE public.mfa_recovery_code (
    user_id uuid NOT NULL REFERENCES public.mfa_totp (user_id),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    PRIMARY KEY (user_id, digest)
);

CREATE TABLE public.mfa_setup (
    user_id uuid PRIMARY KEY REFERENCES public.passkey_subject (user_id),
    generation bigint NOT NULL CHECK (generation > 0),
    session_digest bytea NOT NULL CHECK (octet_length(session_digest) = 32),
    sealed_seed bytea NOT NULL CHECK (octet_length(sealed_seed) = 49),
    expires_at timestamptz NOT NULL,
    failed_count integer NOT NULL CHECK (failed_count >= 0 AND failed_count <= 5)
);

CREATE TABLE public.mfa_flow (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    user_id uuid NOT NULL REFERENCES public.passkey_subject (user_id),
    generation bigint NOT NULL CHECK (generation > 0),
    kind integer NOT NULL CHECK (kind >= 1 AND kind <= 5),
    scope bytea NOT NULL CHECK (octet_length(scope) >= 1 AND octet_length(scope) <= 1055),
    options text NOT NULL CHECK (octet_length(options) <= 8192),
    expires_at timestamptz NOT NULL
);
CREATE INDEX mfa_flow_expiry ON public.mfa_flow (expires_at);
CREATE INDEX mfa_flow_user ON public.mfa_flow (user_id, kind);

ALTER TABLE public.user_session ADD COLUMN totp_verified_at timestamptz;
