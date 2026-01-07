//backend/woo.service.js
import axios from "axios";
import axiosRetry from "axios-retry";

const woo = axios.create({
  baseURL: `${process.env.WOO_BASE_URL}/wp-json/wc/v3`,
  auth: {
    username: process.env.WOO_CONSUMER_KEY,
    password: process.env.WOO_CONSUMER_SECRET
  }
});

axiosRetry(woo, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    error.response?.status >= 500 ||
    error.code === "ECONNABORTED"
});

export async function fetchProducts({ page = 1, limit = 20, category, search }) {
  const params = {
    per_page: limit,
    page,
    status: 'publish', // Only fetch published products
  };

  // Add category filter if provided
  if (category) {
    params.category = category;
  }

  // Add search query if provided
  if (search) {
    params.search = search;
  }

  const { data } = await woo.get("/products", { params });
  return data;
}

export async function fetchProductById(id) {
  const { data } = await woo.get(`/products/${id}`);
  return data;
}

export async function fetchVariations(productId) {
  const { data } = await woo.get(
    `/products/${productId}/variations`,
    { params: { per_page: 100 } }
  );
  return data;
}

export async function fetchProductsBySku(sku) {
  const { data } = await woo.get("/products", {
    params: {
      sku,
      per_page: 5,
    },
  });
  return data;
}

export async function fetchCategories() {
  const { data } = await woo.get("/products/categories", {
    params: { per_page: 100, hide_empty: true },
  });
  return data;
}

export async function createOrder(payload) {
  const { data } = await woo.post("/orders", payload);
  return data;
}

export async function addOrderNote(orderId, note) {
  await woo.post(`/orders/${orderId}/notes`, { note });
}

export async function fetchOrder(id) {
  const { data } = await woo.get(`/orders/${id}`);
  return data;
}

export async function updateOrderStatus(id, payload) {
  const { data } = await woo.put(`/orders/${id}`, payload);
  return data;
}

export async function fetchRecentOrders() {
  const { data } = await woo.get("/orders", {
    params: { per_page: 50, orderby: "date", order: "desc" }
  });
  return data;
}

/* ==========================================
   CUSTOMER FUNCTIONS
========================================== */

/**
 * Fetch customers from WooCommerce with pagination
 * @param {Object} options - Query options
 * @param {number} options.page - Page number (default: 1)
 * @param {number} options.per_page - Items per page (default: 20)
 * @param {string} options.orderby - Order by field (default: "registered_date")
 * @param {string} options.order - Order direction (default: "desc")
 * @param {string} options.search - Search query
 */
export async function fetchCustomers({ 
  page = 1, 
  per_page = 20, 
  orderby = "registered_date", 
  order = "desc",
  search 
} = {}) {
  const params = {
    per_page,
    page,
    orderby,
    order,
  };

  if (search) {
    params.search = search;
  }

  const { data } = await woo.get("/customers", { params });
  return data;
}

/**
 * Fetch a single customer by ID
 */
export async function fetchCustomer(id) {
  const { data } = await woo.get(`/customers/${id}`);
  return data;
}

/**
 * Create a new customer in WooCommerce
 */
export async function createCustomer(payload) {
  const { data } = await woo.post("/customers", payload);
  return data;
}

/**
 * Update an existing customer in WooCommerce
 */
