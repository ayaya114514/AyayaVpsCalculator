# AyayaVpsCalculator

一个 dark theme 的 VPS 剩余价值计算器。根据当前计费周期按天折算剩余价值，并通过在线汇率在 8 种货币之间换算。

## 支持货币

USD、CNY、GBP、EUR、CAD、JPY、SGD、HKD。

## 本地运行

```bash
npm run serve
```

打开 `http://localhost:4173`。运行逻辑测试：

```bash
npm test
```

## 汇率说明

- 首选 [Frankfurter](https://frankfurter.dev/) 的最新中央银行参考汇率，无需 API key。
- 请求失败或 8 秒超时时自动尝试 ExchangeRate-API 的开放接口；使用其汇率时页面按条款显示 “Rates By Exchange Rate API” 署名链接。
- 成功结果在浏览器缓存 6 小时；网络不可用时使用过期缓存或内置参考值，并在页面标明来源。
- 汇率用于估算，不代表支付平台或银行的实际成交价。

## GitHub Pages 部署

1. 将项目 push 到 GitHub repository 的 `main` branch。
2. 在 repository 的 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。
3. `.github/workflows/deploy.yml` 会在每次 push 后先运行 `npm test`，再只发布站点文件（`index.html`、`app.js`、`calculator.js`、`styles.css`、`favicon.svg`）。

项目使用相对路径，可直接部署到 `https://<username>.github.io/<repository>/` 子路径。
