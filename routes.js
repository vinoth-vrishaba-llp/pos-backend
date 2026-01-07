import express from "express";
import { auth } from "./middleware.js";
import * as woo from "./woo.service.js";
import * as base from "./baserow.service.js";
import { normalizeProduct} from "./utils.js";
import { buildWooOrderPayload, normalizeOrderForBaserow } from "./orderUtils.js";
import { getCachedCategories, setCachedCategories } from "./cache.js";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from "./auth.service.js";


const router = express.Router();

/**
 * ✅ PRODUCTION-READY LOGIN
 * POST /auth/login
 */
router.post("/auth/login", (req, res) => {
  const { username, password } = req.body;

  // Validate credentials
  if (
    username !== process.env.POS_ADMIN_USERNAME ||
    password !== process.env.POS_ADMIN_PASSWORD
  ) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const payload = { role: "admin" };

  // Generate tokens
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  console.log(`✅ Login successful at ${new Date().toISOString()}`);

  // ✅ PRODUCTION-READY: Secure HTTP-only cookie
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,           // 🔐 JavaScript cannot access
    sameSite: "strict",       // 🔐 CSRF protection (stricter than lax)
    secure: process.env.NODE_ENV === "production", // 🔐 HTTPS only in production
    maxAge: 24 * 60 * 60 * 1000, // 24 hours expiration
    path: "/",                // Available to entire app
  });

  // Return access token in response
  res.json({
    accessToken,
    tokenType: "Bearer",
    expiresIn: process.env.ACCESS_TOKEN_EXP || "30m",
  });
});

/**
 * ✅ PRODUCTION-READY REFRESH TOKEN
 * POST /auth/refresh
 * 
 * Optional: Enable token rotation for enhanced security
 * Set ENABLE_TOKEN_ROTATION=true in .env
 */
