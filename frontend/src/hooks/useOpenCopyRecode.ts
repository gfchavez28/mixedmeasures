/**
 * useOpenCopyRecode — shared opener for the Copy Recode dialog used by the
 * crosswalk's cell context menu (Phase 3b.7) and any future caller. The
 * hook fetches the source column's recode defs, picks the primary (or
 * first), and builds the CopyRecodeColumn payload the dialog needs.
 * The caller owns dialog open/close state via the `onOpen` callback —
 * this hook doesn't mount the dialog itself.
 */

import { useCallback } from 'react'
import { recodeApi, type ProjectColumnInfo } from '@/lib/api'
import type { CopyRecodeColumn } from '@/components/CopyRecodeDialog'

export interface CopyRecodeOpenArgs {
  sourceColumn: CopyRecodeColumn
  sourceDefId: number
  targetColumns: CopyRecodeColumn[]
}

interface UseOpenCopyRecodeOptions {
  projectId: number
  onOpen: (args: CopyRecodeOpenArgs) => void
}

function toCopyRecodeColumn(col: ProjectColumnInfo): CopyRecodeColumn {
  // ProjectColumnInfo doesn't carry scale_labels (those live on DatasetColumn
  // fetches). Use null for both scale fields that CopyRecodeDialog reads for
  // label compatibility — the dialog's compatibility logic will fall back to
  // scale_points/type checks, which is the same behavior when scale_labels
  // are simply unavailable.
  return {
    id: col.id,
    dataset_id: col.dataset_id,
    dataset_name: col.dataset_name,
    column_code: col.column_code,
    column_text: col.column_text,
    column_type: col.column_type,
    scale_labels: null,
    scale_points: col.scale_points ?? null,
    recode_definitions: [],
  }
}

export function useOpenCopyRecode({ projectId, onOpen }: UseOpenCopyRecodeOptions) {
  return useCallback(
    async (source: ProjectColumnInfo, targets: ProjectColumnInfo[]) => {
      try {
        const defs = await recodeApi.list(projectId, source.dataset_id, source.id)
        const primary = defs.find((d) => d.is_primary) || defs[0]
        if (!primary) return

        const sourceColumn: CopyRecodeColumn = {
          ...toCopyRecodeColumn(source),
          recode_definitions: defs.map((d) => ({
            id: d.id,
            name: d.name,
            recode_type: d.recode_type,
            is_primary: d.is_primary,
          })),
        }

        onOpen({
          sourceColumn,
          sourceDefId: primary.id,
          targetColumns: targets.map(toCopyRecodeColumn),
        })
      } catch (err) {
        console.error('[useOpenCopyRecode] Failed to load recode definitions', err)
      }
    },
    [projectId, onOpen],
  )
}
