/**
 * Draws a saved quantitative GROUP COMPARISON inside a canvas embed (#817).
 *
 * 🔴 **Before this, a comparison embed rendered a different figure.** The
 * canvas's quantitative branch only knew how to draw METRICS via
 * `quickCompute`, so a comparison material — whose config carries `column_ids`
 * like any other — computed a frequency distribution of its own variables and
 * `detectChartType` drew it as a heatmap. Measured on the GSS canvas: the
 * pooled distribution under the title *"Comparison · Trust scale A by degree"*,
 * with F = 690.88, the per-group n/M/SD, p, ω² and the whole Tukey block
 * absent, and nothing saying a substitution had happened.
 *
 * ⚠️ **This is a router, not a second implementation.** Every component here is
 * the one `CorrelationsComparisonsContent` mounts, with the same props — the
 * canvas is a second CONSUMER of those charts, and a private copy would drift
 * the way the two chord maps did (#824). The only thing this file decides is
 * which of the five to draw.
 *
 * ⚠️ **`ComparisonTestStrip` rides every chart except the table**, exactly as in
 * the analysis view: the table prints the test in its own columns, while a box
 * plot or a dumbbell is a picture of the groups with no statistic in it. That
 * asymmetry is deliberate — dropping the strip here would export a figure with
 * no test attached to it, which is the thing a canvas is for.
 */
import DumbbellChart from '@/components/charts/DumbbellChart'
import BoxPlotChart from '@/components/charts/BoxPlotChart'
import QQPlotChart from '@/components/charts/QQPlotChart'
import GroupedScalarBarChart from '@/components/charts/GroupedScalarBarChart'
import GroupComparisonTable from '@/components/charts/GroupComparisonTable'
import ComparisonTestStrip from '@/components/analysis/ComparisonTestStrip'
import {
  shapeComparisonDumbbell,
  shapeComparisonGroupedBars,
  type ChartFormatting,
} from '@/lib/chart-data'
import type { ComparisonChartType } from '@/lib/comparison-chart-types'
import type { GroupComparisonResponse } from '@/lib/api'

interface ComparisonChartRouterProps {
  data: GroupComparisonResponse
  chartType: ComparisonChartType
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
  nonparametric: boolean
  postHocExpanded: boolean
  formatting: ChartFormatting
}

export default function ComparisonChartRouter({
  data, chartType, sigLevels, nonparametric, postHocExpanded, formatting,
}: ComparisonChartRouterProps) {
  switch (chartType) {
    case 'comparison_dumbbell':
      return (
        <>
          <DumbbellChart
            data={shapeComparisonDumbbell(data.rows, data.groups)}
            showCI
            metricType="mean"
            formatting={formatting}
          />
          <ComparisonTestStrip rows={data.rows} sigLevels={sigLevels} nonparametric={nonparametric} />
        </>
      )

    case 'comparison_grouped_bar':
      return (
        <>
          <GroupedScalarBarChart
            sections={shapeComparisonGroupedBars(data.rows, data.groups)}
            groupValues={data.groups}
            showCI
            metricType="mean"
            formatting={formatting}
          />
          <ComparisonTestStrip rows={data.rows} sigLevels={sigLevels} nonparametric={nonparametric} />
        </>
      )

    // #522b — one panel per comparison ROW, not per group: a box plot is one
    // variable's distribution across groups, and normality is a property of the
    // model's residuals. Several selected variables draw several panels, which
    // is what the analysis view does.
    case 'comparison_box':
      return (
        <>
          {data.rows.map(row => (
            <div key={row.source_id} className="mb-4 last:mb-0">
              <BoxPlotChart groups={row.group_stats} formatting={formatting} valueLabel={row.full_label} />
              <ComparisonTestStrip rows={[row]} sigLevels={sigLevels} nonparametric={nonparametric} />
            </div>
          ))}
        </>
      )

    case 'comparison_qq':
      return (
        <>
          {data.rows.map(row => (
            <div key={row.source_id} className="mb-4 last:mb-0">
              <QQPlotChart qq={row.qq} formatting={formatting} valueLabel={row.full_label} />
              <ComparisonTestStrip rows={[row]} sigLevels={sigLevels} nonparametric={nonparametric} />
            </div>
          ))}
        </>
      )

    case 'comparison_table':
      return (
        <GroupComparisonTable
          groups={data.groups}
          rows={data.rows}
          sigLevels={sigLevels}
          nonparametric={nonparametric}
          // The canvas has no expand/collapse affordance to offer, so the post-hoc
          // block follows what the researcher saved rather than a fixed default.
          postHocExpanded={postHocExpanded}
        />
      )
  }
}
