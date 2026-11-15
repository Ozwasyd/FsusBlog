CREATE TABLE public.article_publication_transparency (
    seq bigint PRIMARY KEY CHECK (seq>0),
    publication_id bigint NOT NULL UNIQUE REFERENCES public.article_publication_proof(publication_id),
    prev_sha256 bytea NOT NULL CHECK (octet_length(prev_sha256)=32),
    receipt_sha256 bytea NOT NULL CHECK (octet_length(receipt_sha256)=32),
    entry_sha256 bytea NOT NULL CHECK (octet_length(entry_sha256)=32),
    UNIQUE (seq, publication_id)
);

ALTER TABLE public.article_publication_proof ADD COLUMN transparency_seq bigint;
ALTER TABLE public.article_publication_proof ADD CONSTRAINT publication_proof_exact_transparency
    FOREIGN KEY (transparency_seq,publication_id) REFERENCES public.article_publication_transparency(seq,publication_id)
    DEFERRABLE INITIALLY DEFERRED;
