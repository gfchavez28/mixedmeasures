/**
 * `Add ▾` — the two axes of a dataset, in one control. Shared by BOTH tabs of
 * the dataset workspace (Decision F, then #830f 2026-08-31).
 *
 * ## Why it is a component rather than JSX in each page
 *
 * Decision F built this menu in `DatasetView`, and the Variables view got
 * nothing — so the researcher whom `PickRuleToDeriveDialog`'s empty state sends
 * to the Variables view ("rules are written there") arrived at a screen that
 * could not start the flow it had just described (#830f).
 *
 * Copying the menu would put four items, two group headings and their
 * `aria-labelledby` wiring in two files. That wiring is exactly what Decision F
 * had to add deliberately — Radix's `Group` renders `role="group"` but does NOT
 * associate a sibling `Label`, so without it a reader hears one flat list — and
 * a second copy is how one of the two loses it.
 *
 * ## Why the Records group travels too
 *
 * Appending records is not "a Data view thing": the two views are two tabs of
 * ONE workspace under one nav strip. The codebase already made this exact call
 * in the other direction — Variable Groups left BOTH toolbars together, on the
 * reasoning that removing it from one and leaving it on the other "would make
 * two tabs of one workspace disagree about what belongs to a dataset".
 *
 * ## The width constraint this control exists to respect
 *
 * ⚠️ **Decision F was an ACCESSIBILITY fix.** The pre-F Data toolbar measured
 * 879px inside a 640px container whose ancestor is `overflow-hidden`, so its
 * last buttons were CLIPPED — unreachable at 200% zoom (WCAG 1.4.4). Adding a
 * fourth ITEM to this menu costs the toolbar nothing; adding a fifth BUTTON
 * beside it does. jsdom computes no layout, so no unit test can see it — measure
 * at 640×360 before putting anything else in either row.
 */
import { ChevronDown, CornerDownRight, FileInput, FunctionSquare, Plus } from 'lucide-react'
import { MODE_DISABLED_CLASS, modeDisabledProps } from '@/lib/mode-disabled'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  /** Opens the "Variable" form. */
  onAddVariable: () => void
  /** Opens the "Computed variable" form. */
  onAddComputed: () => void
  /** Opens `PickRuleToDeriveDialog` — the third kind needs an existing rule. */
  onAddRecoded: () => void
  /** Navigates to the append-from-file wizard. */
  onAppendRecords: () => void
  /** Adds ONE empty record to this dataset (queue row 47). A menu ITEM and not
   *  a toolbar button on purpose: the row is budgeted at five buttons and
   *  measured at 625px inside a 625px container at 640×360, so a sixth would
   *  clip (WCAG 1.4.4) while a fourth item costs the row nothing. */
  onAddRecord: () => void
  /** Row 47 — the sentence refusing a hand-added record on a tool-maintained
   *  table, or null on an ordinary one. The participant table's rows are its
   *  participants, so the server 409s this (`ACTION_ADD_ROW`). */
  addRecordRefusal?: string | null
  /** Row 45 (i) — the sentence refusing an append on a tool-maintained table,
   *  or null on an ordinary one. The server 409s both append endpoints there
   *  (its records come from `Participant`), so an ungated item is a control the
   *  request declines — the #806/#807/#812 shape. Threaded rather than derived:
   *  the ONE predicate lives in `lib/managed-dataset.ts`. */
  appendRefusal?: string | null
}

export default function AddVariableMenu({
  onAddVariable, onAddComputed, onAddRecoded, onAppendRecords, appendRefusal,
  onAddRecord, addRecordRefusal,
}: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="text-sm">
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
          Add
          <ChevronDown className="w-3.5 h-3.5 ml-1" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* ⚠️ The group headings carry the meaning of this control, so they are
            ASSOCIATED and not merely rendered — see the header comment. */}
        <DropdownMenuGroup aria-labelledby="add-menu-variables">
          <DropdownMenuLabel id="add-menu-variables" className="text-xs font-medium">
            Variables
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={onAddVariable}>
            <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
            Variable
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddComputed}>
            {/* Violet matches the `FunctionSquare` marking a computed column in
                the grid — the one tint here that carries information (§10.4). */}
            <FunctionSquare
              className="w-4 h-4 mr-2 text-violet-600 dark:text-violet-400"
              aria-hidden="true"
            />
            Computed variable
          </DropdownMenuItem>
          {/* The THIRD kind (Decision B Stage 3, design note §11). jamovi's
              `Add` offers Data / Computed / Transformed in one menu; MM had
              built the third kind and listed only two, so a researcher looking
              where jamovi taught them to look found nothing.

              ⚠️ Inside the EXISTING Variables group on purpose — a new group
              would need its own `aria-labelledby` and would split a set of
              three that belongs together. */}
          <DropdownMenuItem onSelect={onAddRecoded}>
            <CornerDownRight className="w-4 h-4 mr-2" aria-hidden="true" />
            Recoded variable...
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup aria-labelledby="add-menu-records">
          <DropdownMenuLabel id="add-menu-records" className="text-xs font-medium">
            Records
          </DropdownMenuLabel>
          {/* 🔴 THESE ITEMS ARE ACTIVATED BY `onClick` ALONE — never also by
              `onSelect`, and that is a bug fix rather than a style choice.
              `modeDisabledProps` RETURNS an `onClick` (its click guard is the
              load-bearing half of #754), so wiring `onSelect` to the same
              callback fires the action TWICE per activation — Radix dispatches
              a click for keyboard activation too, so both routes double.

              It shipped that way on `Append from file` and nobody could see it:
              navigating twice to the same route is idempotent. Adding a record
              is not, and one click created TWO records — found by driving, not
              by any test. Radix still closes the menu on its own; `onSelect` is
              a notification hook, not the thing that closes it. */}
          {/* Row 47 — the RECORDS axis gained its hand-authored half. A manual
              COLUMN could already be added by hand while a record could only
              arrive from a file; the asymmetry was the tell, and it sat inside
              this very menu, one group apart.

              ⚠️ FIRST in the group, before the file import: adding one record
              is the smaller, more common act, and it is the one a researcher
              building a ten-row lookup table by hand needs. */}
          <DropdownMenuItem
            {...modeDisabledProps<HTMLDivElement>({
              label: 'Add record',
              blockedReason: addRecordRefusal ?? null,
              onActivate: onAddRecord,
            })}
            title={addRecordRefusal ?? undefined}
            className={MODE_DISABLED_CLASS}
          >
            <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
            Add record
          </DropdownMenuItem>
          {/* "Append Data" said nothing — "Data" is the whole table. The
              operation adds ROWS, and it does it from a file (§10.5). */}
          <DropdownMenuItem
            {...modeDisabledProps<HTMLDivElement>({
              label: 'Append from file',
              blockedReason: appendRefusal ?? null,
              onActivate: onAppendRecords,
            })}
            title={appendRefusal ?? undefined}
            className={MODE_DISABLED_CLASS}
          >
            <FileInput className="w-4 h-4 mr-2" aria-hidden="true" />
            Append from file...
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
