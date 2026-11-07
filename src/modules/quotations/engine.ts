/**
 * The quotation premium (Section 11, GR-24). Fixed order: base → riders → override → discount → GST.
 * Full precision until the final amount, which is rounded ONCE, half-up, to 2 decimals. Pure: no database.
 */
/**
 * A rider line. Stage G: `typed` is the price the advisor typed (change #9, it replaces the calculated one, which is
 * kept for reference); `custom` marks an add-on that is not on the product, for this quotation only.
 */
export interface Rider { name: string; priceType: 'FIXED' | 'PERCENT'; value: number; typed?: number | null; custom?: boolean }
export interface EngineInput {
  mode: 'RATE_TABLE' | 'MANUAL_ENTRY';
  base: number;                     // RATE_TABLE: the rate row, or the typed base (change #8); MANUAL_ENTRY: the typed net premium
  /** Change #8: the base was typed by the advisor; `calculatedBase` is the rate-table value kept beside it (null when no row). */
  typedBase?: boolean; calculatedBase?: number | null;
  riders: Rider[];                  // RATE_TABLE: product riders; both modes: typed-price riders and custom add-ons
  taxPercent?: number;              // RATE_TABLE: the price version's tax %
  taxAmount?: number;               // MANUAL_ENTRY: the tax typed from the insurer portal
  override?: { amount: number; reason: string } | null;
  discount?: { kind: 'AMOUNT' | 'PERCENT'; value: number; reference: string; preset?: string | null } | null;
}
export interface Breakdown {
  base: number; entryMode: 'CALCULATED' | 'TYPED'; calculatedBase: number | null;
  riders: Array<{ name: string; amount: number; calculated?: number | null; typed?: boolean; custom?: boolean }>; ridersTotal: number; calculated: number;
  discountPreset: string | null;
  override: number | null; beforeDiscount: number; discount: number; afterDiscount: number;
  taxPercent: number | null; tax: number; final: number;
}

/** Half-up to 2 decimals, done once at the end (also correct for x.xx5 values that binary floats store slightly low). */
export const roundHalfUp = (x: number) => Math.sign(x) * Math.round((Math.abs(x) + 1e-9) * 100) / 100;

export class EngineError extends Error { constructor(public messageId: 'QT-09' | 'QT-19' | 'QT-37') { super(messageId); } }

export function calculate(i: EngineInput): Breakdown {
  // MANUAL_ENTRY: the typed net premium already holds the product's riders, so only typed-price riders and custom
  // add-ons are added (existing quotations, which send neither, are unchanged). RATE_TABLE: every chosen rider.
  const calcOf = (r: Rider) => (r.priceType === 'FIXED' ? r.value : (i.base * r.value) / 100);
  const riders = i.riders
    .filter((r) => i.mode === 'RATE_TABLE' || r.custom || (r.typed !== undefined && r.typed !== null))
    .map((r) => {
      const typed = r.typed !== undefined && r.typed !== null;
      return { name: r.name, amount: typed ? r.typed! : calcOf(r), ...(r.custom ? { custom: true, calculated: null } : { calculated: calcOf(r) }), ...(typed ? { typed: true } : {}) };
    });
  const ridersTotal = riders.reduce((t, r) => t + r.amount, 0);
  const calculated = i.base + ridersTotal;
  const beforeDiscount = i.override ? i.override.amount : calculated;
  let discount = 0;
  if (i.discount && i.discount.value > 0) {
    if (!i.discount.reference?.trim()) throw new EngineError('QT-37');
    discount = i.discount.kind === 'AMOUNT' ? i.discount.value : (beforeDiscount * i.discount.value) / 100;
    if (discount > beforeDiscount) throw new EngineError('QT-09');
    if (discount > calculated) throw new EngineError('QT-19');
  }
  const afterDiscount = beforeDiscount - discount;
  const tax = i.mode === 'RATE_TABLE' ? (afterDiscount * (i.taxPercent ?? 0)) / 100 : (i.taxAmount ?? 0);
  return {
    base: i.base, entryMode: i.typedBase ? 'TYPED' : 'CALCULATED', calculatedBase: i.typedBase ? (i.calculatedBase ?? null) : (i.mode === 'RATE_TABLE' ? i.base : null),
    riders, ridersTotal, discountPreset: i.discount?.preset ?? null, calculated, override: i.override?.amount ?? null, beforeDiscount, discount, afterDiscount,
    taxPercent: i.mode === 'RATE_TABLE' ? (i.taxPercent ?? 0) : null, tax, final: roundHalfUp(afterDiscount + tax),
  };
}