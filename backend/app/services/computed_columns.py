"""Expression engine for computed dataset columns.

Provides a safe, restricted expression language that researchers use to derive
new variables from existing columns.  The engine parses an expression string
into an AST, validates column references, evaluates per-row, and translates
to equivalent R code for reproducibility exports.
"""

from __future__ import annotations

import difflib
import enum
import logging
import math
import re
from dataclasses import dataclass, replace
from typing import Union

from ..models.dataset import VALUE_NUMERIC_TYPES

logger = logging.getLogger(__name__)


# ── Exception ────────────────────────────────────────────────────────────────


class ExpressionError(Exception):
    """Raised for expression parsing, validation, or evaluation errors."""


# ── Token types ──────────────────────────────────────────────────────────────


class TokenType(enum.Enum):
    NUMBER = "NUMBER"
    STRING = "STRING"
    COLREF = "COLREF"
    LPAREN = "LPAREN"
    RPAREN = "RPAREN"
    COMMA = "COMMA"
    PLUS = "PLUS"
    MINUS = "MINUS"
    STAR = "STAR"
    SLASH = "SLASH"
    EQ = "EQ"
    NEQ = "NEQ"
    LTE = "LTE"
    GTE = "GTE"
    LT = "LT"
    GT = "GT"
    AND = "AND"
    OR = "OR"
    NOT = "NOT"
    IF = "IF"
    IDENT = "IDENT"
    EOF = "EOF"


@dataclass
class Token:
    type: TokenType
    value: str
    pos: int


# ── AST nodes ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ColumnRef:
    name: str
    column_id: int | None = None


@dataclass(frozen=True)
class Literal:
    value: float | str


@dataclass(frozen=True)
class BinaryOp:
    op: str
    left: Expr
    right: Expr


@dataclass(frozen=True)
class UnaryOp:
    op: str
    operand: Expr


@dataclass(frozen=True)
class IfExpr:
    condition: Expr
    then_expr: Expr
    else_expr: Expr


@dataclass(frozen=True)
class FunctionCall:
    name: str
    args: tuple[Expr, ...]


Expr = Union[ColumnRef, Literal, BinaryOp, UnaryOp, IfExpr, FunctionCall]


# ── Tokenizer ────────────────────────────────────────────────────────────────

_KEYWORDS: dict[str, TokenType] = {
    "AND": TokenType.AND,
    "OR": TokenType.OR,
    "NOT": TokenType.NOT,
    "IF": TokenType.IF,
}

_TOKEN_RE = re.compile(
    r"""
    (?P<COLREF>\[[^\]]+\])          |
    (?P<STRING>"[^"]*")             |
    (?P<NUMBER>\d+(?:\.\d+)?)       |
    (?P<EQ>==)                      |
    (?P<NEQ>!=)                     |
    (?P<LTE><=)                     |
    (?P<GTE>>=)                     |
    (?P<LT><)                       |
    (?P<GT>>)                       |
    (?P<PLUS>\+)                    |
    (?P<MINUS>-)                    |
    (?P<STAR>\*)                    |
    (?P<SLASH>/)                    |
    (?P<LPAREN>\()                  |
    (?P<RPAREN>\))                  |
    (?P<COMMA>,)                    |
    (?P<IDENT>[A-Za-z_]\w*)         |
    (?P<SKIP>\s+)
    """,
    re.VERBOSE,
)


def tokenize(expression: str) -> list[Token]:
    """Lex an expression string into a list of Tokens ending with EOF."""
    tokens: list[Token] = []
    pos = 0
    for m in _TOKEN_RE.finditer(expression):
        if m.start() != pos:
            bad = expression[pos:m.start()]
            raise ExpressionError(
                f"Unexpected character '{bad}' at position {pos}"
            )
        pos = m.end()
        kind = m.lastgroup
        if kind == "SKIP":
            continue
        value = m.group()
        if kind == "COLREF":
            tokens.append(Token(TokenType.COLREF, value[1:-1], m.start()))
        elif kind == "STRING":
            tokens.append(Token(TokenType.STRING, value[1:-1], m.start()))
        elif kind == "NUMBER":
            tokens.append(Token(TokenType.NUMBER, value, m.start()))
        elif kind == "IDENT":
            tt = _KEYWORDS.get(value.upper(), TokenType.IDENT)
            tokens.append(Token(tt, value.upper() if tt != TokenType.IDENT else value, m.start()))
        else:
            tt = TokenType[kind]
            tokens.append(Token(tt, value, m.start()))

    if pos != len(expression):
        raise ExpressionError(
            f"Unexpected character '{expression[pos]}' at position {pos}"
        )
    tokens.append(Token(TokenType.EOF, "", len(expression)))
    return tokens


