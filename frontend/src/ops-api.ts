import { apiRequest } from './api';

export interface OpsPoint { at: string; used: number; total: number }
export interface OpsSeries { hostId: string; hostName: string; points: OpsPoint[] }
export interface OpsSummary {
  generatedAt: string;
  utilization24h: { bucketMinutes: number; series: OpsSeries[] };
  utilization14d: { bucketMinutes: number; series: OpsSeries[] };
  sessionsPerDay: Array<{ day: string; count: number }>;
  duration: { count: number; avgSeconds: number | null; p90Seconds: number | null };
  startsByHourUtc: number[];
  peakHourUtc: number | null;
  topUsers: Array<{ username: string; sessions: number; minutes: number }>;
  failures: { last24h: number; last14d: number };
  sampleCount: number;
}

export const opsApi = {
  summary: (): Promise<OpsSummary> => apiRequest<OpsSummary>('/admin/ops/summary'),
};