router.post("/auth/refresh", (req, res) => {
  const token = req.cookies.refreshToken;

  if (!token) {
    console.warn(`⚠️ Refresh attempt without token from IP: ${req.ip}`);
    return res.status(401).json({ message: "No refresh token" });
  }

  try {
    const decoded = verifyRefreshToken(token);

    // Generate new access token
    const newAccessToken = generateAccessToken({
      role: decoded.role,
    });

    // ✅ OPTIONAL: Token Rotation
    // Uncomment to enable (more secure, but more complex)
    if (process.env.ENABLE_TOKEN_ROTATION === "true") {
      const newRefreshToken = generateRefreshToken({
        role: decoded.role,
      });

      // Set rotated refresh token
      res.cookie("refreshToken", newRefreshToken, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: 24 * 60 * 60 * 1000,
        path: "/",
      });

      console.log(`✅ Token rotated and refreshed at ${new Date().toISOString()}`);
    } else {
      console.log(`✅ Token refreshed at ${new Date().toISOString()}`);
    }

    res.json({
      accessToken: newAccessToken,
      tokenType: "Bearer",
      expiresIn: process.env.ACCESS_TOKEN_EXP || "30m",
    });
  } catch (err) {
    console.error(`❌ Invalid refresh token attempt: ${err.message}`);
    
    // Clear invalid cookie
    res.clearCookie("refreshToken", { path: "/" });
    
    return res.status(401).json({
      message: "Invalid or expired refresh token",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

/**
 * ✅ PRODUCTION-READY LOGOUT
 * POST /auth/logout
 */
router.post("/auth/logout", (req, res) => {
  // Clear refresh token cookie
  res.clearCookie("refreshToken", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  console.log(`✅ Logout successful at ${new Date().toISOString()}`);

  res.json({ message: "Logged out successfully" });
});


/* PRODUCTS ENDPOINT - ENHANCED */
router.get("/products", auth, async (req, res) => {
  const {
    page = 1,
    limit = 20,
    category,
    sku,
    search,
    per_page,
  } = req.query;

  try {
    // 🔍 SKU / barcode lookup (POS scan)
    if (sku) {
      const products = await woo.fetchProductsBySku(sku);
      return res.json({
        data: products.map(normalizeProduct),
      });
    }

    // 🔍 SEARCH mode (search across all products)
    if (search) {
      const searchLimit = per_page || 100;
      const products = await woo.fetchProducts({ 
        page: 1, 
        limit: searchLimit, 
        category,
        search: search.trim(),
      });
      
      return res.json({
        data: products.map(normalizeProduct),
        meta: {
          page: 1,
          limit: searchLimit,
          isSearch: true,
        },
      });
    }

    // 📦 Normal paginated catalog
    const products = await woo.fetchProducts({ page, limit, category });
    
    res.json({
      data: products.map(normalizeProduct),
      meta: {
        page: +page,
        limit: +limit,
        hasNext: products.length === Number(limit),
      },
    });
  } catch (err) {
    console.error("❌ Failed to fetch products:", err);
    res.status(500).json({ 
      message: "Failed to fetch products",
      error: err.message,
    });
  }
});


router.get("/products/:id", auth, async (req, res) => {
  const product = await woo.fetchProductById(req.params.id);
  res.json(normalizeProduct(product));
});

/* CATEGORIES */
router.get("/categories", auth, async (_, res) => {
  const cached = getCachedCategories();
  if (cached) return res.json(cached);

  const categories = await woo.fetchCategories();
  setCachedCategories(categories);

  res.json(categories);
});

router.get("/products/:id/variations", auth, async (req, res) => {
  const variations = await woo.fetchVariations(req.params.id);

  const normalized = variations.map(v => ({
    id: v.id,
    sku: v.sku,
    price: Number(v.price),
    stock_quantity: v.stock_quantity ?? 0,
    stock_status: v.stock_status,
    size: v.attributes.find(a => a.name === "Size")?.option,
  }));

  res.json(normalized);
});



/* ==========================================
   CREATE ORDER - WITH FMS COMPONENTS LOGGING
========================================== */
router.post("/orders", auth, async (req, res) => {
  try {
    const {
      items,
      customer,
      couponCode,
      notes,
      measurements,
      orderType,
      charges,
      paymentMethod,
    } = req.body;

    // ✅ Validate required fields
    if (!items || items.length === 0) {
      return res.status(400).json({ message: "Items are required" });
    }

    // ✅ Log incoming data with FMS components check
    console.log("\n" + "=".repeat(70));
    console.log("📦 NEW ORDER REQUEST");
    console.log("=".repeat(70));
    console.log("Items Count:", items.length);
    console.log("Customer:", customer ? `${customer.first_name} ${customer.last_name}` : "Walk-in");
    console.log("Payment Method:", paymentMethod);
    console.log("Order Type:", orderType);

    // ✅ Check for FMS components in items
    const fmsItems = items.filter(i => i.fms_components && Array.isArray(i.fms_components) && i.fms_components.length > 0);
    
    if (fmsItems.length > 0) {
      console.log("\n🧵 FMS COMPONENTS DETECTED:");
      fmsItems.forEach((item, idx) => {
        console.log(`   ${idx + 1}. Product ID ${item.product_id} (Qty: ${item.qty})`);
        console.log(`      Components: ${item.fms_components.length}`);
        item.fms_components.forEach((comp, compIdx) => {
          console.log(`         ${compIdx + 1}. Fabric ${comp.fabric_id} @ Warehouse ${comp.warehouse_id}`);
          console.log(`            ${comp.meters_per_unit}m/unit × ${item.qty} = ${(comp.meters_per_unit * item.qty).toFixed(2)}m`);
        });
      });
    } else {
      console.log("\nℹ️  No FMS components in this order");
    }

    // 🏗️ Build WooCommerce payload
    const wooPayload = buildWooOrderPayload({
      items,
      customer,
      couponCode,
      notes,
      measurements,
      orderType,
      charges: charges || { alteration: 0, courier: 0, other: 0 },
      paymentMethod,
    });

    console.log("\n📤 WOOCOMMERCE PAYLOAD PREPARED:");
    console.log("   Line Items:", wooPayload.line_items.length);
    
    // Check if meta_data was added to line items
    wooPayload.line_items.forEach((item, idx) => {
      if (item.meta_data && item.meta_data.length > 0) {
        console.log(`   Item ${idx + 1}: Has ${item.meta_data.length} meta_data entries`);
        item.meta_data.forEach(meta => {
          if (meta.key === "_hr_fms_components") {
            const comps = JSON.parse(meta.value);
            console.log(`      ✅ _hr_fms_components: ${comps.length} components`);
          }
        });
      } else {
        console.log(`   Item ${idx + 1}: No meta_data`);
      }
    });

    // 1️⃣ Create in WooCommerce (source of truth)
    console.log("\n🚀 Creating order in WooCommerce...");
    const wooOrder = await woo.createOrder(wooPayload);

    console.log("✅ WOOCOMMERCE ORDER CREATED:");
    console.log("   Order ID:", wooOrder.id);
    console.log("   Order Number:", wooOrder.number);
    console.log("   Total:", wooOrder.total);
    console.log("   Status:", wooOrder.status);

    // 2️⃣ Verify FMS components were saved
    console.log("\n🔍 VERIFYING FMS COMPONENTS IN CREATED ORDER:");
    let fmsItemCount = 0;
    
    wooOrder.line_items.forEach((item, idx) => {
      const fmsMeta = item.meta_data?.find(m => m.key === "_hr_fms_components");
      
      if (fmsMeta) {
        fmsItemCount++;
        const components = JSON.parse(fmsMeta.value);
        console.log(`   ✅ Item ${idx + 1}: "${item.name}"`);
        console.log(`      Components: ${components.length}`);
        components.forEach((comp, compIdx) => {
          console.log(`         ${compIdx + 1}. ${comp.fabric_name} (${comp.meters_total}m)`);
        });
      } else {
        console.log(`   ℹ️  Item ${idx + 1}: "${item.name}" - No FMS components`);
      }
    });

    if (fmsItemCount > 0) {
      console.log(`\n✅ FMS components successfully saved to ${fmsItemCount} item(s)`);
      console.log("⚠️  IMPORTANT: Go to WooCommerce admin and verify fabric was reserved.");
      console.log(`   Order link: ${process.env.WOO_BASE_URL}/wp-admin/post.php?post=${wooOrder.id}&action=edit`);
    }

    // 3️⃣ Normalize for Baserow
    const normalized = normalizeOrderForBaserow(wooOrder);

    // 4️⃣ Sync to Baserow (best effort)
    const baserowResult = await base.upsertOrder(normalized);

    console.log("\n📊 BASEROW SYNC:", baserowResult.ok ? "Success" : "Failed");
    console.log("=".repeat(70) + "\n");

    // 5️⃣ Return full status
    res.status(201).json({
      success: true,
      woo: {
        ok: true,
        order_id: wooOrder.id,
        order_number: wooOrder.number,
        total: wooOrder.total,
        discount_total: wooOrder.discount_total,
        fms_items: fmsItemCount,
      },
      baserow: {
        ok: baserowResult.ok,
      },
      order: normalized,
      warning: fmsItemCount > 0 
        ? "FMS components added to order. Please verify fabric reservation in WooCommerce admin."
        : null,
    });

  } catch (err) {
    console.error("\n" + "=".repeat(70));
    console.error("❌ ORDER CREATION FAILED");
    console.error("=".repeat(70));
    console.error("Error:", err.response?.data || err.message);
    console.error("=".repeat(70) + "\n");
    
    res.status(500).json({
      success: false,
      woo: { ok: false },
      baserow: { ok: false },
      message: err.response?.data?.message || "Order creation failed",
      error: err.message,
    });
  }
});

/* ==========================================
   LIST ORDERS (PAGINATED + SEARCH)
========================================== */
router.get("/orders", auth, async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  
  try {
    // 🔍 If search query provided, fetch more results and filter
    if (search) {
      const searchLimit = 100;
      const data = await base.getOrders({ page: 1, limit: searchLimit });
      
      // Filter results by order_number (client-side)
      const query = search.trim().toLowerCase();
      const filtered = (data.results || []).filter(order => 
        order.order_number?.toLowerCase().includes(query)
      );
      
      return res.json({
        results: filtered,
        count: filtered.length,
        next: null,
        previous: null,
      });
    }
    
    // Normal paginated list
    const data = await base.getOrders({ page, limit });
    res.json(data);
  } catch (err) {
    console.error("❌ Failed to fetch orders:", err);
    res.status(500).json({ 
      message: "Failed to fetch orders",
      error: err.message,
    });
  }
});

/* ==========================================
   GET ORDER BY ID - FIXED RETRIEVAL
========================================== */
router.get("/orders/:id", auth, async (req, res) => {
  const wooOrderId = req.params.id;

  if (!wooOrderId || wooOrderId === "undefined") {
    return res.status(400).json({ message: "Invalid order ID" });
  }

  try {
    // 1️⃣ Fetch from Baserow first (fast path)
    let order = await base.getOrderByWooId(wooOrderId);

    // 2️⃣ If not found, fetch from WooCommerce and sync
    if (!order) {
      const wooOrder = await woo.fetchOrder(wooOrderId);
      order = normalizeOrderForBaserow(wooOrder);
      await base.upsertOrder(order);
    }

    // 3️⃣ Parse items (stored as JSON string)
    let items = [];
    try {
      items =
        typeof order.items === "string"
          ? JSON.parse(order.items)
          : order.items;
    } catch {
      items = [];
    }

    if (!Array.isArray(items)) {
      items = [];
    }

    // 4️⃣ AUTHORITATIVE TOTALS (DO NOT RECALCULATE)
    const discount = Number(order.discount_amount || 0);

    const charges = {
      alteration: Number(order.alteration_charge || 0),
      courier: Number(order.courier_charge || 0),
      other: Number(order.other_charge || 0),
    };

    const chargesTotal =
      charges.alteration + charges.courier + charges.other;

    const tax = Number(order.tax_total || 0);

    // Subtotal derived safely from Woo totals
    const subtotal =
      Number(order.total) +
      discount -
      chargesTotal -
      tax;

    // 5️⃣ FINAL RESPONSE (PRINT-SAFE)
    res.json({
      woo_order_id: order.woo_order_id,
      order_number: order.order_number,
      status: order.status,
      payment_method: order.payment_method,
      customer_id: order.customer_id,
      created_at: order.created_at,
      updated_at: order.updated_at,

      items: items.map((item, idx) => ({
        key: `${item.product_id || "custom"}-${item.sku || idx}`,
        product_id: item.product_id,
        variation_id: item.variation_id,
        name: item.name,
        sku: item.sku || "",
        quantity: Number(item.quantity || 0),
        unit_price: Number(item.unit_price || 0),
        line_total: Number(item.total || 0),
      })),

      totals: {
        subtotal: Math.max(subtotal, 0),
        discount,
        chargesTotal,
        tax,
        grandTotal: Number(order.total),
      },

      charges,

      discount_details: {
        type: order.discount_type || null,
        amount: discount,
      },

      order_type: order.order_type || "Normal Sale",
      measurements: order.measurements || "-",
      notes: order.notes || "",
    });
  } catch (err) {
    console.error("❌ Failed to fetch order:", err);
    res.status(500).json({
      message: "Failed to fetch order",
      error: err.message,
    });
  }
});


/* ==========================================
   MARK ORDER AS COMPLETED
========================================== */
router.patch("/orders/:id/complete", auth, async (req, res) => {
  const wooOrderId = req.params.id;

  if (!wooOrderId || wooOrderId === "undefined") {
    return res.status(400).json({ message: "Invalid order ID" });
  }

  try {
    // Check if exists in Baserow
    const existing = await base.getOrderByWooId(wooOrderId);

    if (!existing) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Skip if already completed/cancelled
    if (existing.status === "completed" || existing.status === "cancelled") {
      return res.json({ 
        message: "Order already finalized", 
        order: existing 
      });
    }

    // Update in WooCommerce
    await woo.updateOrderStatus(wooOrderId, { status: "completed" });

    // Add order note
    woo.addOrderNote(
      wooOrderId,
      "Order marked as completed via POS"
    ).catch(console.error);

    // Update in Baserow
    const updated = await base.patchOrderStatus(wooOrderId, "completed");

    res.json({
      message: "Order marked as completed",
      order: updated,
    });

  } catch (err) {
    console.error("❌ Failed to mark completed:", err);
    res.status(500).json({ 
      message: "Failed to mark order as completed",
      error: err.message,
    });
  }
});


/* ==========================================
   LIST ORDERS (PAGINATED)
========================================== */
router.get("/orders", auth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  
  try {
    const data = await base.getOrders({ page, limit });
    res.json(data);
  } catch (err) {
    console.error("❌ Failed to fetch orders:", err);
    res.status(500).json({ 
      message: "Failed to fetch orders",
      error: err.message,
    });
  }
});

/* ==========================================
   FMS INSPECTION ENDPOINTS (Read-Only)
   Add these to your routes.js after the main order routes
========================================== */

/**
 * Get FMS component details for a specific order
 * GET /api/orders/:id/fms-components
 */
router.get("/orders/:id/fms-components", auth, async (req, res) => {
  const wooOrderId = req.params.id;

  if (!wooOrderId || wooOrderId === "undefined") {
    return res.status(400).json({ message: "Invalid order ID" });
  }

  try {
    console.log(`\n🔍 Checking FMS components for Order #${wooOrderId}...`);
    
    const wooOrder = await woo.fetchOrder(wooOrderId);
    
    if (!wooOrder) {
      return res.status(404).json({ message: "Order not found" });
    }

    const fmsData = [];
    let totalMetersReserved = 0;

    for (const item of wooOrder.line_items) {
      const fmsMeta = item.meta_data?.find(m => m.key === "_hr_fms_components");
      
      if (fmsMeta) {
        let components;
        try {
          components = typeof fmsMeta.value === "string" 
            ? JSON.parse(fmsMeta.value) 
            : fmsMeta.value;
        } catch (e) {
          console.error(`⚠️  Failed to parse FMS data for item ${item.id}`);
          continue;
        }

        if (Array.isArray(components) && components.length > 0) {
          const itemMeters = components.reduce((sum, c) => sum + (c.meters_total || 0), 0);
          totalMetersReserved += itemMeters;

          fmsData.push({
            item_id: item.id,
            product_id: item.product_id,
            variation_id: item.variation_id,
            name: item.name,
            sku: item.sku,
            quantity: item.quantity,
            total_meters: itemMeters.toFixed(2),
            components: components.map(c => ({
              fabric_id: c.fabric_id,
              fabric_name: c.fabric_name,
              warehouse_id: c.warehouse_id,
              warehouse_name: c.warehouse_name,
              meters_per_unit: c.meters_per_unit,
              meters_total: c.meters_total,
            })),
          });

          console.log(`   ✅ Item: "${item.name}"`);
          console.log(`      Total: ${itemMeters.toFixed(2)}m across ${components.length} fabric(s)`);
        }
      }
    }

    if (fmsData.length === 0) {
      console.log("   ℹ️  No FMS components found");
    } else {
      console.log(`   📊 Total fabric reserved: ${totalMetersReserved.toFixed(2)}m`);
    }

    res.json({
      order_id: wooOrderId,
      order_number: wooOrder.number,
      order_status: wooOrder.status,
      has_fms_components: fmsData.length > 0,
      total_items: wooOrder.line_items.length,
      fms_items_count: fmsData.length,
      total_meters_reserved: totalMetersReserved.toFixed(2),
      items: fmsData,
    });

  } catch (err) {
    console.error("❌ Failed to fetch FMS components:", err);
    res.status(500).json({
      message: "Failed to fetch FMS components",
      error: err.message,
    });
  }
});


/**
 * Check FMS status across recent orders
 * GET /api/orders/check-fms-status?limit=10
 */
router.get("/orders-fms-check/status", auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    console.log(`\n🔍 Checking last ${limit} orders for FMS components...`);
    
    const orders = await woo.fetchRecentOrders();
    const recentOrders = orders.slice(0, limit);

    const results = [];

    for (const order of recentOrders) {
      let fmsItemCount = 0;
      let totalComponents = 0;

      for (const item of order.line_items) {
        const fmsMeta = item.meta_data?.find(m => m.key === "_hr_fms_components");
        
        if (fmsMeta) {
          fmsItemCount++;
          try {
            const components = typeof fmsMeta.value === "string" 
              ? JSON.parse(fmsMeta.value) 
              : fmsMeta.value;
            if (Array.isArray(components)) {
              totalComponents += components.length;
            }
          } catch (e) {
            // Skip parsing errors
          }
        }
      }

      results.push({
        order_id: order.id,
        order_number: order.number,
        date: order.date_created,
        status: order.status,
        total_items: order.line_items.length,
        fms_items: fmsItemCount,
        total_components: totalComponents,
        has_fms: fmsItemCount > 0,
      });

      const icon = fmsItemCount > 0 ? "✅" : "ℹ️ ";
      console.log(`   ${icon} Order #${order.number}: ${fmsItemCount}/${order.line_items.length} items have FMS`);
    }

    const ordersWithFms = results.filter(r => r.has_fms).length;

    console.log(`\n📊 Summary: ${ordersWithFms}/${results.length} orders have FMS components`);

    res.json({
      checked: results.length,
      orders_with_fms: ordersWithFms,
      orders: results,
    });

  } catch (err) {
    console.error("❌ Failed to check FMS status:", err);
    res.status(500).json({
      message: "Failed to check FMS status",
      error: err.message,
    });
  }
});


/**
 * Check if FMS components are properly attached to recent orders
 * Useful for debugging
 */
router.get("/orders/check-fms-status", auth, async (req, res) => {
  try {
    const limit = req.query.limit || 10;
    
    console.log(`\n🔍 Checking last ${limit} orders for FMS components...`);
    
    const orders = await woo.fetchRecentOrders();
    const recentOrders = orders.slice(0, limit);

    const results = [];

    for (const order of recentOrders) {
      let fmsItemCount = 0;
      let totalComponents = 0;

      for (const item of order.line_items) {
        const fmsMeta = item.meta_data?.find(m => m.key === "_hr_fms_components");
        
        if (fmsMeta) {
          fmsItemCount++;
          try {
            const components = typeof fmsMeta.value === "string" 
              ? JSON.parse(fmsMeta.value) 
              : fmsMeta.value;
            if (Array.isArray(components)) {
              totalComponents += components.length;
            }
          } catch (e) {
            // Skip parsing errors
          }
        }
      }

      results.push({
        order_id: order.id,
        order_number: order.number,
        date: order.date_created,
        status: order.status,
        total_items: order.line_items.length,
        fms_items: fmsItemCount,
        total_components: totalComponents,
        has_fms: fmsItemCount > 0,
      });

      const icon = fmsItemCount > 0 ? "✅" : "ℹ️ ";
      console.log(`   ${icon} Order #${order.number}: ${fmsItemCount}/${order.line_items.length} items have FMS`);
    }

    const ordersWithFms = results.filter(r => r.has_fms).length;

    console.log(`\n📊 Summary: ${ordersWithFms}/${results.length} orders have FMS components`);

    res.json({
      checked: results.length,
      orders_with_fms: ordersWithFms,
      orders: results,
    });

  } catch (err) {
    console.error("❌ Failed to check FMS status:", err);
    res.status(500).json({
      message: "Failed to check FMS status",
      error: err.message,
    });
  }
});

/* ==========================================
   CUSTOMERS - WooCommerce + Baserow Sync
========================================== */

/**
 * Generate a secure random password
 */
function generateSecurePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Get all customers (from Baserow with optional search)
 */
router.get("/customers", auth, async (req, res) => {
  try {
    const { page = 1, limit = 100, search } = req.query;
    
    let data = await base.getCustomers({ page, limit });
    
    // Optional: Client-side search if needed
    if (search) {
      const query = search.toLowerCase();
      data.results = data.results.filter(c => 
        (c.first_name || "").toLowerCase().includes(query) ||
        (c.last_name || "").toLowerCase().includes(query) ||
        (c.phone || "").includes(query) ||
        (c.email || "").toLowerCase().includes(query)
      );
    }
    
    res.json(data);
  } catch (err) {
    console.error("❌ Failed to fetch customers:", err);
    res.status(500).json({ 
      message: "Failed to fetch customers",
      error: err.message,
    });
  }
});

/**
 * Get single customer by ID
 */
router.get("/customers/:id", auth, async (req, res) => {
  try {
    // Try Baserow first
    let customer = await base.getCustomerById(req.params.id);
    
    // If not found and ID looks like a WooCommerce ID, try fetching from WooCommerce
    if (!customer && !isNaN(req.params.id)) {
      const wooCustomer = await woo.fetchCustomer(req.params.id);
      if (wooCustomer) {
        // Sync to Baserow
        customer = await base.upsertCustomer(wooCustomer);
      }
    }
    
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }
    
    res.json(customer);
  } catch (err) {
    console.error("❌ Failed to fetch customer:", err);
    res.status(500).json({ 
      message: "Failed to fetch customer",
      error: err.message,
    });
  }
});