# ── Parser ───────────────────────────────────────────────────────────────────

_KNOWN_FUNCTIONS = {
    "MEAN", "SUM", "MIN", "MAX", "COUNT_VALID",
    "ABS", "ROUND", "IS_MISSING", "COALESCE",
}

_FUNC_ARG_COUNTS: dict[str, tuple[int, int | None]] = {
    # name -> (min_args, max_args)  None = unlimited
    "ABS": (1, 1),
    "IS_MISSING": (1, 1),
    "COALESCE": (2, 2),
    "ROUND": (2, 2),
    "MEAN": (2, None),
    "SUM": (2, None),
    "MIN": (2, None),
    "MAX": (2, None),
    "COUNT_VALID": (2, None),
}

_COMPARISON_OPS = {TokenType.EQ, TokenType.NEQ, TokenType.LT, TokenType.GT, TokenType.LTE, TokenType.GTE}


class _Parser:
    def __init__(self, tokens: list[Token]) -> None:
        self._tokens = tokens
        self._pos = 0

    def parse(self) -> Expr:
        expr = self._or_expr()
        if self._peek().type != TokenType.EOF:
            t = self._peek()
            raise ExpressionError(f"Unexpected token '{t.value}' at position {t.pos}")
        return expr

    # ── helpers ──

    def _peek(self) -> Token:
        return self._tokens[self._pos]

    def _advance(self) -> Token:
        t = self._tokens[self._pos]
        self._pos += 1
        return t

    def _expect(self, tt: TokenType) -> Token:
        t = self._advance()
        if t.type != tt:
            raise ExpressionError(
                f"Expected {tt.value} but got '{t.value}' at position {t.pos}"
            )
        return t

    # ── grammar rules (lowest → highest precedence) ──

    def _or_expr(self) -> Expr:
        left = self._and_expr()
        while self._peek().type == TokenType.OR:
            self._advance()
            right = self._and_expr()
            left = BinaryOp("OR", left, right)
        return left

    def _and_expr(self) -> Expr:
        left = self._not_expr()
        while self._peek().type == TokenType.AND:
            self._advance()
            right = self._not_expr()
            left = BinaryOp("AND", left, right)
        return left

    def _not_expr(self) -> Expr:
        if self._peek().type == TokenType.NOT:
            self._advance()
            operand = self._not_expr()
            return UnaryOp("NOT", operand)
        return self._comparison()

    def _comparison(self) -> Expr:
        left = self._addition()
        if self._peek().type in _COMPARISON_OPS:
            op_token = self._advance()
            right = self._addition()
            return BinaryOp(op_token.value, left, right)
        return left

    def _addition(self) -> Expr:
        left = self._multiplication()
        while self._peek().type in (TokenType.PLUS, TokenType.MINUS):
            op_token = self._advance()
            right = self._multiplication()
            left = BinaryOp(op_token.value, left, right)
        return left

    def _multiplication(self) -> Expr:
        left = self._unary()
        while self._peek().type in (TokenType.STAR, TokenType.SLASH):
            op_token = self._advance()
            right = self._unary()
            left = BinaryOp(op_token.value, left, right)
        return left

    def _unary(self) -> Expr:
        if self._peek().type == TokenType.MINUS:
            self._advance()
            operand = self._unary()
            return UnaryOp("-", operand)
        return self._primary()

    def _primary(self) -> Expr:
        t = self._peek()

        if t.type == TokenType.NUMBER:
            self._advance()
            return Literal(float(t.value))

        if t.type == TokenType.STRING:
            self._advance()
            return Literal(t.value)

        if t.type == TokenType.COLREF:
            self._advance()
            return ColumnRef(t.value)

        if t.type == TokenType.LPAREN:
            self._advance()
            expr = self._or_expr()
            self._expect(TokenType.RPAREN)
            return expr

        if t.type == TokenType.IF:
            return self._parse_if()

        if t.type == TokenType.IDENT:
            return self._parse_function_call()

        raise ExpressionError(f"Unexpected token '{t.value}' at position {t.pos}")

    def _parse_if(self) -> IfExpr:
        self._advance()  # consume IF
        self._expect(TokenType.LPAREN)
        condition = self._or_expr()
        self._expect(TokenType.COMMA)
        then_expr = self._or_expr()
        self._expect(TokenType.COMMA)
        else_expr = self._or_expr()
        self._expect(TokenType.RPAREN)
        return IfExpr(condition, then_expr, else_expr)

    def _parse_function_call(self) -> FunctionCall:
        name_token = self._advance()
        name = name_token.value.upper()
        if name not in _KNOWN_FUNCTIONS:
            raise ExpressionError(
                f"Unknown function '{name_token.value}' at position {name_token.pos}"
            )
        self._expect(TokenType.LPAREN)
        args: list[Expr] = [self._or_expr()]
        while self._peek().type == TokenType.COMMA:
            self._advance()
            args.append(self._or_expr())
        self._expect(TokenType.RPAREN)

        min_args, max_args = _FUNC_ARG_COUNTS[name]
        if len(args) < min_args:
            raise ExpressionError(
                f"{name} requires at least {min_args} argument(s), got {len(args)}"
            )
        if max_args is not None and len(args) > max_args:
            raise ExpressionError(
                f"{name} accepts at most {max_args} argument(s), got {len(args)}"
            )
        return FunctionCall(name, tuple(args))


