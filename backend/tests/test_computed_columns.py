"""Tests for the computed columns expression engine.

Sections 1-5: Pure Python tests (no database needed).
Section 6: DB integration tests (uses db_session fixture).
"""

import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

import json
import pytest

from app.services.computed_columns import (
    ExpressionError,
    TokenType,
    ColumnRef,
    Literal,
    BinaryOp,
    UnaryOp,
    IfExpr,
    FunctionCall,
    ColumnInfo,
    ValidationResult,
    tokenize,
    parse,
    validate,
    evaluate,
    to_r_expression,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

# Standard test columns
_COLS = [
    ColumnInfo(id=1, code="A", text="Score A", column_type="numeric"),
    ColumnInfo(id=2, code="B", text="Score B", column_type="numeric"),
    ColumnInfo(id=3, code="C", text="Score C", column_type="numeric"),
    ColumnInfo(id=4, code="type", text="Employee Type", column_type="nominal"),
    ColumnInfo(id=5, code="rate", text="Hourly Rate", column_type="numeric"),
    ColumnInfo(id=6, code="hours", text="Hours Worked", column_type="numeric"),
    ColumnInfo(id=7, code="salary", text="Annual Salary", column_type="numeric"),
]


def _eval_expr(
    expression: str,
    row_data: dict[int, tuple[str | None, float | None]],
    columns: list[ColumnInfo] | None = None,
) -> tuple[str | None, float | None]:
    """Parse → validate → evaluate in one call."""
    cols = columns if columns is not None else _COLS
    ast = parse(expression)
    result = validate(ast, cols)
    return evaluate(result.resolved_ast, row_data)


# ── TestTokenizer ────────────────────────────────────────────────────────────


class TestTokenizer:
    def test_simple_arithmetic(self):
        tokens = tokenize("[A] + [B]")
        types = [t.type for t in tokens]
        assert types == [TokenType.COLREF, TokenType.PLUS, TokenType.COLREF, TokenType.EOF]
        assert tokens[0].value == "A"
        assert tokens[2].value == "B"

    def test_string_literal(self):
        tokens = tokenize('"Hourly"')
        assert tokens[0].type == TokenType.STRING
        assert tokens[0].value == "Hourly"

    def test_number_literals(self):
        tokens = tokenize("42 3.14")
        assert tokens[0].type == TokenType.NUMBER
        assert tokens[0].value == "42"
        assert tokens[1].type == TokenType.NUMBER
        assert tokens[1].value == "3.14"

    def test_keywords_classified(self):
        tokens = tokenize("IF AND OR NOT")
        assert tokens[0].type == TokenType.IF
        assert tokens[1].type == TokenType.AND
        assert tokens[2].type == TokenType.OR
        assert tokens[3].type == TokenType.NOT

    def test_function_name_as_ident(self):
        tokens = tokenize("MEAN")
        assert tokens[0].type == TokenType.IDENT
        assert tokens[0].value == "MEAN"

    def test_comparison_operators(self):
        tokens = tokenize("== != <= >= < >")
        types = [t.type for t in tokens[:-1]]
        assert types == [
            TokenType.EQ, TokenType.NEQ, TokenType.LTE,
            TokenType.GTE, TokenType.LT, TokenType.GT,
        ]

    def test_error_on_invalid_char(self):
        with pytest.raises(ExpressionError, match="Unexpected character"):
            tokenize("[A] @ [B]")

    def test_column_ref_with_spaces(self):
        tokens = tokenize("[Score A]")
        assert tokens[0].type == TokenType.COLREF
        assert tokens[0].value == "Score A"


# ── TestParser ───────────────────────────────────────────────────────────────


class TestParser:
    def test_simple_addition(self):
        ast = parse("[A] + [B]")
        assert isinstance(ast, BinaryOp)
        assert ast.op == "+"
        assert isinstance(ast.left, ColumnRef) and ast.left.name == "A"
        assert isinstance(ast.right, ColumnRef) and ast.right.name == "B"

    def test_multiplication_precedence(self):
        ast = parse("[A] + [B] * [C]")
        assert isinstance(ast, BinaryOp) and ast.op == "+"
        assert isinstance(ast.right, BinaryOp) and ast.right.op == "*"

    def test_left_associativity(self):
        ast = parse("[A] - [B] - [C]")
        assert isinstance(ast, BinaryOp) and ast.op == "-"
        assert isinstance(ast.left, BinaryOp) and ast.left.op == "-"

    def test_parentheses_override(self):
        ast = parse("([A] + [B]) * [C]")
        assert isinstance(ast, BinaryOp) and ast.op == "*"
        assert isinstance(ast.left, BinaryOp) and ast.left.op == "+"

    def test_comparison(self):
        ast = parse("[A] == 5")
        assert isinstance(ast, BinaryOp) and ast.op == "=="

    def test_boolean_and_or(self):
        ast = parse("[A] > 0 AND [B] < 10 OR [C] == 1")
        assert isinstance(ast, BinaryOp) and ast.op == "OR"
        assert isinstance(ast.left, BinaryOp) and ast.left.op == "AND"

    def test_not_expression(self):
        ast = parse("NOT [A] > 5")
        assert isinstance(ast, UnaryOp) and ast.op == "NOT"
        assert isinstance(ast.operand, BinaryOp)

    def test_unary_minus(self):
        ast = parse("-[A]")
        assert isinstance(ast, UnaryOp) and ast.op == "-"

    def test_if_expression(self):
        ast = parse('IF([type] == "Hourly", [rate] * [hours], [salary])')
        assert isinstance(ast, IfExpr)
        assert isinstance(ast.condition, BinaryOp)
        assert isinstance(ast.then_expr, BinaryOp) and ast.then_expr.op == "*"
        assert isinstance(ast.else_expr, ColumnRef)

    def test_function_call_mean(self):
        ast = parse("MEAN([A], [B], [C])")
        assert isinstance(ast, FunctionCall)
        assert ast.name == "MEAN"
        assert len(ast.args) == 3

    def test_function_call_abs(self):
        ast = parse("ABS([A])")
        assert isinstance(ast, FunctionCall) and ast.name == "ABS"
        assert len(ast.args) == 1

    def test_function_call_round(self):
        ast = parse("ROUND([A], 2)")
        assert isinstance(ast, FunctionCall) and ast.name == "ROUND"
        assert len(ast.args) == 2

    def test_function_call_is_missing(self):
        ast = parse("IS_MISSING([A])")
        assert isinstance(ast, FunctionCall) and ast.name == "IS_MISSING"

    def test_function_call_coalesce(self):
        ast = parse("COALESCE([A], 0)")
        assert isinstance(ast, FunctionCall) and ast.name == "COALESCE"
        assert len(ast.args) == 2

    def test_nested_functions(self):
        ast = parse("ROUND(MEAN([A], [B]), 2)")
        assert isinstance(ast, FunctionCall) and ast.name == "ROUND"
        assert isinstance(ast.args[0], FunctionCall) and ast.args[0].name == "MEAN"

    def test_error_empty_expression(self):
        with pytest.raises(ExpressionError, match="empty"):
            parse("")

    def test_error_unclosed_paren(self):
        with pytest.raises(ExpressionError):
            parse("([A] + [B]")

    def test_error_incomplete_expression(self):
        with pytest.raises(ExpressionError):
            parse("[A] +")

    def test_error_unknown_function(self):
        with pytest.raises(ExpressionError, match="Unknown function"):
            parse("AVERAGE([A], [B])")

    def test_error_wrong_arg_count(self):
        with pytest.raises(ExpressionError, match="at least 2"):
            parse("MEAN([A])")

    def test_error_too_many_args(self):
        with pytest.raises(ExpressionError, match="at most 1"):
            parse("ABS([A], [B])")

    def test_numeric_literal(self):
        ast = parse("3.14")
        assert isinstance(ast, Literal) and ast.value == 3.14

    def test_string_literal(self):
        ast = parse('"hello"')
        assert isinstance(ast, Literal) and ast.value == "hello"


# ── TestValidator ────────────────────────────────────────────────────────────


class TestValidator:
    def test_resolves_by_code(self):
        ast = parse("[A]")
        result = validate(ast, _COLS)
        assert isinstance(result.resolved_ast, ColumnRef)
        assert result.resolved_ast.column_id == 1

    def test_resolves_by_text(self):
        cols = [ColumnInfo(id=10, code=None, text="Total Score", column_type="numeric")]
        ast = parse("[Total Score]")
        result = validate(ast, cols)
        assert result.resolved_ast.column_id == 10

    def test_code_takes_priority_over_text(self):
        cols = [
            ColumnInfo(id=1, code="X", text="Something", column_type="numeric"),
            ColumnInfo(id=2, code=None, text="X", column_type="numeric"),
        ]
        ast = parse("[X]")
        result = validate(ast, cols)
        assert result.resolved_ast.column_id == 1

    def test_case_insensitive_resolution(self):
        ast = parse("[a]")
        result = validate(ast, _COLS)
        assert result.resolved_ast.column_id == 1

    def test_unknown_column_raises(self):
        ast = parse("[NoSuchCol]")
        with pytest.raises(ExpressionError, match="Unknown column"):
            validate(ast, _COLS)

    def test_unknown_column_with_fuzzy_suggestion(self):
        ast = parse("[Scor A]")
        with pytest.raises(ExpressionError, match="Did you mean: Score A"):
            validate(ast, _COLS)

    def test_self_reference_raises(self):
        ast = parse("[A]")
        with pytest.raises(ExpressionError, match="own column"):
            validate(ast, _COLS, self_column_id=1)

    def test_dependency_ids_extracted(self):
        ast = parse("[A] + [B] * [C]")
        result = validate(ast, _COLS)
        assert sorted(result.dependency_ids) == [1, 2, 3]

    def test_no_duplicate_dependency_ids(self):
        ast = parse("[A] + [A]")
        result = validate(ast, _COLS)
        assert result.dependency_ids == [1]

    def test_arithmetic_on_nominal_warns(self):
        ast = parse("[type] + [A]")
        result = validate(ast, _COLS)
        assert len(result.warnings) == 1
        assert "non-numeric" in result.warnings[0]


# ── TestEvaluator ────────────────────────────────────────────────────────────


class TestEvaluator:
    @pytest.mark.parametrize("expr, row, expected", [
        # Arithmetic
        ("[A] + [B]", {1: (None, 10.0), 2: (None, 20.0)}, ("30", 30.0)),
        ("[A] - [B]", {1: (None, 100.0), 2: (None, 40.0)}, ("60", 60.0)),
        ("[A] * [B]", {1: (None, 3.0), 2: (None, 7.0)}, ("21", 21.0)),
        ("[A] / [B]", {1: (None, 10.0), 2: (None, 4.0)}, ("2.5", 2.5)),
        # Division by zero
        ("[A] / [B]", {1: (None, 10.0), 2: (None, 0.0)}, (None, None)),
        # NULL propagation
        ("[A] + [B]", {1: (None, None), 2: (None, 5.0)}, (None, None)),
        ("[A] + [B]", {1: (None, 5.0), 2: (None, None)}, (None, None)),
        # Unary minus
        ("-[A]", {1: (None, 42.0)}, ("-42", -42.0)),
    ])
    def test_arithmetic(self, expr, row, expected):
        assert _eval_expr(expr, row) == expected

    @pytest.mark.parametrize("expr, row, expected", [
        # String equality
        ('[type] == "Hourly"', {4: ("Hourly", None)}, ("TRUE", 1.0)),
        ('[type] == "Hourly"', {4: ("Salary", None)}, ("FALSE", 0.0)),
        # Numeric comparison
        ("[A] > [B]", {1: (None, 10.0), 2: (None, 5.0)}, ("TRUE", 1.0)),
        ("[A] > [B]", {1: (None, 3.0), 2: (None, 5.0)}, ("FALSE", 0.0)),
        ("[A] <= [B]", {1: (None, 5.0), 2: (None, 5.0)}, ("TRUE", 1.0)),
        # Null comparison
        ("[A] > [B]", {1: (None, None), 2: (None, 5.0)}, (None, None)),
    ])
    def test_comparison(self, expr, row, expected):
        assert _eval_expr(expr, row) == expected

    def test_if_hourly(self):
        row = {4: ("Hourly", None), 5: (None, 25.0), 6: (None, 40.0), 7: (None, 50000.0)}
        result = _eval_expr(
            'IF([type] == "Hourly", [rate] * [hours], [salary])', row
        )
        assert result == ("1000", 1000.0)

    def test_if_salaried(self):
        row = {4: ("Salary", None), 5: (None, 25.0), 6: (None, 40.0), 7: (None, 50000.0)}
        result = _eval_expr(
            'IF([type] == "Hourly", [rate] * [hours], [salary])', row
        )
        assert result == ("50000", 50000.0)

    def test_if_null_condition(self):
        row = {4: (None, None), 5: (None, 25.0), 6: (None, 40.0), 7: (None, 50000.0)}
        result = _eval_expr(
            'IF([type] == "Hourly", [rate] * [hours], [salary])', row
        )
        assert result == (None, None)

    @pytest.mark.parametrize("expr, row, expected", [
        # MEAN
        ("MEAN([A], [B], [C])", {1: (None, 10.0), 2: (None, 20.0), 3: (None, 30.0)}, ("20", 20.0)),
        # MEAN with partial nulls (na.rm)
        ("MEAN([A], [B], [C])", {1: (None, 10.0), 2: (None, None), 3: (None, 30.0)}, ("20", 20.0)),
        # MEAN all nulls
        ("MEAN([A], [B])", {1: (None, None), 2: (None, None)}, (None, None)),
        # SUM
        ("SUM([A], [B], [C])", {1: (None, 1.0), 2: (None, 2.0), 3: (None, 3.0)}, ("6", 6.0)),
        # MIN
        ("MIN([A], [B], [C])", {1: (None, 3.0), 2: (None, 1.0), 3: (None, 2.0)}, ("1", 1.0)),
        # MAX
        ("MAX([A], [B], [C])", {1: (None, 3.0), 2: (None, 1.0), 3: (None, 2.0)}, ("3", 3.0)),
        # COUNT_VALID
        ("COUNT_VALID([A], [B], [C])", {1: (None, 1.0), 2: (None, None), 3: (None, 3.0)}, ("2", 2.0)),
        # COUNT_VALID all nulls returns 0 (not null)
        ("COUNT_VALID([A], [B])", {1: (None, None), 2: (None, None)}, ("0", 0.0)),
    ])
    def test_aggregates(self, expr, row, expected):
        assert _eval_expr(expr, row) == expected

    @pytest.mark.parametrize("expr, row, expected", [
        # IS_MISSING true
        ("IS_MISSING([A])", {1: (None, None)}, ("TRUE", 1.0)),
        # IS_MISSING false
        ("IS_MISSING([A])", {1: (None, 5.0)}, ("FALSE", 0.0)),
        # COALESCE with null → fallback
        ("COALESCE([A], 0)", {1: (None, None)}, ("0", 0.0)),
        # COALESCE with value → original
        ("COALESCE([A], 0)", {1: (None, 42.0)}, ("42", 42.0)),
    ])
    def test_null_handling(self, expr, row, expected):
        assert _eval_expr(expr, row) == expected

    def test_abs(self):
        assert _eval_expr("ABS([A])", {1: (None, -5.0)}) == ("5", 5.0)

    def test_abs_positive(self):
        assert _eval_expr("ABS([A])", {1: (None, 3.0)}) == ("3", 3.0)

    def test_round(self):
        assert _eval_expr("ROUND([A], 2)", {1: (None, 3.14159)}) == ("3.14", 3.14)

    def test_round_to_zero_decimals(self):
        assert _eval_expr("ROUND([A], 0)", {1: (None, 3.7)}) == ("4", 4.0)

    def test_boolean_and(self):
        row = {1: (None, 7.0), 2: (None, 3.0)}
        assert _eval_expr("[A] > 5 AND [B] < 5", row) == ("TRUE", 1.0)

    def test_boolean_and_false(self):
        row = {1: (None, 2.0), 2: (None, 3.0)}
        assert _eval_expr("[A] > 5 AND [B] < 5", row) == ("FALSE", 0.0)

    def test_boolean_or(self):
        row = {1: (None, 2.0), 2: (None, 3.0)}
        assert _eval_expr("[A] > 5 OR [B] < 5", row) == ("TRUE", 1.0)

    def test_boolean_not(self):
        assert _eval_expr("NOT IS_MISSING([A])", {1: (None, 5.0)}) == ("TRUE", 1.0)

    def test_null_and_false(self):
        """NULL AND FALSE = FALSE (SQL three-valued logic)."""
        row = {1: (None, None), 2: (None, 3.0)}
        assert _eval_expr("[A] > 5 AND [B] < 1", row) == ("FALSE", 0.0)

    def test_null_and_true(self):
        """NULL AND TRUE = NULL."""
        row = {1: (None, None), 2: (None, 3.0)}
        assert _eval_expr("[A] > 5 AND [B] < 5", row) == (None, None)

    def test_null_or_true(self):
        """NULL OR TRUE = TRUE."""
        row = {1: (None, None), 2: (None, 3.0)}
        assert _eval_expr("[A] > 5 OR [B] < 5", row) == ("TRUE", 1.0)

    def test_null_or_false(self):
        """NULL OR FALSE = NULL."""
        row = {1: (None, None), 2: (None, 3.0)}
        assert _eval_expr("[A] > 5 OR [B] > 5", row) == (None, None)

    def test_nested_round_mean(self):
        row = {1: (None, 10.0), 2: (None, 20.0), 3: (None, 33.0)}
        # mean(10,20,33) = 21.0, round(21.0, 1) = 21.0, formatted as "21"
        assert _eval_expr("ROUND(MEAN([A], [B], [C]), 1)", row) == ("21", 21.0)

    def test_nested_round_mean_fractional(self):
        row = {1: (None, 10.0), 2: (None, 20.0), 3: (None, 31.0)}
        # mean(10,20,31) = 20.333..., round(20.333, 1) = 20.3
        assert _eval_expr("ROUND(MEAN([A], [B], [C]), 1)", row) == ("20.3", 20.3)

    def test_complex_expression(self):
        """IF([type] == "Hourly" AND [hours] > 0, [rate] * [hours], [salary])"""
        row = {4: ("Hourly", None), 5: (None, 25.0), 6: (None, 40.0), 7: (None, 50000.0)}
        result = _eval_expr(
            'IF([type] == "Hourly" AND [hours] > 0, [rate] * [hours], [salary])',
            row,
        )
        assert result == ("1000", 1000.0)

    def test_literal_expression(self):
        """Pure literal without column refs."""
        cols = [ColumnInfo(id=1, code="A", text="A", column_type="numeric")]
        ast = parse("2 + 3")
        result = validate(ast, cols)
        assert evaluate(result.resolved_ast, {}) == ("5", 5.0)

    def test_column_not_in_row_data_is_null(self):
        """Missing column_id in row_data treated as NULL."""
        result = _eval_expr("[A] + [B]", {1: (None, 5.0)})
        assert result == (None, None)

    def test_fractional_result(self):
        result = _eval_expr("[A] / [B]", {1: (None, 1.0), 2: (None, 3.0)})
        assert result[1] == pytest.approx(1 / 3)
        assert result[0] == str(1 / 3)


# ── TestRTranslator ──────────────────────────────────────────────────────────


class TestRTranslator:
    """Test R code generation from validated ASTs."""

    _r_names = {1: "a", 2: "b", 3: "c", 4: "emp_type", 5: "rate", 6: "hours", 7: "salary"}

    def _translate(self, expression: str) -> str:
        ast = parse(expression)
        result = validate(ast, _COLS)
        return to_r_expression(result.resolved_ast, self._r_names)

    def test_arithmetic(self):
        assert self._translate("[A] + [B]") == "(df$a + df$b)"

    def test_nested_arithmetic(self):
        r = self._translate("[A] * [B] + [C]")
        assert r == "((df$a * df$b) + df$c)"

    def test_comparison(self):
        r = self._translate('[type] == "Hourly"')
        assert r == '(df$emp_type == "Hourly")'

    def test_boolean(self):
        r = self._translate("[A] > 5 AND [B] < 10")
        assert r == "((df$a > 5) & (df$b < 10))"

    def test_not(self):
        r = self._translate("NOT IS_MISSING([A])")
        assert r == "!(is.na(df$a))"

    def test_if(self):
        r = self._translate('IF([type] == "Hourly", [rate], [salary])')
        assert r == 'ifelse((df$emp_type == "Hourly"), df$rate, df$salary)'

    def test_mean(self):
        r = self._translate("MEAN([A], [B], [C])")
        assert r == "rowMeans(cbind(df$a, df$b, df$c), na.rm = TRUE)"

    def test_sum(self):
        r = self._translate("SUM([A], [B])")
        assert r == "rowSums(cbind(df$a, df$b), na.rm = TRUE)"

    def test_min(self):
        r = self._translate("MIN([A], [B])")
        assert r == "pmin(df$a, df$b, na.rm = TRUE)"

    def test_max(self):
        r = self._translate("MAX([A], [B])")
        assert r == "pmax(df$a, df$b, na.rm = TRUE)"

    def test_count_valid(self):
        r = self._translate("COUNT_VALID([A], [B])")
        assert r == "rowSums(!is.na(cbind(df$a, df$b)))"

    def test_is_missing(self):
        r = self._translate("IS_MISSING([A])")
        assert r == "is.na(df$a)"

    def test_coalesce(self):
        r = self._translate("COALESCE([A], 0)")
        assert r == "ifelse(is.na(df$a), 0, df$a)"

    def test_abs(self):
        r = self._translate("ABS([A])")
        assert r == "abs(df$a)"

    def test_round(self):
        r = self._translate("ROUND([A], 2)")
        assert r == "round(df$a, 2)"

    def test_unary_minus(self):
        r = self._translate("-[A]")
        assert r == "-(df$a)"

    def test_custom_df_name(self):
        """df_name parameter changes the data frame prefix."""
        ast = parse("[A] + [B]")
        result = validate(ast, _COLS)
        r = to_r_expression(result.resolved_ast, self._r_names, df_name="data")
        assert r == "(data$a + data$b)"

    def test_custom_df_name_in_function(self):
        """df_name threads through function calls."""
        ast = parse("MEAN([A], [B], [C])")
        result = validate(ast, _COLS)
        r = to_r_expression(result.resolved_ast, self._r_names, df_name="mydf")
        assert r == "rowMeans(cbind(mydf$a, mydf$b, mydf$c), na.rm = TRUE)"


# ── DB Integration Tests ─────────────────────────────────────────────────────

from app.models.project import Project
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.metric import MetricDefinition
from app.services.computed_columns import evaluate_computed_column
from app.services.staleness import mark_metrics_stale
from app.services.project_portability import _remap_json_id_array


def _setup_computed_data(db):
    """Create project + dataset + 2 numeric columns + 3 rows with values.

    Layout:
      col_a (id=1): values [10, 20, None]
      col_b (id=2): values [3, 7, 5]
      3 rows (id=1,2,3)
    Returns (project, dataset, col_a, col_b, [1,2,3])
    """
    project = Project(id=1, name="Computed Test", user_id=1)
    db.add(project)
    db.flush()

    dataset = Dataset(id=1, project_id=1, name="Survey")
    db.add(dataset)
    db.flush()

    col_a = DatasetColumn(
        id=1, dataset_id=1, column_code="A", column_text="Score A",
        column_type="numeric", sequence_order=0, display_order=0,
    )
    col_b = DatasetColumn(
        id=2, dataset_id=1, column_code="B", column_text="Score B",
        column_type="numeric", sequence_order=1, display_order=1,
    )
    db.add_all([col_a, col_b])
    db.flush()

    values = [(10.0, 3.0), (20.0, 7.0), (None, 5.0)]
    for i, (va, vb) in enumerate(values, start=1):
        row = DatasetRow(id=i, dataset_id=1)
        db.add(row)
        db.flush()
        db.add(DatasetValue(row_id=i, column_id=1, value_text=str(va) if va is not None else None, value_numeric=va))
        db.add(DatasetValue(row_id=i, column_id=2, value_text=str(vb), value_numeric=vb))
    db.flush()

    return project, dataset, col_a, col_b, [1, 2, 3]


class TestBulkEvaluator:
    def test_evaluate_simple_sum(self, db_session):
        project, dataset, col_a, col_b, row_ids = _setup_computed_data(db_session)

        comp_col = DatasetColumn(
            id=10, dataset_id=1, column_code="C1", column_text="Sum",
            column_type="numeric", sequence_order=2, display_order=2,
            source="computed", expression="[A] + [B]",
            depends_on_column_ids=json.dumps([1, 2]),
        )
        db_session.add(comp_col)
        db_session.flush()

        count = evaluate_computed_column(db_session, comp_col)
        assert count == 3

        vals = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == 10)
            .order_by(DatasetValue.row_id)
            .all()
        )
        assert len(vals) == 3
        assert vals[0].value_numeric == 13.0  # 10 + 3
        assert vals[1].value_numeric == 27.0  # 20 + 7
        assert vals[2].value_numeric is None  # None + 5 = None

    def test_evaluate_scoped_to_row_ids(self, db_session):
        project, dataset, col_a, col_b, row_ids = _setup_computed_data(db_session)

        comp_col = DatasetColumn(
            id=10, dataset_id=1, column_code="C1", column_text="Sum",
            column_type="numeric", sequence_order=2, display_order=2,
            source="computed", expression="[A] + [B]",
            depends_on_column_ids=json.dumps([1, 2]),
        )
        db_session.add(comp_col)
        db_session.flush()

        count = evaluate_computed_column(db_session, comp_col, row_ids=[1])
        assert count == 1

        vals = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == 10)
            .all()
        )
        assert len(vals) == 1
        assert vals[0].value_numeric == 13.0

    def test_evaluate_updates_existing(self, db_session):
        """Re-evaluation updates existing DatasetValue rows."""
        project, dataset, col_a, col_b, row_ids = _setup_computed_data(db_session)

        comp_col = DatasetColumn(
            id=10, dataset_id=1, column_code="C1", column_text="Sum",
            column_type="numeric", sequence_order=2, display_order=2,
            source="computed", expression="[A] + [B]",
            depends_on_column_ids=json.dumps([1, 2]),
        )
        db_session.add(comp_col)
        db_session.flush()

        evaluate_computed_column(db_session, comp_col)

        # Change expression
        comp_col.expression = "[A] * [B]"
        evaluate_computed_column(db_session, comp_col)

        vals = (
            db_session.query(DatasetValue)
            .filter(DatasetValue.column_id == 10)
            .order_by(DatasetValue.row_id)
            .all()
        )
        assert vals[0].value_numeric == 30.0  # 10 * 3
        assert vals[1].value_numeric == 140.0  # 20 * 7


