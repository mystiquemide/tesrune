import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMandateStamp } from './mandate-stamp.mjs';
import { proxySizing } from './proxy.mjs';

const TAKER_FEE_RATE = 0.0006;
const MIN_CONFIDENCE = 0.6;

function decline(rule, reason, inputs) {
  return { type: 'decline', rule, reason, inputs };
}

function floorToIncrement(value, increment) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(increment) || increment <= 0) return 0;
  const units = Math.floor((value + Number.EPSILON) / increment);
  return Number((units * increment).toFixed(12));
}

function decimal(value, places = 8) {
  return Number(Number(value).toFixed(places));
}

function fundingSettlements(start, end) {
  const from = new Date(start);
  const to = new Date(end);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) return 0;
  const cursor = new Date(from);
  cursor.setUTCMinutes(0, 0, 0);
  cursor.setUTCHours(Math.ceil(from.getUTCHours() / 8) * 8);
  if (cursor <= from) cursor.setUTCHours(cursor.getUTCHours() + 8);
  let count = 0;
  while (cursor <= to) {
    count += 1;
    cursor.setUTCHours(cursor.getUTCHours() + 8);
  }
  return count;
}

function proposeProxy({ holding, verdict, clockState, openHedges, event, fundingRate, inputs }) {
  const heldQty = Number(holding.qty);
  const equityPrice = Number(holding.equityPrice);
  const beta = Number(holding.beta);
  const indexMark = Number(holding.proxyMark);
  if (![heldQty, equityPrice, beta, indexMark].every(Number.isFinite) || heldQty <= 0 || equityPrice <= 0 || beta <= 0 || indexMark <= 0) {
    return decline('UNLISTED', `No usable proxy sizing for ${holding.ticker}.`, inputs);
  }
  const heldNotional = decimal(heldQty * equityPrice);
  const contract = holding.proxyContract ?? {};
  const sizing = proxySizing({ heldNotional, beta, indexMark, increment: Number(contract.qtyIncrement ?? 0.01), minQty: Number(contract.minQty ?? contract.qtyIncrement ?? 0.01), minNotional: Number(contract.minNotional ?? 5) });
  if (!sizing.ok) return decline('MIN_SIZE', `Proxy hedge for ${holding.ticker}: ${sizing.reason}.`, { ...inputs, proxyQty: sizing.qty, notional: sizing.notional });
  if (openHedges.some((hedge) => hedge.symbol === holding.proxySymbol && hedge.status !== 'closed')) {
    return decline('DUPLICATE', `${holding.proxySymbol} already has an open proxy hedge.`, inputs);
  }
  const createdAt = new Date(clockState.now).toISOString();
  const unwindAt = clockState.nextUnwind;
  const settlements = fundingSettlements(createdAt, unwindAt);
  const funding = Number(fundingRate);
  const estimatedFunding = Number.isFinite(funding) ? decimal(sizing.notional * funding * settlements) : 0;
  const order = { symbol: holding.proxySymbol, qty: sizing.qty, side: 'sell', posSide: 'short', unwindAt, eventId: event?.id };
  const feePerLeg = decimal(sizing.notional * TAKER_FEE_RATE);
  const checks = [
    { rule: 'NOT_DARK', result: 'pass' },
    { rule: 'NOT_MATERIAL', result: 'pass' },
    { rule: 'DIRECTION_UP', result: 'pass' },
    { rule: 'UNLISTED', result: 'proxy', proxyOf: holding.ticker, via: holding.proxySymbol },
    { rule: 'CAP', result: 'beta-scaled', beta: decimal(beta, 4), targetNotional: sizing.targetNotional },
    { rule: 'MIN_SIZE', result: 'pass' },
    { rule: 'DUPLICATE', result: 'pass' }
  ];
  const proposal = {
    type: 'proposal',
    id: randomUUID(),
    createdAt,
    ticker: holding.ticker,
    ...order,
    mark: indexMark,
    notional: sizing.notional,
    hedgeType: 'proxy',
    proxyFor: holding.ticker,
    beta: decimal(beta, 4),
    betaSampleSize: holding.betaSampleSize ?? null,
    heldNotional,
    targetNotional: sizing.targetNotional,
    basisRisk: `Correlation hedge via ${holding.proxySymbol}, not a same-name hedge. Beta is estimated from historical returns and carries basis risk.`,
    takerFeeRate: TAKER_FEE_RATE,
    openFee: feePerLeg,
    unwindFee: feePerLeg,
    estimatedFees: decimal(feePerLeg * 2),
    fundingRate: Number.isFinite(funding) ? funding : 0,
    fundingSettlements: settlements,
    estimatedFunding,
    event: event ? { id: event.id, ts: event.ts, source: event.source, title: event.title, url: event.url, syntheticFixture: Boolean(event.meta?.synthetic), historicalReplay: Boolean(event.meta?.historicalReplay) } : null,
    verdict,
    mandate: { checks }
  };
  proposal.mandate.stamp = createMandateStamp(order);
  return proposal;
}

