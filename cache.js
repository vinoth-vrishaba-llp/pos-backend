let cache = {
  categories: null,
  timestamp: 0,
};

export function getCachedCategories() {
  if (Date.now() - cache.timestamp < 6 * 60 * 60 * 1000) {
    return cache.categories;
  }
  return null;
}

export function setCachedCategories(data) {
  cache = { categories: data, timestamp: Date.now() };
}
