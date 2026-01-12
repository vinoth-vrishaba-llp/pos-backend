import cron from "node-cron";
import * as woo from "./woo.service.js";
import * as base from "./baserow.service.js";
import { normalizeOrderForBaserow, isPosOrder } from "./orderUtils.js"; // ✅ Added isPosOrder import

/**
 * Sync recent WooCommerce orders to Baserow
 * Runs every 1 minute
 * ✅ FIXED: Only syncs orders with _pos_order flag
 */
async function syncRecentOrders() {
  try {
    console.log("[CRON] Syncing recent orders...");

    // Fetch recent orders from WooCommerce
    const recentOrders = await woo.fetchRecentOrders();

    console.log(`[CRON] Found ${recentOrders.length} recent orders`);

    let syncedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Sync each order to Baserow
    for (const wooOrder of recentOrders) {
  try {
    console.log(`\n[DEBUG] Checking order #${wooOrder.number}`);
    console.log(`[DEBUG] meta_data:`, wooOrder.meta_data);
    
    const isPOS = isPosOrder(wooOrder);
    console.log(`[DEBUG] isPosOrder result: ${isPOS}`);
    
    if (!isPOS) {
      skippedCount++;
      console.log(`[CRON] ⏭️  Skipped order #${wooOrder.number} - not a POS order`);
      continue;
    }

        // Normalize with skipPosCheck=true since we already checked
        const normalized = normalizeOrderForBaserow(wooOrder, true);

        if (!normalized) {
          errorCount++;
          console.error(`[CRON] Failed to normalize order ${wooOrder.id}`);
          continue;
        }

        const result = await base.upsertOrder(normalized);

        if (result.ok) {
          syncedCount++;
          console.log(`[CRON] ✅ Synced order #${wooOrder.number} (${result.action})`);
        } else {
          errorCount++;
          console.error(`[CRON] Failed to sync order ${wooOrder.id}`);
        }
      } catch (err) {
        errorCount++;
        console.error(`[CRON] Error syncing order ${wooOrder.id}:`, err.message);
      }
    }

    console.log(
      `[CRON] Order sync complete: ${syncedCount} synced, ${skippedCount} skipped (WordPress), ${errorCount} errors`
    );
  } catch (err) {
    console.error("[CRON] Order sync failed:", err.message);
  }
}

/**
 * Sync recent WooCommerce customers to Baserow
 * Runs every 1 minute
 * ✅ FIXED: Now passes full WooCommerce customer object to preserve meta_data
 */
async function syncRecentCustomers() {
  try {
    console.log("[CRON] Syncing recent customers...");

    // Fetch recent customers from WooCommerce (last 50)
    const recentCustomers = await woo.fetchCustomers({
      per_page: 50,
      orderby: "registered_date",
      order: "desc",
    });

    console.log(`[CRON] Found ${recentCustomers.length} recent customers`);

    let syncedCount = 0;
    let errorCount = 0;

    // Sync each customer to Baserow
    for (const wooCustomer of recentCustomers) {
      try {
        // ✅ Pass the full WooCommerce customer object directly
        // The sanitizeCustomerPayload function will handle the transformation
        // and extract meta_data (including customer_type)
        await base.upsertCustomer(wooCustomer);
        syncedCount++;
        console.log(`[CRON] ✅ Synced customer ${wooCustomer.id}`);
      } catch (err) {
        errorCount++;
        console.error(
          `[CRON] Error syncing customer ${wooCustomer.id}:`,
          err.message
        );
      }
    }

    console.log(
      `[CRON] Customer sync complete: ${syncedCount} synced, ${errorCount} errors`
    );
  } catch (err) {
    console.error("[CRON] Customer sync failed:", err.message);
  }
}

/**
 * Start all cron jobs
 */
export function startCronJobs() {
  // Sync orders every 5 minutes
  cron.schedule("*/5 * * * *", syncRecentOrders);

  // Sync customers every 1 minute
  cron.schedule("*/1 * * * *", syncRecentCustomers);

  console.log("✅ Cron jobs started");
  console.log("   - Order sync: Every 1 minute (POS orders only)");
  console.log("   - Customer sync: Every 1 minute");
}

/**
 * Run sync immediately (useful for testing)
 */
export function runSyncNow() {
  console.log("\n🚀 Running manual sync...\n");
  syncRecentOrders();
  syncRecentCustomers();
}

// ✅ OPTIONAL: Run sync immediately on startup
// Uncomment if you want data synced when server starts
/*
setTimeout(() => {
  console.log("🔄 Running initial sync after server start...");
  syncRecentOrders();
  syncRecentCustomers();
}, 5000); // Wait 5s after server start
*/