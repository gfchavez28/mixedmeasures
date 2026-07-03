import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface Props {
  open: boolean
  onProceed: () => void
  onCancel: () => void
}

/**
 * Track J · J3-1: shown when a researcher adds/removes/renames a code while the
 * codebook is frozen. Soft lock — "Proceed anyway" is allowed; the warning just
 * surfaces that the change will require reconciliation if copies were distributed.
 */
export default function CodebookFrozenWarningDialog({ open, onProceed, onCancel }: Props) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Your codebook is frozen</AlertDialogTitle>
          <AlertDialogDescription>
            Adding, removing, or renaming codes will change the frozen codebook. If
            you've distributed copies to co-coders, a changed codebook will require
            reconciliation when you merge their work. To stop seeing this, unfreeze the
            codebook first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onProceed}>Proceed anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
