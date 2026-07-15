import type { Leg, Plan, Rig } from '../types';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtDeg = (d: number) => `${String(Math.round(d)).padStart(3, '0')}°T`;

function legDesc(leg: Leg): string {
  const man = leg.maneuverAtStart ? `${leg.maneuverAtStart} → ` : '';
  const what =
    leg.kind === 'motor'
      ? `motor ${fmtDeg(leg.headingDeg)} ${leg.speedKn.toFixed(1)} kn`
      : `sail ${leg.board} ${fmtDeg(leg.headingDeg)} ${leg.speedKn.toFixed(1)} kn`;
  return man + what;
}

export function toGpx(plan: Plan, rig: Rig): string {
  const result = rig === 'genoa' ? plan.result.genoa : plan.result.fock;
  if (!result) throw new Error(`no ${rig} result on plan ${plan.id}`);
  if (result.legs.length === 0) throw new Error(`empty route on plan ${plan.id} (${rig})`);
  const pts = result.legs.map(
    (leg) =>
      `    <rtept lat="${leg.start.lat}" lon="${leg.start.lon}">\n` +
      `      <time>${new Date(leg.startTimeMs).toISOString()}</time>\n` +
      `      <desc>${esc(legDesc(leg))}</desc>\n` +
      `    </rtept>`,
  );
  const last = result.legs[result.legs.length - 1];
  pts.push(
    `    <rtept lat="${last.end.lat}" lon="${last.end.lon}">\n` +
      `      <time>${new Date(last.endTimeMs).toISOString()}</time>\n` +
      `      <desc>destination</desc>\n` +
      `    </rtept>`,
  );
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="SailCommand" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <rte>\n    <name>${esc(plan.name)} (${rig})</name>\n${pts.join('\n')}\n  </rte>\n</gpx>\n`
  );
}
