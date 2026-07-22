import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OwnshipMarker from './OwnshipMarker';
import BoatMarker from './BoatMarker';
import type { GpsFix } from '../services/geolocation';

// BoatMarker itself is "not unit-tested" (jsdom has no MapLibre/WebGL
// runtime, per its own docstring) — it renders null and only does real work
// via useMapInstance()/imperative MapLibre calls. Mocked here with a
// detectable stub so OwnshipMarker's own contract — "render BoatMarker with
// these exact props when a fix is present, nothing when it's null" — is
// observable without a real map. vi.mock is hoisted above these imports by
// Vitest, so OwnshipMarker's own `import BoatMarker from './BoatMarker'`
// resolves against this mock regardless of import order.
vi.mock('./BoatMarker', () => ({
  default: vi.fn((props: Record<string, unknown>) => (
    <div
      data-testid="ownship-boat-marker"
      data-cog={String(props.cogDeg)}
      data-hts={String(props.headingToSteerDeg)}
      data-accuracy={String(props.accuracyM)}
      data-lat={String((props.point as { lat: number }).lat)}
      data-lon={String((props.point as { lon: number }).lon)}
    />
  )),
}));

const FIX: GpsFix = { point: { lat: 54.79, lon: 9.43 }, cogDeg: 91.4, sogKn: 6.3, accuracyM: 12 };

describe('OwnshipMarker', () => {
  it('renders nothing when fix is null (toggle off, or no fix yet)', () => {
    render(<OwnshipMarker fix={null} />);
    expect(screen.queryByTestId('ownship-boat-marker')).not.toBeInTheDocument();
    expect(BoatMarker).not.toHaveBeenCalled();
  });

  it('renders BoatMarker with the fix forwarded verbatim when a fix is present', () => {
    render(<OwnshipMarker fix={FIX} />);
    const el = screen.getByTestId('ownship-boat-marker');
    expect(el).toHaveAttribute('data-lat', '54.79');
    expect(el).toHaveAttribute('data-lon', '9.43');
    expect(el).toHaveAttribute('data-cog', '91.4');
    expect(el).toHaveAttribute('data-accuracy', '12');
    // cogDeg is present, so it (not the fallback) is what's passed as the
    // rotation fallback prop too.
    expect(el).toHaveAttribute('data-hts', '91.4');
  });

  it('falls back headingToSteerDeg to 0 when the device reports no COG', () => {
    render(<OwnshipMarker fix={{ ...FIX, cogDeg: null }} />);
    const el = screen.getByTestId('ownship-boat-marker');
    expect(el).toHaveAttribute('data-cog', 'null');
    expect(el).toHaveAttribute('data-hts', '0');
  });
});
