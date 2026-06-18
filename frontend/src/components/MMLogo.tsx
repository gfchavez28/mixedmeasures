import { useTheme } from '@/lib/theme-context'

interface MMLogoProps {
  size?: number
  className?: string
  variant?: 'light' | 'dark' | 'auto'
}

export default function MMLogo({ size = 24, className, variant = 'auto' }: MMLogoProps) {
  const { isDark: themeDark } = useTheme()
  const isDark = variant === 'dark' || (variant === 'auto' && themeDark)

  const bubbleFill = isDark ? '#1e2e24' : '#e6f5ec'
  const bubbleStroke = isDark ? '#4ec88a' : '#2da562'
  const barFill = isDark ? '#f0a050' : '#e08a3a'

  // At 48px+ the fourth bar breaks through the bubble top.
  // Below 48px, all bars stay inside so nothing reads as a stray pixel.
  const useBreakthrough = size >= 48

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      className={className}
      aria-label="Mixed Measures logo"
      role="img"
    >
      <path
        d="M18 38 Q18 22 34 22 L86 22 Q102 22 102 38 L102 76 Q102 90 86 90 L70 90 Q64 90 60 108 Q56 90 50 90 L34 90 Q18 90 18 76 Z"
        fill={bubbleFill}
        stroke={bubbleStroke}
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <rect x="30" y="64" width="12" height="20" rx="1" fill={barFill} />
      <rect x="47" y="38" width="12" height="46" rx="1" fill={barFill} />
      <rect x="64" y="52" width="12" height="32" rx="1" fill={barFill} />
      <rect
        x="81"
        y={useBreakthrough ? 14 : 28}
        width="12"
        height={useBreakthrough ? 70 : 56}
        rx="1"
        fill={barFill}
      />
    </svg>
  )
}
