import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import SailAboardControl from './SailAboardControl';
import { de } from '../i18n/dict.de';
import type { SailId } from '../data/boats';

const BOTH: readonly SailId[] = ['genoa', 'fock'];

function renderControl(props: Partial<Parameters<typeof SailAboardControl>[0]> = {}) {
  cleanup();
  const onChange = vi.fn();
  const { container } = render(
    <SailAboardControl catalogueIds={BOTH} aboard={BOTH} onChange={onChange} {...props} />,
  );
  const group = screen.queryByRole('group', { name: de['boat.sailsAboard.group'] });
  const button = (name: string) => within(group as HTMLElement).getByRole('button', { name });
  return { onChange, container, group, button };
}

describe('#1661 SailAboardControl', () => {
  it('offers Both plus one button per catalogue headsail, named via sailLabelKey', () => {
    const { group } = renderControl();
    const names = within(group as HTMLElement)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual([
      de['boat.sailsAboard.both'],
      de['route.rig.genoa'],
      de['route.rig.fock'],
    ]);
  });

  it('presses Both alone when every headsail is aboard', () => {
    const { button } = renderControl();
    expect(button(de['boat.sailsAboard.both'])).toHaveAttribute('aria-pressed', 'true');
    expect(button(de['route.rig.genoa'])).toHaveAttribute('aria-pressed', 'false');
    expect(button(de['route.rig.fock'])).toHaveAttribute('aria-pressed', 'false');
  });

  it('presses exactly the one sail that is aboard alone', () => {
    const { button } = renderControl({ aboard: ['fock'] });
    expect(button(de['boat.sailsAboard.both'])).toHaveAttribute('aria-pressed', 'false');
    expect(button(de['route.rig.genoa'])).toHaveAttribute('aria-pressed', 'false');
    expect(button(de['route.rig.fock'])).toHaveAttribute('aria-pressed', 'true');
  });

  it('reports a single sail, and Both as the whole catalogue in catalogue order', () => {
    const { onChange, button } = renderControl({ aboard: ['fock'] });
    fireEvent.click(button(de['route.rig.genoa']));
    expect(onChange).toHaveBeenLastCalledWith(['genoa']);
    fireEvent.click(button(de['boat.sailsAboard.both']));
    expect(onChange).toHaveBeenLastCalledWith(BOTH);
  });

  it('never reports an empty or unchanged set: re-clicking the only pressed control is a no-op', () => {
    const only = renderControl({ aboard: ['genoa'] });
    fireEvent.click(only.button(de['route.rig.genoa']));
    expect(only.onChange).not.toHaveBeenCalled();
    const both = renderControl();
    fireEvent.click(both.button(de['boat.sailsAboard.both']));
    expect(both.onChange).not.toHaveBeenCalled();
  });

  it('describes the group with the at-least-one-sail hint', () => {
    const { group } = renderControl();
    expect(group).toHaveAccessibleDescription(de['boat.sailsAboard.hint']);
  });

  it('renders nothing for a boat with a single headsail', () => {
    const { container } = renderControl({ catalogueIds: ['genoa'], aboard: ['genoa'] });
    expect(container).toBeEmptyDOMElement();
  });
});
