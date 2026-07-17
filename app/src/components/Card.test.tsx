import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Card from './Card';

describe('Card', () => {
  it('renders the title as a level-2 heading carrying the section-label class', () => {
    render(<Card title="Trip">body</Card>);
    const heading = screen.getByRole('heading', { level: 2, name: 'Trip' });
    expect(heading).toHaveClass('sc-card-title');
  });

  it('renders its children', () => {
    render(
      <Card title="Advanced">
        <p>option content</p>
      </Card>,
    );
    expect(screen.getByText('option content')).toBeInTheDocument();
  });

  it('does NOT introduce a region landmark (the wrapped sections own that tree)', () => {
    render(<Card title="Trip">body</Card>);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('merges an extra className alongside sc-card', () => {
    const { container } = render(
      <Card title="Trip" className="planner-trip">
        body
      </Card>,
    );
    const root = container.querySelector('div.sc-card');
    expect(root).toHaveClass('sc-card', 'planner-trip');
  });
});
