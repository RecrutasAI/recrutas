import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { ResumeOnFile } from '../components/resume-on-file';

const renderIt = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async ({ queryKey }) => (await fetch(String(queryKey[0]))).json() } } })}>
    <ResumeOnFile />
  </QueryClientProvider>,
);
afterEach(() => server.resetHandlers());

describe('ResumeOnFile', () => {
  it('shows the file name recruiters receive, with view and download links', async () => {
    server.use(http.get('*/api/candidate/resume-file', () => HttpResponse.json({
      onFile: true, exists: true, fileName: 'Jane_Doe_resume.pdf', size: 184_000, uploadedAt: '2026-10-02T12:00:00Z',
      viewUrl: 'https://s.example/view', downloadUrl: 'https://s.example/dl',
    })));
    renderIt();
    expect(await screen.findByTestId('resume-file-name')).toHaveTextContent('Jane_Doe_resume.pdf');
    expect(screen.getByTestId('resume-on-file')).toHaveTextContent('uploaded Oct 2 · 180 KB');
    expect(screen.getByRole('link', { name: /View/ })).toHaveAttribute('href', 'https://s.example/view');
    expect(screen.getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'Jane_Doe_resume.pdf');
  });

  it('says when the file is missing', async () => {
    server.use(http.get('*/api/candidate/resume-file', () => HttpResponse.json({ onFile: true, exists: false })));
    renderIt();
    expect(await screen.findByTestId('resume-missing')).toHaveTextContent('Your resume file is missing');
  });

  it('shows nothing without a resume', async () => {
    server.use(http.get('*/api/candidate/resume-file', () => HttpResponse.json({ onFile: false })));
    const { container } = renderIt();
    await new Promise(r => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
