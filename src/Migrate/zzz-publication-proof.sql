CREATE TABLE public.publication_proof_key (
    key_id text PRIMARY KEY,
    version integer NOT NULL CHECK (version>0),
    spki_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(spki_sha256)=32),
    not_before timestamptz NOT NULL,
    not_after timestamptz NOT NULL CHECK (not_after>=not_before),
    revoked_at timestamptz,
    compromised_at timestamptz,
    UNIQUE (key_id,version,spki_sha256)
);

CREATE TABLE public.article_publication_proof (
    publication_id bigint PRIMARY KEY REFERENCES public.article_publication_canonical(publication_id),
    origin text NOT NULL,
    key_id text NOT NULL,
    key_version integer NOT NULL,
    key_sha256 bytea NOT NULL,
    issued_at timestamptz NOT NULL,
    signature bytea NOT NULL CHECK (octet_length(signature)=64),
    FOREIGN KEY (key_id,key_version,key_sha256) REFERENCES public.publication_proof_key(key_id,version,spki_sha256)
);
