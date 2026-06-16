// ============================================================================
// Feature-access framework — single source of truth.
//
// Each product feature is declared ONCE here. Access resolves in two layers:
//   1. Per-plan default   — `plans` (true = every plan, or a { plan: true } map)
//   2. Per-tenant override — settings.featureFlags = { [key]: "on" | "off" }
//      ("default" or absent  => fall back to the plan default)
//
// The end-user app mirrors this list inline (it bundles separately) and gates UI
// on featureEnabled(); api/admin-metrics.js imports FEATURE_LIST to send the
// registry to the admin console, and writes overrides via the `set-flags` action.
//
// EXTENSIBLE: add a feature by adding one entry below. Nothing else is hardcoded.
// ============================================================================

export const PLANS = ["trial", "sole", "team", "business", "enterprise"];

export const FEATURES = {
  // --- Product modules ---
  catalogues:         { label: "Supplier Catalogues", group: "Modules",   plans: true },
  om_generator:       { label: "O&M Generator",        group: "Modules",   plans: true },
  measure:            { label: "Measure",              group: "Modules",   plans: true },
  hire:               { label: "Hire",                 group: "Modules",   plans: true },
  quick_po:           { label: "Quick PO",             group: "Modules",   plans: true },
  // --- Platform capabilities ---
  ai:                 { label: "AI features",          group: "Platform",  plans: true },
  integrations:       { label: "Integrations",         group: "Platform",  plans: { business: true, enterprise: true } },
  advanced_reporting: { label: "Advanced reporting",   group: "Platform",  plans: true },
  export:             { label: "Export functionality", group: "Platform",  plans: true },
};

// Serializable, ordered list for the admin UI (preserves declaration order).
export const FEATURE_LIST = Object.keys(FEATURES).map(key => ({ key, ...FEATURES[key] }));

// Whether a feature is ON by default for a given plan (before any tenant override).
export function planDefault(key, plan) {
  const f = FEATURES[key];
  if (!f) return false;
  if (f.plans === true) return true;
  if (f.plans && typeof f.plans === "object") return !!f.plans[plan];
  return false;
}

// Effective access for a tenant: override wins, else plan default.
// overrides: { [key]: "on" | "off" | "default" }
export function featureEnabled(key, plan, overrides) {
  const ov = overrides && overrides[key];
  if (ov === "on" || ov === true) return true;
  if (ov === "off" || ov === false) return false;
  return planDefault(key, plan);
}

// Resolve every feature for a tenant -> { [key]: boolean }
export function resolveFeatures(plan, overrides) {
  const out = {};
  for (const key of Object.keys(FEATURES)) out[key] = featureEnabled(key, plan, overrides);
  return out;
}
