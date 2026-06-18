/**
 * useCrosswalkDialogState — owns the open/close state for every Tier 3
 * crosswalk dialog. Pure state, no mutation calls; CrosswalkView's
 * dialog-confirm handlers stay where they are (they need direct access
 * to mutations, and the dialogs aren't memoized children, so the
 * direct-access pattern is correct — see the audit's mutation-access
 * decision).
 *
 * Centralizing the state cluster gets ~60 LOC of useState + handler
 * declarations out of CrosswalkView and gives every dialog one well-
 * named source of truth.
 *
 * Audit Batch C, P4 step 6.
 */

import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { BracketData } from './crosswalk-types'
import type { ColumnSwap } from '@/lib/api/equivalence'
import type { DomainMemberInput } from '@/lib/api'
import type { CopyRecodeOpenArgs } from '@/hooks/useOpenCopyRecode'

export interface CrosswalkDialogState {
  // Create domain
  createDialogOpen: boolean
  setCreateDialogOpen: Dispatch<SetStateAction<boolean>>
  /** Phase 3.5: column IDs to seed CreateDomainDialog with. Set when a
   * drag lands on the "+ New variable group" tile. */
  pendingCreateColumnIds: Set<number> | null
  setPendingCreateColumnIds: Dispatch<SetStateAction<Set<number> | null>>

  // Rename domain
  renameDialogDomain: BracketData | null
  setRenameDialogDomain: Dispatch<SetStateAction<BracketData | null>>

  // Delete domain confirm
  deleteDomainConfirm: { id: number; name: string } | null
  setDeleteDomainConfirm: Dispatch<SetStateAction<{ id: number; name: string } | null>>

  // Delete row confirm
  deleteRowConfirm: { groupId: number; label: string; cellCount: number } | null
  setDeleteRowConfirm: Dispatch<
    SetStateAction<{ groupId: number; label: string; cellCount: number } | null>
  >

  // Zero-member confirm
  zeroMemberConfirm: { domainId: number; domainName: string; members: DomainMemberInput[] } | null
  setZeroMemberConfirm: Dispatch<
    SetStateAction<{ domainId: number; domainName: string; members: DomainMemberInput[] } | null>
  >

  // Bulk-assign picker
  bulkAssignOpen: boolean
  setBulkAssignOpen: Dispatch<SetStateAction<boolean>>
  /** Path A #333: when "+ Add column" is clicked inside a specific bracket,
   * we pre-select that bracket. Null = no pre-selection. */
  bulkAssignPreselectedBracketId: number | null
  setBulkAssignPreselectedBracketId: Dispatch<SetStateAction<number | null>>
  /** Convenience: open the bulk-assign picker without pre-selecting any
   * bracket. Stable identity. */
  openBulkAssignWithoutPreselect: () => void

  // Swap error overlay
  swapErrorState: {
    originalPayload: ColumnSwap[]
    columnIds: number[]
    message: string
  } | null
  setSwapErrorState: Dispatch<
    SetStateAction<{
      originalPayload: ColumnSwap[]
      columnIds: number[]
      message: string
    } | null>
  >

  // Copy recode dialog
  copyRecodeState: CopyRecodeOpenArgs | null
  setCopyRecodeState: Dispatch<SetStateAction<CopyRecodeOpenArgs | null>>
}

export function useCrosswalkDialogState(): CrosswalkDialogState {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [pendingCreateColumnIds, setPendingCreateColumnIds] = useState<Set<number> | null>(null)

  const [renameDialogDomain, setRenameDialogDomain] = useState<BracketData | null>(null)

  const [deleteDomainConfirm, setDeleteDomainConfirm] = useState<{
    id: number
    name: string
  } | null>(null)

  const [deleteRowConfirm, setDeleteRowConfirm] = useState<{
    groupId: number
    label: string
    cellCount: number
  } | null>(null)

  const [zeroMemberConfirm, setZeroMemberConfirm] = useState<{
    domainId: number
    domainName: string
    members: DomainMemberInput[]
  } | null>(null)

  const [bulkAssignOpen, setBulkAssignOpen] = useState(false)
  const [bulkAssignPreselectedBracketId, setBulkAssignPreselectedBracketId] = useState<
    number | null
  >(null)
  const openBulkAssignWithoutPreselect = useCallback(() => {
    setBulkAssignPreselectedBracketId(null)
    setBulkAssignOpen(true)
  }, [])

  const [swapErrorState, setSwapErrorState] = useState<{
    originalPayload: ColumnSwap[]
    columnIds: number[]
    message: string
  } | null>(null)

  const [copyRecodeState, setCopyRecodeState] = useState<CopyRecodeOpenArgs | null>(null)

  return {
    createDialogOpen,
    setCreateDialogOpen,
    pendingCreateColumnIds,
    setPendingCreateColumnIds,
    renameDialogDomain,
    setRenameDialogDomain,
    deleteDomainConfirm,
    setDeleteDomainConfirm,
    deleteRowConfirm,
    setDeleteRowConfirm,
    zeroMemberConfirm,
    setZeroMemberConfirm,
    bulkAssignOpen,
    setBulkAssignOpen,
    bulkAssignPreselectedBracketId,
    setBulkAssignPreselectedBracketId,
    openBulkAssignWithoutPreselect,
    swapErrorState,
    setSwapErrorState,
    copyRecodeState,
    setCopyRecodeState,
  }
}