class TestComputedStaleness:
    def test_source_change_marks_computed_stale(self, db_session):
        project, dataset, col_a, col_b, row_ids = _setup_computed_data(db_session)

        comp_col = DatasetColumn(
            id=10, dataset_id=1, column_code="C1", column_text="Sum",
            column_type="numeric", sequence_order=2, display_order=2,
            source="computed", expression="[A] + [B]",
            depends_on_column_ids=json.dumps([1, 2]),
            stale=False,
        )
        db_session.add(comp_col)
        db_session.flush()

        mark_metrics_stale(db_session, project_id=1, column_ids=[1])

        db_session.refresh(comp_col)
        assert comp_col.stale is True

    def test_computed_stale_cascades_to_metrics(self, db_session):
        project, dataset, col_a, col_b, row_ids = _setup_computed_data(db_session)

        comp_col = DatasetColumn(
            id=10, dataset_id=1, column_code="C1", column_text="Sum",
            column_type="numeric", sequence_order=2, display_order=2,
            source="computed", expression="[A] + [B]",
            depends_on_column_ids=json.dumps([1, 2]),
            stale=False,
        )
        db_session.add(comp_col)
        db_session.flush()

        metric = MetricDefinition(
            id=1, project_id=1, name="Mean Sum",
            metric_type="mean", config="{}",
            input_source_type="dataset_column", input_source_id=10,
            sequence_order=0, origin="human", stale=False,
        )
        db_session.add(metric)
        db_session.flush()

        # Trigger staleness from source column A
        mark_metrics_stale(db_session, project_id=1, column_ids=[1])

        db_session.refresh(comp_col)
        db_session.refresh(metric)
        assert comp_col.stale is True
        assert metric.stale is True

    def test_unrelated_column_does_not_mark_stale(self, db_session):
        project, dataset, col_a, col_b, row_ids = _setup_computed_data(db_session)

        # Add an unrelated column
        col_c = DatasetColumn(
            id=3, dataset_id=1, column_code="C", column_text="Other",
            column_type="numeric", sequence_order=3, display_order=3,
        )
        db_session.add(col_c)

        comp_col = DatasetColumn(
            id=10, dataset_id=1, column_code="C1", column_text="Sum",
            column_type="numeric", sequence_order=4, display_order=4,
            source="computed", expression="[A] + [B]",
            depends_on_column_ids=json.dumps([1, 2]),
            stale=False,
        )
        db_session.add(comp_col)
        db_session.flush()

        # Trigger staleness from unrelated column C
        mark_metrics_stale(db_session, project_id=1, column_ids=[3])

        db_session.refresh(comp_col)
        assert comp_col.stale is not True


