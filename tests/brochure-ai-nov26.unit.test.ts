import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { aiExtract, brochureAiEnabled, buildRequest, mergeAi } from '../src/modules/catalogue/brochureAi.js';
import { decidedResult, launchDateOf } from '../src/modules/catalogue/ocr.service.js';

const FEATURES = [{ key: 'opd', name: 'OPD cover', dataType: 'Yes/No' }, { key: 'amb', name: 'Road ambulance', dataType: 'Amount in ₹' }, { key: 'iwp', name: 'Initial waiting period', dataType: 'Days' }];
const row = (key: string, name: string, dataType: string, value: string | null) => ({ key, name, dataType, found: !!value, value, confidence: value ? 0.6 : 0, page: value ? 1 : null, decision: null, editedValue: null });
const AI = {
  features: [{ key: 'opd', value: 'Yes', page: 3 }, { key: 'amb', value: '2000', page: 4 }, { key: 'iwp', value: null, page: null }],
  details: [{ key: 'name', value: 'Optima Secure', page: 1 }, { key: 'launchDate', value: '2024-04-01', page: 1 }, { key: 'gracePeriodDays', value: '30', page: 5 }],
  variants: [{ name: 'Silver', page: 2 }, { name: 'Gold', page: 2 }],
  extraFeatures: [{ name: 'Restore benefit', value: '100% of sum insured', page: 6 }],
};

afterEach(() => { vi.unstubAllGlobals(); (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = undefined; });

describe('brochure reading with gpt-4o-mini (Nov 2026)', () => {
  it('the request carries the feature list with formats and the text with page markers, as strict JSON schema', () => {
    const body = buildRequest([{ number: 1, text: 'Optima Secure' }, { number: 2, text: 'Silver Gold' }], FEATURES, [{ key: 'name', label: 'Product name' }]);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[1]!.content).toContain('=== Page 2 ===');
    expect(body.messages[1]!.content).toContain('"format":"whole rupees as digits');
  });
  it('model values win; where the model has none the pattern match stays; variants and extra features come in', () => {
    const out = mergeAi([row('opd', 'OPD cover', 'Yes/No', null), row('amb', 'Road ambulance', 'Amount in ₹', null), row('iwp', 'Initial waiting period', 'Days', '30')],
      { details: [], variants: [{ key: 'plus', label: 'Plus', value: 'Plus', confidence: 0.5, page: 1, decision: null, editedValue: null }], suggestions: [] }, AI, { name: 'Product name', launchDate: 'Launch date', gracePeriodDays: 'Grace period (days)' });
    expect(out.rows.map((r) => [r.key, r.found, r.value, r.page])).toEqual([['opd', true, 'Yes', 3], ['amb', true, '2000', 4], ['iwp', true, '30', 1]]);
    expect(out.variants.map((v) => v.value)).toEqual(['Silver', 'Gold']);
    expect(out.suggestions[0]).toMatchObject({ key: 'cf_restore_benefit', label: 'Restore Benefit', value: '100% of sum insured' });
    // accepted values reach the product data, launch date and grace period included
    const accept = <T extends object>(l: T[]) => l.map((r) => ({ ...r, decision: 'ACCEPT' as const }));
    const res = decidedResult({ rows: accept(out.rows) as never, details: accept(out.details) as never, variants: accept(out.variants) as never, suggestions: [] as never });
    expect(res.data).toMatchObject({ name: 'Optima Secure', launchDate: '2024-04-01', gracePeriodDays: 30, features: { opd: { value: true }, amb: { value: 2000 } } });
    expect(res.variants).toEqual([{ name: 'Silver' }, { name: 'Gold' }]);
  });
  it('launch dates as printed', () => {
    expect(launchDateOf('01/04/2024')).toBe('2024-04-01');
    expect(launchDateOf('2024-04-01')).toBe('2024-04-01');
    expect(launchDateOf('13/13/2024')).toBeNull();
  });
  it('calls OpenAI only with a key; a refused or failed call gives null (the OCR values are kept)', async () => {
    expect(brochureAiEnabled()).toBe(false);
    expect(await aiExtract([{ number: 1, text: 'x' }], FEATURES, [], 'ocr_t')).toBeNull();
    (env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = 'sk-test-0123456789abcdef';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(AI) } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    expect((await aiExtract([{ number: 1, text: 'x' }], FEATURES, [], 'ocr_t'))?.variants).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer sk-test-0123456789abcdef');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect(await aiExtract([{ number: 1, text: 'x' }], FEATURES, [], 'ocr_t')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await aiExtract([{ number: 1, text: 'x' }], FEATURES, [], 'ocr_t')).toBeNull();
  });
});