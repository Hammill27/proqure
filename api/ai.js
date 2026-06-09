// Serverless function: proxies AI requests to OpenRouter using a central key.
// The key lives in the Vercel environment variable OPENROUTER_API_KEY and is
// never exposed to the browser. The app calls this endpoint instead of calling
// OpenRouter directly.
//
// Web search (added for the O&M file generator): when the request body sets
//   web: true
// the request is run with OpenRouter's web plugin enabled (Exa-backed) so the
// model can ground its answer in live web results — used to locate manufacturer
// datasheets/literature. Web search is METERED on the OpenRouter account
// (billed per result), so it is OFF unless the caller explicitly asks for it.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "AI is not configured on the server." });
  }

  try {
    const { messages, models, temperature, web, maxResults, user } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Missing messages" });
    }

    // When web search is requested we need a tool/plugin-capable model. Flash-tier
    // Gemini handles the web plugin well and is cheap, so we prefer it for web
    // requests; otherwise use the caller's list (or the standard fallbacks).
    // Listed newest-first; the loop below falls through to the next if a slug has
    // been retired, so this keeps working when OpenRouter rotates model versions.
    // All are routed through OpenRouter - no other provider is used.
    const webModels = ["google/gemini-2.5-flash", "google/gemini-3.1-flash-lite"];
    const standardModels = [
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.1-8b-instruct",
      "mistralai/mistral-7b-instruct",
      "google/gemini-flash-1.5",
    ];
    const modelList = web
      ? (Array.isArray(models) && models.length ? models : webModels)
      : (Array.isArray(models) && models.length ? models : standardModels);

    // OpenRouter web plugin (Exa-backed). Default 4 results keeps cost low.
    const plugins = web
      ? [{ id: "web", max_results: Math.min(Math.max(parseInt(maxResults, 10) || 4, 1), 8) }]
      : undefined;

    let lastErr = "";
    for (const model of modelList) {
      try {
        const body = {
          model,
          messages,
          temperature: typeof temperature === "number" ? temperature : 0.1,
        };
        if (plugins) body.plugins = plugins;
        // Optional end-user/company tag for OpenRouter's own reporting.
        if (typeof user === "string" && user) body.user = user.slice(0, 128);
        // Ask OpenRouter to include usage accounting (cost) in the response.
        body.usage = { include: true };

        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
            "HTTP-Referer": "https://proqure.app",
            "X-Title": "ProQure",
          },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.error) { lastErr = d.error.message || "API error"; continue; }
        const msg = d.choices?.[0]?.message || {};
        const text = msg.content || "";
        // url_citation annotations carry the source URLs the web plugin found.
        const citations = (msg.annotations || [])
          .filter(a => a && (a.type === "url_citation" || a.url_citation))
          .map(a => (a.url_citation || a))
          .map(c => ({ url: c.url, title: c.title || "" }))
          .filter(c => c.url);
        if (text) {
          // Usage accounting: OpenRouter returns token counts and the actual
          // request cost (USD) in `usage`. We surface it so the app can record
          // per-company spend for the admin cost dashboard.
          const usage = d.usage || null;
          const cost = usage && usage.cost != null ? Number(usage.cost) : null;
          return res.status(200).json({ text, citations, usage, cost, model, web: !!web });
        }
      } catch (e) {
        lastErr = e.message;
      }
    }
    return res.status(502).json({ error: "No models available: " + lastErr });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
