CREATE TABLE public.site_session_refresh (
    family_id uuid PRIMARY KEY,
    access_digest bytea NOT NULL UNIQUE REFERENCES public.user_session (digest) ON DELETE CASCADE ON UPDATE CASCADE
        CHECK (octet_length(access_digest) = 32),
    refresh_digest bytea NOT NULL UNIQUE CHECK (octet_length(refresh_digest) = 32),
    previous_access_digest bytea CHECK (octet_length(previous_access_digest) = 32),
    generation bigint NOT NULL CHECK (generation >= 0),
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    rotated_at timestamptz NOT NULL,
    CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE TABLE public.site_session_refresh_tombstone (
    refresh_digest bytea PRIMARY KEY CHECK (octet_length(refresh_digest) = 32),
    family_id uuid NOT NULL REFERENCES public.site_session_refresh (family_id) ON DELETE CASCADE,
    generation bigint NOT NULL CHECK (generation >= 0),
    used_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    CHECK (used_at < expires_at)
);
CREATE INDEX site_session_refresh_tombstone_expiry ON public.site_session_refresh_tombstone (expires_at);
CREATE INDEX site_session_refresh_tombstone_family ON public.site_session_refresh_tombstone (family_id);