/**
 * Create new customer (WooCommerce + Baserow sync)
 */
router.post("/customers", auth, async (req, res) => {
  try {
    const { first_name, last_name, phone, email, billing, customer_type } = req.body;

    console.log("\n" + "=".repeat(70));
    console.log("📥 [STEP 1] RECEIVED REQUEST");
    console.log("=".repeat(70));
    console.log("First Name:", first_name);
    console.log("Last Name:", last_name);
    console.log("Phone:", phone);
    console.log("Email:", email);
    console.log("Customer Type (from req.body):", customer_type);
    console.log("Billing:", JSON.stringify(billing, null, 2));

    // ✅ Validate required fields
    if (!first_name?.trim()) {
      return res.status(400).json({ message: "First name is required" });
    }

    if (!phone?.trim()) {
      return res.status(400).json({ message: "Phone is required" });
    }

    // ✅ Check for duplicate phone in Baserow
    const existingByPhone = await base.findCustomerByPhone(phone.trim());
    if (existingByPhone) {
      console.log("⚠️ Customer with this phone already exists:", existingByPhone.id);
      return res.status(409).json({ 
        message: "Customer with this phone number already exists",
        customer: existingByPhone,
      });
    }

    console.log("\n" + "=".repeat(70));
    console.log("📦 [STEP 2] BUILDING WOOCOMMERCE PAYLOAD");
    console.log("=".repeat(70));

    // ✅ Build WooCommerce payload
    const wooPayload = {
      first_name: first_name.trim(),
      last_name: (last_name || "").trim(),
      username: `customer_${phone.trim()}`,
      password: generateSecurePassword(),
      billing: {
        first_name: first_name.trim(),
        last_name: (last_name || "").trim(),
        phone: phone.trim(),
        address_1: billing?.address_1 || "",
        address_2: billing?.address_2 || "",
        city: billing?.city || "",
        state: billing?.state || "",
        postcode: billing?.postcode || "",
        country: billing?.country || "IN",
      },
      shipping: {
        first_name: first_name.trim(),
        last_name: (last_name || "").trim(),
        address_1: billing?.address_1 || "",
        address_2: billing?.address_2 || "",
        city: billing?.city || "",
        state: billing?.state || "",
        postcode: billing?.postcode || "",
        country: billing?.country || "IN",
      },
      // ✅ Add customer type to meta_data
      meta_data: [
        {
          key: "customer_type",
          value: customer_type || "Walk-in customer"
        }
      ]
    };

    console.log("WooPayload.meta_data:", JSON.stringify(wooPayload.meta_data, null, 2));

    // ✅ Only add email if provided and valid
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (email && email.trim() && emailRegex.test(email.trim())) {
      wooPayload.email = email.trim();
      wooPayload.billing.email = email.trim();
    }

    console.log("\n" + "=".repeat(70));
    console.log("🚀 [STEP 3] CREATING IN WOOCOMMERCE");
    console.log("=".repeat(70));

    // 1️⃣ Create in WooCommerce
    const wooCustomer = await woo.createCustomer(wooPayload);
    
    console.log("✅ WooCommerce Response:");
    console.log("   Customer ID:", wooCustomer.id);
    console.log("   First Name:", wooCustomer.first_name);
    console.log("   Meta Data:", JSON.stringify(wooCustomer.meta_data, null, 2));
    
    // Extract customer type from response
    const extractedType = wooCustomer.meta_data?.find(m => m.key === "customer_type")?.value;
    console.log("   Extracted Customer Type:", extractedType);

    console.log("\n" + "=".repeat(70));
    console.log("💾 [STEP 4] SYNCING TO BASEROW");
    console.log("=".repeat(70));

    // 2️⃣ Sync to Baserow
    let baserowCustomer;
    try {
      console.log("Calling base.upsertCustomer with WooCommerce customer...");
      console.log("WooCustomer structure:");
      console.log("  - id:", wooCustomer.id);
      console.log("  - meta_data:", wooCustomer.meta_data);
      
      baserowCustomer = await base.upsertCustomer(wooCustomer);
      
      console.log("✅ Baserow Response:");
      console.log("   Baserow ID:", baserowCustomer.id);
      console.log("   Customer Type:", baserowCustomer.customer_type);
      console.log("   Full Response:", JSON.stringify(baserowCustomer, null, 2));
    } catch (baserowErr) {
      console.error("⚠️ Baserow sync failed (non-critical):", baserowErr.message);
      console.error("Full error:", baserowErr);
      
      baserowCustomer = {
        woo_customer_id: wooCustomer.id,
        first_name: wooCustomer.first_name,
        last_name: wooCustomer.last_name,
        email: wooCustomer.email,
        phone: wooCustomer.billing?.phone,
        address: "",
        customer_type: customer_type || "Walk-in customer",
      };
    }

    console.log("\n" + "=".repeat(70));
    console.log("✅ [STEP 5] SENDING RESPONSE");
    console.log("=".repeat(70));
    console.log("Final customer_type being returned:", baserowCustomer.customer_type);
    console.log("=".repeat(70) + "\n");

    res.status(201).json(baserowCustomer);
  } catch (err) {
    console.error("\n" + "=".repeat(70));
    console.error("❌ CUSTOMER CREATION FAILED");
    console.error("=".repeat(70));
    console.error("Status:", err.response?.status);
    console.error("Data:", JSON.stringify(err.response?.data, null, 2));
    console.error("Message:", err.message);
    console.error("Stack:", err.stack);
    console.error("=".repeat(70) + "\n");
    
    res.status(err.response?.status || 500).json({ 
      message: err.response?.data?.message || "Failed to create customer",
      error: err.message,
      details: err.response?.data,
    });
  }
});

