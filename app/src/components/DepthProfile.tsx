import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useLang, useT } from '../i18n';
import { activeRigResult } from '../lib/plan';
import { formatKn, formatTime } from '../lib/format';
import { NavMask } from '../lib/mask';
import { WindField } from '../lib/wind';
import { barbSegments } from '../lib/windBarbs';
import {
  indicatorTimes,
  legPositionAt,
  profileSamples,
  sampleCount,
  tickTimes,
  type ProfileSample,
} from '../lib/routeProfile';
import { loadRoutingAssets } from '../services/assets';
import type { Leg, Plan, Rig } from '../types';
import Card from './Card';

export interface DepthProfileProps {
  plan: Plan;
  rig: Rig;
  safetyDepthM: number;
}

// One orange for "shallow / critical" across the raster depth overlay and this
// chart (depthColor.ts's 2.0 m "around draft" stop). NOT #D55E00 — that hex is
// the port-tack line color.
const SAFETY_COLOR = '#E69F00';
// Same grey as the map's motor line (RouteLayer sc-route-motor) and legend.
const MOTOR_COLOR = '#5b5b5b';

// Fallback SVG box when the container can't be measured (jsdom / pre-layout).
const FALLBACK_W = 320;
const FALLBACK_H = 160;

// px layout inside the SVG box.
const STRIP_H = 40; // wind + heading indicator strip above the plot
const AXIS_H = 16; // X-axis tick labels below the plot
const MARGIN_L = 40; // Y-axis labels + rotated axis title
const MARGIN_R = 6;
const WIND_ROW_Y = 12;
const HEAD_ROW_Y = 30;
const BARB_SCALE = 0.55;
const BARB_BOX = 32; // native barb glyph box (windBarbs.ts)

const WIDE_QUERY = '(min-width: 1024px)';

function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: FALLBACK_W, height: FALLBACK_H });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      // Keep the last good size while collapsed (contentRect is 0 then).
      if (cr && cr.width > 0 && cr.height > 0) setSize({ width: cr.width, height: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Contiguous [firstIndex, lastIndex] runs of samples matching `pred`. */
function runs(samples: ProfileSample[], pred: (s: ProfileSample) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < samples.length; i++) {
    if (pred(samples[i])) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, samples.length - 1]);
  return out;
}

