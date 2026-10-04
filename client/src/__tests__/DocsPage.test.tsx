import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import DocsPage from '../pages/docs';

describe('Developer docs page', () => {
  it('shows setup for Claude Code and other clients, the tools, and the safety note', () => {
    render(<DocsPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Recrutas in your AI tools.');
    expect(screen.getByText(/claude mcp add --transport http recrutas https:\/\/www\.recrutas\.ai\/api\/mcp/)).toBeInTheDocument();
    for (const tool of ['search_my_matches', 'get_job', 'list_my_applications', 'record_application', 'why_no_replies']) {
      expect(screen.getByText(tool)).toBeInTheDocument();
    }
    expect(screen.getByText('It can never apply for you.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Docs' }).length).toBeGreaterThan(0); // in the site nav
  });
});
