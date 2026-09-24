const {
  BILLING_LABELS,
  CURRENCIES,
  addMonthsClamped,
  calculateRemainingValue,
  calculateTransfer,
  convertCurrency,
  formatCurrency,
  hasCompleteRates,
  isDateString,
  parseExchangeRateApiRates,
  parseFrankfurterRates,
} = window.VpsCalculator;

const RATE_CACHE_KEY = "ayaya-vps-rates-v2";
const RATE_CACHE_TTL = 6 * 60 * 60 * 1000;
const RATE_FETCH_TIMEOUT = 8000;
const CURRENCY_CODES = Object.keys(CURRENCIES);
const FALLBACK_RATE_DATE = "2026-07-22";
const FALLBACK_RATES = {
  USD: 1,
  CNY: 6.7646,
  GBP: 0.74426,
  EUR: 0.87413,
  CAD: 1.4055,
  JPY: 162.67,
  SGD: 1.2907,
  HKD: 7.848,
};
const RATE_PROVIDERS = {
  frankfurter: { name: "Frankfurter" },
  "exchangerate-api": {
    name: "ExchangeRate-API 备用",
    // The open access endpoint requires this attribution link on pages that use its rates.
    attribution: { text: "Rates By Exchange Rate API", href: "https://www.exchangerate-api.com" },
  },
  builtin: { name: "内置参考值" },
};
const RATE_MODES = {
  online: { suffix: "", status: "online" },
  cache: { suffix: "（缓存）", status: "online" },
  stale: { suffix: "（过期缓存）", status: "offline" },
  builtin: { suffix: "", status: "offline" },
};

const state = {
  rates: { ...FALLBACK_RATES },
  rateDate: FALLBACK_RATE_DATE,
  rateProvider: "builtin",
  rateSource: RATE_PROVIDERS.builtin.name,
  isLoadingRates: false,
  lastCalculation: null,
  isStale: false,
};

const elements = {};
let toastTimer;

document.addEventListener("DOMContentLoaded", init);

function init() {
  Object.assign(elements, {
    form: document.querySelector("#calculator-form"),
    purchaseAmount: document.querySelector("#purchase-amount"),
    purchaseCurrency: document.querySelector("#purchase-currency"),
    purchaseSymbol: document.querySelector("#purchase-symbol"),
    purchaseDate: document.querySelector("#purchase-date"),
    expiryDate: document.querySelector("#expiry-date"),
    targetCurrency: document.querySelector("#target-currency"),
    transferAmount: document.querySelector("#transfer-amount"),
    transferSymbol: document.querySelector("#transfer-symbol"),
    transferLabel: document.querySelector("#transfer-label"),
    formMessage: document.querySelector("#form-message"),
    rateStatus: document.querySelector("#rate-status"),
    refreshRates: document.querySelector("#refresh-rates"),
    resultPanel: document.querySelector("#result-panel"),
    resultState: document.querySelector("#result-state"),
    toast: document.querySelector("#toast"),
  });

  populateCurrencyOptions();
  refreshDateLimits();
  elements.purchaseDate.value = getLocalDateString(new Date());
  updateExpiryDate();
  updateSymbols();
  bindEvents();
  loadExchangeRates();
}

function bindEvents() {
  elements.form.addEventListener("submit", handleSubmit);
  document.querySelector("#reset-button").addEventListener("click", resetForm);
  document.querySelector("#copy-button").addEventListener("click", copyMarkdown);
  elements.refreshRates.addEventListener("click", () => loadExchangeRates(true));

  elements.purchaseDate.addEventListener("focus", refreshDateLimits);
  elements.purchaseDate.addEventListener("change", updateExpiryDate);
  document.querySelectorAll('input[name="billingCycle"]').forEach((input) => input.addEventListener("change", updateExpiryDate));
  elements.purchaseCurrency.addEventListener("change", updateSymbols);
  elements.targetCurrency.addEventListener("change", updateSymbols);
  document.querySelectorAll('input[name="transferMode"]').forEach((input) => input.addEventListener("change", syncTransferMode));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshDateLimits();
  });

  elements.form.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", markResultStale);
    input.addEventListener("change", markResultStale);
  });
}

