// DigiHaat's share links (…/digilink/CODE) are a client-rendered app: the raw
// HTML only carries the storefront's generic meta tags, so the real product —
// title, price and gallery images — never appears in it. The reader gateway
// renders the page like a browser and returns markdown, which does.
//
// Shared by the admin extract flow (server.js) and the price sync
// (dropship-sync.js) so both read DigiHaat the same way.

const DIGIHAAT_LIVE_HOST = "https://digihaat.in";

const normalizeDigihaatUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

    if (
      ["digihat.com", "digihaat.com", "digihat.in", "digihaat.in"].includes(host)
    ) {
      return `${DIGIHAAT_LIVE_HOST}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Not a URL — fall through and let the caller report it.
  }

  return rawUrl;
};

const fetchDigihaatRenderedProduct = async (rawUrl) => {
  const url = normalizeDigihaatUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: "text/plain",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const text = (await response.text()).slice(0, 400000);

    if (!text || text.trim().length < 200) return null;

    const markdownImages = [
      ...new Set(
        [...text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)]
          .map((match) => match[1].trim())
          .filter(
            (imageUrl) =>
              /^https?:\/\//i.test(imageUrl) &&
              !/digihaat\.in\/images\/|google-play|app-store|logo|favicon/i.test(
                imageUrl
              )
          )
      ),
    ];

    if (markdownImages.length === 0) return null;

    // Real product photos live under …/product/…; anything else is chrome.
    const images = [
      ...markdownImages.filter((imageUrl) => /\/product\//i.test(imageUrl)),
      ...markdownImages.filter((imageUrl) => !/\/product\//i.test(imageUrl)),
    ].slice(0, 8);

    const title =
      text
        .match(/^#\s+(.{5,220})$/m)?.[1]
        ?.replace(/\s+/g, " ")
        .trim() || "";

    const priceMatch = text.match(/₹\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
    const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;

    const mrpMatch = text.match(
      /₹\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*₹\s*([0-9][0-9,]*(?:\.[0-9]+)?)/
    );
    const mrp = mrpMatch ? Number(mrpMatch[1].replace(/,/g, "")) : 0;

    const brand =
      text.match(/\[Home\][^\n]*?\/\[([^\]]+)\]/)?.[1]?.trim() || "";

    const description = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\*\s+/.test(line))
      .map((line) => line.replace(/^\*\s+/, ""))
      .slice(0, 6)
      .join(" ");

    return {
      url,
      title,
      brand,
      price,
      mrp,
      description,
      images,
      // The rendered product page loaded with a price; treat it as buyable
      // unless it explicitly says otherwise.
      inStock: !/out\s+of\s+stock|sold\s+out|currently\s+unavailable|notify\s+me/i.test(
        text
      ),
      context: [title, `Price: Rs ${price}`, description]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1000),
    };
  } catch (error) {
    console.error("DigiHaat render fallback failed:", error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { normalizeDigihaatUrl, fetchDigihaatRenderedProduct };