def parse(expression: str) -> Expr:
    """Parse an expression string into an AST.

    Raises ExpressionError on syntax errors.
    """
    if not expression or not expression.strip():
        raise ExpressionError("Expression is empty")
    tokens = tokenize(expression)
    return _Parser(tokens).parse()


# ── Validator ────────────────────────────────────────────────────────────────

# Numeric-OPERAND eligibility (formula arithmetic/aggregation). Aliases the single
# source of truth in models/dataset.py (#399). ColumnInfo.column_type is a string,
# but ColumnType is a (str, Enum) so string membership in this frozenset works.
_NUMERIC_TYPES = VALUE_NUMERIC_TYPES


@dataclass
class ColumnInfo:
    """Metadata about an available column for validation."""
    id: int
    code: str | None
    text: str
    column_type: str


@dataclass
class ValidationResult:
    """Result of validating an expression against available columns."""
    resolved_ast: Expr
    dependency_ids: list[int]
    warnings: list[str]


def validate(
    ast: Expr,
    columns: list[ColumnInfo],
    self_column_id: int | None = None,
) -> ValidationResult:
    """Validate an AST against available columns.

    Resolves ColumnRef names to column IDs. Checks for self-reference.
    Returns resolved AST, dependency IDs, and warnings.

    Raises ExpressionError if a column reference cannot be resolved.
    """
    code_map: dict[str, list[ColumnInfo]] = {}
    text_map: dict[str, list[ColumnInfo]] = {}
    for c in columns:
        if c.code:
            code_map.setdefault(c.code.lower(), []).append(c)
        text_map.setdefault(c.text.lower(), []).append(c)

    dependency_ids: list[int] = []
    warnings: list[str] = []

    def _resolve(node: Expr) -> Expr:
        if isinstance(node, ColumnRef):
            key = node.name.lower()
            # Try code first
            matches = code_map.get(key, [])
            if not matches:
                matches = text_map.get(key, [])
            if not matches:
                all_names = []
                for c in columns:
                    if c.code:
                        all_names.append(c.code)
                    all_names.append(c.text)
                suggestions = difflib.get_close_matches(node.name, all_names, n=3, cutoff=0.5)
                hint = f" Did you mean: {', '.join(suggestions)}?" if suggestions else ""
                raise ExpressionError(f"Unknown column '{node.name}'.{hint}")
            if len(matches) > 1:
                raise ExpressionError(
                    f"Ambiguous column reference '{node.name}' — "
                    f"matches {len(matches)} columns"
                )
            col = matches[0]
            if col.id not in dependency_ids:
                dependency_ids.append(col.id)
            return replace(node, column_id=col.id)

        if isinstance(node, Literal):
            return node

        if isinstance(node, BinaryOp):
            left = _resolve(node.left)
            right = _resolve(node.right)
            # Warn on arithmetic with non-numeric columns
            if node.op in ("+", "-", "*", "/"):
                for side in (left, right):
                    if isinstance(side, ColumnRef):
                        col_info = next(
                            (c for c in columns if c.id == side.column_id), None
                        )
                        if col_info and col_info.column_type not in _NUMERIC_TYPES:
                            warnings.append(
                                f"Arithmetic on non-numeric column '{col_info.text}' "
                                f"(type: {col_info.column_type})"
                            )
            return replace(node, left=left, right=right)

        if isinstance(node, UnaryOp):
            return replace(node, operand=_resolve(node.operand))

        if isinstance(node, IfExpr):
            return replace(
                node,
                condition=_resolve(node.condition),
                then_expr=_resolve(node.then_expr),
                else_expr=_resolve(node.else_expr),
            )

        if isinstance(node, FunctionCall):
            resolved_args = tuple(_resolve(a) for a in node.args)
            # Warn when a row-wise aggregate references a non-numeric column. Its
            # cells contribute no numeric value and are silently treated as
            # missing at eval time (#360), so an all-text column would yield an
            # empty (NULL) result row-by-row. ordinal/numeric/percentage/binary
            # count as numeric (post scale-map, ordinal cells carry value_numeric).
            if node.name in ("MEAN", "SUM", "MIN", "MAX", "COUNT_VALID"):
                for arg in resolved_args:
                    if isinstance(arg, ColumnRef):
                        col_info = next(
                            (c for c in columns if c.id == arg.column_id), None
                        )
                        if col_info and col_info.column_type not in _NUMERIC_TYPES:
                            warnings.append(
                                f"{node.name}() includes non-numeric column "
                                f"'{col_info.text}' (type: {col_info.column_type}); "
                                f"its values are treated as missing."
                            )
            return replace(node, args=resolved_args)

        return node  # pragma: no cover

    resolved = _resolve(ast)

    if self_column_id is not None and self_column_id in dependency_ids:
        raise ExpressionError("Expression cannot reference its own column")

    return ValidationResult(resolved, dependency_ids, warnings)


