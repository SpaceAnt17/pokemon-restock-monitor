
/**
 * Walmart Pokemon TCG Restock Scraper
 *
 * Features:
 * - Walmart search-page extraction
 * - First-party Walmart seller filtering
 * - Detailed seller diagnostics
 * - Product deduplication
 * - Online stock and preorder detection
 * - Multiple Pokemon TCG search terms
 * - Pagination
 * - Retry and error handling
 *
 * Compatible with monitor.js and config.js.
 */

const axios = require('axios');
const config = require('../config');
const { withRetry, sleep } = require('../utils/retry');

const WALMART_BASE = 'https://www.walmart.com';
const SEARCH_URL = `${WALMART_BASE}/search`;

const WALMART_SELLER_ID =
  'F55CDC31AB754BB68FE0B39041159D63';

const SEARCH_KEYWORDS = [
  'pokemon trading card game',
  'pokemon booster pack',
  'pokemon booster bundle',
  'pokemon elite trainer box',
  'pokemon tin',
  'pokemon collection box',
];

const DELAY_MS = 2000;
const MAX_RETRIES = 3;
const DEBUG_SAMPLE_LIMIT = 8;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',

  'Accept':
    'text/html,application/xhtml+xml,' +
    'application/xml;q=0.9,*/*;q=0.8',

  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

// --------------------------------------------------
// SESSION
// --------------------------------------------------

async function initSession() {
  const response = await axios.get(
    `${WALMART_BASE}/`,
    {
      headers: HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    }
  );

  const cookies = (
    response.headers['set-cookie'] || []
  )
    .map(cookie => cookie.split(';')[0])
    .join('; ');

  return cookies;
}

// --------------------------------------------------
// FETCH SEARCH PAGE
// --------------------------------------------------

async function fetchPage(cookies, keyword, page) {
  return withRetry(
    async () => {
      const response = await axios.get(
        SEARCH_URL,
        {
          params: {
            q: keyword,
            page,
          },

          headers: {
            ...HEADERS,
            Referer: `${WALMART_BASE}/`,
            ...(cookies
              ? { Cookie: cookies }
              : {}),
          },

          timeout: 30000,
          decompress: true,
        }
      );

      if (typeof response.data !== 'string') {
        throw new Error(
          'Unexpected Walmart response format'
        );
      }

      return response.data;
    },

    {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: 2000,

      isRetryable(error) {
        const status = error.response?.status;

        return (
          status === 429 ||
          status >= 500 ||
          !status ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT'
        );
      },

      onRetry(error, attempt, delay) {
        console.warn(
          `[Walmart] Retry ${attempt}: ` +
          `${error.message}. Waiting ${delay}ms`
        );
      },
    }
  );
}

// --------------------------------------------------
// EXTRACT NEXT DATA
// --------------------------------------------------

function parseNextData(html) {
  if (typeof html !== 'string') {
    return null;
  }

  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    console.warn(
      '[Walmart] Could not parse __NEXT_DATA__:',
      error.message
    );

    return null;
  }
}

// --------------------------------------------------
// EXTRACT PRODUCTS
// --------------------------------------------------

function extractItems(nextData) {
  const stacks =
    nextData?.props?.pageProps?.initialData
      ?.searchResult?.itemStacks || [];

  return stacks
    .flatMap(stack => stack.items || [])
    .filter(item => item && item.usItemId);
}

function extractPagination(nextData) {
  const result =
    nextData?.props?.pageProps?.initialData
      ?.searchResult || {};

  return {
    maxPage: result.paginationV2?.maxPage || 1,
    hasMorePages: result.hasMorePages || false,
    total:
      result.aggregatedCount ||
      result.count ||
      0,
  };
}

// --------------------------------------------------
// SELLER INFORMATION
// --------------------------------------------------

function getSellerInfo(item) {
  return {
    sellerName: item.sellerName ?? null,
    sellerId: item.sellerId ?? null,
    sellerType: item.sellerType ?? null,
    catalogSellerId:
      item.catalogSellerId ?? null,

    sellerDisplayName:
      item.sellerDisplayName ?? null,

    seller:
      item.seller ?? null,
  };
}

