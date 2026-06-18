# Mixed Measures — Logo & Brand Spec

## The Mark

The Mixed Measures logo is a **bar chart nested inside a speech bubble**, rendered in green (qualitative) and orange (quantitative). The speech bubble is the icon itself — no background rectangle. A **5px green stroke** defines the bubble shape clearly at all sizes, and a deep centered notch signals "speech/response" without looking like a chat app.

The four bars trace an asymmetric **M shape** — a subtle discovery for viewers who look closely.

### Two-Tier Rendering

The mark has two variants selected automatically by rendered size:

- **Full variant (48px and above):** The fourth bar (tallest peak) **breaks through the top of the speech bubble**, signaling that the tool handles more than its container suggests and that qualitative and quantitative data intersect rather than staying siloed.
- **Small variant (below 48px, including favicon):** All four bars are contained inside the bubble. The breakthrough concept doesn't survive sub-pixel rendering, so at small sizes it is omitted in favor of a clean, legible mark.

### Design Principles

- **First read:** "Bar chart inside a speech bubble" → mixed methods
- **Second read:** "The bar heights trace an M" → Mixed Measures
- **The breakthrough bar (full variant only):** Data exceeds the container — the tool integrates rather than separates
- **Squared bar caps** contrast with the rounded bubble → precision meets warmth
- **Deep centered notch** (drops to y=108) → reads as speech bubble even at small sizes
- **5px green stroke** → survives at favicon size, defines the shape without needing a background frame
- **No background rectangle** → the bubble silhouette is the icon, keeping the mark light and cohesive in any UI context

---

## Color Spec

| Role | Light Mode | Dark Mode |
|------|-----------|-----------|
| Bubble fill | `#e6f5ec` | `#1e2e24` |
| Bubble stroke (green) | `#2da562` | `#4ec88a` |
| Bar fill (orange) | `#e08a3a` | `#f0a050` |
| Wordmark "M" (Mixed) | `#2da562` | `#4ec88a` |
| Wordmark "ixed" | `#1a1f2b` | `#e8e8e6` |
| Wordmark "M" (Measures) | `#e08a3a` | `#f0a050` |
| Wordmark "easures" | `#5a5f6b` | `#9a9a96` |

---

## Typography

**Wordmark font:** Plus Jakarta Sans (Google Fonts)
- "Mixed" — weight 600 (SemiBold)
- "Measures" — weight 400 (Regular)
- Letter spacing: 0.02em
- Stacked layout (Mixed above Measures)

---

## Files Included

### SVG (vector, scalable)
- `mm-mark-light.svg` — Full mark, light mode
- `mm-mark-dark.svg` — Full mark, dark mode
- `mm-mark-transparent.svg` — Mark for overlays (same as light; included for naming consistency)
- `mm-favicon.svg` — Small variant for 16px use (bars contained inside bubble)
- `mm-lockup-light.svg` — Mark + wordmark, light mode
- `mm-lockup-dark.svg` — Mark + wordmark, dark mode

### Code
- `MMLogo.tsx` — Drop-in React component (replaces existing `MMLogo.tsx` in `frontend/src/components/`)
  - Supports `size`, `className`, and `variant` ('light' | 'dark' | 'auto') props
  - Auto-detects dark mode via `.dark` class on `<html>`
  - Automatically switches between full variant (≥48px) and small variant (<48px)

---

## Geometry Reference

### Speech Bubble Path
```
M18 38 Q18 22 34 22 L86 22 Q102 22 102 38 L102 76 Q102 90 86 90 L70 90 Q64 90 60 108 Q56 90 50 90 L34 90 Q18 90 18 76 Z
```
- Bubble body: x=18 to x=102, y=22 to y=90 (with rounded corners r≈16)
- Notch: centered at x=60, drops to y=108
- Stroke: 5px, round linejoin

### Bar Positions (in 120×120 viewBox)

| Bar | x | y (full) | y (small) | width | height (full) | height (small) |
|-----|---|----------|-----------|-------|---------------|----------------|
| 1 | 30 | 64 | 64 | 12 | 20 | 20 |
| 2 | 47 | 38 | 38 | 12 | 46 | 46 |
| 3 | 64 | 52 | 52 | 12 | 32 | 32 |
| 4 | 81 | 14 | 28 | 12 | 70 | 56 |

All bars bottom-align at y=84 (inside the bubble body). In the full variant, bar 4 extends above the bubble top edge (y=22) to y=14.

---

## Usage Guidelines

### Size thresholds
- **Below 48px:** Use small variant (bars contained). The `MMLogo.tsx` component handles this automatically.
- **48px and above:** Use full variant (breakthrough bar).
- **Below 16px:** Not recommended. Use text-only wordmark if needed.

### Clear space
Leave at least 25% of the mark's width as padding on all sides.

### Backgrounds
- On light backgrounds: use light-mode mark. The green stroke provides definition.
- On dark backgrounds: use dark-mode mark. The bubble fill and bright stroke provide contrast.
- On photos or complex backgrounds: ensure sufficient contrast with the bubble stroke.

### Lockup
- Wordmark always appears to the right of the mark, vertically centered
- "Mixed" and "Measures" are stacked (not on one line)
- The green M and orange M in the wordmark echo the mark's color split

### What not to do
- Don't rotate the mark
- Don't change the bar proportions or reorder bars
- Don't use the bubble without bars or bars without the bubble
- Don't add drop shadows or effects
- Don't add a background rectangle behind the bubble (the bubble silhouette is the icon)
- Don't use the breakthrough bar variant below 48px
