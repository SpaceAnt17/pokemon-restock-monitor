
const axios = require('axios');
const fs = require('fs');
const config = require('../config');
const { withRetry, sleep } = require('../utils/retry');

const BASE = 'https://www.walmart.com';
const SEARCH_URL = `${BASE}/search`;

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

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function diagnoseResponse(html, response, keyword) {
  const body = String(html || '');
  const lower = body.toLowerCase();

  const signals = {
    status: response.status,
    finalUrl:
      response.request?.res?.responseUrl || 'unknown',
    contentType:
      response.headers['content-type'] || 'unknown',
    htmlLength: body.length,
    hasNextData: body.includes('__NEXT_DATA__'),
    hasNextFlight: body.includes('self.__next_f.push'),
    hasProductData:
      body.includes('searchResult') ||
      body.includes('itemStacks'),
    hasCaptcha:
      lower.includes('captcha') ||
      lower.includes('robot or human') ||
      lower.includes('verify you are human'),
    hasBlockMessage:
      lower.includes('access denied') ||
      lower.includes('automated access') ||
      lower.includes('unusual traffic'),
  };

  console.log(
    '[Walmart DIAGNOSTIC]',
    JSON.stringify({ keyword, ...signals }, null, 2)
  );

  // Only save a small diagnostic sample.
  // Never upload full session HTML or cookies.
  const sample = body
    .replace(/<script[\s\S]*?<\/script>/gi, '[SCRIPT REMOVED]')
    .replace(/<style[\s\S]*?<\/style>/gi, '[STYLE REMOVED]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  console.log('[Walmart DIAGNOSTIC] Text sample:', sample);

  return signals;
}

async function initSession() {
  const response = await axios.get(BASE + '/', {
    headers: HEADERS,
    timeout: 20000,
    maxRedirects: 5,
  });

  const cookies = (response.headers['set-cookie'] || [])
    .map(c => c.split(';')[0])
    .join('; ');

  if (!cookies) {
    throw new Error('Walmart homepage returned no cookies');
  }

  console.log('[Walmart] Session initialized');
  return cookies;
}

async function fetchPage(cookies, keyword, page) {
  return withRetry(
    async () => {
      const response = await axios.get(SEARCH_URL, {
        params: { q: keyword, page },
        headers: {
          ...HEADERS,
          Referer: BASE + '/',
          Cookie: cookies,
        },
        timeout: 30000,
        maxRedirects: 5,
      });

      return response;
    },
    {
      maxAttempts: 3,
      baseDelayMs: 2000,
      isRetryable(error) {
        const status = error.response?.status;
        return (
          !status ||
          status === 429 ||
          status >= 500
        );
      },
      onRetry(error, attempt, delay) {
        console.warn(
          `[Walmart] Retry ${attempt}: ${error.message}. ` +
          `Waiting ${delay}ms`
        );
      },
    }
  );
}

function parseNextData(html) {
  const match = String(html).match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    console.warn(
      '[Walmart] __NEXT_DATA__ JSON parse failed:',
      error.message
    );
    return null;
  }
}

function extractItems(data) {
  const result =
    data?.props?.pageProps?.initialData?.searchResult;

  return (result?.itemStacks || [])
    .flatMap(stack => stack.items || [])
    .filter(item => item?.usItemId);
}

function extractPagination(data) {
  const result =
    data?.props?.pageProps?.initialData?.searchResult || {};

  return {
    maxPage: result.paginationV2?.maxPage || 1,
    total: result.aggregatedCount || result.count || 0,
  };
}

function isSoldByWalmart(item) {
  return (
    item.sellerName === 'Walmart.com' ||
    item.sellerId === WALMART_SELLER_ID
  );
}

function isPokemonProduct(item) {
  return /pok[eé]mon/i.test(item.name || '');
}

function getStockStatus(item) {
  if (item.preOrder?.isPreOrder === true) {
    return 'pre_order';
  }

  const availability =
    item.availabilityStatusV2?.value;

  if (
    item.isOutOfStock === true ||
    availability === 'OUT_OF_STOCK'
  ) {
    return 'out_of_stock';
  }

  if (
    availability === 'IN_STOCK' ||
    item.canAddToCart === true ||
    item.showAtc === true
  ) {
    return 'in_stock';
  }

  return 'out_of_stock';
}

