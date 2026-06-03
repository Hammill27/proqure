// Serverless function: proxies AI requests to OpenRouter using a central key.
// The key lives in the Vercel environment variable OPENROUTER_API_KEY and is
// never exposed to the browser. The app calls this endpoint instead of calling
// OpenRouter directly.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "AI is not configured on the server." });
  }

  try {
    const { messages, models, temperature } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Missing messages" });
    }

    const modelList = Array.isArray(models) && models.length ? models : [
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.1-8b-instruct",
      "mistralai/mistral-7b-instruct",
      "google/gemini-flash-1.5",
    ];

    let lastErr = "";
    for (const model of modelList) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
            "HTTP-Referer": "https://proqure.app",
            "X-Title": "ProQure",
          },
          body: JSON.stringify({ model, messages, temperature: typeof temperature === "number" ? temperature : 0.1 }),
        });
        const d = await r.json();
        if (d.error) { lastErr = d.error.message || "API error"; continue; }
        const text = d.choices?.[0]?.message?.content || "";
        if (text) return res.status(200).json({ text });
      } catch (e) {
        lastErr = e.message;
      }
    }
    return res.status(502).json({ error: "No models available: " + lastErr });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error" });
  }
}
