import * as v from 'shared/valita.js';

export const pointSchema = v.tuple([v.number(), v.array(v.number())]);
export type Point = v.Infer<typeof pointSchema>;

export const seriesSchema = v.object({
  metric: v.string(),
  points: v.array(pointSchema),
});
export type Series = v.Infer<typeof seriesSchema>;

export const reportMetricsSchema = v.object({
  series: v.array(seriesSchema),
});
export type ReportMetrics = v.Infer<typeof reportMetricsSchema>;
