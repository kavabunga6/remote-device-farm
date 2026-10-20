export function trafficHar(raw: Record<string, unknown>, notes?: { tunnel?: string; unmeasured?: string }): {
  log: { version: string; creator: { name: string; version: string }; entries: any[] };
};
