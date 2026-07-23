export const de = {
  'app.title': 'SailCommand',
  'app.tagline': 'Zeitoptimale Törnplanung — offline an Bord.',
  'app.disclaimer':
    'SailCommand ist eine Törnplanungshilfe, kein Navigationsgerät. Kartendaten sind vereinfacht; maßgeblich bleiben amtliche Seekarten und der Plotter.',
  'plan.eta': 'Ankunft {time}',
  'harborPicker.searchLabel': 'Hafen suchen',
  'harborPicker.searchPlaceholder': 'Hafen suchen…',
  'harborPicker.resultsLabel': 'Häfen',
  'harborPicker.noResults': 'Keine Häfen gefunden.',
  'options.safetyDepth.label': 'Sicherheitstiefe (m)',
  'options.motorSpeed.label': 'Motorfahrtgeschwindigkeit (kn)',
  'options.motorThreshold.label': 'Motor-Schwellenwert (kn)',
  'options.maneuverPenalty.label': 'Wende-/Halsenstrafzeit (s)',
  'options.performanceFactor.label': 'Leistungsfaktor (×)',
  'options.motorEnabled.label': 'Motor aktiviert',
  'options.motorEnabled.help':
    'Motor nur als Rückfall: Motorabschnitte werden geplant, wenn die berechnete Segelfahrt unter den Schwellenwert fällt, und mit Motorfahrtgeschwindigkeit gefahren.',
  'options.showOwnship.label': 'Meine Position anzeigen',
  'options.showOwnship.help':
    'Zeigt deine GPS-Position und den Genauigkeitskreis überall auf der Karte an — beim Planen, ohne Plan oder in der Live-Ansicht, nicht nur während der Live-Führung. Consumer-GPS-Genauigkeit, keine kartengenaue Positionsbestimmung; dies ist eine Törnplanungshilfe, kein Navigationsgerät. Das Aktivieren fragt nach dem Standortzugriff.',
  // One-line glance of the collapsed "Erweitert" disclosure, joined with " · ".
  'options.summary.motorOn': 'Motor an',
  'options.summary.motorOff': 'Motor aus',
  'options.summary.maneuver': 'Wende {seconds} s',
  'options.summary.performance': '×{factor}',
  'planner.card.trip': 'Reise',
  'planner.card.advanced': 'Erweitert',
  'planner.card.result': 'Ergebnis',
  'planner.origin.label': 'Start',
  'planner.destination.label': 'Ziel',
  'planner.pickOnMap': 'Auf Karte wählen',
  'planner.change': 'Ändern',
  'planner.via.label': 'Wegpunkte',
  'planner.via.add': 'Wegpunkt hinzufügen',
  'planner.via.remove': 'Wegpunkt {index} entfernen',
  'planner.via.moveUp': 'Wegpunkt {index} nach oben verschieben',
  'planner.via.moveDown': 'Wegpunkt {index} nach unten verschieben',
  'planner.via.marker': 'Wegpunkt {index}',
  'planner.via.replanning': 'Route wird mit geänderten Wegpunkten neu berechnet…',
  'planner.departure.label': 'Abfahrt',
  'planner.plan': 'Route planen',
  // §3.5 empty/first-run: friendly guidance near the primary action while no
  // plan exists yet and an endpoint is still unpicked.
  'planner.onboarding': 'Wähle Start und Ziel, um eine Route zu planen.',
  // §3.5: terse disabled-button reason when both endpoints aren't set (the
  // gap-fill for the previously reasonless online-but-incomplete state).
  'planner.disabled.pickEndpoints': 'Start und Ziel wählen.',
  'planner.result.details': 'Details ansehen',
  // Swapped into the planner's live status region on plan completion — a
  // stable, atomic summary announced once per new plan (never on slider/
  // via-edit re-renders).
  'planner.result.announce': 'Route berechnet — Ankunft {arrival}, Dauer {duration}, {distance}.',
  // GPX import (#3): the control, the success confirmation, one message per
  // rejection reason, and the non-blocking notices. "Import/Planung"-Sprache,
  // niemals "Navigation" — importierte Geometrie ist eine Planungseingabe.
  'planner.import.button': 'GPX importieren',
  'planner.import.success':
    'Route importiert — Start, Ziel und Wegpunkte übernommen. Abfahrt und Optionen wählen, dann planen.',
  'planner.import.error.notGpx': 'Keine gültige GPX-Datei.',
  'planner.import.error.tooFewPoints':
    'Die GPX-Datei enthält keine zwei verwendbaren Punkte (Start und Ziel).',
  'planner.import.error.badCoord': 'Die GPX-Datei enthält ungültige Koordinaten.',
  'planner.import.error.outOfBounds':
    'Ein Punkt liegt außerhalb des abgedeckten Seegebiets (Flensburger Förde / Dänische Südsee).',
  'planner.import.error.tooLarge': 'Die GPX-Datei ist zu groß für den Import.',
  'planner.import.error.failed': 'GPX-Datei konnte nicht gelesen werden.',
  'planner.import.notice.trackReduced':
    'Track auf Start- und Zielpunkt reduziert — der Trackverlauf wird für die Planung ignoriert.',
  'planner.import.notice.viaCapped':
    '{dropped} zusätzliche Wegpunkte verworfen (Höchstzahl an Wegpunkten überschritten).',
  'planner.import.notice.multipleRoutes':
    'Mehrere Routen in der Datei — nur die erste wurde importiert.',
  'planner.import.notice.multipleTracks':
    'Mehrere Tracks in der Datei — nur der erste wurde importiert.',
  'planner.status.fetching': 'Windvorhersage wird geladen…',
  'planner.status.routing': 'Route wird berechnet…',
  'planner.status.routingProgress': 'Route wird berechnet… {progress}%',
  // #53: relaxed-depth probe phase after an unreachable requested-depth solve
  'planner.status.probing':
    'Keine Route bei eingestellter Sicherheitstiefe — geringere Sicherheitstiefen werden geprüft…',
  'error.offline':
    'Windvorhersagedienst nicht erreichbar. Internetverbindung prüfen und erneut versuchen.',
  'error.rateLimited':
    'Anfragelimit des Windvorhersagedienstes erreicht. Kurz warten und erneut versuchen.',
  'error.windService':
    'Windvorhersage konnte nicht geladen werden. Bitte in Kürze erneut versuchen.',
  'error.internal':
    'Routenplanung unerwartet fehlgeschlagen. Erneut versuchen; bei wiederholtem Auftreten die App neu laden.',
  'error.noRoute.unreachable':
    'Keine Route gefunden — das Ziel ist ohne Landkontakt oder zu flaches Wasser nicht erreichbar.',
  'error.noRoute.beyondHorizon':
    'Keine Route innerhalb des 6-Tage-Vorhersagehorizonts gefunden. Spätere Abfahrt oder ein näheres Ziel versuchen.',
  'error.noRoute.calmMotorOff':
    'Zu wenig Wind zum Segeln und Motor deaktiviert — Motor in den Optionen aktivieren oder Abfahrt verschieben.',
  'error.noRoute.snapOrigin':
    'Der Startpunkt ist nicht befahrbar — einen Punkt mindestens 300 m von Land oder Flachwasser wählen.',
  'error.noRoute.snapDestination':
    'Das Ziel ist nicht befahrbar — einen Punkt mindestens 300 m von Land oder Flachwasser wählen.',
  'error.noRoute.snapVia':
    'Ein Zwischenpunkt ist nicht befahrbar — einen Punkt mindestens 300 m von Land oder Flachwasser wählen.',
  'error.replanStaleWind':
    'Die gespeicherte Windvorhersage deckt die Abfahrtszeit dieses Plans nicht mehr ab. Route neu planen, um eine aktuelle Vorhersage zu laden.',
  'error.replanInit':
    'Routenplaner konnte nicht gestartet werden. Erneut versuchen; bei wiederholtem Auftreten die App neu laden.',
  // #115: manual "reroute from here" (Live-Ansicht) — honest failures, never
  // eine stillschweigend gekürzte oder extrapolierte Route.
  'error.rerouteStaleWind':
    'Die gespeicherte Windvorhersage dieses Plans deckt die aktuelle Zeit nicht mehr ab — eine neue Route ab jetzt kann daraus nicht berechnet werden. Route neu planen, um eine aktuelle Vorhersage zu laden.',
  'error.rerouteFixOutside':
    'Die aktuelle GPS-Position liegt außerhalb des abgedeckten Seegebiets oder ist nicht befahrbar — von hier kann keine Route berechnet werden.',
  'route.rig.genoa': 'Genua',
  'route.rig.fock': 'Fock',
  'route.rigTabs': 'Riggvergleich',
  'route.recommended': 'Empfohlen',
  'route.fasterRig': 'Schneller: {rig}',
  'route.staleForecast':
    'Die Wettervorhersage ist mehr als 12 Stunden älter als die Abfahrt — die Windbedingungen können sich seither geändert haben.',
  // #53: honest passage-planning-aid copy — charted data may under- OR
  // overstate real depths (dredged channels are exactly where chart data is
  // pessimistic); never claim the route is verified safe.
  'route.shallow.banner':
    'Achtung: Diese Route quert Wasser, das flacher kartiert ist als die eingestellte Sicherheitstiefe von {requested} m — geringste kartierte Tiefe entlang der Route: {minGate} m. Kartendaten können reale Tiefen unter- wie überschätzen; insbesondere ausgebaggerte Fahrrinnen sind oft tiefer als kartiert. Markierte Abschnitte mit amtlicher Seekarte und Echolot prüfen.',
  'route.totals.distance': 'Distanz',
  'route.totals.duration': 'Dauer',
  'route.totals.eta': 'Ankunft',
  'route.totals.maneuvers': 'Manöver',
  'route.totals.motorDistance': 'Strecke unter Motor',
  'route.totals.avgSpeed': 'Ø Geschw.',
  // Sail/motor split bar (Ergebnis card).
  'route.split.sail': 'Segeln',
  'route.split.motor': 'Motor',
  'route.split.aria': 'Segelanteil {sailPct} %, Motoranteil {motorPct} %',
  'route.legs.time': 'Zeit',
  'route.legs.kind': 'Art',
  'route.legs.heading': 'Kurs',
  'route.legs.twa': 'TWA',
  'route.legs.tws': 'TWS',
  'route.legs.speed': 'Geschwindigkeit',
  'route.legs.distance': 'Distanz',
  'route.legs.maneuver': 'Manöver',
  'route.legs.motorNote': 'Motor = reine Motorfahrt, keine Segelleistung modelliert.',
  'route.legs.disclosure': 'Etappen ({count})',
  'route.kind.motor': 'Motor',
  'route.board.port': 'Bb',
  'route.board.starboard': 'Stb',
  'route.pointOfSail.beat': 'Kreuz',
  'route.pointOfSail.reach': 'Halbwind',
  'route.pointOfSail.broadReach': 'Raum',
  'route.pointOfSail.run': 'Vorwind',
  'route.maneuver.tack': 'Wende',
  'route.maneuver.gybe': 'Halse',
  'route.maneuverLetter.tack': 'W',
  'route.maneuverLetter.gybe': 'H',
  'route.legend.title': 'Legende',
  'route.legend.sailStarboard': 'Segel, Steuerbordbug',
  'route.legend.sailPort': 'Segel, Backbordbug',
  'route.legend.motor': 'Motor (ohne Segelleistung)',
  'route.legend.maneuver': 'Wende/Halse',
  'route.legend.headingChange': 'Kursänderung',
  'route.legend.via': 'Zwischenpunkt',
  'route.legend.shallow': 'Flacher als Sicherheitstiefe kartiert',
  'route.exportGpx': 'GPX exportieren',
  'route.windBarbs.toggle': 'Windpfeile anzeigen',
  'route.windBarbs.timeSlider': 'Vorhersagezeitpunkt',
  'route.annotations.toggle': 'Zeiten & Geschwindigkeiten',
  'route.motorLetter': 'M',
  // Depth profile (#45)
  'profile.title': 'Tiefenprofil',
  'profile.depthAxis': 'Tiefe (m)',
  'profile.deepCap': '≥ 25 m',
  'profile.safetyDepth': 'Sicherheitstiefe',
  'profile.heading': 'Kurs',
  'profile.wind': 'Wind',
  // 'min.' with the period: disambiguates from the panel's minutes ('x h yy
  // min', '+12 min') on this time-axis chart (German abbreviations take a dot).
  'profile.minDepth': 'min.',
  // Deliberately terse: shares the narrow-viewport map-top row with the
  // plan-gated wind-barb toggle on the opposite side (app.css).
  'map.depth.toggle': 'Wassertiefen',
  // Seezeichen-Overlay (#7) — standardmäßig AUS, Opt-in.
  'map.seamarks.toggle': 'Seezeichen',
  'seamark.popover.type': 'Typ',
  'seamark.popover.category': 'Kategorie',
  'seamark.popover.colour': 'Farbe',
  'seamark.popover.lightCharacter': 'Kennung',
  'seamark.popover.lightColour': 'Lichtfarbe',
  'seamark.popover.lightPeriod': 'Wiederkehr',
  'plansList.empty': 'Noch keine gespeicherten Pläne.',
  'plansList.created': 'Erstellt',
  'plansList.delete': 'Plan löschen',
  'plansList.confirmDelete': 'Löschen bestätigen',
  'plansList.actionError': 'Aktion fehlgeschlagen. Bitte erneut versuchen.',
  // #114: recalculate a saved plan with a FRESH forecast (unlike a via-replan,
  // which reuses the stored grid and stays offline-capable).
  'plansList.recalc': 'Neu berechnen',
  'plansList.recalc.saveNew': 'Als neuen Plan berechnen',
  'plansList.recalc.replace': 'Original ersetzen',
  'plansList.recalc.confirmReplace': 'Ersetzen bestätigen',
  'plansList.recalc.cancel': 'Abbrechen',
  'plansList.recalc.offline':
    'Neuberechnung nur online möglich — es wird eine frische Windvorhersage geladen.',
  'plansList.recalcName': '{name} (neu berechnet)',
  'live.toggle': 'Live-Ansicht',
  'live.noPlan': 'Route laden oder planen, um die Live-Führung zu nutzen.',
  'live.hts.label': 'Steuerkurs',
  'live.cog.label': 'COG',
  'live.sog.label': 'SOG',
  'live.nextEvent.label': 'Nächstes in {distance}',
  'live.nextEvent.motorStart': 'Motor an',
  'live.nextEvent.none': 'Keine weiteren Manöver auf dieser Route',
  'live.eta.label': 'Voraussichtliche Ankunft',
  'live.gpsHint':
    'Standortzugriff ist nicht verfügbar, daher kann die Bootsposition nicht auf der Karte angezeigt werden. Planung und die gespeicherte Route funktionieren weiterhin uneingeschränkt — dies ist eine Törnplanungshilfe, kein Navigationsgerät.',
  'live.gpsHint.dismiss': 'Verstanden',
  // #115: manueller "Route ab hier"-Neuplan — Planungssprache, keine
  // Navigationsführung; nutzt die GESPEICHERTE Windvorhersage des Plans
  // (offlinefähig, im Gegensatz zur #114-Neuberechnung).
  'live.reroute.action': 'Route ab hier neu planen',
  'live.reroute.busy': 'Route wird ab aktueller Position neu geplant…',
  'live.reroute.needFix':
    'Erfordert eine aktive GPS-Position — Live-Ansicht starten und auf einen GPS-Fix warten.',
  'live.reroute.hint':
    'Erstellt einen neuen Plan von der aktuellen Position zum Ziel mit der gespeicherten Windvorhersage; der ursprüngliche Plan bleibt erhalten. Planungshilfe, keine Navigationsführung.',
  'live.reroute.name': '{name} (ab Position neu geplant)',
  'nav.plan': 'Planen',
  'nav.routes': 'Routen',
  'nav.live': 'Live',
  'nav.langToggle': 'English anzeigen',
  'nav.langToggle.de': 'DE',
  'nav.langToggle.en': 'EN',
  'about.open': 'Über SailCommand',
  'about.title': 'Über SailCommand',
  'about.close': 'Schließen',
  'about.version': 'Version {version}',
  'about.changelog.title': 'Was ist neu',
  'about.changelog.langNote': 'Das Änderungsprotokoll wird auf Englisch geführt.',
  'about.caveats.heading': 'Wichtige Hinweise',
  'about.caveats.polars':
    'Die Polardaten sind Schätzungen auf Basis ORC-artiger VPP-Daten, einstellbar über den Leistungsfaktor in den Optionen — nicht renngenau kalibriert.',
  'about.dataSize':
    'Der erste Aufruf lädt ca. 44 MB (Basiskarte und Routendaten) herunter; spätere Aufrufe werden aus dem Cache bedient und funktionieren offline.',
  'about.sources.heading': 'Datenquellen',
  'about.sources.protomaps': 'Kartendarstellung: Protomaps',
  'about.sources.osm': '© OpenStreetMap-Mitwirkende (ODbL)',
  'about.sources.osmMask':
    'Land-/Tiefenmaske: abgeleitet von © OpenStreetMap-Mitwirkenden, bereitgestellt unter ODbL',
  'about.sources.openMeteo': 'Windvorhersage: Wetterdaten von Open-Meteo.com (CC-BY 4.0)',
  'about.sources.polars':
    'Polare: ORC International Zertifikat 2026, Salona 45 „Miles Ahead" (AUT 035/26); Vorwind-Werte auf Weißsegel (ohne Spinnaker) korrigiert — Schätzung, nicht renngenau kalibriert.',
  'about.sources.seamarks':
    'Seezeichen: © OpenStreetMap-Mitwirkende (ODbL), Stand der Seezeichendaten: 22. Juli 2026 — Zeitpunkt-Extrakt, nicht laufend überprüft',
  'banner.offline': 'Offline — Planung deaktiviert. Gespeicherte Routen bleiben verfügbar.',
  'banner.mapError': 'Kartendaten konnten nicht geladen werden — Anzeige evtl. unvollständig.',
  'banner.persistenceError': 'Einstellungen konnten nicht gespeichert werden.',
  'banner.dismiss': 'Schließen',
  // §3.5: retry action shown on network/offline plan errors (re-runs the plan).
  'banner.retry': 'Erneut versuchen',
  'banner.tapPick': 'Auf Karte tippen für {target}.',
  'banner.tapPick.cancel': 'Abbrechen',
  'banner.viaTooClose': 'Wegpunkt zu nah am Nachbarn — übersprungen',
  'banner.viaTooClose.plural': '{count} Wegpunkte zu nah an Nachbarn — übersprungen',
  'pwa.updateAvailable': 'Update verfügbar',
  'pwa.reload': 'Neu laden',
  'pwa.offlineReady': 'App & Karten offline verfügbar',
  // #25 AIS overlay — vessel popup + shared disclaimer.
  'ais.popup.name': 'Name',
  'ais.popup.mmsi': 'MMSI',
  'ais.popup.shipType': 'Schiffstyp',
  'ais.popup.sog': 'SOG',
  'ais.popup.cog': 'COG',
  'ais.popup.age': 'Letztes Signal vor',
  'ais.disclaimer':
    'AIS-Abdeckung stammt von freiwilligen Landstationen und ist nicht garantiert oder vollständig. Diese Anzeige ist eine Aufmerksamkeitshilfe, keine Kollisionsverhütung und kein Navigationsgerät.',
  'options.ais.apiKey.label': 'AIS-API-Schlüssel (aisstream.io)',
  'options.ais.mmsi.label': 'Eigene MMSI (optional)',
  'options.ais.mmsi.invalid': 'Die MMSI muss aus genau 9 Ziffern bestehen.',
  'options.ais.help':
    'Zeigt Live-Schiffsverkehr aus der Umgebung nur in der Live-Ansicht (nur online). Erstelle einen kostenlosen API-Schlüssel auf aisstream.io und füge ihn hier ein. Schlüssel und MMSI bleiben nur auf diesem Gerät gespeichert; der Schlüssel wird ausschließlich an aisstream.io als Teil des Abonnements gesendet, die MMSI dient nur dazu, das eigene Schiff aus der Anzeige herauszufiltern, und wird niemals übertragen. Aufmerksamkeitshilfe, kein Navigationsgerät.',
} as const;
export type MsgKey = keyof typeof de;
