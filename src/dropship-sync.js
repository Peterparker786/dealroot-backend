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

const DROPSHIP_PLATFORMS = ["Amazon", "Flipkart", "Meesho"];

// Amazon / Flipkart / Meesho block a User-Agent after a few requests, so we
// rotate through a small set like the existing link-extraction endpoint does.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
];

const FETCH_TIMEOUT_MS = 25000;

const roundMoney = (amount) =>
  Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

const platformForUrl = (url) => {
  let host = "";

  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }

  if (host.includes("amazon")) return "Amazon";
  if (host.includes("flipkart")) return "Flipkart";
  if (host.includes("meesho")) return "Meesho";
  return "";
};

async function fetchHtml(url) {
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENTS[attempt % USER_AGENTS.length],
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "Upgrade-Insecure-Requests": "1",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      lastStatus = response.status;

      if (response.ok) {
        const html = (await response.text()).slice(0, 3000000);

        // A tiny page means a bot/JS wall, not a product page.
        if (html.trim().length >= 800) return html;
      }
    } catch (error) {
      if (error.name === "AbortError" && attempt === 2) {
        throw new Error("Source page timed out — link check karein");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    lastStatus
      ? `Source page load nahi hui (HTTP ${lastStatus})`
      : "Source page load nahi hui"
  );
}

// Reads the *selling* price from the source page. Tried in order of
// reliability: structured data first, then the platform's own markup.
const parsePrice = (html) => {
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
const parseStock = (html) => {
  const availability = html.match(
    /"availability"\s*:\s*"([^"]+)"/i
  )?.[1];

  if (availability) {
    if (/outofstock|soldout|discontinued/i.test(availability)) return false;
    if (/instock|limitedavailability|onlineonly/i.test(availability)) return true;
  }

  if (
    /currently unavailable|out of stock|sold out|notify me when|अभी उपलब्ध नहीं/i.test(
      html
    )
  ) {
    return false;
  }

  if (/add to cart|buy now|add to bag/i.test(html)) return true;

  return null;
};

// Fetches the live price + stock for one marketplace product URL.
async function fetchSourceProduct({ url, platform }) {
  const sourceUrl = String(url || "").trim();

  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error("Valid product URL chahiye (https://...)");
  }

  const html = await fetchHtml(sourceUrl);

  return {
    platform: platform || platformForUrl(sourceUrl),
    price: parsePrice(html),
    inStock: parseStock(html),
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

    const sellingPrice = roundMoney(live.price * entry.multiplier);
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
  fetchSourceProduct,
  createDropshipSyncService,
};
