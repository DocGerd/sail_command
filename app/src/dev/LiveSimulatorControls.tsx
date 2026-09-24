import { useEffect, useState } from 'react';
import Button from '../components/Button';
import Chip from '../components/Chip';
import { useLang } from '../i18n';
import type { Leg } from '../types';
import {
  LIVE_SIM_SCENARIOS,
  getLiveSimController,
  type LiveSimScenario,
  type LiveSimState,
} from './liveSimulator';
import { liveSimDict } from './LiveSimulatorControls.dict';

const SPEED_STEP = 10;
const SPEED_MIN = 10;
const SPEED_MAX = 200;

export interface LiveSimulatorControlsProps {
  // #1486 review: the ACTIVE plan's legs, so 'track'/'drift' follow the
  // real route rather than a synthetic loop (heading-to-steer/depth-caution
  // math in LiveView.tsx is computed against the same `legs`, so a
  // divergent simulated track produced a false "crosses charted land"
  // caution there). Wired here — inside this dev/UAT-only, conditionally
  // MOUNTED component — rather than as a standalone effect in LiveView.tsx:
  // this whole component tree dead-code-eliminates out of the prod bundle
  // (see LiveView.tsx's gate comment), so an effect declared inside it
  // never becomes an unconditional hook call in a production build.
  legs: readonly Leg[];
}

/**
 * #143: dev/UAT-only Live-view simulator panel — play/pause, scenario
 * select, speed multiplier, jump-to-position. Imported only from
 * LiveView.tsx behind the fold-exact `import.meta.env.DEV || __SC_UAT__`
 * gate (see that file's comment); never import this unconditionally.
 *
 * Drives the SAME controller singleton geolocation.ts's `subscribeLiveSim`
 * adapter reads from (via `getLiveSimController()`, never a fresh
 * instance), so this panel's controls affect every GPS consumer currently
 * subscribed (both seams) rather than a private copy.
 */
export default function LiveSimulatorControls({ legs }: LiveSimulatorControlsProps) {
  const [lang] = useLang();
  const dict = liveSimDict[lang];
  const controller = getLiveSimController();
  const [state, setState] = useState<LiveSimState>(controller.getState());

  useEffect(() => controller.subscribeState(setState), [controller]);

  useEffect(() => {
    controller.setRoute(legs.length > 0 ? [legs[0].start, ...legs.map((l) => l.end)] : null);
    return () => controller.setRoute(null);
  }, [controller, legs]);

  return (
    <div className="live-sim-controls">
      <Chip>{dict['liveSim.title']}</Chip>
      <label className="live-sim-controls-field">
        {dict['liveSim.scenario.label']}
        <select
          value={state.scenario}
          onChange={(e) => controller.setScenario(e.target.value as LiveSimScenario)}
        >
          {LIVE_SIM_SCENARIOS.map((scenario) => (
            <option key={scenario} value={scenario}>
              {dict[`liveSim.scenario.${scenario}`]}
            </option>
          ))}
        </select>
      </label>
      <Button
        variant="secondary"
        aria-pressed={state.playing}
        onClick={() => (state.playing ? controller.pause() : controller.play())}
      >
        {state.playing ? dict['liveSim.pause'] : dict['liveSim.play']}
      </Button>
      <label className="live-sim-controls-field">
        {dict['liveSim.speed.label'].replace('{multiplier}', String(state.speedMultiplier))}
        <input
          type="range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={state.speedMultiplier}
          onChange={(e) => controller.setSpeedMultiplier(Number(e.target.value))}
        />
      </label>
      <label className="live-sim-controls-field">
        {dict['liveSim.jump.label']}
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          defaultValue={0}
          onChange={(e) => controller.jumpToFraction(Number(e.target.value) / 100)}
        />
      </label>
    </div>
  );
}
