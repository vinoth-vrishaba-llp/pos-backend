// backend/orderUtils.js

/**
 * Build WooCommerce Order Payload from POS Cart
 * ✅ UPDATED: Properly formats FMS components to match WordPress plugin expectations
 * ✅ FIXED: Removed created_at to let WooCommerce handle timestamps
 */
export function buildWooOrderPayload(cartData) {
  const {
    items,              // Cart items with product_id, variation_id, qty, fms_components
    customer,           // Customer object or null for walk-in
    couponCode,         // Coupon code string (optional)
    notes,              // Customer notes
    measurements,       // Customer measurements
    orderType,          // "Normal Sale" | "Advanced Booking" | "Alteration"
    charges,            // { alteration, courier, other }
    paymentMethod,      // "cod" | "cash" | "card" | "upi"
  } = cartData;

  // 1️⃣ Build line items with FMS components in meta_data
  const line_items = items.map(item => {
    const lineItem = {
      product_id: item.product_id,
      variation_id: item.variation_id || 0,
      quantity: item.qty,
    };

    // ✅ Add FMS components to line item meta_data if available
    if (item.fms_components && Array.isArray(item.fms_components) && item.fms_components.length > 0) {
      // Transform to match WordPress FMS plugin expected format
      const snapshot = item.fms_components.map(comp => ({
        fabric_id: String(comp.fabric_id || comp.fabricId || ""),
        fabric_name: comp.fabric_name || comp.fabricName || comp.fabric_id,
        warehouse_id: String(comp.warehouse_id || comp.warehouseId || "1"),
        warehouse_name: comp.warehouse_name || comp.warehouseName || "Main Warehouse",
        meters_per_unit: Number(comp.meters_per_unit || comp.metersPerUnit || 0),
        meters_total: Number((comp.meters_per_unit || comp.metersPerUnit || 0) * item.qty),
      }));

      lineItem.meta_data = [
        {
          key: "_hr_fms_components",
          value: JSON.stringify(snapshot),
        }
      ];
    }

    return lineItem;
  });

  // 2️⃣ Build billing info
  let billing;
  
  if (customer) {
    billing = {
      first_name: customer.first_name || "",
      last_name: customer.last_name || "",
      phone: customer.phone || "",
      address_1: customer.address_1 || "",
      address_2: customer.address_2 || "",
      city: customer.city || "",
      state: customer.state || "",
      postcode: customer.postcode || "",
      country: customer.country || "IN",
    };
    
    // Only add email if it exists and is not empty
    if (customer.email && customer.email.trim()) {
      billing.email = customer.email.trim();
    }
  } else {
    // Walk-in customer
    billing = {
      first_name: "Walk-in",
      last_name: "Customer",
      phone: "",
      address_1: "",
      city: "",
      country: "IN",
    };
  }

  // 3️⃣ Build coupon lines
  const coupon_lines = [];
  if (couponCode && couponCode.trim()) {
    coupon_lines.push({
      code: couponCode.trim(),
    });
  }

  // 4️⃣ Build fee lines (alteration + other charges ONLY)
  const fee_lines = [];
  
  if (charges.alteration && charges.alteration > 0) {
    fee_lines.push({
      name: "Alteration Charges",
      total: String(charges.alteration),
      tax_status: "none",
    });
  }

  if (charges.other && charges.other > 0) {
    fee_lines.push({
      name: "Other Charges",
      total: String(charges.other),
      tax_status: "none",
    });
  }

  // 5️⃣ Build shipping lines (courier charge)
  const shipping_lines = [];
  if (charges.courier && charges.courier > 0) {
    shipping_lines.push({
      method_id: "flat_rate",
      method_title: "Courier Charges",
      total: String(charges.courier),
    });
  }

  // 6️⃣ Build meta_data for order
  const meta_data = [
    {
      key: "order_type",
      value: orderType || "Normal Sale",
    },
    {
      key: "measurements",
      value: measurements || "-",
    },
    {
      key: "_pos_order",
      value: "yes",
    },
  ];

  // 7️⃣ Assemble final payload
  const payload = {
    status: "processing",
    customer_id: customer?.woo_customer_id || 0,
    payment_method: paymentMethod || "cod",
    payment_method_title: getPaymentMethodTitle(paymentMethod),
    set_paid: paymentMethod !== "cod",
    billing,
    shipping: billing,
    line_items,
    coupon_lines,
    fee_lines,
    shipping_lines,
    customer_note: notes || "",
    meta_data,
    // ❌ REMOVED: created_at - WooCommerce handles this automatically with correct timezone
  };

  return payload;
}

