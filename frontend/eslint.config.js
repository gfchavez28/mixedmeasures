import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // React Compiler readiness rules (eslint-plugin-react-hooks v7). We are NOT
      // adopting the React Compiler for v1.0 — manual ref-stabilization
      // (optionsRef/mutationsRef/handlerRefs/structsRef), manual memoization, and
      // dnd-kit hook-result access are all intentional and correct without it.
      // Revisit as a deliberate v1.x track (adopting the compiler would let us
      // DELETE the manual memo these flag). Tracked: #401.
      //
      // `refs`/`static-components` flag a pattern used at scale (every dnd-kit
      // useDroppable/useSortable result access, every stabilization ref) with no
      // existing inline disables, so turn them off. `immutability`/`preserve-
      // manual-memoization` stay `warn` — they already have curated per-site
      // inline disables (usePlayback DOM writes, QualitativeAnalysisView qa.*);
      // turning them off would orphan those directives into errors under
      // --report-unused-disable-directives. `set-state-in-effect` stays `warn` —
      // it flags real "you-might-not-need-an-effect" smells we triage individually.
      'react-hooks/refs': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      // #481 — DESIGN.md §11: ban raw Tailwind neutral/blue palette utilities
      // (always mm-*/shadcn tokens or lib/selection.ts). Status & entity palettes
      // (amber/emerald/rose/purple/teal/orange/sky/indigo) stay allowed by design.
      // Deliberate exceptions (entity-color maps, data-viz fills) carry an inline
      // `// eslint-disable-next-line no-restricted-syntax -- <reason>`.
      'no-restricted-syntax': ['error',
        {
          selector: "Literal[value=/\\b(?:blue|gray|slate|zinc|stone)-\\d/]",
          message: 'Raw Tailwind palette banned (DESIGN.md §11) — use mm-*/shadcn tokens or lib/selection.ts.',
        },
        {
          selector: "TemplateElement[value.raw=/\\b(?:blue|gray|slate|zinc|stone)-\\d/]",
          message: 'Raw Tailwind palette banned (DESIGN.md §11) — use mm-*/shadcn tokens or lib/selection.ts.',
        },
      ],
    },
  },
)