# ── Evaluator ────────────────────────────────────────────────────────────────

# Internal value tags
_NUM = "numeric"
_TXT = "text"
_BOOL = "bool"
_NULL = "null"

# Internal value type: (tag, payload)
_Val = tuple[str, object]


def _format_number(v: float) -> str:
    """Format a float for value_text — drop trailing .0 for integers."""
    if math.isinf(v) or math.isnan(v):
        return str(v)
    if v == int(v):
        return str(int(v))
    return str(v)


def _eval(node: Expr, row: dict[int, tuple[str | None, float | None]]) -> _Val:
    """Recursively evaluate an AST node against one row of data."""

    if isinstance(node, Literal):
        if isinstance(node.value, str):
            return (_TXT, node.value)
        return (_NUM, node.value)

    if isinstance(node, ColumnRef):
        if node.column_id is None:
            raise ExpressionError("Unresolved column reference (run validator first)")
        pair = row.get(node.column_id)
        if pair is None:
            return (_NULL, None)
        vt, vn = pair
        if vn is not None:
            return (_NUM, float(vn))
        if vt is not None:
            return (_TXT, vt)
        return (_NULL, None)

    if isinstance(node, UnaryOp):
        val = _eval(node.operand, row)
        if node.op == "-":
            if val[0] == _NULL:
                return (_NULL, None)
            if val[0] != _NUM:
                raise ExpressionError("Unary minus requires a numeric value")
            return (_NUM, -val[1])
        if node.op == "NOT":
            if val[0] == _NULL:
                return (_NULL, None)
            if val[0] != _BOOL:
                raise ExpressionError("NOT requires a boolean value")
            return (_BOOL, not val[1])

    if isinstance(node, BinaryOp):
        return _eval_binary(node, row)

    if isinstance(node, IfExpr):
        cond = _eval(node.condition, row)
        if cond[0] == _NULL:
            return (_NULL, None)
        if cond[0] != _BOOL:
            raise ExpressionError("IF condition must be boolean")
        if cond[1]:
            return _eval(node.then_expr, row)
        return _eval(node.else_expr, row)

    if isinstance(node, FunctionCall):
        return _eval_function(node, row)

    raise ExpressionError(f"Unknown AST node type: {type(node)}")  # pragma: no cover


