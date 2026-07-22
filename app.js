const {
  BILLING_LABELS,
  CURRENCIES,
  addMonthsClamped,
  calculateRemainingValue,
  convertCurrency,
  formatCurrency,
} = window.VpsCalculator;

const RATE_CACHE_KEY = "ayaya-vps-rates-v1";
const RATE_CACHE_TTL = 6 * 60 * 60 * 1000;
const CURRENCY_CODES = Object.keys(CURRENCIES);
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

const state = {
  rates: { ...FALLBACK_RATES },
  rateDate: "2026-07-22",
  rateSource: "内置参考值",
  rateFetchedAt: 0,
  hasCalculated: false,
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
    compactRateStatus: document.querySelector("#compact-rate-status"),
    resultPanel: document.querySelector("#result-panel"),
    resultContent: document.querySelector("#result-content"),
    resultState: document.querySelector("#result-state"),
    toast: document.querySelector("#toast"),
  });

  populateCurrencyOptions();
  const today = getLocalDateString(new Date());
  elements.purchaseDate.value = today;
  elements.purchaseDate.max = today;
  updateExpiryDate();
  updateSymbols();
  bindEvents();
  loadExchangeRates();
}

function bindEvents() {
  elements.form.addEventListener("submit", handleSubmit);
  document.querySelector("#reset-button").addEventListener("click", resetForm);
  document.querySelector("#copy-button").addEventListener("click", copyMarkdown);
  document.querySelector("#refresh-rates").addEventListener("click", () => loadExchangeRates(true));

  elements.purchaseDate.addEventListener("change", updateExpiryDate);
  document.querySelectorAll('input[name="billingCycle"]').forEach((input) => input.addEventListener("change", updateExpiryDate));
  elements.purchaseCurrency.addEventListener("change", updateSymbols);
  elements.targetCurrency.addEventListener("change", updateSymbols);

  document.querySelectorAll('input[name="transferMode"]').forEach((input) => {
    input.addEventListener("change", () => {
      const isPremium = getTransferMode() === "premium";
      elements.transferLabel.textContent = isPremium ? "溢价金额" : "出让价格";
      elements.transferAmount.placeholder = isPremium ? "增加的金额" : "选填";
      markResultStale();
    });
  });

  elements.form.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", markResultStale);
    input.addEventListener("change", markResultStale);
  });
}

function populateCurrencyOptions() {
  const html = CURRENCY_CODES.map((code) => `<option value="${code}">${code} · ${CURRENCIES[code].name}</option>`).join("");
  elements.purchaseCurrency.innerHTML = html;
  elements.targetCurrency.innerHTML = html;
  elements.purchaseCurrency.value = "USD";
  elements.targetCurrency.value = "CNY";
}

function updateSymbols() {
  elements.purchaseSymbol.textContent = CURRENCIES[elements.purchaseCurrency.value].symbol;
  elements.transferSymbol.textContent = CURRENCIES[elements.targetCurrency.value].symbol;
  if (state.hasCalculated) updateDisplayedRate();
}

function updateExpiryDate() {
  if (!elements.purchaseDate.value) return;
  const months = Number(document.querySelector('input[name="billingCycle"]:checked').value);
  elements.expiryDate.value = addMonthsClamped(elements.purchaseDate.value, months);
}

