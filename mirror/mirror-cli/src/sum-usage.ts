import {Analytics} from 'cloudflare-api/src/analytics.js';
import {
  connectionLifetimes,
  runningConnectionSeconds,
} from 'mirror-schema/src/datasets.js';
import {unreachable} from 'shared/src/asserts.js';
import * as v from 'shared/src/valita.js';
import {getProviderConfig} from './cf.js';
import type {CommonYargsArgv, YargvToInterface} from './yarg-types.js';

export function sumUsageOptions(yargs: CommonYargsArgv) {
  return yargs
    .option('period', {
      desc: 'Aggregation period',
      choices: ['month', 'week', 'day', 'hour'],
      default: 'month',
    })
    .option('end-time', {
      desc: 'End time of the aggregation period. Defaults to now()',
      type: 'string',
    });
}

type SumUsageHandlerArgs = YargvToInterface<ReturnType<typeof sumUsageOptions>>;

// https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
export async function sumUsageHandler(yargs: SumUsageHandlerArgs) {
  const {period, endTime} = yargs;
  const config = await getProviderConfig(yargs);
  const analytics = new Analytics(config);
  const endDate = endTime ? new Date(endTime) : new Date();
  const startDate = new Date(endDate.getTime());
  switch (period) {
    case 'month':
      startDate.setMonth(endDate.getMonth() - 1);
      break;
    case 'week':
      startDate.setDate(endDate.getDate() - 7);
      break;
    case 'day':
      startDate.setDate(endDate.getDate() - 1);
      break;
    case 'hour':
      startDate.setHours(endDate.getHours() - 1);
      break;
    default:
      unreachable();
  }

  const result1 = await analytics.query(
    runningConnectionSeconds
      .selectStarPlus({
        schema: v.object({
          adjustedPeriod: v.number(),
        }),
        expr: {
          adjustedPeriod: 'IF(period > elapsed, elapsed, period)',
        },
      })
      .where('timestamp', '>=', startDate)
      .and('timestamp', '<', endDate)
      .select({
        schema: v.object({
          teamID: v.string(),
          appID: v.string(),
          totalElapsed: v.number(),
          totalPeriod: v.number(),
        }),
        expr: {
          totalElapsed: 'SUM(elapsed)',
          totalPeriod: 'SUM(period)',
        },
      })
      .groupBy('teamID', 'appID')
      .orderBy('totalElapsed'),
  );

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  const result2 = await analytics.query(
    connectionLifetimes
      .selectStarPlus({
        schema: v.object({
          lifetimeMs: v.number(),
          afterMs: v.number(),
          beforeMs: v.number(),
        }),
        expr: {
          lifetimeMs: 'endTime - startTime',
          afterMs: `IF(endTime > ${endMs}, endTime - ${endMs}, 0.0)`,
          beforeMs: `IF(${startMs} > startTime, ${startMs} - startTime, 0.0)`,
        },
      })
      .where('startTime', '<', endMs)
      .and('endTime', '>', startMs)
      .select({
        schema: v.object({
          teamID: v.string(),
          appID: v.string(),
          totalConnections: v.string(), // COUNT() returns a string.  :P
          lifetimeSeconds: v.number(),
        }),
        expr: {
          totalConnections: 'COUNT()',
          lifetimeSeconds: 'SUM(lifetimeMs - afterMs - beforeMs) / 1000',
        },
      })
      .groupBy('teamID', 'appID')
      .orderBy('lifetimeSeconds'),
  );

  const combined = new Map();
  result1.data.forEach(result => combined.set(result.appID, result));
  result2.data.forEach(result => {
    const {appID} = result;
    const existing = combined.get(appID);
    if (existing) {
      combined.set(appID, {...existing, ...result});
    } else {
      combined.set(appID, result);
    }
  });

  console.log('Combined', combined);
}
