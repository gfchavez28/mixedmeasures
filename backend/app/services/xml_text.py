"""Text bound for a file that is XML underneath: `.xlsx`, `.docx`, `.qdc` (#1485).

XML 1.0 (§2.2, `Char`) cannot hold the C0 control characters other than tab,
newline and return, any half of a surrogate pair, or U+FFFE / U+FFFF — not even
escaped. MEASURED over every code point (lxml 6.1.0): lxml refuses exactly
those 2,079 and no others, and each library meets one by failing the WHOLE
file:

- openpyxl 3.1.5 raises ``IllegalCharacterError`` when a C0 character is
  ASSIGNED to a cell — its own check covers 29 of the 2,079 — and lxml raises
  at ``save`` for the rest (a sheet TITLE is only checked at ``save``);
- python-docx 1.2.0 raises ``ValueError`` / ``UnicodeEncodeError`` as the run,
  paragraph, heading or table cell is added;
- the stdlib ElementTree behind `.qdc` raises nothing and writes a file no XML
  reader opens.

The import doors keep these characters (a CSV answer stores ``\\x0b`` as it
came), and so do the screen, the CSV exports and the R export. Only a file
that CANNOT hold one is cleaned, here, as it is written — never at the door,
and never in the database.

``\\x0b`` (vertical tab: FileMaker's in-cell return, Word's manual line break
pasted as text) and ``\\x0c`` (form feed) become a line break, so two lines do
not glue into one word; every other one is removed.
"""

import re

_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
_LINE_BREAKS = ("\x0b", "\x0c")


def xml_safe_text(value, line_break: str = "\n"):
    """``value`` with every character XML 1.0 cannot hold removed.

    ``\\x0b`` and ``\\x0c`` become ``line_break`` — a newline by default, which
    python-docx writes as Word's own line break and a spreadsheet keeps inside
    the cell; pass ``" "`` where the text must stay on one line (a sheet title,
    a name attribute). Anything that is not a ``str`` passes through unchanged,
    so a number keeps its type.
    """
    if not isinstance(value, str) or _XML_ILLEGAL.search(value) is None:
        return value
    return _XML_ILLEGAL.sub(
        lambda m: line_break if m.group() in _LINE_BREAKS else "", value,
    )


def xml_safe_tree(value):
    """A copy of a JSON-shaped value with ``xml_safe_text`` applied to every
    string in it, keys included — for a Tiptap document, whose every attr is a
    renderer's to read. Never mutates its argument."""
    if isinstance(value, str):
        return xml_safe_text(value)
    if isinstance(value, dict):
        return {xml_safe_text(k): xml_safe_tree(v) for k, v in value.items()}
    if isinstance(value, list):
        return [xml_safe_tree(v) for v in value]
    return value
