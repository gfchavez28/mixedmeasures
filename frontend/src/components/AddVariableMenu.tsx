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
}

export default function AddVariableMenu({
  onAddVariable, onAddComputed, onAddRecoded, onAppendRecords,
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
          {/* "Append Data" said nothing — "Data" is the whole table. The
              operation adds ROWS, and it does it from a file (§10.5). */}
          <DropdownMenuItem onSelect={onAppendRecords}>
            <FileInput className="w-4 h-4 mr-2" aria-hidden="true" />
            Append from file...
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