export function propose({ holding, verdict, clockState, openHedges = [], event, fundingRate = 0, requestedQty }) {
  const inputs = {
    ticker: holding?.ticker,
    symbol: holding?.symbol,
    heldQty: holding?.qty,
    status: holding?.status,
    window: clockState?.window,
    class: verdict?.class,
    direction: verdict?.direction,
    confidence: verdict?.confidence,
    hedgeRatio: verdict?.hedge_ratio,
    requestedQty
  };

  if (clockState?.window !== 'dark') return decline('NOT_DARK', 'Your broker is open. Sell there.', inputs);
  if (verdict?.class !== 'material' || !Number.isFinite(Number(verdict?.confidence)) || Number(verdict.confidence) < MIN_CONFIDENCE) {
    return decline('NOT_MATERIAL', `Event classified ${verdict?.class ?? 'unknown'} at ${Number(verdict?.confidence ?? 0).toFixed(2)} confidence.`, inputs);
  }
  if (verdict?.direction !== 'down') return decline('DIRECTION_UP', `No downside hedge: direction is ${verdict?.direction ?? 'unclear'}.`, inputs);
  if (holding?.status !== 'hedgeable' || !holding?.demoListed) {
    if (holding?.status === 'proxy') return proposeProxy({ holding, verdict, clockState, openHedges, event, fundingRate, inputs });
    return decline('UNLISTED', `${holding?.symbol ?? holding?.ticker ?? 'Instrument'} is not listed on the proof venue.`, inputs);
  }

  const heldQty = Number(holding.qty);
  const mark = Number(holding.mark);
  const increment = Number(holding.contract?.qtyIncrement ?? 0.01);
  const minQty = Number(holding.contract?.minQty ?? increment);
  const minNotional = Number(holding.contract?.minNotional ?? 5);
  const ratio = Number(verdict.hedge_ratio);
  const suggestion = requestedQty === undefined ? heldQty * ratio : Number(requestedQty);
  if (![heldQty, mark, increment, minQty, minNotional, ratio, suggestion].every(Number.isFinite) || heldQty <= 0 || mark <= 0 || ratio <= 0) {
    return decline('MIN_SIZE', 'The proposed hedge has invalid or non-positive sizing inputs.', inputs);
  }
  const capped = Math.min(suggestion, heldQty);
  const qty = floorToIncrement(capped, increment);
  const clippedFrom = suggestion > heldQty ? suggestion : undefined;
  const notional = decimal(qty * mark);
  if (qty < minQty || notional < minNotional) return decline('MIN_SIZE', `The capped hedge is below ${minQty} shares or ${minNotional} USDT.`, { ...inputs, cappedQty: qty, notional });
  if (openHedges.some((hedge) => hedge.symbol === holding.symbol && hedge.status !== 'closed') || Number(holding.openShortQty ?? 0) > 0) {
    return decline('DUPLICATE', `${holding.symbol} already has an open short hedge.`, inputs);
  }

  const createdAt = new Date(clockState.now).toISOString();
  const unwindAt = clockState.nextUnwind;
  const settlements = fundingSettlements(createdAt, unwindAt);
  const funding = Number(fundingRate);
  const estimatedFunding = Number.isFinite(funding) ? decimal(notional * funding * settlements) : 0;
  const order = {
    symbol: holding.symbol,
    qty,
    side: 'sell',
    posSide: 'short',
    unwindAt,
    eventId: event?.id
  };
  const checks = [
    { rule: 'NOT_DARK', result: 'pass' },
    { rule: 'NOT_MATERIAL', result: 'pass' },
    { rule: 'DIRECTION_UP', result: 'pass' },
    { rule: 'UNLISTED', result: 'pass' },
    { rule: 'CAP', result: clippedFrom === undefined ? 'pass' : 'clipped', clippedFrom, qty },
    { rule: 'MIN_SIZE', result: 'pass' },
    { rule: 'DUPLICATE', result: 'pass' }
  ];
  const feePerLeg = decimal(notional * TAKER_FEE_RATE);
  const proposal = {
    type: 'proposal',
    id: randomUUID(),
    createdAt,
    ticker: holding.ticker,
    ...order,
    mark,
    notional,
    takerFeeRate: TAKER_FEE_RATE,
    openFee: feePerLeg,
    unwindFee: feePerLeg,
    estimatedFees: decimal(feePerLeg * 2),
    fundingRate: Number.isFinite(funding) ? funding : 0,
    fundingSettlements: settlements,
    estimatedFunding,
    clippedFrom,
    event: event ? { id: event.id, ts: event.ts, source: event.source, title: event.title, url: event.url, syntheticFixture: Boolean(event.meta?.synthetic), historicalReplay: Boolean(event.meta?.historicalReplay) } : null,
    verdict,
    mandate: { checks }
  };
  proposal.mandate.stamp = createMandateStamp(order);
  return proposal;
}

export { MIN_CONFIDENCE, TAKER_FEE_RATE, floorToIncrement, fundingSettlements };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = propose({
    holding: { ticker: 'TSLA', symbol: 'TSLAUSDT', qty: 100, status: 'hedgeable', demoListed: true, mark: 364.22, openShortQty: 0, contract: { minQty: 0.01, qtyIncrement: 0.01, minNotional: 5 } },
    verdict: { class: 'material', direction: 'down', confidence: 0.82, hedge_ratio: 0.75, reasoning: 'Material downside event.' },
    clockState: { now: '2026-09-22T01:00:00.000Z', window: 'dark', nextUnwind: '2026-09-22T13:29:00.000Z' },
    event: { id: 'fixture-8k', ts: '2026-09-22T00:30:00.000Z', source: 'sec-edgar', title: 'TSLA 8-K item 2.02', url: 'https://www.sec.gov/' },
    fundingRate: -0.000049
  });
  console.log(JSON.stringify(result, null, 2));
}
