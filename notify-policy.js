// notify-policy.js — single source of truth for notification category policy.
//
// Pure module: no imports, no env, no I/O — so it is safe to share between the
// serverless email functions (import "../notify-policy.js") and to mirror in the
// bundled app. It maps every notification category onto the EXISTING role ranks
// (engineer 1, buyer 2, manager 3; legacy "owner" -> manager) rather than inventing
// a parallel permission system, and declares each category's channel behaviour.
//
// Each category defines, per the platform's channel model:
//   inApp           : minimum role rank that SEES it in the notification centre
//   email.roles     : minimum role rank that may RECEIVE email
//   email.cadence   : "immediate" | "digest" | "off"   (default delivery)
//   email.mandatory : true => the user cannot turn this email off
//   group           : centre grouping + preferences section
//   channels        : future channels (push) — declared now, wired later
//
// Role mapping rationale (mirrors the app's `can`/VIEW_MIN_ROLE):
//   • Announcements & maintenance  -> everyone (rank 1); they affect all users.
//   • Billing / AI spend / usage / seats -> managers & owners (rank 3).
//   • Invoices, RFQ/quote/PO/hire activity, AI tasks -> buyer+ (rank 2),
//     matching who can already reach those features (sendRFQ/raisePO/viewCosts ≥ 2).
//   • Team activity & system alerts -> managers (rank 3), matching manageTeam.

export const ROLE_RANK = { engineer: 1, buyer: 2, manager: 3, owner: 3 };
export const rankOf = (role) => ROLE_RANK[String(role || "").toLowerCase()] || 1;

export const NOTIF_POLICY = {
  // --- Announcements (admin-authored; visible to everyone in a company) ---
  maintenance:  { label: "Planned maintenance", group: "Announcements",
                  inApp: 1, email: { roles: 1, cadence: "immediate", mandatory: true  }, channels: { push: "planned" } },
  announcement: { label: "Announcements",        group: "Announcements",
                  inApp: 1, email: { roles: 1, cadence: "immediate", mandatory: false }, channels: { push: "planned" } },
  release:      { label: "Product updates",      group: "Announcements",
                  inApp: 1, email: { roles: 1, cadence: "digest",    mandatory: false }, channels: { push: "planned" } },

  // --- Subscription & Usage (managers / account owners) ---
  billing:      { label: "Billing & subscription", group: "Subscription & Usage",
                  inApp: 3, email: { roles: 3, cadence: "immediate", mandatory: true  }, channels: { push: "planned" } },
  usage_cost:   { label: "AI spend",               group: "Subscription & Usage",
                  inApp: 3, email: { roles: 3, cadence: "digest",    mandatory: false }, channels: { push: "planned" } },
  usage:        { label: "Plan usage & limits",    group: "Subscription & Usage",
                  inApp: 3, email: { roles: 3, cadence: "digest",    mandatory: false }, channels: { push: "planned" } },

  // --- Activity (operational; follows existing feature permissions) ---
  invoice:      { label: "Invoices",                    group: "Activity",
                  inApp: 2, email: { roles: 2, cadence: "digest",    mandatory: false }, channels: { push: "planned" } },
  workflow:     { label: "RFQs, quotes, orders & hire", group: "Activity",
                  inApp: 2, email: { roles: 2, cadence: "digest",    mandatory: false }, channels: { push: "planned" } },
  process:      { label: "AI task results",             group: "Activity",
                  inApp: 2, email: { roles: 2, cadence: "digest",    mandatory: false }, channels: { push: "planned" } },
  team:         { label: "Team activity",               group: "Activity",
                  inApp: 3, email: { roles: 3, cadence: "digest",    mandatory: false }, channels: { push: "planned" } },
  system:       { label: "System alerts",               group: "Activity",
                  inApp: 3, email: { roles: 3, cadence: "immediate", mandatory: false }, channels: { push: "planned" } },
};

export const DEFAULT_POLICY = {
  label: "Notifications", group: "Activity",
  inApp: 1, email: { roles: 1, cadence: "off", mandatory: false }, channels: { push: "planned" },
};
export const policyFor = (category) => NOTIF_POLICY[category] || DEFAULT_POLICY;

// Visible in-app? An optional per-announcement min_role can RAISE the floor
// ("company-specific messages visible to all unless explicitly restricted").
export function canSeeInApp(category, role, minRole) {
  const need = Math.max(policyFor(category).inApp, minRole ? rankOf(minRole) : 0);
  return rankOf(role) >= need;
}

// Should this user receive EMAIL for this category?
// prefs: { [category]: boolean } — absent => cadence default (ON); mandatory => always ON.
export function emailEligible(category, role, prefs, minRole) {
  const e = policyFor(category).email;
  if (e.cadence === "off") return false;
  const need = Math.max(e.roles, minRole ? rankOf(minRole) : 0);
  if (rankOf(role) < need) return false;
  if (e.mandatory) return true;
  const has = prefs && Object.prototype.hasOwnProperty.call(prefs, category);
  return has ? !!prefs[category] : true; // default ON for non-mandatory email categories
}

export const cadenceOf = (category) => policyFor(category).email.cadence;
