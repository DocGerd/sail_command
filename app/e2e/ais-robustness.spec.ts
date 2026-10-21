import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { seedFreshProfileDefaults, startPreview } from './helpers';

// #1804: AIS robustness against a FAKE aisstream (page.routeWebSocket), so no
// real socket ever leaves the machine. The silence watchdog is driven with
// Playwright's page clock; the thresholds are the client's own constants.
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const NO_TRAFFIC_MS = 20_000;
const SILENCE_RECONNECT_MS = 180_000;

const OWN_MMSI = '211000999';

function classBPosition(mmsi: number, lat: number, lon: number, name: string): string {
  return JSON.stringify({
    MessageType: 'StandardClassBPositionReport',
    MetaData: { MMSI: mmsi, ShipName: name },
    Message: {
      StandardClassBPositionReport: {
        Latitude: lat,
        Longitude: lon,
        Sog: 5.2,
        Cog: 120,
        TrueHeading: 511,
      },
    },
  });
}

async function openSettingsAndTypeKey(page: Page, key: string): Promise<void> {
  await page.getByRole('tab', { name: 'Boot' }).click();
  await page.getByLabel('AIS-API-Schlüssel (aisstream.io)').fill(key);
}

test.beforeEach(async ({ page }) => {
  await seedFreshProfileDefaults(page);
});

test('#1804: without a key AIS opens no socket at all', async ({ page }) => {
  const server = await startPreview(page);
  try {
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Live' }).click();
    await expect(page.getByText(/^AIS aus/)).toBeVisible();
    expect(sockets).toEqual([]);
  } finally {
    server.kill();
  }
});

test('#1804: connected-no-traffic, a Class B target, own-boat dedupe and silence reconnect', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const server = await startPreview(page);
  try {
    const connections: WebSocketRoute[] = [];
    const subscriptions: Record<string, unknown>[] = [];
    await page.routeWebSocket(AIS_URL, (ws) => {
      connections.push(ws);
      ws.onMessage((message) => {
        subscriptions.push(JSON.parse(String(message)) as Record<string, unknown>);
      });
    });

    await page.goto(server.url);
    await page.clock.install();

    await openSettingsAndTypeKey(page, 'FAKE-KEY');
    await page.getByLabel('MMSI dieses Boots (optional)').fill(OWN_MMSI);
    await page.getByRole('tab', { name: 'Live' }).click();

    await expect.poll(() => connections.length).toBe(1);
    await expect.poll(() => subscriptions.length).toBe(1);
    expect(subscriptions[0]).toMatchObject({
      APIKey: 'FAKE-KEY',
      FilterMessageTypes: [
        'PositionReport',
        'ShipStaticData',
        'StandardClassBPositionReport',
        'ExtendedClassBPositionReport',
        'StaticDataReport',
      ],
    });

    // Open socket, nothing delivered: 'connecting' until the quiet threshold,
    // then the distinct no-traffic state, with no reconnect.
    await expect(page.getByText('AIS verbindet…')).toBeVisible();
    await page.clock.runFor(NO_TRAFFIC_MS);
    await expect(page.getByText('AIS verbunden · kein Verkehr im Ausschnitt')).toBeVisible();
    expect(connections).toHaveLength(1);

    // Traffic resumes: one Class B vessel plus the user's own transponder,
    // which must not be counted.
    connections[0].send(classBPosition(211000111, 54.82, 9.65, 'KLEINER FISCH'));
    connections[0].send(classBPosition(Number(OWN_MMSI), 54.83, 9.66, 'EIGENES BOOT'));
    await expect(page.getByText('AIS live · 1 Schiffe')).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(page.getByText('AIS live · 1 Schiffe')).toBeVisible();

    // A quiet sea first shows as no-traffic, and only a long silence recycles
    // the socket through the normal backoff.
    await page.clock.runFor(NO_TRAFFIC_MS);
    await expect(page.getByText('AIS verbunden · kein Verkehr im Ausschnitt')).toBeVisible();
    expect(connections).toHaveLength(1);
    await page.clock.runFor(SILENCE_RECONNECT_MS);
    await expect.poll(() => connections.length).toBe(2);
    await expect.poll(() => subscriptions.length).toBe(2);
  } finally {
    server.kill();
  }
});
