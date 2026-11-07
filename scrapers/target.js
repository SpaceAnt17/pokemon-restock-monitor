
const axios = require('axios');
const config = require('../config');
const { withRetry, sleep } = require('../utils/retry');

// Target Redsky API configuration
const REDSKY_BASE =
  'https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2';

const REDSKY_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
const VISITOR_ID = '018c8d4b-a1b7-7e65-8e16-e60f2a64b4a6';
const STORE_ID = '1375';

const COUNT = 24;
const DELAY_MS = 1500;
const MAX_RETRIES = 3;

const SEARCH_KEYWORD = 'pokemon cards';

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':
    `https://www.target.com/s?searchTerm=${encodeURIComponent(SEARCH_KEYWORD)}`,
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

// Diagnostic logging
function logHttpError(err) {
  const response = err.response;

  console.error('\n[Target DEBUG] Request failed');

  console.error({
    status: response?.status ?? null,
    statusText: response?.statusText ?? null,
    contentType: response?.headers?.['content-type'] ?? null,
    retryAfter: response?.headers?.['retry-after'] ?? null,
    server: response?.headers?.server ?? null,
    errorCode: err.code ?? null,
    message: err.message,
  });

  const body = response?.data;

  if (body != null) {
    const output = typeof body === 'string'
      ? body
      : JSON.stringify(body);

    console.error(
      '[Target DEBUG] Response body:',
      output.slice(0, 1000)
    );
  }

  console.error('[Target DEBUG] End\n');
}

// Fetch Redsky data
async function fetchRedsky(params) {
  return withRetry(
    async () => {
      try {
        const res = await axios.get(REDSKY_BASE, {
          params: {
            ...BASE_PARAMS,
            ...params,
          },
          headers: REQUEST_HEADERS,
          timeout: 22000,
          decompress: true,
        });

        return res.data;
      } catch (err) {
        logHttpError(err);

        const status = err.response?.status;

        if (status === 400) {
          const message =
            err.response?.data?.errors?.[0]?.message ??
            'Bad Request';

          const error = new Error(
            `[Target] Redsky 400: ${message}`
          );

          error.permanent = true;
          throw error;
        }

        if (status === 403 || status === 435) {
          const error = new Error(
            `[Target] API returned HTTP ${status}. ` +
            'Request rejected by server.'
          );

          error.permanent = true;
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

        const status = err.response?.status;

        if (status === 429) return false;

        return (
          !status ||
          status >= 500 ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT'
        );
      },

      onRetry(err, attempt, delayMs) {
        console.warn(
          `[Target] Attempt ${attempt} failed: ` +
          `${err.message}. Retrying in ${delayMs / 1000}s`
        );
      },
    }
  );
}

// Fetch paginated products
async function fetchAllTcins(purchasabilityFilter) {
  const label = purchasabilityFilter
    ? 'in-stock'
    : 'all-products';

  const tcins = new Map();

  let offset = 0;
  let total = Infinity;
  let page = 0;

  while (
    offset < total &&
    page < config.maxPages
  ) {
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
        `[Target] ${label} page ${page + 1} failed: ${err.message}`
      );

      // Do not mistake a blocked request for
      // an empty inventory.
      throw err;
    }

    const search = data?.data?.search ?? {};
    const items = search.products ?? [];
    const meta =
      search.search_response?.metadata ?? {};

    if (page === 0) {
      total = meta.total_results ?? items.length;

      console.log(
        `[Target] ${label}: ${total} results`
      );
    }

    if (items.length === 0) break;

    for (const raw of items) {
      const tcin =
        raw?.tcin ?? raw?.item?.tcin;

      if (tcin) {
        tcins.set(String(tcin), raw);
      }
    }

    offset += COUNT;
    page++;

    if (
      offset < total &&
      page < config.maxPages
    ) {
      await sleep(DELAY_MS);
    }
  }

  return tcins;
}

// Exclude Target Plus third-party sellers
function isSoldByTarget(raw) {
  if (
    raw?.item?.fulfillment?.is_marketplace === true
  ) {
    return false;
  }

  const relationship =
    raw?.item?.relationship_type ?? '';

  return (
    relationship !== 'TargetPlus' &&
    relationship !== 'TargetPlus_CollectionItem'
  );
}

// Detect preorders
function isPreOrder(raw) {
  const priceType =
    raw?.price?.formatted_current_price_type ?? '';

  return (
    priceType === 'pre_order' ||
    priceType === 'preorder'
  );
}

