/**
 * The Fleet's link normalisation, ported: must equal jobs-fleet fleet/ids.py canonical_url
 * (checked on all 159,340 live links on 2026-10-11: 0 differences).
 */
import { describe, it, expect } from 'vitest';
import { canonicalUrl, linkKey } from '../server/lib/canonical-url';

describe('canonicalUrl', () => {
  it('matches the Python original on the tricky cases', () => {
    expect(canonicalUrl('HTTPS://Jobs.Lever.co/acme/1/?utm_source=x&gh_src=y&b=2&a=1')).toBe('https://jobs.lever.co/acme/1?a=1&b=2');
    expect(canonicalUrl('https://acme.com/careers?gh_jid=123')).toBe('https://acme.com/careers?gh_jid=123');
    expect(canonicalUrl('https://acme.com/jobs?q=a b&x=%7E')).toBe('https://acme.com/jobs?q=a+b&x=~');
    expect(canonicalUrl('https://acme.com/jobs?flag&k=')).toBe('https://acme.com/jobs?flag=&k=');
    expect(canonicalUrl('https://acme.com/')).toBe('https://acme.com/');
    expect(canonicalUrl('https://acme.com/a/#frag')).toBe('https://acme.com/a');
    expect(canonicalUrl('')).toBe('');
  });
  it('gives equal fingerprints to the same posting', () => {
    expect(linkKey('https://jobs.lever.co/acme/1/?utm_source=li')).toBe(linkKey('https://jobs.lever.co/acme/1'));
    expect(linkKey('https://jobs.lever.co/acme/1')).toMatch(/^[0-9a-f]{16}$/);
  });
});
