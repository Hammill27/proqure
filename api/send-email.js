// Serverless function: sends email via Resend using a central API key.
// The key lives in the Vercel environment variable RESEND_API_KEY and is never
// exposed to the browser.
//
// Supports the decided email model:
//   from      - "Display Name <quotes@proqure.co.uk>" (ProQure domain, business display name)
//   reply_to  - the user's own inbox, so supplier replies reach them
//   html      - the branded ProQure email template (falls back to text if absent)
//
// NOTE: the "from" domain (proqure.co.uk) must be verified in Resend to deliver.

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { to, subject, text, html, from, reply_to } = req.body || {};

  if (!from || !to || !subject) {
    return res.status(400).json({ error: "Missing from, to, or subject" });
  }

  try {
    // Build payload; only include optional fields when present.
    const payload = {
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
    };
    if (text) payload.text = text;
    if (html) payload.html = html;
    if (reply_to) payload.reply_to = reply_to;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || "Resend error" });
    }
    return res.status(200).json({ id: data.id, success: true });
  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: err.message });
  }
}