def _eval_binary(node: BinaryOp, row: dict) -> _Val:
    left = _eval(node.left, row)
    right = _eval(node.right, row)

    # Boolean operators
    if node.op == "AND":
        if left[0] == _NULL:
            if right[0] == _BOOL and right[1] is False:
                return (_BOOL, False)
            return (_NULL, None)
        if right[0] == _NULL:
            if left[0] == _BOOL and left[1] is False:
                return (_BOOL, False)
            return (_NULL, None)
        if left[0] != _BOOL or right[0] != _BOOL:
            raise ExpressionError("AND requires boolean operands")
        return (_BOOL, left[1] and right[1])

    if node.op == "OR":
        if left[0] == _NULL:
            if right[0] == _BOOL and right[1] is True:
                return (_BOOL, True)
            return (_NULL, None)
        if right[0] == _NULL:
            if left[0] == _BOOL and left[1] is True:
                return (_BOOL, True)
            return (_NULL, None)
        if left[0] != _BOOL or right[0] != _BOOL:
            raise ExpressionError("OR requires boolean operands")
        return (_BOOL, left[1] or right[1])

    # Null propagation for all remaining ops
    if left[0] == _NULL or right[0] == _NULL:
        return (_NULL, None)

    # Equality / inequality — work on both text and numeric
    if node.op in ("==", "!="):
        # If either is text, compare as text
        if left[0] == _TXT or right[0] == _TXT:
            lv = left[1] if left[0] == _TXT else _format_number(left[1])
            rv = right[1] if right[0] == _TXT else _format_number(right[1])
            result = lv == rv if node.op == "==" else lv != rv
        else:
            result = left[1] == right[1] if node.op == "==" else left[1] != right[1]
        return (_BOOL, result)

    # Ordered comparison — numeric only
    if node.op in ("<", ">", "<=", ">="):
        if left[0] != _NUM or right[0] != _NUM:
            raise ExpressionError(
                f"Comparison '{node.op}' requires numeric operands"
            )
        lv, rv = left[1], right[1]
        if node.op == "<":
            return (_BOOL, lv < rv)
        if node.op == ">":
            return (_BOOL, lv > rv)
        if node.op == "<=":
            return (_BOOL, lv <= rv)
        return (_BOOL, lv >= rv)

    # Arithmetic — numeric only
    if node.op in ("+", "-", "*", "/"):
        if left[0] != _NUM or right[0] != _NUM:
            raise ExpressionError(
                f"Arithmetic '{node.op}' requires numeric operands"
            )
        if node.op == "/" and right[1] == 0:
            return (_NULL, None)
        ops = {"+": lambda a, b: a + b, "-": lambda a, b: a - b,
               "*": lambda a, b: a * b, "/": lambda a, b: a / b}
        return (_NUM, ops[node.op](left[1], right[1]))

    raise ExpressionError(f"Unknown operator '{node.op}'")  # pragma: no cover


