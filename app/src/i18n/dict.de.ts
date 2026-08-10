export const de = {
  'app.title': 'SailCommand',
  'app.tagline': 'Zeitoptimale Törnplanung — offline an Bord.',
  'app.disclaimer':
    'SailCommand ist eine Törnplanungshilfe, kein Navigationsgerät. Kartendaten sind vereinfacht; maßgeblich bleiben amtliche Seekarten und der Plotter.',
  'panel.resizer.label': 'Panelbreite anpassen',
  'plan.eta': 'Ankunft {time}',
  'harborPicker.searchLabel': 'Hafen suchen',
  'harborPicker.searchPlaceholder': 'Hafen suchen…',
  'harborPicker.resultsLabel': 'Häfen',
  'harborPicker.noResults': 'Keine Häfen gefunden.',
  'options.safetyDepth.label': 'Sicherheitstiefe (m)',
  // #299: die Tiefenkomfort-Spanne und die übrigen Boot-Einstellungen wohnen
  // jetzt im eigenen „Boot"-Tab (SettingsPanel) — dieser Link direkt bei der
  // (weiterhin hier verbleibenden) Sicherheitstiefe verhindert, dass jemand
  // die Komfort-Spanne für gelöscht hält, weil sie nicht mehr direkt daneben
  // steht.
  'planner.safetyDepth.boatLink': 'Tiefenkomfort-Spanne & weitere Boot-Einstellungen',
  'options.depthComfortMargin.label': 'Tiefenkomfort-Spanne (m)',
  'options.depthComfortMargin.help':
    'Über die Sicherheitstiefe hinaus bevorzugt die Planung zusätzlich Wasser, das mindestens um diesen Wert tiefer ist, sofern das kaum zusätzliche Zeit kostet — 0 deaktiviert die Präferenz. Sie erlaubt niemals flacheres Wasser, als die Sicherheitstiefe zulässt, und die empfohlene Besegelung kann sich dadurch ändern.',
  'options.motorSpeed.label': 'Motorfahrtgeschwindigkeit (kn)',
  'options.motorThreshold.label': 'Motor-Schwellenwert (kn)',
  'options.sailPreference.label': 'Segelvorzug (kn)',
  'options.sailPreference.help':
    'Wie viel Fahrt die Planung aufgibt, um weiter zu segeln. Sie segelt weiter, solange die Segelfahrt höchstens um diesen Wert unter der Motorfahrtgeschwindigkeit liegt, und motort sonst — ein höherer Wert bedeutet also mehr Segeln und spätere Ankunft. Auf Motorfahrtgeschwindigkeit minus Motor-Schwellenwert gesetzt, motort die Planung nur noch im Rückfall.',
  'options.maneuverPenalty.label': 'Wende-/Halsenstrafzeit (s)',
  'options.performanceFactor.label': 'Leistungsfaktor (×)',
  'options.motorEnabled.label': 'Motor aktiviert',
  'options.motorEnabled.help':
    'Motorabschnitte erlauben: Die Planung motort, wo Segeln um mehr als den Segelvorzug langsamer wäre als Motorfahrt, und immer unterhalb des Motor-Schwellenwerts. Motorabschnitte laufen mit Motorfahrtgeschwindigkeit und werden als Motor gekennzeichnet.',
  'options.showOwnship.label': 'Meine Position anzeigen',
  'options.showOwnship.help':
    'Zeigt deine GPS-Position und den Genauigkeitskreis überall auf der Karte an — beim Planen, ohne Plan oder in der Live-Ansicht, nicht nur während der Live-Führung. Consumer-GPS-Genauigkeit, keine kartengenaue Positionsbestimmung; dies ist eine Törnplanungshilfe, kein Navigationsgerät. Das Aktivieren fragt nach dem Standortzugriff.',
  // #299: Abschnittsüberschriften im Boot-Tab (SettingsPanel).
  'settings.section.boatSafety': 'Boot & Sicherheit',
  'settings.section.propulsion': 'Antrieb',
  'settings.section.liveAis': 'Live & AIS',
  'planner.card.trip': 'Reise',
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
  // #301: die Eingaben (Start/Ziel/Abfahrt/Einstellungen) weichen von der
  // oben angezeigten Route ab — eine erneute Berechnung würde jetzt eine
  // andere Route liefern. Als zweiter Chip in der Ergebnis-Karte gezeigt UND
  // in die eine Live-Region dieses Panels eingefügt (nie eine zweite).
  'planner.result.stale':
    'Zeigt die zuvor berechnete Route — die Eingaben wurden seitdem geändert.',
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
  // #340: phase readout, not a percentage — the router solves genoa and fock
  // SEQUENTIALLY, so "Segel {index} von {total}" ({rig} already localized via
  // RIG_LABEL_KEY) is honest and bounded, unlike the removed percentage.
  'planner.status.routingRig': 'Route wird berechnet… Segel {index} von {total} ({rig})',
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
  // #433: Ursachen, die zuvor alle auf error.internal zusammenfielen, jetzt
  // unterscheidbar — jeweils mit Hinweistext, der ehrlich sagt, ob „Erneut
  // versuchen" tatsächlich helfen kann (siehe App.tsx's RETRY_MAY_HELP_KEYS).
  'error.workerInit':
    'Der Routenplaner konnte nicht gestartet werden — erforderliche Daten konnten nicht geladen werden. App neu laden und erneut versuchen.',
  'error.routingTimeout':
    'Die Routenberechnung hat das Zeitlimit überschritten. Ein erneuter Versuch dürfte genauso am Zeitlimit scheitern — eine einfachere Route oder ein schnelleres Gerät könnten helfen.',
  // #433 review Minor 1: behauptet NICHT, dass ein erneuter Versuch
  // zwecklos ist — diese Ursache umfasst auch einen Ressourcenerschöpfungs-
  // Fehler, bei dem ein frischer Worker tatsächlich helfen kann (siehe
  // Kommentar zu usePlanFlow.ts's ROUTING_FAILURE_MESSAGE_KEY).
  'error.routingFailed':
    'Bei der Routenberechnung ist ein interner Fehler aufgetreten. Eine andere Route oder andere Einstellungen helfen eher als ein erneuter Versuch mit derselben Anfrage.',
  'error.routingCrashed':
    'Die Routen-Engine ist unerwartet abgestürzt. Erneut versuchen — sie startet dabei neu.',
  'error.routingMessageError':
    'Die Routen-Engine hat eine nicht lesbare Antwort gesendet. Erneut versuchen — sie startet dabei neu.',
  'error.routingInterrupted': 'Die Routenberechnung wurde unterbrochen. Erneut versuchen.',
  'error.planSaveFailed':
    'Die Route wurde berechnet, konnte aber nicht gespeichert werden. Erneut versuchen oder freien Speicherplatz auf diesem Gerät prüfen.',
  'error.windUnknown':
    'Windvorhersage konnte aufgrund eines unerwarteten Fehlers nicht geladen werden. Bitte in Kürze erneut versuchen.',
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
  // #432: die Suche wurde abgebrochen, BEVOR sie fertig war — anders als die
  // übrigen error.noRoute.*-Texte ist das ausdrücklich keine Aussage darüber,
  // ob es eine Route gibt.
  'error.noRoute.searchBudget':
    'Die Routenberechnung hat ihr Zeitlimit erreicht, bevor sie fertig war — das heißt nicht, dass es keine Route gibt. Ein näheres Ziel, weniger Zwischenpunkte oder eine kleinere Tiefen-Komfortspanne helfen; ein schnelleres Gerät ebenfalls.',
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
  // #259: honest copy for the two cases where badging one rig as
  // "recommended" would be misleading — an ETA tie (too close to call) and
  // an all-motor route (the polar never drove a leg, so rig choice is moot).
  'route.rigTie': 'Genua und Fock liegen für diese Passage praktisch gleichauf',
  'route.rigMoot': 'Riggwahl spielt hier keine Rolle — die Passage läuft durchgehend unter Motor',
  'route.staleForecast':
    'Die Wettervorhersage ist mehr als 12 Stunden älter als die Abfahrt — die Windbedingungen können sich seither geändert haben.',
  // #53/#452: honest passage-planning-aid copy — see dict.en.ts's comment
  // for why {used} < {requested} always holds here, why the closing
  // sentence deliberately does not imply unflagged water is safe, and why
  // {minGate} is framed at plan level ("crossed by this plan", not "on this
  // route"). review (PR #461 Minor 4): the previous opening
  // ("...Sicherheitstiefe ... war nicht passierbar") was a direct calque of
  // the English — a *Sicherheitstiefe* is a threshold, and a threshold is
  // not itself *passierbar* (that adjective applies to a passage/channel/
  // route, not a depth). Reworded to name what actually happened: the
  // requested-depth solve found no continuous route, so the planner used a
  // reduced one instead.
  'route.shallow.banner':
    'Achtung: Mit der eingestellten Sicherheitstiefe von {requested} m wurde keine durchgehende Route gefunden — diese Route wurde daher mit einer reduzierten Tiefe von {used} m geplant. Geringste von diesem Plan gequerte Kartentiefe: {minGate} m. Kartendaten können reale Tiefen sowohl unter- als auch überschätzen, daher ist diese Warnung nicht vollständig: Ein Abschnitt ohne Warnung ist nicht garantiert frei von Untiefen. Markierte Abschnitte mit amtlicher Seekarte und Echolot prüfen.',
  // #452 gap 3: siehe dict.en.ts's Kommentar für Zweck und Konvention
  // (Singular/`.plural`, wie banner.viaTooClose(.plural)).
  'route.shallow.locator': 'Die betroffene Etappe beginnt um {time}.',
  'route.shallow.locator.plural': '{count} Etappen sind betroffen — die erste beginnt um {time}.',
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
  'route.legs.duration': 'Dauer',
  'route.legs.kind': 'Art',
  'route.legs.cog': 'COG',
  'route.legs.twa': 'TWA',
  'route.legs.tws': 'TWS',
  'route.legs.speed': 'Geschwindigkeit',
  'route.legs.distance': 'Distanz',
  'route.legs.maneuver': 'Manöver',
  // #452 gap 3: siehe dict.en.ts's Kommentar (per-Etappe Untiefen-Markierung,
  // Text statt reiner Farbe).
  'route.legs.shallow': 'Untiefe',
  'route.legs.shallowMarker': 'Untiefe {depth} m',
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
  // #324: map-only overlay of the rig NOT currently shown as the primary
  // route (dashed, reduced opacity — see RouteLayer.tsx's setupLayers).
  'route.legend.altRig': 'Anderes Rigg (gestrichelt)',
  'route.exportGpx': 'GPX exportieren',
  'route.windBarbs.toggle': 'Windpfeile anzeigen',
  'route.windBarbs.timeSlider': 'Vorhersagezeitpunkt',
  'route.annotations.toggle': 'Zeiten & Geschwindigkeiten',
  'route.altRig.toggle': 'Anderes Rigg anzeigen',
  'route.altRig.unavailable': 'Nur ein Rigg hat eine Route gefunden',
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
  // {value} s — same text in both languages, but still routed through the
  // dict (#300) rather than hardcoded, per repo convention.
  'seamark.popover.lightPeriodUnit': '{value} s',
  // Seezeichen-Popover-WERTE (#300): übersetzt aus den in
  // app/public/data/seamarks.json tatsächlich vorkommenden OSM-Tag-Werten
  // (nicht aus dem vollen IALA-Tagging-Schema) — seamarkPopover.coverage.test.ts
  // sichert die Abdeckung ab. `seamark.popover.lightCharacter`-Werte (Fl, Oc, …)
  // bleiben bewusst unübersetzt, siehe seamarkPopover.ts.
  'seamark.value.type.beacon_cardinal': 'Kardinalbake',
  'seamark.value.type.beacon_isolated_danger': 'Einzelgefahrenbake',
  'seamark.value.type.beacon_lateral': 'Lateralbake',
  'seamark.value.type.beacon_special_purpose': 'Sonderbake',
  'seamark.value.type.buoy_cardinal': 'Kardinaltonne',
  'seamark.value.type.buoy_isolated_danger': 'Einzelgefahrentonne',
  'seamark.value.type.buoy_lateral': 'Lateraltonne',
  // #300 F1: NOT "Fahrwassertonne" — that names any lateral fairway buoy, not
  // the IALA safe-water class. "Mitte-Fahrwasser-Zeichen" = "Safe Water
  // Marks" per the BSH/INT-1 chart-symbols legend (Karte 1 / INT 1), matching
  // the Kardinaltonne/Lateraltonne naming pattern already used in this table.
  'seamark.value.type.buoy_safe_water': 'Mitte-Fahrwasser-Tonne',
  'seamark.value.type.buoy_special_purpose': 'Sondertonne',
  'seamark.value.type.light_major': 'Hauptfeuer',
  'seamark.value.type.light_minor': 'Nebenfeuer',
  'seamark.value.category.anchorage': 'Ankerplatz',
  'seamark.value.category.cable': 'Kabel',
  // #300 F2/F9: NOT "Freizeichen" (telephone dial tone, Duden). Two further
  // candidates were considered and REJECTED before landing on
  // "Gefahrenpeilung" below — recorded so a future maintainer who
  // rediscovers either attestation doesn't read the choice as sloppiness:
  //
  // 1. "Deckpeilung" — genuinely attested (see citation below), F9's
  //    Blocker is UPHELD on this one, not overturned: "Deckpeilung" names
  //    the transit/bearing METHOD, and that method is shared by leading
  //    AND clearing lines (`category.leading` below is glossed via the
  //    SAME BSH legend row, "Richtlinie"), so it cannot distinguish the two
  //    and was rejected as the value here. Citation, verbatim from the PDF
  //    TEXT LAYER (not a summarizing fetch): "Wichtige Zeichen und
  //    Abkürzungen für Klein- und Sportschifffahrtskarten aus Karte 1 /
  //    INT 1", © 2013 BSH, page 1, "Hydrographie / Hydrography" section —
  //    the legend runs in sequence: "Richtlinie" / "Leading line" /
  //    "Deckpeilung" / "Clearing line" / "Empfohlener Kurs" / "Recommended
  //    track". EDITION NOTE (kept because it now documents a REJECTED
  //    candidate, which makes it more useful, not less — it stops a future
  //    maintainer from "restoring" Deckpeilung on the strength of the real
  //    BSH pairing without knowing why it was passed over): the copy
  //    served at the bsh.de URL TODAY is a different, re-laid-out 4-page
  //    edition containing neither "Deckpeilung" nor "Clearing" (verified by
  //    grepping the extracted text of all 4 pages) — its legend jumps
  //    "Richtlinie / Leading line" straight to "Empfohlener Kurs /
  //    Recommended track". Cite the 2013 edition specifically, not "the
  //    BSH site". Working mirror:
  //    https://www.segelschule-bensberg.de/pdf/Kartenzeichen1_Copy.pdf
  // 2. "Klarierungsmarke" — the only class-(a) German MARK noun found for
  //    "clearing mark" (ULTRAMARIN schifffahrtslexikon.de gives literally
  //    "veiligheidsbaken" / "Klarierungsmarke" / "clearing mark"), also
  //    rejected: its sibling entries all gloss *safety mark*, indicating a
  //    calque rather than settled usage, and "Klarierung" reads as customs
  //    clearance to a German mariner — the misreading direction matters
  //    more than attestation rank here (a "Gefahren-" root misreads toward
  //    "danger", the right half of the actual concept; a "Klarierungs-"
  //    root misreads toward customs, unrelated to it).
  //
  // CHOSEN: "Gefahrenpeilung" is attested as a TERM — ULTRAMARIN
  // schifffahrtslexikon.de: "gevarenpeiling" / "Gefahrenpeilung" /
  // "danger bearing" (https://www.schifffahrtslexikon.de/d/gefahrenpeilung_de.php)
  // — a danger bearing IS the clearing-bearing concept, so unlike
  // "Deckpeilung" it carries the distinguishing semantics. This is
  // evidence class (a): attested AS A TERM, NOT as a pairing with "clearing
  // mark" — no source pairs "Gefahrenpeilung" with that phrase, and it must
  // never be cited as INT 1 or S-57. Used bare, no "Bake einer" prefix
  // (that shape existed only to satisfy a mark-noun constraint the row
  // doesn't need — the popover's separate Typ row already supplies
  // mark-ness): all 3 shipped `clearing` features are beacon_special_
  // purpose, so the popover reads "Typ: Sonderbake" / "Kategorie:
  // Gefahrenpeilung" — naming the bearing this mark establishes, not
  // re-asserting mark-ness; stays correct even if a future pipeline run
  // tags a buoy with this category.
  //
  // KNOWN FORM INCONSISTENCY (deliberate, not an oversight): `leading`
  // below is a mark NOUN ("Richtbake"), while this entry names a bearing/
  // concept, not a mark noun — German has no attested clearing-mark noun to
  // make the two forms uniform, and each is independently the
  // best-attested option for what it tags. Do not "harmonise" them.
  'seamark.value.category.clearing': 'Gefahrenpeilung',
  'seamark.value.category.degaussing_range': 'Entmagnetisierungsstrecke',
  'seamark.value.category.east': 'Ost',
  // #300: verbatim BSH gloss, same citation as `clearing` above —
  // "Wichtige Zeichen und Abkürzungen für Klein- und Sportschifffahrtskarten
  // aus Karte 1 / INT 1", © 2013 BSH, page 1, "Hydrographie / Hydrography"
  // section: "Militärisches Übungsgebiet / Firing danger area". Read from
  // the PDF text layer, not a summarizing fetch. Supersedes the earlier
  // "Schießgefahrenbereich"/"Schießgefahrengebiet" dispute — neither was
  // ever BSH's actual term; this is.
  'seamark.value.category.firing_danger_area': 'Militärisches Übungsgebiet',
  // #300 F3: "unreiner Grund" per the BSH/INT-1 legend (Karte 1 / INT 1):
  // "Unr.; Unrein; Unreiner Grund / Foul" — "Hindernisgrund" was an invented
  // compound, not chart usage.
  'seamark.value.category.foul_ground': 'unreiner Grund',
  'seamark.value.category.lanby': 'Großtonne (LANBY)',
  // #300 F5/F10: NOT "Richtfeuerlinie" — that wrongly conflates "Feuer"
  // (implies LIT) with "-linie" (the navigational LINE, not the mark). The
  // BSH legend (see `clearing` above) confirms "Richtfeuer" = "Leading
  // lights" (lit only) and "Richtlinie" = "Leading line" (the line, not the
  // mark) — neither fits a mark that can be either. "Richtbake" is
  // attested as "leading mark" by DWDS and de.wikipedia's "Bake
  // (Seezeichen)" article (a pair of beacons whose extended connecting
  // line indicates the course — exactly what `category=leading` tags),
  // and is type-correct for all 64 shipped features (every one is a
  // beacon_special_purpose). Honest sizing of the lit/unlit picture (F10
  // corrected an earlier overclaim here): "Bake" conventionally denotes an
  // UNLIT fixed mark, so "Richtbake" leans unlit in the same direction
  // "Richtfeuer" leans lit — it is a defensible compromise, not a neutral
  // term. Measured on the shipped data: 53 of the 64 `leading` features
  // DO carry a lightCharacter (most are in fact lit) — "Richtfeuer" would
  // only be wrong for the remaining 11, not for "unlit beacons" as a class.
  // "Richtbake" is chosen because it is structurally correct for all 64
  // (they are all beacons), where "Richtfeuer" would be wrong for those 11.
  //
  // KNOWN FORM INCONSISTENCY (see `clearing` above): this is a mark NOUN,
  // while `clearing`'s "Gefahrenpeilung" names a bearing/concept —
  // deliberate, not an oversight; German has no attested clearing-mark
  // noun to make the two forms uniform.
  'seamark.value.category.leading': 'Richtbake',
  // #300 F5: German Wikipedia's own article for "marine farm" is titled
  // "Marikultur" (de.wikipedia.org/wiki/Meeresfarm redirects there) — the
  // established term, "Meeresfarm" is the lay/colloquial one.
  'seamark.value.category.marine_farm': 'Marikultur',
  // #300 F5: maintainer decision — "Muring" (dropping "-platz", which named
  // the place rather than the ground-tackle/mooring-buoy system the tag
  // actually denotes).
  'seamark.value.category.mooring': 'Muring',
  'seamark.value.category.no_entry': 'Sperrgebiet',
  'seamark.value.category.north': 'Nord',
  'seamark.value.category.notice': 'Hinweis',
  'seamark.value.category.odas': 'Messboje (ODAS)',
  'seamark.value.category.pipeline': 'Pipeline',
  'seamark.value.category.port': 'Backbord',
  'seamark.value.category.preferred_channel_port': 'Hauptfahrwasser Backbord',
  'seamark.value.category.preferred_channel_starboard': 'Hauptfahrwasser Steuerbord',
  'seamark.value.category.recording': 'Messstation',
  'seamark.value.category.recreation_zone': 'Freizeitzone',
  'seamark.value.category.recreational': 'Freizeit',
  'seamark.value.category.south': 'Süd',
  'seamark.value.category.starboard': 'Steuerbord',
  // #300 F5: maintainer decision — "Zieltonne" ("Zielscheibe" reads as a
  // dartboard/shooting-range target, not a floating nautical mark).
  'seamark.value.category.target': 'Zieltonne',
  'seamark.value.category.unknown_purpose': 'Unbekannter Zweck',
  'seamark.value.category.warning': 'Warnung',
  'seamark.value.category.wave_recorder': 'Wellenmessboje',
  'seamark.value.category.west': 'West',
  'seamark.value.category.yachting': 'Sportschifffahrt',
  'seamark.value.colour.black': 'Schwarz',
  'seamark.value.colour.green': 'Grün',
  'seamark.value.colour.grey': 'Grau',
  'seamark.value.colour.orange': 'Orange',
  'seamark.value.colour.red': 'Rot',
  'seamark.value.colour.white': 'Weiß',
  'seamark.value.colour.yellow': 'Gelb',
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
  // #251: der Steuerkurs ist eine Peilung zum aktiven Wegpunkt, kein
  // tiefengeprüfter Kurs. Behauptet nie, der Kurs sei sicher.
  'live.hts.depthCaution':
    'Peilung kreuzt {depth} m — flacher als deine Sicherheitstiefe ({safety} m)',
  // Land ist eine andere Gefahr als flaches Wasser, und die Maske kodiert es
  // als Tiefe 0,0 m — „kreuzt 0.0 m“ würde es als Lotung ausgeben.
  'live.hts.landCaution': 'Peilung kreuzt kartiertes Land',
  'live.hts.depthUnchecked': 'Tiefe nicht geprüft',
  'live.gpsHint':
    'Standortzugriff ist nicht verfügbar, daher kann die Bootsposition nicht auf der Karte angezeigt werden. Planung und die gespeicherte Route funktionieren weiterhin uneingeschränkt — dies ist eine Törnplanungshilfe, kein Navigationsgerät.',
  'live.gpsHint.dismiss': 'Verstanden',
  // #361: siehe englisches Dict für den Hintergrund.
  'live.ownship.marker': 'Aktuelle Bootsposition',
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
  // #299: kurz gehalten, kürzer sogar als "Routen" — vermeidet die 280px-
  // Enge, die für eine Tab-Option gegen ein Wort wie "Einstellungen" spräche.
  'nav.boat': 'Boot',
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
  'about.caveats.depthMask':
    'Die Tiefenwerte mischen zwei Lesarten derselben EMODnet-Bathymetriedaten: Die geglättete Lesart wird nur dort verwendet, wo sie mit der vorsichtigeren auf 0,9 m genau übereinstimmt, sodass der von der App verwendete Tiefenwert nie mehr als 0,9 m tiefer ist als die vorsichtigere Lesart — das beschreibt die Quelldaten, nicht den tatsächlichen Meeresgrund. Eine Zelle, durch die bei Sicherheitstiefe G geplant wird, hat eine vorsichtige Lesart von mindestens G − 0,9 m: 2,1 m, der Tiefgang, bei der Standardtiefe von 3,0 m — aber nur 1,2 m, wenn eine Route auf eine geringere Tiefenschwelle zurückfällt, um verbunden zu bleiben; das wird auf der betroffenen Route markiert.',
  'about.dataSize':
    'Der erste Aufruf lädt ca. 44 MB (Basiskarte und Routendaten) herunter; spätere Aufrufe werden aus dem Cache bedient und funktionieren offline.',
  'about.sources.heading': 'Datenquellen',
  'about.sources.protomaps': 'Kartendarstellung: Protomaps',
  'about.sources.osm': '© OpenStreetMap-Mitwirkende (ODbL)',
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
  'ais.status.off': 'AIS aus — Schlüssel in den Optionen eingeben',
  'ais.status.connecting': 'AIS verbindet…',
  'ais.status.live': 'AIS live · {count} Schiffe',
  'ais.status.offline': 'AIS offline',
  'ais.status.keyError': 'AIS: API-Schlüssel prüfen',
  'ais.status.liveRoute': 'AIS live · {count} Schiffe ({routeCount} entlang Route)',
  // #155: north-arrow / track-up compass. One label per state, carrying both
  // the current orientation AND the action a tap performs (no aria-pressed:
  // a tri-state cycle is not a binary toggle). Degrees never appear here.
  'map.compass.northUp': 'Kartenausrichtung: Norden oben. Kursorientierung aktivieren',
  'map.compass.northUp.noTrack':
    'Kartenausrichtung: Norden oben. Kursorientierung ohne GPS-Kurs nicht verfügbar',
  'map.compass.trackUp': 'Kartenausrichtung: Kurs oben. Auf Norden oben umschalten',
  'map.compass.trackUp.stale':
    'Kartenausrichtung: Kurs oben (letzter Kurs wird gehalten). Auf Norden oben umschalten',
  'map.compass.free': 'Karte manuell gedreht. Auf Norden oben zurücksetzen',
  'map.compass.unavailableStatus': 'Kursorientierung nicht verfügbar – keine GPS-Position in Fahrt',
  // #155: nautical scale bar. The visible label uses the chart abbreviation;
  // the aria-label spells the unit out (screen readers mangle "kbl"/"sm").
  'map.scale.aria': 'Maßstab: {distance} {unit}',
  'map.scale.unit.nm': 'sm',
  'map.scale.unit.cbl': 'kbl',
  'map.scale.unit.m': 'm',
  'map.scale.unit.nm.one': 'Seemeile',
  'map.scale.unit.nm.other': 'Seemeilen',
  'map.scale.unit.cbl.one': 'Kabellänge',
  'map.scale.unit.cbl.other': 'Kabellängen',
  'map.scale.unit.m.one': 'Meter',
  'map.scale.unit.m.other': 'Meter',
} as const;
export type MsgKey = keyof typeof de;
