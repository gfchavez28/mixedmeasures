/**
 * #963 — what the New Rule form may CLAIM and OFFER before its two lists answer.
 *
 * Both were driven on the running app before this guard was written, and both
 * arms had a distinct failure:
 *
 *  - **the rules outstanding** — the form rendered its editor from the FREQUENCY
 *    seed, and the rebuild effect re-ran the instant the rules landed, so a value
 *    typed into it was silently reverted (measured: `99` back to `1` at the
 *    moment the list answered);
 *  - **the frequencies outstanding** — the form said *"No response values found.
 *    Use the input below to add labels manually"* while rendering **no input**,
 *    and left **Create enabled**, which saves a rule whose `mapping` is `{}`
 *    (`RecodeDefinitionCreate.mapping: dict`, no minimum).
 *
 * `ready` is the POSITIVE CONTROL in every case: a guard that passed by making
 * the form permanently inert would satisfy every negative assertion here.
 */
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewDefinitionForm } from './RecodeWorkbench'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'
import type { ListLoad } from '@/lib/list-status'
import type { DatasetColumn, RecodeDefinition, ValueFrequency } from '@/lib/api'

const load = (status: ListLoad['status'], over: Partial<ListLoad> = {}): ListLoad => ({
  status,
  error: status === 'failed' ? { status: 500 } : null,
  retry: vi.fn(),
  retrying: false,
  ...over,
})

const column = () => ({ id: 7, column_type: 'ordinal' }) as unknown as DatasetColumn

const freqData = (...vals: string[]) => ({
  column_id: 7,
  total: vals.length,
  frequencies: vals.map(value_text => ({ value_text, count: 1, is_na: false })) as unknown as ValueFrequency[],
})

function mount(seedLoad: ListLoad, opts: { definitions?: RecodeDefinition[]; freqs?: boolean } = {}) {
  const onCreate = vi.fn()
  const view = render(
    <NewDefinitionForm
      existingDefinitions={opts.definitions ?? []}
      onCreate={onCreate}
      isCreating={false}
      selectedColumn={column()}
      frequenciesData={opts.freqs === false ? undefined : freqData('1', '2', '3')}
      seedLoad={seedLoad}
    />,
  )
  return { onCreate, ...view }
}

const createButton = () => screen.getByRole('button', { name: 'Create' })
const valueInputs = () =>
  screen.queryAllByRole('spinbutton').filter(el => /^Value for /.test(el.getAttribute('aria-label') ?? ''))

describe('#963 — the New Rule form while its lists are loading', () => {
  it('renders no editor, so there is no draft to seed or to overwrite', () => {
    mount(load('loading'))
    expect(valueInputs()).toHaveLength(0)
  })

  it('says it is loading instead of claiming the variable has no responses', () => {
    mount(load('loading'))
    expect(screen.getByRole('status')).toHaveTextContent(/Loading this variable/i)
    expect(screen.queryByText(/No response values found/i)).toBeNull()
    expect(screen.queryByText(/No labels available for preview/i)).toBeNull()
  })

  it('does not claim there is no scale map to reverse', () => {
    mount(load('loading'))
    fireEvent.click(screen.getByRole('radio', { name: 'Reverse' }))
    expect(screen.queryByText(/No scale map definitions exist to reverse/i)).toBeNull()
  })

  it('refuses to create, and the disabled Create says why', () => {
    const { onCreate } = mount(load('loading'))
    fireEvent.change(screen.getByLabelText('Definition name'), { target: { value: 'Banded' } })
    const create = createButton()
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('title', expect.stringMatching(/Loading/i))
    fireEvent.click(create)
    expect(onCreate).not.toHaveBeenCalled()
  })
})

describe('#963 — the New Rule form after its lists fail', () => {
  it('says the load failed and offers a Retry, rather than showing an empty seed', () => {
    mount(load('failed'))
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/i)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(valueInputs()).toHaveLength(0)
    expect(screen.queryByText(/No response values found/i)).toBeNull()
  })

  it('keeps the failure notice up while the retry runs, with Retry still focusable', () => {
    mount(load('failed', { retrying: true }))
    const retry = screen.getByRole('button', { name: /Retrying/ })
    // `aria-disabled`, never `disabled` — Chrome blurs a focused element that
    // becomes disabled, and the keyboard user pressed this one.
    expect(retry).not.toBeDisabled()
    expect(retry).toHaveAttribute('aria-disabled', 'true')
  })

  it('refuses to create, and Create names the failure rather than a wait', () => {
    const { onCreate } = mount(load('failed'))
    fireEvent.change(screen.getByLabelText('Definition name'), { target: { value: 'Banded' } })
    expect(createButton()).toBeDisabled()
    expect(createButton()).toHaveAttribute('title', expect.stringMatching(/could not be loaded/i))
    fireEvent.click(createButton())
    expect(onCreate).not.toHaveBeenCalled()
  })
})

