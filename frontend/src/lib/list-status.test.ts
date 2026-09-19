/**
 * #961 — `listStatus` is the ONE answer to "may this surface say anything about
 * the list yet?". These pin the three answers and the two ways to get them
 * wrong: deciding on the ARRAY (an empty answer and no answer look the same)
 * and deciding on `isError` (a failed REFETCH still has a real answer in hand).
 */
import { describe, it, expect } from 'vitest'
import { combineListStatus, listStatus } from './list-status'

describe('listStatus', () => {
  it('no answer and no error is loading', () => {
    expect(listStatus({ data: undefined, isError: false })).toBe('loading')
  })

  it('no answer and an error is failed', () => {
    expect(listStatus({ data: undefined, isError: true })).toBe('failed')
  })

  it('an EMPTY answer is ready — emptiness is a fact once the server has said so', () => {
    expect(listStatus({ data: { codes: [] }, isError: false })).toBe('ready')
    expect(listStatus({ data: [], isError: false })).toBe('ready')
  })

  it('a failed REFETCH over an answer already in hand stays ready', () => {
    // React Query keeps the last data and reports isError; swapping a real,
    // possibly-stale list for a failure notice would hide the researcher's work.
    expect(listStatus({ data: { codes: [{ id: 1 }] }, isError: true })).toBe('ready')
  })

  it('falsy answers are answers — the check is `!== undefined`, never truthiness', () => {
    expect(listStatus({ data: 0, isError: false })).toBe('ready')
    expect(listStatus({ data: '', isError: false })).toBe('ready')
  })
})

describe('combineListStatus', () => {
  it('is ready only when every list is', () => {
    expect(combineListStatus(['ready', 'ready'])).toBe('ready')
    expect(combineListStatus(['ready', 'loading'])).toBe('loading')
  })

  it('a failure outranks a wait — the claim cannot be made by waiting', () => {
    expect(combineListStatus(['loading', 'failed'])).toBe('failed')
    expect(combineListStatus(['failed', 'ready', 'loading'])).toBe('failed')
  })

  it('no lists at all is ready (nothing to wait for)', () => {
    expect(combineListStatus([])).toBe('ready')
  })
})
