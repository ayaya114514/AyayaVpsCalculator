(function attachCalculator(root, factory) {
  const calculator = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = calculator;
  } else {
    root.VpsCalculator = calculator;
  }
}(typeof globalThis !== "undefined" ? globalThis : window, function createCalculator() {
  const CURRENCIES = {
    USD: { name: "美元", symbol: "US$", fractionDigits: 2 },
    CNY: { name: "人民币", symbol: "¥", fractionDigits: 2 },
    GBP: { name: "英镑", symbol: "£", fractionDigits: 2 },
    EUR: { name: "欧元", symbol: "€", fractionDigits: 2 },
    CAD: { name: "加元", symbol: "C$", fractionDigits: 2 },
    JPY: { name: "日元", symbol: "JP¥", fractionDigits: 0 },
    SGD: { name: "新加坡元", symbol: "S$", fractionDigits: 2 },
    HKD: { name: "港元", symbol: "HK$", fractionDigits: 2 },
  };

  const BILLING_LABELS = {
    1: "月付",
    3: "季付",
    6: "半年付",
    12: "年付",
    24: "两年付",
    36: "三年付",
  };

  function parseDateParts(dateString) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString || "");
    if (!match) throw new Error("日期格式无效");
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }

  function formatDateInput(year, month, day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function addMonthsClamped(dateString, monthsToAdd) {
    const { year, month, day } = parseDateParts(dateString);
    const targetIndex = year * 12 + (month - 1) + Number(monthsToAdd);
    const targetYear = Math.floor(targetIndex / 12);
    const targetMonthIndex = targetIndex % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
    return formatDateInput(targetYear, targetMonthIndex + 1, Math.min(day, lastDay));
  }

  function toEpochDay(dateString) {
    const { year, month, day } = parseDateParts(dateString);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  }

  function calculateRemainingValue({ amount, startDate, expiryDate, today }) {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) throw new Error("请输入大于 0 的购买价格");

    const startDay = toEpochDay(startDate);
    const expiryDay = toEpochDay(expiryDate);
    const todayDay = toEpochDay(today);
    const totalDays = expiryDay - startDay;
    if (totalDays <= 0) throw new Error("到期日期必须晚于开始日期");

    const remainingDays = Math.max(0, Math.min(totalDays, expiryDay - todayDay));
    const ratio = remainingDays / totalDays;
    return { totalDays, remainingDays, ratio, value: numericAmount * ratio };
  }

  function convertCurrency(amount, from, to, usdRates) {
    if (from === to) return Number(amount);
    const fromRate = usdRates[from];
    const toRate = usdRates[to];
    if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
      throw new Error("当前币种的汇率暂不可用");
    }
    return (Number(amount) / fromRate) * toRate;
  }

  function roundCurrency(amount, currency) {
    const digits = CURRENCIES[currency]?.fractionDigits ?? 2;
    // Round with Intl so the stored value always matches what formatCurrency displays.
    const text = new Intl.NumberFormat("en-US", {
      useGrouping: false,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number(amount));
    return Number(text) || 0;
  }

  function formatCurrency(amount, currency, locale = "zh-CN") {
    const config = CURRENCIES[currency];
    const number = Number(amount);
    if (!config || !Number.isFinite(number)) return "—";
    const rounded = roundCurrency(number, currency);
    const digits = new Intl.NumberFormat(locale, {
      minimumFractionDigits: config.fractionDigits,
      maximumFractionDigits: config.fractionDigits,
    }).format(Math.abs(rounded));
    return `${rounded < 0 ? "−" : ""}${config.symbol}${digits}`;
  }

  function calculateTransfer({ value, amount, mode, currency }) {
    const roundedValue = roundCurrency(value, currency);
    const input = roundCurrency(amount, currency);
    const finalPrice = mode === "premium" ? roundCurrency(roundedValue + input, currency) : input;
    return { finalPrice, premium: roundCurrency(finalPrice - roundedValue, currency) };
  }

  function hasCompleteRates(rates, codes) {
    return codes.every((code) => {
      const rate = Number(rates?.[code]);
      return Number.isFinite(rate) && rate > 0;
    });
  }

  function isDateString(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function parseFrankfurterRates(rows, codes) {
    if (!Array.isArray(rows)) throw new Error("Frankfurter 数据格式无效");
    const rates = { USD: 1 };
    let date = "";
    rows.forEach((row) => {
      if (!codes.includes(row?.quote) || row.base !== "USD") return;
      rates[row.quote] = Number(row.rate);
      if (isDateString(row.date) && row.date > date) date = row.date;
    });
    if (!hasCompleteRates(rates, codes)) throw new Error("Frankfurter 数据不完整");
    if (!date) throw new Error("Frankfurter 缺少汇率日期");
    return { rates, date };
  }

  function parseExchangeRateApiRates(data, codes, fallbackDate) {
    if (data?.result !== "success") throw new Error("ExchangeRate-API 返回失败");
    const rates = Object.fromEntries(codes.map((code) => [code, Number(data.rates?.[code])]));
    if (!hasCompleteRates(rates, codes)) throw new Error("备用汇率数据不完整");
    const updatedAt = Number(data.time_last_update_unix);
    const date = Number.isFinite(updatedAt) && updatedAt > 0
      ? new Date(updatedAt * 1000).toISOString().slice(0, 10)
      : fallbackDate;
    return { rates, date };
  }

  return {
    BILLING_LABELS,
    CURRENCIES,
    addMonthsClamped,
    calculateRemainingValue,
    calculateTransfer,
    convertCurrency,
    formatCurrency,
    formatDateInput,
    hasCompleteRates,
    isDateString,
    parseExchangeRateApiRates,
    parseFrankfurterRates,
    roundCurrency,
    toEpochDay,
  };
}));