def _eval_function(node: FunctionCall, row: dict) -> _Val:
    name = node.name

    if name == "IS_MISSING":
        val = _eval(node.args[0], row)
        return (_BOOL, val[0] == _NULL)

    if name == "COALESCE":
        val = _eval(node.args[0], row)
        if val[0] == _NULL:
            return _eval(node.args[1], row)
        return val

    if name == "ABS":
        val = _eval(node.args[0], row)
        if val[0] == _NULL:
            return (_NULL, None)
        if val[0] != _NUM:
            raise ExpressionError("ABS requires a numeric value")
        return (_NUM, abs(val[1]))

    if name == "ROUND":
        val = _eval(node.args[0], row)
        digits_val = _eval(node.args[1], row)
        if val[0] == _NULL:
            return (_NULL, None)
        if val[0] != _NUM:
            raise ExpressionError("ROUND requires a numeric first argument")
        if digits_val[0] != _NUM:
            raise ExpressionError("ROUND requires a numeric second argument (digits)")
        return (_NUM, round(val[1], int(digits_val[1])))

    # Row-wise aggregates: MEAN, SUM, MIN, MAX, COUNT_VALID
    if name in ("MEAN", "SUM", "MIN", "MAX", "COUNT_VALID"):
        values: list[float] = []
        for arg in node.args:
            v = _eval(arg, row)
            # Treat a missing cell (_NULL) OR an unmappable text cell (_TXT) as
            # missing and skip it (#360). A _TXT here means a column reference
            # resolved to a value that has value_text but no value_numeric — e.g.
            # an ordinal/Likert column with a single typo'd label ("Srongly
            # Disagree") that never got a numeric value. Raising on it 500'd the
            # whole computed column for one bad cell. Skipping matches the R
            # translation's rowMeans/rowSums(..., na.rm = TRUE) semantics
            # (see _to_r_function), so Python compute and R export agree.
            if v[0] == _NULL or v[0] == _TXT:
                continue
            if v[0] != _NUM:
                raise ExpressionError(f"{name} requires numeric arguments")
            values.append(v[1])

        if name == "COUNT_VALID":
            return (_NUM, float(len(values)))

        if not values:
            return (_NULL, None)

        if name == "MEAN":
            return (_NUM, sum(values) / len(values))
        if name == "SUM":
            return (_NUM, sum(values))
        if name == "MIN":
            return (_NUM, min(values))
        if name == "MAX":
            return (_NUM, max(values))

    raise ExpressionError(f"Unknown function '{name}'")  # pragma: no cover


def evaluate(
    ast: Expr,
    row_data: dict[int, tuple[str | None, float | None]],
) -> tuple[str | None, float | None]:
    """Evaluate a validated AST against one row of data.

    Args:
        ast: Validated AST (ColumnRef nodes must have column_id set).
        row_data: {column_id: (value_text, value_numeric)} for this row.

    Returns:
        (value_text, value_numeric) result tuple.
    """
    result = _eval(ast, row_data)
    tag, val = result

    if tag == _NULL:
        return (None, None)
    if tag == _NUM:
        return (_format_number(val), val)
    if tag == _TXT:
        return (val, None)
    if tag == _BOOL:
        return ("TRUE" if val else "FALSE", 1.0 if val else 0.0)
    return (None, None)  # pragma: no cover


# ── R Translator ─────────────────────────────────────────────────────────────

_R_BINARY_OPS = {
    "AND": "&",
    "OR": "|",
}


def to_r_expression(
    ast: Expr,
    column_r_names: dict[int, str],
    df_name: str = "df",
) -> str:
    """Convert a validated AST to an R expression string.

    Args:
        ast: Validated AST (ColumnRef nodes must have column_id set).
        column_r_names: {column_id: "r_safe_name"} mapping.
        df_name: R data frame variable name (default "df", use "data" for R export).

    Returns:
        R expression string using {df_name}$ column references.
    """
    return _to_r(ast, column_r_names, df_name)


def _to_r(node: Expr, names: dict[int, str], df_name: str) -> str:
    if isinstance(node, Literal):
        if isinstance(node.value, str):
            return f'"{node.value}"'
        v = node.value
        if v == int(v) and not math.isinf(v):
            return str(int(v))
        return str(v)

    if isinstance(node, ColumnRef):
        r_name = names.get(node.column_id, f"col_{node.column_id}")
        return f"{df_name}${r_name}"

    if isinstance(node, UnaryOp):
        inner = _to_r(node.operand, names, df_name)
        if node.op == "NOT":
            return f"!({inner})"
        return f"-({inner})"

    if isinstance(node, BinaryOp):
        left = _to_r(node.left, names, df_name)
        right = _to_r(node.right, names, df_name)
        r_op = _R_BINARY_OPS.get(node.op, node.op)
        return f"({left} {r_op} {right})"

    if isinstance(node, IfExpr):
        cond = _to_r(node.condition, names, df_name)
        then = _to_r(node.then_expr, names, df_name)
        els = _to_r(node.else_expr, names, df_name)
        return f"ifelse({cond}, {then}, {els})"

    if isinstance(node, FunctionCall):
        return _to_r_function(node, names, df_name)

    raise ExpressionError(f"Unknown AST node type: {type(node)}")  # pragma: no cover


