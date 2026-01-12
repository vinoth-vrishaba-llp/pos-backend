// backend/cache.js

/* ==========================================
   CATEGORIES CACHE (EXISTING)
========================================== */
let categoriesCache = {
  categories: null,
  timestamp: 0,
};

export function getCachedCategories() {
  const TTL = 6 * 60 * 60 * 1000; // 6 hours
  if (Date.now() - categoriesCache.timestamp < TTL) {
    return categoriesCache.categories;
  }
  return null;
}

export function setCachedCategories(data) {
  categoriesCache = { categories: data, timestamp: Date.now() };
}

/* ==========================================
   VARIATIONS CACHE (NEW)
   ✅ Caches product variations to reduce WooCommerce API calls
========================================== */

// Structure: Map<productId, { variations: [...], timestamp: number }>
const variationsCache = new Map();

// Cache TTL: 5 minutes (300000ms)
const VARIATIONS_TTL = 5 * 60 * 1000;

/**
 * Get cached variations for a product
 * @param {number|string} productId - Product ID
 * @returns {Array|null} - Cached variations or null if expired/missing
 */
export function getCachedVariations(productId) {
  const cached = variationsCache.get(String(productId));
  
  if (!cached) {
    return null;
  }

  // Check if expired
  const now = Date.now();
  if (now - cached.timestamp > VARIATIONS_TTL) {
    // Expired - delete and return null
    variationsCache.delete(String(productId));
    //console.log(`🗑️ Cache expired for product ${productId}`);
    return null;
  }

  //console.log(`✅ Cache HIT for product ${productId} (${cached.variations.length} variations)`);
  return cached.variations;
}

/**
 * Set cached variations for a product
 * @param {number|string} productId - Product ID
 * @param {Array} variations - Variations data
 */
export function setCachedVariations(productId, variations) {
  variationsCache.set(String(productId), {
    variations,
    timestamp: Date.now(),
  });
  
  //console.log(`💾 Cached ${variations.length} variations for product ${productId}`);
}

/**
 * Clear variations cache for a specific product
 * @param {number|string} productId - Product ID
 */
export function clearCachedVariations(productId) {
  const deleted = variationsCache.delete(String(productId));
  if (deleted) {
    //console.log(`🗑️ Cleared cache for product ${productId}`);
  }
  return deleted;
}

/**
 * Clear all variations cache
 * Useful for manual cache refresh or debugging
 */
export function clearAllVariationsCache() {
  const size = variationsCache.size;
  variationsCache.clear();
  //console.log(`🗑️ Cleared all variations cache (${size} products)`);
  return size;
}

/**
 * Get cache statistics
 * Useful for monitoring and debugging
 */
export function getCacheStats() {
  const stats = {
    variations: {
      size: variationsCache.size,
      products: Array.from(variationsCache.keys()),
      ttl: VARIATIONS_TTL,
    },
    categories: {
      cached: categoriesCache.categories !== null,
      timestamp: categoriesCache.timestamp,
    },
  };
  
  return stats;
}

/* ==========================================
   AUTOMATIC CACHE CLEANUP
   Clean up expired entries every 10 minutes
========================================== */
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [productId, cache] of variationsCache.entries()) {
    if (now - cache.timestamp > VARIATIONS_TTL) {
      variationsCache.delete(productId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    ////console.log(`🧹 Cleaned ${cleaned} expired cache entries`);
  }
}, 10 * 60 * 1000); // Run every 10 minutes