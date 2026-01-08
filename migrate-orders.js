/**
 * Migration Script: Fix Existing Baserow Orders
 * 
 * This script:
 * 1. Fetches all orders from Baserow
 * 2. For each order, fetches fresh data from WooCommerce
 * 3. Re-normalizes with correct field mapping
 * 4. Updates Baserow with fixed data
 * 
 * Run with: node migrate-orders.js
 */

import "./env.js";
import * as woo from "./woo.service.js";
import * as base from "./baserow.service.js";
import { normalizeOrderForBaserow } from "./orderUtils.js";

async function migrateOrders() {
  console.log("🚀 Starting Baserow order migration...\n");

  let migratedCount = 0;
  let failedCount = 0;
  let page = 1;
  const limit = 50;
  let hasMore = true;

  while (hasMore) {
    try {
      // Fetch orders from Baserow
      console.log(`📦 Fetching page ${page}...`);
      const { results, next } = await base.getOrders({ page, limit });

      if (!results || results.length === 0) {
        hasMore = false;
        break;
      }

      console.log(`   Found ${results.length} orders`);

      // Process each order
      for (const baserowOrder of results) {
        try {
          const wooOrderId = baserowOrder.woo_order_id;

          if (!wooOrderId) {
            console.log(`   ⚠️  Skipping order ${baserowOrder.id} - no woo_order_id`);
            failedCount++;
            continue;
          }

          // Fetch fresh data from WooCommerce
          console.log(`   🔄 Migrating order #${baserowOrder.order_number} (Woo ID: ${wooOrderId})`);
          
          const wooOrder = await woo.fetchOrder(wooOrderId);

          // Re-normalize with correct mapping
          const normalized = normalizeOrderForBaserow(wooOrder);

          console.log(`   📅 Timestamps - Created: ${normalized.created_at}, Updated: ${normalized.updated_at}`);

          // Update in Baserow
          const result = await base.upsertOrder(normalized);

          if (result.ok) {
            console.log(`   ✅ Migrated order #${baserowOrder.order_number}`);
            migratedCount++;
          } else {
            console.log(`   ❌ Failed to migrate order #${baserowOrder.order_number}`);
            failedCount++;
          }

          // Rate limiting - wait 100ms between requests
          await sleep(100);

        } catch (err) {
          console.error(`   ❌ Error migrating order:`, err.message);
          failedCount++;
        }
      }

      // Check if there are more pages
      hasMore = !!next;
      page++;

    } catch (err) {
      console.error(`❌ Failed to fetch page ${page}:`, err.message);
      break;
    }
  }

  console.log("\n✨ Migration complete!");
  console.log(`   ✅ Migrated: ${migratedCount}`);
  console.log(`   ❌ Failed: ${failedCount}`);
  console.log(`   📊 Total: ${migratedCount + failedCount}`);
}

/**
 * Fix specific orders by WooCommerce ID
 * Useful for spot-fixing problematic orders
 */
async function fixSpecificOrders(wooOrderIds) {
  console.log(`🔧 Fixing ${wooOrderIds.length} specific orders...\n`);

  let fixedCount = 0;
  let failedCount = 0;

  for (const wooOrderId of wooOrderIds) {
    try {
      console.log(`   🔄 Fixing order ${wooOrderId}...`);

      // Fetch from WooCommerce
      const wooOrder = await woo.fetchOrder(wooOrderId);

      // Normalize
      const normalized = normalizeOrderForBaserow(wooOrder);

      // Upsert to Baserow
      const result = await base.upsertOrder(normalized);

      if (result.ok) {
        console.log(`   ✅ Fixed order ${wooOrderId}`);
        fixedCount++;
      } else {
        console.log(`   ❌ Failed to fix order ${wooOrderId}`);
        failedCount++;
      }

      await sleep(100);

    } catch (err) {
      console.error(`   ❌ Error fixing order ${wooOrderId}:`, err.message);
      failedCount++;
    }
  }

  console.log("\n✨ Fix complete!");
  console.log(`   ✅ Fixed: ${fixedCount}`);
  console.log(`   ❌ Failed: ${failedCount}`);
}

