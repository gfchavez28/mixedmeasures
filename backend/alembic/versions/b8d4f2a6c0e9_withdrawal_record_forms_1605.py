"""#1605 (D230) — a withdrawal made before this release learns its ID's other Unicode
form, and that ID as a name in other capitals or spacing.

Revision ID: b8d4f2a6c0e9
Revises: f2a6c8d4b1e7

A withdrawal remembers the person's ID as a hash (`removal_tombstones`, #1190) so no
import, link or typed create brings them back. Before this release the hash was taken
over the ID as written, trimmed only, and names were compared the same way. So an ID
written in the other Unicode form — a decomposed accent, which some Mac and
transcription tools write and which reads the same on screen — or a transcript writing
the person's name in other capitals (`MARÍA LÓPEZ`) brought them back as a new
participant. This release compares IDs in any canonically equivalent form (capitals
kept: `P01` and `p01` can be two people) and names folded (capitals, spacing and how an
accent is encoded ignored) — `services/tombstones.py`.

## What this adds, for each withdrawal made on this install

The `withdrawn` audit entry keeps the person's ID in plain text (decision D9), so the
two hashes the new writer takes over that ID can be added where missing:
- the ID kind's hash over the composed (NFC) ID. For an ID already composed — every
  ASCII code — it is the hash already stored, and nothing is added;
- the name kind's FOLDED hash of the ID (D229: a participant made from a transcript has
  ID == name, and only the name kind ignores capitals).

## What it cannot add (stated in the app's record note)

Her OTHER names — display name, speaker names, labels — are not in the audit entry,
so they keep matching exactly as they were written. A withdrawal that reached this
project through a merged file (a colleague's) has no audit entry here and keeps its
rows as they are. A project the withdrawal outlived (deleted since) is not reached: the
entry is joined to its project for the identity the rows are keyed by.

## Data only, two statements, nothing from `app.`

No schema change. One `INSERT … SELECT … WHERE NOT EXISTS` per kind, on the connection
it is given, inside the chain's one transaction (`backend/alembic/the internal design notes). The
hashes are made by Python functions registered on this connection only; the two rules
are COPIED here, never imported, because a revision must do the same thing on every
database it ever meets while the app's modules may change.
`tests/test_withdrawal_record_upgrade_1605.py` holds these copies equal to
`tombstones.identifier_hash` / `folded_name_hash`. The functions parse the entry's JSON
themselves and answer NULL for anything they cannot read — a malformed entry is skipped,
never a failed update. `SELECT DISTINCT` and the `NOT EXISTS` make it idempotent (the
same ID withdrawn twice is one row).

## Downgrade does nothing

The rows it adds are values in kinds an older build already reads: the composed ID
hash is a correct match for that build too, and a folded name hash matches nothing
there (its prefix is new). The joint display's fence (`e7b3c5a9d2f4`) keeps an older
build from opening this database anyway.
"""
import hashlib
import json
import unicodedata

from alembic import op
import sqlalchemy as sa


revision = 'b8d4f2a6c0e9'
down_revision = 'f2a6c8d4b1e7'
branch_labels = None
depends_on = None


# ── The two hash rules, COPIED from `services/tombstones.py` at #1605 (never imported).
_ID_PREFIX = "mm-withdrawn-identifier:v1:"
_NAME_FOLD_PREFIX = "mm-withdrawn-name:v2:"


def _trim(text):
    # `identifier_match.normalize_key`: `raw.strip() if raw else ""`.
    return text.strip() if text else ""


def _sha(prefix, key):
    return hashlib.sha256((prefix + key).encode("utf-8")).hexdigest()


def identifier_hash(identifier):
    """`tombstones.identifier_hash`: the trimmed ID, composed (NFC), capitals kept."""
    key = _trim(identifier)
    return _sha(_ID_PREFIX, unicodedata.normalize("NFC", key)) if key else None


def folded_name_hash(name):
    """`tombstones.folded_name_hash`: whitespace collapsed, NFD(casefold(NFD(x)))."""
    key = _trim(name)
    if not key:
        return None
    folded = unicodedata.normalize(
        "NFD", unicodedata.normalize("NFD", " ".join(key.split())).casefold())
    return _sha(_NAME_FOLD_PREFIX, folded)


def _identifier_in(details):
    """The plain ID a `withdrawn` audit entry keeps (`RedactionOutcome.identifier`), or
    None for an entry this cannot read."""
    try:
        parsed = json.loads(details) if details else None
    except (TypeError, ValueError):
        return None
    ident = parsed.get("identifier") if isinstance(parsed, dict) else None
    return ident if isinstance(ident, str) else None


def _hash_of_entry(rule):
    def fn(details):
        ident = _identifier_in(details)
        return rule(ident) if ident is not None else None
    return fn


#: (SQL function name, the tombstone kind it writes, its rule).
_KINDS = (
    ("mm_1605_identifier_hash", "participant", identifier_hash),
    ("mm_1605_folded_name_hash", "participant_name", folded_name_hash),
)


def _insert_missing(fn_name):
    return sa.text(f"""
        INSERT INTO removal_tombstones
            (project_uuid, entity_type, entity_uuid, identifier_hash, reason, created_at)
        SELECT DISTINCT p.project_uuid, :kind, NULL, {fn_name}(a.details), 'withdrawal',
               CURRENT_TIMESTAMP
        FROM audit_entries AS a
        JOIN projects AS p ON p.id = a.project_id
        WHERE a.action = 'withdrawn'
          AND a.entity_type = 'participant'
          AND p.project_uuid IS NOT NULL
          AND {fn_name}(a.details) IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM removal_tombstones AS t
              WHERE t.project_uuid = p.project_uuid
                AND t.entity_type = :kind
                AND t.identifier_hash = {fn_name}(a.details)
          )
    """)


def upgrade() -> None:
    conn = op.get_bind()
    raw = conn.connection.driver_connection
    for fn_name, kind, rule in _KINDS:
        raw.create_function(fn_name, 1, _hash_of_entry(rule))
        conn.execute(_insert_missing(fn_name), {"kind": kind})


def downgrade() -> None:
    pass