// --------------------------------------------------
// WALMART FIRST-PARTY CHECK
// --------------------------------------------------

function isSoldByWalmart(item) {
  const sellerName = String(
    item.sellerName || ''
  ).trim().toLowerCase();

  const sellerId = String(
    item.sellerId || ''
  ).trim().toUpperCase();

  const sellerDisplayName = String(
    item.sellerDisplayName || ''
  ).trim().toLowerCase();

  const catalogSellerId = String(
    item.catalogSellerId || ''
  ).trim().toUpperCase();

  if (sellerName === 'walmart.com') {
    return true;
  }

  if (sellerDisplayName === 'walmart.com') {
    return true;
  }

  if (sellerId === WALMART_SELLER_ID) {
    return true;
  }

  if (catalogSellerId === WALMART_SELLER_ID) {
    return true;
  }

  return false;
}

// --------------------------------------------------
// POKEMON PRODUCT FILTER
// --------------------------------------------------

function isPokemonProduct(item) {
  const name = String(
    item.name || ''
  ).toLowerCase();

  return (
    name.includes('pokemon') ||
    name.includes('pokémon')
  );
}

// --------------------------------------------------
// STOCK STATUS
// --------------------------------------------------

function getStockStatus(item) {
  if (item.preOrder?.isPreOrder === true) {
    return 'pre_order';
  }

  const availability = String(
    item.availabilityStatusV2?.value || ''
  ).toUpperCase();

  if (
    item.isOutOfStock === true ||
    availability === 'OUT_OF_STOCK'
  ) {
    return 'out_of_stock';
  }

  if (availability === 'IN_STOCK') {
    return 'in_stock';
  }

  if (
    item.canAddToCart === true ||
    item.showAtc === true
  ) {
    return 'in_stock';
  }

  return 'out_of_stock';
}

// --------------------------------------------------
// PRODUCT URL
// --------------------------------------------------

function buildUrl(item) {
  const canonical = String(
    item.canonicalUrl || ''
  ).split('?')[0];

  if (canonical.startsWith('https://www.walmart.com/')) {
    return canonical;
  }

  if (canonical.startsWith('/')) {
    return `${WALMART_BASE}${canonical}`;
  }

  return `${WALMART_BASE}/ip/${item.usItemId}`;
}

// --------------------------------------------------
// PRICE
// --------------------------------------------------

function buildPrice(item) {
  const raw = item.price;

  const formatted =
    item.priceInfo?.linePrice || '';

  let numeric = null;

  if (raw !== null && raw !== undefined) {
    const parsed = Number(raw);

    if (Number.isFinite(parsed)) {
      numeric = parsed;
    }
  }

  if (numeric === null && formatted) {
    const parsed = parseFloat(
      String(formatted).replace(/[^0-9.]/g, '')
    );

    if (Number.isFinite(parsed)) {
      numeric = parsed;
    }
  }

  const wasPrice =
    item.priceInfo?.wasPrice || null;

  return {
    price:
      numeric !== null
        ? `$${numeric.toFixed(2)}`
        : 'N/A',

    priceNumeric: numeric,

    regularPrice:
      wasPrice !== null
        ? String(wasPrice)
        : null,
  };
}

// --------------------------------------------------
// PICKUP STATUS
// --------------------------------------------------

function getPickupStatus(item) {
  const pickup =
    item.pickupAndDeliveryStoreInfo
      ?.pickupStores?.[0]?.available;

  if (pickup === true) {
    return 'in_stock';
  }

  if (pickup === false) {
    return 'out_of_stock';
  }

  const badges = Array.isArray(
    item.fulfillmentBadges
  )
    ? item.fulfillmentBadges
    : [];

  const normalized = badges
    .filter(badge => typeof badge === 'string')
    .map(badge => badge.toLowerCase());

  if (
    normalized.includes('pickup_today') ||
    normalized.includes('free_pickup_today')
  ) {
    return 'in_stock';
  }

  return null;
}