/**
 * Validate all orders in Baserow
 * Checks for missing/invalid fields without updating
 */
async function validateOrders() {
  console.log("🔍 Validating Baserow orders...\n");

  const issues = {
    missing_woo_id: [],
    invalid_status: [],
    missing_items: [],
    invalid_discount: [],
    missing_charges: [],
  };

  let page = 1;
  const limit = 50;
  let hasMore = true;
  let totalChecked = 0;

  while (hasMore) {
    try {
      const { results, next } = await base.getOrders({ page, limit });

      if (!results || results.length === 0) {
        hasMore = false;
        break;
      }

      for (const order of results) {
        totalChecked++;

        // Check woo_order_id
        if (!order.woo_order_id) {
          issues.missing_woo_id.push(order.order_number);
        }

        // Check status - ✅ UPDATED: Added "refund"
        const validStatuses = ["paid", "completed", "cancelled", "refund"];
        if (!validStatuses.includes(order.status)) {
          issues.invalid_status.push({
            order: order.order_number,
            status: order.status,
          });
        }

        // Check items
        if (!order.items || order.items === "[]") {
          issues.missing_items.push(order.order_number);
        }

        // Check discount consistency
        if (order.discount_amount > 0 && !order.discount_type) {
          issues.invalid_discount.push({
            order: order.order_number,
            amount: order.discount_amount,
          });
        }

        // Check if charges exist but are 0
        const hasChargeFields = 
          order.alteration_charge !== undefined &&
          order.courier_charge !== undefined &&
          order.other_charge !== undefined;

        if (!hasChargeFields) {
          issues.missing_charges.push(order.order_number);
        }
      }

      hasMore = !!next;
      page++;

    } catch (err) {
      console.error(`❌ Failed to fetch page ${page}:`, err.message);
      break;
    }
  }

  console.log(`\n📊 Validation Results (${totalChecked} orders checked):\n`);
  
  console.log(`❌ Missing woo_order_id: ${issues.missing_woo_id.length}`);
  if (issues.missing_woo_id.length > 0) {
    console.log(`   Orders: ${issues.missing_woo_id.join(", ")}`);
  }

  console.log(`\n❌ Invalid status: ${issues.invalid_status.length}`);
  if (issues.invalid_status.length > 0) {
    issues.invalid_status.forEach(i => {
      console.log(`   Order ${i.order}: "${i.status}"`);
    });
  }

  console.log(`\n❌ Missing items: ${issues.missing_items.length}`);
  if (issues.missing_items.length > 0) {
    console.log(`   Orders: ${issues.missing_items.slice(0, 10).join(", ")}`);
    if (issues.missing_items.length > 10) {
      console.log(`   ... and ${issues.missing_items.length - 10} more`);
    }
  }

  console.log(`\n⚠️  Discount without type: ${issues.invalid_discount.length}`);
  if (issues.invalid_discount.length > 0) {
    issues.invalid_discount.slice(0, 5).forEach(i => {
      console.log(`   Order ${i.order}: ₹${i.amount}`);
    });
  }

  console.log(`\n⚠️  Missing charge fields: ${issues.missing_charges.length}`);

  const totalIssues = 
    issues.missing_woo_id.length +
    issues.invalid_status.length +
    issues.missing_items.length +
    issues.invalid_discount.length +
    issues.missing_charges.length;

  if (totalIssues === 0) {
    console.log("\n✅ All orders are valid!");
  } else {
    console.log(`\n⚠️  Total issues found: ${totalIssues}`);
    console.log("\nRun migrateOrders() to fix these issues.");
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   USAGE EXAMPLES
========================= */

// Migrate all orders
// migrateOrders();

// Fix specific orders
// fixSpecificOrders([12345, 12346, 12347]);

// Validate without updating
// validateOrders();

// Export for use
export { migrateOrders, fixSpecificOrders, validateOrders };