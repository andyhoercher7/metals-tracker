// Computes realized + unrealized P&L from the raw trade ledger, plus an S&P 500
// (IVV) benchmark: "what if I'd put the same dollars into IVV on the same day,
// at IVV's open price." Uses average-cost accounting and mirrors every buy/sell
// proportionally into a shadow IVV position so the comparison is apples-to-apples.

// Find IVV's open on a date, falling back to the most recent prior trading day
// (handles weekends/holidays).
function openOnOrBefore(opensMap, dateStr) {
  if (opensMap[dateStr] != null) return opensMap[dateStr]
  const d = new Date(dateStr + 'T00:00:00Z')
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() - 1)
    const k = d.toISOString().slice(0, 10)
    if (opensMap[k] != null) return opensMap[k]
  }
  return null
}

export function computePerformance(trades, currentPrices, ivvOpens, ivvCurrent) {
  const byTicker = {}
  trades.forEach(t => { (byTicker[t.ticker] = byTicker[t.ticker] || []).push(t) })

  let totalInvested = 0, realizedStock = 0, unrealizedStock = 0, holdingsValue = 0
  let realizedIVV = 0, unrealizedIVV = 0, ivvHoldingsValue = 0
  const perTicker = []

  for (const [ticker, list] of Object.entries(byTicker)) {
    list.sort((a, b) =>
      a.trade_date < b.trade_date ? -1 :
      a.trade_date > b.trade_date ? 1 :
      (a.created_at || '') < (b.created_at || '') ? -1 : 1
    )

    let shares = 0, cost = 0        // current stock position (avg cost)
    let ivvShares = 0, ivvCost = 0  // shadow IVV position
    let tRealized = 0, tRealizedIVV = 0, tInvested = 0

    for (const tr of list) {
      const n = Number(tr.shares) || 0
      const p = Number(tr.price) || 0
      const amount = Number(tr.dollar_amount) || n * p
      const ivvOpen = openOnOrBefore(ivvOpens, tr.trade_date)

      if (tr.action === 'BUY') {
        shares += n
        cost += amount
        tInvested += amount
        if (ivvOpen) {
          ivvShares += amount / ivvOpen
          ivvCost += amount
        }
      } else {
        // SELL_PARTIAL or SELL_FULL
        if (shares <= 0) continue
        const sellN = tr.action === 'SELL_FULL' ? shares : Math.min(n, shares)
        const f = sellN / shares
        const avg = cost / shares
        tRealized += (p - avg) * sellN
        cost -= avg * sellN
        shares -= sellN

        // Mirror the sale proportionally in the IVV shadow at IVV's open that day
        if (ivvShares > 0 && ivvOpen) {
          const ivvSell = ivvShares * f
          const ivvAvg = ivvCost / ivvShares
          tRealizedIVV += (ivvOpen - ivvAvg) * ivvSell
          ivvCost -= ivvAvg * ivvSell
          ivvShares -= ivvSell
        }
      }
    }

    const cp = currentPrices[ticker]
    const tUnreal = (shares > 0 && cp != null) ? (cp - cost / shares) * shares : 0
    const tHoldVal = (shares > 0 && cp != null) ? shares * cp : 0
    const ivvUnreal = (ivvShares > 0 && ivvCurrent) ? (ivvCurrent - ivvCost / ivvShares) * ivvShares : 0
    const ivvHoldVal = (ivvShares > 0 && ivvCurrent) ? ivvShares * ivvCurrent : 0

    totalInvested += tInvested
    realizedStock += tRealized
    unrealizedStock += tUnreal
    holdingsValue += tHoldVal
    realizedIVV += tRealizedIVV
    unrealizedIVV += ivvUnreal
    ivvHoldingsValue += ivvHoldVal

    const tTotal = tRealized + tUnreal
    const tIvvTotal = tRealizedIVV + ivvUnreal
    const tReturnPct = tInvested > 0 ? (tTotal / tInvested) * 100 : 0
    const tIvvReturnPct = tInvested > 0 ? (tIvvTotal / tInvested) * 100 : 0

    perTicker.push({
      ticker,
      shares,
      currentPrice: cp ?? null,
      invested: tInvested,
      realized: tRealized,
      unrealized: tUnreal,
      total: tTotal,
      returnPct: tReturnPct,
      ivvTotal: tIvvTotal,
      ivvReturnPct: tIvvReturnPct,
      alpha: tReturnPct - tIvvReturnPct,
    })
  }

  const totalPnl = realizedStock + unrealizedStock
  const returnPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0
  const ivvPnl = realizedIVV + unrealizedIVV
  const ivvReturnPct = totalInvested > 0 ? (ivvPnl / totalInvested) * 100 : 0

  return {
    totalInvested,
    realized: realizedStock,
    unrealized: unrealizedStock,
    totalPnl,
    holdingsValue,
    returnPct,
    ivv: {
      realized: realizedIVV,
      unrealized: unrealizedIVV,
      totalPnl: ivvPnl,
      holdingsValue: ivvHoldingsValue,
      returnPct: ivvReturnPct,
    },
    alpha: returnPct - ivvReturnPct,
    perTicker: perTicker.sort((a, b) => b.total - a.total),
  }
}