/**
 * Update customer (WooCommerce → Fetch Full Data → Baserow)
 */
router.patch("/customers/:id", auth, async (req, res) => {
  try {
    const wooCustomerId = req.params.id;
    const { first_name, last_name, email, phone, billing, meta_data } = req.body;

    console.log("\n" + "=".repeat(70));
    console.log("📥 [UPDATE REQUEST]");
    console.log("   WooCommerce Customer ID:", wooCustomerId);
    console.log("   Data:", { first_name, last_name, email, phone });
    console.log("   meta_data:", meta_data);
    console.log("=".repeat(70));

    if (!wooCustomerId || isNaN(wooCustomerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid WooCommerce customer ID",
      });
    }

    /* ---------------------------------
       EMAIL VALIDATION (billing only)
    ---------------------------------- */
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const providedEmail = (email || "").trim();

    if (providedEmail && !emailRegex.test(providedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
        email: providedEmail,
      });
    }

    /* ---------------------------------
       BUILD WOO PAYLOAD
    ---------------------------------- */
    const wooPayload = {
      first_name: (first_name || "").trim(),
      last_name: (last_name || "").trim(),
      billing: {
        first_name: (first_name || "").trim(),
        last_name: (last_name || "").trim(),
        phone: (phone || "").trim(),
        address_1: billing?.address_1 || "",
        address_2: billing?.address_2 || "",
        city: billing?.city || "",
        state: billing?.state || "",
        postcode: billing?.postcode || "",
        country: billing?.country || "IN",
      },
    };

    // Add email if provided
    if (providedEmail) {
      wooPayload.billing.email = providedEmail;
    }

    // ✅ ADD: Include meta_data if provided (for customer_type updates)
    if (meta_data && Array.isArray(meta_data)) {
      wooPayload.meta_data = meta_data;
    }

    console.log("\n📋 [WOO PAYLOAD]");
    console.log(JSON.stringify(wooPayload, null, 2));

    /* ---------------------------------
       UPDATE WOO
    ---------------------------------- */
    const updated = await woo.updateCustomer(wooCustomerId, wooPayload);
    console.log("✅ WooCommerce updated:", updated.id);

    /* ---------------------------------
       ✅ NEW: FETCH FULL CUSTOMER & SYNC TO BASEROW
    ---------------------------------- */
    try {
      console.log("\n🔄 Fetching full customer data from WooCommerce...");
      const fullCustomer = await woo.fetchCustomer(wooCustomerId);
      
      console.log("📦 Full customer fetched:");
      console.log("   meta_data:", JSON.stringify(fullCustomer.meta_data, null, 2));
      
      console.log("\n💾 Syncing to Baserow...");
      const baserowCustomer = await base.upsertCustomer(fullCustomer);
      
      console.log("✅ Baserow synced:");
      console.log("   customer_type:", baserowCustomer.customer_type);
    } catch (syncErr) {
      console.error("⚠️ Baserow sync failed (non-critical):", syncErr.message);
    }

    return res.json({
      success: true,
      message: "Customer updated successfully",
      woo_customer_id: updated.id,
      email: updated.billing?.email || null,
    });

  } catch (err) {
    console.error("❌ Customer update failed:", err.response?.data || err.message);

    return res.status(err.response?.status || 500).json({
      success: false,
      message: "Failed to update customer",
      error: err.response?.data || err.message,
    });
  }
});



