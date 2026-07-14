import { render, screen } from '@testing-library/react';
import App from './App';

it('renders the app shell', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'SailCommand' })).toBeInTheDocument();
});
