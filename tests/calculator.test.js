const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addMonthsClamped,
  calculateRemainingValue,
  convertCurrency,
  formatCurrency,
} = require("../calculator.js");

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

test("formats currencies with appropriate precision", () => {
  assert.match(formatCurrency(1234.5, "USD"), /1,234\.50/);
  assert.match(formatCurrency(1234.5, "JPY"), /1,235/);
});
