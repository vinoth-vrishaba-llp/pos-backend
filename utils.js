export function normalizeProduct(p) {
  // 🔑 Extract HR FMS components from product meta
  const fmsMeta = p.meta_data?.find(
    m => m.key === "_hr_fms_components"
  );

  return {
    id: p.id,
    name: p.name,
    sku: p.sku || null,
    type: p.type,
    price: p.price ? Number(p.price) : null,

    stock_status: p.stock_status,
    stock_quantity:
      p.manage_stock === true
        ? p.stock_quantity
        : null,

    image: p.images?.[0]?.thumbnail || null,

    categories: p.categories.map(c => ({
      id: c.id,
      name: c.name,
      slug: c.slug
    })),

    attributes: p.attributes.map(a => ({
      name: a.name,
      options: a.options,
    })),

    // ✅ THIS IS THE MISSING PIECE
    fms_components: Array.isArray(fmsMeta?.value)
      ? fmsMeta.value
      : [],

    purchasable: p.purchasable,
  };
}
