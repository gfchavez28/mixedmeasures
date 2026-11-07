/**
 * #1335 (D46/D47, 1.5.9) — the rule a co-occurrence pair is counted by.
 *
 * Since 1.5.9 two codes co-occur on a passage (or, at the source level, in a
 * source) only where ONE coder applied both; coder A's X beside coder B's Y is a
 * disagreement about the passage, not a relationship between X and Y. The
 * diagonal is unchanged: the passages carrying a code, by anyone.
 *
 * Said where the number is read: the matrix's caption (`QualCooccurrence`, which
 * the analysis tab, its PNG export and the Canvas embed all render) and the
 * Canvas export's note under the table (`lib/canvas-export.ts`). The server's CSV
 * first line and Excel corner cell say the same words from
 * `backend/app/services/code_analysis.py::COOCCURRENCE_RULE`;
 * `backend/tests/test_cooccurrence_one_coder.py` holds the two equal.
 *
 * ⚠️ A DEFINITION, not a stated basis (D47): one rule for every scope, so it does
 * not ride the wire and has no union option.
 */
export const COOCCURRENCE_RULE = 'Two codes count as co-occurring only where one coder applied both.'
