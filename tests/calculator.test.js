const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CURRENCIES,
  addMonthsClamped,
  calculateRemainingValue,
  calculateTransfer,
  convertCurrency,
  formatCurrency,
  hasCompleteRates,
  parseExchangeRateApiRates,
  parseFrankfurterRates,
  roundCurrency,
} = require("../calculator.js");

const CODES = Object.keys(CURRENCIES);
const QUOTES = { CNY: 6.7065, GBP: 0.75253, EUR: 0.87612, CAD: 1.4081, JPY: 158.07, SGD: 1.2787, HKD: 7.8495 };

test("adds billing months and clamps month-end dates", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsClamped("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonthsClamped("2026-12-15", 3), "2027-03-15");
});

test("calculates remaining days and prorated value", () => {
  const result = calculateRemainingValue({
    amount: 120,
    startDate: "2026-01-01",
    expiryDate: "2027-01-01",
    today: "2026-07-02",
  });
  assert.equal(result.totalDays, 365);
  assert.equal(result.remainingDays, 183);
  assert.ok(Math.abs(result.value - (120 * 183) / 365) < 1e-10);
});

test("clamps expired and not-yet-started plans", () => {
  assert.equal(calculateRemainingValue({ amount: 10, startDate: "2026-01-01", expiryDate: "2026-02-01", today: "2026-03-01" }).ratio, 0);
  assert.equal(calculateRemainingValue({ amount: 10, startDate: "2026-08-01", expiryDate: "2026-09-01", today: "2026-07-01" }).ratio, 1);
});

test("converts through USD base rates", () => {
  const rates = { USD: 1, CNY: 7.2, EUR: 0.9 };
  assert.equal(convertCurrency(100, "USD", "CNY", rates), 720);
  assert.equal(convertCurrency(720, "CNY", "EUR", rates), 90);
});

test("formats currencies with the same symbols as the inputs", () => {
  assert.equal(formatCurrency(1234.5, "USD"), "US$1,234.50");
  assert.equal(formatCurrency(1234.5, "JPY"), "JP¥1,235");
  assert.equal(formatCurrency(1234.5, "SGD"), "S$1,234.50");
  assert.equal(formatCurrency(-2.5, "CAD"), "−C$2.50");
  assert.equal(formatCurrency(-0.001, "USD"), "US$0.00");
});

test("rounds currency values exactly as they are displayed", () => {
  assert.equal(roundCurrency(2.87671, "USD"), 2.88);
  assert.equal(roundCurrency(1234.5, "JPY"), 1235);
  assert.ok(Object.is(roundCurrency(-0.001, "USD"), 0));
});

test("treats a transfer price equal to the displayed value as break-even", () => {
  assert.deepEqual(calculateTransfer({ value: 2.87671, amount: 2.88, mode: "transfer", currency: "USD" }), { finalPrice: 2.88, premium: 0 });
  assert.deepEqual(calculateTransfer({ value: 2.87671, amount: 5, mode: "premium", currency: "USD" }), { finalPrice: 7.88, premium: 5 });
  assert.equal(calculateTransfer({ value: 100.4, amount: 90, mode: "transfer", currency: "JPY" }).premium, -10);
});

test("parses complete Frankfurter rows", () => {
  const rows = Object.entries(QUOTES).map(([quote, rate]) => ({ date: "2026-09-24", base: "USD", quote, rate }));
  const { rates, date } = parseFrankfurterRates(rows, CODES);
  assert.equal(date, "2026-09-24");
  assert.equal(rates.USD, 1);
  assert.equal(rates.JPY, 158.07);
});

test("rejects Frankfurter rows with missing or invalid rates", () => {
  const rows = Object.entries(QUOTES).map(([quote, rate]) => ({ date: "2026-09-24", base: "USD", quote, rate }));
  assert.throws(() => parseFrankfurterRates(rows.slice(1), CODES), /不完整/);
  assert.throws(() => parseFrankfurterRates(rows.map((row) => (row.quote === "EUR" ? { ...row, rate: null } : row)), CODES), /不完整/);
  assert.throws(() => parseFrankfurterRates([...rows.slice(1), { ...rows[0], quote: "AUD" }], CODES), /不完整/);
  assert.throws(() => parseFrankfurterRates({}, CODES), /格式无效/);
});

test("parses ExchangeRate-API data and tolerates a missing update time", () => {
  const data = { result: "success", time_last_update_unix: 1790208152, rates: { USD: 1, ...QUOTES } };
  assert.equal(parseExchangeRateApiRates(data, CODES, "2026-01-01").date, "2026-09-24");
  const withoutTime = { ...data, time_last_update_unix: undefined };
  assert.equal(parseExchangeRateApiRates(withoutTime, CODES, "2026-09-25").date, "2026-09-25");
  assert.throws(() => parseExchangeRateApiRates({ ...data, rates: { USD: 1 } }, CODES, "2026-09-25"), /不完整/);
  assert.throws(() => parseExchangeRateApiRates({ result: "error" }, CODES, "2026-09-25"), /返回失败/);
});

test("checks that every currency has a positive rate", () => {
  assert.equal(hasCompleteRates({ USD: 1, ...QUOTES }, CODES), true);
  assert.equal(hasCompleteRates({ USD: 1, ...QUOTES, HKD: 0 }, CODES), false);
  assert.equal(hasCompleteRates(null, CODES), false);
});
