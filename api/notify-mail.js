// api/notify-mail.js — branded, no-reply notification email.
//
// Informational notifications send from a dedicated no-reply address (not the
// quotes@/orders@ relay used for supplier RFQs), with ProQure's identity and
// colours so they feel native to the platform. Server-only: uses the service
// RESEND_API_KEY directly, so neither the browser nor send-email.js is involved.
//
// FROM must be a verified sender on the (already verified) proqure.co.uk domain.

export const NOTIFY_FROM = "ProQure <notifications@proqure.co.uk>";

const C = { green: "#15824F", greenDark: "#0E5C38", ink: "#1A1A17", body: "#33332E",
  mute: "#6B6A62", line: "#E7E6E0", wash: "#F6F6F3",
  type: { info: "#5B5BD6", success: "#1E9E63", warning: "#C77D2E", critical: "#D14343" } };

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function itemHtml(n) {
  const col = C.type[n.type] || C.type.info;
  const cta = (n.cta_label && n.cta_href)
    ? `<tr><td style="padding:10px 0 2px 0"><a href="${esc(n.cta_href)}" style="display:inline-block;background:${C.green};color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;padding:9px 16px;border-radius:8px">${esc(n.cta_label)} &rarr;</a></td></tr>`
    : "";
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0">
    <tr>
      <td width="4" style="background:${col};border-radius:3px">&nbsp;</td>
      <td style="padding:0 0 0 14px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;color:${C.ink}">${esc(n.title)}</td></tr>
          ${n.body ? `<tr><td style="font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;color:${C.mute};padding-top:3px;line-height:1.5">${esc(n.body)}</td></tr>` : ""}
          ${cta}
        </table>
      </td>
    </tr>
  </table>`;
}

// items: [{ type, title, body, cta_label?, cta_href? }]
export function renderNotificationEmail({ heading, intro, items, companyName }) {
  const wordmark = `<span style="font-family:'Segoe UI',Arial,sans-serif;font-weight:800;font-size:20px;color:#ffffff;letter-spacing:-.01em">Pro<span style="color:#BDEBD2">Qure</span></span>`;
  const rows = (items || []).map(itemHtml).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:${C.wash}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.wash};padding:24px 0">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:14px;overflow:hidden">
          <tr><td style="background:${C.green};padding:18px 28px">${wordmark}</td></tr>
          <tr><td style="padding:26px 28px 8px 28px">
            <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:18px;font-weight:800;color:${C.ink};margin:0 0 4px 0">${esc(heading)}</div>
            ${intro ? `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;color:${C.mute};margin:0 0 18px 0;line-height:1.5">${esc(intro)}</div>` : `<div style="height:10px"></div>`}
            ${rows}
          </td></tr>
          <tr><td style="padding:8px 28px 24px 28px">
            <div style="border-top:1px solid ${C.line};padding-top:14px;font-family:'Segoe UI',Arial,sans-serif;font-size:11.5px;color:#90908A;line-height:1.6">
              This is an automated notification from ProQure${companyName ? ` for ${esc(companyName)}` : ""}. Please don&rsquo;t reply to this email &mdash; it&rsquo;s sent from an unmonitored address. You can manage which notifications you receive by email from the bell &rarr; preferences in ProQure.
            </div>
          </td></tr>
        </table>
        <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#B0AFA6;padding:14px 0">Sent with ProQure &middot; app.proqure.co.uk</div>
      </td></tr>
    </table>
  </body></html>`;
}

// Send via Resend from the no-reply address (no reply_to). Returns {ok, id?|error?}.
export async function sendMail({ to, subject, html, companyId }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };
  const toList = Array.isArray(to) ? to : [to];
  if (!toList.length) return { ok: true, skipped: true };
  const payload = { from: NOTIFY_FROM, to: toList, subject, html };
  if (companyId && typeof companyId === "string") {
    const v = companyId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    if (v) payload.tags = [{ name: "company_id", value: v }, { name: "kind", value: "notification" }];
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (d && d.message) || `Resend ${r.status}` };
    return { ok: true, id: d && d.id };
  } catch (e) { return { ok: false, error: (e && e.message) || "send failed" }; }
}
