/**
 * Dropping a file on the "wrong" list should route it, not swallow it.
 *
 * Before Observations, a recording dropped on the Conversations list matched no
 * filter and the handler simply `return`ed — the person holding a video and no
 * transcript, i.e. exactly the person the Observations track was built for, got
 * nothing at all. Silence is the #552 failure in a new costume.
 */
import { describe, it, expect } from 'vitest'
import { routeDroppedFiles } from './import-routing'

const f = (name: string) => new File(['x'], name)

describe('routeDroppedFiles', () => {
  it('a transcript dropped on Conversations stays a Conversation', () => {
    expect(routeDroppedFiles([f('interview.csv')], 'conversation'))
      .toEqual({ kind: 'conversation', files: [expect.any(File)] })
    expect(routeDroppedFiles([f('zoom.vtt')], 'conversation').kind).toBe('conversation')
  })

  it('a RECORDING dropped on Conversations routes to an Observation', () => {
    // The rescue. This used to be a silent no-op.
    const route = routeDroppedFiles([f('session.mp4')], 'conversation')
    expect(route.kind).toBe('observation')
  })

  it('a TRANSCRIPT dropped on Observations routes to a Conversation', () => {
    const route = routeDroppedFiles([f('zoom.vtt')], 'observation')
    expect(route.kind).toBe('conversation')
  })

  it('a recording dropped on Observations stays an Observation', () => {
    expect(routeDroppedFiles([f('session.mov')], 'observation').kind).toBe('observation')
  })

  it('only ever takes ONE recording — an Observation IS its recording', () => {
    const route = routeDroppedFiles([f('a.mp4'), f('b.mp4')], 'observation')
    expect(route.kind).toBe('observation')
    expect(route.kind === 'observation' && route.files).toHaveLength(1)
  })

  it('honours the destination when the file fits it, even if it also fits elsewhere', () => {
    // A .csv is a transcript here and a dataset elsewhere — destination breaks the tie.
    expect(routeDroppedFiles([f('rows.csv')], 'conversation').kind).toBe('conversation')
  })

  it('a document dropped anywhere routes to Documents', () => {
    expect(routeDroppedFiles([f('report.pdf')], 'conversation').kind).toBe('document')
    expect(routeDroppedFiles([f('notes.docx')], 'observation').kind).toBe('document')
  })

  it('an unroutable file is honestly nothing, not a wrong guess', () => {
    expect(routeDroppedFiles([f('archive.zip')], 'conversation')).toEqual({ kind: 'none' })
    expect(routeDroppedFiles([], 'observation')).toEqual({ kind: 'none' })
  })
})
