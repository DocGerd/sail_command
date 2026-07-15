import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import Banner from './Banner';

afterEach(cleanup);

describe('Banner', () => {
  it('renders its children and uses role="status" for an info banner', () => {
    render(<Banner kind="info">Hello</Banner>);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('Hello');
  });

  it('uses role="alert" for a warning banner', () => {
    render(<Banner kind="warning">Careful</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Careful');
  });

  it('renders no dismiss button when onDismiss is omitted', () => {
    render(<Banner kind="info">No dismiss</Banner>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a dismiss button labeled with dismissLabel and calls onDismiss when clicked', () => {
    const onDismiss = vi.fn();
    render(
      <Banner kind="warning" onDismiss={onDismiss} dismissLabel="Dismiss">
        Dismissible
      </Banner>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