function BarbGlyph({
  speedKn,
  dirFromDeg,
  x,
  y,
}: {
  speedKn: number;
  dirFromDeg: number;
  x: number;
  y: number;
}) {
  const c = BARB_BOX / 2;
  return (
    <g
      className="dp-barb"
      transform={`translate(${x.toFixed(1)}, ${y.toFixed(1)}) scale(${BARB_SCALE}) rotate(${dirFromDeg.toFixed(1)}) translate(${-c}, ${-c})`}
    >
      {barbSegments(speedKn).map((seg, i) => {
        if (seg.kind === 'circle') {
          return (
            <circle
              key={i}
              cx={seg.cx}
              cy={seg.cy}
              r={seg.r}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
            />
          );
        }
        const pts = seg.points.map((p) => `${p.x},${p.y}`).join(' ');
        return seg.kind === 'fill' ? (
          <polygon key={i} points={pts} fill="currentColor" />
        ) : (
          <polyline
            key={i}
            points={pts}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </g>
  );
}

function HeadingArrow({ headingDeg, x, y }: { headingDeg: number; x: number; y: number }) {
  // Arrow points "up" (north) in local coords; rotate by the course over ground.
  return (
    <g
      className="dp-heading"
      transform={`translate(${x.toFixed(1)}, ${y.toFixed(1)}) rotate(${headingDeg.toFixed(1)})`}
    >
      <path
        d="M0,6 L0,-6 M0,-6 L-3,-2 M0,-6 L3,-2"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

export default function DepthProfile({ plan, rig, safetyDepthM }: DepthProfileProps) {
  const t = useT();
  const [lang] = useLang();
  const uid = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const { width: W, height: H } = useElementSize(plotRef);

  // Wide viewports open the profile by default; narrow keeps the map primary.
  // Read once at mount (matchMedia), then follow the user's own toggling.
  const [open, setOpen] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(WIDE_QUERY).matches,
  );

  // The mask is a read-only Uint8Array VIEW over the module-cached buffer —
  // never a copy, never transferred, never mutated (buffer ownership rules
  // stay with the routing path).
  const [mask, setMask] = useState<NavMask | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadRoutingAssets()
      .then((assets) => {
        if (!cancelled) setMask(new NavMask(assets.maskMeta, new Uint8Array(assets.maskBuffer)));
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  const result = activeRigResult(plan, rig);
  // Memoized so the empty-route fallback isn't a fresh array each render
  // (keeps the samples/windField memos stable).
  const legs: Leg[] = useMemo(() => result?.legs ?? [], [result]);
  const startMs = legs.length ? legs[0].startTimeMs : 0;
  const endMs = legs.length ? legs[legs.length - 1].endTimeMs : 0;
  const durationMs = endMs - startMs;

  const samples = useMemo(
    () => (mask && legs.length ? profileSamples(legs, mask, sampleCount(durationMs)) : []),
    [mask, legs, durationMs],
  );
  // WindField wraps the stored grid only (never re-fetched); it does not
  // depend on the legs. Constructed unconditionally — the empty-route early
  // return below means the unused instance is thrown away harmlessly.
  const windField = useMemo(() => new WindField(plan.windGrid), [plan.windGrid]);

  if (!result || legs.length === 0) return null;

  // The shallowest sample drives the summary glance value. If even the
  // shallowest point is deep-capped, the whole route is >= 25 m — show the
  // honest cap label, never the fake 25.4 sentinel number (design rule).
  const minSample = samples.length ? samples.reduce((m, s) => (s.depthM < m.depthM ? s : m)) : null;
  // The <summary> carries ONLY the min-depth glance — the Card <h2> is the
  // single section title, so the label is not rendered (or announced) twice.
  const summaryValue =
    minSample === null
      ? ''
      : `${t('profile.minDepth')} ${minSample.capped ? t('profile.deepCap') : `${minSample.depthM.toFixed(1)} m`}`;

  // #64 phase 3: the profile gets the card treatment for visual consistency
  // with the Ergebnis card. The inner <details> keeps its own collapse + SVG
  // behavior (the summary carries the min-depth glance); CSS drops the inner
  // border so the two read as one surface.
  return (
    <Card title={t('profile.title')} className="depth-profile-card">
      <details
        className="depth-profile"
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="depth-profile-summary">{summaryValue}</summary>
        <div className="depth-profile-plot" ref={plotRef}>
          {samples.length > 0 && (
            <ProfileChart
              W={W}
              H={H}
              uid={uid}
              lang={lang}
              t={t}
              legs={legs}
              samples={samples}
              windField={windField}
              startMs={startMs}
              endMs={endMs}
              safetyDepthM={safetyDepthM}
            />
          )}
        </div>
      </details>
    </Card>
  );
}

function ProfileChart({
  W,
  H,
  uid,
  lang,
  t,
  legs,
  samples,
  windField,
  startMs,
  endMs,
  safetyDepthM,
}: {
  W: number;
  H: number;
  uid: string;
  lang: ReturnType<typeof useLang>[0];
  t: ReturnType<typeof useT>;
  legs: Leg[];
  samples: ProfileSample[];
  windField: WindField;
  startMs: number;
  endMs: number;
  safetyDepthM: number;
}) {
  const x0 = MARGIN_L;
  const x1 = W - MARGIN_R;
  const y0 = STRIP_H;
  const y1 = H - AXIS_H;
  const plotW = Math.max(1, x1 - x0);
  const plotH = Math.max(1, y1 - y0);
  const spanMs = Math.max(1, endMs - startMs);

  const capped = samples.some((s) => s.capped);
  const maxDepth = samples.reduce((m, s) => Math.max(m, s.depthM), 0);
  // Axis range 0..min(maxSample+2, 25); a small floor keeps very shallow
  // routes from being over-zoomed. The safety depth is deliberately NOT part
  // of this — so changing it moves only the overlay, never the samples/scale.
  const axisMax = Math.max(4, Math.min(maxDepth + 2, 25));

  const xOf = (tMs: number) => x0 + ((tMs - startMs) / spanMs) * plotW;
  const yOf = (depthM: number) => y0 + (Math.min(depthM, axisMax) / axisMax) * plotH;

  const capHatch = `dp-cap-${uid}`;
  const motorHatch = `dp-motor-${uid}`;

  // Half a sample step, to give one-sample runs a visible width.
  const halfStep = samples.length > 1 ? spanMs / (samples.length - 1) / 2 : spanMs / 2;
  const spanX = (i: number, j: number): { x: number; w: number } => {
    const a = Math.max(startMs, samples[i].tMs - halfStep);
    const b = Math.min(endMs, samples[j].tMs + halfStep);
    return { x: xOf(a), w: Math.max(1, xOf(b) - xOf(a)) };
  };

  const pts = samples.map((s) => ({ x: xOf(s.tMs), y: yOf(s.depthM) }));
  const lineD = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${y1.toFixed(1)} L${pts[0].x.toFixed(1)},${y1.toFixed(1)} Z`;

  const gridStep = axisMax <= 6 ? 2 : 5;
  const gridDepths: number[] = [];
  for (let d = 0; d <= axisMax + 1e-6; d += gridStep) gridDepths.push(d);

  const ticks = tickTimes(startMs, endMs);
  const indicators = indicatorTimes(startMs, endMs);
  const safetyY = yOf(safetyDepthM);

  return (
    <svg
      className="depth-profile-svg"
      width="100%"
      height="100%"
      viewBox={`0 0 ${W.toFixed(0)} ${H.toFixed(0)}`}
      role="img"
      aria-label={t('profile.title')}
    >
      <defs>
        <pattern
          id={capHatch}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1" opacity="0.4" />
        </pattern>
        <pattern
          id={motorHatch}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" stroke={MOTOR_COLOR} strokeWidth="1.5" />
        </pattern>
      </defs>

      {/* Depth gridlines + Y labels */}
      {gridDepths.map((d) => (
        <g key={`g${d}`}>
          <line
            x1={x0}
            y1={yOf(d).toFixed(1)}
            x2={x1}
            y2={yOf(d).toFixed(1)}
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.12"
          />
          <text
            className="dp-ylabel"
            x={x0 - 4}
            y={yOf(d) + 3}
            textAnchor="end"
            fontSize="9"
            fill="currentColor"
          >
            {capped && Math.abs(d - axisMax) < 1e-6 && Math.abs(axisMax - 25) < 1e-6
              ? t('profile.deepCap')
              : d.toFixed(0)}
          </text>
        </g>
      ))}

      {/* Rotated Y axis title */}
      <text
        x={11}
        y={(y0 + y1) / 2}
        textAnchor="middle"
        fontSize="9"
        fill="currentColor"
        opacity="0.75"
        transform={`rotate(-90 11 ${((y0 + y1) / 2).toFixed(1)})`}
      >
        {t('profile.depthAxis')}
      </text>

      {/* Seabed area (water above, ground below the curve) */}
      <path className="dp-seabed-area" d={areaD} fill="currentColor" opacity="0.12" />

      {/* Shallow tint: columns where depth < safety depth (render-time overlay) */}
      {runs(samples, (s) => s.depthM < safetyDepthM).map(([i, j], k) => {
        const { x, w } = spanX(i, j);
        return (
          <rect
            key={`sh${k}`}
            className="dp-shallow"
            x={x.toFixed(1)}
            y={y0}
            width={w.toFixed(1)}
            height={plotH.toFixed(1)}
            fill={SAFETY_COLOR}
            opacity="0.18"
          />
        );
      })}

      {/* #53: legs flagged as crossing cells charted below the plan's
          REQUESTED safety depth (leg.shallow, persisted with the plan) —
          emphasized beyond the generic render-time tint above: a stronger
          band plus a solid marker bar along the top edge. */}
      {legs.map((leg, k) =>
        leg.shallow ? (
          <g key={`sw${k}`} className="dp-shallow-leg">
            <rect
              x={xOf(leg.startTimeMs).toFixed(1)}
              y={y0}
              width={Math.max(1, xOf(leg.endTimeMs) - xOf(leg.startTimeMs)).toFixed(1)}
              height={plotH.toFixed(1)}
              fill={SAFETY_COLOR}
              opacity="0.28"
            />
            <line
              x1={xOf(leg.startTimeMs).toFixed(1)}
              y1={(y0 + 1.5).toFixed(1)}
              x2={xOf(leg.endTimeMs).toFixed(1)}
              y2={(y0 + 1.5).toFixed(1)}
              stroke={SAFETY_COLOR}
              strokeWidth="3"
            />
          </g>
        ) : null,
      )}

      {/* Motor bands (grey hatch) over the motor legs' time spans */}
      {legs.map((leg, k) =>
        leg.kind === 'motor' ? (
          <rect
            key={`mo${k}`}
            className="dp-motor-band"
            x={xOf(leg.startTimeMs).toFixed(1)}
            y={y0}
            width={Math.max(1, xOf(leg.endTimeMs) - xOf(leg.startTimeMs)).toFixed(1)}
            height={plotH.toFixed(1)}
            fill={`url(#${motorHatch})`}
            opacity="0.5"
          />
        ) : null,
      )}

      {/* Deep-cap band + label: honest ">= 25 m", never a fake depth */}
      {runs(samples, (s) => s.capped).map(([i, j], k) => {
        const { x, w } = spanX(i, j);
        return (
          <rect
            key={`cap${k}`}
            className="dp-cap-band"
            x={x.toFixed(1)}
            y={(y1 - 8).toFixed(1)}
            width={w.toFixed(1)}
            height="8"
            fill={`url(#${capHatch})`}
          />
        );
      })}

      {/* Seabed profile line, on top of the fills */}
      <path
        className="dp-seabed"
        d={lineD}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.6"
      />

      {/* Safety-depth line + label (moves with the setting, no resampling).
          When the safety depth is deeper than the axis max (a setting raised
          past the route's deepest sample + margin), yOf() clamps to the bottom
          frame — a line there would lie about its depth, so draw only the label
          in that case. The label always shows the true set value. */}
      {safetyDepthM <= axisMax && (
        <line
          className="dp-safety-line"
          x1={x0}
          y1={safetyY.toFixed(1)}
          x2={x1}
          y2={safetyY.toFixed(1)}
          stroke={SAFETY_COLOR}
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
      )}
      <text
        className="dp-safety-label"
        x={x1}
        y={safetyY - 3}
        textAnchor="end"
        fontSize="9"
        fill={SAFETY_COLOR}
        paintOrder="stroke"
        stroke="var(--sc-bg)"
        strokeWidth="2.5"
      >
        {t('profile.safetyDepth')} {safetyDepthM.toFixed(1)} m
      </text>

      {/* Plot frame (left + bottom axes) */}
      <line x1={x0} y1={y0} x2={x0} y2={y1} stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <line x1={x0} y1={y1} x2={x1} y2={y1} stroke="currentColor" strokeWidth="1" opacity="0.4" />

      {/* X ticks + clock labels */}
      {ticks.map((tick, k) => (
        <g key={`t${k}`}>
          <line
            x1={xOf(tick).toFixed(1)}
            y1={y1}
            x2={xOf(tick).toFixed(1)}
            y2={y1 + 4}
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.4"
          />
          <text
            className="dp-tick"
            x={xOf(tick).toFixed(1)}
            y={y1 + 13}
            textAnchor="middle"
            fontSize="9"
            fill="currentColor"
          >
            {formatTime(tick, lang)}
          </text>
        </g>
      ))}

      {/* Indicator strip: row labels, motor strips, heading arrows, wind barbs */}
      <text
        className="dp-strip-label"
        x={2}
        y={WIND_ROW_Y + 3}
        fontSize="8"
        fill="currentColor"
        opacity="0.7"
      >
        {t('profile.wind')}
      </text>
      <text
        className="dp-strip-label"
        x={2}
        y={HEAD_ROW_Y + 3}
        fontSize="8"
        fill="currentColor"
        opacity="0.7"
      >
        {t('profile.heading')}
      </text>
      {legs.map((leg, k) =>
        leg.kind === 'motor' ? (
          <line
            key={`ms${k}`}
            className="dp-motor-strip"
            x1={xOf(leg.startTimeMs).toFixed(1)}
            y1={HEAD_ROW_Y}
            x2={xOf(leg.endTimeMs).toFixed(1)}
            y2={HEAD_ROW_Y}
            stroke={MOTOR_COLOR}
            strokeWidth="2"
            strokeDasharray="3 2"
          />
        ) : null,
      )}
      {indicators.map((tick, k) => {
        const lp = legPositionAt(legs, tick);
        if (!lp) return null;
        const w = windField.sample(lp.pos, tick);
        const x = xOf(tick);
        return (
          <g key={`ind${k}`}>
            <title>{`${formatTime(tick, lang)} · ${formatKn(w.speedKn)}`}</title>
            <BarbGlyph speedKn={w.speedKn} dirFromDeg={w.dirFromDeg} x={x} y={WIND_ROW_Y} />
            {!lp.motor && <HeadingArrow headingDeg={lp.headingDeg} x={x} y={HEAD_ROW_Y} />}
          </g>
        );
      })}
    </svg>
  );
}