router.delete("/customers/:id", auth, (req, res) => {
  return res.status(405).json({
    success: false,
    message: "Customer deletion is not allowed in POS",
  });
});


/* ==========================================
   REPORTS ENDPOINTS
========================================== */

/**
 * Get comprehensive dashboard report
 * Combines multiple report types for dashboard view
 */
router.get("/reports/dashboard", auth, async (req, res) => {
  try {
    const { period, date_min, date_max } = req.query;
    
    console.log("\n📊 Fetching dashboard reports...");
    console.log("   Period:", period || "default");
    console.log("   Date range:", date_min && date_max ? `${date_min} to ${date_max}` : "none");

    const [
      salesReport,
      topSellers,
      ordersTotals,
      customersTotals,
      productsTotals,
      couponsTotals,
    ] = await Promise.all([
      woo.fetchSalesReport({ period, date_min, date_max }),
      woo.fetchTopSellersReport({ period, date_min, date_max }),
      woo.fetchOrdersTotals(),
      woo.fetchCustomersTotals(),
      woo.fetchProductsTotals(),
      woo.fetchCouponsTotals(),
    ]);

    console.log("✅ All reports fetched successfully");

    res.json({
      success: true,
      data: {
        sales: salesReport,
        topSellers: topSellers,
        totals: {
          orders: ordersTotals,
          customers: customersTotals,
          products: productsTotals,
          coupons: couponsTotals,
        },
      },
    });
  } catch (err) {
    console.error("❌ Failed to fetch dashboard reports:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch reports",
      error: err.message,
    });
  }
});

