import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import SegmentModeControl from './SegmentModeControl';
import { de } from '../i18n/dict.de';

function renderControl(props: Partial<Parameters<typeof SegmentModeControl>[0]> = {}) {
  const onChange = vi.fn();
  const p = {
    index: 1,
    fromLabel: 'Wegpunkt 1',
    toLabel: 'Ziel',
    mode: null,
    motorEnabled: true,
    onChange,
    ...props,
  };
  render(<SegmentModeControl {...p} />);
  const group = screen.getByRole('group', {
    name: `Abschnitt ${p.index + 1}: ${p.fromLabel} → ${p.toLabel}`,
  });
  const button = (key: 'planner.segment.auto' | 'planner.segment.motor' | 'planner.segment.sail') =>
    within(group).getByRole('button', { name: de[key] });
  return { onChange, group, button };
}

describe('#885 SegmentModeControl', () => {
  it('presses exactly the current mode', () => {
    const { button } = renderControl({ mode: 'sail' });
    expect(button('planner.segment.auto')).toHaveAttribute('aria-pressed', 'false');
    expect(button('planner.segment.motor')).toHaveAttribute('aria-pressed', 'false');
    expect(button('planner.segment.sail')).toHaveAttribute('aria-pressed', 'true');
  });

  it('reports the chosen mode with its segment index; Auto reports null', () => {
    const { onChange, button } = renderControl({ mode: 'sail' });
    fireEvent.click(button('planner.segment.motor'));
    expect(onChange).toHaveBeenLastCalledWith(1, 'motor');
    fireEvent.click(button('planner.segment.auto'));
    expect(onChange).toHaveBeenLastCalledWith(1, null);
  });

  it('R4: with the motor off, motor is disabled and the reason is shown on the first segment', () => {
    const { button, group } = renderControl({ index: 0, fromLabel: 'Start', motorEnabled: false });
    expect(button('planner.segment.motor')).toBeDisabled();
    expect(button('planner.segment.sail')).toBeEnabled();
    expect(group).toHaveAccessibleDescription(de['planner.segment.motorOff']);
  });

  it('R4: a segment already marked motor while the motor is off shows the conflict and stays pressed', () => {
    const { button, group } = renderControl({ mode: 'motor', motorEnabled: false });
    expect(button('planner.segment.motor')).toHaveAttribute('aria-pressed', 'true');
    expect(group).toHaveAccessibleDescription(de['planner.segment.conflict']);
  });

  it('shows no notice while the motor is on', () => {
    const { group } = renderControl({ mode: 'motor' });
    expect(group).not.toHaveAttribute('aria-describedby');
  });
});