class TestComputedGuards:
    def test_source_deletion_blocked(self, db_session):
        """Computed column depends_on_column_ids blocks source deletion."""
        project, dataset, col_a, col_b, row_ids = _setup_computed_data(db_session)

        comp_col = DatasetColumn(
            id=10, dataset_id=1, column_code="C1", column_text="Sum",
            column_type="numeric", sequence_order=2, display_order=2,
            source="computed", expression="[A] + [B]",
            depends_on_column_ids=json.dumps([1, 2]),
        )
        db_session.add(comp_col)
        db_session.flush()

        # Simulate the guard check from delete_manual_column
        computed_deps = (
            db_session.query(DatasetColumn)
            .filter(
                DatasetColumn.dataset_id == 1,
                DatasetColumn.expression.isnot(None),
            )
            .all()
        )
        dep_names = []
        for cc in computed_deps:
            if cc.depends_on_column_ids:
                dep_ids = json.loads(cc.depends_on_column_ids)
                if 1 in dep_ids:  # col_a.id
                    dep_names.append(cc.column_text)
        assert dep_names == ["Sum"]


class TestPortabilityRemapping:
    def test_remap_json_id_array(self):
        """_remap_json_id_array correctly remaps column IDs."""
        remap = {"dataset_columns": {1: 100, 2: 200, 3: 300}}
        result = _remap_json_id_array(json.dumps([1, 2, 3]), remap, "dataset_columns")
        assert json.loads(result) == [100, 200, 300]

    def test_remap_json_id_array_none(self):
        result = _remap_json_id_array(None, {}, "dataset_columns")
        assert result is None

    def test_remap_json_id_array_partial(self):
        """IDs not in remap are preserved as-is."""
        remap = {"dataset_columns": {1: 100}}
        result = _remap_json_id_array(json.dumps([1, 2]), remap, "dataset_columns")
        parsed = json.loads(result)
        assert parsed[0] == 100
        assert parsed[1] == 2


