CREATE TABLE public.private_media_upload (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.blog_user (id),
    command_id uuid NOT NULL,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
    format smallint NOT NULL CHECK (format BETWEEN 1 AND 2),
    length integer NOT NULL CHECK (length BETWEEN 1 AND 20971520),
    part_size integer NOT NULL CHECK (part_size BETWEEN 65536 AND 2097152),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    expires_at timestamptz NOT NULL,
    asset_id uuid REFERENCES public.private_media (id),
    complete boolean NOT NULL DEFAULT false CHECK (NOT complete OR asset_id IS NOT NULL),
    UNIQUE (owner_id, command_id)
);

CREATE TABLE public.private_media_upload_part (
    upload_id uuid NOT NULL REFERENCES public.private_media_upload (id),
    part integer NOT NULL CHECK (part BETWEEN 0 AND 319),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),
    PRIMARY KEY (upload_id, part)
);

CREATE INDEX private_media_upload_expiry ON public.private_media_upload (expires_at, id);
CREATE INDEX private_media_upload_asset ON public.private_media_upload (asset_id) WHERE asset_id IS NOT NULL;
