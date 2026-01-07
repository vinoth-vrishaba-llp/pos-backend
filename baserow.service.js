//backend/baserow.service.js
import axios from "axios";
import axiosRetry from "axios-retry";

const base = axios.create({
  baseURL: process.env.BASEROW_BASE_URL,
  headers: {
    Authorization: `Token ${process.env.BASEROW_TOKEN}`,
  },
});

axiosRetry(base, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    error.response?.status >= 500,
});

/* =========================
   ORDERS
========================= */

/**
 * Get paginated orders from Baserow
 */
export async function getOrders({ page = 1, limit = 20 }) {
  try {
    const { data } = await base.get(
      `/database/rows/table/${process.env.BASEROW_ORDERS_TABLE_ID}/`,
      {
        params: {
          page,
          size: limit,
          user_field_names: true,
          order_by: "-created_at",
        },
      }
    );
    return data;
  } catch (err) {
    console.error("[BASEROW GET ORDERS FAILED]", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Get single order by WooCommerce order ID
 */
export async function getOrderByWooId(wooOrderId) {
  try {
    const { data } = await base.get(
      `/database/rows/table/${process.env.BASEROW_ORDERS_TABLE_ID}/`,
      {
        params: {
          filter__woo_order_id__equal: wooOrderId,
          user_field_names: true,
        },
      }
    );
    return data.results?.[0] || null;
  } catch (err) {
    console.error("[BASEROW GET ORDER FAILED]", {
      woo_order_id: wooOrderId,
      error: err.response?.data || err.message,
    });
    return null;
  }
}

/**
 * Upsert order to Baserow with schema validation
 */
export async function upsertOrder(order) {
  try {
    const TABLE_ID = process.env.BASEROW_ORDERS_TABLE_ID;
    if (!TABLE_ID) {
      throw new Error("BASEROW_ORDERS_TABLE_ID missing in environment");
    }

    validateOrderSchema(order);
    const sanitized = sanitizeOrderPayload(order);
    const existing = await getOrderByWooId(order.woo_order_id);

    if (existing) {
      const { data } = await base.patch(
        `/database/rows/table/${TABLE_ID}/${existing.id}/`,
        sanitized,
        { params: { user_field_names: true } }
      );
      return { ok: true, data, action: "updated" };
    } else {
      const { data } = await base.post(
        `/database/rows/table/${TABLE_ID}/`,
        sanitized,
        { params: { user_field_names: true } }
      );
      return { ok: true, data, action: "created" };
    }
  } catch (err) {
    console.error("[BASEROW UPSERT FAILED]", err.response?.data || err.message);
    return { ok: false, error: err };
  }
}

/**
 * Patch order status only (for order completion)
 */
export async function patchOrderStatus(wooOrderId, status) {
  try {
    const existing = await getOrderByWooId(wooOrderId);
    if (!existing) return null;

    const STATUS_MAP = {
      completed: "completed",
      cancelled: "cancelled",
      processing: "paid",
      pending: "paid",
      "on-hold": "paid",
    };

    const payload = {
      status: STATUS_MAP[status] || existing.status,
      updated_at: new Date().toISOString(),
    };

    const { data } = await base.patch(
      `/database/rows/table/${process.env.BASEROW_ORDERS_TABLE_ID}/${existing.id}/`,
      payload,
      { params: { user_field_names: true } }
    );

    return data;
  } catch (err) {
    console.error("[BASEROW PATCH STATUS FAILED]", {
      woo_order_id: wooOrderId,
      error: err.response?.data || err.message,
    });
    throw err;
  }
}

/* =========================
   VALIDATION & SANITIZATION
========================= */

function validateOrderSchema(order) {
  const required = ["woo_order_id", "order_number", "status", "total"];
  const missing = required.filter(field => !order[field]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(", ")}`);
  }

  const validStatuses = ["paid", "completed", "cancelled"];
  if (!validStatuses.includes(order.status)) {
    throw new Error(`Invalid status: ${order.status}. Must be one of: ${validStatuses.join(", ")}`);
  }
}

function sanitizeOrderPayload(order) {
  return {
    woo_order_id: Number(order.woo_order_id),
    order_number: String(order.order_number),
    status: order.status,
    total: Number(order.total) || 0,
    payment_method: order.payment_method || "unknown",
    customer_id: order.customer_id && order.customer_id > 0 
      ? Number(order.customer_id) 
      : null,
    notes: order.notes || "",
    measurements: order.measurements || "-",
    order_type: order.order_type || "Normal Sale",
    items: typeof order.items === "string" 
      ? order.items 
      : JSON.stringify(order.items || []),
    created_at: order.created_at || new Date().toISOString(),
    updated_at: order.updated_at || new Date().toISOString(),
    discount_type: order.discount_type || null,
    discount_amount: Number(order.discount_amount) || 0,
    alteration_charge: Number(order.alteration_charge) || 0,
    courier_charge: Number(order.courier_charge) || 0,
    other_charge: Number(order.other_charge) || 0,
  };
}

/* =========================
   CUSTOMERS
========================= */

export async function getCustomers({ page = 1, limit = 20 }) {
  try {
    const { data } = await base.get(
      `/database/rows/table/${process.env.BASEROW_CUSTOMERS_TABLE_ID}/`,
      {
        params: {
          page,
          size: limit,
          user_field_names: true,
          order_by: "-created_at",
        },
      }
    );
    return data;
  } catch (err) {
    console.error("[BASEROW GET CUSTOMERS FAILED]", err.response?.data || err.message);
    throw err;
  }
}

export async function getCustomerById(id) {
  try {
    const { data } = await base.get(
      `/database/rows/table/${process.env.BASEROW_CUSTOMERS_TABLE_ID}/${id}/`,
      {
        params: {
          user_field_names: true,
        },
      }
    );
    return data;
  } catch (err) {
    console.error("[BASEROW GET CUSTOMER BY ID FAILED]", {
      id,
      error: err.response?.data || err.message,
    });
    return null;
  }
}

export async function getCustomerByWooId(wooCustomerId) {
  try {
    const { data } = await base.get(
      `/database/rows/table/${process.env.BASEROW_CUSTOMERS_TABLE_ID}/`,
      {
        params: {
          filter__woo_customer_id__equal: wooCustomerId,
          user_field_names: true,
        },
      }
    );
    return data.results?.[0] || null;
  } catch (err) {
    console.error("[BASEROW GET CUSTOMER BY WOO ID FAILED]", {
      woo_customer_id: wooCustomerId,
      error: err.response?.data || err.message,
    });
    return null;
  }
}

export async function findCustomerByPhone(phone) {
  try {
    const { data } = await base.get(
      `/database/rows/table/${process.env.BASEROW_CUSTOMERS_TABLE_ID}/`,
      {
        params: {
          filter__phone__equal: phone,
          user_field_names: true,
        },
      }
    );
    return data.results?.[0] || null;
  } catch (err) {
    console.error("[BASEROW FIND CUSTOMER BY PHONE FAILED]", {
      phone,
      error: err.response?.data || err.message,
    });
    return null;
  }
}

export async function upsertCustomer(customer) {
  try {
    const TABLE_ID = process.env.BASEROW_CUSTOMERS_TABLE_ID;
    if (!TABLE_ID) {
      throw new Error("BASEROW_CUSTOMERS_TABLE_ID missing in environment");
    }

    const sanitized = sanitizeCustomerPayload(customer);
    const existing = sanitized.woo_customer_id 
      ? await getCustomerByWooId(sanitized.woo_customer_id)
      : null;

    if (existing) {
      const { data } = await base.patch(
        `/database/rows/table/${TABLE_ID}/${existing.id}/`,
        sanitized,
        { params: { user_field_names: true } }
      );
      return data;
    } else {
      const { data } = await base.post(
        `/database/rows/table/${TABLE_ID}/`,
        sanitized,
        { params: { user_field_names: true } }
      );
      return data;
    }
  } catch (err) {
    console.error("[BASEROW CUSTOMER UPSERT FAILED]", {
      woo_customer_id: customer.woo_customer_id,
      error: err.response?.data || err.message,
    });
    throw err;
  }
}

export async function updateCustomer(id, updates) {
  try {
    const TABLE_ID = process.env.BASEROW_CUSTOMERS_TABLE_ID;
    const sanitized = sanitizeCustomerPayload(updates);
    
    const { data } = await base.patch(
      `/database/rows/table/${TABLE_ID}/${id}/`,
      sanitized,
      { params: { user_field_names: true } }
    );
    
    return data;
  } catch (err) {
    console.error("[BASEROW UPDATE CUSTOMER FAILED]", {
      id,
      error: err.response?.data || err.message,
    });
    throw err;
  }
}

export async function deleteCustomer(id) {
  try {
    const TABLE_ID = process.env.BASEROW_CUSTOMERS_TABLE_ID;
    await base.delete(`/database/rows/table/${TABLE_ID}/${id}/`);
    return true;
  } catch (err) {
    console.error("[BASEROW DELETE CUSTOMER FAILED]", {
      id,
      error: err.response?.data || err.message,
    });
    throw err;
  }
}

function sanitizeCustomerPayload(customer) {
  const billing = customer.billing || {};
  
  // Extract customer_type from meta_data
  let customerType = "Walk-in customer";
  if (customer.meta_data && Array.isArray(customer.meta_data)) {
    const typeMetaData = customer.meta_data.find(m => m.key === "customer_type");
    if (typeMetaData) {
      customerType = typeMetaData.value;
    }
  }
  
  const addressParts = [
    billing.address_1 || customer.address_1 || "",
    billing.address_2 || customer.address_2 || "",
    billing.city || customer.city || "",
    billing.state || customer.state || "",
    billing.postcode || customer.postcode || "",
    billing.country || customer.country || "",
  ].filter(Boolean);

  const sanitized = {
    first_name: customer.first_name || "",
    last_name: customer.last_name || "",
    phone: billing.phone || customer.phone || "",
    email: customer.email || billing.email || "",
    address: addressParts.length > 0 ? addressParts.join(", ") : "",
    address_line_2: billing.address_2 || customer.address_2 || "",
    city: billing.city || customer.city || "",
    state: billing.state || customer.state || "",
    postcode: billing.postcode || customer.postcode || "",
    country: billing.country || customer.country || "IN",
    customer_type: customerType,
    updated_at: new Date().toISOString(),
  };

  if (customer.woo_customer_id || customer.id) {
    sanitized.woo_customer_id = Number(customer.woo_customer_id || customer.id);
  }

  if (customer.created_at) {
    sanitized.created_at = customer.created_at;
  } else if (customer.date_created) {
    sanitized.created_at = customer.date_created;
  } else if (!customer.id && !customer.woo_customer_id) {
    sanitized.created_at = new Date().toISOString();
  }

  return sanitized;
}