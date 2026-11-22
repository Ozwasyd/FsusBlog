"""Independent FHS2 v4 pages used by patch and catalog tests."""

import struct


def posting_vector(article_ids):
    # All IDs in this fixture have one-byte deltas. Each row has body TF 1
    # and zero positions.
    return bytes([len(article_ids)]) + b"".join(
        bytes((article_id - previous, 0, 0, 1, 0))
        for previous, article_id in zip((0, *article_ids), article_ids)
    )


def encode_terms(terms):
    term_table = bytearray()
    posting_data = bytearray()
    for term_hash, postings, positions in terms:
        term_table.extend(struct.pack(
            "<IfIIII", term_hash, 1.0, len(posting_data), len(postings), positions, 0,
        ))
        posting_data.extend(postings)
    return term_table, posting_data


def assemble_shard(role, flags, term_count, document_count, term_table, rows, posting_data):
    # FHS2 v4 has a 72-byte header and 8-byte-aligned empty sections.
    terms_at = 72
    documents_at = terms_at + len(term_table)
    document_end = documents_at + len(rows)
    empty_sections_at = (document_end + 7) & ~7
    header = struct.pack(
        "<4s16If", b"FHS2", 4, role, flags, term_count, document_count, 0, 0, 0,
        terms_at, documents_at, empty_sections_at, empty_sections_at, empty_sections_at,
        empty_sections_at, empty_sections_at, len(posting_data), 1.0,
    )
    return header + term_table + rows + bytes(empty_sections_at - document_end) + posting_data
