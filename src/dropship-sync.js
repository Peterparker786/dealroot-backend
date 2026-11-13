// ===================== DROPSHIP LIVE PRICE SYNC =====================
// Everything dropship-related lives here and in its own `DropshipProduct`
// collection, so the regular product schema, product listing and checkout
// flow stay completely untouched. A dropship product is still a normal
// document in the `Product` collection (so it shows up in the storefront,
// cart and checkout exactly like any other product); this module only
// reads its marketplace source and keeps price/stock in sync.
//
// Fallback rule (important): if a scrape fails, is blocked, or returns 0,
// the saved price is never overwritten — the entry is only marked as failed.

const { fetchDigihaatRenderedProduct } = require("./digihaat-render");

const DROPSHIP_PLATFORMS = ["Amazon", "Flipkart", "Meesho", "DigiHaat"];

// Amazon / Flipkart / Meesho / DigiHaat block a User-Agent after a few
// requests, so we rotate through a small set of FULL browser fingerprints
// (not just the UA string) like a real desktop/mobile visitor would look.
const BROWSER_PROFILES = [
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="130", "Chromium";v="130", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
  },
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  },
];

// Whole-page budget (direct attempts + every proxy gateway). Without a budget
// a blocked Flipkart page could burn minutes on retries and time the whole
// admin request out.
const PAGE_BUDGET_MS = 30000;
const FETCH_TIMEOUT_MS = 12000;

const PLATFORM_HOME = {
  Amazon: "https://www.amazon.in/",
  Flipkart: "https://www.flipkart.com/",
  Meesho: "https://www.meesho.com/",
  DigiHaat: "https://www.digihaat.in/",
};

// Full navigation headers for a product page request. The Referer is the
// marketplace home page, which is what a browser sends when a visitor clicks
// through from the homepage/search instead of hitting the URL cold.
const browserHeadersFor = (url, attempt = 0, platform = "") => {
  const profile = BROWSER_PROFILES[attempt % BROWSER_PROFILES.length];
  const home = PLATFORM_HOME[platformForUrl(url) || platform] || "";

  return {
    ...profile,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": home ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    ...(home ? { Referer: home } : {}),
  };
};

// Text that marketplaces put on their block / CAPTCHA pages. Matched only on
// the first chunk of the page so a normal product description can never trip it.
const BLOCK_MARKERS =
  /ip[\s_-]?blocked|access denied|unusual traffic|are you a robot|verify (?:that )?you are (?:a )?human|request blocked|px-captcha|incapsula|cf-error|just a moment\.\.\.|enable javascript and cookies to continue|enter the characters you see below|type the characters you see|api-services-support@amazon\.com|to discuss automated access|sorry,? we just need to make sure you(?:'|&#39;|’)re not a robot/i;

const BLOCK_STATUSES = [403, 429, 451, 503];

// A page is unusable when the status says blocked OR the body is a tiny shell /
// CAPTCHA wall. Both cases move the request to the proxy fallback.
const looksBlocked = (html = "", status = 200) => {
  if (BLOCK_STATUSES.includes(Number(status))) return true;

  const head = String(html).slice(0, 20000);

  if (head.trim().length < 800) return true;

  return BLOCK_MARKERS.test(head);
};

// A product page must carry some product data. Amazon also answers with a
// short "continue shopping" interstitial (HTTP 200) that has no price, stock
// or title, which would otherwise look like a valid page with an empty price.
const looksLikeProductPage = (html = "") =>
  /id=["']productTitle["']|class=["'][^"']*a-price-whole|itemprop=["']price["']|"og:title"|class=["'][^"']*_30jeq3|add\s+to\s+cart|add\s+to\s+bag|buy\s+now/i.test(
    String(html).slice(0, 400000)
  );

// Free read-through gateways, tried in order when a platform blocks our IP.
// `SCRAPER_PROXY_TEMPLATE` (e.g. "https://user:pass@proxy.example/fetch?url={url}")
// can be set in .env to put a dedicated proxy in front of all of them.
// Flipkart answers 429 to datacenter IPs (Render included) and every free
// read-through proxy is either rate limited or already blocked by Flipkart.
// Google's translate proxy still serves the full page from its own IPs, with
// the original markup, so it is the gateway that actually rescues Flipkart.
const TRANSLATE_PROXY_HOSTS =
  /^(?:www\.)?(?:flipkart|amazon|meesho)\.(?:com|in)$/i;

const googleTranslateProxyUrl = (url) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (!TRANSLATE_PROXY_HOSTS.test(host)) return "";

    const params = new URLSearchParams(parsed.search);
    params.set("_x_tr_sl", "auto");
    params.set("_x_tr_tl", "en");
    params.set("_x_tr_hl", "en");
    params.set("_x_tr_pto", "wapp");

    return `https://${host.replace(/\./g, "-")}.translate.goog${parsed.pathname}?${params.toString()}`;
  } catch {
    return "";
  }
};

