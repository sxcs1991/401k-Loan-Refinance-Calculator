/*
 * 401(k) Loan Refinance Calculator — calculation engine
 * Rules follow IRC §72(p) and Treas. Reg. §1.72(p)-1 Q&A-19 / Q&A-20 as explained in the
 * ARA Participant Loans Resource Guide (Ch. 5), Examples 14–20.
 * Pure functions, no DOM access. Dates are 'YYYY-MM-DD' strings at the API boundary.
 */
(function (root) {
  'use strict';

  const PPY = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4 };
  const FREQ_LABEL = { weekly: 'weekly', biweekly: 'biweekly', semimonthly: 'semimonthly', monthly: 'monthly', quarterly: 'quarterly' };

  // ---------- dates ----------
  function parseD(s) {
    if (!s) return null;
    if (s instanceof Date) return s;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  function fmtD(dt) { return dt ? dt.toISOString().slice(0, 10) : ''; }
  function us(dt) { if (!dt) return ''; const s = dt.toISOString(); return s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4); }
  function addDays(dt, n) { return new Date(dt.getTime() + n * 86400000); }
  function addMonths(dt, n) {
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + n, d = dt.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(d, last)));
  }
  function addYears(dt, n) { return addMonths(dt, 12 * n); }
  function minD(a, b) { return a <= b ? a : b; }
  function maxD(a, b) { return a >= b ? a : b; }

  // k-th payment date (k = 0 is the first payment)
  function payDate(first, freq, k) {
    switch (freq) {
      case 'weekly': return addDays(first, 7 * k);
      case 'biweekly': return addDays(first, 14 * k);
      case 'semimonthly': return addDays(addMonths(first, Math.floor(k / 2)), (k % 2) ? 15 : 0);
      case 'quarterly': return addMonths(first, 3 * k);
      case 'monthly':
      default: return addMonths(first, k);
    }
  }
  // number of payments whose date falls on or before `end`
  function countPayments(first, freq, end) {
    if (!first || !end || first > end) return 0;
    let n = 0;
    while (n < 5000 && payDate(first, freq, n) <= end) n++;
    return n;
  }

  // ---------- money ----------
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  function periodicRate(annualPct, freq) { return (annualPct || 0) / 100 / (PPY[freq] || 12); }
  function pmt(P, r, n) {
    if (n <= 0) return 0;
    if (r === 0) return P / n;
    return P * r / (1 - Math.pow(1 + r, -n));
  }
  // number of payments needed to retire P with payment `pay`
  function nper(P, r, pay) {
    if (pay <= 0) return Infinity;
    if (r === 0) return Math.ceil(P / pay - 1e-9);
    const x = 1 - P * r / pay;
    if (x <= 0) return Infinity;
    return Math.ceil(-Math.log(x) / Math.log(1 + r) - 1e-9);
  }
  // balance after k level payments
  function balAfter(P, r, pay, k) {
    if (k <= 0) return P;
    if (r === 0) return Math.max(0, P - pay * k);
    const g = Math.pow(1 + r, k);
    return Math.max(0, P * g - pay * (g - 1) / r);
  }

  /*
   * Build an amortization schedule.
   * tranches: [{ principal, n }] — each tranche is level-amortized over its own n payments
   * (one tranche = ordinary loan; several = step-payment / two-tranche structure).
   * If `payment` is given (single tranche only) it overrides the level payment.
   */
  function buildSchedule({ tranches, annualRate, freq, first, payment }) {
    const r = periodicRate(annualRate, freq);
    const tr = tranches.filter(t => t.principal > 0.004 && t.n > 0).map(t => ({
      bal: t.principal, n: t.n,
      pay: (payment && tranches.length === 1) ? payment : r2(pmt(t.principal, r, t.n))
    }));
    const rows = [];
    let k = 0, totInt = 0, totPay = 0;
    while (tr.some(t => t.bal > 0.004) && k < 5000) {
      let pay = 0, int = 0, prin = 0;
      for (const t of tr) {
        if (t.bal <= 0.004) continue;
        const i = r2(t.bal * r);
        let p = t.pay;
        const lastScheduled = !payment && k === t.n - 1;
        if (lastScheduled || p >= t.bal + i) p = r2(t.bal + i); // final payment clears the tranche
        const pr = r2(p - i);
        t.bal = r2(t.bal - pr);
        pay += p; int += i; prin += pr;
      }
      const bal = tr.reduce((s, t) => s + t.bal, 0);
      rows.push({ no: k + 1, date: fmtD(payDate(first, freq, k)), payment: r2(pay), interest: r2(int), principal: r2(prin), balance: r2(bal) });
      totInt += int; totPay += pay; k++;
    }
    return { rows, totalInterest: r2(totInt), totalPaid: r2(totPay) };
  }

  // ---------- vesting ----------
  const VESTING = {
    immediate: { label: '100% immediate', pct: () => 100 },
    cliff2: { label: '2-year cliff', pct: y => (y >= 2 ? 100 : 0) },
    cliff3: { label: '3-year cliff', pct: y => (y >= 3 ? 100 : 0) },
    graded4: { label: '4-year graded (25%/yr)', pct: y => Math.min(100, 25 * Math.floor(y)) },
    graded5: { label: '5-year graded (20%/yr)', pct: y => Math.min(100, 20 * Math.floor(y)) },
    graded6: { label: '6-year graded (2–6)', pct: y => (y < 2 ? 0 : Math.min(100, 20 * (Math.floor(y) - 1))) },
    custom: { label: 'Custom', pct: null }
  };
  // custom: array of percentages for completed years 0..6 (index = years)
  function vestedPct(schedule, years, custom) {
    const y = Math.max(0, Math.floor(+years || 0));
    if (schedule === 'custom') {
      const arr = (custom || []).map(v => +v || 0);
      let p = 0;
      for (let i = 0; i <= Math.min(y, arr.length - 1); i++) p = arr[i];
      return Math.max(0, Math.min(100, p));
    }
    const s = VESTING[schedule] || VESTING.immediate;
    return s.pct(y);
  }

  // ---------- loans ----------
  const COUNTING = ['active', 'default', 'deemed']; // statuses still outstanding for §72(p) limits
  const CLOSED = ['offset', 'paid'];               // no longer outstanding; matter only for 12-month lookback

  // latest permissible term: processed date + 5 yrs (or residence term) − 1 day  (guide: 9/1/2024 → 8/31/2029)
  function latestPermissibleTerm(loan, settings) {
    const pd = parseD(loan.processedDate);
    if (!pd) return null;
    const yrs = loan.type === 'residence' ? (+settings.residenceYears || 15) : 5;
    return addDays(addYears(pd, yrs), -1);
  }

  // scheduled level-payment terms of an existing loan, assuming payments made on time
  function loanTerms(loan, settings) {
    const pd = parseD(loan.processedDate), md = parseD(loan.maturityDate);
    if (!pd || !md || !(loan.amount > 0)) return null;
    const freq = loan.frequency || 'monthly';
    const first = addDays(pd, +settings.firstPaymentDays || 20);
    const n = Math.max(1, countPayments(first, freq, md));
    const r = periodicRate(loan.rate, freq);
    const pay = pmt(loan.amount, r, n);
    return { first, n, r, pay, freq };
  }

  // scheduled balance on date d (0 before the loan existed)
  function scheduledBalance(loan, d, settings) {
    const pd = parseD(loan.processedDate);
    if (!pd || d < pd) return 0;
    const t = loanTerms(loan, settings);
    if (!t) return +loan.outstanding || 0;
    const k = countPayments(t.first, t.freq, d);
    return balAfter(loan.amount, t.r, t.pay, Math.min(k, t.n));
  }

  // estimated balance of a loan on a past date d within the lookback window
  function balanceOn(loan, d, settings) {
    const pd = parseD(loan.processedDate);
    if (!pd || d < pd) return 0;
    if (CLOSED.includes(loan.status)) {
      const cd = parseD(loan.closedDate);
      if (cd && d >= cd) return 0;
      return scheduledBalance(loan, d, settings);
    }
    // a loan balance does not grow over time, so it was at least today's balance on any earlier date
    return Math.max(scheduledBalance(loan, d, settings), +loan.outstanding || 0);
  }

  // highest aggregate outstanding balance during the 12 months before the refinance date
  function estimateHOB(loans, refiDate, settings) {
    const refi = parseD(refiDate);
    const start = addMonths(refi, -12);
    const candidates = [start];
    for (const l of loans) {
      const pd = parseD(l.processedDate);
      if (pd && pd > start && pd < refi) candidates.push(pd);
    }
    let best = 0, bestDate = start;
    for (const d of candidates) {
      const tot = loans.reduce((s, l) => s + balanceOn(l, d, settings), 0);
      if (tot > best + 0.004) { best = tot; bestDate = d; }
    }
    return { value: r2(best), date: fmtD(bestDate), windowStart: fmtD(start) };
  }

  // amortization schedule of an existing loan (for display)
  function existingLoanSchedule(loan, settings) {
    const t = loanTerms(loan, settings);
    if (!t) return null;
    return buildSchedule({ tranches: [{ principal: +loan.amount, n: t.n }], annualRate: loan.rate, freq: t.freq, first: t.first });
  }

  // ---------- main calculation ----------
  /*
   * input = {
   *   refiDate, loans:[{id, number, processedDate, amount, outstanding, frequency, rate, maturityDate, type, status, closedDate}],
   *   sources:[{name, balance, vested, eligible}],
   *   plan:{allowLoans, allowRefi, allSourcesEligible, minAmount, maxAmount, maxLoans, frequency, rate},
   *   hob:{mode:'calc'|'manual', manual},
   *   selection: 'all' | loan id,
   *   settings:{firstPaymentDays, minAppliesToCash, blockIfDefault, tenK, residenceYears, allowDefaultRefi, addLoansToVested}
   * }
   */
  function calculate(input) {
    const S = input.settings, P = input.plan;
    const out = { errors: [], warnings: [], notes: [] };
    const refi = parseD(input.refiDate);
    if (!refi) { out.errors.push('Enter the refinance date.'); return out; }
    const loans = input.loans || [];

    if (P.allowLoans === false) { out.errors.push('The plan does not allow participant loans.'); }
    if (P.allowRefi === false) { out.errors.push('The plan does not allow loan refinances.'); }

    const counting = loans.filter(l => COUNTING.includes(l.status));
    const OS = r2(counting.reduce((s, l) => s + (+l.outstanding || 0), 0));
    const hasDefault = loans.some(l => l.status === 'default' || l.status === 'deemed');
    const hasDeemed = loans.some(l => l.status === 'deemed');

    if (hasDefault && S.blockIfDefault) {
      out.errors.push('A loan is in default or deemed distributed, and the plan setting blocks new loans while a default exists.');
    } else if (hasDeemed) {
      out.warnings.push('A deemed-distributed loan is still unpaid. A replacement loan is allowed only if repaid through enforceable payroll withholding or secured by collateral outside the plan; otherwise the whole new loan is a deemed distribution (Treas. Reg. §1.72(p)-1 Q&A-19).');
    }

    // eligible-to-refinance loans
    const eligible = loans.filter(l => l.status === 'active' || (S.allowDefaultRefi && l.status === 'default'));
    out.eligibleIds = eligible.map(l => l.id);
    let replaced;
    if (input.selection === 'all') replaced = eligible;
    else replaced = eligible.filter(l => String(l.id) === String(input.selection));
    if (!replaced.length) out.errors.push(eligible.length ? 'Choose the loan to refinance.' : 'There is no outstanding loan eligible for refinancing.');

    // vested balance
    const sources = input.sources || [];
    const vestedAll = r2(sources.reduce((s, x) => s + (+x.vested || 0), 0));
    const vestedEligible = r2(sources.filter(x => P.allSourcesEligible !== false || x.eligible).reduce((s, x) => s + (+x.vested || 0), 0));
    const loanFund = S.addLoansToVested ? r2(loans.filter(l => l.status === 'active' || l.status === 'default').reduce((s, l) => s + (+l.outstanding || 0), 0)) : 0;
    const vestedBase = r2(vestedEligible + loanFund);

    // 12-month highest outstanding balance
    let hob;
    const hobEst = estimateHOB(loans, input.refiDate, S);
    if (input.hob && input.hob.mode === 'manual' && input.hob.manual !== '' && input.hob.manual != null) hob = +input.hob.manual;
    else hob = hobEst.value;
    hob = Math.max(hob, OS);
    const reduction = r2(Math.max(0, hob - OS));
    const dollarLimit = r2(50000 - reduction);
    let pctLimit = r2(vestedBase * 0.5);
    if (S.tenK) pctLimit = r2(Math.min(vestedBase, Math.max(pctLimit, 10000)));
    const planMax = (P.maxAmount > 0) ? Math.min(+P.maxAmount, 50000) : 50000;
    const limit = r2(Math.max(0, Math.min(dollarLimit, pctLimit, planMax)));
    let limitBasis = limit === dollarLimit ? '$50,000 limit (reduced by 12-month lookback)' : (limit === pctLimit ? (S.tenK && pctLimit > vestedBase * 0.5 ? '$10,000 floor' : '50% of vested balance') : 'plan maximum loan amount');

    const R = r2(replaced.reduce((s, l) => s + (+l.outstanding || 0), 0));
    const O = r2(OS - R);

    out.limits = { vestedAll, vestedEligible, loanFund, vestedBase, pctLimit, hob: r2(hob), hobEstimate: hobEst, hobMode: (input.hob && input.hob.mode) || 'calc', OS, reduction, dollarLimit, planMax, limit, limitBasis, R, O };

    // number of loans check
    if (P.maxLoans > 0) {
      const after = counting.length - replaced.length + 1;
      if (after > P.maxLoans) out.warnings.push(`After this refinance the participant would have ${after} outstanding loans; the plan allows ${P.maxLoans}.`);
    }

    if (out.errors.length) return out;

    // terms
    const lpts = replaced.map(l => latestPermissibleTerm(l, S)).filter(Boolean);
    if (lpts.length !== replaced.length) { out.errors.push('Each loan being refinanced needs a processed date.'); return out; }
    const LPT = lpts.reduce(minD);
    const first = addDays(refi, +S.firstPaymentDays || 20);
    const freq = P.frequency || replaced.slice().sort((a, b) => (a.processedDate > b.processedDate ? 1 : -1))[0].frequency || 'monthly';
    const rate = +P.rate;
    if (!(rate > 0)) { out.errors.push('Enter the loan interest rate (prime rate or custom rate).'); return out; }
    const fiveYrEnd = addDays(addYears(refi, 5), -1);
    const minAmt = +P.minAmount || 0;

    out.common = { LPT: fmtD(LPT), first: fmtD(first), freq, rate, fiveYrEnd: fmtD(fiveYrEnd), refi: fmtD(refi), replacedIds: replaced.map(l => l.id) };

    function finishOption(o) {
      if (o.maxCash < -0.004) {
        o.available = false;
        o.reason = o.reason || `The replaced balance plus other loans already exceeds the loan limit by ${money(-o.maxCash)}.`;
      } else if (S.minAppliesToCash && minAmt > 0 && o.maxCash < minAmt) {
        o.available = false;
        o.reason = `Maximum new cash (${money(Math.max(0, o.maxCash))}) is below the plan minimum loan amount of ${money(minAmt)}.`;
      } else o.available = true;
      o.maxCash = r2(Math.max(0, o.maxCash));
      return o;
    }

    // Option 1 — Maximum Amount: replacement ends no later than the LPT; replaced loan disregarded (Ex. 15/16, Ex. 18 Option #2)
    const o1 = { key: 'amount', title: 'Maximum Amount', end: LPT, sumOf: false };
    o1.maxNPay = countPayments(first, freq, LPT);
    o1.maxReplacement = r2(limit - O);
    o1.maxCash = r2(o1.maxReplacement - R);
    if (o1.maxNPay < 1) { o1.reason = `The latest permissible term of the replaced loan (${us(LPT)}) ends before the first payment date.`; o1.maxCash = -1; }
    o1.rule = `Term ends by the latest permissible term of the replaced loan${replaced.length > 1 ? 's' : ''} (${us(LPT)}), so only the replacement loan is tested against the limit (guide Ex. 15–16; Ex. 18 Option #2).`;
    out.option1 = finishOption(o1);

    // Option 2 — Maximum Term: new 5-year term; if it ends after the LPT, replaced balance is added back (Ex. 14, 17, 19)
    const end2 = maxD(fiveYrEnd, LPT);
    const sumOf = end2 > LPT;
    const o2 = { key: 'term', title: 'Maximum Term', end: end2, sumOf };
    o2.maxNPay = countPayments(first, freq, end2);
    o2.maxReplacement = r2(limit - O - (sumOf ? R : 0));
    o2.maxCash = r2(o2.maxReplacement - R);
    o2.rule = sumOf
      ? `New 5-year term ends ${us(end2)}, after the latest permissible term of the replaced loan (${us(LPT)}). The replaced balance (${money(R)}) is treated as still outstanding, so replacement loan + replaced loan + other loans must fit within the limit (guide Ex. 14, 17, 19).`
      : `The replaced loan's latest permissible term (${us(LPT)}) already runs past a new 5-year term, so the longest term available is the same as Maximum Amount.`;
    if (o2.maxCash < 0) o2.reason = `Under the sum-of rule the replaced balance is counted twice (${money(R)} × 2 + other loans ${money(O)} vs. limit ${money(limit)}), leaving no room for a longer term. Use the Maximum Amount option instead.`;
    out.option2 = finishOption(o2);

    // Option 3 — Two-tranche / step payments (guide "If You're Curious", Ex. 18 Option #3, Ex. 20)
    const o3 = { key: 'step', title: 'Longer Term with Step Payments', end: fiveYrEnd, sumOf: false };
    if (fiveYrEnd <= LPT) {
      o3.available = false; o3.notApplicable = true;
      o3.reason = 'Not needed: the replaced loan can already be extended past a new 5-year term without the sum-of rule.';
      o3.maxCash = 0;
    } else {
      o3.tranches = replaced.map(l => {
        const md = parseD(l.maturityDate);
        let end = md && md >= first ? minD(md, latestPermissibleTerm(l, S)) : latestPermissibleTerm(l, S);
        return { label: `Loan ${l.number || l.id} balance`, principal: +l.outstanding || 0, end: fmtD(end), n: countPayments(first, freq, end) };
      });
      if (o3.tranches.some(t => t.n < 1)) {
        o3.maxCash = -1; o3.reason = 'A replaced loan matures before the first payment date, so its balance cannot be re-amortized by its original term.';
      } else {
        o3.maxReplacement = r2(limit - O);
        o3.maxCash = r2(o3.maxReplacement - R);
      }
      o3.maxNPay = countPayments(first, freq, fiveYrEnd);
      o3.rule = `The replaced balance is repaid by its original maturity date, and the new cash is amortized separately over 5 years (to ${us(fiveYrEnd)}). Because neither part runs past its own maximum term, only the replacement loan is tested against the limit (guide Ex. 18 Option #3, Ex. 20). Payments step down once the original loan's portion is repaid.`;
      finishOption(o3);
    }
    out.option3 = o3;

    return out;
  }

  /*
   * Price an option for the participant's choices.
   * choice = { cash, mode:'payments'|'amount', nPay, payment }
   */
  function priceOption(opt, common, R, choice) {
    const freq = common.freq, rate = common.rate, first = parseD(common.first);
    const r = periodicRate(rate, freq);
    let cash = choice && choice.cash != null && choice.cash !== '' ? Math.min(+choice.cash, opt.maxCash) : opt.maxCash;
    cash = r2(Math.max(0, cash));
    const total = r2(R + cash);
    const res = { cash, total, freq, rate };

    if (opt.key === 'step') {
      const tranches = opt.tranches.map(t => ({ principal: t.principal, n: t.n }));
      tranches.push({ principal: cash, n: opt.maxNPay });
      const sch = buildSchedule({ tranches, annualRate: rate, freq, first });
      res.schedule = sch;
      res.nPay = sch.rows.length;
      // payment phases (a tranche's odd-cent final payment stays in its phase)
      const phases = [];
      for (const row of sch.rows) {
        const last = phases[phases.length - 1];
        if (last && Math.abs(last.payment - row.payment) < 1) { last.to = row.no; last.toDate = row.date; }
        else phases.push({ payment: row.payment, from: row.no, to: row.no, fromDate: row.date, toDate: row.date });
      }
      res.phases = phases.filter(p => p.to - p.from >= 0);
      res.payment = phases.length ? phases[0].payment : 0;
      res.endDate = sch.rows.length ? sch.rows[sch.rows.length - 1].date : '';
      return res;
    }

    const maxN = opt.maxNPay;
    const defPay = r2(pmt(total, r, maxN));
    res.maxNPay = maxN; res.minPayment = defPay;
    let n = maxN, pay = defPay;
    if (choice && choice.mode === 'payments' && choice.nPay) {
      n = Math.max(1, Math.min(maxN, Math.floor(+choice.nPay)));
      pay = r2(pmt(total, r, n));
    } else if (choice && choice.mode === 'amount' && choice.payment) {
      pay = Math.max(defPay, r2(+choice.payment));
      n = Math.min(maxN, nper(total, r, pay));
    }
    const sch = buildSchedule({ tranches: [{ principal: total, n }], annualRate: rate, freq, first, payment: (choice && choice.mode === 'amount' && choice.payment) ? pay : undefined });
    res.schedule = sch;
    res.nPay = sch.rows.length;
    res.payment = pay;
    res.endDate = sch.rows.length ? sch.rows[sch.rows.length - 1].date : '';
    return res;
  }

  function money(x) {
    return '$' + (Math.round((+x || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const api = { PPY, FREQ_LABEL, VESTING, parseD, fmtD, addDays, addMonths, addYears, payDate, countPayments, pmt, nper, balAfter, periodicRate, buildSchedule, vestedPct, latestPermissibleTerm, estimateHOB, existingLoanSchedule, scheduledBalance, calculate, priceOption, money };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LRC = api;
})(typeof window !== 'undefined' ? window : globalThis);
