import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Button from './Button';

describe('Button', () => {
  it('defaults to the primary variant and type="button"', () => {
    render(<Button>Plan route</Button>);
    const btn = screen.getByRole('button', { name: 'Plan route' });
    expect(btn).toHaveClass('sc-btn', 'sc-btn-primary');
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('applies the requested variant class', () => {
    render(<Button variant="secondary">Pick on map</Button>);
    expect(screen.getByRole('button', { name: 'Pick on map' })).toHaveClass('sc-btn-secondary');
  });

  it('applies the ghost variant class', () => {
    render(<Button variant="ghost">Add waypoint</Button>);
    expect(screen.getByRole('button', { name: 'Add waypoint' })).toHaveClass('sc-btn-ghost');
  });

  it('lets an explicit type override the default', () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit');
  });

  it('forwards onClick and fires it on click', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards disabled and does not fire onClick while disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards aria-label and merges an extra className', () => {
    render(
      <Button aria-label="Remove waypoint 1" className="extra">
        ×
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Remove waypoint 1' });
    expect(btn).toHaveClass('sc-btn', 'sc-btn-primary', 'extra');
  });
});
