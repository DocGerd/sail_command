import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Chip from './Chip';

describe('Chip', () => {
  it('renders children inside a span carrying the shared .chip class', () => {
    render(<Chip>Genoa</Chip>);
    const chip = screen.getByText('Genoa');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveClass('chip');
  });

  it('merges an extra className alongside .chip', () => {
    render(<Chip className="chip-sail">Fock</Chip>);
    expect(screen.getByText('Fock')).toHaveClass('chip', 'chip-sail');
  });

  it('forwards arbitrary span props', () => {
    render(<Chip title="recommended rig">Genoa</Chip>);
    expect(screen.getByText('Genoa')).toHaveAttribute('title', 'recommended rig');
  });
});
