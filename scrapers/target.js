
/**
 * Target Pokémon TCG Restock Monitor
 *
 * Uses Target's Redsky search endpoint.
 *
 * Improvements:
 * - Failed requests stop the scan
 * - Incomplete inventory scans are rejected
 * - HTTP errors are reported clearly
 * - Failed stock checks cannot mark everything OOS
 * - Existing monitor.js compatibility preserved
 */

const axios = require('axios');
const config = require('../config');
const { withRetry, sleep } = require('../utils/retry');

// API configuration
const REDSKY_BASE =
  'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2';

const REDSKY_KEY =
  '9f36aeafbe60771e321a7cc95a78140772ab3e96';

const VISITOR_ID =
  '018c8d4b-a1b7-7e65-8e16-e60f2a64b4a6';

const STORE_ID = '1375';

const COUNT = 24;
const DELAY_MS = 1500;
const MAX_RETRIES = 3;

const SEARCH_KEYWORD = 'pokemon cards';

const REQUEST_HEADERS = {
  'User-Agent': config.requestHeaders['User-Agent'],
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':
    'https://www.target.com/s?searchTerm=pokemon%20cards',
  'Origin': 'https://www.target.com',
};

const BASE_PARAMS = {
  keyword: SEARCH_KEYWORD,
  channel: 'WEB',
  platform: 'desktop',
  page: '/search',
  visitor_id: VISITOR_ID,
  key: REDSKY_KEY,
  pricing_store_id: STORE_ID,
  scheduled_delivery_store_id: STORE_ID,
  store_id: STORE_ID,
  fulfillment_test_mode: 'grocery',
  zip: '60601',
  state: 'IL',
  latitude: '41.882',
  longitude: '-87.628',
  include_sponsored: true,
};

// Fetch Target product data
async function fetchRedsky(params) {
  return withRetry(
    async () => {
      try {
        const response = await axios.get(REDSKY_BASE, {
          params: { ...BASE_PARAMS, ...params },
          headers: REQUEST_HEADERS,
          timeout: 22000,
        });

        if (!response.data?.data?.search) {
          throw new Error(
            'Target returned an unexpected response format'
          );
        }

        return response.data;
      } catch (err) {
        const status = err.response?.status;

        if (status) {
          const error = new Error(
            `Target API returned HTTP ${status}`
          );

          error.status = status;
          error.permanent =
            status >= 400 && status < 500 && status !== 429;

          throw error;
        }

        throw err;
      }
    },
    {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: 2000,

      isRetryable(err) {
        if (err.permanent) return false;

        if (err.status === 429) return false;

        if (err.status) {
          return err.status >= 500;
        }

        return [
          'ECONNRESET',
          'ETIMEDOUT',
          'ECONNABORTED',
        ].includes(err.code);
      },

      onRetry(err, attempt, delayMs) {
        console.warn(
          `[Target] Attempt ${attempt} failed: ${err.message}. ` +
          `Retrying in ${delayMs / 1000}s`
        );
      },
    }
  );
}

// Retrieve product pages
async function fetchAllTcins(purchasabilityFilter) {
  const label = purchasabilityFilter
    ? 'in-stock'
    : 'all-products';

  const tcins = new Map();

  let offset = 0;
  let total = null;
  let page = 0;

  const maxPages = Math.max(1, config.maxPages || 3);

  while (page < maxPages) {
    let data;

    try {
      data = await fetchRedsky({
        count: COUNT,
        offset,
        default_purchasability_filter:
          purchasabilityFilter,
      });
    } catch (err) {
      console.error(
        `[Target] ${label} page ${page + 1} failed: ` +
        err.message
      );

      // Never interpret failed requests as empty stock.
      throw err;
    }

    const search = data.data.search;
    const items = search.products;

    if (!Array.isArray(items)) {
      throw new Error(
        `[Target] Invalid product list in ${label} scan`
      );
    }

    const metadata =
      search.search_response?.metadata || {};

    if (page === 0) {
      total = metadata.total_results;

      console.log(
        `[Target] ${label}: ` +
        `${total ?? 'unknown'} total results`
      );
    }

    for (const raw of items) {
      const tcin = raw?.tcin || raw?.item?.tcin;

      if (tcin) {
        tcins.set(String(tcin), raw);
      }
    }

    page++;
    offset += COUNT;

    if (items.length === 0) break;

    if (total != null && offset >= total) break;

    if (page < maxPages) {
      await sleep(DELAY_MS);
    }
  }

  return {
    products: tcins,
    total,
    complete:
      total != null && offset >= total,
  };
}

