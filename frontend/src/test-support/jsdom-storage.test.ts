/**
 * #996 — `localStorage` inside the test environment is jsdom's working Storage.
 *
 * On Node 24 this passes with or without the setup file (nothing shadows it);
 * on Node 25 it fails without it, which is the version that produced 18 red
 * tests impersonating a product defect. It is the only test in the suite whose
 * SUBJECT is the environment, so a failure here says "the harness", not "the app".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'

afterEach(() => localStorage.clear())

describe('the test environment’s localStorage (#996)', () => {
  it('is a working Storage — every method the app calls exists', () => {
    expect(typeof localStorage.clear).toBe('function')
    localStorage.setItem('mm-996', 'x')
    expect(localStorage.getItem('mm-996')).toBe('x')
    expect(localStorage.length).toBe(1)
    localStorage.removeItem('mm-996')
    expect(localStorage.getItem('mm-996')).toBeNull()
  })

  it('is jsdom’s own object, the same one `window` sees', () => {
    const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window
    expect(jsdomWindow).toBeDefined()
    expect(localStorage).toBe(jsdomWindow!.localStorage)
    expect(window.localStorage).toBe(localStorage)
  })

  it('the setup file is registered, so the fix applies to EVERY test file', () => {
    // Setup that exists but is not wired is the #624 shape: fully built,
    // reached by nothing.
    const config = readFileSync(join(__dirname, '../../vite.config.ts'), 'utf8')
    expect(config).toMatch(/setupFiles:\s*\[[^\]]*'\.\/src\/test-support\/jsdom-storage\.ts'/)
  })
})
