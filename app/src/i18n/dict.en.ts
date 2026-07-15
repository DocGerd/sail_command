import type { MsgKey } from './dict.de';

export const en = {
  'app.title': 'SailCommand',
  'app.disclaimer':
    'SailCommand is a passage-planning aid, not a navigation device. Chart data is simplified; official charts and your plotter remain authoritative.',
  'plan.eta': 'Arrival {time}',
  'harborPicker.searchLabel': 'Search harbor',
  'harborPicker.noResults': 'No harbors match your search.',
  'options.safetyDepth.label': 'Safety depth (m)',
  'options.motorSpeed.label': 'Motoring speed (kn)',
  'options.motorThreshold.label': 'Motor threshold (kn)',
  'options.maneuverPenalty.label': 'Maneuver penalty (s)',
  'options.performanceFactor.label': 'Performance factor (×)',
  'options.motorEnabled.label': 'Motor enabled',
  'planner.origin.label': 'Origin',
  'planner.destination.label': 'Destination',
  'planner.notSelected': 'Not selected',
  'planner.pickOnMap': 'Pick on map',
  'planner.departure.label': 'Departure',
  'planner.plan': 'Plan route',
  'planner.status.fetching': 'Fetching wind forecast…',
  'planner.status.routing': 'Calculating route…',
  'planner.status.routingProgress': 'Calculating route… {progress}%',
} satisfies Record<MsgKey, string>;
