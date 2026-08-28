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
  // #699: der zulässige Bereich hing bislang nur als natives min/max-Attribut
  // am Feld, ohne sichtbaren oder für Screenreader zugänglichen Text — ein
  // außerhalb liegender Wert wurde beim Verlassen des Felds stillschweigend
  // auf den nächsten gültigen Wert korrigiert. {min}/{max} kommen aus
  // safetyDepthFieldFor(boat), ist also je nach Boot unterschiedlich.
  'options.safetyDepth.help': 'Erlaubter Bereich: {min}–{max} m',
  // #731: the sibling, generic notice for the blur-clamp ITSELF (not the
  // disclosure at options.safetyDepth.help above) — shared by all eight
  // NumberInput sites (safety depth here + SettingsPanel's seven
  // NumericField instances), so it deliberately carries NO unit: each
  // field's own label already has one in parentheses ("Sicherheitstiefe
  // (m)", "Motorfahrtgeschwindigkeit (kn)", …).
  'numberInput.corrected': 'Auf {value} korrigiert (zulässiger Bereich {min}–{max})',
  // #299: die Sicherheitstiefe erscheint jetzt an ZWEI Stellen — hier als
  // Schnellzugriff und im Boot-Tab (SettingsPanel) als kanonisches Zuhause,
  // eine gemeinsame Quelle (PR #486 review). Die Tiefenkomfort-Spanne und
  // die übrigen Boot-Einstellungen wohnen weiterhin AUSSCHLIESSLICH dort —
  // dieser Link verhindert, dass jemand sie für gelöscht hält, weil sie
  // nicht mehr direkt neben der Sicherheitstiefe steht. Nicht mehr "&", weil
  // die Sicherheitstiefe (rechts daneben sichtbar) nicht mehr exklusiv dort
  // wohnt — "weitere" statt einer Aufzählung, mit der Komfort-Spanne als
  // konkretem Anker.
  'planner.safetyDepth.boatLink': 'Weitere Boot-Einstellungen (u. a. Tiefenkomfort-Spanne)',
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
  // #54: Bootsauswahl (BoatPicker im Boot-Tab).
  'boat.section.title': 'Bootsauswahl',
  'boat.picker.label': 'Boot auswählen',
  'boat.draft': 'Tiefgang {depth} m',
  // Spec G.3: Herkunftsstufen der Polardaten. Bewusst keine Buchstaben
  // (A/B/C) im Text — die Stufenbuchstaben sind Spec-interne Bezeichner und
  // sagen einer Seglerin nichts; das Wort selbst schon.
  'boat.polarTier.certificate': 'Zertifikat',
  'boat.polarTier.modelled': 'Modelliert',
  'boat.polarTier.estimated': 'Geschätzt',
  'boat.polarTier.aria': 'Polardaten: {tier}',
  'boat.polarDetail.summary': 'Polardaten & Herkunft',
  // Spec N.2. „Geprüft“, nicht „verifiziert“: Spec N.5 verbietet in neuen
  // Texten die Register-Wörter genau/verifiziert/zuverlässig/sicher.
  'boat.keel.assumed':
    'Angenommener Kiel: {keel}. Nicht anhand der Papiere dieses Schiffs geprüft.',
  // Spec C.7: nach oben geklemmt, gespeichert — und angesagt. Nur nach oben.
  'boat.clamp.notice': 'Sicherheitstiefe auf {depth} m angehoben – Mindestwert für {boat}.',
  // #299: Abschnittsüberschriften im Boot-Tab (SettingsPanel).
  'settings.section.boatSafety': 'Boot & Sicherheit',
  'settings.section.propulsion': 'Antrieb',
  'settings.section.liveAis': 'Live & AIS',
  // #353 PR2: Kartenanzeige-Regler für Seezeichen (Größe + Anzeigekategorie).
  'settings.section.mapDisplay': 'Kartenanzeige',
  'settings.seamarkSize.label': 'Symbolgröße (Seezeichen)',
  'settings.seamarkSize.value': '{percent} %',
  'settings.seamarkSize.help':
    'Ändert die Anzeigegröße der Seezeichen-Symbole auf der Karte. Unterhalb von Zoomstufe 12 skaliert der Kollisionsabstand mit den Symbolen; bei höheren Zoomstufen überlappen sich größere Symbole stärker.',
  'settings.seamarkCategory.label': 'Angezeigte Seezeichen',
  'settings.seamarkCategory.base': 'Basis',
  'settings.seamarkCategory.standard': 'Standard',
  'settings.seamarkCategory.all': 'Alle',
  'settings.seamarkCategory.help':
    'Kardinal-, Lateral- und Mitte-Fahrwasser-Zeichen, Einzelgefahrenzeichen sowie Leuchttürme werden immer angezeigt, auch bei „Basis“. „Standard“ (Voreinstellung) zeigt alles, einschließlich Unterwasserkabeln und Pipelines. „Alle“ zeigt derzeit dasselbe wie „Standard“.',
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
  // #340/#54: phase readout, not a percentage — the router solves
  // request.sailIds SEQUENTIALLY, so "Segel {index} von {total}" ({sail}
  // already localized via sailLabelKey) is honest and bounded, unlike the
  // removed percentage.
  'planner.status.routingSail': 'Route wird berechnet… Segel {index} von {total} ({sail})',
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
    'Routenplanung unerwartet fehlgeschlagen. Bei wiederholtem Auftreten die App neu laden.',
  // #662: RouteSummary.tsx's fallback for a SAVED plan whose stored no-route
  // reason cannot be trusted (PR #656 / #614 made `reason` fall back to
  // `null` for a value outside the NoRouteReason union). This render site is
  // reached only when viewing an already-saved plan, never while live-
  // planning — "Erneut versuchen"/"App neu laden" would both be futile here
  // (a retry re-runs planning, which this screen isn't doing; a reload
  // changes nothing about what a stored record contains), so unlike
  // error.internal above this key names the one thing that DOES help:
  // planning the route again. App.tsx's RETRY_MAY_HELP_KEYS mechanism is not
  // involved — this key never reaches the live-planning Retry button.
  'error.savedPlanUnreadable':
    'Das Ergebnis dieses gespeicherten Plans konnte nicht gelesen werden. Route neu planen, um ein aktuelles Ergebnis zu erhalten.',
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
  // #553 / spec §I.3: der eine typisierte Fehler, bei dem weder „Erneut
  // versuchen" noch „App neu laden" hilft — beides ändert nichts am Katalog.
  // Der Satz nennt deshalb stattdessen, wie eng der Verlust ist: die
  // gespeicherte Route bleibt vollständig lesbar und exportierbar, nur eine
  // Neuberechnung ist nicht möglich. Siehe dict.en.ts.
  'error.boatNotInCatalogue':
    'Diese Route wurde für ein Boot geplant, das nicht mehr verfügbar ist, und kann deshalb nicht neu berechnet werden. Die gespeicherte Route lässt sich weiterhin öffnen, ansehen und exportieren.',
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
    'Ein Wegpunkt ist nicht befahrbar — einen Punkt mindestens 300 m von Land oder Flachwasser wählen.',
  // #432: die Suche wurde abgebrochen, BEVOR sie fertig war — anders als die
  // übrigen error.noRoute.*-Texte ist das ausdrücklich keine Aussage darüber,
  // ob es eine Route gibt.
  'error.noRoute.searchBudget':
    'Die Routenberechnung hat ihr Zeitlimit erreicht, bevor sie fertig war — das heißt nicht, dass es keine Route gibt. Ein näheres Ziel, weniger Wegpunkte oder eine kleinere Tiefen-Komfortspanne helfen; ein schnelleres Gerät ebenfalls.',
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
  // Fallback label for a stored sail id the current catalogue no longer
  // knows (lib/resultSummary.ts's sailLabelKey). Names the sail as unknown
  // rather than rendering an empty string or the literal 'undefined'.
  'route.rig.unknown': 'Unbekanntes Segel',
  'route.rigTabs': 'Riggvergleich',
  'route.recommended': 'Empfohlen',
  'route.fasterRig': 'Schneller: {rig}',
  // #259: honest copy for the two cases where badging one rig as
  // "recommended" would be misleading — an ETA tie (too close to call) and
  // an all-motor route (the polar never drove a leg, so rig choice is moot).
  // #578: parameterised — the two names used to be hardcoded "Genua und
  // Fock", correct only because every catalogue boat's foresail happens to
  // use those two ids. lib/resultSummary.ts's renderRigVerdict resolves
  // both slots from the PLAN's own compared sails (solve order), through
  // the same sailLabelKey every other rig-facing string uses.
  'route.rigTie': '{sailA} und {sailB} liegen für diese Passage praktisch gleichauf',
  'route.rigMoot': 'Riggwahl spielt hier keine Rolle — die Passage läuft durchgehend unter Motor',
  // #553 / spec §N.4: schwächere Aussage als rigTie oben — dort ist ein
  // Vergleich gelaufen und endete unentschieden, hier hat gar keiner
  // stattgefunden. Siehe dict.en.ts für die drei auslösenden Fälle.
  'route.rigNotCompared':
    'Die Segel wurden für diese Passage nicht verglichen — es wird kein schnelleres Rigg angegeben',
  // #540 spec §E.3: a budget-exhausted sail is ALSO a 'not-compared' verdict
  // (rigVerdictKey collapses onto route.rigNotCompared above), but a stalled
  // search reads very differently from "nothing to compare" — the ★-suppressed
  // recommendation is still computed over one completed sail only, and this
  // sentence is what stops that from being misread as a finished two-sail
  // comparison. Rendered instead of rigNotCompared exactly when
  // PlanResultOk.comparisonComplete is false; see dict.en.ts for the derived
  // MsgKey helper (resultVerdictKey in lib/resultSummary.ts).
  'route.comparisonIncomplete':
    'Die Suche wurde durch Zeitüberschreitung abgebrochen, bevor beide Segel verglichen werden konnten — es wird kein schnelleres Rigg angegeben',
  // #748: see dict.en.ts for the full rationale (conventional "> Nh" age
  // shorthand, the model-reference-time blocker, and why this is Option 3).
  // PR #763 review Major 3: "bei Abfahrt" added — same fix as the English
  // "at departure", see dict.en.ts's comment for why the bare form was
  // factually wrong.
  'route.staleForecast': 'Vorhersage bei Abfahrt > 12 h alt',
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
  // #504 Korrekturwelle 4: von EINEM dichten Absatz zu drei Teilen innerhalb
  // EINER role="alert"-Region restrukturiert (ShallowWarning,
  // RouteSummary.tsx: ein <div> mit .lead/.detail/.caveat-Kindern) — führt
  // mit der schwerwiegendsten, handlungsrelevanten Tatsache (der
  // Untergrenze), statt alles gleich stark zu betonen. Sätze umzuordnen ist
  // NICHT automatisch sicher: Korrekturwelle 6 fand, dass leads ursprüngliches
  // "derselben Tiefendaten" eine ANAPHER war, die auf {minGate} zurückwies —
  // und {minGate} lebt jetzt in .detail, UNTER dem lead. Die Schlagzeile
  // einer Sicherheitswarnung verwies auf etwas, das die Leserin noch nicht
  // gesehen hatte. Behoben, indem "der Kartentiefen" direkt benannt wird,
  // statt darauf zu verweisen. Jede satzübergreifende Referenz zu prüfen ist
  // jetzt ein PFLICHTSCHRITT bei jeder künftigen Umordnung hier, keine
  // Annahme — .detail und .caveat wurden ebenfalls geprüft (Welle 6) und
  // tragen keine solche Referenz (beide sind in sich geschlossen: "diese
  // Route"/"diese Warnung" sind deiktisch auf die gesamte Warnung bezogen,
  // nicht positionsabhängig). lead/leadSevere tragen IMMER die
  // #493-Untergrenzen-Klausel; leadSevere fügt zusätzlich die
  // Bootstiefgang-Klausel an (nicht "Tiefgang des Boots von {draft} m" — das
  // "von" hing dort mehrdeutig). "Achtung:" ist von detail hierher
  // gewandert, da lead jetzt der prominenteste Teil ist.
  'route.shallow.lead':
    'Achtung: Eine vorsichtigere Lesart der Kartentiefen kann bis auf {cautious} m sinken.',
  'route.shallow.leadSevere':
    'Achtung: Eine vorsichtigere Lesart der Kartentiefen kann bis auf {cautious} m sinken — unter den Bootstiefgang von {draft} m.',
  // #516 Zuwachs 1: siehe dict.en.ts's Kommentar für Zweck, Herkunft und
  // Anaphern-Disziplin (rein präsentativ, in RouteSummary.tsx zur Laufzeit
  // gegen die geladene Maske berechnet, nie in PlanResult gespeichert) —
  // einschließlich der Begründung, warum "Bis zu" / "Up to" entfällt.
  // Die beiden deutschen Fragen sind in der Durchsicht von PR #523 (Minor 4)
  // entschieden, nicht mehr offen: PLURAL "verlaufen" bleibt, weil formatNm
  // immer eine Dezimalzahl liefert ("0.3 nm"), die Seemeilen im Plural
  // verlangt — der Singular wäre nur für "eine Seemeile" richtig, was dieser
  // Code nie erzeugen kann. "durch Wasser" statt "in Wasser", weil
  // "verlaufen in" + Flüssigkeit die Alltagsbedeutung von zerlaufender Farbe
  // trägt.
  'route.shallow.exposure':
    '{dist} dieser Route verlaufen durch Wasser, das flacher als die eingestellte Sicherheitstiefe von {requested} m kartiert ist.',
  // PR #763 review Blocker 2: the plan's ACTUAL used gate, stated on its own
  // (never bundled with requested/minGate as route.shallow.detail already
  // does) so it can render in the Disclosure's always-visible SUMMARY — the
  // most consequential number in this warning must be visible without
  // opening anything.
  'route.shallow.usedDepth': 'Geplant mit einer Sicherheitstiefe von {used} m.',
  // #516 Zuwachs 2 (setzt #518 voraus): siehe dict.en.ts's Kommentar für
  // Zweck, Messung statt Annahme, Reihenfolge und Anaphern-Disziplin.
  // "eingestellte Sicherheitstiefe" statt des Entwurfsdokuments "eingestellte
  // Tiefe", zur Angleichung an .exposure oben und .detail unten, die
  // denselben Begriff schon zweimal in dieser Datei verwenden.
  'route.shallow.confined':
    'Jeder Abschnitt unterhalb der eingestellten Sicherheitstiefe liegt im Umkreis von {radius} um Start, Ziel oder Wegpunkte.',
  // #516: die explizite Produktentscheidung des Maintainers (im
  // #516-Entwurfsdokument bewusst UNEMPFOHLEN gelassen, "eine
  // Maintainer-Entscheidung, markiert statt entworfen" — inzwischen
  // entschieden). Zuletzt in .detail gerendert, nach dem Mechanismus-Satz,
  // auf den er antwortet (PR #523, Minor 3). In RouteSummary.tsx an drei
  // Bedingungen gekoppelt — `showRemedy`: dieselbe gemessene Exposition
  // größer als null wie die Zahl davor, das breite Layout, und usedDepthM
  // über SAFETY_DEPTH_FIELD.min. Die Begründung zu jeder einzelnen steht an
  // dieser Deklaration; sie ist die einzige Stelle zum Nachlesen und Ändern.
  'route.shallow.remedy':
    'Eine geringere Sicherheitstiefe könnte dem Planer helfen, eine direktere Route zu finden.',
  // Was passiert ist: die eingestellte Sicherheitstiefe war nicht
  // passierbar, die tatsächlich verwendete Tiefe, die geringste gequerte
  // Kartentiefe. Normale Textstärke (nicht mehr hervorgehoben) — siehe
  // dict.en.ts's Kommentar für den vollen Hintergrund ({used} < {requested},
  // {minGate} als Plan-weite Angabe).
  'route.shallow.detail':
    'Mit der eingestellten Sicherheitstiefe von {requested} m wurde keine durchgehende Route gefunden — diese Route wurde daher mit einer reduzierten Tiefe von {used} m geplant. Geringste von diesem Plan gequerte Kartentiefe: {minGate} m.',
  // #452 gap 3: siehe dict.en.ts's Kommentar für Zweck und Konvention
  // (Singular/`.plural`, wie banner.viaTooClose(.plural)). An .detail
  // angehängt (die "was passiert ist"-Aussage, zu der diese Ortsangabe
  // gehört), nicht an .lead oder .caveat.
  'route.shallow.locator': 'Die betroffene Etappe beginnt um {time}.',
  'route.shallow.locator.plural': '{count} Etappen sind betroffen — die erste beginnt um {time}.',
  // Die Kartengenauigkeits-Einschränkung — visuell sekundär (kleinere
  // Schrift), aber NIE hinter einem Klick verborgen: eine
  // Sicherheitsaussage über die Grenzen der obigen Warnung, in einer App
  // ohne eigene Kartenautorität.
  'route.shallow.caveat':
    'Kartendaten können reale Tiefen sowohl unter- als auch überschätzen, daher ist diese Warnung nicht vollständig: Ein Abschnitt ohne Warnung ist nicht garantiert frei von Untiefen. Markierte Abschnitte mit amtlicher Seekarte und Echolot prüfen.',
  // #612: siehe dict.en.ts's Kommentar für Zweck, Auslöser, Eskalation und
  // die beiden Klauseln, die hier bewusst FEHLEN. Formulierung an bereits
  // ausgelieferte, geprüfte Kopie angelehnt: "eine vorsichtigere Lesart der
  // Kartentiefen" ist wörtlich aus route.shallow.lead oben, und "unter den
  // Bootstiefgang von {draft} m" wörtlich aus route.shallow.leadSevere (deren
  // Kommentar erklärt, warum nicht "Tiefgang des Boots von"). PLURAL
  // "verlaufen" wie in route.shallow.exposure, aus demselben Grund: formatNm
  // liefert immer eine Dezimalzahl, die Seemeilen im Plural verlangt.
  // Bewusst NICHT "derselben Tiefendaten" — CLAUDE.md führt genau dieses Wort
  // als Anaphern-Defekt (#493/#504); "der Kartentiefen" benennt den Bezug
  // direkt und bleibt aus jeder Position heraus richtig.
  'route.marginal.notice':
    '{dist} dieser Route verlaufen durch Wasser, das eine vorsichtigere Lesart der Kartentiefen unter die eingestellte Sicherheitstiefe von {requested} m setzt.',
  'route.marginal.noticeSevere':
    'Achtung: {dist} dieser Route verlaufen durch Wasser, das eine vorsichtigere Lesart der Kartentiefen unter die eingestellte Sicherheitstiefe von {requested} m setzt — bei dieser Einstellung kann diese Lesart unter den Bootstiefgang von {draft} m fallen.',
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
  // #651: siehe dict.en.ts's Kommentar für Zweck und Herkunft (das
  // render-seitige Gegenstück zu shallowMarker oben, für eine Etappe, die
  // der Planer NICHT gelockert hat). {depth} ist hier die kartierte
  // Maskenlesart, auf oder über dem angeforderten Gate — "Untiefe" wäre
  // falsch, da die kartierten Daten diese Zelle nicht unter das Gate
  // stellen; nur die vorsichtigere #493-Lesart derselben Zelle kann das
  // (isMarginalDepthM, lib/shallowExposure.ts's eigenes #612-Kriterium, pro
  // Etappe angewandt). "Grenzwertig" benennt diesen Unterschied.
  'route.legs.marginalMarker': 'Grenzwertig {depth} m',
  // #493/#504: vorsichtige Untergrenze derselben Zelle, NEBEN der obigen
  // Marke gerendert (nie ersetzend) — siehe cautiousDepthLowerBoundM in
  // app/src/lib/mask.ts für die Herleitung. Als GEFAHR formuliert, nicht als
  // Komfort-Untergrenze — "≥ {depth} m vorsichtig" hing "vorsichtig" als
  // Adverb hinter die Zahl (unidiomatisch) und las sich neben dem "kann bis
  // auf … sinken" des Banners für denselben Sachverhalt beruhigend;
  // "bis auf ... m" benennt dieselbe Gefahr konsistent in beiden Texten.
  'route.legs.shallowCautious': 'vorsichtig: bis auf {depth} m',
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
  'route.legend.via': 'Wegpunkt',
  // #651 fix-wave, MAJOR 1: siehe dict.en.ts's Kommentar für die vollständige
  // Begründung (die alte Formulierung war für die neue MARGINAL-Population
  // sachlich falsch, da diese per Definition auf oder über dem Gate kartiert
  // ist).
  'route.legend.shallow': 'Vorsichtige Tiefenlesart unter Sicherheitstiefe',
  // #324: map-only overlay of the rig NOT currently shown as the primary
  // route (dashed, reduced opacity — see RouteLayer.tsx's setupLayers).
  'route.legend.altRig': 'Anderes Rigg (gestrichelt)',
  'route.exportGpx': 'GPX exportieren',
  'route.windBarbs.toggle': 'Windpfeile anzeigen',
  'route.windBarbs.timeSlider': 'Vorhersagezeitpunkt',
  'route.annotations.toggle': 'Zeiten & Geschwindigkeiten',
  'route.altRig.toggle': 'Anderes Rigg anzeigen',
  'route.altRig.unavailable': 'Nur ein Rigg hat eine Route gefunden',
  // #628: summary label for the Disclosure wrapping the whole map-overlay
  // controls cluster (annotation/barb/alt-rig toggles, forecast slider,
  // legend) — collapsible so it stops obstructing the chart on mobile.
  'route.controls.summary': 'Anzeigeoptionen',
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
  // #512 review F8: the exhaustive minimum is unavailable (defensively, when
  // a leg endpoint falls outside mask coverage) — an em dash plus a word so
  // it can never be mistaken for a measurement or for "0". Rendered INSTEAD
  // OF the number, never alongside it.
  'profile.minDepthUnknown': 'min. — unbekannt',
  // Deliberately terse: shares the narrow-viewport map-top row with the
  // plan-gated wind-barb toggle on the opposite side (app.css).
  'map.depth.toggle': 'Wassertiefen',
  // #598: Legende der #492-Schraffur (siehe dict.en.ts für die volle
  // Begründung — nie "flaches Wasser", die Schraffur ist ein Hinweis auf
  // eine vorsichtige Lesart, kein Flachwasser-Indikator).
  'map.depth.legend.title': 'Legende',
  'map.depth.legend.hatchLabel': 'Schraffur: vorsichtige Lesart',
  // PR #625 self-review Minor 3: the final clause's "sie" (feminine) bound to
  // "die Schraffur"/"die Farbe" — no reading reached the intended referent,
  // "das Wasser" (neuter). Replaced verbatim per the review's suggested fix;
  // English "it" was never gender-bound, so that half needed no change.
  'map.depth.legend.basis':
    'Die diagonale Schraffur markiert Wasser, bei dem die vorsichtigere der beiden Lesarten hinter der Farbüberlagerung unter Ihre Sicherheitstiefe fallen könnte — auch wenn die angezeigte Farbe noch unbedenklich wirkt. Sie kann auch Wasser markieren, das tatsächlich tief genug ist; dieser Kompromiss ist beabsichtigt, damit die Schraffur eher zu oft warnt, als das Wasser unbedenklich wirken zu lassen, obwohl es das vielleicht nicht ist.',
  // #597 — PR #625 self-review Major 1 (see dict.en.ts's own comment for the
  // full defect/derivation): "sieht genauso aus wie Land" was FALSE, in the
  // dangerous direction. Byte 0 gets no paint at all either way, so this
  // water renders as ordinary basemap blue, not anything land-coloured.
  'map.depth.legend.caveat':
    'Unvermessenes und trockenfallendes Wasser trägt ebenfalls keine Schraffur und ist durch nichts gekennzeichnet, sieht also aus wie gewöhnliches Wasser. Fehlende Schraffur ist keine Garantie, dass das Wasser unbedenklich ist — es kann sich schlicht um eine Stelle ohne Daten handeln.',
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
  // #54: shown for a stored plan the read-time normaliser cannot handle. Two
  // strings, because the two cases call for different user action, and prod
  // and /uat/ share one origin-scoped database, so a production user can meet
  // the newer-version case without having done anything wrong.
  //
  // Says only what the stored schemaVersion PROVES. It deliberately does not
  // promise the record is undamaged: the classification rests on that one
  // number, so a record both written by a newer build AND corrupted (partial
  // write, foreign tool) lands here too — and the row's only control is an
  // irreversible delete, so the copy must not overstate recoverability.
  'plansList.unreadable.newerVersion':
    'Dieser Plan wurde mit einer neueren Version der App gespeichert. Diese ältere Version kann ihn nicht lesen. Er bleibt gespeichert.',
  'plansList.unreadable.damaged':
    'Dieser Plan kann nicht geöffnet werden – der gespeicherte Datensatz ist unvollständig oder beschädigt. Er bleibt gespeichert.',
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
  'live.toggle': 'Live-Ansicht starten',
  'live.toggle.stop': 'Live-Ansicht beenden',
  'live.noPlan': 'Route laden oder planen, um die Live-Führung zu nutzen.',
  // #713: unused today (the sr-only expansion only renders in English, since
  // 'live.hts.label' below is already the full word) — kept for `satisfies`
  // parity, and a real translation rather than a placeholder in case that
  // gate ever changes.
  'live.hts.expansion': 'Steuerkurs',
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
  // #696: siehe die englische Zwillingsdatei für den Grund, warum dies ein
  // eigener Schlüssel ist statt 'about.close' wiederzuverwenden.
  'about.closeDialog': 'Dialog schließen',
  'about.version': 'Version {version}',
  'about.changelog.title': 'Was ist neu',
  'about.changelog.langNote': 'Das Änderungsprotokoll wird auf Englisch geführt.',
  'about.caveats.heading': 'Wichtige Hinweise',
  'about.caveats.polars':
    'Die Polardaten sind Schätzungen auf Basis ORC-artiger VPP-Daten, einstellbar über den Leistungsfaktor in den Optionen — nicht renngenau kalibriert.',
  // #539 / #54 Spec C.8 R5 + J OQ-2: siehe den Kommentar in dict.en.ts —
  // jede Zahl kommt jetzt aus dem AUSGEWÄHLTEN Boot (lib/depthDisclosure.ts).
  // formatDepthM liefert das deutsche Dezimalkomma, damit „2,1 m“ hier nicht
  // still zu „2.1 m“ wird.
  'about.caveats.depthMask':
    'Die Tiefenwerte mischen zwei Lesarten derselben EMODnet-Bathymetriedaten: Die geglättete Lesart wird nur dort verwendet, wo sie mit der vorsichtigeren auf {tolerance} m genau übereinstimmt, sodass der von der App verwendete Tiefenwert nie mehr als {tolerance} m tiefer ist als die vorsichtigere Lesart — das beschreibt die Quelldaten, nicht den tatsächlichen Meeresgrund. Eine Zelle, durch die bei Sicherheitstiefe G geplant wird, hat eine vorsichtige Lesart von mindestens G − {tolerance} m. Die Standard-Sicherheitstiefe für die {boat} beträgt {gate} m und ist so gewählt, dass diese Untergrenze nie unter den Tiefgang von {draft} m fällt — sie kann aber nur {floor} m betragen, wenn eine Route auf eine geringere Tiefenschwelle zurückfällt, um verbunden zu bleiben; das wird auf der betroffenen Route markiert.',
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
  // #571 redesign: triggered from App.tsx's handlePlan pre-check now (a
  // dedupeViaPoints call mirroring what usePlanFlow.ts's run() does
  // internally), not from a via-replan — the wording itself is unchanged.
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
  'ais.popup.age': 'Letztes Signal',
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
