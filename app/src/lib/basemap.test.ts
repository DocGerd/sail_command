import { describe, expect, it } from 'vitest';
import { BASEMAP_PATH, isBasemapArchivePath } from './basemap';

// #118: the deployed basemap archive ships as `.pmtiles.png` — image/png is
// the only content-type proven gzip-exempt AND Range-clean on the GitHub
// Pages/Fastly origin (application/octet-stream Range responses come back as
// un-inflatable slices of the COMPRESSED stream). The predicate below is what
// sw.ts's first-registered Range→206 route matches on; these literals pin its
// exact shape (mutation-honesty, #50).

describe('BASEMAP_PATH (#118 rename)', () => {
  it('is the renamed .png-masqueraded archive path', () => {
    expect(BASEMAP_PATH).toBe('data/basemap.pmtiles.png');
  });
});

describe('isBasemapArchivePath (sw.ts Range→206 route scoping)', () => {
  it('matches the renamed archive path', () => {
    expect(isBasemapArchivePath('/sail_command/data/basemap.pmtiles.png')).toBe(true);
  });

  it('still matches the legacy .pmtiles path (transition safety: an installed SW updating over the rename must own both shapes)', () => {
    expect(isBasemapArchivePath('/sail_command/data/basemap.pmtiles')).toBe(true);
  });

  it('never matches ordinary .png assets — the discriminator, NOT every .png', () => {
    expect(isBasemapArchivePath('/sail_command/icons/icon-512.png')).toBe(false);
  });

  it('never matches other data assets', () => {
    expect(isBasemapArchivePath('/sail_command/data/mask.bin')).toBe(false);
  });

  it('matches under the UAT sub-path deployment too', () => {
    expect(isBasemapArchivePath('/sail_command/uat/data/basemap.pmtiles.png')).toBe(true);
  });
});