async function loadExchangeRates(force = false) {
  setRateStatus("loading", "正在获取最新汇率");
  const cached = readRateCache();
  if (!force && cached && Date.now() - cached.fetchedAt < RATE_CACHE_TTL) {
    applyRates(cached.rates, cached.date, "本地缓存", cached.fetchedAt);
    return;
  }

  try {
    const quotes = CURRENCY_CODES.filter((code) => code !== "USD").join(",");
    const response = await fetch(`https://api.frankfurter.dev/v2/rates?base=USD&quotes=${quotes}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Frankfurter ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length < CURRENCY_CODES.length - 1) throw new Error("Frankfurter 数据不完整");
    const rates = { USD: 1 };
    rows.forEach((row) => { rates[row.quote] = Number(row.rate); });
    const fetchedAt = Date.now();
    applyRates(rates, rows[0].date, "Frankfurter", fetchedAt);
    writeRateCache({ rates, date: rows[0].date, fetchedAt });
  } catch (primaryError) {
    try {
      const response = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });
      if (!response.ok) throw new Error(`ExchangeRate-API ${response.status}`);
      const data = await response.json();
      const rates = Object.fromEntries(CURRENCY_CODES.map((code) => [code, Number(data.rates?.[code])]));
      if (CURRENCY_CODES.some((code) => !Number.isFinite(rates[code]))) throw new Error("备用汇率数据不完整");
      const fetchedAt = Date.now();
      const date = new Date(data.time_last_update_unix * 1000).toISOString().slice(0, 10);
      applyRates(rates, date, "ExchangeRate-API（备用）", fetchedAt);
      writeRateCache({ rates, date, fetchedAt });
    } catch (fallbackError) {
      const staleCache = readRateCache();
      if (staleCache) {
        applyRates(staleCache.rates, staleCache.date, "过期缓存", staleCache.fetchedAt, true);
      } else {
        applyRates(FALLBACK_RATES, state.rateDate, "离线参考值", 0, true);
      }
      console.warn("汇率服务暂不可用", primaryError, fallbackError);
    }
  }
}

function applyRates(rates, date, source, fetchedAt, isOffline = false) {
  state.rates = rates;
  state.rateDate = date;
  state.rateSource = source;
  state.rateFetchedAt = fetchedAt;
  const message = isOffline ? `${source} · ${date}` : `${source} · ${date} 更新`;
  setRateStatus(isOffline ? "offline" : "online", message);
  if (state.hasCalculated) {
    updateDisplayedRate();
    showToast("汇率已刷新，请重新计算结果");
    markResultStale();
  }
}

function setRateStatus(status, message) {
  elements.compactRateStatus.innerHTML = `<span class="status-dot status-dot--${status}"></span><span>${message}</span>`;
}

function readRateCache() {
  try {
    const data = JSON.parse(localStorage.getItem(RATE_CACHE_KEY));
    if (!data?.rates || !data?.date || !data?.fetchedAt) return null;
    if (CURRENCY_CODES.some((code) => !Number.isFinite(Number(data.rates[code])))) return null;
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
    renderResult({ ...result, amount, convertedValue, purchaseCurrency, targetCurrency });
  } catch (error) {
    elements.formMessage.textContent = error.message || "暂时无法完成计算，请检查输入";
  }
}

function renderResult(result) {
  const { amount, value, convertedValue, ratio, remainingDays, purchaseCurrency, targetCurrency } = result;
  const months = document.querySelector('input[name="billingCycle"]:checked').value;
  const transferAmount = elements.transferAmount.value === "" ? null : Number(elements.transferAmount.value);
  const transferMode = getTransferMode();

  document.querySelector("#remaining-value").textContent = formatCurrency(convertedValue, targetCurrency);
  document.querySelector("#original-remaining-value").textContent = purchaseCurrency === targetCurrency ? "" : `原币约 ${formatCurrency(value, purchaseCurrency)}`;
  document.querySelector("#remaining-days").textContent = String(remainingDays);
  document.querySelector("#remaining-progress").style.width = `${(ratio * 100).toFixed(2)}%`;
  document.querySelector("#remaining-percent").textContent = `剩余 ${(ratio * 100).toFixed(1)}%`;
  document.querySelector("#period-start").textContent = formatShortDate(elements.purchaseDate.value);
  document.querySelector("#period-end").textContent = formatShortDate(elements.expiryDate.value);
  document.querySelector("#result-purchase-price").textContent = formatCurrency(amount, purchaseCurrency);
  document.querySelector("#result-billing-cycle").textContent = `${BILLING_LABELS[months]} · ${result.totalDays} 天`;

  const transferRow = document.querySelector("#transfer-price-row");
  const premiumRow = document.querySelector("#premium-row");
  if (transferAmount !== null && Number.isFinite(transferAmount) && transferAmount >= 0) {
    const finalTransferPrice = transferMode === "premium" ? convertedValue + transferAmount : transferAmount;
    const premium = finalTransferPrice - convertedValue;
    const premiumElement = document.querySelector("#result-premium");
    document.querySelector("#result-transfer-price").textContent = formatCurrency(finalTransferPrice, targetCurrency);
    premiumElement.textContent = `${premium > 0 ? "+" : premium < 0 ? "−" : ""}${formatCurrency(Math.abs(premium), targetCurrency)} · ${premium > 0 ? "溢价" : premium < 0 ? "亏损" : "持平"}`;
    premiumElement.className = premium > 0 ? "positive" : premium < 0 ? "negative" : "";
    transferRow.hidden = false;
    premiumRow.hidden = false;
  } else {
    transferRow.hidden = true;
    premiumRow.hidden = true;
  }

  updateDisplayedRate();
  elements.resultPanel.hidden = false;
  elements.resultContent.hidden = false;
  elements.resultState.textContent = "已计算";
  elements.resultState.className = "result-state result-state--ready";
  state.hasCalculated = true;

  if (window.matchMedia("(max-width: 900px)").matches) {
    elements.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function updateDisplayedRate() {
  const from = elements.purchaseCurrency.value;
  const to = elements.targetCurrency.value;
  let rate = 1;
  try { rate = convertCurrency(1, from, to, state.rates); } catch { /* Keep neutral rate label. */ }
  document.querySelector("#rate-pair").textContent = `1 ${from} = ${formatRate(rate)} ${to}`;
  document.querySelector("#rate-time").textContent = `${state.rateDate} · ${state.rateSource}`;
}

function markResultStale() {
  if (!state.hasCalculated) return;
  elements.resultState.textContent = "待重新计算";
  elements.resultState.className = "result-state result-state--stale";
}

function resetForm() {
  elements.form.reset();
  elements.purchaseCurrency.value = "USD";
  elements.targetCurrency.value = "CNY";
  elements.purchaseDate.value = getLocalDateString(new Date());
  updateExpiryDate();
  updateSymbols();
  elements.formMessage.textContent = "";
  elements.resultPanel.hidden = true;
  elements.resultState.textContent = "等待输入";
  elements.resultState.className = "result-state";
  state.hasCalculated = false;
  showToast("已清空输入");
}

async function copyMarkdown() {
  const rows = Array.from(document.querySelectorAll("#result-content .result-list div:not([hidden])")).map((row) => {
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
    `| 剩余时间 | ${document.querySelector("#remaining-days").textContent} 天 |`,
    ...rows,
    `| 换算汇率 | ${document.querySelector("#rate-pair").textContent} |`,
    `| 汇率日期 | ${state.rateDate}（${state.rateSource}） |`,
  ].join("\n");

  try {
    await navigator.clipboard.writeText(markdown);
    showToast("Markdown 已复制");
  } catch {
    showToast("复制失败，请检查浏览器权限");
  }
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
