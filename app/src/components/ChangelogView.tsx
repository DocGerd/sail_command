import { useT } from '../i18n';
import type { ChangelogRelease } from '../lib/changelog';

export interface ChangelogViewProps {
  releases: ChangelogRelease[];
}

/**
 * #131: scrollable release-history list for the About dialog's "What's new"
 * disclosure. Content (versions, category names, entry texts) is the parsed
 * CHANGELOG.md and stays English by design — only the maintained-in-English
 * note is i18n'd. Issue/PR refs like "(#131)" render as plain text, NOT
 * links: the app must stay honest offline, and a dead GitHub link would
 * pretend connectivity.
 */
export default function ChangelogView({ releases }: ChangelogViewProps) {
  const t = useT();
  // An empty section (e.g. [Unreleased] right after a release cut rolled its
  // entries out) is parser-visible but pure noise on screen — skip it.
  const visible = releases.filter((r) => r.categories.some((c) => c.entries.length > 0));
  return (
    <div className="changelog-view">
      <p className="changelog-lang-note">{t('about.changelog.langNote')}</p>
      {visible.map((release) => (
        <section key={release.version} className="changelog-release">
          <h4>
            {release.version}
            {release.date !== null && <span className="changelog-date"> — {release.date}</span>}
          </h4>
          {release.categories
            // A stray empty `### Category` must not render an orphan heading
            // over a zero-item list (review r3640079372).
            .filter((category) => category.entries.length > 0)
            .map((category) => (
              <div key={category.name}>
                <h5>{category.name}</h5>
                <ul>
                  {category.entries.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            ))}
        </section>
      ))}
    </div>
  );
}