// Exclude third-party sellers
function isSoldByTarget(raw) {
  if (
    raw?.item?.fulfillment?.is_marketplace === true
  ) {
    return false;
  }

  const relationship =
    raw?.item?.relationship_type || '';

  return ![
    'TargetPlus',
    'TargetPlus_CollectionItem',
  ].includes(relationship);
}

// Detect preorders
function isPreOrder(raw) {
  const type =
    raw?.price?.formatted_current_price_type || '';

  return ['pre_order', 'preorder'].includes(type);
}

// Build product URL
function buildUrl(raw) {
  const buyUrl =
    raw?.item?.enrichment?.buy_url || '';

  if (buyUrl.startsWith('https://')) {
    return buyUrl;
  }

  if (buyUrl.startsWith('/')) {
    return `https://www.target.com${buyUrl}`;
  }

  const tcin = raw?.tcin || raw?.item?.tcin;

  return `https://www.target.com/p/-/A-${tcin}`;
}

// Local store inventory
function getInStoreStatus(raw) {
  const options =
    raw?.item?.fulfillment?.store_options || [];

  const store = options.find(
    item => String(item.location_id) === STORE_ID
  );

  if (!store) return null;

  const status =
    store?.availability?.availability_status ||
    store?.order_pickup?.availability
      ?.availability_status ||
    '';

  if (status === 'IN_STOCK') return 'in_stock';
  if (status === 'OUT_OF_STOCK') return 'out_of_stock';

  return status ? status.toLowerCase() : null;
}

// Convert Target product data into monitor format
function normalizeProduct(raw, stockStatus) {
  const tcin = raw?.tcin || raw?.item?.tcin;

  const name =
    raw?.item?.product_description?.title ||
    'Pokémon Product';

  const price = raw?.price?.current_retail;
  const regular = raw?.price?.reg_retail;

  return {
    id: `target-${tcin}`,
    retailer: 'target',
    tcin,

    name: name.replace(
      /&#(\d+);/g,
      (_, number) => String.fromCharCode(number)
    ),

    brand:
      raw?.item?.primary_brand?.name || null,

    price:
      price != null
        ? `$${Number(price).toFixed(2)}`
        : 'N/A',

    priceNumeric: price ?? null,

    regularPrice:
      regular != null && regular !== price
        ? `$${Number(regular).toFixed(2)}`
        : null,

    url: buildUrl(raw),

    inStock: stockStatus === 'in_stock',
    stockStatus,

    inStoreStatus: getInStoreStatus(raw),

    releaseDate: null,
  };
}

// Main Target scraper
async function scrapeTarget() {
  console.log(
    `[Target] Starting Pokémon scan: ${SEARCH_KEYWORD}`
  );

  const allResult = await fetchAllTcins(false);

  if (allResult.products.size === 0) {
    throw new Error(
      'Target returned no products. Scan rejected.'
    );
  }

  await sleep(DELAY_MS * 2);

  const stockResult = await fetchAllTcins(true);

  // Search results are capped at maxPages.
  // Missing products cannot safely be marked OOS
  // unless both searches were complete.
  const canConfirmMissing =
    allResult.complete && stockResult.complete;

  if (!canConfirmMissing) {
    console.warn(
      '[Target] Partial search results: ' +
      'missing products will not be marked OOS.'
    );
  }

  const products = [];

  for (const [tcin, raw] of allResult.products) {
    if (!isSoldByTarget(raw)) continue;

    let stockStatus;

    if (isPreOrder(raw)) {
      stockStatus = 'pre_order';
    } else if (stockResult.products.has(tcin)) {
      stockStatus = 'in_stock';
    } else if (canConfirmMissing) {
      stockStatus = 'out_of_stock';
    } else {
      // Avoid false stock-status changes.
      // Do not feed unknown stock into state comparison.
      throw new Error(
        'Target stock results incomplete; ' +
        'scan rejected to protect inventory state.'
      );
    }

    products.push(
      normalizeProduct(raw, stockStatus)
    );
  }

  console.log(
    `[Target] Scan complete: ${products.length} products`
  );

  console.log(
    `[Target] In stock: ${
      products.filter(p => p.inStock).length
    }`
  );

  return products;
}

// Standalone test
if (require.main === module) {
  scrapeTarget()
    .then(products => {
      console.log(
        JSON.stringify(products.slice(0, 5), null, 2)
      );
    })
    .catch(err => {
      console.error(
        '[Target] Scan failed:',
        err.message
      );

      process.exit(1);
    });
}

module.exports = {
  scrapeTarget,
  normalizeProduct,
  isSoldByTarget,
  isPreOrder,
};
