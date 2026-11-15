CREATE TABLE public.site_passkey_name (
    credential_id bytea PRIMARY KEY,
    user_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64 AND octet_length(name) <= 256),
    FOREIGN KEY (credential_id, user_id) REFERENCES public.passkey_credential (credential_id, user_id) ON DELETE CASCADE
);
