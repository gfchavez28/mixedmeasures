import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CoderMappingDecision, MergeCoderPreview } from '@/lib/api'
import { ConfirmStep } from './MergeProject'
import { agreementNote, confirmBlocker } from '@/lib/merge-coder-mapping'

afterEach(cleanup)

/**
 * #1034 — the confirm step says what KIND of coder each one is, why a same-name
 * coder is not proposed, and counts only PEOPLE toward consensus and agreement.
 */
const MODEL: MergeCoderPreview = {
  original_id: 2, username: 'Model-1', coder_type: 'ai', archived: false, file_app_count: 40,
  local_match: null,
  name_in_use: { username: 'Model-1', coder_type: 'human', reason: 'kind', new_username: 'Model-1 (2)' },
  match_options: [],
  machine_provenance: { model: 'gpt-4o-2024-08-06', access: 'api' },
  create_username: 'Model-1 (2)',
}
const PERSON: MergeCoderPreview = {
  original_id: 1, username: 'Ana', coder_type: 'human', archived: false, file_app_count: 12,
  local_match: { id: 5, username: 'Ana', archived: false, local_app_count: 30, basis: 'identity' },
  name_in_use: null, match_options: [{ id: 5, username: 'Ana', archived: false }],
  machine_provenance: null, create_username: 'Ana (2)',
}
/** #1352 — the colleague whose name is every install's first coder. */
const NAMESAKE: MergeCoderPreview = {
  original_id: 3, username: 'Researcher', coder_type: 'human', archived: false, file_app_count: 7,
  local_match: { id: 1, username: 'Researcher', archived: false, local_app_count: 40, basis: 'name' },
  name_in_use: null, match_options: [{ id: 1, username: 'Researcher', archived: false }],
  machine_provenance: null, create_username: 'Researcher (2)',
}

function renderStep(
  coders: MergeCoderPreview[], decisions: Record<number, CoderMappingDecision>,
  peopleHere: number[] = [], onContinue: () => void = () => {},
) {
  const people = coders.filter(c => c.coder_type !== 'ai' && decisions[c.original_id]?.action === 'create').length
  const models = coders.filter(c => c.coder_type === 'ai' && decisions[c.original_id]?.action === 'create').length
  return render(
    <TooltipProvider>
      <ConfirmStep
        title="Study" mergeCoders={coders} decisions={decisions} renames={{}}
        newCoders={{ people, models }} continueLabel="Continue"
        agreement={agreementNote(coders, decisions, peopleHere)}
        blocker={confirmBlocker(coders, decisions)}
        onDecision={() => {}} onRename={() => {}} onToggleUnarchive={() => {}}
        onCancel={() => {}} onContinue={onContinue}
      />
    </TooltipProvider>,
  )
}

describe('#1034 — the confirm step', () => {
  it('names a model as a model, with its configuration', () => {
    renderStep([MODEL], { 2: { action: 'create' } })
    expect(screen.getByText('Machine coder · gpt-4o-2024-08-06 · via API')).toBeInTheDocument()
  })

  it('says why a same-name PERSON is not proposed, and the name the model gets instead', () => {
    renderStep([MODEL], { 2: { action: 'create' } })
    expect(screen.getByText(/A person called “Model-1” is already here/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'New coder name for Model-1' })).toHaveValue('Model-1 (2)')
  })

  it('a new MODEL does not claim to enable consensus or agreement', () => {
    renderStep([PERSON, MODEL], { 1: { action: 'match', target_user_id: 5 }, 2: { action: 'create' } })
    expect(screen.queryByText(/enables consensus/)).not.toBeInTheDocument()
    expect(screen.getByText(/1 new model coder — compared on the Model comparison tab/)).toBeInTheDocument()
    expect(screen.getByText(/Fewer than two people will have coded this project/)).toBeInTheDocument()
  })

  it('the footer’s TOOLTIP counts people too (a11y-name-sweep run 9)', () => {
    // The sentence was corrected by #1034; the title beside it still said
    // "two coders" / "every coder", so a model read as a voter on hover.
    renderStep([PERSON, MODEL], { 1: { action: 'match', target_user_id: 5 }, 2: { action: 'create' } })
    const footer = screen.getByText(/Fewer than two people/).closest('[title]')!
    expect(footer.getAttribute('title')).toMatch(/at least two people/)
    expect(footer.getAttribute('title')).not.toMatch(/two coders|every coder/)
  })

  it('POSITIVE CONTROL: a new PERSON beside one already here makes them available', () => {
    renderStep([{ ...PERSON, local_match: null }], { 1: { action: 'create' } }, [5])
    expect(screen.getByText(/2 people have coded this project — consensus \+ agreement \(IRR\) become available/)).toBeInTheDocument()
  })

  it('a person is not labelled a machine coder, and the same coder is said as such', () => {
    renderStep([PERSON], { 1: { action: 'match', target_user_id: 5 } })
    expect(screen.queryByText(/Machine coder ·/)).not.toBeInTheDocument()
    expect(screen.getByText('The same coder as “Ana” here.')).toBeInTheDocument()
  })
})

describe('#1352 — a name is never answered on the researcher’s behalf', () => {
  it('an unanswered namesake holds Continue, with the reason beside it', () => {
    const onContinue = vi.fn()
    renderStep([NAMESAKE], {}, [1], onContinue)
    const button = screen.getByRole('button', { name: /Continue/ })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Choose whether “Researcher” is a coder already here or a new coder.')).toBeInTheDocument()
    fireEvent.click(button)
    expect(onContinue).not.toHaveBeenCalled()
    expect(screen.getByText(/A coder called “Researcher” is already here, with 40 codings/)).toBeInTheDocument()
  })

  it('POSITIVE CONTROL: once answered, Continue goes', () => {
    const onContinue = vi.fn()
    renderStep([NAMESAKE], { 3: { action: 'create' } }, [1], onContinue)
    const button = screen.getByRole('button', { name: /Continue/ })
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    expect(onContinue).toHaveBeenCalledOnce()
    // #1246 — the numbered name is shown before the act.
    expect(screen.getByRole('textbox', { name: 'New coder name for Researcher' })).toHaveValue('Researcher (2)')
  })

  it('🔴 the payload is built BEFORE the merging step, so a gap is never a "did not answer"', () => {
    // `buildCoderMapping` throws on a coder with no decision. Called inside the request's
    // `try` (after `setStep('merging')`), the throw reached `mergeFailure`, which reads an
    // unanswered error as "whether the merge finished is not known" — over a request that
    // was never sent. Pinned by SOURCE ORDER (the page reaches Merge only past the blocker,
    // so no render can produce the gap — the #1206 call-before-navigate shape).
    const src = stripComments(readFileSync(join(__dirname, 'MergeProject.tsx'), 'utf8'))
    const start = src.indexOf('const runMerge = useCallback(')
    expect(start).toBeGreaterThan(0)
    const body = src.slice(start, src.indexOf('\n  }, [', start))
    const build = body.indexOf('buildCoderMapping(')
    const merging = body.indexOf("setStep('merging')")
    // Population self-check: both are in the slice, once each.
    expect(build).toBeGreaterThan(0)
    expect(merging).toBeGreaterThan(0)
    expect(body.split('buildCoderMapping(').length).toBe(2)
    expect(build).toBeLessThan(merging)
    // …and a throw goes back to the confirm step, never on to the request.
    expect(body.slice(build, merging)).toMatch(/catch\s*\{\s*setStep\('confirm'\)\s*return\s*\}/)
  })
})
