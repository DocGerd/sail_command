import type { MsgKey } from './dict.de';

export const en = {
  'app.title': 'SailCommand',
  'app.disclaimer':
    'SailCommand is a passage-planning aid, not a navigation device. Chart data is simplified; official charts and your plotter remain authoritative.',
  'plan.eta': 'Arrival {time}',
} satisfies Record<MsgKey, string>;
