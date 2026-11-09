/** ISO-8601 duration subset allowed by the case schema (PnDTnHnMnS) to milliseconds. */
export function durationMs(d: string): number {
  const m = /^P(?!$)(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) throw new Error(`bad ISO-8601 duration: ${d}`);
  const [, D, H, M, S] = m.map((x) => (x ? Number(x) : 0));
  return (((D * 24 + H) * 60 + M) * 60 + S) * 1000;
}