def _to_r_function(node: FunctionCall, names: dict[int, str], df_name: str) -> str:
    args_r = [_to_r(a, names, df_name) for a in node.args]

    if node.name == "MEAN":
        return f"rowMeans(cbind({', '.join(args_r)}), na.rm = TRUE)"

    if node.name == "SUM":
        return f"rowSums(cbind({', '.join(args_r)}), na.rm = TRUE)"

    if node.name == "MIN":
        return f"pmin({', '.join(args_r)}, na.rm = TRUE)"

    if node.name == "MAX":
        return f"pmax({', '.join(args_r)}, na.rm = TRUE)"

    if node.name == "COUNT_VALID":
        return f"rowSums(!is.na(cbind({', '.join(args_r)})))"

    if node.name == "ABS":
        return f"abs({args_r[0]})"

    if node.name == "ROUND":
        return f"round({args_r[0]}, {args_r[1]})"

    if node.name == "IS_MISSING":
        return f"is.na({args_r[0]})"

    if node.name == "COALESCE":
        return f"ifelse(is.na({args_r[0]}), {args_r[1]}, {args_r[0]})"

    raise ExpressionError(f"Unknown function '{node.name}'")  # pragma: no cover


# ── Bulk evaluator (requires DB) ────────────────────────────────────────────


def evaluate_computed_column(
    db,  # Session — typed loosely to avoid circular import
    column,  # DatasetColumn ORM instance
    row_ids: list[int] | None = None,
) -> int:
    """Evaluate a computed column's expression for all (or specified) rows.

    Creates or updates DatasetValue rows with the computed results.
    Returns the number of rows evaluated.
    """
    # Local imports to avoid circular dependency
    from ..models.dataset import DatasetColumn, DatasetRow, DatasetValue

    if not column.expression:
        raise ExpressionError("Column has no expression")

    ast = parse(column.expression)

    # Build ColumnInfo list from sibling columns in the same dataset
    siblings = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == column.dataset_id,
            DatasetColumn.id != column.id,
        )
        .all()
    )
    col_infos = [
        ColumnInfo(id=c.id, code=c.column_code, text=c.column_text, column_type=c.column_type.value if hasattr(c.column_type, 'value') else str(c.column_type))
        for c in siblings
    ]

    result = validate(ast, col_infos, self_column_id=column.id)
    resolved_ast = result.resolved_ast
    dep_ids = result.dependency_ids

    # Load source values for dependency columns
    value_query = (
        db.query(DatasetValue.row_id, DatasetValue.column_id,
                 DatasetValue.value_text, DatasetValue.value_numeric)
        .filter(DatasetValue.column_id.in_(dep_ids))
    )
    if row_ids is not None:
        value_query = value_query.filter(DatasetValue.row_id.in_(row_ids))

    # Build row_data: {row_id: {column_id: (value_text, value_numeric)}}
    row_data: dict[int, dict[int, tuple]] = {}
    for resp_id, col_id, vt, vn in value_query.all():
        row_data.setdefault(resp_id, {})[col_id] = (vt, vn)

    # Determine which rows to evaluate
    if row_ids is not None:
        target_row_ids = row_ids
    else:
        target_row_ids = [
            r[0] for r in
            db.query(DatasetRow.id)
            .filter(DatasetRow.dataset_id == column.dataset_id)
            .all()
        ]

    # Load existing computed values for upsert
    existing_values: dict[int, DatasetValue] = {}
    existing_query = (
        db.query(DatasetValue)
        .filter(
            DatasetValue.column_id == column.id,
        )
    )
    if row_ids is not None:
        existing_query = existing_query.filter(DatasetValue.row_id.in_(row_ids))
    for dv in existing_query.all():
        existing_values[dv.row_id] = dv

    # Evaluate each row
    count = 0
    for row_id in target_row_ids:
        rd = row_data.get(row_id, {})
        vt, vn = evaluate(resolved_ast, rd)

        if row_id in existing_values:
            dv = existing_values[row_id]
            dv.value_text = vt
            dv.value_numeric = vn
        else:
            dv = DatasetValue(
                row_id=row_id,
                column_id=column.id,
                value_text=vt,
                value_numeric=vn,
            )
            db.add(dv)
        count += 1

    db.flush()
    return count
