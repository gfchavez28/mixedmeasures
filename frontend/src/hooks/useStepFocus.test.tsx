/**
 * #1011 — the one rule for where focus goes when an import wizard's step changes.
 *
 * Rendered under StrictMode throughout: the app runs in it, and the first version
 * of this rule (Coding Import, #1005) passed an unwrapped test while taking focus
 * on arrival in the app — StrictMode runs a mount effect twice and a ref survives.
 */
import { StrictMode, useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useStepFocus } from './useStepFocus'

afterEach(cleanup)

type Step = 'loading' | 'one' | 'two' | 'busy'

function Wizard({ initial, transient = [] }: { initial: Step; transient?: Step[] }) {
  const [step, setStep] = useState<Step>(initial)
  const ref = useStepFocus(step, transient)
  return (
    <div>
      <h2 ref={ref} tabIndex={-1}>heading {step}</h2>
      {(['loading', 'one', 'two', 'busy'] as Step[]).map(s => (
        <button key={s} type="button" onClick={() => setStep(s)}>go {s}</button>
      ))}
    </div>
  )
}

const renderWizard = (initial: Step, transient?: Step[]) =>
  render(<StrictMode><Wizard initial={initial} transient={transient} /></StrictMode>)
const heading = () => screen.getByRole('heading')

describe('useStepFocus', () => {
  it('does NOT take focus when the page opens', () => {
    renderWizard('one')
    expect(document.activeElement).not.toBe(heading())
  })

  it('moves focus to the heading when the step changes', () => {
    renderWizard('one')
    fireEvent.click(screen.getByRole('button', { name: 'go two' }))
    expect(document.activeElement).toBe(heading())
    expect(heading()).toHaveTextContent('heading two')
  })

  it('never lands on a transient step, and moves on the step after it', () => {
    renderWizard('one', ['busy'])
    const busy = screen.getByRole('button', { name: 'go busy' })
    busy.focus()
    fireEvent.click(busy)
    expect(document.activeElement).not.toBe(heading())
    fireEvent.click(screen.getByRole('button', { name: 'go two' }))
    expect(document.activeElement).toBe(heading())
  })

  it('treats leaving an INITIAL transient step as arrival (Merge opens on `loading`)', () => {
    renderWizard('loading', ['loading'])
    fireEvent.click(screen.getByRole('button', { name: 'go one' }))
    expect(document.activeElement).not.toBe(heading())
    // …and every change after that is a real one.
    fireEvent.click(screen.getByRole('button', { name: 'go two' }))
    expect(document.activeElement).toBe(heading())
  })

  it('moves focus again on a step reached a second time', () => {
    renderWizard('one')
    fireEvent.click(screen.getByRole('button', { name: 'go two' }))
    screen.getByRole('button', { name: 'go one' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'go one' }))
    expect(document.activeElement).toBe(heading())
  })
})