// --------------------------------------------------
// NORMALIZE PRODUCT
// --------------------------------------------------

function normalizeItem(item) {
  const stockStatus = getStockStatus(item);

  const {
    price,
    priceNumeric,
    regularPrice,
  } = buildPrice(item);

  return {
    id: `walmart-${item.usItemId}`,

    retailer: 'walmart',

    usItemId: item.usItemId,

    name: item.name || '',

    brand: item.brand || null,

    price,
    priceNumeric,
    regularPrice,

    url: buildUrl(item),

    inStock: stockStatus === 'in_stock',

    stockStatus,

    pickupStatus: getPickupStatus(item),

    releaseDate:
      item.preOrder?.streetDate ||
      item.preOrder?.releaseDate ||
      null,
  };
}

// --------------------------------------------------
// DEBUG SELLER INFORMATION
// --------------------------------------------------

function debugSellers(items, keyword) {
  console.log(
    `\n[Walmart DEBUG] Seller samples: ${keyword}`
  );

  const samples = items.slice(
    0,
    DEBUG_SAMPLE_LIMIT
  );

  for (const item of samples) {
    console.log(
      '[Walmart DEBUG]',
      JSON.stringify(
        {
          name: item.name,
          usItemId: item.usItemId,

          ...getSellerInfo(item),

          recognizedAsWalmart:
            isSoldByWalmart(item),

          isPokemon:
            isPokemonProduct(item),

          availability:
            item.availabilityStatusV2,

          isOutOfStock:
            item.isOutOfStock,

          canAddToCart:
            item.canAddToCart,
        },
        null,
        2
      )
    );
  }
}

// --------------------------------------------------
// MAIN SCRAPER
// --------------------------------------------------

