/**
 * Cleanup Script: Remove Non-POS Orders from Baserow
 * 
 * This script:
 * 1. Fetches all orders from Baserow
 * 2. Checks each order in WooCommerce for _pos_order flag
 * 3. Deletes orders that are NOT POS orders
 * 
 * Run with: node cleanup-non-pos-orders.js
 */

import "./env.js";
import * as woo from "./woo.service.js";
import * as base from "./baserow.service.js";
import axios from "axios";

async function cleanupNonPosOrders(dryRun = true) {
  //console.log("🧹 Starting cleanup of non-POS orders from Baserow...\n");
  
  if (dryRun) {
    //console.log("⚠️  DRY RUN MODE - No deletions will be made");
    //console.log("   Set dryRun=false to actually delete orders\n");
  }

  let checkedCount = 0;
  let posOrdersCount = 0;
  let nonPosOrdersCount = 0;
  let deletedCount = 0;
  let errorCount = 0;
  let page = 1;
  const limit = 50;
  let hasMore = true;

  const nonPosOrders = [];

  while (hasMore) {
    try {
      console.log(`📦 Fetching page ${page}...`);
      const { results, next } = await base.getOrders({ page, limit });

      if (!results || results.length === 0) {
        hasMore = false;
        break;
      }

      console.log(`   Found ${results.length} orders`);

      for (const baserowOrder of results) {
        try {
          checkedCount++;
          const wooOrderId = baserowOrder.woo_order_id;

          if (!wooOrderId) {
            console.log(`   ⚠️  Order ${baserowOrder.order_number} - no woo_order_id`);
            errorCount++;
            continue;
          }

          // Fetch from WooCommerce to check POS flag
          console.log(`   🔍 Checking order #${baserowOrder.order_number} (Woo ID: ${wooOrderId})`);
          
          const wooOrder = await woo.fetchOrder(wooOrderId);

          // Check for _pos_order flag
          const hasPosFlag = wooOrder.meta_data?.some(m => m.key === "_pos_order" && m.value === "yes");

          if (hasPosFlag) {
            console.log(`      ✅ POS order - keeping`);
            posOrdersCount++;
          } else {
            console.log(`      ❌ NOT a POS order`);
            nonPosOrdersCount++;
            
            nonPosOrders.push({
              baserow_id: baserowOrder.id,
              order_number: baserowOrder.order_number,
              woo_order_id: wooOrderId,
              total: baserowOrder.total,
              created_at: baserowOrder.created_at,
            });

            if (!dryRun) {
              try {
                console.log(`      🗑️  Deleting from Baserow...`);
                await deleteBaserowOrder(baserowOrder.id);
                deletedCount++;
                console.log(`      ✅ Deleted`);
              } catch (delErr) {
                console.error(`      ❌ Failed to delete:`, delErr.message);
                errorCount++;
              }
            }
          }

          // Rate limiting
          await sleep(200);

        } catch (err) {
          console.error(`   ❌ Error checking order:`, err.message);
          errorCount++;
        }
      }

      hasMore = !!next;
      page++;

    } catch (err) {
      console.error(`❌ Failed to fetch page ${page}:`, err.message);
      break;
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("🧹 CLEANUP COMPLETE");
  console.log("=".repeat(70));
  console.log(`📊 Total orders checked: ${checkedCount}`);
  console.log(`✅ POS orders (kept): ${posOrdersCount}`);
  console.log(`❌ Non-POS orders found: ${nonPosOrdersCount}`);
  
  if (dryRun) {
    console.log(`\n⚠️  DRY RUN - No deletions made`);
  } else {
    console.log(`🗑️  Orders deleted: ${deletedCount}`);
  }
  
  console.log(`⚠️  Errors: ${errorCount}`);
  console.log("=".repeat(70));

  if (nonPosOrders.length > 0) {
    console.log("\n📋 Non-POS Orders Found:");
    console.log("=".repeat(70));
    nonPosOrders.forEach(order => {
      console.log(`Order #${order.order_number} (Woo: ${order.woo_order_id}, Baserow: ${order.baserow_id})`);
      console.log(`  Total: ₹${order.total}, Created: ${order.created_at}`);
    });
    console.log("=".repeat(70));

    if (dryRun) {
      console.log("\n💡 To delete these orders, edit the script and change:");
      console.log("   cleanupNonPosOrders(true) → cleanupNonPosOrders(false)");
    }
  }
}

/**
 * Delete a single order from Baserow
 */
async function deleteBaserowOrder(baserowId) {
  const TABLE_ID = process.env.BASEROW_ORDERS_TABLE_ID;
  const url = `${process.env.BASEROW_BASE_URL}/database/rows/table/${TABLE_ID}/${baserowId}/`;
  
  await axios.delete(url, {
    headers: {
      Authorization: `Token ${process.env.BASEROW_TOKEN}`,
    },
  });
}

/**
 * Quick check - see how many non-POS orders exist
 */
async function quickCount() {
  console.log("🔍 Quick count of non-POS orders...\n");

  let posCount = 0;
  let nonPosCount = 0;
  let errorCount = 0;
  let page = 1;
  const limit = 50;
  let hasMore = true;

  while (hasMore) {
    try {
      const { results, next } = await base.getOrders({ page, limit });

      if (!results || results.length === 0) {
        break;
      }

      for (const baserowOrder of results) {
        if (!baserowOrder.woo_order_id) {
          errorCount++;
          continue;
        }

        try {
          const wooOrder = await woo.fetchOrder(baserowOrder.woo_order_id);
          const hasPosFlag = wooOrder.meta_data?.some(m => m.key === "_pos_order" && m.value === "yes");

          if (hasPosFlag) {
            posCount++;
          } else {
            nonPosCount++;
          }

          await sleep(200);

        } catch (err) {
          errorCount++;
        }
      }

      hasMore = !!next;
      page++;
      console.log(`Checked page ${page - 1}... POS: ${posCount}, Non-POS: ${nonPosCount}`);

    } catch (err) {
      break;
    }
  }

  console.log("\n📊 Summary:");
  console.log(`   ✅ POS orders: ${posCount}`);
  console.log(`   ❌ Non-POS orders: ${nonPosCount}`);
  console.log(`   ⚠️  Errors: ${errorCount}`);
  console.log(`   📊 Total: ${posCount + nonPosCount}`);
}

/**
 * Delete specific orders by Baserow ID
 */
async function deleteSpecificOrders(baserowIds) {
  console.log(`🗑️  Deleting ${baserowIds.length} specific orders...\n`);

  let deletedCount = 0;
  let errorCount = 0;

  for (const baserowId of baserowIds) {
    try {
      console.log(`   Deleting Baserow order ${baserowId}...`);
      await deleteBaserowOrder(baserowId);
      deletedCount++;
      console.log(`   ✅ Deleted`);
      await sleep(100);
    } catch (err) {
      console.error(`   ❌ Failed:`, err.message);
      errorCount++;
    }
  }

  console.log(`\n✅ Deleted: ${deletedCount}`);
  console.log(`❌ Errors: ${errorCount}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================
   AUTO-RUN
========================= */

// ✅ UNCOMMENT ONE OF THESE TO RUN:

// 1. Dry run - see what would be deleted (SAFE)
cleanupNonPosOrders(false);

// 2. Quick count only (faster, just counts)
// quickCount();

// 3. Actually delete non-POS orders (CAREFUL!)
// cleanupNonPosOrders(false);

// 4. Delete specific orders by Baserow ID
// deleteSpecificOrders([168]);