export async function updateCustomer(id, payload) {
  console.log(`📤 Updating WooCommerce customer ${id}...`);
  try {
    const { data } = await woo.put(`/customers/${id}`, payload);
    console.log(`✅ WooCommerce customer ${id} updated successfully`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to update WooCommerce customer ${id}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Delete a customer from WooCommerce (permanently)
 * @param {number} id - WooCommerce customer ID
 * @param {boolean} force - Force delete (default: true for permanent deletion)
 */
export async function deleteCustomer(id, force = true) {
  console.log(`🗑️ Deleting WooCommerce customer ${id}...`);
  try {
    const { data } = await woo.delete(`/customers/${id}`, {
      params: {
        force, // force=true for permanent deletion, force=false for trash
      },
    });
    console.log(`✅ WooCommerce customer ${id} deleted successfully`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to delete WooCommerce customer ${id}:`, error.response?.data || error.message);
    throw error;
  }
}

// Add these functions to your existing woo.service.js

/* ==========================================
   REPORTS FUNCTIONS
========================================== */

/**
 * Fetch top sellers report
 * @param {Object} params - Query parameters
 * @param {string} params.period - Period (week, month, last_month, year)
 * @param {string} params.date_min - Start date (YYYY-MM-DD)
 * @param {string} params.date_max - End date (YYYY-MM-DD)
 */
export async function fetchTopSellersReport({ period, date_min, date_max } = {}) {
  const params = {};
  
  if (period) params.period = period;
  if (date_min) params.date_min = date_min;
  if (date_max) params.date_max = date_max;
  
  const { data } = await woo.get("/reports/top_sellers", { params });
  return data;
}

/**
 * Fetch sales report
 */
export async function fetchSalesReport({ period, date_min, date_max } = {}) {
  const params = {};
  
  if (period) params.period = period;
  if (date_min) params.date_min = date_min;
  if (date_max) params.date_max = date_max;
  
  const { data } = await woo.get("/reports/sales", { params });
  return data;
}

/**
 * Fetch coupons totals
 */
export async function fetchCouponsTotals() {
  const { data } = await woo.get("/reports/coupons/totals");
  return data;
}

/**
 * Fetch customers totals
 */
export async function fetchCustomersTotals() {
  const { data } = await woo.get("/reports/customers/totals");
  return data;
}

/**
 * Fetch orders totals
 */
export async function fetchOrdersTotals() {
  const { data } = await woo.get("/reports/orders/totals");
  return data;
}

/**
 * Fetch products totals
 */
export async function fetchProductsTotals() {
  const { data } = await woo.get("/reports/products/totals");
  return data;
}

/**
 * Fetch reviews totals
 */
export async function fetchReviewsTotals() {
  const { data } = await woo.get("/reports/reviews/totals");
  return data;
}

/* ==========================================
   COUPON FUNCTIONS
   Add this section BEFORE "REPORTS FUNCTIONS" section in woo.service.js
========================================== */

/**
 * Fetch all coupons from WooCommerce
 * @param {Object} params - Query parameters
 * @param {number} params.page - Page number
 * @param {number} params.per_page - Items per page
 * @param {string} params.search - Search query
 * @param {string} params.code - Filter by coupon code
 */
export async function fetchCoupons({ 
  page = 1, 
  per_page = 100,
  search,
  code
} = {}) {
  const params = {
    per_page,
    page,
    orderby: "date",
    order: "desc"
  };

  if (search) {
    params.search = search;
  }

  if (code) {
    params.code = code;
  }

  console.log(`📥 Fetching coupons from WooCommerce...`);
  try {
    const { data } = await woo.get("/coupons", { params });
    console.log(`✅ Fetched ${data.length} coupons`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to fetch coupons:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Fetch a single coupon by ID
 */
export async function fetchCoupon(id) {
  console.log(`📥 Fetching coupon ${id}...`);
  try {
    const { data } = await woo.get(`/coupons/${id}`);
    console.log(`✅ Fetched coupon: ${data.code}`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to fetch coupon ${id}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Create a new coupon in WooCommerce
 * @param {Object} payload - Coupon data
 * @param {string} payload.code - Coupon code (required, must be unique)
 * @param {string} payload.discount_type - Type: 'percent', 'fixed_cart', 'fixed_product'
 * @param {string} payload.amount - Discount amount
 * @param {boolean} payload.individual_use - Allow only individual use
 * @param {boolean} payload.exclude_sale_items - Exclude sale items
 * @param {string} payload.minimum_amount - Minimum order amount
 */
export async function createCoupon(payload) {
  console.log(`📤 Creating coupon: ${payload.code}...`);
  try {
    const { data } = await woo.post("/coupons", payload);
    console.log(`✅ Coupon created successfully: ${data.code} (ID: ${data.id})`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to create coupon:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Update an existing coupon
 */
export async function updateCoupon(id, payload) {
  console.log(`📤 Updating coupon ${id}...`);
  try {
    const { data } = await woo.put(`/coupons/${id}`, payload);
    console.log(`✅ Coupon ${id} updated successfully`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to update coupon ${id}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Delete a coupon (permanently)
 */
export async function deleteCoupon(id, force = true) {
  console.log(`🗑️ Deleting coupon ${id}...`);
  try {
    const { data } = await woo.delete(`/coupons/${id}`, {
      params: { force }
    });
    console.log(`✅ Coupon ${id} deleted successfully`);
    return data;
  } catch (error) {
    console.error(`❌ Failed to delete coupon ${id}:`, error.response?.data || error.message);
    throw error;
  }
}