// Build product URL
function buildUrl(raw) {
  const buyUrl =
    raw?.item?.enrichment?.buy_url ?? '';

  if (buyUrl.startsWith('http')) {
    return buyUrl;
  }

  if (buyUrl.startsWith('/')) {
    return `https://www.target.com${buyUrl}`;
  }

  const tcin =
    raw?.tcin ?? raw?.item?.tcin;

  return `https://www.target.com/p/-/A-${tcin}`;
}

// Detect in-store availability
function getInStoreStatus(raw) {
  const options =
    raw?.item?.fulfillment?.store_options ?? [];

  const store =
    options.find(
      option =>
        String(option.location_id) === STORE_ID
    ) ?? options[0];

  if (!store) return null;

  const status =
    store?.availability?.availability_status ??
    store?.order_pickup?.availability?.availability_status ??
    '';

  if (!status) return null;

  if (status === 'IN_STOCK') {
    return 'in_stock';
  }

  if (status === 'OUT_OF_STOCK') {
    return 'out_of_stock';
  }

  return status.toLowerCase();
}

// Normalize product data
function normalizeProduct(raw, stockStatus) {
  const tcin =
    raw?.tcin ?? raw?.item?.tcin;

  const name =
    raw?.item?.product_description?.title ?? '';

  const price =
    raw?.price?.current_retail;

  const regularPrice =
    raw?.price?.reg_retail;

  return {
    id: `target-${tcin}`,
    retailer: 'target',
    tcin,

    name: name.replace(
      /&#(\d+);/g,
      (_, n) => String.fromCharCode(n)
    ),

    brand:
      raw?.item?.primary_brand?.name ?? null,

    price:
      price != null
        ? `$${Number(price).toFixed(2)}`
        : 'N/A',

    priceNumeric: price ?? null,

    regularPrice:
      regularPrice != null &&
      regularPrice !== price
        ? `$${Number(regularPrice).toFixed(2)}`
        : null,

    url: buildUrl(raw),

    inStock:
      stockStatus === 'in_stock',

    stockStatus,

    inStoreStatus:
      getInStoreStatus(raw),

    releaseDate: null,
  };
}

// Main scraper
async function scrapeTarget() {
  console.log(
    `[Target] Starting Pokemon scan: ${SEARCH_KEYWORD}`
  );

  // Pass 1: discover products
  const allPass = await fetchAllTcins(false);

  if (allPass.size === 0) {
    console.warn(
      '[Target] No products returned. ' +
      'Check API response and search parameters.'
    );

    return [];
  }

  await sleep(DELAY_MS * 2);

  // Pass 2: identify purchasable products
  const inStockPass = await fetchAllTcins(true);

  const products = [];
  let thirdPartyCount = 0;

  for (const [tcin, raw] of allPass) {
    if (!isSoldByTarget(raw)) {
      thirdPartyCount++;
      continue;
    }

    let stockStatus;

    if (isPreOrder(raw)) {
      stockStatus = 'pre_order';
    } else if (inStockPass.has(tcin)) {
      stockStatus = 'in_stock';
    } else {
      stockStatus = 'out_of_stock';
    }

    products.push(
      normalizeProduct(raw, stockStatus)
    );
  }

  const inStock = products.filter(
    p => p.stockStatus === 'in_stock'
  ).length;

  const outOfStock = products.filter(
    p => p.stockStatus === 'out_of_stock'
  ).length;

  const preOrder = products.filter(
    p => p.stockStatus === 'pre_order'
  ).length;

  const inStore = products.filter(
    p => p.inStoreStatus === 'in_stock'
  ).length;

  console.log(
    `[Target] Done: ${products.length} products ` +
    `(${inStock} online in-stock, ` +
    `${inStore} in-store, ` +
    `${outOfStock} out-of-stock, ` +
    `${preOrder} preorder, ` +
    `${thirdPartyCount} third-party skipped)`
  );

  return products;
}

// Standalone test
if (require.main === module) {
  const args = process.argv.slice(2);

  scrapeTarget()
    .then(products => {
      console.log(
        `[Target] Scan completed: ${products.length} products`
      );

      if (args.includes('--json')) {
        console.log(
          JSON.stringify(products, null, 2)
        );
      } else {
        console.log(
          JSON.stringify(products.slice(0, 5), null, 2)
        );
      }
    })
    .catch(err => {
      console.error(
        '[Target] Fatal:',
        err.message
      );

      process.exitCode = 1;
    });
}

module.exports = {
  scrapeTarget,
  normalizeProduct,
  isSoldByTarget,
  isPreOrder,
};
