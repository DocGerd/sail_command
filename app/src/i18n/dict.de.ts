export const de = {
  'app.title': 'SailCommand',
  'app.disclaimer':
    'SailCommand ist eine Törnplanungshilfe, kein Navigationsgerät. Kartendaten sind vereinfacht; maßgeblich bleiben amtliche Seekarten und der Plotter.',
  'plan.eta': 'Ankunft {time}',
  'harborPicker.searchLabel': 'Hafen suchen',
  'harborPicker.noResults': 'Keine Häfen gefunden.',
  'options.safetyDepth.label': 'Sicherheitstiefe (m)',
  'options.motorSpeed.label': 'Motorfahrtgeschwindigkeit (kn)',
  'options.motorThreshold.label': 'Motor-Schwellenwert (kn)',
  'options.maneuverPenalty.label': 'Wende-/Halsenstrafzeit (s)',
  'options.performanceFactor.label': 'Leistungsfaktor (×)',
  'options.motorEnabled.label': 'Motor aktiviert',
  'planner.origin.label': 'Start',
  'planner.destination.label': 'Ziel',
  'planner.notSelected': 'Nicht ausgewählt',
  'planner.pickOnMap': 'Auf Karte wählen',
  'planner.departure.label': 'Abfahrt',
  'planner.plan': 'Route planen',
  'planner.status.fetching': 'Windvorhersage wird geladen…',
  'planner.status.routing': 'Route wird berechnet…',
  'planner.status.routingProgress': 'Route wird berechnet… {progress}%',
} as const;
export type MsgKey = keyof typeof de;
