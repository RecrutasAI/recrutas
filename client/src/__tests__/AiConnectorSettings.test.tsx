import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, afterEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { queryClient } from '@/lib/queryClient';
import { AiConnectorSettings, claudeCodeCommand } from '../components/ai-connector-settings';

const TOKEN = 'rk_' + 'a'.repeat(43);
afterEach(() => { queryClient.clear(); server.resetHandlers(); });

describe('Connect your AI tools', () => {
  it('creates a token and shows the setup command once', async () => {
    server.use(
      http.get('*/api/account/api-tokens', () => HttpResponse.json([])),
      http.post('*/api/account/api-tokens', () => HttpResponse.json({ id: 1, token: TOKEN, prefix: TOKEN.slice(0, 10) }, { status: 201 })),
    );
    render(<QueryClientProvider client={queryClient}><AiConnectorSettings /></QueryClientProvider>);
    await userEvent.click(screen.getByRole('button', { name: /create token/i }));
    expect(await screen.findByTestId('connector-claude-code')).toHaveTextContent(claudeCodeCommand(TOKEN));
    expect(screen.getByTestId('connector-json')).toHaveTextContent('"Authorization": "Bearer ' + TOKEN);
    await userEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.queryByTestId('connector-claude-code')).toBeNull();
  });

  it('lists tokens with when they were last used', async () => {
    server.use(http.get('*/api/account/api-tokens', () => HttpResponse.json([
      { id: 2, name: 'Claude Code', prefix: 'rk_abcdefg', lastUsedAt: null, createdAt: new Date().toISOString() },
    ])));
    render(<QueryClientProvider client={queryClient}><AiConnectorSettings /></QueryClientProvider>);
    expect(await screen.findByText('Never used')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Claude Code' })).toBeInTheDocument();
  });
});
