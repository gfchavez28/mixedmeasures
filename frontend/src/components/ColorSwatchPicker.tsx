// Shared color palette and picker for categories and domains
import { CATEGORY_COLORS } from '@/lib/chart-data'
export { CATEGORY_COLORS }

export function ColorSwatchPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CATEGORY_COLORS.map(color => (
        <button
          key={color}
          type="button"
          aria-label={`Color ${color}`}
          aria-pressed={value === color}
          className={`w-7 h-7 rounded-md border-2 transition-all ${
            value === color ? 'border-mm-text scale-110 shadow-xs' : 'border-transparent hover:border-mm-border-medium'
          }`}
          style={{ backgroundColor: color }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  )
}