/**
 * Helper: Get payment method title
 */
function getPaymentMethodTitle(method) {
  const titles = {
    cod: "Cash on Delivery",
    bacs: "Direct Bank Transfer",
    cash: "Cash Payment",
    card: "Card Payment",
    upi: "UPI Payment",
    upi_card: "UPI / Card Payment",
  };
  return titles[method] || "Cash Payment";
}


/**
 * Check if order was created via POS
 * This prevents WordPress-created orders from syncing to Baserow
 */
export function isPosOrder(wooOrder) {
  // ✅ CRITICAL: Check if order and meta_data exist
  if (!wooOrder || !wooOrder.meta_data || !Array.isArray(wooOrder.meta_data)) {
    console.log("[isPosOrder] No meta_data found, returning false");
    return false;
  }
  
  const posOrderMeta = wooOrder.meta_data.find(m => m.key === "_pos_order");
  const result = posOrderMeta && posOrderMeta.value === "yes";
  
  console.log(`[isPosOrder] Order ${wooOrder.number}: ${result ? "POS" : "NOT POS"}`);
  return result;
} 
   export function normalizeOrderForBaserow(wooOrder, skipPosCheck = false) {
     if (!skipPosCheck && !isPosOrder(wooOrder)) {
       return null; // Don't normalize non-POS orders
     }

  // Extract coupon info
  const coupon = wooOrder.coupon_lines?.[0];
  const discountType = coupon 
    ? (coupon.discount_type || "fixed_cart")
    : null;

  // Extract fees by name
  const getFee = (name) => {
    const fee = wooOrder.fee_lines?.find(f => f.name === name);
    return Number(fee?.total || 0);
  };

  // Extract shipping (courier charge)
  const courierCharge = wooOrder.shipping_lines?.[0]
    ? Number(wooOrder.shipping_lines[0].total || 0)
    : 0;

  // Extract meta_data
  const getMeta = (key) => {
    const meta = wooOrder.meta_data?.find(m => m.key === key);
    return meta?.value || null;
  };

  return {
    woo_order_id: wooOrder.id,
    order_number: String(wooOrder.number),
    status: mapStatus(wooOrder.status),
    total: Number(wooOrder.total),
    payment_method: wooOrder.payment_method || "unknown",
    customer_id: wooOrder.customer_id > 0 ? wooOrder.customer_id : null,
    notes: wooOrder.customer_note || "",
    measurements: getMeta("measurements") || "-",
    items: JSON.stringify(normalizeLineItems(wooOrder.line_items)),
    
    created_at: wooOrder.date_created_gmt ? `${wooOrder.date_created_gmt}Z` : wooOrder.date_created,
    updated_at: wooOrder.date_modified_gmt 
      ? `${wooOrder.date_modified_gmt}Z` 
      : (wooOrder.date_created_gmt ? `${wooOrder.date_created_gmt}Z` : wooOrder.date_created),
    
    discount_type: discountType,
    discount_amount: Number(wooOrder.discount_total || 0),
    
    alteration_charge: getFee("Alteration Charges"),
    courier_charge: courierCharge,
    other_charge: getFee("Other Charges"),
    
    order_type: getMeta("order_type") || "Normal Sale",
  };
}

function mapStatus(wooStatus) {
  const STATUS_MAP = {
    "checkout-draft": "paid",
    "pending": "paid",
    "processing": "paid",
    "on-hold": "paid",
    "completed": "completed",
    "cancelled": "cancelled",
    "refunded": "refund",
    "failed": "cancelled",
  };
  return STATUS_MAP[wooStatus] || "paid";
}

function normalizeLineItems(lineItems) {
  return lineItems.map(item => ({
    product_id: item.product_id,
    variation_id: item.variation_id || null,
    name: item.name,
    sku: item.sku || "",
    quantity: Number(item.quantity),
    unit_price: Number(item.price),
    subtotal: Number(item.subtotal),
    total: Number(item.total),
    tax: Number(item.total_tax || 0),
  }));
}