/**
 * Get sales report
 */
router.get("/reports/sales", auth, async (req, res) => {
  try {
    const { period, date_min, date_max } = req.query;
    const data = await woo.fetchSalesReport({ period, date_min, date_max });
    res.json({ success: true, data });
  } catch (err) {
    console.error("❌ Failed to fetch sales report:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch sales report",
      error: err.message,
    });
  }
});

/**
 * Get top sellers report
 */
router.get("/reports/top-sellers", auth, async (req, res) => {
  try {
    const { period, date_min, date_max } = req.query;
    const data = await woo.fetchTopSellersReport({ period, date_min, date_max });
    res.json({ success: true, data });
  } catch (err) {
    console.error("❌ Failed to fetch top sellers:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch top sellers",
      error: err.message,
    });
  }
});

/**
 * Get all totals (orders, customers, products, coupons)
 */
router.get("/reports/totals", auth, async (req, res) => {
  try {
    const [orders, customers, products, coupons] = await Promise.all([
      woo.fetchOrdersTotals(),
      woo.fetchCustomersTotals(),
      woo.fetchProductsTotals(),
      woo.fetchCouponsTotals(),
    ]);

    res.json({
      success: true,
      data: {
        orders,
        customers,
        products,
        coupons,
      },
    });
  } catch (err) {
    console.error("❌ Failed to fetch totals:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch totals",
      error: err.message,
    });
  }
});

