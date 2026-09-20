// Index-proxy hedge sizing for names that are not listed as a Bitget stock perp.
// A proxy is a correlation hedge on an index perp, sized by beta. It is not a
// same-name hedge and carries basis risk. Beta is estimated from real returns
// and always labeled an estimate.

function returns(series) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = Number(series[i - 1]);
    const curr = Number(series[i]);
    if (Number.isFinite(prev) && Number.isFinite(curr) && prev > 0) out.push((curr - prev) / prev);
  }
  return out;
}

// Beta of a name against an index from aligned close series (oldest to newest).
export function estimateBeta(nameCloses, indexCloses, minSamples = 20) {
  const rn = returns(nameCloses);
  const ri = returns(indexCloses);
  const n = Math.min(rn.length, ri.length);
  if (n < minSamples) return null;
  const a = rn.slice(-n);
  const b = ri.slice(-n);
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varB += (b[i] - meanB) ** 2;
  }
  if (varB <= 0) return null;
  return { beta: Number((cov / varB).toFixed(4)), sampleSize: n };
}

// Size the index short that offsets the held notional given beta. Floors to the
// index increment so the proxy notional never exceeds the beta target.
export function proxySizing({ heldNotional, beta, indexMark, increment = 0.01, minQty = increment, minNotional = 5 }) {
  const values = [heldNotional, beta, indexMark, increment, minQty, minNotional];
  if (!values.every(Number.isFinite) || heldNotional <= 0 || beta <= 0 || indexMark <= 0 || increment <= 0) {
    return { ok: false, reason: 'invalid proxy sizing inputs' };
  }
  const targetNotional = beta * heldNotional;
  const units = Math.floor((targetNotional / indexMark + Number.EPSILON) / increment);
  const qty = Number((units * increment).toFixed(12));
  const notional = Number((qty * indexMark).toFixed(8));
  if (qty < minQty || notional < minNotional) return { ok: false, reason: `proxy hedge below ${minQty} or ${minNotional} USDT`, qty, notional };
  return { ok: true, qty, notional, targetNotional: Number(targetNotional.toFixed(8)) };
}