function populateCurrencyOptions() {
  const options = CURRENCY_CODES.map((code) => new Option(`${code} · ${CURRENCIES[code].name}`, code));
  elements.purchaseCurrency.replaceChildren(...options);
  elements.targetCurrency.replaceChildren(...options.map((option) => option.cloneNode(true)));
  elements.purchaseCurrency.value = "USD";
  elements.targetCurrency.value = "CNY";
}

function updateSymbols() {
  elements.purchaseSymbol.textContent = CURRENCIES[elements.purchaseCurrency.value].symbol;
  elements.transferSymbol.textContent = CURRENCIES[elements.targetCurrency.value].symbol;
}

function syncTransferMode() {
  const isPremium = getTransferMode() === "premium";
  elements.transferLabel.textContent = isPremium ? "溢价金额" : "出让价格";
  elements.transferAmount.placeholder = isPremium ? "增加的金额" : "选填";
}

function refreshDateLimits() {
  elements.purchaseDate.max = getLocalDateString(new Date());
}

function getAutoExpiryDate() {
  if (!elements.purchaseDate.value) return "";
  return addMonthsClamped(elements.purchaseDate.value, getBillingMonths());
}

function updateExpiryDate() {
  const expiry = getAutoExpiryDate();
  if (expiry) elements.expiryDate.value = expiry;
}

async function loadExchangeRates(force = false) {
  if (state.isLoadingRates) return;
  const cached = readRateCache();
  if (!force && cached && isCacheFresh(cached)) {
    applyRates(cached, "cache");
    return;
  }

  state.isLoadingRates = true;
  setRefreshBusy(true);
  setRateStatus("loading", "正在获取最新汇率");
  try {
    const latest = await fetchLatestRates();
    writeRateCache({ ...latest, fetchedAt: Date.now() });
    applyRates(latest, "online", force);
  } catch (error) {
    console.warn("汇率服务暂不可用", error);
    const fallback = readRateCache();
    if (fallback) {
      applyRates(fallback, isCacheFresh(fallback) ? "cache" : "stale", force, true);
    } else {
      applyRates({ rates: FALLBACK_RATES, date: FALLBACK_RATE_DATE, provider: "builtin" }, "builtin", force, true);
    }
  } finally {
    state.isLoadingRates = false;
    setRefreshBusy(false);
  }
}

async function fetchLatestRates() {
  const quotes = CURRENCY_CODES.filter((code) => code !== "USD").join(",");
  try {
    const rows = await fetchJson(`https://api.frankfurter.dev/v2/rates?base=USD&quotes=${quotes}`);
    return { ...parseFrankfurterRates(rows, CURRENCY_CODES), provider: "frankfurter" };
  } catch (primaryError) {
    try {
      const data = await fetchJson("https://open.er-api.com/v6/latest/USD");
      const parsed = parseExchangeRateApiRates(data, CURRENCY_CODES, getLocalDateString(new Date()));
      return { ...parsed, provider: "exchangerate-api" };
    } catch (fallbackError) {
      throw new AggregateError([primaryError, fallbackError], "汇率服务暂不可用");
    }
  }
}

