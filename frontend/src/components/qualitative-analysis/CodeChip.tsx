import { getCodeColor, getContrastColor } from '@/lib/utils'

interface CodeChipProps {
  code: { id: number; name: string; color: string | null; category_color?: string | null; category_name?: string | null }
  size?: 'sm' | 'xs'
  onClick?: (codeId: number) => void
}

export default function CodeChip({ code, size = 'sm', onClick }: CodeChipProps) {
  const bgColor = getCodeColor(code)
  const textColor = getContrastColor(bgColor)

  const sizeClasses = size === 'xs'
    ? 'text-[10px] px-1.5 py-0.5'
    : 'text-[11px] px-2 py-0.5'

  const Tag = onClick ? 'button' : 'span'

  return (
    <Tag
      className={`${sizeClasses} rounded-full inline-flex items-center gap-1 whitespace-nowrap leading-tight ${
        onClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''
      }`}
      style={{ backgroundColor: bgColor, color: textColor }}
      title={code.category_name ? `${code.name} (${code.category_name})` : code.name}
      onClick={onClick ? () => onClick(code.id) : undefined}
    >
      {code.name}
    </Tag>
  )
}
