import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Field from './Field';

describe('Field', () => {
  it('associates the label with the wrapped control via htmlFor', () => {
    render(
      <Field label="Safety depth" htmlFor="depth-input">
        <input id="depth-input" type="number" defaultValue={3} />
      </Field>,
    );
    // getByLabelText resolves the label->control association.
    expect(screen.getByLabelText('Safety depth')).toHaveAttribute('id', 'depth-input');
  });

  it('renders no help paragraph when help is omitted', () => {
    const { container } = render(
      <Field label="Departure" htmlFor="dep">
        <input id="dep" />
      </Field>,
    );
    expect(container.querySelector('.sc-field-help')).toBeNull();
  });

  it('renders help text with the given id when provided', () => {
    render(
      <Field label="Motor" htmlFor="motor" help="Fallback only." helpId="motor-help">
        <input id="motor" type="checkbox" aria-describedby="motor-help" />
      </Field>,
    );
    const help = screen.getByText('Fallback only.');
    expect(help).toHaveClass('sc-field-help');
    expect(help).toHaveAttribute('id', 'motor-help');
  });
});