async function fetchJson(url) {
  const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(RATE_FETCH_TIMEOUT) : undefined;
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}`);
  return response.json();
}

function applyRates({ rates, date, provider }, mode, announce = false, failed = false) {
  const { suffix, status } = RATE_MODES[mode];
  state.rates = { ...rates };
  state.rateDate = date;
  state.rateProvider = provider;
  state.rateSource = `${RATE_PROVIDERS[provider].name}${suffix}`;
  setRateStatus(status, `${state.rateSource} · ${date}`, provider);

  if (!state.lastCalculation) return;
  const changed = getPairRate(state.lastCalculation.purchaseCurrency, state.lastCalculation.targetCurrency) !== state.lastCalculation.rate;
  if (changed) markResultStale();
  if (failed && (announce || changed)) {
    showToast(`汇率服务暂不可用，使用${state.rateSource}`);
  } else if (changed) {
    showToast("汇率已更新，请重新计算");
  } else if (announce) {
    showToast("汇率已是最新");
  }
}

function setRateStatus(status, message, provider) {
  const dot = document.createElement("span");
  dot.className = `status-dot status-dot--${status}`;
  const text = document.createElement("span");
  text.textContent = message;
  elements.rateStatus.replaceChildren(dot, text, ...createAttribution(provider));
}

function createAttribution(provider) {
  const attribution = RATE_PROVIDERS[provider]?.attribution;
  if (!attribution) return [];
  const link = document.createElement("a");
  link.href = attribution.href;
  link.textContent = attribution.text;
  link.target = "_blank";
  link.rel = "noopener";
  return [link];
}

function setRefreshBusy(isBusy) {
  elements.refreshRates.disabled = isBusy;
  elements.refreshRates.textContent = isBusy ? "刷新中" : "刷新";
}

function isCacheFresh(cache) {
  return Date.now() - cache.fetchedAt < RATE_CACHE_TTL;
}

function readRateCache() {
  try {
    const data = JSON.parse(localStorage.getItem(RATE_CACHE_KEY));
    if (!data || !isDateString(data.date) || !Number.isFinite(data.fetchedAt)) return null;
    if (!RATE_PROVIDERS[data.provider] || !hasCompleteRates(data.rates, CURRENCY_CODES)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeRateCache(data) {
  try { localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(data)); } catch { /* Storage can be unavailable in privacy mode. */ }
}

function handleSubmit(event) {
  event.preventDefault();
  elements.formMessage.textContent = "";
  try {
    const purchaseCurrency = elements.purchaseCurrency.value;
    const targetCurrency = elements.targetCurrency.value;
    const amount = Number(elements.purchaseAmount.value);
    const result = calculateRemainingValue({
      amount,
      startDate: elements.purchaseDate.value,
      expiryDate: elements.expiryDate.value,
      today: getLocalDateString(new Date()),
    });
    const convertedValue = convertCurrency(result.value, purchaseCurrency, targetCurrency, state.rates);
    renderResult({
      ...result,
      amount,
      convertedValue,
      purchaseCurrency,
      targetCurrency,
      rate: getPairRate(purchaseCurrency, targetCurrency),
      rateDate: state.rateDate,
      rateSource: state.rateSource,
      rateProvider: state.rateProvider,
    });
  } catch (error) {
    elements.formMessage.textContent = error.message || "暂时无法完成计算，请检查输入";
  }
}

function renderResult(result) {
  const { amount, value, convertedValue, ratio, remainingDays, totalDays, purchaseCurrency, targetCurrency } = result;
  const months = getBillingMonths();
  const isAutoExpiry = elements.expiryDate.value === getAutoExpiryDate();
  const transferAmount = elements.transferAmount.value === "" ? null : Number(elements.transferAmount.value);

  document.querySelector("#remaining-value").textContent = formatCurrency(convertedValue, targetCurrency);
  document.querySelector("#original-remaining-value").textContent = purchaseCurrency === targetCurrency ? "" : `原币约 ${formatCurrency(value, purchaseCurrency)}`;
  document.querySelector("#remaining-days").textContent = String(remainingDays);
  document.querySelector("#remaining-progress").style.width = `${(ratio * 100).toFixed(2)}%`;
  document.querySelector("#remaining-percent").textContent = `剩余 ${(ratio * 100).toFixed(1)}%`;
  document.querySelector("#period-start").textContent = formatShortDate(elements.purchaseDate.value);
  document.querySelector("#period-end").textContent = formatShortDate(elements.expiryDate.value);
  document.querySelector("#result-purchase-price").textContent = formatCurrency(amount, purchaseCurrency);
  document.querySelector("#result-billing-cycle").textContent = `${isAutoExpiry ? BILLING_LABELS[months] : "自定义"} · ${totalDays} 天`;

  const transferRow = document.querySelector("#transfer-price-row");
  const premiumRow = document.querySelector("#premium-row");
  if (transferAmount !== null && Number.isFinite(transferAmount) && transferAmount >= 0) {
    const { finalPrice, premium } = calculateTransfer({ value: convertedValue, amount: transferAmount, mode: getTransferMode(), currency: targetCurrency });
    const premiumElement = document.querySelector("#result-premium");
    document.querySelector("#result-transfer-price").textContent = formatCurrency(finalPrice, targetCurrency);
    premiumElement.textContent = `${premium > 0 ? "+" : premium < 0 ? "−" : ""}${formatCurrency(Math.abs(premium), targetCurrency)} · ${premium > 0 ? "溢价" : premium < 0 ? "亏损" : "持平"}`;
    premiumElement.className = premium > 0 ? "positive" : premium < 0 ? "negative" : "";
    transferRow.hidden = false;
    premiumRow.hidden = false;
  } else {
    transferRow.hidden = true;
    premiumRow.hidden = true;
  }

  document.querySelector("#rate-pair").textContent = `1 ${purchaseCurrency} = ${formatRate(result.rate)} ${targetCurrency}`;
  const rateTime = document.createElement("span");
  rateTime.textContent = `${result.rateDate} · ${result.rateSource}`;
  document.querySelector("#rate-time").replaceChildren(rateTime, ...createAttribution(result.rateProvider));

  elements.resultPanel.hidden = false;
  elements.resultState.textContent = "已计算";
  elements.resultState.className = "result-state result-state--ready";
  state.lastCalculation = result;
  state.isStale = false;

  if (window.matchMedia("(max-width: 900px)").matches) {
    elements.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function getPairRate(from, to) {
  try {
    return convertCurrency(1, from, to, state.rates);
  } catch {
    return Number.NaN;
  }
}

function markResultStale() {
  if (!state.lastCalculation) return;
  state.isStale = true;
  elements.resultState.textContent = "待重新计算";
  elements.resultState.className = "result-state result-state--stale";
}

function resetForm() {
  elements.form.reset();
  elements.purchaseCurrency.value = "USD";
  elements.targetCurrency.value = "CNY";
  refreshDateLimits();
  elements.purchaseDate.value = getLocalDateString(new Date());
  updateExpiryDate();
  updateSymbols();
  syncTransferMode();
  elements.formMessage.textContent = "";
  elements.resultPanel.hidden = true;
  elements.resultState.textContent = "等待输入";
  elements.resultState.className = "result-state";
  state.lastCalculation = null;
  state.isStale = false;
  showToast("已清空输入");
}

async function copyMarkdown() {
  const calculation = state.lastCalculation;
  if (!calculation) return;
  if (state.isStale) {
    showToast("结果待重新计算，请先计算再复制");
    return;
  }

  const rows = Array.from(document.querySelectorAll("#result-panel .result-list div:not([hidden])")).map((row) => {
    const label = row.querySelector("dt").textContent;
    const value = row.querySelector("dd").textContent;
    return `| ${label} | ${value} |`;
  });
  const markdown = [
    "### VPS 剩余价值",
    "",
    "| 项目 | 结果 |",
    "| --- | --- |",
    `| 当前剩余价值 | ${document.querySelector("#remaining-value").textContent} |`,
    `| 剩余时间 | ${calculation.remainingDays} 天 |`,
    ...rows,
    `| 换算汇率 | ${document.querySelector("#rate-pair").textContent} |`,
    `| 汇率日期 | ${calculation.rateDate}（${calculation.rateSource}） |`,
  ].join("\n");

  try {
    await navigator.clipboard.writeText(markdown);
    showToast("Markdown 已复制");
  } catch {
    showToast("复制失败，请检查浏览器权限");
  }
}

function getBillingMonths() {
  return Number(document.querySelector('input[name="billingCycle"]:checked').value);
}

function getTransferMode() {
  return document.querySelector('input[name="transferMode"]:checked').value;
}

function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShortDate(date) {
  return date ? date.replaceAll("-", "/") : "—";
}

function formatRate(rate) {
  if (!Number.isFinite(rate)) return "—";
  if (rate >= 100) return rate.toFixed(2);
  if (rate >= 1) return rate.toFixed(4);
  return rate.toFixed(6);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}