const PROXY_GATEWAYS = [
  {
    // Text only: an image request must never be routed through it.
    name: "translate",
    textOnly: true,
    build: (url) => googleTranslateProxyUrl(url),
  },
  {
    name: "reader",
    build: (url) => `https://r.jina.ai/${url}`,
  },
  {
    name: "allorigins",
    build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: "codetabs",
    build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  {
    name: "corsproxy",
    build: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  },
];

const proxyGateways = () => {
  const template = String(process.env.SCRAPER_PROXY_TEMPLATE || "").trim();

  if (!template.includes("{url}")) return PROXY_GATEWAYS;

  return [
    {
      name: "custom-proxy",
      build: (url) => template.replace("{url}", encodeURIComponent(url)),
    },
    ...PROXY_GATEWAYS,
  ];
};

// One request through the first gateway that answers with something usable.
// Binary (images) and text (HTML/markdown) are both handled, because the
// gateways return whatever content type the origin sent.
const fetchThroughGateways = async (
  url,
  { timeoutMs = 12000, budgetMs = 0, maxGateways = 4, binaryOnly = false } = {}
) => {
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0;

  for (const gateway of proxyGateways().slice(0, maxGateways)) {
    if (deadline && Date.now() + 2000 > deadline) break;
    if (binaryOnly && gateway.textOnly) continue;

    const gatewayUrl = gateway.build(url);

    if (!gatewayUrl) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(gatewayUrl, {
        headers: {
          "User-Agent": BROWSER_PROFILES[0]["User-Agent"],
          Accept: "*/*",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      if (!response.ok) continue;

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const isBinary = /^(image|application\/octet-stream)/.test(contentType);

      // An image request must never accept an HTML/text answer (the markdown
      // reader always replies with text), otherwise one gateway would swallow
      // the whole fallback chain.
      if (binaryOnly && !isBinary) continue;

      if (isBinary) {
        const buffer = Buffer.from(await response.arrayBuffer());

        if (buffer.length > 1000) {
          return { buffer, contentType, gateway: gateway.name };
        }

        continue;
      }

      const text = (await response.text()).slice(0, 3000000);

      if (text.trim().length >= 800) {
        return { text, contentType, gateway: gateway.name };
      }
    } catch {
      // gateway down / timed out — try the next one
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
};

// The reader gateway (r.jina.ai) answers with markdown, not HTML. Price parsing
// already works on plain text, but the title/description/image extractor needs
// tags — so the markdown is converted into the small HTML skeleton it expects.
const markdownToPseudoHtml = (markdown, sourceUrl) => {
  const escape = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const title = (markdown.match(/^Title:\s*(.+)$/m)?.[1] || "").trim();

  const images = [
    ...new Set(
      [...markdown.matchAll(/!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g)].map(
        (match) => match[1]
      )
    ),
  ].slice(0, 10);

  const bodyText = markdown.split(/Markdown Content:/i)[1] || markdown;
  const description = bodyText
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*_`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);

  return [
    "<html><head>",
    `<title>${escape(title)}</title>`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(description)}" />`,
    images[0]
      ? `<meta property="og:image" content="${escape(images[0])}" />`
      : "",
    `<meta property="og:url" content="${escape(sourceUrl)}" />`,
    "</head><body>",
    ...images.map((src) => `<img src="${escape(src)}" />`),
    `<p>${escape(description)}</p>`,
    `<pre>${escape(markdown.slice(0, 200000))}</pre>`,
    "</body></html>",
  ].join("");
};

const imageMagicOk = (buffer) => {
  if (!buffer || buffer.length < 1000) return false;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return true;
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return true;
  }

  return buffer.subarray(0, 3).toString("ascii") === "GIF";
};

// Downloads one product image. A 403 on the image host (Flipkart blocks the
// CDN per-IP too) is retried through the free gateways, and the bytes are
// magic-checked so a "blocked" HTML error page is never treated as an image.
const fetchImageBuffer = async (
  imageUrl,
  { referer = "", timeoutMs = 12000, budgetMs = 0 } = {}
) => {
  try {
    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": BROWSER_PROFILES[0]["User-Agent"],
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    if (response.ok && imageMagicOk(buffer)) {
      return {
        buffer,
        contentType: response.headers.get("content-type") || "image/jpeg",
        via: "direct",
      };
    }
  } catch {
    // fall through to the gateways
  }

  const proxied = await fetchThroughGateways(imageUrl, {
    timeoutMs: Math.min(timeoutMs, 10000),
    budgetMs,
    maxGateways: 3,
    binaryOnly: true,
  });

  if (proxied?.buffer && imageMagicOk(proxied.buffer)) {
    return {
      buffer: proxied.buffer,
      contentType: proxied.contentType || "image/jpeg",
      via: proxied.gateway,
    };
  }

  return null;
};

const roundMoney = (amount) =>
  Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

// Default markup: 100% on top of the source price, i.e. the old hardcoded 2x.
const DEFAULT_MARGIN_PERCENT = 100;

// Selling price from the entry's saved margin rule.
//   percentage -> source + (source * margin/100)   (100% = 2x, 50% = 1.5x)
//   flat       -> source + fixed rupee amount
// Older entries that only stored a `multiplier` keep working: the multiplier
// is translated into the equivalent percentage margin.
const sellingPriceFor = (sourcePrice, entry = {}) => {
  const source = Number(sourcePrice);

  if (!Number.isFinite(source) || source <= 0) return 0;

  if (String(entry.marginType || "").toLowerCase() === "flat") {
    const flat = Number(entry.marginValue);
    return roundMoney(source + (Number.isFinite(flat) ? Math.max(0, flat) : 0));
  }

  const savedPercent = Number(entry.marginValue);
  const legacyMultiplier = Number(entry.multiplier);
  const percent =
    Number.isFinite(savedPercent) && savedPercent >= 0
      ? savedPercent
      : Number.isFinite(legacyMultiplier) && legacyMultiplier > 0
        ? Math.max(0, (legacyMultiplier - 1) * 100)
        : DEFAULT_MARGIN_PERCENT;

  return roundMoney(source + (source * percent) / 100);
};

// Human readable margin, e.g. "+100%" or "+₹200 flat".
const marginLabelFor = (entry = {}) => {
  if (String(entry.marginType || "").toLowerCase() === "flat") {
    return `+₹${Number(entry.marginValue) || 0} flat`;
  }

  const legacyMultiplier = Number(entry.multiplier);
  const percent =
    Number.isFinite(Number(entry.marginValue)) && Number(entry.marginValue) >= 0
      ? Number(entry.marginValue)
      : Number.isFinite(legacyMultiplier) && legacyMultiplier > 0
        ? Math.max(0, (legacyMultiplier - 1) * 100)
        : DEFAULT_MARGIN_PERCENT;

  return `+${percent}%`;
};

const platformForUrl = (url) => {
  let host = "";

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }

  // Short links too: amzn.in/amzn.to/a.co are Amazon's own, fkrt.it is
  // Flipkart's. The fetch follows the redirect to the real product page.
  if (
    host.includes("amazon") ||
    /(^|\.)amzn\.(in|to|eu)$/.test(host) ||
    host === "a.co"
  ) {
    return "Amazon";
  }
  if (host.includes("flipkart") || /(^|\.)fkrt\.it$/.test(host)) return "Flipkart";
  if (host.includes("meesho")) return "Meesho";
  // DigiHaat is the ONDC marketplace at digihaat.in — accept the common
  // "digihat" spelling too, since people type it both ways.
  if (host.includes("digihaat") || host.includes("digihat")) return "DigiHaat";
  return "";
};

// Flipkart blocks its HTML pages (HTTP 429) for every datacenter IP, including
// Render and every free proxy, but the endpoint its own web app calls still
// answers normally. It returns the product JSON, which is turned into the same
// small markup the shared extractors already understand.
const fetchFlipkartApiPage = async (url) => {
  try {
    const parsed = new URL(url);

    if (!/(^|\.)flipkart\.com$/i.test(parsed.hostname)) return null;

    const response = await fetch("https://www.flipkart.com/api/4/page/fetch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        // Flipkart's API rejects the request without this browser fingerprint.
        "x-user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop",
        accept: "*/*",
        "accept-language": "en-IN,en;q=0.9",
        origin: "https://www.flipkart.com",
        referer: "https://www.flipkart.com/",
      },
      body: JSON.stringify({
        pageUri: `${parsed.pathname}${parsed.search}`,
        requestContext: { type: "BROWSE_PAGE" },
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) return null;

    const text = await response.text();

    if (text.length < 5000) return null;

    const priceBlock = text.match(
      /"ppd":\{"fsp":([0-9.]+),"finalPrice":([0-9.]+),"mrp":([0-9.]+)/
    );
    const price = Number(priceBlock?.[2] || priceBlock?.[1] || 0);

    if (!Number.isFinite(price) || price <= 0) return null;

    const mrp = Number(priceBlock?.[3] || 0);

    const decode = (value) =>
      String(value || "")
        .replace(/\\u002F/g, "/")
        .replace(/\\+/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();

    const title = decode(text.match(/"ogTitle":"([^"]+)"/)?.[1])
      .replace(/\s*Online at Best Price.*$/i, "")
      .trim();

    const description = decode(
      text.match(/"ogDescription":"([^"]+)"/)?.[1] ||
        text.match(/"description":"(Buy [^"]{20,600})"/)?.[1]
    );
    const brand = decode(text.match(/"bd":"([^"]{1,40})"/)?.[1]);

    const availability = text.match(
      /"availability":"https:\/\/schema\.org\/(InStock|OutOfStock|[A-Za-z]+)"/
    )?.[1];
    const inStock =
      availability === "InStock"
        ? true
        : availability === "OutOfStock"
          ? false
          : null;

    const images = [
      ...new Set(
        (
          text.match(
            /https:\\?\/\\?\/rukmini[^"\\]*?\/image\/[^"\\]+/g
          ) || []
        )
          .map((imageUrl) =>
            imageUrl
              .replace(/\\\//g, "/")
              .replace(/\{@width\}/g, "832")
              .replace(/\{@height\}/g, "832")
              .replace(/\{@quality\}/g, "80")
          )
          .filter((imageUrl) => !/\/promos\//i.test(imageUrl))
      ),
    ].slice(0, 8);

    const escape = (value) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const html = [
      "<html><head>",
      `<title>${escape(title)}</title>`,
      `<meta property="og:title" content="${escape(title)}" />`,
      `<meta property="og:description" content="${escape(description)}" />`,
      images[0]
        ? `<meta property="og:image" content="${escape(images[0])}" />`
        : "",
      `<meta property="og:url" content="${escape(url)}" />`,
      `<meta name="brand" content="${escape(brand)}" />`,
      "</head><body>",
      `<div class="_30jeq3 _16Jk6d">\u20b9${price.toLocaleString("en-IN")}</div>`,
      mrp > price
        ? `<div class="_3I9_wc">\u20b9${mrp.toLocaleString("en-IN")}</div>`
        : "",
      // The shared stock parser reads these two strings; only one is present.
      inStock === false ? "<p>Out of stock</p>" : "<p>Add to cart</p>",
      ...images.map((src) => `<img src="${escape(src)}" />`),
      "</body></html>",
    ].join("");

    return {
      html,
      via: "flipkart-api",
      status: 200,
      warnings: [],
      // The extractor prefers this structured form over re-reading the markup.
      product: { title, brand, price, mrp, description, images, inStock },
    };
  } catch (error) {
    console.error("Flipkart API fallback failed:", error.message);
    return null;
  }
};

// Loads the raw page HTML with a two stage strategy:
//   1. direct request using rotating realistic browser fingerprints
//   2. free proxy gateway (Flipkart/Amazon answer 403 to a datacenter IP)
// Flipkart additionally uses its own page API first, because its HTML pages are
// blocked outright for datacenter IPs.
// Throws an error with `code = "BLOCKED"` when both stages fail, so the admin
// UI can offer the screenshot / manual-image fallbacks instead of a dead end.
async function fetchPageHtml(url, { platform = "" } = {}) {
  if (String(platform || platformForUrl(url) || "").toLowerCase() === "flipkart") {
    const apiPage = await fetchFlipkartApiPage(url);

    if (apiPage) return apiPage;
  }

  let lastStatus = 0;
  let sawBlock = false;
  let sawTimeout = false;

  const deadline = Date.now() + PAGE_BUDGET_MS;

  for (let attempt = 0; attempt < BROWSER_PROFILES.length; attempt += 1) {
    const remaining = deadline - Date.now();

    if (remaining < 6000) break;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(FETCH_TIMEOUT_MS, remaining)
    );

    try {
      const response = await fetch(url, {
        headers: browserHeadersFor(url, attempt, platform),
        redirect: "follow",
        signal: controller.signal,
      });

      lastStatus = response.status;

      const html = (await response.text()).slice(0, 3000000);

      if (
        response.ok &&
        !looksBlocked(html, response.status) &&
        looksLikeProductPage(html)
      ) {
        return { html, via: "direct", status: response.status, warnings: [] };
      }

      if (
        looksBlocked(html, response.status) ||
        (response.ok && !looksLikeProductPage(html))
      ) {
        sawBlock = true;
      }
    } catch (error) {
      if (error.name === "AbortError") sawTimeout = true;
    } finally {
      clearTimeout(timer);
    }
  }

  // Stage 2 — the free read-through gateways, inside the remaining budget.
  const proxied = await fetchThroughGateways(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    budgetMs: Math.max(0, deadline - Date.now()),
  });

  if (proxied?.text && !looksBlocked(proxied.text, 200)) {
    const isMarkdown =
      proxied.gateway === "reader" || /^Title:\s*.+$/m.test(proxied.text.slice(0, 2000));

    return {
      html: isMarkdown
        ? markdownToPseudoHtml(proxied.text, url)
        : // The translate proxy serves a copy with its own base URL; restoring
          // the real one keeps relative image links pointing at the marketplace.
          proxied.text.replace(
            /<base\s+href=["'][^"']*["']\s*\/?>/i,
            `<base href="${url}">`
          ),
      via: proxied.gateway,
      status: 200,
      warnings: [
        `${platform || platformForUrl(url) || "Source"} ne direct request block kar di — backup proxy (${proxied.gateway}) se data liya gaya. Images kam aa sakti hain.`,
      ],
    };
  }

  const label = platform || platformForUrl(url) || "Source page";
  const reason = lastStatus
    ? `${label} ne request block kar di (HTTP ${lastStatus}${BLOCK_STATUSES.includes(lastStatus) ? " — IP blocked" : ""})`
    : sawTimeout
      ? "Source page load nahi hui (timeout)"
      : "Source page load nahi hui";

  const error = new Error(
    `${reason} — free proxy fallback bhi fail hua. AI Screenshot Extract ya images ka manual upload use karein.`
  );

  error.code = sawBlock || BLOCK_STATUSES.includes(lastStatus) ? "BLOCKED" : "FETCH_FAILED";
  error.status = lastStatus || 0;

  throw error;
}

// DigiHaat (ONDC) serves prices inside its own payload/markup shapes, so it
// gets a dedicated block that is tried before the shared patterns. Returns
// null when nothing usable is found, and the caller then falls back to the
// generic patterns below.
const DIGIHAAT_PRICE_PATTERNS = [
  // ONDC / Beckn price object: "price": { "value": 298, "currency": "INR" }
  /"price"\s*:\s*\{\s*"value"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
  /"sellingPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
  /"finalPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
  /"offerPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
  /"discountedPrice"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
  /"value"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?\s*,\s*"currency"\s*:\s*"INR"/i,
  // Rendered price block, e.g. "₹298₹500(15% OFF)" — the first number is the
  // actual selling price, the second one is the struck-through MRP.
  /₹\s*([0-9][0-9,]{0,8})\s*(?:₹|<)/,
];

const parseDigiHaatPrice = (html) => {
  for (const pattern of DIGIHAAT_PRICE_PATTERNS) {
    const match = html.match(pattern);
    const value = Number(String(match?.[1] || "").replace(/,/g, ""));

    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
};

// DigiHaat availability: ONDC payloads carry a status field, and the rendered
// page falls back to plain "Sold out" / "Out of stock" text.
const parseDigiHaatStock = (html) => {
  const status = html.match(
    /"(?:stockStatus|availability|inventoryStatus)"\s*:\s*"([^"]+)"/i
  )?.[1];

  if (status) {
    if (/out[\s_-]*of[\s_-]*stock|sold[\s_-]*out|unavailable|discontinued/i.test(status)) {
      return false;
    }

    if (/in[\s_-]*stock|available/i.test(status)) return true;
  }

  if (/out\s+of\s+stock|sold\s+out|currently\s+unavailable|notify\s+me/i.test(html)) {
    return false;
  }

  if (/add\s+to\s+cart|buy\s+now/i.test(html)) return true;

  return null;
};

// Amazon's own buy-box availability, which is far more reliable than scanning
// the whole page: product pages routinely contain "Currently unavailable" in
// other sellers / recommendation blocks even when the main offer is in stock.
const parseAmazonStock = (html) => {
  if (/id=["']outOfStock["']/i.test(html)) return false;

  // A rendered buy box is the strongest possible in-stock signal.
  if (
    /id=["']add-to-cart-button["']/i.test(html) ||
    /name=["']submit\.add-to-cart["']/i.test(html)
  ) {
    return true;
  }

  const availabilityBlock =
    html.match(/id=["']availability["'][^>]*>([\s\S]{0,400}?)<\/(?:div|span)>/i)?.[1] ||
    "";

  const availabilityText = availabilityBlock
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/currently unavailable|out of stock|unavailable/i.test(availabilityText)) {
    return false;
  }

  if (/in stock|only \d+ left/i.test(availabilityText)) return true;

  return null;
};

// Reads the *selling* price from the source page. Tried in order of
// reliability: structured data first, then the platform's own markup.
const parsePrice = (html, platform = "") => {
  // DigiHaat-specific block first — every other platform keeps the exact same
  // pattern order it had before.
  if (String(platform).toLowerCase().includes("digihaat")) {
    const digiHaatPrice = parseDigiHaatPrice(html);

    if (digiHaatPrice) return digiHaatPrice;
  }

  // Amazon: the buy-box price is what a shopper actually pays, so it wins over
  // any other "price" that appears in the page's embedded JSON.
  if (String(platform).toLowerCase().includes("amazon")) {
    const amazonPatterns = [
      /id=["'](?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|priceblock_ourprice|priceblock_dealprice)["'][\s\S]{0,4000}?class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)/i,
      /class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)/i,
      /id=["']priceblock_ourprice["'][^>]*>\s*(?:₹|&#8377;|Rs\.?)?\s*([0-9,]+)/i,
    ];

    for (const pattern of amazonPatterns) {
      const value = Number(
        String(html.match(pattern)?.[1] || "").replace(/,/g, "")
      );

      if (Number.isFinite(value) && value > 0) return value;
    }
  }

  const patterns = [
    // JSON-LD / embedded product JSON
    /"price"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
    /"priceAmount"\s*:\s*"?([0-9]+(?:\.[0-9]{1,2})?)"?/i,
    /"priceToPay"\s*:\s*\{[^}]*"price"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /"discountedPrice"\s*:\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    // itemprop="price" content="1299"
    /itemprop=["']price["'][^>]*content=["']([0-9,.]+)["']/i,
    // Amazon: <span class="a-price-whole">1,299</span>
    /class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([0-9,]+)/i,
    // Flipkart: <div class="_30jeq3 _16Jk6d">₹1,299</div>
    /class=["'][^"']*_30jeq3[^"']*["'][^>]*>\s*(?:₹|&#8377;|Rs\.?)?\s*([0-9,]+)/i,
    // Meesho / generic rupee price in markup
    /(?:₹|&#8377;|Rs\.?\s*)\s*([0-9][0-9,]{1,8})(?:\.\d{1,2})?/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = Number(String(match?.[1] || "").replace(/,/g, ""));

    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
};

// true = in stock, false = out of stock, null = could not tell.
const parseStock = (html, platform = "") => {
  const isAmazon = String(platform).toLowerCase().includes("amazon");

  if (String(platform).toLowerCase().includes("digihaat")) {
    const digiHaatStock = parseDigiHaatStock(html);

    if (digiHaatStock !== null) return digiHaatStock;
  }

  if (isAmazon) {
    const amazonStock = parseAmazonStock(html);

    if (amazonStock !== null) return amazonStock;
  }

  const availability = html.match(
    /"availability"\s*:\s*"([^"]+)"/i
  )?.[1];

  if (availability) {
    // \s* keeps the old camelCase values (OutOfStock/InStock) working while
    // also accepting spaced ones ("out of stock", "in stock").
    if (/out\s*of\s*stock|sold\s*out|discontinued/i.test(availability)) return false;
    if (/in\s*stock|limited\s*availability|online\s*only/i.test(availability)) return true;
  }

  // Loose whole-page scan, skipped for Amazon where those words also appear in
  // other-seller and recommendation blocks.
  if (
    !isAmazon &&
    /currently unavailable|out of stock|sold out|notify me when|अभी उपलब्ध नहीं/i.test(
      html
    )
  ) {
    return false;
  }

  if (/add to cart|buy now|add to bag/i.test(html)) return true;

  return null;
};

// Downloads the raw source page plus the resolved platform. The admin
// "extract details" flow needs the HTML too (title/description/images), while
// the price sync only needs the parsed numbers.
async function fetchSourcePage({ url, platform }) {
  const sourceUrl = String(url || "").trim();

  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error("Valid product URL chahiye (https://...)");
  }

  // Resolve the platform before parsing so the DigiHaat block can run even
  // when the caller only supplied a URL.
  const resolvedPlatform = platform || platformForUrl(sourceUrl);
  const page = await fetchPageHtml(sourceUrl, { platform: resolvedPlatform });

  return {
    platform: resolvedPlatform,
    html: page.html,
    via: page.via,
    warnings: page.warnings || [],
    product: page.product || null,
  };
}

// Fetches the live price + stock for one marketplace product URL.
async function fetchSourceProduct({ url, platform }) {
  const initialPlatform = platform || platformForUrl(url) || "";

  // DigiHaat's product pages are rendered client-side, so the raw HTML has no
  // price. Start reading the rendered page in parallel with the normal fetch
  // so the admin does not wait for two timeouts back to back.
  const renderedPromise =
    initialPlatform === "DigiHaat"
      ? fetchDigihaatRenderedProduct(url)
      : Promise.resolve(null);

  // Everything DigiHaat needs (price, stock) comes from the rendered page, so
  // only hit the raw HTML when that fails.
  if (initialPlatform === "DigiHaat") {
    const renderedFirst = await renderedPromise;

    if (renderedFirst?.price > 0) {
      return {
        platform: "DigiHaat",
        price: renderedFirst.price,
        inStock: renderedFirst.inStock ?? null,
        fetchedAt: new Date(),
      };
    }
  }

  let page = null;
  let pageError = null;

  try {
    page = await fetchSourcePage({ url, platform });
  } catch (error) {
    pageError = error;
  }

  const resolvedPlatform =
    page?.platform || platform || platformForUrl(url) || "";

  let price = page ? parsePrice(page.html, resolvedPlatform) : 0;
  let inStock = page ? parseStock(page.html, resolvedPlatform) : null;

  const rendered = await renderedPromise;

  if (resolvedPlatform === "DigiHaat" && (!price || price <= 0)) {
    if (rendered?.price > 0) {
      price = rendered.price;

      if (inStock === null && rendered.inStock !== undefined) {
        inStock = rendered.inStock;
      }
    }
  }

  if (!price || price <= 0) {
    if (!page && pageError) throw pageError;
  }

  return {
    platform: resolvedPlatform,
    price,
    inStock,
    fetchedAt: new Date(),
  };
}

// Builds the sync engine over the real models (passed in so this module never
// needs its own mongoose connection or model definitions).
function createDropshipSyncService({ Product, DropshipProduct }) {
  let running = false;

  const syncOne = async (entry) => {
    const checkedAt = new Date();

    let live = null;

    try {
      live = await fetchSourceProduct({
        url: entry.sourceUrl,
        platform: entry.platform,
      });
    } catch (error) {
      entry.lastCheckedAt = checkedAt;
      entry.lastSyncStatus = "failed";
      entry.lastSyncError = error.message;
      await entry.save();

      return { updated: false, reason: error.message };
    }

    // Fallback: a failed / zero scrape must never overwrite the saved price.
    if (!live.price || !Number.isFinite(live.price) || live.price <= 0) {
      entry.lastCheckedAt = checkedAt;
      entry.lastSyncStatus = "failed";
      entry.lastSyncError = "Live price nahi mila — purana price rakha gaya";
      await entry.save();

      return { updated: false, reason: "price-not-found" };
    }

    const product = await Product.findById(entry.product).lean();

    if (!product) {
      entry.active = false;
      entry.lastCheckedAt = checkedAt;
      entry.lastSyncStatus = "failed";
      entry.lastSyncError = "Catalog product delete ho chuka hai";
      await entry.save();

      return { updated: false, reason: "product-missing" };
    }

    const sellingPrice = sellingPriceFor(live.price, entry);
    const update = {
      price: sellingPrice,
      // MRP must never sit below the selling price.
      mrp: Math.max(sellingPrice, Number(product.mrp) || 0),
    };

    if (live.inStock === false) {
      update.stock = 0;
    } else if (live.inStock === true && Number(product.stock) <= 0) {
      // Back in stock at the source — restore the catalog stock. A product
      // that still has stock keeps its real inventory count untouched.
      update.stock = Math.max(1, Number(entry.stockWhenAvailable) || 20);
    }

    await Product.findByIdAndUpdate(entry.product, { $set: update });

    entry.sourcePrice = live.price;
    entry.sellingPrice = sellingPrice;
    entry.inStock = live.inStock !== false;
    entry.lastCheckedAt = checkedAt;
    entry.lastSyncedAt = checkedAt;
    entry.lastSyncStatus = "ok";
    entry.lastSyncError = "";
    await entry.save();

    return { updated: true, sellingPrice };
  };

  // Syncs every active dropship entry, one at a time (never hammers the
  // marketplaces in parallel). Returns a small report for the admin UI.
  const syncAll = async () => {
    if (running) {
      return { skipped: true, checked: 0, updated: 0, failed: 0 };
    }

    running = true;

    const report = { skipped: false, checked: 0, updated: 0, failed: 0 };

    try {
      const entries = await DropshipProduct.find({ active: true });

      for (const entry of entries) {
        report.checked += 1;

        const result = await syncOne(entry);

        if (result.updated) {
          report.updated += 1;
        } else {
          report.failed += 1;
        }
      }
    } finally {
      running = false;
    }

    return report;
  };

  return { syncOne, syncAll, isRunning: () => running };
}

module.exports = {
  DROPSHIP_PLATFORMS,
  DEFAULT_MARGIN_PERCENT,
  fetchImageBuffer,
  fetchSourcePage,
  fetchSourceProduct,
  looksBlocked,
  marginLabelFor,
  parsePrice,
  parseStock,
  platformForUrl,
  sellingPriceFor,
  createDropshipSyncService,
};
