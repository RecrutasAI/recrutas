import { describe, it, expect } from 'vitest';
import { campaignCode } from '../server/lib/campaign-code';

describe('campaignCode', () => {
  it('keeps real launch and partner codes whole', () => {
    expect(campaignCode('HN-47T1WO')).toBe('HN-47T1WO');
    expect(campaignCode('REDDIT-PNFQ6Z')).toBe('REDDIT-PNFQ6Z');
    expect(campaignCode('rr-king')).toBe('RR-KING');
    expect(campaignCode('PILOT-ACME')).toBe('PILOT-ACME');
  });
  it('drops anything that is not a letter, digit or dash, and caps at the column size', () => {
    expect(campaignCode('TWITTER-LRL9SY<script>')).toBe('TWITTER-LRL9SYSCRIPT');
    expect(campaignCode(' hn 47t1wo ')).toBe('HN47T1WO');
    expect(campaignCode('A'.repeat(60))).toHaveLength(40);
    expect(campaignCode('***')).toBeUndefined();
  });
});
