// Hand-written declarations for wave-fixture.mjs so the builder can be
// imported from typechecked Vitest specs. Keep in sync with wave-fixture.mjs.
export declare const N_LATS: number;
export declare const N_LONS: number;
export declare const N_HOURS: number;
export declare const E2E_NULL_POINT: readonly [number, number];
export declare const NULL_POINTS: readonly (readonly [number, number])[];

export declare function buildWaveFixture(startS: number): {
  hourly: {
    time: number[];
    wave_height: (number | null)[];
    wave_direction: (number | null)[];
    wave_period: (number | null)[];
  };
}[];
