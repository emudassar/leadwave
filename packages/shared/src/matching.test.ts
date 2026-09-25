import { describe, expect, it } from 'vitest';
import { matchKeywords, normalise, parseEmail, parsePhone, renderMergeFields } from './matching.js';
import type { KeywordRule } from './automation.js';

const rule = (over: Partial<KeywordRule> = {}): KeywordRule => ({
  mode: 'contains',
  keywords: ['link'],
  excludeKeywords: [],
  ...over,
});

describe('normalise', () => {
  it('lowercases, strips accents and collapses punctuation', () => {
    expect(normalise('LÍNK!!!  please')).toBe('link please');
  });
});

describe('matchKeywords', () => {
  it('matches a whole word anywhere in the comment', () => {
    expect(matchKeywords(rule(), 'send me the LINK please 🙏')).toEqual({
      matched: true,
      keyword: 'link',
    });
  });

  it('does not match a word that merely contains the keyword', () => {
    expect(matchKeywords(rule(), 'follow me on linkedin').matched).toBe(false);
  });

  it('tolerates trailing punctuation and emoji', () => {
    expect(matchKeywords(rule(), 'link!!! 🔥').matched).toBe(true);
  });

  it('honours exact mode', () => {
    const r = rule({ mode: 'exact' });
    expect(matchKeywords(r, 'link').matched).toBe(true);
    expect(matchKeywords(r, 'the link').matched).toBe(false);
  });

  it('honours starts_with mode', () => {
    const r = rule({ mode: 'starts_with', keywords: ['price'] });
    expect(matchKeywords(r, 'price please?').matched).toBe(true);
    expect(matchKeywords(r, 'what price').matched).toBe(false);
  });

  it('fires on everything in any mode', () => {
    expect(matchKeywords(rule({ mode: 'any', keywords: [] }), 'anything at all').matched).toBe(true);
  });

  it('never fires when an excluded word is present', () => {
    const r = rule({ excludeKeywords: ['not'] });
    expect(matchKeywords(r, 'not the link').matched).toBe(false);
  });

  it('reports which keyword fired', () => {
    const r = rule({ keywords: ['price', 'cost', 'how much'] });
    expect(matchKeywords(r, 'how much is it?').keyword).toBe('how much');
  });

  it('ignores an empty message', () => {
    expect(matchKeywords(rule(), '   ').matched).toBe(false);
  });
});

describe('parseEmail', () => {
  it.each([
    ['sarah@hello.co', 'sarah@hello.co'],
    ['my email is Sarah@Hello.CO!', 'sarah@hello.co'],
    ['here you go: sarah.jones+ig@hello.co.uk.', 'sarah.jones+ig@hello.co.uk'],
    ['sarah @ hello . co', 'sarah@hello.co'],
    ['sarah at hello dot co', 'sarah@hello.co'],
    ['(sarah@hello.co)', 'sarah@hello.co'],
  ])('parses %j', (input, expected) => {
    expect(parseEmail(input)).toBe(expected);
  });

  it.each(['no email here', 'sarah@', '@hello.co', 'sarah@hello'])('rejects %j', (input) => {
    expect(parseEmail(input)).toBeNull();
  });
});

describe('parsePhone', () => {
  it.each([
    ['03001234567', 'PK', '+923001234567'],
    ['+92 300 1234567', 'PK', '+923001234567'],
    ['3001234567', 'PK', '+923001234567'],
    ['0092 300 1234567', 'PK', '+923001234567'],
    ['98765 43210', 'IN', '+919876543210'],
    ['+91-98765-43210', 'IN', '+919876543210'],
    ['(555) 123 4567', 'US', '+15551234567'],
    ['my number is 0300-1234567 thanks', 'PK', '+923001234567'],
  ])('parses %j for %s', (input, country, expected) => {
    expect(parsePhone(input, country)).toBe(expected);
  });

  it.each(['no digits here', '12345', 'call me'])('rejects %j', (input) => {
    expect(parsePhone(input, 'PK')).toBeNull();
  });
});

describe('renderMergeFields', () => {
  const ctx = { firstName: 'Sarah', lastName: 'Jones', username: 'sarahj', pageName: 'LeadWave' };

  it('supports both single and double brace spellings', () => {
    expect(renderMergeFields('Hi {first_name} / {{first_name}}', ctx)).toBe('Hi Sarah / Sarah');
  });

  it('builds full_name from the parts', () => {
    expect(renderMergeFields('{full_name}', ctx)).toBe('Sarah Jones');
  });

  it('falls back to a neutral word rather than printing the token', () => {
    expect(renderMergeFields('Hi {first_name}', {})).toBe('Hi there');
  });

  it('leaves unknown tokens untouched', () => {
    expect(renderMergeFields('Hi {not_a_field}', ctx)).toBe('Hi {not_a_field}');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderMergeFields('Hi {{ first_name }}', ctx)).toBe('Hi Sarah');
  });
});
