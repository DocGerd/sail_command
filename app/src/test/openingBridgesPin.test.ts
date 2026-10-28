import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPENING_BRIDGES } from '../data/openingBridges';

// #1881: OPENING_BRIDGES is typed by hand; its span, name and URL come from
// the charted channel in pipeline/charted-channels.json.
interface ChannelFile {
  channels: {
    id: string;
    source: { bridge: { title: string; url: string } };
    centreline: { lat: number; lon: number; marks?: { seamarkIndex: number }[] }[];
  }[];
}

const file = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../pipeline/charted-channels.json'),
    'utf8',
  ),
) as ChannelFile;

const SPAN_LIGHTS = [2262, 2263, 2264, 2265];

describe('#1881 Kong Christian X bridge data matches pipeline/charted-channels.json', () => {
  it('span, name and URL equal the channel’s', () => {
    const channel = file.channels.find((c) => c.id === 'soenderborg-alssund');
    expect(channel, 'channel soenderborg-alssund').toBeDefined();
    const spanPoints = (channel?.centreline ?? []).filter((p) =>
      (p.marks ?? []).some((m) => SPAN_LIGHTS.includes(m.seamarkIndex)),
    );
    expect(spanPoints, 'the centreline point carrying the four span lights').toHaveLength(1);
    const bridge = OPENING_BRIDGES.find((b) => b.id === 'soenderborg-kong-christian-x');
    expect(bridge).toBeDefined();
    expect(bridge?.span).toEqual({ lat: spanPoints[0]!.lat, lon: spanPoints[0]!.lon });
    expect(bridge?.infoUrl).toBe(channel?.source.bridge.url);
    expect(bridge?.name).toBe(channel?.source.bridge.title);
  });
});