function normalizeItem(item) {
  const stockStatus = getStockStatus(item);

  const rawPrice = Number(item.price);
  const priceNumeric =
    Number.isFinite(rawPrice) && item.price != null
      ? rawPrice
      : null;

  const path = item.canonicalUrl || '';
  const url = path.startsWith('http')
    ? path
    : path.startsWith('/')
      ? BASE + path
      : `${BASE}/ip/${item.usItemId}`;

  return {
    id: `walmart-${item.usItemId}`,
    retailer: 'walmart',
    usItemId: item.usItemId,
    name: item.name || '',
    brand: item.brand || null,
    price:
      priceNumeric === null
        ? 'N/A'
        : `$${priceNumeric.toFixed(2)}`,
    priceNumeric,
    regularPrice: item.priceInfo?.wasPrice || null,
    url: url.split('?')[0],
    inStock: stockStatus === 'in_stock',
    stockStatus,
    releaseDate:
      item.preOrder?.streetDate ||
      item.preOrder?.releaseDate ||
      null,
  };
}

async function scrapeWalmart() {
  console.log('[Walmart] Starting Pokemon TCG monitor');

  const cookies = await initSession();
  await sleep(1000);

  const products = [];
  const seen = new Set();

  let successfulPages = 0;
  let failedPages = 0;
  let marketplaceSkipped = 0;

  for (const keyword of SEARCH_KEYWORDS) {
    console.log(`[Walmart] Searching: "${keyword}"`);

    let maxPage = 1;

    for (
      let page = 1;
      page <= Math.min(maxPage, config.maxPages || 3);
      page++
    ) {
      let response;

      try {
        response = await fetchPage(cookies, keyword, page);
      } catch (error) {
        failedPages++;
        console.error(
          `[Walmart] Request failed: ${error.message}`
        );
        break;
      }

      const html = response.data;
      const diagnostic = diagnoseResponse(
        html,
        response,
        keyword
      );

      if (
        diagnostic.hasCaptcha ||
        diagnostic.hasBlockMessage
      ) {
        throw new Error(
          '[Walmart] Bot challenge detected. ' +
          'Product data cannot be trusted.'
        );
      }

      const nextData = parseNextData(html);

      if (!nextData) {
        failedPages++;
        console.warn(
          '[Walmart] No valid __NEXT_DATA__. ' +
          'Page structure may have changed.'
        );
        break;
      }

      const items = extractItems(nextData);
      const pagination = extractPagination(nextData);

      if (page === 1) {
        maxPage = Math.max(1, pagination.maxPage);

        console.log(
          `[Walmart] ${pagination.total} results, ` +
          `${maxPage} pages`
        );
      }

      if (!items.length) {
        failedPages++;
        console.warn(
          '[Walmart] No items extracted from search data.'
        );
        break;
      }

      successfulPages++;

      let added = 0;

      for (const item of items) {
        if (!item.usItemId || seen.has(item.usItemId)) {
          continue;
        }

        seen.add(item.usItemId);

        if (!isSoldByWalmart(item)) {
          marketplaceSkipped++;
          continue;
        }

        if (!isPokemonProduct(item)) continue;

        products.push(normalizeItem(item));
        added++;
      }

      console.log(
        `[Walmart] Page ${page}: ${items.length} items, ` +
        `${added} Walmart-sold Pokemon products`
      );

      if (page < maxPage) await sleep(DELAY_MS);
    }

    await sleep(DELAY_MS);
  }

  console.log('[Walmart] Final diagnostic summary:');
  console.log({
    successfulPages,
    failedPages,
    productsFound: products.length,
    marketplaceSkipped,
  });

  // Crucial: do not return [] on a complete scraper failure.
  // monitor.js will skip comparison and preserve existing state.
  if (successfulPages === 0) {
    throw new Error(
      '[Walmart] All search pages failed. ' +
      'No reliable product data obtained.'
    );
  }

  if (failedPages > 0) {
    throw new Error(
      `[Walmart] Partial scrape: ${failedPages} pages failed. ` +
      'Preserving existing inventory state.'
    );
  }

  console.log(
    `[Walmart] Done: ${products.length} products`
  );

  return products;
}

if (require.main === module) {
  scrapeWalmart()
    .then(products => {
      console.log(
        JSON.stringify(products.slice(0, 5), null, 2)
      );
    })
    .catch(error => {
      console.error('[Walmart] Fatal:', error.message);
      process.exitCode = 1;
    });
}

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