/* ==========================================
   COUPONS ENDPOINTS
   Add this section BEFORE "export default router;" at the end of routes.js
========================================== */

/**
 * Get all coupons
 * GET /api/coupons
 */
router.get("/coupons", auth, async (req, res) => {
  try {
    const { page = 1, per_page = 100, search, code } = req.query;
    
    const coupons = await woo.fetchCoupons({ 
      page, 
      per_page, 
      search,
      code
    });
    
    res.json({
      success: true,
      data: coupons,
      count: coupons.length,
    });
  } catch (err) {
    console.error("❌ Failed to fetch coupons:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch coupons",
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * Get single coupon by ID
 * GET /api/coupons/:id
 */
router.get("/coupons/:id", auth, async (req, res) => {
  try {
    const coupon = await woo.fetchCoupon(req.params.id);
    
    res.json({
      success: true,
      data: coupon,
    });
  } catch (err) {
    console.error("❌ Failed to fetch coupon:", err);
    
    if (err.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }
    
    res.status(500).json({
      success: false,
      message: "Failed to fetch coupon",
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * Create new coupon
 * POST /api/coupons
 */
router.post("/coupons", auth, async (req, res) => {
  try {
    const {
      code,
      discount_type = "percent",
      amount,
      description = "",
      individual_use = false,
      exclude_sale_items = false,
      minimum_amount = "0",
      maximum_amount = "0",
      free_shipping = false,
      usage_limit = null,
      usage_limit_per_user = null,
      date_expires = null,
    } = req.body;

    console.log("\n" + "=".repeat(70));
    console.log("🎟️ NEW COUPON REQUEST");
    console.log("=".repeat(70));
    console.log("Code:", code);
    console.log("Type:", discount_type);
    console.log("Amount:", amount);
    console.log("=".repeat(70));

    // Validate required fields
    if (!code || !code.trim()) {
      return res.status(400).json({
        success: false,
        message: "Coupon code is required",
      });
    }

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid discount amount is required",
      });
    }

    // Valid discount types
    const validTypes = ["percent", "fixed_cart", "fixed_product"];
    if (!validTypes.includes(discount_type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid discount type. Must be: percent, fixed_cart, or fixed_product",
      });
    }

    // Build coupon payload
    const payload = {
      code: code.trim().toUpperCase(),
      discount_type,
      amount: String(amount),
      description,
      individual_use,
      exclude_sale_items,
      minimum_amount: String(minimum_amount),
      maximum_amount: String(maximum_amount),
      free_shipping,
    };

    // Optional fields
    if (usage_limit) payload.usage_limit = Number(usage_limit);
    if (usage_limit_per_user) payload.usage_limit_per_user = Number(usage_limit_per_user);
    if (date_expires) payload.date_expires = date_expires;

    // Create in WooCommerce
    const coupon = await woo.createCoupon(payload);

    console.log("✅ COUPON CREATED:");
    console.log("   ID:", coupon.id);
    console.log("   Code:", coupon.code);
    console.log("   Amount:", coupon.amount);
    console.log("=".repeat(70) + "\n");

    res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      data: coupon,
    });
  } catch (err) {
    console.error("\n" + "=".repeat(70));
    console.error("❌ COUPON CREATION FAILED");
    console.error("=".repeat(70));
    console.error("Error:", err.response?.data || err.message);
    console.error("=".repeat(70) + "\n");

    // Handle duplicate code error
    if (err.response?.data?.code === "woocommerce_rest_coupon_code_already_exists") {
      return res.status(409).json({
        success: false,
        message: "A coupon with this code already exists",
        error: "Duplicate coupon code",
      });
    }

    res.status(err.response?.status || 500).json({
      success: false,
      message: "Failed to create coupon",
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * Update coupon
 * PUT /api/coupons/:id
 */
router.put("/coupons/:id", auth, async (req, res) => {
  try {
    const couponId = req.params.id;
    
    if (!couponId || isNaN(couponId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon ID",
      });
    }

    console.log(`\n📝 Updating coupon ${couponId}...`);

    const coupon = await woo.updateCoupon(couponId, req.body);

    console.log(`✅ Coupon ${couponId} updated successfully\n`);

    res.json({
      success: true,
      message: "Coupon updated successfully",
      data: coupon,
    });
  } catch (err) {
    console.error(`❌ Failed to update coupon:`, err);

    if (err.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.status(err.response?.status || 500).json({
      success: false,
      message: "Failed to update coupon",
      error: err.response?.data?.message || err.message,
    });
  }
});

/**
 * Delete coupon
 * DELETE /api/coupons/:id
 */
router.delete("/coupons/:id", auth, async (req, res) => {
  try {
    const couponId = req.params.id;
    
    if (!couponId || isNaN(couponId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid coupon ID",
      });
    }

    const force = req.query.force !== "false";

    await woo.deleteCoupon(couponId, force);

    res.json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (err) {
    console.error(`❌ Failed to delete coupon:`, err);

    if (err.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.status(err.response?.status || 500).json({
      success: false,
      message: "Failed to delete coupon",
      error: err.response?.data?.message || err.message,
    });
  }
});

export default router;