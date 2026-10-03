import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CoderMappingDecision, MergeCoderPreview } from '@/lib/api'
import { ConfirmStep } from './MergeProject'

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
}
const PERSON: MergeCoderPreview = {
  original_id: 1, username: 'Ana', coder_type: 'human', archived: false, file_app_count: 12,
  local_match: { id: 5, username: 'Ana', archived: false, local_app_count: 30 },
  name_in_use: null, match_options: [{ id: 5, username: 'Ana', archived: false }],
  machine_provenance: null,
}

function renderStep(coders: MergeCoderPreview[], decisions: Record<number, CoderMappingDecision>) {
  const people = coders.filter(c => c.coder_type !== 'ai' && decisions[c.original_id]?.action === 'create').length
  const models = coders.filter(c => c.coder_type === 'ai' && decisions[c.original_id]?.action === 'create').length
  return render(
    <TooltipProvider>
      <ConfirmStep
        title="Study" mergeCoders={coders} decisions={decisions} renames={{}}
        newCoders={{ people, models }} continueLabel="Continue"
        onDecision={() => {}} onRename={() => {}} onToggleUnarchive={() => {}}
        onCancel={() => {}} onContinue={() => {}}
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
    expect(screen.getByText(/keeps this project single-coder/)).toBeInTheDocument()
  })

  it('the footer’s TOOLTIP counts people too (a11y-name-sweep run 9)', () => {
    // The sentence was corrected by #1034; the title beside it still said
    // "two coders" / "every coder", so a model read as a voter on hover.
    renderStep([PERSON, MODEL], { 1: { action: 'match', target_user_id: 5 }, 2: { action: 'create' } })
    const footer = screen.getByText(/keeps this project single-coder/).closest('[title]')!
    expect(footer.getAttribute('title')).toMatch(/at least two people/)
    expect(footer.getAttribute('title')).not.toMatch(/two coders|every coder/)
  })

  it('POSITIVE CONTROL: a new PERSON still enables them', () => {
    renderStep([{ ...PERSON, local_match: null }], { 1: { action: 'create' } })
    expect(screen.getByText('1 new person — enables consensus + agreement (IRR).')).toBeInTheDocument()
  })

  it('a person is not labelled a machine coder', () => {
    renderStep([PERSON], { 1: { action: 'match', target_user_id: 5 } })
    expect(screen.queryByText(/Machine coder ·/)).not.toBeInTheDocument()
    expect(screen.getByText('Same name already here')).toBeInTheDocument()
  })
})
