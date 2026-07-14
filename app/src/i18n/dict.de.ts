export const de = {
  'app.title': 'SailCommand',
  'app.disclaimer':
    'SailCommand ist eine Törnplanungshilfe, kein Navigationsgerät. Kartendaten sind vereinfacht; maßgeblich bleiben amtliche Seekarten und der Plotter.',
  'plan.eta': 'Ankunft {time}',
} as const;
export type MsgKey = keyof typeof de;