describe('#963 — POSITIVE CONTROL: the form is fully operable once both lists answer', () => {
  it('seeds the editor from the responses and lets a typed value stand', () => {
    mount(load('ready'))
    const inputs = valueInputs()
    expect(inputs).toHaveLength(3)
    expect(inputs.map(i => (i as HTMLInputElement).value)).toEqual(['1', '2', '3'])
    fireEvent.change(inputs[0], { target: { value: '99' } })
    expect((valueInputs()[0] as HTMLInputElement).value).toBe('99')
  })

  it('creates, passing the seeded mapping', () => {
    const { onCreate } = mount(load('ready'))
    fireEvent.change(screen.getByLabelText('Definition name'), { target: { value: 'Banded' } })
    expect(createButton()).not.toBeDisabled()
    fireEvent.click(createButton())
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      name: 'Banded',
      recode_type: 'scale_map',
      mapping: { '1': 1, '2': 2, '3': 3 },
    })
  })

  it('still makes the honest empty claim when the answer really is "none"', () => {
    mount(load('ready'), { freqs: false })
    expect(screen.getByText(/No response values found/i)).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('still says when there is no scale map to reverse', () => {
    mount(load('ready'))
    fireEvent.click(screen.getByRole('radio', { name: 'Reverse' }))
    expect(screen.getByText(/No scale map definitions exist to reverse/i)).toBeInTheDocument()
  })

  it('seeds when the status transitions loading → ready', () => {
    const { rerender } = mount(load('loading'))
    expect(valueInputs()).toHaveLength(0)
    rerender(
      <NewDefinitionForm
        existingDefinitions={[]}
        onCreate={vi.fn()}
        isCreating={false}
        selectedColumn={column()}
        frequenciesData={freqData('1', '2', '3')}
        seedLoad={load('ready')}
      />,
    )
    expect(valueInputs()).toHaveLength(3)
  })
})

/**
 * The page half, which no render of this component can reach: that it passes a
 * COMPUTED load state rather than a literal, and that `definitions` is not a
 * destructuring default.
 *
 * ⚠️ A `[]` default is a FRESH ARRAY on every render of the page, and it is a
 * dependency of the form's rebuild effect — so the effect re-ran on renders that
 * had nothing to do with this variable's rules. `useMemo` is what makes the
 * identity track the DATA.
 */
describe('#963 — the page wires the form to real queries', () => {
  const source = stripComments(
    readFileSync(join(SRC_DIR, 'pages/RecodeWorkbench.tsx'), 'utf8'),
    'RecodeWorkbench.tsx',
  )

  it('can still see the code it is scanning', () => {
    // Self-check per narrowing (#814): a stripped-to-nothing source would make
    // every assertion below pass by finding nothing.
    expect(source).toContain('function NewDefinitionForm')
    expect(source).toContain('<NewDefinitionForm')
  })

  it('derives the two load states from the two queries', () => {
    expect(source).toMatch(/const\s+defsLoad\s*=\s*useListLoad\(\s*definitionsQuery\s*\)/)
    expect(source).toMatch(
      /const\s+seedLoad\s*=\s*useListLoad\(\s*definitionsQuery\s*,\s*frequenciesQuery\s*\)/,
    )
  })

  it('passes the computed seedLoad to the form, never a literal', () => {
    expect(source).toMatch(/seedLoad=\{seedLoad\}/)
    expect(source).not.toMatch(/seedLoad=\{\{/)
  })

  it('holds the rule list in a useMemo, not a destructuring default', () => {
    expect(source).toMatch(/const\s+definitions\s*=\s*useMemo\(/)
    expect(source).not.toMatch(/data:\s*definitions\s*=\s*\[\]/)
  })

  it('counts the rules only once the list has answered', () => {
    expect(source).toMatch(/defsLoad\.status === 'ready' \? ` \(\$\{definitions\.length\}\)` : ''/)
  })
})
