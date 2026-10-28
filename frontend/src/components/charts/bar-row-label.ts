/**
 * A bar's label and click read the bar's own DATA ROW, never `data[index]` (#1314, #504).
 *
 * 🔴 **recharts' `index` does not number the chart's rows.** recharts 3.8.1 drops every
 * zero-size rectangle before it draws (`Bar.js` `computeBarRectangles` returns `null` for
 * `width === 0 || height === 0`, then `.filter(Boolean)`), and both the label renderer
 * (`LabelList.js`) and a Bar's `onClick` are numbered by what SURVIVED. After any empty
 * category, `data[index]` is the row ABOVE: the label prints its value and a click opens its
 * code, on every bar after the empty one, while the bar lengths, the tooltip and the
 * frequency table stay right. #504 fixed it in `QualBarChart` alone (2026-07-02); #1314 found
 * it in the three quantitative bar charts and two click drill-downs that never got that fix.
 * ⚠️ **A grouped stacked or diverging chart shifted with NO empty category**: the gap between
 * its groups is a separator row whose every segment is zero.
 *
 * ⚠️ **On a STACKED bar, the label's `value` is not the segment either** — it is the
 * cumulative END of the stack (a 20 segment sitting on 40 reads 60). Read the row.
 *
 * The mechanism is recharts' public API, not a mirror of its filter: a `LabelList` whose
 * `dataKey` is a FUNCTION is called with the row's payload, and what it returns arrives as
 * the label's `value`. Returning the row itself hands the renderer the true row for plain,
 * stacked and diverging bars alike. A click receives the drawn rectangle, whose `payload` is
 * the row (`barClickRow`).
 *
 * The consequence, accepted with the fix: a bar recharts did not draw gets no label from here,
 * because recharts draws no label for a bar it did not draw. (Before, an empty category's
 * "0.0%" appeared — on the next bar.) So an empty category or a real zero shows no number on
 * its bar, BY DECISION; printing one here would need `minPointSize`, which draws a bar that is
 * not there.
 *
 * ⚠️ **An UNDEFINED statistic is a different case, and it IS marked (#1363).** A scalar row
 * whose `value` is `null` draws no bar either, so nothing here can mark it: `HorizontalBarChart`
 * and `VerticalBarChart` mark it on the row's CATEGORY-AXIS tick instead (`—`, with the reason
 * in the tick's `<title>`, `data-undefined-statistic`), because recharts draws a tick for every
 * row whether or not it drew the bar. Never `?? 0` a `null` to get a label back — that is the
 * zero `statistics.md` §1 forbids.
 */
import type { ReactElement } from 'react'
import type { BarRectangleItem, LabelListProps, LabelProps } from 'recharts'

/** Where recharts drew the bar a label belongs to. `width` is negative for a bar left of zero. */
export interface BarLabelBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A `<Bar label={…}>` whose renderer receives the bar's own row and its drawn box. Pass
 * `false` instead of calling this to draw no labels.
 */
export function barRowLabel<Row>(render: (row: Row, box: BarLabelBox) => ReactElement | null): LabelListProps {
  return {
    dataKey: (row: Row) => row,
    content: (props: LabelProps) => {
      const { x, y, width, height, value } = props as unknown as BarLabelBox & { value: Row }
      return render(value, { x, y, width, height })
    },
  }
}

/** The row behind the bar a `<Bar onClick>` was called for. */
export function barClickRow<Row>(clicked: BarRectangleItem): Row | undefined {
  return clicked?.payload as Row | undefined
}
