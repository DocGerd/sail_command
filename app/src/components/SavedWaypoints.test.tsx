import 'fake-indexeddb/auto';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { __resetDbForTests, listWaypoints } from '../services/db';
import * as db from '../services/db';
import type { ViaPoint } from '../types';
import SavedWaypoints, { type SavedWaypointsProps } from './SavedWaypoints';

function renderSaved(props: Partial<SavedWaypointsProps> = {}) {
  localStorage.setItem('sc-lang', 'en');
  const onSelect = props.onSelect ?? vi.fn();
  return {
    onSelect,
    ...render(
      <I18nProvider>
        <SavedWaypoints viaPoints={props.viaPoints ?? []} onSelect={onSelect} />
      </I18nProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('SavedWaypoints (#848)', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('shows the empty state and the device-local disclosure with no saved waypoints', async () => {
    renderSaved();
    expect(await screen.findByText(/no saved waypoints/i)).toBeInTheDocument();
    // #848's own body requires device-local persistence be DISCLOSED, not
    // discovered — asserted unconditionally, not gated on any waypoint
    // existing.
    expect(screen.getByText(/stay on this device and browser only/i)).toBeInTheDocument();
  });

  it('offers a "save" action per current draft via point, and saving persists and lists it', async () => {
    const via: ViaPoint = { lat: 54.79, lon: 9.91, name: 'Ankerplatz' };
    renderSaved({ viaPoints: [via] });

    const saveButton = await screen.findByRole('button', {
      name: /Save Ankerplatz as a waypoint/i,
    });
    fireEvent.click(saveButton);

    // Persisted through the real service, not a UI mock.
    await vi.waitFor(async () => {
      const stored = await listWaypoints();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ name: 'Ankerplatz', lat: 54.79, lon: 9.91 });
    });

    // And re-renders into the saved-waypoints list.
    expect(await screen.findByText('Ankerplatz')).toBeInTheDocument();
  });

  it('an unnamed via point falls back to its formatted coordinates when saved — same fallback the via row itself uses', async () => {
    const via: ViaPoint = { lat: 54.5, lon: 9.5 };
    renderSaved({ viaPoints: [via] });

    fireEvent.click(await screen.findByRole('button', { name: /Save.*as a waypoint/i }));

    await vi.waitFor(async () => {
      const stored = await listWaypoints();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.name).toBe('54.500°N 9.500°E');
    });
  });

  it('selecting a saved waypoint calls onSelect with a plain {lat, lon, name} ViaPoint', async () => {
    await db.saveWaypoint({
      id: 'wp-1',
      name: 'Kalkgrund',
      lat: 54.85,
      lon: 10.0,
      createdAtMs: 1000,
    });
    const { onSelect } = renderSaved();

    const row = await screen.findByRole('button', { name: /Kalkgrund/ });
    fireEvent.click(row);

    expect(onSelect).toHaveBeenCalledWith({ lat: 54.85, lon: 10.0, name: 'Kalkgrund' });
  });

  it('two-tap delete removes a saved waypoint and refreshes to the empty state', async () => {
    await db.saveWaypoint({
      id: 'wp-1',
      name: 'Kalkgrund',
      lat: 54.85,
      lon: 10.0,
      createdAtMs: 1000,
    });
    renderSaved();

    const del = await screen.findByRole('button', { name: 'Delete waypoint' });
    fireEvent.click(del);
    expect(await screen.findByRole('button', { name: 'Confirm delete' })).toBeInTheDocument();
    // Single tap must not delete yet.
    expect(await listWaypoints()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));

    expect(await screen.findByText(/no saved waypoints/i)).toBeInTheDocument();
    expect(await listWaypoints()).toHaveLength(0);
  });

  it('lists saved waypoints newest-first', async () => {
    await db.saveWaypoint({ id: 'wp-a', name: 'First', lat: 1, lon: 1, createdAtMs: 1000 });
    await db.saveWaypoint({ id: 'wp-b', name: 'Second', lat: 2, lon: 2, createdAtMs: 2000 });
    renderSaved();

    const rows = await screen.findAllByRole('button', { name: /First|Second/ });
    expect(rows[0]).toHaveTextContent('Second');
    expect(rows[1]).toHaveTextContent('First');
  });

  it('a failed save shows an inline error and does not add a row', async () => {
    vi.spyOn(db, 'saveWaypoint').mockRejectedValueOnce(new Error('boom'));
    const via: ViaPoint = { lat: 54.5, lon: 9.5, name: 'Test' };
    renderSaved({ viaPoints: [via] });

    fireEvent.click(await screen.findByRole('button', { name: /Save Test as a waypoint/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed/i);
    expect(screen.queryByText('Test', { selector: '.waypoints-name' })).not.toBeInTheDocument();
  });
});
