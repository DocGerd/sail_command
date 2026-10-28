import type { LatLon } from '../types';

// #1881: bridges a route notice names. Curated, typed and bundled (data
// source B2 of the #1881 maintainer ruling): presentation-only, nothing here reaches
// routing. `test/openingBridgesPin.test.ts` pins span and URL to
// pipeline/charted-channels.json. Add an entry only for a bridge plans can
// reach; Kappeln and Egernsund are mask-disconnected.

export interface OpeningBridge {
  id: string;
  name: string;
  kind: 'bascule';
  /** Midpoint of the passage span. */
  span: LatLon;
  /** Roughly the width of the sound at the deck; a route crossing it passes the bridge. */
  passageLine: { a: LatLon; b: LatLon };
  /** Danske Havnelods page for the bridge: opening times and closures. */
  infoUrl: string;
}

export const OPENING_BRIDGES: readonly OpeningBridge[] = [
  {
    id: 'soenderborg-kong-christian-x',
    name: "Kong Christian X's Bro",
    kind: 'bascule',
    span: { lat: 54.9110026, lon: 9.7830141 },
    passageLine: {
      a: { lat: 54.9110026, lon: 9.7814541 },
      b: { lat: 54.9110026, lon: 9.7845741 },
    },
    infoUrl:
      'https://www.danskehavnelods.dk/Havnelodsen/bridges/aa6d840b-7664-4b3f-8b01-deec8d7c6e02.html',
  },
];