# ── R Export Integration Tests ────────────────────────────────────────────────

from app.models.recode import RecodeDefinition
from app.models.statistical_test import StatisticalTest
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.materials import MaterialCollection, Material
from app.routers.export_r import _build_r_script


def _setup_r_export_project(db):
    """Create a minimal project with diverse column types for R export testing."""
    project = Project(name="R Export Test", user_id=1)
    db.add(project)
    db.flush()

    dataset = Dataset(project_id=project.id, name="Survey")
    db.add(dataset)
    db.flush()

    col_a = DatasetColumn(
        dataset_id=dataset.id, column_code="score_a", column_text="Score A",
        column_type="numeric", sequence_order=0, display_order=0, source="imported",
    )
    col_b = DatasetColumn(
        dataset_id=dataset.id, column_code="score_b", column_text="Score B",
        column_type="numeric", sequence_order=1, display_order=1, source="imported",
    )
    db.add_all([col_a, col_b])
    db.flush()

    col_comp = DatasetColumn(
        dataset_id=dataset.id, column_code="total", column_text="Total Score",
        column_type="numeric", sequence_order=2, display_order=2, source="computed",
        expression="[score_a] + [score_b]",
        depends_on_column_ids=json.dumps([col_a.id, col_b.id]),
    )
    col_likert = DatasetColumn(
        dataset_id=dataset.id, column_code="satis", column_text="Satisfaction",
        column_type="ordinal", sequence_order=3, display_order=3, source="imported",
    )
    db.add_all([col_comp, col_likert])
    db.flush()

    # Primary recode for ordinal column (scale map)
    recode_scale = RecodeDefinition(
        column_id=col_likert.id, name="Satisfaction scale", is_primary=True,
        recode_type="scale_map", output_type="numeric",
        mapping=json.dumps({"Very Low": 1, "Low": 2, "Medium": 3, "High": 4, "Very High": 5}),
    )
    # Reverse recode on score_a
    recode_rev = RecodeDefinition(
        column_id=col_a.id, name="Score A reverse", is_primary=True,
        recode_type="reverse", output_type="numeric",
        mapping=json.dumps({"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}),
    )
    db.add_all([recode_scale, recode_rev])
    db.flush()

    # Rows + values
    for i in range(1, 4):
        row = DatasetRow(dataset_id=dataset.id)
        db.add(row)
        db.flush()
        db.add_all([
            DatasetValue(row_id=row.id, column_id=col_a.id,
                         value_text=str(i * 10), value_numeric=float(i * 10)),
            DatasetValue(row_id=row.id, column_id=col_b.id,
                         value_text=str(i * 5), value_numeric=float(i * 5)),
            DatasetValue(row_id=row.id, column_id=col_comp.id,
                         value_text=str(i * 15), value_numeric=float(i * 15)),
            DatasetValue(row_id=row.id, column_id=col_likert.id,
                         value_text="High", value_numeric=4.0),
        ])

    # Domain with members
    domain = AnalysisDomain(project_id=project.id, name="Performance")
    db.add(domain)
    db.flush()
    db.add(AnalysisDomainMember(
        domain_id=domain.id, member_type="column",
        member_id=col_a.id, sequence_order=0,
    ))
    db.add(AnalysisDomainMember(
        domain_id=domain.id, member_type="column",
        member_id=col_b.id, sequence_order=1,
    ))

    # Statistical test (alpha on domain)
    stat_test = StatisticalTest(
        project_id=project.id, test_type="cronbachs_alpha",
        target_type="analysis_domain", target_id=domain.id,
        result_data=json.dumps({"alpha": 0.85, "k": 2, "n": 3}),
        stale=False,
    )
    db.add(stat_test)

    # Material (descriptives mean chart)
    collection = MaterialCollection(project_id=project.id, name="Saved")
    db.add(collection)
    db.flush()
    mat = Material(
        collection_id=collection.id, material_type="horizontal_bar",
        source_tab="descriptives", auto_name="Mean Scores",
        config=json.dumps({
            "metric_type": "mean",
            "column_ids": [col_a.id, col_b.id],
        }),
    )
    db.add(mat)
    db.flush()

    cols = [col_a, col_b, col_comp, col_likert]
    return project, dataset, cols, domain, stat_test, collection, mat


def _call_build_r_script(db, project, dataset, cols):
    """Helper to call _build_r_script with minimal required parameters."""
    col_meta = {}
    for c in cols:
        col_meta[c.id] = {
            "r_name": c.column_code or f"col_{c.id}",
            "col": c,
            "dataset": dataset,
            "is_demographic": c.column_type == "demographic",
        }

    from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
    domains = db.query(AnalysisDomain).filter(
        AnalysisDomain.project_id == project.id
    ).all()
    all_domain_name_map = {d.id: d.name for d in domains}
    all_domain_members_map = {}
    for d in domains:
        members = db.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.domain_id == d.id,
            AnalysisDomainMember.member_type == "column",
        ).all()
        all_domain_members_map[d.id] = [
            col_meta[m.member_id]["r_name"]
            for m in members if m.member_id in col_meta
        ]

    human_metrics = db.query(MetricDefinition).filter(
        MetricDefinition.project_id == project.id,
        MetricDefinition.origin == "human",
    ).all()

    stat_tests = db.query(StatisticalTest).filter(
        StatisticalTest.project_id == project.id,
        StatisticalTest.result_data != None,
    ).all()

    materials_list = db.query(Material).join(
        MaterialCollection
    ).filter(
        MaterialCollection.project_id == project.id,
    ).all()
    quant_mats = [m for m in materials_list if not m.material_type.startswith("qual_")]

    return _build_r_script(
        db=db,
        project=project,
        project_slug="r_export_test",
        qualifying_datasets=[(dataset, cols)],
        col_meta=col_meta,
        domain_metrics=[],
        domain_score_cols=[],
        domain_members_map={},
        domain_members_by_dataset_map={},
        n_records=3,
        n_variables=len(cols),
        skipped_datasets=[],
        is_multi_dataset=False,
        equiv_groups=[],
        used_names={c.column_code for c in cols if c.column_code},
        all_domain_name_map=all_domain_name_map,
        all_domain_members_map=all_domain_members_map,
        all_domain_members_by_dataset_map={},
        human_metrics=human_metrics,
        human_metric_labels={},
        stat_tests=stat_tests,
        quant_materials=quant_mats,
    )


class TestRExportScript:
    """Integration tests for R script generation."""

    def test_no_bom_prefix(self, db_session):
        # #363: the .R script must NOT carry a UTF-8 BOM \u2014 R fails to parse it
        # ("unexpected input"). (The BOM stays on the companion .csv.)
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert not script.startswith("\ufeff")
        assert script.lstrip().startswith("#")

    def test_section_markers(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert "# ---- Packages ----" in script
        assert "# ---- Read data ----" in script

    def test_toc_generated(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert "# Table of contents:" in script
        assert "#   - Packages" in script
        assert "#   - Read data" in script

    def test_computed_column_formula_with_data_prefix(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert "data$total <- (data$score_a + data$score_b)" in script

    def test_computed_column_in_variable_labels(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert 'attr(data$total, "label") <- "Total Score"' in script

    def test_computed_column_skipped_in_ordinal_factors(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        # Ordinal factor for satis should exist
        assert "data$satis <- factor(data$satis," in script
        # Computed column should NOT appear as a factor
        assert "data$total <- factor(" not in script

    def test_reverse_scored_has_formula(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert "reverse-scored" in script
        assert "original scale 1-5" in script
        assert "score_a_R" in script

    def test_psych_package_for_alpha(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert '"psych"' in script
        assert "psych::alpha(" in script

    def test_ggplot2_package_for_chart(self, db_session):
        project, dataset, cols, *_ = _setup_r_export_project(db_session)
        script = _call_build_r_script(db_session, project, dataset, cols)
        assert '"ggplot2"' in script
        assert "geom_col(" in script

    def test_no_extra_packages_without_analysis(self, db_session):
        """A project with no analysis/tests/charts should only need readr."""
        project = Project(name="Empty", user_id=1)
        db_session.add(project)
        db_session.flush()
        dataset = Dataset(project_id=project.id, name="Data")
        db_session.add(dataset)
        db_session.flush()
        col = DatasetColumn(
            dataset_id=dataset.id, column_code="x", column_text="X",
            column_type="numeric", sequence_order=0, display_order=0,
        )
        db_session.add(col)
        db_session.flush()

        col_meta = {col.id: {"r_name": "x", "col": col, "dataset": dataset,
                              "is_demographic": False}}
        script = _build_r_script(
            db=db_session, project=project, project_slug="empty",
            qualifying_datasets=[(dataset, [col])], col_meta=col_meta,
            domain_metrics=[], domain_score_cols=[], domain_members_map={},
            domain_members_by_dataset_map={},
            n_records=0, n_variables=1, skipped_datasets=[],
            is_multi_dataset=False, equiv_groups=[], used_names={"x"},
            all_domain_name_map={}, all_domain_members_map={},
            all_domain_members_by_dataset_map={},
            human_metrics=[], human_metric_labels={},
            stat_tests=[], quant_materials=[],
        )
        assert 'required_packages <- c("readr")' in script
        assert '"dplyr"' not in script
        assert '"psych"' not in script
        assert '"ggplot2"' not in script


# ═══════════════════════════════════════════════════════════════════════════════
# #360 — row-wise aggregates skip unmappable text cells (na.rm), don't 500
# ═══════════════════════════════════════════════════════════════════════════════
#
# A ColumnRef resolving to a value with value_text but no value_numeric (an
# ordinal/Likert cell whose label was a typo and never got mapped) used to raise
# ExpressionError inside MEAN/SUM/MIN/MAX/COUNT_VALID, which propagated as an
# unhandled 500 from create/update/recompute. Now such cells are treated as
# missing and skipped — matching the R translation's rowMeans(..., na.rm = TRUE).
# (Recreated here — original prediction test lived in /tmp.)


class TestAggregateTextCellSkipping:
    def test_mean_skips_unmappable_text_cell(self):
        # A=2, B="Srongly Disagree" (typo, no numeric), C=4 → mean(2,4)=3
        row = {1: (None, 2.0), 2: ("Srongly Disagree", None), 3: (None, 4.0)}
        assert _eval_expr("MEAN([A], [B], [C])", row) == ("3", 3.0)

    def test_sum_skips_unmappable_text_cell(self):
        row = {1: (None, 2.0), 2: ("typo", None), 3: (None, 4.0)}
        assert _eval_expr("SUM([A], [B], [C])", row) == ("6", 6.0)

    def test_min_max_skip_unmappable_text_cell(self):
        row = {1: (None, 7.0), 2: ("typo", None), 3: (None, 3.0)}
        assert _eval_expr("MIN([A], [B], [C])", row) == ("3", 3.0)
        assert _eval_expr("MAX([A], [B], [C])", row) == ("7", 7.0)

    def test_count_valid_excludes_text_cell(self):
        row = {1: (None, 1.0), 2: ("typo", None), 3: (None, 3.0)}
        assert _eval_expr("COUNT_VALID([A], [B], [C])", row) == ("2", 2.0)

    def test_mean_all_text_yields_null(self):
        # Every arg unmappable → no numeric values → NULL (row blanks, no crash).
        row = {1: ("a", None), 2: ("b", None)}
        assert _eval_expr("MEAN([A], [B])", row) == (None, None)

    def test_string_equality_still_works_alongside_skip(self):
        # The skip is in the aggregate branch only; text == still compares text.
        assert _eval_expr('[type] == "Hourly"', {4: ("Hourly", None)}) == ("TRUE", 1.0)

    def test_aggregate_over_nonnumeric_column_warns(self):
        # _COLS id=4 ("type") is nominal — MEAN over it warns at validate time.
        result = validate(parse("MEAN([A], [type])"), _COLS)
        assert any("non-numeric" in w and "MEAN" in w for w in result.warnings)


class TestAggregateTextCellDBIntegration:
    def test_mean_over_ordinal_with_typo_cell_does_not_raise(self, db_session):
        """End-to-end #360: a MEAN computed column over ordinal columns where one
        cell is an unmapped typo evaluates without raising; the typo is skipped."""
        db = db_session
        db.add(Project(id=1, name="Typo Test", user_id=1)); db.flush()
        db.add(Dataset(id=1, project_id=1, name="Survey")); db.flush()
        cf1 = DatasetColumn(id=1, dataset_id=1, column_code="CF1", column_text="CF1",
                            column_type="ordinal", sequence_order=0, display_order=0)
        cf2 = DatasetColumn(id=2, dataset_id=1, column_code="CF2", column_text="CF2",
                            column_type="ordinal", sequence_order=1, display_order=1)
        db.add_all([cf1, cf2]); db.flush()
        # row1: CF1=4, CF2=5 ; row2: CF1=3, CF2 typo (value_text, no numeric)
        data = [(4.0, ("5", 5.0)), (3.0, ("Srongly Disagree", None))]
        for i, (v1, (vt2, vn2)) in enumerate(data, start=1):
            db.add(DatasetRow(id=i, dataset_id=1)); db.flush()
            db.add(DatasetValue(row_id=i, column_id=1, value_text=str(v1), value_numeric=v1))
            db.add(DatasetValue(row_id=i, column_id=2, value_text=vt2, value_numeric=vn2))
        db.flush()
        comp = DatasetColumn(id=10, dataset_id=1, column_code="CFm", column_text="CF Mean",
                             column_type="numeric", sequence_order=2, display_order=2,
                             source="computed", expression="MEAN([CF1], [CF2])",
                             depends_on_column_ids=json.dumps([1, 2]))
        db.add(comp); db.flush()

        count = evaluate_computed_column(db, comp)  # must not raise
        assert count == 2
        vals = (db.query(DatasetValue).filter(DatasetValue.column_id == 10)
                .order_by(DatasetValue.row_id).all())
        assert vals[0].value_numeric == 4.5   # mean(4, 5)
        assert vals[1].value_numeric == 3.0   # mean(3) — typo cell skipped


# ═══════════════════════════════════════════════════════════════════════════════
# #361 — deleting a computed column blocked when another depends on it
# ═══════════════════════════════════════════════════════════════════════════════

import asyncio as _asyncio
from fastapi import HTTPException
from app.models.user import User
from app.routers.dataset import delete_computed_column


def _run_dataset(coro):
    return _asyncio.run(coro)


class TestComputedColumnDeletionGuard:
    def _seed(self, db):
        db.add(Project(id=1, name="Dep Guard", user_id=1)); db.flush()
        db.add(Dataset(id=1, project_id=1, name="Comp")); db.flush()
        db.add(DatasetColumn(id=1, dataset_id=1, column_code="A", column_text="Base_Salary",
                             column_type="numeric", sequence_order=0, display_order=0,
                             source="imported"))
        db.flush()
        return db.query(User).filter(User.id == 1).one()

    def test_delete_blocked_when_dependent_exists(self, db_session):
        db = db_session
        user = self._seed(db)
        base = DatasetColumn(id=10, dataset_id=1, column_code="C1", column_text="Annualized_Base",
                             column_type="numeric", sequence_order=1, display_order=1,
                             source="computed", expression="[A] * 2080",
                             depends_on_column_ids=json.dumps([1]))
        db.add(base); db.flush()
        dependent = DatasetColumn(id=11, dataset_id=1, column_code="C2",
                                  column_text="FTE_Adjusted_Annual",
                                  column_type="numeric", sequence_order=2, display_order=2,
                                  source="computed", expression="[C1] / 2",
                                  depends_on_column_ids=json.dumps([10]))
        db.add(dependent); db.flush()

        with pytest.raises(HTTPException) as exc:
            _run_dataset(delete_computed_column(
                project_id=1, dataset_id=1, column_id=10, user=user, db=db))
        assert exc.value.status_code == 409
        assert "FTE_Adjusted_Annual" in exc.value.detail
        # Base column survives the rejected delete.
        assert db.query(DatasetColumn).filter(DatasetColumn.id == 10).first() is not None

    def test_delete_allowed_when_no_dependents(self, db_session):
        db = db_session
        user = self._seed(db)
        standalone = DatasetColumn(id=12, dataset_id=1, column_code="C3", column_text="Standalone",
                                   column_type="numeric", sequence_order=1, display_order=1,
                                   source="computed", expression="[A] + 1",
                                   depends_on_column_ids=json.dumps([1]))
        db.add(standalone); db.flush()

        _run_dataset(delete_computed_column(
            project_id=1, dataset_id=1, column_id=12, user=user, db=db))
        assert db.query(DatasetColumn).filter(DatasetColumn.id == 12).first() is None
