ALTER TABLE public.article_publication_transparency ADD CONSTRAINT publication_transparency_exact_head
    UNIQUE (seq, entry_sha256);

CREATE TABLE public.publication_transparency_head (
    singleton boolean PRIMARY KEY CHECK (singleton),
    seq bigint NOT NULL,
    entry_sha256 bytea NOT NULL CHECK (octet_length(entry_sha256)=32),
    origin text NOT NULL,
    key_id text NOT NULL,
    key_version integer NOT NULL,
    key_sha256 bytea NOT NULL,
    attested_at timestamptz NOT NULL,
    signature bytea NOT NULL CHECK (octet_length(signature)=64),
    FOREIGN KEY (seq,entry_sha256) REFERENCES public.article_publication_transparency(seq,entry_sha256),
    FOREIGN KEY (key_id,key_version,key_sha256) REFERENCES public.publication_proof_key(key_id,version,spki_sha256)
);
