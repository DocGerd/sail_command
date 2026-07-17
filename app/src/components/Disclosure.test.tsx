import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Disclosure from './Disclosure';

describe('Disclosure', () => {
  it('renders the summary and the body children', () => {
    render(
      <Disclosure summary="Advanced">
        <p>options</p>
      </Disclosure>,
    );
    expect(screen.getByText('Advanced')).toBeInTheDocument();
    expect(screen.getByText('options')).toBeInTheDocument();
  });

  it('is closed by default (no open attribute)', () => {
    const { container } = render(<Disclosure summary="Legs">table</Disclosure>);
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
  });

  it('starts open when defaultOpen is set', () => {
    const { container } = render(
      <Disclosure summary="Legs" defaultOpen>
        table
      </Disclosure>,
    );
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(true);
  });

  it('puts the summary in a <summary> carrying the touch-target class', () => {
    render(<Disclosure summary="Advanced">body</Disclosure>);
    const summary = screen.getByText('Advanced');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary).toHaveClass('sc-disclosure-summary');
  });

  // The runtime open<->close SYNC (onToggle -> setOpen, the controlled-<details>
  // footgun guard this component exists to provide) is deliberately NOT unit-
  // tested here: jsdom flips <details open> directly on the DOM and React does
  // not re-assert an unchanged `open` prop on re-render, so any jsdom assertion
  // on `details.open` reads back the value the test itself set and passes even
  // if onToggle is deleted (mutation-verified false-pass hole — repo lesson #50).
  // That sync is covered by E2E once Disclosure is first rendered (Phase 3).
});