async function scrapeWalmart() {
  console.log(
    '\n[Walmart] Starting Pokemon TCG monitor'
  );

  let cookies = '';

  try {
    cookies = await initSession();

    console.log(
      '[Walmart] Session initialized'
    );
  } catch (error) {
    console.warn(
      '[Walmart] Session initialization failed:',
      error.message
    );

    throw error;
  }

  await sleep(1000);

  const products = [];
  const acceptedIds = new Set();

  const sellerCounts = new Map();

  let thirdPartyCount = 0;
  let nonPokemonCount = 0;
  let duplicateCount = 0;
  let pagesSucceeded = 0;
  let pagesFailed = 0;

  const maxConfiguredPages = Math.max(
    1,
    Number(config.maxPages) || 3
  );

  for (const keyword of SEARCH_KEYWORDS) {
    console.log(
      `\n[Walmart] Searching: "${keyword}"`
    );

    let page = 1;
    let maxPage = maxConfiguredPages;

    while (page <= maxPage) {
      let html;

      try {
        html = await fetchPage(
          cookies,
          keyword,
          page
        );
      } catch (error) {
        pagesFailed++;

        console.error(
          `[Walmart] Failed "${keyword}" ` +
          `page ${page}: ${error.message}`
        );

        break;
      }

      const nextData = parseNextData(html);

      if (!nextData) {
        pagesFailed++;

        console.warn(
          `[Walmart] No valid __NEXT_DATA__ ` +
          `for "${keyword}" page ${page}`
        );

        break;
      }

      const searchResult =
        nextData?.props?.pageProps
          ?.initialData?.searchResult;

      if (
        !searchResult ||
        !Array.isArray(searchResult.itemStacks)
      ) {
        pagesFailed++;

        console.warn(
          `[Walmart] Missing expected search data ` +
          `for "${keyword}" page ${page}`
        );

        break;
      }

      pagesSucceeded++;

      const items = extractItems(nextData);
      const pagination = extractPagination(nextData);

      if (page === 1) {
        maxPage = Math.min(
          Number(pagination.maxPage) || 1,
          maxConfiguredPages
        );

        console.log(
          `[Walmart] ${pagination.total} results, ` +
          `${pagination.maxPage} pages`
        );

        debugSellers(items, keyword);
      }

      if (items.length === 0) {
        console.log(
          `[Walmart] Empty page ${page}`
        );

        break;
      }

      let added = 0;
      let skipped = 0;

      for (const item of items) {
        const id = String(
          item.usItemId || ''
        );

        if (!id) {
          continue;
        }

        if (acceptedIds.has(id)) {
          duplicateCount++;
          continue;
        }

        const sellerName = String(
          item.sellerName ||
          item.sellerDisplayName ||
          '(missing)'
        );

        sellerCounts.set(
          sellerName,
          (sellerCounts.get(sellerName) || 0) + 1
        );

        if (!isPokemonProduct(item)) {
          nonPokemonCount++;
          skipped++;
          continue;
        }

        if (!isSoldByWalmart(item)) {
          thirdPartyCount++;
          skipped++;
          continue;
        }

        products.push(normalizeItem(item));
        acceptedIds.add(id);
        added++;
      }

      console.log(
        `[Walmart] "${keyword}" ` +
        `page ${page}/${maxPage}: ` +
        `${items.length} items, ` +
        `${added} added, ` +
        `${skipped} filtered`
      );

      page++;

      if (page <= maxPage) {
        await sleep(DELAY_MS);
      }
    }

    await sleep(DELAY_MS * 2);
  }

  if (pagesSucceeded === 0) {
    throw new Error(
      '[Walmart] All search pages failed. ' +
      'No reliable product data obtained.'
    );
  }

  // Avoid treating a partially failed scrape as
  // a complete inventory snapshot.
  if (pagesFailed > 0) {
    throw new Error(
      `[Walmart] Incomplete scrape: ` +
      `${pagesFailed} page(s) failed. ` +
      'Skipping inventory comparison.'
    );
  }

  const inStock = products.filter(
    product => product.stockStatus === 'in_stock'
  ).length;

  const outOfStock = products.filter(
    product => product.stockStatus === 'out_of_stock'
  ).length;

  const preOrder = products.filter(
    product => product.stockStatus === 'pre_order'
  ).length;

  console.log(
    '\n[Walmart] Seller breakdown:'
  );

  const sortedSellers = [
    ...sellerCounts.entries(),
  ].sort((a, b) => b[1] - a[1]);

  for (const [seller, count] of sortedSellers.slice(0, 20)) {
    console.log(
      `[Walmart] ${seller}: ${count}`
    );
  }

  console.log(
    '\n[Walmart] Final summary'
  );

  console.log(
    `[Walmart] Pages succeeded: ${pagesSucceeded}`
  );

  console.log(
    `[Walmart] Products accepted: ${products.length}`
  );

  console.log(
    `[Walmart] In stock: ${inStock}`
  );

  console.log(
    `[Walmart] Out of stock: ${outOfStock}`
  );

  console.log(
    `[Walmart] Preorders: ${preOrder}`
  );

  console.log(
    `[Walmart] Third-party filtered: ${thirdPartyCount}`
  );

  console.log(
    `[Walmart] Non-Pokemon filtered: ${nonPokemonCount}`
  );

  console.log(
    `[Walmart] Duplicate accepted listings: ${duplicateCount}`
  );

  return products;
}

// --------------------------------------------------
// COMMAND LINE
// --------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);

  const showAll = args.includes('--all');
  const asJson = args.includes('--json');

  scrapeWalmart()
    .then(products => {
      if (asJson) {
        console.log(
          JSON.stringify(products, null, 2)
        );
        return;
      }

      const sample = showAll
        ? products
        : products.slice(0, 5);

      console.log(
        `\nWalmart Pokemon TCG: ` +
        `${products.length} products`
      );

      for (const product of sample) {
        console.log(
          `\n${product.name}\n` +
          `Price: ${product.price}\n` +
          `Status: ${product.stockStatus}\n` +
          `URL: ${product.url}`
        );
      }
    })
    .catch(error => {
      console.error(
        '[Walmart] Fatal error:',
        error.message
      );

      process.exitCode = 1;
    });
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  scrapeWalmart,
  parseNextData,
  extractItems,
  extractPagination,
  isSoldByWalmart,
  isPokemonProduct,
  getStockStatus,
  normalizeItem,
};
