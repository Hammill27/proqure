import { useState, useEffect, useRef, useCallback } from "react";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(typeof window!=="undefined"?window.innerWidth<768:false);
  useEffect(()=>{
    const fn = ()=>setIsMobile(window.innerWidth<768);
    window.addEventListener("resize",fn);
    return ()=>window.removeEventListener("resize",fn);
  },[]);
  return isMobile;
}

// --- Speech recognition hook -------------------------------------------------
function useSpeechRecognition({ onTranscript, onFinal }) {
  const recRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    setSupported(true);
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-GB";
    rec.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t + " "; else interim += t;
      }
      if (final) onFinal(final); else onTranscript(interim);
    };
    rec.onerror = () => setListening(false);
    rec.onend   = () => setListening(false);
    recRef.current = rec;
  }, []);
  const start = () => { if (recRef.current) { recRef.current.start(); setListening(true); } };
  const stop  = () => { if (recRef.current) { recRef.current.stop();  setListening(false); } };
  return { listening, supported, start, stop };
}

// --- Constants ----------------------------------------------------------------
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const RESEND_API    = "https://api.resend.com/emails";
const TRADES = ["Plumbing","HVAC","Electrical","Ventilation","Mechanical"];
const DEFAULT_SUPPLIERS = [
  { id:1, name:"Travis Perkins",         categories:["Plumbing","HVAC","Electrical"],  email:"quotes@travisperkins.co.uk" },
  { id:2, name:"Wolseley UK",             categories:["Plumbing","HVAC"],               email:"rfq@wolseley.co.uk" },
  { id:3, name:"Screwfix Trade",          categories:["Electrical","Plumbing"],         email:"trade@screwfix.com" },
  { id:4, name:"City Electrical Factors", categories:["Electrical"],                    email:"quotes@cef.co.uk" },
  { id:5, name:"Graham",                  categories:["HVAC","Plumbing","Ventilation"], email:"rfq@grahamplumbingheating.co.uk" },
];
const STATUS = {
  draft:    { bg:"var(--amber-light)",   text:"#854D0E",         label:"Draft" },
  pending:  { bg:"var(--indigo-light)",  text:"var(--indigo)",   label:"Pending quotes" },
  received: { bg:"#FAF5FF",             text:"#6B21A8",         label:"Quotes received" },
  approved: { bg:"var(--green-light)",   text:"var(--green-deep)",label:"Approved" },
};

// --- AI helpers ---------------------------------------------------------------
async function callAI(system, user, history=[]) {
  const key = window.__piq_or_key__ || "";
  if (!key) throw new Error("NO_KEY");
  const models = [
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.1-8b-instruct",
    "mistralai/mistral-7b-instruct",
    "google/gemini-flash-1.5",
  ];
  const messages = [
    {role:"system",content:system},
    ...history.slice(-8),
    {role:"user",content:user}
  ];
  let lastErr = "";
  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+key,"HTTP-Referer":"https://proquote.app","X-Title":"ProQuote"},
        body: JSON.stringify({ model, messages })
      });
      const d = await res.json();
      if (d.error) { lastErr = d.error.message||"API error"; continue; }
      const text = d.choices?.[0]?.message?.content || "";
      if (text) return text;
    } catch(e) { lastErr = e.message; }
  }
  throw new Error("No models available: "+lastErr);
}
async function parseMaterialList(raw) {
  const sys = `You are a procurement assistant for UK plumbing, HVAC, and electrical trades. Parse a material request into structured JSON. Return ONLY valid JSON, no markdown.
Format: {"items":[{"id":1,"description":"...","quantity":N,"unit":"...","category":"Plumbing|HVAC|Electrical|Ventilation|Mechanical","notes":"..."}],"jobRef":"...","urgency":"standard|urgent|next-day"}`;
  const txt = await callAI(sys, `Parse this material request: ${raw}`);
  try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); } catch { return null; }
}
async function generateRFQ(items, jobRef, company, contactName, fromEmail, deliveryMethod, deliveryDate, altAddress, rfqDeadline) {
  const sys = `You are a professional procurement system for a UK trades company. Generate a professional RFQ email body. Return ONLY the plain text email body, no subject line, no markdown. Sign off with the real contact name and company provided, no placeholder brackets.`;
  const list = items.map(i=>`- ${i.quantity} ${i.unit} ${i.description}`).join("\n");
  const deliveryLabels = {
    direct: "Delivery direct to site",
    alternative: `Delivery to alternative address: ${altAddress||"to be confirmed"}`,
    collect: "Collection from branch",
    tbc: "Delivery method to be confirmed"
  };
  const deliveryStr = deliveryLabels[deliveryMethod]||deliveryMethod;
  const dateStr = deliveryDate ? `Required by: ${deliveryDate}` : "Required date: To be confirmed";
  const deadlineStr = rfqDeadline ? `Please respond by: ${new Date(rfqDeadline).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}` : "";
  return callAI(sys,
    `Generate an RFQ email for ${company||"our company"}, job ref ${jobRef||"TBC"}, contact: ${contactName||"The Procurement Team"}, email: ${fromEmail||""}.\n\nItems required:\n${list}\n\nDelivery requirements:\n- Method: ${deliveryStr}\n- ${dateStr}\n${deadlineStr?"- "+deadlineStr:""}\n\nAsk for unit prices, availability, lead time, and please ask them to include carriage/delivery charges in their quotation. Keep it concise and professional. Clearly mention the delivery method and required date in the email.${deadlineStr?" Prominently include the response deadline.":""}`
  );
}
// --- Quote text pre-processor ------------------------------------------------
function preprocessQuoteText(raw) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(from|regards|thanks|sent from|dear|hi |hello|to:|cc:|subject:|date:).*/gim, "")
    .replace(/[^\x20-\x7E\n\u00A3\u20AC$]/g, " ")
    .trim();
}

// --- Parse price string to float ----------------------------------------------
function parsePrice(s) {
  if (!s || typeof s !== "string") return null;
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

// --- JavaScript post-processor - validates AI output -------------------------
function validateAndFix(analysis, requestedItems) {
  if (!analysis || analysis.error) return analysis;

  const warnings = [...(analysis.warnings||[])];
  const matched = (analysis.matched||[]).map(m => {
    let confidence = "high";
    const unitPrice = parsePrice(m.unitPrice);
    const requestedQty = parseFloat(m.requestedQty) || 0;
    const quotedQty = parseFloat(m.quotedQty) || requestedQty;

    // Recalculate line total from unit price × quoted qty
    let calculatedTotal = null;
    if (unitPrice !== null && quotedQty > 0) {
      calculatedTotal = unitPrice * quotedQty;
      const aiTotal = parsePrice(m.lineTotal);
      if (aiTotal !== null && Math.abs(aiTotal - calculatedTotal) > 0.02) {
        warnings.push(`Maths check: ${m.item} - AI said £${aiTotal.toFixed(2)} but ${quotedQty} × £${unitPrice.toFixed(2)} = £${calculatedTotal.toFixed(2)}`);
        confidence = "low";
      }
    }

    // Flag uncertain prices
    if (!m.unitPrice || m.unitPrice === "Not quoted" || m.unitPrice === "POA" || m.unitPrice === "TBA" || m.unitPrice === "-") {
      confidence = "low";
    }

    // Flag if unit price looks suspiciously high or low (sanity check)
    if (unitPrice !== null) {
      if (unitPrice < 0.01) { warnings.push(`Suspicious price: ${m.item} quoted at £${unitPrice} - please verify`); confidence = "low"; }
      if (unitPrice > 50000) { warnings.push(`Unusually high price: ${m.item} at £${unitPrice} - please verify`); confidence = "low"; }
    }

    // Flag qty mismatch
    if (requestedQty > 0 && quotedQty > 0 && Math.abs(requestedQty - quotedQty) > 0.001) {
      confidence = confidence === "high" ? "medium" : confidence;
    }

    // Vague stock status - downgrade confidence
    if (m.stockQty === "unknown" || (typeof m.inStock !== "boolean")) {
      confidence = confidence === "high" ? "medium" : confidence;
    }

    return {
      ...m,
      lineTotal: calculatedTotal !== null ? `£${calculatedTotal.toFixed(2)}` : m.lineTotal,
      confidence,
    };
  });

  // Recompute subtotal from validated line totals
  const computedSubtotal = matched.reduce((sum, m) => {
    const t = parsePrice(m.lineTotal);
    return sum + (t || 0);
  }, 0);

  const aiSubtotal = parsePrice(analysis.subtotal);
  if (aiSubtotal !== null && computedSubtotal > 0 && Math.abs(aiSubtotal - computedSubtotal) > 0.50) {
    warnings.push(`Subtotal check: AI said ${analysis.subtotal} but line totals add up to £${computedSubtotal.toFixed(2)}`);
  }

  // Use computed subtotal if more reliable
  const finalSubtotal = computedSubtotal > 0 ? `£${computedSubtotal.toFixed(2)}` : analysis.subtotal;

  // Recompute estimated total with carriage
  const carriageAmt = parsePrice(analysis.carriageCharge);
  const finalTotal = carriageAmt !== null && computedSubtotal > 0
    ? `£${(computedSubtotal + carriageAmt).toFixed(2)}`
    : analysis.estimatedTotal || finalSubtotal;

  // Completeness score - verify against actual matched vs requested
  const requestedCount = requestedItems.length;
  const matchedCount = matched.filter(m => m.unitPrice && m.unitPrice !== "Not quoted" && m.unitPrice !== "-").length;
  const missingCount = (analysis.missing||[]).length;
  const computedCompleteness = requestedCount > 0
    ? Math.round((matchedCount / requestedCount) * 100)
    : analysis.completeness;

  // Use the lower of AI completeness or computed - prevents AI over-claiming
  const finalCompleteness = Math.min(analysis.completeness || 0, computedCompleteness);

  // Flag carriage ambiguity
  const carriageRaw = (analysis.carriageCharge||"").toLowerCase();
  if (carriageRaw.includes("over") || carriageRaw.includes("above") || carriageRaw.includes("minimum") || carriageRaw.includes("depending")) {
    warnings.push(`Carriage condition: "${analysis.carriageCharge}" - verify whether this order qualifies for free delivery`);
  }

  // Overall verdict based on validated completeness
  const overallVerdict = finalCompleteness >= 90 ? "excellent"
    : finalCompleteness >= 75 ? "good"
    : finalCompleteness >= 50 ? "partial"
    : "poor";

  return {
    ...analysis,
    matched,
    warnings: [...new Set(warnings)], // deduplicate
    subtotal: finalSubtotal,
    estimatedTotal: finalTotal,
    completeness: finalCompleteness,
    overallVerdict,
    _validated: true,
  };
}

// --- Stage 1: Extract raw line items from quote -------------------------------
async function extractQuoteLines(quoteText, supplierName) {
  const sys = `You are a data extraction specialist. Your ONLY job is to extract every pricing line from a supplier quote EXACTLY as written. Do not interpret, match, or analyse anything. Just extract the raw lines.

Return ONLY valid JSON - no markdown, no explanation:
{
  "supplierName": "...",
  "lines": [
    {"rawText":"exact line from quote","product":"product name as written","qty":null or number,"unit":"unit as written or null","unitPrice":null or number,"lineTotal":null or number,"currency":"GBP"}
  ],
  "carriageRaw": "exact carriage text or null",
  "leadTimeRaw": "exact lead time text or null",
  "vatRaw": "exact VAT text or null",
  "discountRaw": "exact discount text or null",
  "quoteRef": "supplier quote reference or null"
}

Rules - CRITICAL:
- Copy product names EXACTLY as they appear - do not normalise or interpret
- If a price says "POA", "TBA", "Call", "On application" - set unitPrice to null and note in rawText
- If a quantity is ambiguous (e.g. "10 x 3m lengths") - set qty to null and preserve rawText exactly
- ONLY include lines that are clearly products or services being quoted
- Do NOT include lines that are email headers, signatures, addresses, payment terms
- If you cannot find a numeric price - set unitPrice to null, never guess`;

  const cleaned = preprocessQuoteText(quoteText);
  const raw = await callAI(sys,
    `Supplier: ${supplierName||"Unknown"}

Quote text:
${cleaned}

Extract all pricing lines as JSON.`
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return { lines:[], error:"extraction_failed", raw }; }
}

// --- Stage 2: Match extracted lines to requested items ------------------------
async function matchQuoteToRequest(requestedItems, extractedLines, supplierName) {
  const reqList = requestedItems.map((item,i) =>
    `${i+1}. ${item.quantity} ${item.unit} of "${item.description}"${item.notes?` [Note: ${item.notes}]`:""}`
  ).join("\n")

  const lineList = (extractedLines.lines||[]).map((l,i) =>
    `${i+1}. "${l.rawText}" | product: ${l.product} | qty: ${l.qty??'?'} | unit: ${l.unit??'?'} | unitPrice: ${l.unitPrice??'?'} | lineTotal: ${l.lineTotal??'?'}`
  ).join("\n")

  const sys = `You are a procurement matching specialist. Match supplier quote lines to requested items. Be STRICT - only match if you are genuinely confident. Return ONLY valid JSON, no markdown.

Output format:
{
  "matched": [
    {
      "requestedItem": "description from request",
      "requestedQty": number,
      "requestedUnit": "unit",
      "quotedProduct": "product name from quote",
      "quotedQty": number or null,
      "quotedUnit": "unit from quote or null",
      "unitPrice": "£X.XX or Not quoted",
      "lineTotal": "£X.XX or null",
      "inStock": true/false/null,
      "stockQty": "number or unknown",
      "leadTime": "string or null",
      "qtyMatch": true/false,
      "matchConfidence": "high|medium|low",
      "matchReason": "brief explanation of why these match",
      "notes": "any relevant notes"
    }
  ],
  "missing": [
    {"item":"description","reason":"not found in quote|out of stock|discontinued|price on application"}
  ],
  "alternatives": [
    {"requestedItem":"...","alternativeOffered":"...","altPrice":"...","reason":"why alternative","recommended":true/false}
  ],
  "unmatchedQuoteLines": ["lines in quote that didn't match any requested item"]
}

Matching rules - CRITICAL:
- Match based on product type, specification, and size - a "22mm compression elbow" matches "22mm elbow compression fitting"
- Do NOT match if the specification is different (e.g. 15mm vs 22mm, copper vs plastic)
- If partially matching (e.g. similar product but different spec) - set matchConfidence to "low" and explain in matchReason
- If a requested item appears NOWHERE in the quote - put it in missing, do not force a match
- qtyMatch is true only if quotedQty equals requestedQty exactly
- inStock: true if quote says "in stock", "available", "ex-stock"; false if "out of stock", "unavailable"; null if not mentioned
- matchConfidence high = clear exact match, medium = likely match with minor differences, low = uncertain`;

  const raw = await callAI(sys,
    `Supplier: ${supplierName||"Unknown"}

Requested items:
${reqList}

Extracted quote lines:
${lineList||"(no lines extracted)"}

Match and return JSON.`
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return { matched:[], missing:requestedItems.map(i=>({item:i.description,reason:"matching_failed"})), error:"matching_failed" }; }
}

// --- Stage 3: Synthesise final analysis --------------------------------------
async function synthesiseAnalysis(requestedItems, extractedData, matchedData, supplierName) {
  const sys = `You are a senior procurement analyst. You have been given pre-extracted and pre-matched quote data. Your job is to produce a final analysis summary. Return ONLY valid JSON, no markdown.

Output:
{
  "supplierName": "...",
  "recommendation": "2-sentence plain-English verdict - be specific about value, completeness, and any concerns",
  "discounts": [{"item":"...","discount":"percent or amount","detail":"condition if any"}],
  "positives": ["specific positive points - max 4"],
  "warnings": ["specific warnings - only real issues, max 5"],
  "vatNote": "exact VAT statement from quote or 'Not stated'",
  "carriageCharge": "£X.XX or Free or Free over £X or Not stated - use exact wording from quote",
  "leadTime": "exact lead time from quote or Not stated"
}

Rules:
- Base EVERYTHING on the provided data - do not invent or assume anything
- If carriageCharge has a condition (e.g. free over £150) - include the full condition
- Discounts only if explicitly stated in the quote - never infer
- Warnings only for real problems: missing items, qty mismatches, unclear prices, conditional carriage
- Positives only for genuinely good things: fast delivery, full availability, competitive pricing
- Recommendation must reference the actual completeness and total`;

  const summary = {
    supplier: supplierName,
    requested: requestedItems.map(i=>`${i.quantity} ${i.unit} ${i.description}`),
    matched: matchedData.matched?.length||0,
    missing: matchedData.missing?.length||0,
    carriageRaw: extractedData.carriageRaw||"not stated",
    leadTimeRaw: extractedData.leadTimeRaw||"not stated",
    vatRaw: extractedData.vatRaw||"not stated",
    discountRaw: extractedData.discountRaw||"none",
    warnings: matchedData.matched?.filter(m=>!m.qtyMatch||m.matchConfidence==="low").map(m=>`${m.requestedItem}: ${m.matchReason}`)||[],
  };

  const raw = await callAI(sys,
    `Data summary:
${JSON.stringify(summary,null,2)}

Produce final analysis JSON.`
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
  catch { return { recommendation:"Analysis complete.", discounts:[], positives:[], warnings:[], vatNote:"Not stated", carriageCharge:"Not stated", leadTime:"Not stated" }; }
}

// --- Master analyseQuote - orchestrates all stages ---------------------------
async function analyseQuote(items, quoteText, supplierName, onProgress) {
  const progress = onProgress || (()=>{});

  try {
    // Stage 1: Extract
    progress("Extracting quote data...");
    const extracted = await extractQuoteLines(quoteText, supplierName);

    // Stage 2: Match
    progress("Matching items to request...");
    const matched = await matchQuoteToRequest(items, extracted, supplierName);

    // Stage 3: Synthesise
    progress("Validating and calculating...");
    const synthesis = await synthesiseAnalysis(items, extracted, matched, supplierName);

    // Compute subtotal from matched lines
    const lineTotal = (matched.matched||[]).reduce((sum,m)=>{
      const p = parsePrice(m.unitPrice);
      const q = parseFloat(m.quotedQty) || parseFloat(m.requestedQty) || 0;
      return sum + (p !== null && q > 0 ? p * q : parsePrice(m.lineTotal) || 0);
    }, 0);

    const carriageAmt = parsePrice(synthesis.carriageCharge);
    const estimatedTotal = lineTotal > 0
      ? `£${(lineTotal + (carriageAmt||0)).toFixed(2)}`
      : null;

    // Completeness - based on actual matched with real prices
    const pricedItems = (matched.matched||[]).filter(m => parsePrice(m.unitPrice) !== null && m.matchConfidence !== "low");
    const completeness = items.length > 0
      ? Math.round((pricedItems.length / items.length) * 100)
      : 0;

    const overallVerdict = completeness >= 90 ? "excellent"
      : completeness >= 75 ? "good"
      : completeness >= 50 ? "partial" : "poor";

    // Build unified result
    const result = {
      supplierName: extracted.supplierName || supplierName,
      completeness,
      overallVerdict,
      recommendation: synthesis.recommendation || "",
      subtotal: lineTotal > 0 ? `£${lineTotal.toFixed(2)}` : "Not calculated",
      carriageCharge: synthesis.carriageCharge || "Not stated",
      vatNote: synthesis.vatNote || "Not stated",
      estimatedTotal: estimatedTotal || "Not calculated",
      leadTime: synthesis.leadTime || extracted.leadTimeRaw || "Not stated",
      discounts: synthesis.discounts || [],
      matched: (matched.matched||[]).map(m => ({
        item: m.requestedItem,
        requestedQty: m.requestedQty,
        requestedUnit: m.requestedUnit,
        quotedQty: m.quotedQty,
        quotedUnit: m.quotedUnit || m.requestedUnit,
        unitPrice: m.unitPrice || "Not quoted",
        lineTotal: (() => {
          const p = parsePrice(m.unitPrice);
          const q = parseFloat(m.quotedQty) || parseFloat(m.requestedQty) || 0;
          return p !== null && q > 0 ? `£${(p*q).toFixed(2)}` : m.lineTotal || "-";
        })(),
        inStock: m.inStock,
        stockQty: m.stockQty || "unknown",
        qtyMatch: m.qtyMatch,
        confidence: m.matchConfidence,
        notes: [m.matchReason, m.notes].filter(Boolean).join(" · ") || "-",
      })),
      missing: matched.missing || [],
      alternatives: matched.alternatives || [],
      warnings: [
        ...(synthesis.warnings||[]),
        ...(matched.matched||[])
          .filter(m=>m.matchConfidence==="low")
          .map(m=>`Low confidence match: "${m.requestedItem}" > "${m.quotedProduct||"?"}" - please verify`),
      ].slice(0,8),
      positives: synthesis.positives || [],
      quoteRef: extracted.quoteRef || null,
      _validated: true,
      _stages: { extracted: extracted.lines?.length||0, matched: matched.matched?.length||0 },
    };

    // Final JS validation pass
    return validateAndFix(result, items);

  } catch(e) {
    return { error:true, errorMessage: e.message };
  }
}

// --- Extract quote text from uploaded file using AI --------------------------
async function extractQuoteFromFile(fileContent, fileName, fileType) {
  const sys = `You are a procurement data extraction specialist. A supplier has sent a quote document. Extract ALL pricing information, stock availability, delivery charges, lead times, and any other relevant procurement data from the document content provided. Return the extracted information as clean, structured plain text that clearly lists each item with its price, availability, and any other details. Preserve all numbers and prices exactly. If the document appears to be a table or spreadsheet, convert it to a clear line-by-line format. Start directly with the extracted data, no preamble.`;
  const prompt = `File name: ${fileName}
File type: ${fileType}

Document content:
${fileContent}

Extract all quote/pricing information as clean structured text.`;
  return callAI(sys, prompt);
}

// --- Read file content for AI extraction -------------------------------------
async function readFileForExtraction(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split(".").pop().toLowerCase();
    // For text-based files read directly
    if (["txt","csv","html","htm"].includes(ext)) {
      const reader = new FileReader();
      reader.onload = e => resolve({ content: e.target.result, type: "text" });
      reader.onerror = reject;
      reader.readAsText(file);
      return;
    }
    // For Excel files use SheetJS via CDN
    if (["xlsx","xls","ods"].includes(ext)) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          if (!window.XLSX) {
            await new Promise((res,rej)=>{
              const s=document.createElement("script");
              s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
              s.onload=res; s.onerror=rej;
              document.head.appendChild(s);
            });
          }
          const wb = window.XLSX.read(e.target.result, {type:"binary"});
          let text = "";
          wb.SheetNames.forEach(name => {
            const ws = wb.Sheets[name];
            text += `Sheet: ${name}\n`;
            text += window.XLSX.utils.sheet_to_csv(ws);
            text += "\n\n";
          });
          resolve({ content: text, type: "excel" });
        } catch(err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsBinaryString(file);
      return;
    }
    // For PDF and Word - read as base64 and send to AI with note
    // (AI will do its best with the text it can extract)
    const reader = new FileReader();
    reader.onload = e => {
      // For PDFs we extract the raw text portions
      if (ext === "pdf") {
        const text = e.target.result;
        // Try to extract readable text from PDF binary
        const matches = text.match(/\((.*?)\)/g)||[];
        const extracted = matches
          .map(m=>m.slice(1,-1))
          .filter(s=>s.length>1&&/[a-zA-Z0-9£$€.,]/.test(s))
          .join(" ");
        resolve({ content: extracted||text.slice(0,5000), type:"pdf" });
      } else {
        resolve({ content: e.target.result.slice(0,8000), type:"binary" });
      }
    };
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });
}

// --- Email via Vercel serverless function (no CORS) --------------------------
// Build a branded HTML email from a plain-text body + optional logo
function buildEmailHtml(bodyText, settings) {
  const logo = settings.logoBase64
    ? `<img src="${settings.logoBase64}" alt="${settings.company||"Company"}" style="max-height:56px;max-width:200px;display:block;margin-bottom:16px"/>`
    : `<div style="font-size:20px;font-weight:700;color:#15824F;margin-bottom:16px">${settings.company||"ProQuote"}</div>`;
  const safeBody = (bodyText||"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/\n/g,"<br/>");
  const footer = settings.poNotes ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #EAE9E3;font-size:12px;color:#908F86">${settings.poNotes.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</div>` : "";
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAFAF8">
    <div style="max-width:600px;margin:0 auto;padding:32px 24px;font-family:'Helvetica Neue',Arial,sans-serif">
      <div style="background:#FFFFFF;border:1px solid #EAE9E3;border-radius:16px;padding:28px 32px">
        ${logo}
        <div style="font-size:14px;line-height:1.7;color:#1A1A17">${safeBody}</div>
        ${footer}
      </div>
      <div style="text-align:center;margin-top:16px;font-size:11px;color:#C4C3BA">Sent via ProQuote${settings.company?` on behalf of ${settings.company}`:""}</div>
    </div>
  </body></html>`;
}

async function sendRFQEmails(suppliers, subject, body, apiKey, fromEmail, settings={}) {
  const results = [];
  for (const s of suppliers) {
    try {
      const res = await fetch("/api/send-email", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          from: fromEmail||"andy@initialmechanical.co.uk",
          to:   [s.email],
          subject,
          text: body,
          html: buildEmailHtml(body, settings)
        })
      });
      const d = await res.json();
      if (res.ok && d.success) {
        results.push({ supplier:s.name, success:true, id:d.id });
      } else {
        results.push({ supplier:s.name, success:false, error:d.error||JSON.stringify(d), statusCode:res.status });
      }
    } catch(e) {
      results.push({ supplier:s.name, success:false, error:"Network error: "+e.message });
    }
  }
  return results;
}

// --- PDF generation via jsPDF (loaded from CDN on demand) --------------------
async function generatePO({ poNumber, jobRef, site, supplier, items, analysis, company, contactName, contactEmail, date }) {
  if (!window.jspdf) {
    await new Promise((res,rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"mm", format:"a4" });
  const W = 210, M = 18;

  // -- Deep navy header bar --
  doc.setFillColor(15,23,42);
  doc.rect(0,0,W,42,"F");

  // Accent stripe
  doc.setFillColor(59,130,246);
  doc.rect(0,42,W,3,"F");

  // Company & PO title
  doc.setTextColor(255,255,255);
  doc.setFont("helvetica","bold"); doc.setFontSize(22);
  doc.text("PURCHASE ORDER", M, 18);
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.setTextColor(148,163,184);
  doc.text(company||"Your Company", M, 27);
  doc.text("Powered by ProQuote", M, 33);

  // PO number & date - right aligned
  doc.setTextColor(255,255,255);
  doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text(poNumber, W-M, 18, {align:"right"});
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.setTextColor(148,163,184);
  doc.text(`Issued: ${date}`, W-M, 27, {align:"right"});

  // -- Info boxes --
  let y = 54;
  // Box backgrounds
  doc.setFillColor(248,250,252); doc.roundedRect(M, y, 80, 32, 2, 2, "F");
  doc.setFillColor(248,250,252); doc.roundedRect(M+86, y, 80, 32, 2, 2, "F");

  // Supplier box
  doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
  doc.text("SUPPLIER", M+4, y+7);
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(15,23,42);
  doc.text(supplier?.name||"-", M+4, y+14);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(71,85,105);
  doc.text(supplier?.email||"-", M+4, y+20);

  // Job box
  doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
  doc.text("JOB DETAILS", M+90, y+7);
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(15,23,42);
  doc.text(`Ref: ${jobRef||"TBC"}`, M+90, y+14);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(71,85,105);
  doc.text(site||"-", M+90, y+20);
  if(contactName) doc.text(`Contact: ${contactName}`, M+90, y+26);

  y += 42;

  // -- Table header --
  doc.setFillColor(15,23,42);
  doc.rect(M, y, W-M*2, 10, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(8); doc.setTextColor(148,163,184);
  doc.text("#",    M+3,  y+6.5);
  doc.text("DESCRIPTION", M+12, y+6.5);
  doc.text("QTY",  122,  y+6.5);
  doc.text("UNIT", 136,  y+6.5);
  doc.text("UNIT PRICE", 152, y+6.5);
  doc.text("TOTAL", W-M, y+6.5, {align:"right"});
  y += 10;

  // -- Table rows --
  const rows = analysis?.matched?.length
    ? analysis.matched
    : items.map(i=>({ item:i.description, requestedQty:i.quantity, requestedUnit:i.unit, quotedPrice:"TBC" }));

  let grandTotal = 0;
  rows.forEach((row,idx) => {
    if (y > 255) { doc.addPage(); y = 20; }
    // Alternating rows
    doc.setFillColor(...(idx%2===0?[255,255,255]:[248,250,252]));
    doc.rect(M, y, W-M*2, 9, "F");
    // Left border accent on even rows
    if(idx%2===0){ doc.setFillColor(59,130,246); doc.rect(M,y,1,9,"F"); }

    const price = parseFloat((row.quotedPrice||"").replace(/[^0-9.]/g,""))||0;
    const qty   = row.requestedQty||0;
    const line  = price&&qty ? `£${(price*qty).toFixed(2)}` : "TBC";
    if (line!=="TBC") grandTotal += price*qty;

    doc.setFont("helvetica","normal"); doc.setFontSize(8.5); doc.setTextColor(71,85,105);
    doc.text(String(idx+1), M+3, y+6);
    doc.setTextColor(15,23,42); doc.setFont("helvetica","normal");
    doc.text(String(row.item||"").slice(0,50), M+12, y+6);
    doc.setTextColor(71,85,105);
    doc.text(String(qty), 122, y+6);
    doc.text(String(row.requestedUnit||""), 136, y+6);
    doc.setFont("helvetica","bold"); doc.setTextColor(15,23,42);
    doc.text(row.quotedPrice||"TBC", 152, y+6);
    doc.setTextColor(59,130,246);
    doc.text(line, W-M, y+6, {align:"right"});
    y += 9;
  });

  // -- Total bar --
  y += 4;
  doc.setFillColor(15,23,42);
  doc.rect(M, y, W-M*2, 12, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(255,255,255);
  doc.text("TOTAL DUE", M+3, y+8);
  doc.setTextColor(59,130,246);
  doc.text(grandTotal?`£${grandTotal.toFixed(2)}`:"TBC", W-M, y+8, {align:"right"});
  y += 20;

  // -- VAT note --
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(100,116,139);
  doc.text("All prices shown exclude VAT unless otherwise stated.", M, y);
  y += 10;

  // -- Footer --
  doc.setDrawColor(226,232,240); doc.setLineWidth(0.3);
  doc.line(M, 275, W-M, 275);
  doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(148,163,184);
  doc.text(`${company||"Your Company"}  ·  ${contactEmail||""}  ·  PO ${poNumber}`, M, 280);
  doc.text("Generated by ProQuote - AI-powered procurement for trades", W-M, 280, {align:"right"});

  doc.save(`PO-${poNumber}.pdf`);
}

// --- Tiny shared components ---------------------------------------------------
const Btn = ({ onClick, disabled, color="#15824F", outline=false, children }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: outline?"transparent": disabled?"var(--bg-subtle2)":color,
    color: outline?"var(--text-secondary)": disabled?"var(--text-muted)":"white",
    border: outline?"1px solid var(--border-solid)":"none",
    borderRadius:"var(--radius-sm)", padding:"10px 18px", fontSize:13, fontWeight:600,
    cursor: disabled?"not-allowed":"pointer", letterSpacing:"-0.01em",
    display:"inline-flex", alignItems:"center", justifyContent:"center", gap:7,
    boxShadow: (outline||disabled)?"none":"0 1px 2px rgba(26,26,23,0.08)",
    opacity: disabled?0.7:1
  }}
  onMouseEnter={e=>{if(!disabled){e.currentTarget.style.filter="brightness(1.06)";e.currentTarget.style.transform="translateY(-1px)";}}}
  onMouseLeave={e=>{e.currentTarget.style.filter="none";e.currentTarget.style.transform="translateY(0)";}}
  >{children}</button>
)
const Badge = ({ children, bg, text }) => (
  <span style={{ background:bg, color:text, fontSize:11, fontWeight:600, padding:"3px 11px", borderRadius:20, whiteSpace:"nowrap", letterSpacing:"0.01em" }}>{children}</span>
);
const Card = ({ children, style={}, hover=false }) => (
  <div className={hover?"card-hover":""} style={{ background:"var(--bg-card-solid)", border:"1px solid var(--border)", borderRadius:"var(--radius-lg)", padding:"24px 28px", boxShadow:"var(--shadow-sm)", position:"relative", overflow:"hidden", ...style }}>{children}</div>
);
const Spinner = () => (
  <span style={{ width:14, height:14, border:"2px solid white", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin 0.7s linear infinite" }}/>
);

// --- Icon system: clean line icons (replaces emojis) -------------------------
const ICON_PATHS = {
  clipboard: '<path d="M9 2h6a1 1 0 011 1v1h1a2 2 0 012 2v13a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2h1V3a1 1 0 011-1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-6z"/>',
  check_circle: '<circle cx="12" cy="12" r="9"/><polyline points="8.5 12 11 14.5 16 9"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0M12 17v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
  package: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3.3 7L12 12l8.7-5M12 12v10"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><line x1="9" y1="7" x2="9" y2="7.01"/><line x1="15" y1="7" x2="15" y2="7.01"/><line x1="9" y1="11" x2="9" y2="11.01"/><line x1="15" y1="11" x2="15" y2="11.01"/><line x1="9" y1="15" x2="15" y2="15"/>',
  paperclip: '<path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8"/>',
  send: '<line x1="21" y1="3" x2="10" y2="14"/><polygon points="21 3 14 21 10 14 3 10 21 3"/>',
  flag: '<path d="M5 21V4a1 1 0 011-1h12l-2.5 4L18 11H6"/>',
  trash: '<polyline points="3 6 21 6"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M6 6l1 14a1 1 0 001 1h8a1 1 0 001-1l1-14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 109-9 9 9 0 00-6.4 2.6L3 13"/>',
  rocket: '<path d="M5 13c-2 1-3 5-3 5s4-1 5-3M9 11a8 8 0 015-7 8 8 0 012 8 12 12 0 01-4 4l-4 1-2-2z"/><circle cx="14.5" cy="9.5" r="1.5"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  arrow_right: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  plane: '<path d="M17.8 19.2L16 11l3.5-3.5a2.1 2.1 0 00-3-3L13 8 4.8 6.2a.5.5 0 00-.5.8L8 11l-3 3H3l1.5 2.5L7 18l1-1 3-3 3.5 3.7a.5.5 0 00.8-.5z"/>',
  wave: '<path d="M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v2M10 10.5V6a2 2 0 00-4 0v8a8 8 0 008 8h2a8 8 0 008-8 2 2 0 00-4 0"/>',
  books: '<path d="M4 19V5a1 1 0 011-1h3a1 1 0 011 1v14M9 19V7a1 1 0 011-1h3a1 1 0 011 1v12"/><path d="M14 19l2.5-13 4 1L18 19"/><line x1="3" y1="20" x2="21" y2="20"/>',
  help_circle: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5"/><line x1="12" y1="17" x2="12" y2="17.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 01-4 0v-.1A1.6 1.6 0 007.3 19l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 010-4h.1A1.6 1.6 0 004.8 7.3l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9.4a1.6 1.6 0 001-1.5V3a2 2 0 014 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9.4a1.6 1.6 0 001.5 1H21a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  file_check: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 15 11 17 15 13"/>',
};
const Icon = ({ name, size=16, color="currentColor", strokeWidth=2, style={} }) => {
  const path = ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style} dangerouslySetInnerHTML={{__html:path}}/>
  );
};

// --- App ----------------------------------------------------------------------
export default function App() {
  // Settings persisted to localStorage
  const [settings, setSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_settings")||"{}"); } catch { return {}; }
  });
  const [suppliers, setSuppliers] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_suppliers")||"null")||DEFAULT_SUPPLIERS; } catch { return DEFAULT_SUPPLIERS; }
  });
  // Global activity logger — records everything across the app
  const logActivity = (action, detail, meta={}) => {
    const entry = {
      id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      ts: new Date().toISOString(),
      action, detail,
      user: settings.contactName || "You",
      ...meta
    };
    setActivityLog(prev => [entry, ...prev].slice(0,500));
    return entry;
  };

  const saveSettings = (patch) => {
    const next = {...settings,...patch}; setSettings(next);
    try {
      localStorage.setItem("piq_settings", JSON.stringify(next));
    } catch(err) {
      showToast("Settings saved but storage is full - try a smaller logo","warn");
    }
  };
  const saveSuppliers = (s) => { setSuppliers(s); try{localStorage.setItem("piq_suppliers",JSON.stringify(s))}catch{} };

  // Nav & toast
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState(null);
  const showToast = (msg, type="success") => { setToast({msg,type}); setTimeout(()=>setToast(null),4000); };

  // Requests
  const [requests, setRequests] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_requests")||"[]")}catch{return []} });
  const [orders,   setOrders]   = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_orders")||"[]")}catch{return []} });
  const [activityLog, setActivityLog] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_activity")||"[]")}catch{return []} });

  // Wizard state
  const [step,     setStep]     = useState(1);
  const [rawInput, setRawInput] = useState("");
  const [interim,  setInterim]  = useState("");
  const [parsed,   setParsed]   = useState(null);
  const [jobRef,   setJobRef]   = useState("");
  const [site,     setSite]     = useState("");
  const [trade,    setTrade]    = useState("Plumbing");
  const [rfqEmail, setRfqEmail] = useState("");
  const [selSup,   setSelSup]   = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [loadMsg,  setLoadMsg]  = useState("");
  const [emailRes, setEmailRes] = useState(null);
  const [deliveryMethod, setDeliveryMethod] = useState("direct");
  const [deliveryDate,   setDeliveryDate]   = useState("");
  const [altAddress,     setAltAddress]     = useState("");
  const [requestNotes,   setRequestNotes]   = useState("");
  const [requestBudget,  setRequestBudget]  = useState("");

  // Help AI chat
  const [helpMessages, setHelpMessages] = useState([]);
  const [helpInput, setHelpInput] = useState("");
  const [helpLoading, setHelpLoading] = useState(false);

  // Contact form
  const [contactForm, setContactForm] = useState({name:"",email:"",category:"Bug report",priority:"Normal",description:""});
  const [contactSent, setContactSent] = useState(false);

  // Keyboard shortcuts
  useEffect(()=>{
    const handler = e=>{
      if (e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA"||e.target.tagName==="SELECT") return;
      if (e.key==="?"||e.key==="/") { setShowShortcuts(p=>!p); return; }
      if (e.key==="n"||e.key==="N") { setView("new"); resetNewRequest(); }
      else if (e.key==="q"||e.key==="Q") setView("quotes");
      else if (e.key==="o"||e.key==="O") setView("orders");
      else if (e.key==="d"||e.key==="D") setView("dashboard");
      else if (e.key==="s"||e.key==="S") setView("settings");
      else if (e.key==="h"||e.key==="H") setView("help");
      else if (e.key==="Escape") { setShowShortcuts(false);
        setDeleteConfirm(null); setEditModal(null); setActivityModal(null);
        setApproveConfirm(null); setApproveSuccess(null); setTemplateModal(false);
      }
    };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[]);

  // Templates
  const [templates, setTemplates] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_templates")||"[]")}catch{return []} });
  const saveTemplates = (t) => { setTemplates(t); localStorage.setItem("piq_templates",JSON.stringify(t)); };
  const [templateModal, setTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");

  // RFQ deadline
  const [rfqDeadline, setRfqDeadline] = useState("");

  // Edit modal state
  const [editModal,  setEditModal]  = useState(null); // request being edited
  const [editForm,   setEditForm]   = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null); // request id to confirm delete
  const [activityModal, setActivityModal] = useState(null); // request to show log

  // Orders state

  const [activeOrder, setActiveOrder] = useState(null);
  const [sendingOrder, setSendingOrder] = useState(null);
  const [orderFilter, setOrderFilter] = useState("all");
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [expandedQuote, setExpandedQuote] = useState(null);
  const [orderNote, setOrderNote] = useState({});
  const [expectedDelivery, setExpectedDelivery] = useState({}); // {orderId: dateStr}

  function handleOrderConfirmationUpload(file, orderId) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const doc = {
        id: `CONF-${Date.now()}`,
        type: "confirmation",
        label: file.name,
        date: new Date().toLocaleDateString("en-GB"),
        fileSize: `${(file.size/1024).toFixed(1)} KB`,
        dataUrl: e.target.result,
        fileType: file.type,
      };
      const entry = {
        ts: new Date().toISOString(),
        action: "Supplier confirmation attached",
        detail: `${file.name} uploaded`,
        user: settings.contactName||"You"
      };
      setOrders(p=>p.map(o=>o.id===orderId?{
        ...o,
        status:"confirmed",
        confirmationDoc: doc,
        activity:[...(o.activity||[]),entry]
      }:o));
      showToast(`Confirmation attached - order marked as Confirmed`);
      logActivity("Confirmation uploaded",`${doc.label} attached - order confirmed`,{entity:"order"});
    };
    reader.readAsDataURL(file);
  }

  // Quote library - persisted
  const [quoteLibrary, setQuoteLibrary] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_quote_library")||"[]"); } catch { return []; }
  });
  const saveToLibrary = (qa, reqId, jobRef, site, trade) => {
    const entry = {
      id: `QL-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      savedAt: new Date().toISOString(),
      expiryDate: new Date(Date.now()+(settings.quoteValidityDays||30)*24*3600000).toISOString(),
      reqId, jobRef, site, trade,
      supplierName: qa.supplierName||"Unknown",
      completeness: qa.completeness,
      totalEstimate: qa.estimatedTotal||qa.subtotal||"",
      carriageCharge: qa.carriageCharge||"",
      leadTime: qa.leadTime||"",
      items: qa.matched||[],
      missing: qa.missing||[],
      warnings: qa.warnings||[],
      overallVerdict: qa.overallVerdict||"",
    };
    setQuoteLibrary(prev => {
      const next = [entry, ...prev];
      localStorage.setItem("piq_quote_library", JSON.stringify(next.slice(0,500)));
      return next.slice(0,500);
    });
  };

  // Quote analysis state
  const [activeReq,     setActiveReq]     = useState(null);
  const [approvedQuoteId, setApprovedQuoteId] = useState(null);
  const [approveConfirm, setApproveConfirm] = useState(null); // {qa} waiting for confirmation
  const [approveSuccess, setApproveSuccess] = useState(null); // {poNum, supplier, reqId} success state
  const [quoteInput,    setQuoteInput]    = useState("");
  const [quoteSupplierName, setQuoteSupplierName] = useState("");
  const [quoteAnalysis, setQuoteAnalysis] = useState(null);
  const [allAnalyses, setAllAnalyses] = useState([]);
  const [fileExtracting, setFileExtracting] = useState({}); // {supplierIndex: bool}
  const [dragOver, setDragOver] = useState({}); // {supplierIndex: bool}

  // Settings form
  const [sForm, setSForm] = useState({company:"",contactName:"",fromEmail:"",resendKey:"",openRouterKey:"",logoBase64:"",poNotes:"",quoteValidityDays:30,...settings});

  // Supplier form
  const [newSup, setNewSup] = useState({name:"",email:"",categories:""});
  const [quickSup, setQuickSup] = useState({name:"",email:""});
  const [showQuickSup, setShowQuickSup] = useState(false);

  // Voice
  const { listening, supported:voiceOk, start:micStart, stop:micStop } = useSpeechRecognition({
    onTranscript: t => setInterim(t),
    onFinal:      t => {
      // Just append the transcribed text to the box - let the user review and edit.
      // They tap "Parse with AI" themselves when ready.
      setRawInput(p => (p + t).trim() + " ");
      setInterim("");
    }
  });
  const supported = voiceOk;
  const toggleListen = () => { listening ? micStop() : micStart(); };

  const stats = {
    total:    requests.length,
    pending:  requests.filter(r=>r.status==="pending").length,
    received: requests.filter(r=>r.status==="received").length,
    approved: requests.filter(r=>r.status==="approved").length,
  };

  const filteredSup = suppliers.filter(s=>(s.categories||[]).some(cat=>cat.trim().toLowerCase()===trade.trim().toLowerCase()));

  function logToRequest(reqId, action, detail="") {
    const entry = { ts: new Date().toISOString(), action, detail, user: settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===reqId ? {...r, activity:[...(r.activity||[]), entry]} : r));
    // Also record in the global activity log
    const reqObj = requests.find(r=>r.id===reqId);
    logActivity(action, detail, { reqId, jobRef: reqObj?.jobRef||"", entity:"request" });
  }

  function handleDelete(id) {
    logToRequest(id, "Deleted", "Request permanently deleted");
    setRequests(p=>p.filter(r=>r.id!==id));
    if (activeReq?.id===id) setActiveReq(null);
    setDeleteConfirm(null);
    showToast("Request deleted");
  }

  function handleEditSave() {
    const r = requests.find(r=>r.id===editModal.id);
    const changes = [];
    if (editForm.jobRef!==r.jobRef) changes.push(`Job ref: ${r.jobRef} > ${editForm.jobRef}`);
    if (editForm.site!==r.site)     changes.push(`Site: ${r.site} > ${editForm.site}`);
    if (editForm.status!==r.status) changes.push(`Status: ${(STATUS[r.status]||{label:r.status}).label} > ${(STATUS[editForm.status]||{label:editForm.status}).label}`);
    if (editForm.notes!==r.notes)   changes.push(`Notes updated`);
    const entry = { ts: new Date().toISOString(), action:"Edited", detail: changes.join(" · ")||"No changes", user: settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===editModal.id
      ? {...r, jobRef:editForm.jobRef, site:editForm.site, status:editForm.status, notes:editForm.notes, activity:[...(r.activity||[]), entry]}
      : r
    ));
    if (activeReq?.id===editModal.id) setActiveReq(prev=>({...prev, jobRef:editForm.jobRef, site:editForm.site, status:editForm.status, notes:editForm.notes}));
    setEditModal(null);
    showToast("Request updated");
  }

  // -- Handlers --
  async function handleParse() {
    if (!rawInput.trim()) return;
    if (!settings.openRouterKey) { showToast("Add your free OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true); setLoadMsg("Parsing your material list...");
    try {
      const data = await parseMaterialList(rawInput);
      if (!data || !data.items || data.items.length===0) {
        showToast("Couldn't read a clear list from that. Try rephrasing, or edit the text and parse again.","warn");
        setLoading(false);
        return;
      }
      setParsed(data);
      if (data?.jobRef && !jobRef) setJobRef(data.jobRef);
      // Duplicate detection
      if (jobRef) {
        const dupe = requests.find(r=>r.jobRef&&r.jobRef.toLowerCase()===jobRef.toLowerCase()&&r.trade===trade&&(Date.now()-new Date(r.created||Date.now()).getTime())<30*24*3600000);
        if (dupe) showToast(`Heads up: similar request ${dupe.id} already exists for ${jobRef}`,"warn");
      }
      // Auto-select all suppliers matching the current trade
      const matchingIds = suppliers
        .filter(s=>(s.categories||[]).some(cat=>cat.trim().toLowerCase()===trade.trim().toLowerCase()))
        .map(s=>s.id);
      setSelSup(matchingIds);
      setStep(2);
    } catch(e) {
      showToast("AI error: "+e.message,"warn");
    }
    setLoading(false);
  }


  async function handleGenRFQ() {
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true); setLoadMsg("Generating RFQ email...");
    try {
      const email = await generateRFQ(parsed.items, jobRef, settings.company, settings.contactName, settings.fromEmail, deliveryMethod, deliveryDate, altAddress, rfqDeadline);
      setRfqEmail(email);
      setStep(3);
    } catch(e) { showToast("AI error: "+e.message,"warn"); }
    setLoading(false);
  }

  async function handleSendEmails() {
    if (!settings.resendKey) { showToast("Add your Resend API key in Settings first","warn"); setView("settings"); return; }
    setLoading(true); setLoadMsg("Sending to suppliers...");
    const toSend = suppliers.filter(s=>selSup.includes(s.id));
    const subject = `Request for Quotation - ${jobRef||parsed?.jobRef||"TBC"}`;
    const results = await sendRFQEmails(toSend, subject, rfqEmail, settings.resendKey, settings.fromEmail||"onboarding@resend.dev", settings);
    setLoading(false);
    const ok = results.filter(r=>r.success).length;
    if (ok > 0) {
      const sentSuppliers = toSend.map(s=>({ id:s.id, name:s.name, email:s.email, quote:"", saved:false }));
      const newId = `RFQ-${Date.now().toString().slice(-6)}`;
      const r = {
        id: newId,
        jobRef:jobRef||"TBC", site:site||"Site TBC", trade, notes:requestNotes, budget:requestBudget,
        status:"pending",
        created: new Date().toISOString().split("T")[0],
        items: parsed.items,
        deliveryMethod, deliveryDate, altAddress, rfqDeadline,
        sentTo: sentSuppliers,
        activity:[
          { ts:new Date().toISOString(), action:"Request created", detail:`Job: ${jobRef||"TBC"} · Site: ${site||"TBC"} · Trade: ${trade} · ${parsed.items.length} items`, user:settings.contactName||"You" },
          { ts:new Date().toISOString(), action:"RFQ emails sent", detail:`Sent to ${ok} supplier${ok!==1?"s":""}: ${toSend.map(s=>s.name).join(", ")}${rfqDeadline?` · Deadline: ${new Date(rfqDeadline).toLocaleDateString("en-GB")}`:""}${deliveryMethod?` · Delivery: ${deliveryMethod}`:""}`, user:settings.contactName||"You" },
        ]
      };
      setRequests(p=>[r,...p]);
      // Show success state briefly then redirect and reset
      showToast(`v ${ok} RFQ${ok!==1?"s":""} sent - ${newId} saved`);
      logActivity("RFQ sent",`${newId} (${jobRef||"job"}) sent to ${ok} supplier${ok!==1?"s":""}`,{entity:"request",reqId:newId,jobRef});
      setTimeout(()=>{
        // Full reset - ready for next request
        setStep(1);
        setRawInput(""); setParsed(null); setJobRef(""); setSite(""); setTrade("Plumbing");
        setRfqEmail(""); setEmailRes(null); setSelSup([]);
        setDeliveryMethod("direct"); setDeliveryDate(""); setAltAddress(""); setRfqDeadline(""); setRequestNotes(""); setRequestBudget("");
        setView("dashboard");
      }, 1800);
      setEmailRes(results); // show brief success UI
    } else {
      setEmailRes(results);
      showToast(`Send failed - check your Resend key and supplier emails`,"warn");
    }
  }

  function handleDuplicate(r) {
    setJobRef(r.jobRef+" (copy)");
    setSite(r.site||"");
    setTrade(r.trade||"Plumbing");
    setDeliveryMethod(r.deliveryMethod||"direct");
    setDeliveryDate(r.deliveryDate||"");
    setAltAddress(r.altAddress||"");
    // Rebuild raw input from items
    const raw = (r.items||[]).map(i=>`${i.quantity} ${i.unit} of ${i.description}${i.notes?` (${i.notes})`:""}`).join(", ");
    setRawInput(raw);
    setParsed({ items: r.items.map(i=>({...i})), jobRef:r.jobRef+" (copy)", urgency:"standard" });
    setStep(2);
    setView("new");
    showToast("Request duplicated - review and send");
    console.log(`[ProQuote] Request duplicated from ${r.id}`);
  }

  function handleSaveTemplate() {
    if (!parsed||!newTemplateName.trim()) return;
    const t = { id:`TPL-${Date.now()}`, name:newTemplateName.trim(), trade, items:parsed.items, created:new Date().toISOString().split("T")[0], usageCount:0 };
    saveTemplates([t,...templates]);
    setTemplateModal(false);
    setNewTemplateName("");
    showToast(`Template "${t.name}" saved`);
    console.log(`[ProQuote] Template saved: ${t.name} - ${t.items.length} items`);
  }

  function handleLoadTemplate(t) {
    setTrade(t.trade||"Plumbing");
    setParsed({ items:(t.items||[]).map(i=>({...i})), jobRef:"", urgency:"standard" });
    setRawInput(t.items.map(i=>`${i.quantity} ${i.unit} of ${i.description}`).join(", "));
    // Increment usage count
    saveTemplates(templates.map(tp=>tp.id===t.id?{...tp,usageCount:(tp.usageCount||0)+1,lastUsed:new Date().toISOString().split("T")[0]}:tp));
    setStep(2);
    setTemplateModal(false);
    showToast(`Template "${t.name}" loaded`);
  }

  function resetNewRequest() {
    setStep(1); setRawInput(""); setParsed(null); setJobRef(""); setSite(""); setTrade("Plumbing");
    setRfqEmail(""); setEmailRes(null); setSelSup([]);
    setDeliveryMethod("direct"); setDeliveryDate(""); setAltAddress(""); setRfqDeadline("");
    setInterim(""); setScanning(false);
    setLoading(false); setLoadMsg("");
    setAllAnalyses([]); setExpandedQuote(null);
  }

  function handleFinalise() {
    if (parsed) {
      const r = {
        id:`RFQ-${Date.now().toString().slice(-6)}`,
        jobRef:jobRef||"TBC", site:site||"Site TBC", trade,
        status: "draft",
        created: new Date().toISOString().split("T")[0],
        items: parsed.items,
        activity:[{ ts:new Date().toISOString(), action:"Saved as draft", detail:"No emails sent", user:settings.contactName||"You" }]
      };
      setRequests(p=>[r,...p]);
      showToast("Saved as draft");
    }
    resetNewRequest();
    setView("dashboard");
  }

  async function handleAnalyse() {
    if (!quoteInput.trim()||!activeReq) return;
    if (!settings.openRouterKey) { showToast("Add your free OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true); setLoadMsg("Analysing quote...");
    try {
      const supplierName = suppliers.find(s=>selSup.includes(s.id))?.name || quoteSupplierName || "Supplier";
      const a = await analyseQuote(activeReq.items, quoteInput, supplierName);
      setQuoteAnalysis(a);
      if (!a.error) {
        const entry = { ts:new Date().toISOString(), action:"Quote analysed", detail:`Completeness: ${a.completeness}%`, user:settings.contactName||"You" };
        setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"received",activity:[...(r.activity||[]),entry]}:r));
      }
    } catch(e) { showToast("AI error: "+e.message,"warn"); }
    setLoading(false);
  }

  async function handleAnalyseAll() {
    if (!activeReq) return;
    const toAnalyse = (activeReq.sentTo||[]).filter(s=>s.quote&&s.quote.trim());
    if (!toAnalyse.length) return;
    if (!settings.openRouterKey) { showToast("Add your OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true);
    const results = [];
    for (let i=0; i<toAnalyse.length; i++) {
      const sup = toAnalyse[i];
      setLoadMsg(`Analysing ${sup.name} (${i+1} of ${toAnalyse.length})...`);
      try {
        const a = await analyseQuote(activeReq.items, sup.quote, sup.name);
        if (!a.error) results.push({...a, supplierName:a.supplierName||sup.name, _id:sup.id});
      } catch(e) { showToast(`Error analysing ${sup.name}: ${e.message}`,"warn"); }
    }
    setAllAnalyses(results);
    setApprovedQuoteId(null);
    if (results.length>0) setExpandedQuote(results[0]._id);
    logActivity("Quotes analysed",`${results.length} supplier quote${results.length!==1?"s":""} analysed for ${activeReq.jobRef}`,{entity:"quote",reqId:activeReq.id,jobRef:activeReq.jobRef});
    if (results.length>0) {
      const entry = { ts:new Date().toISOString(), action:"AI analysis run", detail:`${results.length} quote${results.length!==1?"s":""} analysed`, user:settings.contactName||"You" };
      setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"received",activity:[...(r.activity||[]),entry]}:r));
      setActiveReq(prev=>({...prev,status:"received"}));
      // Auto-save all quotes to library
      results.forEach(qa => saveToLibrary(qa, activeReq.id, activeReq.jobRef, activeReq.site, activeReq.trade));
    }
    setLoading(false);
    showToast(`Analysis complete - ${results.length} quote${results.length!==1?"s":""} saved to library`);
  }

  async function handleApprovePO(qa) {
    const analysis = qa || quoteAnalysis;
    const sup = suppliers.find(s=>s.name===analysis?.supplierName) || suppliers[0];
    const poNum = `PO-${Date.now().toString().slice(-6)}`;
    const dateStr = new Date().toLocaleDateString("en-GB");

    // Auto-save all OTHER quotes to library before approving
    const otherQuotes = allAnalyses.filter(a=>a._id!==qa._id);
    otherQuotes.forEach(a=>{
      const libEntry = {
        id:`QL-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        savedAt:new Date().toISOString(),
        expiryDate: new Date(Date.now()+(settings.quoteValidityDays||30)*24*3600000).toISOString(),
        reqId:activeReq.id, jobRef:activeReq.jobRef, site:activeReq.site, trade:activeReq.trade,
        supplierName:a.supplierName, completeness:a.completeness,
        totalEstimate:a.estimatedTotal||a.subtotal||"",
        carriageCharge:a.carriageCharge||"", leadTime:a.leadTime||"",
        items:a.matched||[], missing:a.missing||[], warnings:a.warnings||[],
        overallVerdict:a.overallVerdict||"", autoSaved:true,
      };
      setQuoteLibrary(prev=>{ const n=[libEntry,...prev].slice(0,500); localStorage.setItem("piq_quote_library",JSON.stringify(n)); return n; });
    });

    await generatePO({ poNumber:poNum, jobRef:activeReq?.jobRef, site:activeReq?.site, supplier:sup, items:activeReq?.items||[], analysis, company:settings.company||"Your Company", contactName:settings.contactName||settings.company||"Your Company", contactEmail:settings.fromEmail||"", date:dateStr });

    const doc = { id:poNum, type:"generated", label:`PO ${poNum}`, supplier:sup?.name||"", supplierEmail:sup?.email||"", date:dateStr, status:"approved" };
    const poEntry = {
      ts:new Date().toISOString(),
      action:"PO approved & generated",
      detail:`PO ${poNum} - ${sup?.name||"supplier"} - Est. ${analysis?.estimatedTotal||"-"} - ${otherQuotes.length} other quote${otherQuotes.length!==1?"s":""} auto-saved to library`,
      user:settings.contactName||"You"
    };
    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"approved",documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),poEntry]}:r));
    setActiveReq(prev=>({...prev,status:"approved",documents:[...(prev.documents||[]),doc]}));
    setApprovedQuoteId(qa?._id||null);
    logActivity("PO approved & generated",`${poNum} - ${sup?.name||"supplier"} - Est. ${analysis?.estimatedTotal||"-"} (${otherQuotes.length} other quote${otherQuotes.length!==1?"s":""} saved to library)`,{entity:"order",reqId:activeReq.id,jobRef:activeReq.jobRef});

    // Remove other quotes from the analysis view
    setAllAnalyses([qa]);

    const order = {
      id:poNum, reqId:activeReq.id,
      jobRef:activeReq?.jobRef||"TBC", site:activeReq?.site||"", trade:activeReq?.trade||"",
      supplier:sup?.name||"", supplierEmail:sup?.email||"",
      items:activeReq?.items||[], analysis, poNumber:poNum, poDate:dateStr,
      estimatedTotal: analysis?.estimatedTotal || analysis?.subtotal || "",
      status:"pending-send", type:"generated", label:`PO ${poNum}`,
      deliveryMethod:activeReq?.deliveryMethod||"", deliveryDate:activeReq?.deliveryDate||"",
      notes:"",
      activity:[{ ts:new Date().toISOString(), action:"Order created", detail:`PO ${poNum} approved - ${sup?.name||"supplier"} - ${analysis?.estimatedTotal||"-"}`, user:settings.contactName||"You" }]
    };
    setOrders(p=>[order,...p]);

    // Show success state
    setApproveConfirm(null);
    setApproveSuccess({ poNum, supplier:sup?.name||"", reqId:activeReq.id, jobRef:activeReq.jobRef, estimatedTotal:analysis?.estimatedTotal||"" });
  }

  function handleUndoApproval() {
    if (!activeReq) return;
    setApprovedQuoteId(null);
    setRequests(p=>p.map(r=>r.id===activeReq.id?{
      ...r,
      status:"received",
      documents:(r.documents||[]).filter(d=>d.type!=="generated"||d.id!==r.documents?.slice(-1)[0]?.id),
      activity:[...(r.activity||[]),{ ts:new Date().toISOString(), action:"Approval undone", detail:"PO approval reversed", user:settings.contactName||"You" }]
    }:r));
    // Remove from orders
    setOrders(p=>p.filter(o=>o.reqId!==activeReq.id||o.status==="sent"||o.status==="acknowledged"));
    setActiveReq(prev=>({...prev,status:"received"}));
    showToast("Approval undone - you can re-approve a different quote");
  }

  async function handleHelpChat(question) {
    if (!question.trim()) return;
    if (!settings.openRouterKey) { showToast("Add your OpenRouter key in Settings to use the AI assistant","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    const userMsg = {role:"user",content:question};
    setHelpMessages(p=>[...p,userMsg]);
    setHelpInput("");
    setHelpLoading(true);
    const sys = `You are the ProQuote AI assistant. ProQuote is an AI-powered procurement platform for UK trades contractors (plumbing, HVAC, electrical, mechanical, ventilation). You help users understand and use every part of the platform. Be concise, friendly, and accurate.

COMPLETE FEATURE REFERENCE (you can explain how to do all of these):

CREATING A REQUEST (New request page, 3 steps):
- Three ways to add materials: (1) Voice - tap the mic and speak your list, it transcribes live then you review and tap Parse with AI; (2) Type the list in plain English and tap Parse with AI; (3) Scan a document - photograph a scope of works, delivery note or handwritten list, or upload a PDF/image; vision AI extracts the items. (4) Import a materials spreadsheet - upload a CSV with description/quantity/unit columns and it imports instantly with no AI needed.
- After parsing, every item is editable (description, quantity, unit, category). Add/remove rows freely.
- Step 2: set an optional response deadline, choose delivery method, add request notes, set an optional budget for the job, and pick which suppliers to send to (filtered by trade). You can also load a saved template.
- Duplicate detection warns if a similar request for the same job already exists.
- Step 3: review the auto-generated RFQ email and send it to all selected suppliers at once.

QUOTE ANALYSIS:
- Pick a request from the left, paste each supplier's quote into their box, or drag/drop a PDF/Excel file to auto-extract.
- Tap Analyse all quotes. The AI runs a 3-stage analysis (extract, match to your request, synthesise) plus a JavaScript maths-validation layer that recalculates every total.
- Each supplier gets a completeness score (shown in a circular ring), a verdict, estimated total, matched items, missing items, warnings and positives. Cards are collapsible - tap to expand.
- Two views via the Cards/Compare toggle: Cards (one expandable card per supplier) and Compare (side-by-side table, one row per item, lowest price badged automatically).
- Markup calculator: enter a markup % to see cost vs sell price for each supplier.
- Print/Export button opens a print-friendly view (use Save as PDF).
- Approve a quote to generate a PO; all other quotes auto-save to the library. Undo is available.

ORDERS (status timeline: Ready to send > Sent > Confirmed > Delivered):
- Cards are collapsible - tap any order to expand it.
- Send the PO email to the supplier (needs a Resend key). Add a note and expected delivery date first.
- When Sent: either tap Mark as confirmed / Mark as delivered manually, OR upload the supplier's confirmation document. Both options work.
- Filter by All / Active / Delivered. Export orders to CSV.

LIBRARY: every non-approved quote auto-saves here with a 30-day expiry (configurable). Shows supplier scorecards (avg completeness), price history, expiry badges. Export to CSV.

SUPPLIERS: manage supplier accounts; each shows RFQ count, response rate, average completeness and PO win count.

ACTIVITY LOG: the dashboard shows a Recent activity feed logging every action across the app - RFQs sent, quotes analysed, POs approved, orders sent/confirmed/delivered, confirmations uploaded, suppliers added, library changes. Each request also keeps its own activity history (open it from All Requests). DASHBOARD CHARTS: a Spend by trade bar chart and budget-vs-actual progress bars appear automatically once you have orders/budgets. SUPPLIER QUICK-ADD: on the request wizard supplier step you can add a new supplier inline with '+ Add a supplier' without leaving the page. LIBRARY: you can remove a quote from the library with the bin icon on its row.
OTHER: dark/light theme toggle; keyboard shortcuts (N new, Q quotes, O orders, D dashboard, S settings, H help, ? shows the shortcut list); company branding (logo upload, default PO terms, quote validity days) in Settings - the logo appears on HTML emails; budget tracking on the dashboard (actual vs budget per job); quote expiry warnings on the dashboard; CSV export on library/orders/requests; All Requests has search and status/trade filters; click the ProQuote logo to return to the dashboard.

SETUP: AI features need a free OpenRouter API key (openrouter.ai). Email sending needs a Resend API key and verified domain (resend.com). Both go in Settings. Data is stored in the browser; cloud sync is on the roadmap.

If asked about something ProQuote does not do, say so clearly and mention if it is on the roadmap. Answer in 2-4 sentences unless a step-by-step is genuinely needed - then use short numbered steps.`;
    const history = [...helpMessages,userMsg].slice(-10).map(m=>({role:m.role,content:m.content}));
    try {
      const raw = await callAI(sys, question, history);
      setHelpMessages(p=>[...p,{role:"assistant",content:raw}]);
    } catch(e) { setHelpMessages(p=>[...p,{role:"assistant",content:"Sorry, I couldn't process that. Please try again."}]); }
    setHelpLoading(false);
  }

  async function handleSaveDraftQuote(qa) {
    const poNum = `DRAFT-${Date.now().toString().slice(-6)}`;
    const dateStr = new Date().toLocaleDateString("en-GB");
    const sup = suppliers.find(s=>s.name===qa?.supplierName) || {name:qa?.supplierName||"Supplier"};
    await generatePO({ poNumber:poNum, jobRef:activeReq?.jobRef, site:activeReq?.site, supplier:sup, items:activeReq?.items||[], analysis:qa, company:settings.company||"Your Company", contactName:settings.contactName||settings.company||"Your Company", contactEmail:settings.fromEmail||"", date:dateStr });
    const doc = { id:poNum, type:"draft", label:`Draft - ${sup.name}`, supplier:sup.name, date:dateStr, status:"draft" };
    const entry = { ts:new Date().toISOString(), action:"Draft quote saved", detail:`Draft PDF saved for ${sup.name} - not yet approved`, user:settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),entry]}:r));
    setActiveReq(prev=>({...prev,documents:[...(prev.documents||[]),doc]}));
    showToast(`Draft saved for ${sup.name}`);
    logActivity("Draft PO saved",`Draft for ${sup.name} - ${activeReq?.jobRef||""}`,{entity:"quote",jobRef:activeReq?.jobRef});
  }

  function handleUploadDocument(file) {
    if (!file||!activeReq) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const doc = {
        id:`UPLOAD-${Date.now()}`,
        type:"uploaded",
        label:file.name,
        supplier:"",
        date:new Date().toLocaleDateString("en-GB"),
        status:"uploaded",
        dataUrl: e.target.result,
        fileType: file.type,
        fileSize: `${(file.size/1024).toFixed(1)} KB`
      };
      const entry = { ts:new Date().toISOString(), action:"Document uploaded", detail:`${file.name} (${doc.fileSize}) uploaded`, user:settings.contactName||"You" };
      setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),entry]}:r));
      setActiveReq(prev=>({...prev,documents:[...(prev.documents||[]),doc]}));
      showToast(`${file.name} uploaded to job`);
    };
    reader.readAsDataURL(file);
  }

  function handleCreateOrderFromDoc(doc, req) {
    if (!doc||!req) return;
    const sup = suppliers.find(s=>req.sentTo?.some(st=>st.name===s.name))||{name:doc.supplier||"Supplier",email:""};
    const order = {
      id: doc.id,
      reqId: req.id,
      jobRef: req.jobRef||"TBC",
      site: req.site||"",
      trade: req.trade||"",
      supplier: doc.supplier||sup.name||"",
      supplierEmail: sup.email||"",
      items: req.items||[],
      poNumber: doc.id,
      poDate: doc.date,
      status: "pending-send",
      type: doc.type,
      label: doc.label,
      dataUrl: doc.dataUrl||null,
      deliveryMethod: req.deliveryMethod||"",
      deliveryDate: req.deliveryDate||"",
      notes: "",
      activity: [{ ts:new Date().toISOString(), action:"Order created from uploaded document", detail:doc.label, user:settings.contactName||"You" }]
    };
    setOrders(p=>[order,...p.filter(o=>o.id!==doc.id)]);
    showToast(`${doc.label} added to Orders`);
  }

  async function handleSendOrder(order) {
    if (!settings.resendKey) { showToast("Add your Resend API key in Settings to send orders","warn"); setView("settings"); return; }
    if (!order.supplierEmail) { showToast("No supplier email on this order - edit the order to add one","warn"); return; }
    setSendingOrder(order.id);
    const note = orderNote[order.id]||"";
    const subject = `Purchase Order ${order.poNumber} - ${order.jobRef}`;
    const deliveryLabels = { direct:"Delivery direct to site", alternative:"Delivery to alternative address", collect:"Collection from branch", tbc:"Delivery method to be confirmed" };
    const body = `Dear ${order.supplier},

Please find attached Purchase Order ${order.poNumber} for job reference ${order.jobRef}.

${order.site?`Site: ${order.site}`:""}
${order.deliveryMethod?`Delivery method: ${deliveryLabels[order.deliveryMethod]||order.deliveryMethod}`:""}
${order.deliveryDate?`Required by: ${new Date(order.deliveryDate).toLocaleDateString("en-GB")}`:""}

${note?`Additional notes:
${note}
`:""}
Please confirm receipt of this order and advise of any issues with availability or delivery timescales.

Kind regards
${settings.contactName||settings.company||"The Procurement Team"}
${settings.company||""}`;

    try {
      const res = await fetch("/api/send-email", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ from:settings.fromEmail||"onboarding@resend.dev", to:[order.supplierEmail], subject, text:body, html:buildEmailHtml(body, settings) })
      });
      const d = await res.json();
      if (res.ok && d.success) {
        const entry = { ts:new Date().toISOString(), action:"Order sent to supplier", detail:`Sent to ${order.supplierEmail}`, user:settings.contactName||"You" };
        setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"sent",sentAt:new Date().toISOString(),activity:[...(o.activity||[]),entry]}:o));
        showToast(`Order sent to ${order.supplier}`);
        logActivity("Order sent",`${order.poNumber} emailed to ${order.supplier}`,{entity:"order",jobRef:order.jobRef});
      } else {
        showToast(`Send failed: ${d.error||"Unknown error"}`,"warn");
      }
    } catch(e) { showToast(`Send failed: ${e.message}`,"warn"); }
    setSendingOrder(null);
  }

  const isMobile = useIsMobile();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [quoteViewMode, setQuoteViewMode] = useState("cards");
  const [marginPct, setMarginPct] = useState(0);
  const [reqFilterStatus, setReqFilterStatus] = useState("all");
  const [reqFilterTrade, setReqFilterTrade] = useState("all");
  const [reqSearch, setReqSearch] = useState("");
  const [darkMode, setDarkMode] = useState(()=>{ try{return localStorage.getItem("piq_dark")==="1"}catch{return false} });
  const toggleDark = () => setDarkMode(p=>{ const n=!p; localStorage.setItem("piq_dark",n?"1":"0"); return n; });

  // -- Persist to localStorage --
  useEffect(()=>{ try{localStorage.setItem("piq_requests",JSON.stringify(requests))}catch{} },[requests]);
  useEffect(()=>{ try{localStorage.setItem("piq_orders",JSON.stringify(orders))}catch{} },[orders]);
  useEffect(()=>{ try{localStorage.setItem("piq_activity",JSON.stringify(activityLog.slice(0,500)))}catch{} },[activityLog]);

  // Spend by trade (from approved orders)
  const spendByTrade = (() => {
    const map = {};
    orders.forEach(o => {
      const v = parseFloat(String(o.analysis?.estimatedTotal||o.estimatedTotal||"").replace(/[^0-9.]/g,""));
      if (!isNaN(v) && v>0) { const t=o.trade||"Other"; map[t]=(map[t]||0)+v; }
    });
    return Object.entries(map).map(([trade,total])=>({trade,total})).sort((a,b)=>b.total-a.total);
  })();
  const maxTradeSpend = spendByTrade.length ? Math.max(...spendByTrade.map(s=>s.total)) : 0;

  // Budget tracking: jobs with a budget set, vs actual approved spend
  const budgetJobs = requests
    .filter(r => r.budget && parseFloat(r.budget) > 0)
    .map(r => {
      const jobOrders = orders.filter(o => o.jobRef === r.jobRef);
      const actual = jobOrders.reduce((sum,o) => {
        const v = parseFloat(String(o.estimatedTotal||o.analysis?.estimatedTotal||"").replace(/[^0-9.]/g,""));
        return sum + (isNaN(v)?0:v);
      }, 0);
      const budget = parseFloat(r.budget);
      return { id:r.id, jobRef:r.jobRef, budget, actual, pct: budget>0?Math.round(actual/budget*100):0 };
    });

  // Expiring quotes (within 5 days or already expired)
  const expiringQuotes = quoteLibrary.filter(q => {
    if (!q.expiryDate) return false;
    const daysLeft = Math.ceil((new Date(q.expiryDate).getTime() - Date.now()) / 86400000);
    return daysLeft <= 5;
  }).sort((a,b) => new Date(a.expiryDate) - new Date(b.expiryDate));

  // Template modal computed values (used in JSX)
  const templateTradeOrder = ["Plumbing","HVAC","Electrical","Mechanical","Ventilation","Gas","General"];
  const templateGrouped = templateTradeOrder.reduce((acc,tr)=>{
    const matching = templates.filter(t=>t.trade===tr);
    if(matching.length>0) acc[tr]=matching;
    return acc;
  },{});
  templates.filter(t=>!templateTradeOrder.includes(t.trade)).forEach(t=>{
    if(!templateGrouped[t.trade]) templateGrouped[t.trade]=[];
    templateGrouped[t.trade].push(t);
  });
  const templateCurrentTrade = trade||"Plumbing";

  const navItems = [
          {id:"dashboard",label:"Dashboard",      d:"M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z"},
          {id:"new",      label:"New request",    d:"M12 5v14M5 12h14"},
          {id:"requests", label:"All requests",   d:"M4 6h16M4 12h10M4 18h6"},
          {id:"quotes",   label:"Quotes",         d:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2"},
          {id:"orders",   label:"Orders",         d:"M20 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 16H8M12 12H8"},
          {id:"suppliers",label:"Suppliers",      d:"M17 20h-2a4 4 0 00-8 0H5m7-10a3 3 0 100-6 3 3 0 000 6z"},
          {id:"library",  label:"Library",        d:"M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 014 17V5a2 2 0 012-2h12a2 2 0 012 2v12M4 19.5V21"},
          {id:"settings", label:"Settings",       d:"M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"},
          {id:"help",     label:"Help",           d:"M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01"},
          {id:"contact",  label:"Contact",        d:"M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"},
  ];
  const handleNav = (id) => { setView(id); setMoreMenuOpen(false); if(id==="quotes"&&requests.length&&!activeReq)setActiveReq(requests[0]); if(id==="new")resetNewRequest(); };
  const pendingOrders = orders.filter(o=>o.status==="pending-send").length;

  // Overdue requests (for dashboard banner)
  const overdueRequests = (() => {
    const now = Date.now();
    return requests.filter(r => {
      if (r.status !== "pending") return false;
      const sent = r.activity?.find(a => a.action === "RFQ emails sent")?.ts
                || r.activity?.find(a => a.action === "Created")?.ts;
      if (!sent) return false;
      return (now - new Date(sent).getTime()) / 3600000 >= 24;
    });
  })();

  // Quote analysis pending status
  const activeReqSentTs = activeReq?.activity?.find(a => a.action === "RFQ emails sent")?.ts;
  const activeReqHoursAgo = activeReqSentTs ? Math.floor((Date.now() - new Date(activeReqSentTs).getTime()) / 3600000) : 0;

  // Quote library scorecards
  const supplierScoreCards = (() => {
    const bySupplier = {};
    quoteLibrary.forEach(q => {
      if (!bySupplier[q.supplierName]) bySupplier[q.supplierName] = {name:q.supplierName, quotes:[], total:0};
      bySupplier[q.supplierName].quotes.push(q);
      bySupplier[q.supplierName].total += q.completeness || 0;
    });
    return Object.values(bySupplier).map(s => ({
      ...s,
      avgCompleteness: Math.round(s.total / s.quotes.length),
      lastQuoted: s.quotes.sort((a,b) => new Date(b.savedAt)-new Date(a.savedAt))[0]?.savedAt
    })).sort((a,b) => b.avgCompleteness - a.avgCompleteness);
  })();

  // Help page FAQs
  const helpFaqs = [
    {cat:"Getting started", qs:[
      {q:"What is ProQuote?", a:"ProQuote is an AI-powered procurement platform for trades contractors. It automates the full workflow from creating a material request on site through to sending a PO to your supplier."},
      {q:"What trades are supported?", a:"Plumbing, HVAC, Electrical, Mechanical, Ventilation, and Gas - with General as a catch-all."},
      {q:"Does it work on mobile?", a:"Yes. ProQuote is a web app that works on any device. On mobile you get a dedicated layout with a bottom tab bar and voice input."},
      {q:"Do I need to install anything?", a:"No. ProQuote runs entirely in a browser - Chrome, Safari, Edge. No app download needed."},
      {q:"Where is my data stored?", a:"All data is stored in your browser and persists across sessions. Cloud backup is coming soon."},
    ]},
    {cat:"Creating requests", qs:[
      {q:"How does voice input work?", a:"Tap the microphone button on the new request page and speak your list naturally. The app transcribes in real time and the AI structures it into a clean itemised list."},
      {q:"Can I edit the parsed list?", a:"Yes. Every field is editable - description, quantity, unit, category, and notes. You can also add or remove items before sending."},
      {q:"What are templates?", a:"Templates save common material lists for instant reuse. They are grouped by trade so you can find them quickly."},
      {q:"Can I set a response deadline?", a:"Yes. In Step 2 there is a response deadline date picker. The date appears in the RFQ email and as a countdown on the dashboard."},
      {q:"How do I scan a document or photo?", a:"On Step 1, tap 'Take a photo or upload a document'. On mobile this opens your camera. Photograph a scope of works, delivery note or handwritten list - the vision AI reads it and extracts the items. PDFs and images both work. Review the extracted list, then tap Parse with AI."},
      {q:"Can I import a spreadsheet?", a:"Yes. On Step 1 use 'Import a materials spreadsheet'. Upload a CSV with description, quantity and unit columns and it imports instantly - no AI needed, no waiting. It auto-detects your column headers."},
      {q:"Can I set a budget for a job?", a:"Yes. On Step 2 there is an optional Budget field. Once set, the dashboard shows a progress bar of actual approved spend against your budget, turning amber near the limit and red if you go over."},
      {q:"What are request notes?", a:"An optional field on Step 2 for access instructions or special requirements. Notes are stored with the request and shown in the All Requests list."},
    ]},
    {cat:"Quotes & analysis", qs:[
      {q:"How do I enter a supplier quote?", a:"In Quote Analysis, each supplier has their own box. Paste their email response or upload their PDF/Excel file. The AI reads documents automatically."},
      {q:"What does the AI check?", a:"The AI checks every item for price, stock availability, quantity accuracy, carriage charges, lead times, discounts, and alternatives. It produces a completeness score and recommends the best supplier."},
      {q:"What happens to other quotes when I approve one?", a:"All other quotes are automatically saved to the Quote Library in the background."},
      {q:"Can I undo an approval?", a:"Yes. The approved quote card shows an Undo button that reverses everything."},
      {q:"What is the Compare view?", a:"In the analysis results, the Cards/Compare toggle switches to a side-by-side table - one row per requested item, one column per supplier, so you can scan who is cheapest on each line. The lowest total is badged automatically. You can approve straight from the table."},
      {q:"How does the markup calculator work?", a:"Enter a markup percentage in the analysis results and ProQuote shows each supplier's cost alongside the marked-up sell price - useful for quoting the end client. Set it back to 0 for pure cost."},
      {q:"Can I export or print a comparison?", a:"Yes. The Print button in the analysis results opens a print-friendly layout - use your browser's Save as PDF to share it."},
      {q:"How are quotes collapsed?", a:"Each supplier result is a collapsible card. Tap the header to expand the full matched-items table and analysis; tap again to collapse. The first card opens automatically after analysis."},
    ]},
    {cat:"Orders", qs:[
      {q:"How do I send a PO to a supplier?", a:"In the Orders page, find the order and tap Send order. An email is sent to the supplier with the full PO details."},
      {q:"How do I attach a supplier confirmation?", a:"When an order is Sent, the right panel shows an upload area. Upload the confirmation PDF and the order moves to Confirmed automatically."},
      {q:"Do completed orders disappear?", a:"No. All orders stay permanently. Use the All / Active / Delivered filter to manage what you see."},
      {q:"Can I mark an order complete without a document?", a:"Yes. When an order is Sent, you can tap Mark as confirmed or Mark as delivered directly, or upload the supplier's confirmation document - whichever suits. Both options are available."},
      {q:"Can I export my orders?", a:"Yes. The Orders page has an Export button that downloads all orders as a CSV, including PO numbers, suppliers, totals, delivery dates and item lists."},
      {q:"Are order cards collapsible?", a:"Yes. Tap any order row to expand its full detail - status timeline, items and actions. Tap again to collapse."},
    ]},
    {cat:"Library, branding & shortcuts", qs:[
      {q:"What is the Quote Library?", a:"Every quote that is not approved is automatically saved to the Library when you generate a PO. It builds a price history per supplier, shows supplier scorecards (average completeness), and flags quotes that are expiring. Export it all to CSV."},
      {q:"Do quotes expire?", a:"Yes. Saved quotes expire after 30 days by default (configurable in Settings). The dashboard warns you when quotes are within 5 days of expiry, and the library shows a colour-coded expiry badge on each."},
      {q:"How do I add my company logo?", a:"In Settings, under Company branding, upload your logo. It is automatically resized and appears at the top of the branded HTML emails sent to suppliers. You can also set default PO terms and the quote validity period there."},
      {q:"Do emails include my branding?", a:"Yes. RFQ and purchase order emails are sent as branded HTML with your logo (or company name) at the top, your message in a clean card, and your PO terms in the footer."},
      {q:"What keyboard shortcuts are there?", a:"Press N for new request, Q for quotes, O for orders, D for dashboard, S for settings, H for help, and ? to show the full shortcuts panel. Esc closes any open dialog."},
      {q:"How do I get back to the dashboard quickly?", a:"Click the ProQuote logo at the top of the sidebar, press D, or use the dashboard tab."},
      {q:"Can I search and filter my requests?", a:"Yes. The All Requests page has a search box plus status and trade filters, so you can quickly find any job. The filtered list can be exported to CSV."},
      {q:"Where can I see everything that has happened?", a:"The dashboard has a Recent activity feed that logs every action across the app - RFQs sent, quotes analysed, POs approved, orders sent, confirmed and delivered, confirmations uploaded, suppliers added and library changes. Each individual request also keeps its own activity history, which you can open from the All Requests page."},
      {q:"What charts does the dashboard show?", a:"Once you have approved orders, a Spend by trade bar chart appears. If you set budgets on jobs, budget-vs-actual progress bars show too, turning amber near the limit and red if you go over."},
      {q:"Can I add a supplier while creating a request?", a:"Yes. On the supplier step of the request wizard, tap '+ Add a supplier' to add one inline - it is saved and auto-selected without leaving the page."},
      {q:"Can I remove a quote from the library?", a:"Yes. Each row in the Quote Library has a bin icon to remove that quote. The removal is logged in the activity feed."},
    ]},
    {cat:"Settings & troubleshooting", qs:[
      {q:"Why is the AI not working?", a:"You need a free OpenRouter API key. Go to openrouter.ai, sign up, copy your key, and paste it in Settings."},
      {q:"Why are emails not sending?", a:"Email sending requires a Resend API key and a verified domain. Go to resend.com, create a free account, verify your domain, and add the key in Settings."},
      {q:"My data disappeared after refreshing.", a:"Data is stored in your browser. Clearing browser data will remove it. Full cloud sync is on the roadmap."},
      {q:"Can I export my data?", a:"Yes. The Library, Orders and All Requests pages each have a CSV export button, so you can back up or share your data anytime."},
    ]},
  ];

  // File upload handler for quote entry
  const processQuoteFile = async(file, si, sup, activeReqId) => {
    if (!file) return;
    if (!settings.openRouterKey) { showToast("Add your OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setFileExtracting(prev=>({...prev,[si]:true}));
    showToast(`Reading ${file.name}...`);
    try {
      const { content, type } = await readFileForExtraction(file);
      showToast(`AI extracting data from ${file.name}...`);
      const extracted = await extractQuoteFromFile(content, file.name, type);
      const newQuote = sup.quote?.trim()
        ? sup.quote + "\n\n--- From " + file.name + " ---\n" + extracted
        : "--- Extracted from " + file.name + " ---\n" + extracted;
      setRequests(p=>p.map(r=>r.id===activeReqId?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,quote:newQuote}:s)}:r));
      setActiveReq(prev=>({...prev,sentTo:prev.sentTo.map((s,i)=>i===si?{...s,quote:newQuote}:s)}));
      showToast(`${file.name} extracted - review and save`);
    } catch(err) {
      showToast(`Could not read ${file.name}: ${err.message}`,"warn");
    }
    setFileExtracting(prev=>({...prev,[si]:false}));
  };

  // Bulk CSV/spreadsheet import — parses a materials list directly into items (no AI needed)
  const importMaterialsCSV = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) { showToast("That file looks empty","warn"); return; }
      // Detect header row — look for description/qty/quantity/unit keywords
      const first = lines[0].toLowerCase();
      const hasHeader = /desc|item|material|qty|quantity|unit/.test(first);
      // Split a CSV line respecting simple quoted values
      const splitLine = (line) => {
        const out = []; let cur = ""; let inQ = false;
        for (const ch of line) {
          if (ch === '"') inQ = !inQ;
          else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
          else cur += ch;
        }
        out.push(cur);
        return out.map(s => s.trim().replace(/^"|"$/g, ""));
      };
      // Map header positions if present
      let descIdx = 0, qtyIdx = 1, unitIdx = 2;
      if (hasHeader) {
        const cols = splitLine(first);
        cols.forEach((col, i) => {
          if (/desc|item|material/.test(col)) descIdx = i;
          else if (/qty|quantity|amount/.test(col)) qtyIdx = i;
          else if (/unit|measure/.test(col)) unitIdx = i;
        });
      }
      const dataLines = hasHeader ? lines.slice(1) : lines;
      const items = dataLines.map(line => {
        const cols = splitLine(line);
        return {
          description: cols[descIdx] || cols[0] || "",
          quantity: cols[qtyIdx] || "1",
          unit: cols[unitIdx] || "no",
          category: ""
        };
      }).filter(it => it.description);
      if (!items.length) { showToast("Couldn't find any items in that file","warn"); return; }
      setParsed({ jobRef: jobRef||"", trade, items });
      setStep(2);
      showToast(`Imported ${items.length} item${items.length!==1?"s":""} from spreadsheet`);
    } catch(err) {
      showToast("Could not read that file: " + err.message, "warn");
    }
  };

  // Document scan handler
  const [scanning, setScanning] = useState(false);
  const scanDocumentFile = async (file) => {
    if (!file) return;
    if (!settings.openRouterKey) { showToast("Add your OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setRawInput("");  // Clear previous input before scanning
    setScanning(true);
    setLoading(true);
    setLoadMsg("Reading document...");
    try {
      // Read file as base64 for vision API
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });

      const isImage = file.type.startsWith("image/");
      const isPDF   = file.type === "application/pdf";

      if (!isImage && !isPDF) {
        // Text-based file — read as text and parse normally
        const text = await file.text();
        setRawInput(text);
        setScanning(false);
        setLoading(false);
        showToast("Document loaded. Review, then tap Parse with AI");
        return;
      }

      setLoadMsg("AI reading document...");

      // Use vision-capable model for images
      const key = settings.openRouterKey;
      const systemPrompt = `You are an expert at reading construction and trades documents.
Extract ALL material items from this document — scope of works, schedule of materials, delivery notes, handwritten lists, anything.
Return ONLY a plain text list in this format, one item per line:
[quantity] [unit] [description]
Example:
20 metres 22mm copper pipe
6 no 22mm compression elbows
1 box PTFE tape

Rules:
- Include every material item you can see, even if quantities are unclear
- If quantity is not clear, use 1 as default
- If unit is not clear, use "no" (number off)
- Do NOT include labour, costs, prices, or non-material items
- Do NOT add any explanation or preamble — just the list`;

      let content;
      if (isImage) {
        content = [
          { type: "image_url", image_url: { url: `data:${file.type};base64,${base64}` } },
          { type: "text", text: "Extract all material items from this document as a plain list." }
        ];
      } else {
        // PDF — send as text extraction prompt
        content = `I have a PDF document. Here is the base64 content. Please extract all material items: ${base64.slice(0, 8000)}`;
      }

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key,
          "HTTP-Referer": "https://proquote.app",
          "X-Title": "ProQuote"
        },
        body: JSON.stringify({
          model: isImage ? "google/gemini-flash-1.5" : "deepseek/deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: isImage ? content : (typeof content === "string" ? content : JSON.stringify(content)) }
          ]
        })
      });
      const data = await res.json();
      const extracted = data.choices?.[0]?.message?.content || "";
      if (!extracted.trim()) throw new Error("No items found in document");

      setRawInput(extracted.trim());
      setScanning(false);
      setLoading(false);
      const itemCount = extracted.trim().split("\n").filter(Boolean).length;
      showToast(`Document scanned - ${itemCount} item${itemCount!==1?"s":""} found. Review, then Parse with AI`);

    } catch(err) {
      setScanning(false);
      setLoading(false);
      setLoadMsg("");
      showToast("Could not read document: " + err.message, "warn");
    }
  };

  // CSV export helper
  const downloadCSV = (filename, rows) => {
    if (!rows.length) { showToast("Nothing to export","warn"); return; }
    const headers = Object.keys(rows[0]);
    const escape = (v) => {
      const s = (v==null?"":String(v)).replace(/"/g,'""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [
      headers.join(","),
      ...rows.map(r => headers.map(h => escape(r[h])).join(","))
    ].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} row${rows.length!==1?"s":""}`);
  };

  // -- Render --
  return (
    <div data-theme={darkMode?"dark":"light"} style={{fontFamily:"'Plus Jakarta Sans','Helvetica Neue',sans-serif",background:"var(--bg-page)",minHeight:"100vh",color:"var(--text-primary)",transition:"background 0.3s,color 0.2s"}}>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <style>{`
      /* -- LIGHT THEME (default) -- */
      :root {
        --bg-page:        #FAFAF8;
        --bg-card:        #FFFFFF;
        --bg-card-solid:  #FFFFFF;
        --bg-input:       #FFFFFF;
        --bg-subtle:      #F6F6F3;
        --bg-subtle2:     #EFEFEA;
        --bg-header:      #FFFFFF;
        --border:         #EAE9E3;
        --border-solid:   #E2E1DA;
        --text-primary:   #1A1A17;
        --text-secondary: #5C5B54;
        --text-tertiary:  #908F86;
        --text-muted:     #C4C3BA;
        --green:          #1E9E63;
        --green-dark:     #15824F;
        --green-deep:     #0E5C38;
        --green-light:    #DFF3E8;
        --green-mint:     #F2FAF5;
        --indigo:         #5B5BD6;
        --indigo-light:   #EEEEFB;
        --amber:          #C77D2E;
        --amber-light:    #FBF3E8;
        --red:            #D14343;
        --red-light:      #FBEDED;
        --shadow-sm:      0 1px 2px rgba(26,26,23,0.04), 0 1px 1px rgba(26,26,23,0.03);
        --shadow-md:      0 2px 4px rgba(26,26,23,0.04), 0 6px 16px rgba(26,26,23,0.06);
        --shadow-lg:      0 4px 8px rgba(26,26,23,0.04), 0 16px 40px rgba(26,26,23,0.10);
        --sidebar-bg:     #18181B;
        --sidebar-border: #27272A;
        --sidebar-text:   #A1A1AA;
        --sidebar-active: #34D399;
        --sidebar-activebg: rgba(52,211,153,0.12);
        --topbar-bg:      #18181B;
        --bottombar-bg:   #18181B;
        --radius-sm:      10px;
        --radius-md:      14px;
        --radius-lg:      20px;
      }
      /* -- DARK THEME -- */
      [data-theme="dark"] {
        --bg-page:        #16161A;
        --bg-card:        #1C1C21;
        --bg-card-solid:  #1C1C21;
        --bg-input:       #232328;
        --bg-subtle:      #232328;
        --bg-subtle2:     #2E2E35;
        --bg-header:      #1C1C21;
        --border:         #2E2E35;
        --border-solid:   #3A3A42;
        --text-primary:   #F4F4F2;
        --text-secondary: #B4B4AE;
        --text-tertiary:  #87877F;
        --text-muted:     #5C5C56;
        --green:          #3DD68C;
        --green-dark:     #2BB873;
        --green-deep:     #7FE8B5;
        --green-light:    rgba(61,214,140,0.14);
        --green-mint:     rgba(61,214,140,0.07);
        --indigo:         #8B8BF0;
        --indigo-light:   rgba(139,139,240,0.14);
        --amber:          #E0A04D;
        --amber-light:    rgba(224,160,77,0.12);
        --red:            #E66B6B;
        --red-light:      rgba(230,107,107,0.12);
        --shadow-sm:      0 1px 2px rgba(0,0,0,0.4);
        --shadow-md:      0 2px 4px rgba(0,0,0,0.3), 0 8px 20px rgba(0,0,0,0.4);
        --shadow-lg:      0 4px 8px rgba(0,0,0,0.3), 0 20px 48px rgba(0,0,0,0.55);
        --sidebar-bg:     #111114;
        --sidebar-border: #26262C;
        --sidebar-text:   #87877F;
        --sidebar-active: #3DD68C;
        --sidebar-activebg: rgba(61,214,140,0.10);
        --topbar-bg:      #111114;
        --bottombar-bg:   #111114;
      }
      [data-theme="dark"] input,[data-theme="dark"] textarea,[data-theme="dark"] select {
        background:var(--bg-input)!important;color:var(--text-primary)!important;border-color:var(--border-solid)!important;
      }
      [data-theme="dark"] input::placeholder,[data-theme="dark"] textarea::placeholder { color:var(--text-muted)!important; }
      *{box-sizing:border-box;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
      body{letter-spacing:-0.011em}
      h1,h2,h3{letter-spacing:-0.022em}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      @keyframes slideUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
      @keyframes cardExpand{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
      @keyframes scaleIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
      @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
      @keyframes typingDot{0%,60%,100%{opacity:0.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
      .stagger-in{animation:slideUp 0.5s cubic-bezier(0.16,1,0.3,1) backwards}
      ::-webkit-scrollbar{width:8px;height:8px}
      ::-webkit-scrollbar-track{background:transparent}
      ::-webkit-scrollbar-thumb{background:var(--bg-subtle2);border-radius:99px;border:2px solid transparent;background-clip:padding-box}
      ::-webkit-scrollbar-thumb:hover{background:var(--text-muted);background-clip:padding-box}
      ::selection{background:var(--green-light);color:var(--green-deep)}
      input,textarea,select{font-family:'Plus Jakarta Sans','Helvetica Neue',sans-serif!important}
      input:focus,textarea:focus,select:focus{border-color:var(--green-dark)!important;box-shadow:0 0 0 3px var(--green-light)!important}
      input,textarea,select{transition:border-color 0.15s,box-shadow 0.15s}
      button{transition:all 0.18s cubic-bezier(0.16,1,0.3,1)!important}
      details summary::-webkit-details-marker{display:none}
      .card-hover{transition:transform 0.2s cubic-bezier(0.16,1,0.3,1),box-shadow 0.2s,border-color 0.2s}
      .card-hover:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);border-color:var(--border-solid)}
      @media(max-width:768px){.desktop-only{display:none!important}.mobile-only{display:flex!important}}
      @media(min-width:769px){.mobile-only{display:none!important}.desktop-only{display:flex!important}}
      @media print{
        .no-print{display:none!important}
        body{background:white!important}
        .print-only{display:block!important}
        @page{margin:15mm;size:A4}
      }
      .print-only{display:none}
      `}</style>

      {/* Toast */}
      {toast&&(
        <div style={{position:"fixed",top:isMobile?16:24,right:isMobile?16:24,left:isMobile?16:"auto",zIndex:9999,background:toast.type==="warn"?"var(--amber-light)":"var(--sidebar-bg)",color:toast.type==="warn"?"var(--amber)":"white",padding:"13px 20px",borderRadius:"var(--radius-md)",fontSize:14,fontWeight:600,letterSpacing:"-0.01em",boxShadow:"var(--shadow-lg)",display:"flex",alignItems:"center",gap:10,animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)",border:"1px solid",borderColor:toast.type==="warn"?"var(--amber)":"rgba(255,255,255,0.08)",maxWidth:360}}>
          <span style={{flexShrink:0,display:"inline-flex"}}>{toast.type==="warn"
            ?<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/><circle cx="12" cy="12" r="10"/></svg>
            :<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3DD68C" strokeWidth="2.6" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}</span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Desktop sidebar */}
      {!isMobile&&(
        <div style={{position:"fixed",top:0,left:0,bottom:0,width:240,background:"var(--sidebar-bg)",display:"flex",flexDirection:"column",zIndex:100,borderRight:"1px solid var(--sidebar-border)"}}>
          <div onClick={()=>setView("dashboard")} style={{padding:"20px 20px 16px",borderBottom:"1px solid var(--sidebar-border)",display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} title="Back to dashboard">
            <div style={{width:32,height:32,background:"linear-gradient(135deg,#1E9E63,#15824F)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
            </div>
            <span style={{fontSize:16,fontWeight:800,color:"white",fontFamily:"inherit"}}>Pro<span style={{color:"#1E9E63"}}>Quote</span></span>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"12px 12px"}}>
            <div style={{fontSize:10,color:"var(--sidebar-text)",letterSpacing:"0.1em",textTransform:"uppercase",fontWeight:600,marginBottom:8,paddingLeft:4,opacity:0.7}}>Navigation</div>
            {navItems.map(item=>(
              <button key={item.id} onClick={()=>handleNav(item.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:"0 8px 8px 0",border:"none",background:view===item.id?"var(--sidebar-activebg)":"transparent",color:view===item.id?"var(--sidebar-active)":"var(--sidebar-text)",cursor:"pointer",fontSize:13,fontWeight:view===item.id?600:400,marginBottom:1,textAlign:"left",borderLeft:view===item.id?"3px solid var(--sidebar-active)":"3px solid transparent",transition:"all 0.2s cubic-bezier(0.16,1,0.3,1)"}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={item.d}/></svg>
                {item.label}
                {item.id==="orders"&&pendingOrders>0&&(
                  <span style={{marginLeft:"auto",background:"var(--green)",color:"white",fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:99}}>{pendingOrders}</span>
                )}
              </button>
            ))}
          </div>
          <div style={{padding:"14px 20px",borderTop:"1px solid var(--sidebar-border)"}}>
            <button onClick={toggleDark} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--bg-subtle2)",border:"1px solid var(--sidebar-border)",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  {darkMode
                    ?<><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>
                    :<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  }
                </svg>
                <span style={{fontSize:12,color:darkMode?"#FCD34D":"#6B7280",fontWeight:500}}>{darkMode?"Light mode":"Dark mode"}</span>
              </div>
              <div style={{width:38,height:22,background:darkMode?"var(--green)":"rgba(255,255,255,0.12)",borderRadius:11,position:"relative",transition:"background 0.3s",flexShrink:0}}>
                <div style={{position:"absolute",top:3,left:darkMode?19:3,width:16,height:16,background:"white",borderRadius:"50%",transition:"left 0.3s",boxShadow:"0 1px 4px rgba(0,0,0,0.4)"}}/>
              </div>
            </button>
            <div style={{fontSize:11,background:"var(--bg-subtle2)",borderRadius:"var(--radius-sm)",padding:"10px 14px",display:"flex",alignItems:"center",gap:8,border:"1px solid var(--sidebar-border)"}}>
              <span style={{color:settings.openRouterKey?"var(--green)":"var(--amber)"}}>*</span>
              <span style={{color:settings.openRouterKey?"var(--green)":"var(--amber)",fontSize:11}}>{settings.openRouterKey?(settings.resendKey?"AI + Email ready":"AI active"):"Setup needed"}</span>
            </div>
          </div>
        </div>
      )}

      {/* Mobile top bar */}
      {isMobile&&(
        <div style={{position:"fixed",top:0,left:0,right:0,height:60,background:"var(--topbar-bg)",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",zIndex:100,borderBottom:"1px solid var(--sidebar-border)"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,background:"linear-gradient(135deg,#1E9E63,#15824F)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
            </div>
            <span style={{fontSize:15,fontWeight:800,color:"white"}}>Pro<span style={{color:"#1E9E63"}}>Quote</span></span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button onClick={toggleDark} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",color:"white",fontSize:13}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{darkMode?<><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>:<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>}</svg></button>
            <div style={{width:8,height:8,borderRadius:"50%",background:settings.openRouterKey?"var(--green)":"var(--amber)"}}/>
          </div>
        </div>
      )}

      {/* Main content */}
      <div style={{marginLeft:isMobile?0:240,padding:isMobile?"76px 16px 88px":"32px 40px",minHeight:"100vh",animation:"fadeIn 0.2s ease"}}>

        {view==="dashboard"&&(
          <div style={{animation:"fadeIn 0.25s ease",maxWidth:1000}}>

            {/* Hero */}
            <div className="stagger-in" style={{background:"linear-gradient(140deg,#101013 0%,#1a1a20 55%,#15211b 100%)",borderRadius:"var(--radius-lg)",padding:isMobile?"26px 24px":"40px 44px",marginBottom:24,position:"relative",overflow:"hidden",boxShadow:"0 1px 2px rgba(0,0,0,0.1), 0 20px 50px rgba(16,16,19,0.25)",border:"1px solid rgba(255,255,255,0.04)"}}>
              <div style={{position:"absolute",top:-80,right:-80,width:340,height:340,background:"radial-gradient(circle,rgba(61,214,140,0.18) 0%,transparent 65%)",borderRadius:"50%",pointerEvents:"none"}}/>
              <div style={{position:"absolute",bottom:-120,left:-60,width:280,height:280,background:"radial-gradient(circle,rgba(91,91,214,0.10) 0%,transparent 70%)",borderRadius:"50%",pointerEvents:"none"}}/>
              <div style={{position:"relative",zIndex:1,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:16}}>
                <div>
                  <div style={{fontSize:11,fontWeight:600,color:"#5BE3A0",letterSpacing:"0.18em",textTransform:"uppercase",marginBottom:8}}>{new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</div>
                  <h1 style={{fontSize:isMobile?27:38,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"white",lineHeight:1.1,marginBottom:10}}>Good {new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}</h1>
                  <p style={{fontSize:isMobile?13:15,color:"rgba(148,163,184,0.9)",margin:0,lineHeight:1.6}}>
                    {requests.length===0?"Welcome to ProQuote - create your first material request to get started":`You have ${stats.pending} pending quote${stats.pending!==1?"s":""} waiting${stats.received>0?` and ${stats.received} ready to analyse`:""}.`}
                  </p>
                </div>
                <button onClick={()=>{setView("new");resetNewRequest();}} style={{display:"flex",alignItems:"center",gap:8,background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:14,padding:isMobile?"11px 18px":"14px 26px",fontSize:isMobile?13:15,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 24px rgba(34,197,94,0.4)",flexShrink:0}}>
                  + New request
                </button>
              </div>
            </div>

            {/* Overdue banner */}
            {overdueRequests.length>0&&(
              <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:14,padding:"14px 20px",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:"#9A3412",marginBottom:10}}>Suppliers have not responded yet</div>
                {overdueRequests.map(r=>{
                  const sentEntry = r.activity?.find(a=>a.action==="RFQ emails sent")||r.activity?.find(a=>a.action==="Created");
                  const hoursAgo = sentEntry?Math.floor((Date.now()-new Date(sentEntry.ts).getTime())/3600000):0;
                  const daysAgo = Math.floor(hoursAgo/24);
                  const pendingSups = (r.sentTo||[]).filter(s=>!s.saved).map(s=>s.name);
                  return(
                    <div key={r.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #FED7AA"}}>
                      <div>
                        <span style={{fontSize:13,fontWeight:600,color:"#7C2D12"}}>{r.jobRef}</span>
                        <span style={{fontSize:12,color:"#C2410C",marginLeft:8}}>{pendingSups.length>0?`${pendingSups.join(", ")} hasn't responded`:"No quotes received"}</span>
                        <span style={{fontSize:11,color:"#EA580C",marginLeft:8}}>{daysAgo>0?`${daysAgo}d ago`:`${hoursAgo}h ago`}</span>
                      </div>
                      <button onClick={()=>{setActiveReq(r);setView("quotes");}} style={{fontSize:11,color:"#EA580C",background:"#FEF3C7",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>View</button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Expiring quotes banner */}
            {expiringQuotes.length>0&&(
              <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:14,padding:"14px 20px",marginBottom:20}}>
                <div style={{fontSize:13,fontWeight:700,color:"#9A3412",marginBottom:8}}>
                  ⏰ {expiringQuotes.length} quote{expiringQuotes.length!==1?"s":""} expiring soon
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                  {expiringQuotes.map(q=>{
                    const daysLeft = Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000);
                    return(
                      <span key={q.id} style={{fontSize:11,padding:"3px 10px",borderRadius:99,background:daysLeft<=0?"var(--red-light)":daysLeft<=2?"var(--amber-light)":"#FEF3C7",color:daysLeft<=0?"var(--red)":daysLeft<=2?"var(--amber)":"#92400E",fontWeight:600}}>
                        {q.supplierName} · {q.jobRef} · {daysLeft<=0?"Expired":`${daysLeft}d left`}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Budget tracking */}
            {budgetJobs.length>0&&(
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 22px",marginBottom:20,boxShadow:"var(--shadow-sm)"}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:14}}>Budget tracking</div>
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  {budgetJobs.map(b=>{
                    const over = b.actual>b.budget;
                    const barColor = over?"var(--red)":b.pct>=85?"var(--amber)":"var(--green-dark)";
                    return(
                      <div key={b.id}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
                          <span style={{fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{b.jobRef}</span>
                          <span style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:over?"var(--red)":"var(--text-secondary)"}}>
                            £{b.actual.toFixed(2)} / £{b.budget.toFixed(2)}
                            {over&&<span style={{marginLeft:8,fontWeight:700,color:"var(--red)"}}>over by £{(b.actual-b.budget).toFixed(2)}</span>}
                          </span>
                        </div>
                        <div style={{height:8,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${Math.min(100,b.pct)}%`,background:barColor,borderRadius:99,transition:"width 0.4s"}}/>
                        </div>
                        <div style={{fontSize:10,color:"var(--text-tertiary)",marginTop:3}}>{b.pct}% of budget used{b.actual===0?" · no orders approved yet":""}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Spend by trade chart */}
            {spendByTrade.length>0&&(
              <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"20px 24px",marginBottom:20,boxShadow:"var(--shadow-sm)",animationDelay:"0.15s"}}>
                <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",marginBottom:16}}>Spend by trade</div>
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  {spendByTrade.map(s=>{
                    const pct = maxTradeSpend>0?Math.round(s.total/maxTradeSpend*100):0;
                    const tradeColors={Plumbing:"#5B5BD6",HVAC:"#1E9E63",Electrical:"#C77D2E",Mechanical:"#7E6DD6",Ventilation:"#2BB873",Gas:"#D14343",Other:"#908F86"};
                    const col=tradeColors[s.trade]||"#5B5BD6";
                    return(
                      <div key={s.trade}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                          <span style={{fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{s.trade}</span>
                          <span style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>£{s.total.toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                        </div>
                        <div style={{height:10,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${pct}%`,background:col,borderRadius:99,transition:"width 0.5s cubic-bezier(0.16,1,0.3,1)"}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Stat cards */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"repeat(2,1fr)":"repeat(4,1fr)",gap:isMobile?10:14,marginBottom:isMobile?18:24}}>
              {[
                {label:"Total requests",  value:stats.total,    color:"#5B5BD6", grad:"linear-gradient(135deg,#5B5BD6,#4A4AB8)", icon:"clipboard", nav:()=>setView("requests")},
                {label:"Awaiting quotes", value:stats.pending,  color:"#C77D2E", grad:"linear-gradient(135deg,#C77D2E,#A8661F)", icon:"clock", nav:()=>setView("quotes")},
                {label:"Quotes received", value:stats.received, color:"#7E6DD6", grad:"linear-gradient(135deg,#7E6DD6,#6B4FC4)", icon:"inbox", nav:()=>{setView("quotes");if(requests.length&&!activeReq)setActiveReq(requests[0]);}},
                {label:"Approved POs",    value:stats.approved, color:"#1E9E63", grad:"linear-gradient(135deg,#1E9E63,#15824F)", icon:"check_circle", nav:()=>setView("orders")},
              ].map((s,si)=>(
                <button key={s.label} onClick={s.nav} className="stagger-in" style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-md)",padding:isMobile?"16px 18px":"20px 24px",border:"1px solid var(--border)",position:"relative",overflow:"hidden",boxShadow:"var(--shadow-sm)",textAlign:"left",cursor:"pointer",width:"100%",display:"block",transition:"transform 0.2s cubic-bezier(0.16,1,0.3,1),box-shadow 0.2s,border-color 0.2s",animationDelay:`${si*0.05}s`}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=s.color;e.currentTarget.style.boxShadow=`0 2px 4px rgba(26,26,23,0.04), 0 12px 28px ${s.color}1f`;e.currentTarget.style.transform="translateY(-3px)";}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.boxShadow="var(--shadow-sm)";e.currentTarget.style.transform="translateY(0)";}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div style={{display:"flex"}}><Icon name={s.icon} size={20} color="white"/></div>
                    <div style={{fontSize:9,fontWeight:700,color:s.value>0?s.color:"var(--text-muted)",letterSpacing:"0.08em",textTransform:"uppercase"}}>{s.value>0?"active":"empty"}</div>
                  </div>
                  <div style={{fontSize:isMobile?26:36,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",lineHeight:1,letterSpacing:"-2px",color:s.value>0?s.color:"var(--text-muted)",marginBottom:4}}>{s.value}</div>
                  <div style={{fontSize:11,color:"var(--text-secondary)",fontWeight:500}}>{s.label}</div>
                  <div style={{position:"absolute",bottom:0,left:0,right:0,height:2,background:s.value>0?s.grad:"transparent",borderRadius:"0 0 var(--radius-md) var(--radius-md)"}}/>
                </button>
              ))}
            </div>

            {/* Quick actions */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:isMobile?8:12,marginBottom:isMobile?18:24}}>
              {[
                {label:"New request",  sub:"Voice or type",         icon:"mic", action:()=>{setView("new");resetNewRequest();}, accent:"#5B5BD6"},
                {label:"Analyse",      sub:"Compare quotes",        icon:"search", action:()=>{setView("quotes");if(requests.length&&!activeReq)setActiveReq(requests[0]);}, accent:"#7E6DD6"},
                {label:"Orders",       sub:`${orders.filter(o=>o.status==="pending-send").length} ready to send`, icon:"package", action:()=>setView("orders"), accent:"#1E9E63"},
                {label:"Suppliers",    sub:"Manage accounts",       icon:"building", action:()=>setView("suppliers"), accent:"#C77D2E"},
              ].map((q,qi)=>(
                <button key={q.label} onClick={q.action} className="stagger-in" style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:8,padding:isMobile?"14px 16px":"18px 22px",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",cursor:"pointer",textAlign:"left",boxShadow:"var(--shadow-sm)",transition:"transform 0.2s cubic-bezier(0.16,1,0.3,1),box-shadow 0.2s",position:"relative",overflow:"hidden",minHeight:isMobile?90:104,animationDelay:`${0.2+qi*0.04}s`}}
                  onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow="var(--shadow-md)";}}
                  onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="var(--shadow-sm)";}}>
                  <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:q.accent,borderRadius:"var(--radius-lg) var(--radius-lg) 0 0"}}/>
                  <div style={{marginTop:2,display:"flex"}}><Icon name={q.icon} size={20} color={q.accent}/></div>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:2}}>{q.label}</div>
                    <div style={{fontSize:11,color:"var(--text-tertiary)",lineHeight:1.4}}>{q.sub}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Recent requests */}
            {requests.length>0&&(
              <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",overflow:"hidden",boxShadow:"var(--shadow-sm)",animationDelay:"0.35s"}}>
                <div style={{padding:"18px 24px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center",background:darkMode?"rgba(34,197,94,0.04)":"linear-gradient(135deg,#FAFFFE,#F0FDF4)"}}>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>Recent requests</div>
                  <button onClick={()=>setView("requests")} style={{fontSize:12,color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View all</button>
                </div>
                {requests.slice(0,8).map((r,idx)=>{
                  const sc = STATUS[r.status]||STATUS.draft;
                  return(
                    <div key={r.id}
                      onClick={()=>{setActiveReq(r);setView("quotes");}}
                      onMouseEnter={e=>e.currentTarget.style.background=darkMode?"rgba(34,197,94,0.04)":"rgba(34,197,94,0.02)"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                      style={{display:"flex",alignItems:"center",gap:16,padding:"12px 24px",borderTop:idx===0?"none":"1px solid var(--border)",cursor:"pointer",transition:"background 0.15s"}}>
                      <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",minWidth:80,fontFamily:"'JetBrains Mono',monospace"}}>{r.id}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:500,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.jobRef}</div>
                        <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.site} · {r.trade}</div>
                      </div>
                      <div>
                        <Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge>
                        {r.rfqDeadline&&r.status==="pending"&&(
                          <div style={{fontSize:10,marginTop:3,color:Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)<=0?"var(--red)":Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)<=1?"var(--amber)":"var(--green-dark)",fontWeight:600}}>
                            {Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)<=0?"Deadline passed":`${Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000)}d left`}
                          </div>
                        )}
                      </div>
                      <div style={{fontSize:11,color:"var(--text-muted)",flexShrink:0}}>{r.created}</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Recent activity feed */}
            {activityLog.length>0&&(
              <div className="stagger-in" style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",overflow:"hidden",boxShadow:"var(--shadow-sm)",marginTop:20,animationDelay:"0.4s"}}>
                <div style={{padding:"18px 24px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)"}}>Recent activity</div>
                  <span style={{fontSize:11,color:"var(--text-tertiary)"}}>{activityLog.length} event{activityLog.length!==1?"s":""}</span>
                </div>
                <div style={{maxHeight:340,overflowY:"auto"}}>
                  {activityLog.slice(0,40).map((a,i)=>{
                    const iconMap = {
                      "RFQ sent":"send","Quotes analysed":"search","PO approved & generated":"check_circle","Order sent":"package","Order confirmed":"check","Order delivered":"flag","Confirmation uploaded":"paperclip","Draft PO saved":"edit","Deleted":"trash","Edited":"edit","Approval undone":"undo","Document attached":"paperclip","Supplier confirmation attached":"paperclip","Supplier added":"building","Library quote removed":"trash"};
                    const iconName = iconMap[a.action]||"clipboard";
                    const when = new Date(a.ts);
                    const mins = Math.floor((Date.now()-when.getTime())/60000);
                    const timeLabel = mins<1?"just now":mins<60?`${mins}m ago`:mins<1440?`${Math.floor(mins/60)}h ago`:when.toLocaleDateString("en-GB",{day:"numeric",month:"short"});
                    return(
                      <div key={a.id||i} style={{display:"flex",gap:12,padding:"12px 24px",borderBottom:i<activityLog.slice(0,40).length-1?"1px solid var(--border)":"none",alignItems:"flex-start"}}>
                        <div style={{width:30,height:30,borderRadius:8,background:"var(--bg-subtle)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={iconName} size={15} color="var(--text-secondary)"/></div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{a.action}</div>
                          <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis"}}>{a.detail}</div>
                        </div>
                        <div style={{fontSize:11,color:"var(--text-muted)",flexShrink:0,whiteSpace:"nowrap"}}>{timeLabel}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {requests.length===0&&(
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"40px 32px",textAlign:"center",boxShadow:"var(--shadow-sm)"}}>
                <div style={{marginBottom:16,display:"flex",justifyContent:"center"}}><Icon name="rocket" size={40} color="var(--green-dark)"/></div>
                <div style={{fontSize:16,fontWeight:600,color:"var(--text-primary)",marginBottom:8}}>Ready to get started</div>
                <div style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Create your first material request to start procuring with AI</div>
                <button onClick={()=>{setView("new");resetNewRequest();}} style={{background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:"var(--radius-md)",padding:"12px 28px",fontSize:14,fontWeight:700,cursor:"pointer"}}>Create first request</button>
              </div>
            )}
          </div>
        )}

        {view==="new"&&(
          <div className="stagger-in" style={{maxWidth:860}}>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>New material request</h1>
              <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>Step {step} of 3 - {step===1?"Describe your materials":step===2?"Review and configure":"Review and send"}</p>
            </div>

            {/* Step indicator */}
            <div style={{display:"flex",alignItems:"center",marginBottom:24,gap:0}}>
              {[{n:1,l:"Describe"},{n:2,l:"Review"},{n:3,l:"Send"}].map((s,i)=>(
                <div key={s.n} style={{display:"flex",alignItems:"center",flex:i<2?1:"none"}}>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                    <div style={{width:32,height:32,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:step>=s.n?"var(--green-dark)":"var(--bg-subtle2)",color:step>=s.n?"white":"var(--text-muted)",boxShadow:step===s.n?"0 0 0 4px var(--green-light)":"none",transition:"all 0.3s cubic-bezier(0.16,1,0.3,1)"}}>{step>s.n?<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>:s.n}</div>
                    <span style={{fontSize:11,color:step===s.n?"var(--green-dark)":"var(--text-muted)",fontWeight:step===s.n?600:400}}>{s.l}</span>
                  </div>
                  {i<2&&<div style={{flex:1,height:2,background:step>s.n?"var(--green-dark)":"var(--bg-subtle2)",margin:"0 4px",marginBottom:14}}/>}
                </div>
              ))}
            </div>

            {step===1&&(
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px",boxShadow:"var(--shadow-sm)"}}>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr 1fr",gap:12,marginBottom:20}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Job reference</label>
                    <input value={jobRef} onChange={e=>setJobRef(e.target.value)} placeholder="e.g. JOB-2025-012" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Site / Location</label>
                    <input value={site} onChange={e=>setSite(e.target.value)} placeholder="e.g. Unit 4, High Street" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Trade</label>
                    <select value={trade} onChange={e=>setTrade(e.target.value)} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                      {TRADES.map(t=><option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{background:listening?"linear-gradient(135deg,#FEF2F2,#FFF5F5)":"linear-gradient(135deg,var(--green-mint),var(--green-light))",border:listening?"2px solid var(--red)":"2px dashed var(--green-dark)",borderRadius:"var(--radius-md)",padding:"24px",textAlign:"center",marginBottom:16,cursor:"pointer"}} onClick={()=>supported&&toggleListen()}>
                  <div style={{fontSize:28,marginBottom:8}}>{listening
                      ?<svg width="28" height="28" viewBox="0 0 24 24" fill="var(--red)" stroke="var(--red)" strokeWidth="1"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                      :<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 10a7 7 0 01-14 0"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>}</div>
                  <div style={{fontSize:14,fontWeight:600,color:listening?"var(--red)":"var(--green-deep)"}}>{listening?"Listening - tap to stop":"Tap to speak your material list"}</div>
                  <div style={{fontSize:12,color:listening?"var(--red)":"var(--green-dark)",marginTop:4}}>{listening?"Speak now - your words appear below. Review, then tap Parse with AI":"Or type your list below"}</div>
                  {listening&&interim&&(
                    <div style={{fontSize:13,color:"var(--text-primary)",marginTop:10,padding:"8px 12px",background:"var(--bg-card-solid)",borderRadius:8,fontStyle:"italic",border:"1px solid var(--border)"}}>"{interim}"</div>
                  )}
                </div>

                <textarea value={rawInput} onChange={e=>setRawInput(e.target.value)} placeholder="e.g. 20 metres of 22mm copper pipe, 12 compression elbows, 6 isolation valves and 4 rolls of PTFE tape..." style={{width:"100%",height:100,padding:"10px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit",lineHeight:1.6,marginBottom:16}}></textarea>

                {/* Scan document button */}
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:8}}>Or scan a document</div>
                  <label style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",background:scanning?"var(--indigo-light)":"var(--bg-subtle)",border:scanning?"2px solid var(--indigo)":"1px dashed var(--border)",borderRadius:"var(--radius-md)",cursor:scanning?"not-allowed":"pointer",transition:"all 0.2s"}}>
                    <input type="file" accept="image/*,.pdf,capture=camera" style={{display:"none"}} disabled={scanning||loading} onChange={e=>{if(e.target.files[0])scanDocumentFile(e.target.files[0]);e.target.value="";}}/>
                    <div style={{width:40,height:40,borderRadius:12,background:scanning?"var(--indigo)":"linear-gradient(135deg,#5B5BD6,#4A4AB8)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 4px 12px rgba(99,102,241,0.3)"}}>
                      {scanning
                        ?<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" style={{animation:"spin 1s linear infinite"}}><circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke="white"/></svg>
                        :<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                      }
                    </div>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:scanning?"var(--indigo)":"var(--text-primary)",marginBottom:2}}>{scanning?loadMsg:"Take a photo or upload a document"}</div>
                      <div style={{fontSize:11,color:"var(--text-tertiary)"}}>Scope of works, delivery note, handwritten list · Photo, PDF, or image</div>
                    </div>
                    {!scanning&&(
                      <div style={{marginLeft:"auto",display:"flex",gap:6,flexShrink:0}}>
                        <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--indigo-light)",color:"var(--indigo)"}}>PHOTO</span>
                        <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--bg-subtle2)",color:"var(--text-tertiary)"}}>PDF</span>
                      </div>
                    )}
                  </label>

                  {/* Bulk spreadsheet import */}
                  <label style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",marginTop:10,background:"var(--bg-subtle)",border:"1px dashed var(--border)",borderRadius:"var(--radius-md)",cursor:"pointer"}}>
                    <input type="file" accept=".csv,.txt,.tsv" style={{display:"none"}} onChange={e=>{if(e.target.files[0])importMaterialsCSV(e.target.files[0]);e.target.value="";}}/>
                    <div style={{width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 4px 12px rgba(30,158,99,0.25)"}}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
                    </div>
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",marginBottom:2}}>Import a materials spreadsheet</div>
                      <div style={{fontSize:11,color:"var(--text-tertiary)"}}>CSV with columns: description, quantity, unit · imports instantly, no AI needed</div>
                    </div>
                    <div style={{marginLeft:"auto",flexShrink:0}}>
                      <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-dark)"}}>CSV</span>
                    </div>
                  </label>
                </div>

                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <button onClick={()=>setTemplateModal(true)} style={{fontSize:12,color:"var(--green-dark)",background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",fontWeight:500}}>Load template</button>
                  <Btn onClick={handleParse} disabled={!rawInput.trim()||loading||scanning} color="#15824F">
                    {loading||scanning?loadMsg||"Processing...":"Parse with AI"}
                  </Btn>
                </div>
              </div>
            )}

            {step===2&&parsed&&(
              <div>
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px",boxShadow:"var(--shadow-sm)",marginBottom:16}}>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>AI parsed {parsed.items?.length||0} items</div>
                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:14}}>Review and edit before sending - all fields are editable</div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",minWidth:600}}>
                      <thead>
                        <tr style={{background:"var(--bg-subtle)"}}>
                          {["#","Description","Qty","Unit","Category","Notes (editable)",""].map(h=>(
                            <th key={h} style={{padding:"9px 12px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.items?.map((item,i)=>{
                          const updateItem = (field,val) => setParsed(p=>({...p,items:p.items.map((it,ii)=>ii===i?{...it,[field]:val}:it)}));
                          const cellStyle = {padding:"5px 8px",border:"1px solid transparent",borderRadius:6,fontSize:13,outline:"none",fontFamily:"inherit",background:"transparent",color:"var(--text-primary)",width:"100%",transition:"all 0.15s"};
                          return(
                            <tr key={i} style={{borderTop:"1px solid var(--border)"}}>
                              <td style={{padding:"8px 12px",fontSize:12,color:"var(--text-muted)",fontFamily:"monospace"}}>{i+1}</td>
                              <td style={{padding:"4px 6px",minWidth:160}}>
                                <input value={item.description||""} onChange={e=>updateItem("description",e.target.value)}
                                  style={{...cellStyle,fontWeight:500}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:70}}>
                                <input type="number" value={item.quantity||""} onChange={e=>updateItem("quantity",e.target.value)}
                                  style={{...cellStyle,fontFamily:"'JetBrains Mono',monospace",width:60}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:80}}>
                                <input value={item.unit||""} onChange={e=>updateItem("unit",e.target.value)}
                                  style={{...cellStyle,width:70}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:120}}>
                                <select value={item.category||"General"} onChange={e=>updateItem("category",e.target.value)}
                                  style={{...cellStyle,width:110,cursor:"pointer"}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}>
                                  {["Plumbing","HVAC","Electrical","Mechanical","Ventilation","Gas","General"].map(cat=>(<option key={cat} value={cat}>{cat}</option>))}
                                </select>
                              </td>
                              <td style={{padding:"4px 6px"}}>
                                <input value={item.notes||""} onChange={e=>updateItem("notes",e.target.value)}
                                  placeholder="Add note..."
                                  style={{...cellStyle,color:"var(--text-secondary)",fontSize:12}}
                                  onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--border)",background:"var(--bg-subtle)"})}
                                  onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}/>
                              </td>
                              <td style={{padding:"4px 6px",width:30}}>
                                <button onClick={()=>setParsed(p=>({...p,items:p.items.filter((_,ii)=>ii!==i)}))}
                                  style={{background:"none",border:"none",cursor:"pointer",color:"var(--text-muted)",fontSize:14}}
                                  onMouseEnter={e=>e.target.style.color="var(--red)"}
                                  onMouseLeave={e=>e.target.style.color="var(--text-muted)"}>x</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button onClick={()=>setParsed(p=>({...p,items:[...p.items,{id:Date.now(),description:"",quantity:1,unit:"pcs",category:"General",notes:""}]}))}
                    style={{marginTop:10,fontSize:12,color:"var(--green-dark)",background:"none",border:"1px dashed var(--green-dark)",borderRadius:6,padding:"5px 14px",cursor:"pointer"}}>
                    + Add item
                  </button>
                </div>

                {/* Request notes + budget */}
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"2fr 1fr",gap:12,marginBottom:12}}>
                  <div style={{background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px"}}>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--text-secondary)",marginBottom:8}}>Request notes (optional)</div>
                    <textarea value={requestNotes} onChange={e=>setRequestNotes(e.target.value)} placeholder="Any special instructions, access notes, or additional context for suppliers..." style={{width:"100%",height:60,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",resize:"none",fontFamily:"inherit",lineHeight:1.6}}></textarea>
                  </div>
                  <div style={{background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:"var(--radius-md)",padding:"14px 16px"}}>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--green-deep)",marginBottom:8}}>Budget (optional)</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:16,fontWeight:700,color:"var(--green-deep)"}}>£</span>
                      <input type="number" min="0" value={requestBudget} onChange={e=>setRequestBudget(e.target.value)} placeholder="0.00" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--green-light)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",fontFamily:"monospace"}}/>
                    </div>
                    <div style={{fontSize:10,color:"var(--green-dark)",marginTop:6,lineHeight:1.4}}>Track actual spend against this on the dashboard</div>
                  </div>
                </div>

                {/* Deadline + Delivery */}
                <div style={{background:"var(--amber-light)",border:"1px solid var(--amber)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:2}}>Response deadline (optional)</div>
                    <div style={{fontSize:11,color:"var(--amber)"}}>Ask suppliers to respond before this date</div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <input type="date" value={rfqDeadline} onChange={e=>setRfqDeadline(e.target.value)} min={new Date().toISOString().split("T")[0]}
                      style={{padding:"8px 12px",border:"1px solid var(--amber)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    {rfqDeadline&&<button onClick={()=>setRfqDeadline("")} style={{fontSize:11,color:"var(--amber)",background:"none",border:"none",cursor:"pointer"}}>Clear</button>}
                  </div>
                </div>

                <div style={{background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--indigo)",marginBottom:10}}>Delivery requirements</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                    {[{val:"direct",label:"To site",icon:"truck"},{val:"alternative",label:"Alt. address",icon:"building"},{val:"collect",label:"Collect",icon:"store"},{val:"tbc",label:"TBC",icon:"question"}].map(opt=>(
                      <label key={opt.val} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6,padding:"10px 8px",borderRadius:"var(--radius-sm)",border:`1.5px solid ${deliveryMethod===opt.val?"var(--green-dark)":"var(--border)"}`,background:deliveryMethod===opt.val?"var(--green-mint)":"var(--bg-card-solid)",cursor:"pointer",textAlign:"center"}}>
                        <input type="radio" name="dm" value={opt.val} checked={deliveryMethod===opt.val} onChange={()=>setDeliveryMethod(opt.val)} style={{accentColor:"var(--green-dark)"}}/>
                        <span style={{fontSize:11,fontWeight:deliveryMethod===opt.val?600:400,color:"var(--text-primary)"}}>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                  {deliveryMethod==="alternative"&&(
                    <input value={altAddress} onChange={e=>setAltAddress(e.target.value)} placeholder="Enter alternative delivery address" style={{width:"100%",marginTop:10,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  )}
                  <div style={{marginTop:10,display:"flex",gap:10,flexWrap:"wrap"}}>
                    <div>
                      <label style={{fontSize:11,color:"var(--text-secondary)",display:"block",marginBottom:4}}>Required by date</label>
                      <input type="date" value={deliveryDate} onChange={e=>setDeliveryDate(e.target.value)} style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    </div>
                  </div>
                </div>

                {/* Suppliers */}
                <div style={{background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"16px",marginBottom:16}}>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",marginBottom:10}}>Suppliers to receive RFQ <span style={{color:"var(--text-secondary)",fontWeight:400}}>({trade})</span></div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {filteredSup.map(s=>(
                      <label key={s.id} style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer",background:selSup.includes(s.id)?"var(--green-mint)":"var(--bg-card-solid)",border:`1px solid ${selSup.includes(s.id)?"var(--green-dark)":"var(--border)"}`,borderRadius:"var(--radius-sm)",padding:"8px 14px",transition:"all 0.15s"}}>
                        <input type="checkbox" checked={selSup.includes(s.id)} onChange={e=>setSelSup(p=>e.target.checked?[...p,s.id]:p.filter(id=>id!==s.id))} style={{accentColor:"var(--green-dark)"}}/>
                        <span style={{fontWeight:600,color:"var(--text-primary)"}}>{s.name}</span>
                        <span style={{fontSize:11,color:"var(--text-tertiary)"}}>{s.email}</span>
                      </label>
                    ))}
                    {filteredSup.length===0&&<div style={{fontSize:13,color:"var(--text-tertiary)",marginBottom:8}}>No {trade} suppliers yet - add one below</div>}
                  </div>
                  {/* Quick-add supplier inline */}
                  {showQuickSup?(
                    <div style={{marginTop:12,padding:"14px 16px",background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)"}}>
                      <div style={{fontSize:12,fontWeight:700,color:"var(--text-secondary)",marginBottom:10}}>Add a new supplier</div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <input value={quickSup.name} onChange={e=>setQuickSup(p=>({...p,name:e.target.value}))} placeholder="Supplier name" style={{flex:"1 1 140px",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                        <input value={quickSup.email} onChange={e=>setQuickSup(p=>({...p,email:e.target.value}))} placeholder="quotes@supplier.co.uk" style={{flex:"1 1 180px",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                        <Btn onClick={()=>{
                          if(!quickSup.name.trim()||!quickSup.email.trim()){showToast("Enter a name and email","warn");return;}
                          const ns={id:`SUP-${Date.now()}`,name:quickSup.name.trim(),email:quickSup.email.trim(),categories:[trade]};
                          const updated=[...suppliers,ns];
                          saveSuppliers(updated);
                          setSelSup(p=>[...p,ns.id]);
                          logActivity("Supplier added",`${ns.name} added from request wizard`,{entity:"supplier"});
                          setQuickSup({name:"",email:""});setShowQuickSup(false);
                          showToast(`${ns.name} added and selected`);
                        }} color="#15824F">Add</Btn>
                        <Btn outline onClick={()=>{setShowQuickSup(false);setQuickSup({name:"",email:""});}}>Cancel</Btn>
                      </div>
                    </div>
                  ):(
                    <button onClick={()=>setShowQuickSup(true)} style={{marginTop:10,fontSize:13,color:"var(--green-dark)",background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",fontWeight:600}}>+ Add a supplier</button>
                  )}
                </div>

                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <Btn outline onClick={()=>setStep(1)}>Back</Btn>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <button onClick={()=>setTemplateModal(true)} style={{fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"8px 14px",cursor:"pointer",fontWeight:500}}>Save as template</button>
                    <Btn onClick={handleGenRFQ} disabled={loading||selSup.length===0} color="#15824F">
                      {loading?loadMsg:"Generate RFQ email"}
                    </Btn>
                  </div>
                </div>
              </div>
            )}

            {step===3&&(
              <div>
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px",boxShadow:"var(--shadow-sm)",marginBottom:16}}>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Review RFQ email</div>
                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:16}}>This email will be sent to {selSup.length} supplier{selSup.length!==1?"s":""}</div>
                  <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)",padding:"14px 16px",fontFamily:"'JetBrains Mono',monospace",fontSize:12,lineHeight:1.8,color:"var(--text-secondary)",marginBottom:16,whiteSpace:"pre-wrap",maxHeight:300,overflowY:"auto"}}>{rfqEmail}</div>
                  {selSup.length>0&&(
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:8}}>Will be sent to:</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {suppliers.filter(s=>selSup.includes(s.id)).map(s=>(
                          <span key={s.id} style={{fontSize:12,color:"var(--green-dark)",background:"var(--green-light)",padding:"3px 10px",borderRadius:99}}>{s.name}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {emailRes&&emailRes.some(r=>r.success)&&(
                    <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--green-light)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-sm)",padding:"12px 16px"}}>
                      <span style={{fontSize:16}}>ok</span>
                      <div>
                        <div style={{fontSize:13,fontWeight:600,color:"var(--green-dark)"}}>Quotes sent successfully</div>
                        <div style={{fontSize:12,color:"var(--green-dark)",opacity:0.8}}>Redirecting to dashboard...</div>
                      </div>
                    </div>
                  )}
                  {!emailRes&&(
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                      <Btn outline onClick={()=>setStep(2)}>Back</Btn>
                      <div style={{display:"flex",gap:10}}>
                        {settings.resendKey?(
                          <Btn onClick={handleSendEmails} disabled={loading||selSup.length===0} color="#15824F">
                            {loading?loadMsg:`Send to ${selSup.length} supplier${selSup.length!==1?"s":""}`}
                          </Btn>
                        ):(
                          <div style={{fontSize:13,color:"var(--text-tertiary)"}}>
                            Configure Resend in <button onClick={()=>setView("settings")} style={{color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600,fontSize:13,padding:0}}>Settings</button> to send emails
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {view==="quotes"&&(
          <div style={{display:"flex",gap:20,alignItems:"flex-start",animation:"fadeIn 0.25s ease",minHeight:"60vh"}}>

            {/* Left sidebar - request selector */}
            {!isMobile&&(
              <div style={{width:220,flexShrink:0,background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:"1px solid var(--border)",overflow:"hidden",boxShadow:"var(--shadow-sm)",position:"sticky",top:16}}>
                <div style={{padding:"14px 16px",borderBottom:"1px solid var(--border)",fontSize:12,fontWeight:700,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em"}}>Requests</div>
                {requests.filter(r=>r.status==="pending"||r.status==="received").length===0?(
                  <div style={{padding:"20px 16px",fontSize:12,color:"var(--text-tertiary)",textAlign:"center"}}>No active requests</div>
                ):(
                  <div>
                    {requests.filter(r=>r.status==="pending"||r.status==="received").map(r=>{
                      const quotesIn = (r.sentTo||[]).filter(s=>s.saved).length;
                      const quotesTotal = (r.sentTo||[]).length;
                      const isActive = activeReq?.id===r.id;
                      return(
                        <button key={r.id} onClick={()=>{setActiveReq(r);setAllAnalyses([]);setExpandedQuote(null);}}
                          style={{width:"100%",textAlign:"left",background:isActive?"var(--green-mint)":"transparent",border:"none",borderLeft:isActive?"3px solid var(--green-dark)":"3px solid transparent",padding:"12px 16px",cursor:"pointer",borderBottom:"1px solid var(--border)",transition:"all 0.15s"}}>
                          <div style={{fontSize:12,fontWeight:700,color:isActive?"var(--green-dark)":"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace",marginBottom:2}}>{r.id}</div>
                          <div style={{fontSize:11,color:"var(--text-secondary)",marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.jobRef}</div>
                          <div style={{fontSize:10,color:"var(--text-tertiary)"}}>{quotesIn}/{quotesTotal} quotes</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Main area */}
            <div style={{flex:1,minWidth:0}}>
              {!activeReq?(
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"48px 32px",textAlign:"center",boxShadow:"var(--shadow-sm)"}}>
                  <div style={{fontSize:14,color:"var(--text-secondary)",marginBottom:16}}>Select a request to start analysing quotes</div>
                  {requests.filter(r=>r.status==="pending"||r.status==="received").length===0&&(
                    <button onClick={()=>{setView("new");resetNewRequest();}} style={{background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 24px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Create a request</button>
                  )}
                  {isMobile&&requests.filter(r=>r.status==="pending"||r.status==="received").length>0&&(
                    <div style={{display:"flex",flexDirection:"column",gap:8,maxWidth:400,margin:"0 auto"}}>
                      {requests.filter(r=>r.status==="pending"||r.status==="received").map(r=>(
                        <button key={r.id} onClick={()=>{setActiveReq(r);setAllAnalyses([]);}} style={{textAlign:"left",padding:"12px 16px",background:"var(--bg-subtle)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",cursor:"pointer"}}>
                          <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",fontFamily:"monospace"}}>{r.id}</div>
                          <div style={{fontSize:12,color:"var(--text-secondary)"}}>{r.jobRef} · {r.site}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ):(
                <div>
                  {/* Request header */}
                  <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 22px",marginBottom:16,boxShadow:"var(--shadow-sm)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4,flexWrap:"wrap"}}>
                          <span style={{fontSize:16,fontWeight:800,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{activeReq.id}</span>
                          <span style={{fontSize:11,fontWeight:700,padding:"2px 10px",borderRadius:99,background:"var(--indigo-light)",color:"var(--indigo)"}}>{activeReq.trade}</span>
                          {approvedQuoteId&&<span style={{fontSize:11,fontWeight:700,padding:"2px 10px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>PO Approved</span>}
                        </div>
                        <div style={{fontSize:13,color:"var(--text-secondary)"}}>{activeReq.jobRef} · {activeReq.site}</div>
                        <div style={{fontSize:12,color:"var(--text-tertiary)",marginTop:3}}>{activeReq.items?.length||0} items · {(activeReq.sentTo||[]).length} suppliers</div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                        {activeReq.rfqDeadline&&(
                          Math.ceil((new Date(activeReq.rfqDeadline).getTime()-Date.now())/86400000)<=0
                          ?<span style={{fontSize:11,fontWeight:700,padding:"4px 12px",borderRadius:99,background:"var(--red-light)",color:"var(--red)"}}>Deadline passed</span>
                          :<span style={{fontSize:11,fontWeight:700,padding:"4px 12px",borderRadius:99,background:"var(--amber-light)",color:"var(--amber)"}}>Respond by {new Date(activeReq.rfqDeadline).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Quote entry */}
                  {allAnalyses.length===0&&(
                    <div>
                      <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:12,textTransform:"uppercase",letterSpacing:"0.08em"}}>Enter supplier quotes</div>
                      <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>
                        {(activeReq.sentTo||[]).map((sup,si)=>(
                          <div key={sup.id||si} style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"16px 20px",boxShadow:"var(--shadow-sm)"}}>
                            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                              <div style={{width:34,height:34,borderRadius:10,background:"linear-gradient(135deg,var(--indigo),#4A4AB8)",display:"flex",alignItems:"center",justifyContent:"center",color:"white",fontWeight:700,fontSize:14,flexShrink:0}}>{(sup.name||"?")[0]}</div>
                              <div style={{flex:1}}>
                                <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>{sup.name}</div>
                                <div style={{fontSize:11,color:"var(--text-tertiary)"}}>{sup.email}</div>
                              </div>
                              {sup.saved&&<span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>Entered</span>}
                            </div>
                            <textarea
                              value={sup.quote||""}
                              onChange={e=>{
                                const val=e.target.value;
                                setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,quote:val,saved:!!val.trim()}:s)}:r));
                                setActiveReq(p=>({...p,sentTo:p.sentTo.map((s,i)=>i===si?{...s,quote:val,saved:!!val.trim()}:s)}));
                              }}
                              placeholder={`Paste ${sup.name||"supplier"}'s quote here...`}
                              style={{width:"100%",height:90,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",resize:"vertical",fontFamily:"inherit",lineHeight:1.6,marginBottom:8}}
                            ></textarea>
                            <div
                              onDragOver={e=>{e.preventDefault();setDragOver(p=>({...p,[si]:true}));}}
                              onDragLeave={e=>{e.preventDefault();setDragOver(p=>({...p,[si]:false}));}}
                              onDrop={e=>{e.preventDefault();setDragOver(p=>({...p,[si]:false}));const f=e.dataTransfer.files[0];if(f)processQuoteFile(f,si,sup,activeReq.id);}}
                              style={{padding:"10px 12px",background:dragOver[si]?"var(--indigo-light)":"var(--bg-subtle)",borderRadius:"var(--radius-sm)",border:dragOver[si]?"2px dashed var(--indigo)":"1px dashed var(--border)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,transition:"all 0.15s"}}>
                              <span style={{fontSize:12,color:dragOver[si]?"var(--indigo)":fileExtracting[si]?"var(--indigo)":"var(--text-tertiary)"}}>
                                {fileExtracting[si]?"Extracting...":dragOver[si]?"Drop to extract":"Drag document or"}
                              </span>
                              <label style={{fontSize:11,color:"var(--indigo)",background:"var(--indigo-light)",borderRadius:6,padding:"4px 10px",cursor:fileExtracting[si]?"not-allowed":"pointer",fontWeight:500,flexShrink:0}}>
                                {fileExtracting[si]?"Reading...":"Browse file"}
                                <input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.csv,.txt" style={{display:"none"}} disabled={!!fileExtracting[si]} onChange={e=>{if(e.target.files[0])processQuoteFile(e.target.files[0],si,sup,activeReq.id);e.target.value="";}}/>
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                        <Btn onClick={handleAnalyseAll} disabled={loading||!(activeReq.sentTo||[]).some(s=>s.quote&&s.quote.trim())||!settings.openRouterKey} color="#15824F">
                          {loading?<span>Analysing... {loadMsg}</span>:"Analyse all quotes"}
                        </Btn>
                        {!settings.openRouterKey&&<span style={{fontSize:12,color:"var(--amber)"}}>Add OpenRouter key in Settings to enable AI</span>}
                      </div>
                    </div>
                  )}

                  {/* Results */}
                  {allAnalyses.length>0&&(
                    <div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:10}} className="no-print">
                        <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em"}}>Results - {allAnalyses.length} supplier{allAnalyses.length!==1?"s":""}</div>
                        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                          {/* View toggle */}
                          <div style={{display:"flex",background:"var(--bg-subtle2)",borderRadius:8,padding:2}}>
                            <button onClick={()=>setQuoteViewMode("cards")} style={{fontSize:12,fontWeight:600,padding:"5px 12px",borderRadius:6,border:"none",cursor:"pointer",background:quoteViewMode==="cards"?"var(--bg-card-solid)":"transparent",color:quoteViewMode==="cards"?"var(--text-primary)":"var(--text-tertiary)",boxShadow:quoteViewMode==="cards"?"var(--shadow-sm)":"none"}}>Cards</button>
                            <button onClick={()=>setQuoteViewMode("compare")} style={{fontSize:12,fontWeight:600,padding:"5px 12px",borderRadius:6,border:"none",cursor:"pointer",background:quoteViewMode==="compare"?"var(--bg-card-solid)":"transparent",color:quoteViewMode==="compare"?"var(--text-primary)":"var(--text-tertiary)",boxShadow:quoteViewMode==="compare"?"var(--shadow-sm)":"none"}}>Compare</button>
                          </div>
                          {/* Margin calculator */}
                          <div style={{display:"flex",alignItems:"center",gap:6,background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:8,padding:"4px 10px"}}>
                            <span style={{fontSize:11,fontWeight:600,color:"var(--green-deep)"}}>Markup</span>
                            <input type="number" min="0" max="200" value={marginPct} onChange={e=>setMarginPct(Math.max(0,Math.min(200,parseInt(e.target.value)||0)))} style={{width:46,padding:"3px 6px",border:"1px solid var(--green-light)",borderRadius:5,fontSize:12,outline:"none",fontFamily:"monospace",textAlign:"center"}}/>
                            <span style={{fontSize:11,fontWeight:600,color:"var(--green-deep)"}}>%</span>
                          </div>
                          <button onClick={()=>{
                            if (allAnalyses.length>0) setExpandedQuote(allAnalyses[0]._id);
                            setTimeout(()=>window.print(),300);
                          }} style={{fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontWeight:500}}><Icon name="printer" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Print</button>
                          <button onClick={()=>{setAllAnalyses([]);setExpandedQuote(null);setQuoteViewMode("cards");setMarginPct(0);}} style={{fontSize:12,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer"}}>Re-analyse</button>
                        </div>
                      </div>

                      {/* Margin summary bar - shows when markup is set */}
                      {marginPct>0&&(
                        <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:12,padding:"10px 14px",background:"var(--green-mint)",border:"1px solid var(--green-light)",borderRadius:10}}>
                          <span style={{fontSize:12,fontWeight:700,color:"var(--green-deep)"}}>At {marginPct}% markup:</span>
                          {allAnalyses.map(qa=>{
                            const cost = parsePrice(qa.estimatedTotal)||parsePrice(qa.subtotal);
                            if (!cost) return null;
                            const sell = cost*(1+marginPct/100);
                            return(
                              <span key={qa._id} style={{fontSize:12,color:"var(--text-secondary)"}}>
                                <strong style={{color:"var(--text-primary)"}}>{qa.supplierName}:</strong> £{cost.toFixed(2)} <Icon name="arrow_right" size={12} style={{verticalAlign:"-1px",margin:"0 2px"}}/> <strong style={{color:"var(--green-dark)"}}>£{sell.toFixed(2)}</strong> <span style={{color:"var(--text-tertiary)"}}>(+£{(sell-cost).toFixed(2)})</span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {quoteViewMode==="cards"&&allAnalyses.map((qa,qi)=>{
                        const vMap = {
                          excellent:{bg:"var(--green-light)",  border:"var(--green-dark)", text:"var(--green-deep)", label:"Excellent"},
                          good:     {bg:"var(--indigo-light)", border:"var(--indigo)",     text:"var(--indigo)",     label:"Good"},
                          partial:  {bg:"var(--amber-light)",  border:"var(--amber)",      text:"var(--amber)",      label:"Partial"},
                          poor:     {bg:"var(--red-light)",    border:"var(--red)",        text:"var(--red)",        label:"Poor"},
                        };
                        const vc = vMap[qa.overallVerdict||"good"]||vMap.good;
                        const isOpen = expandedQuote===qa._id;
                        const sc = qa.completeness>=80?"var(--green-dark)":qa.completeness>=60?"var(--amber)":"var(--red)";
                        const isApproved = approvedQuoteId===qa._id;
                        return(
                          <div key={qa._id||qi} style={{marginBottom:10,background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:"1px solid var(--border)",borderTop:`3px solid ${vc.border}`,overflow:"hidden",boxShadow:isOpen?"var(--shadow-md)":"var(--shadow-sm)",transition:"box-shadow 0.2s cubic-bezier(0.16,1,0.3,1)"}}>
                            <div onClick={()=>setExpandedQuote(isOpen?null:qa._id)} style={{padding:"14px 18px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",background:isOpen?vc.bg:"var(--bg-card-solid)",transition:"background 0.2s"}}>
                              <div style={{width:46,height:46,borderRadius:"50%",background:`conic-gradient(${sc} ${qa.completeness*3.6}deg, var(--bg-subtle2) 0deg)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                <div style={{width:34,height:34,borderRadius:"50%",background:"var(--bg-card-solid)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                                  <span style={{fontSize:11,fontWeight:800,color:sc,fontFamily:"monospace"}}>{qa.completeness}%</span>
                                </div>
                              </div>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                                  <span style={{fontSize:14,fontWeight:700,color:"var(--text-primary)"}}>{qa.supplierName}</span>
                                  <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,background:vc.bg,color:vc.text}}>{vc.label}</span>
                                  {isApproved&&<span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:99,background:"var(--green-light)",color:"var(--green-deep)"}}>Approved</span>}
                                </div>
                                <div style={{fontSize:12,color:"var(--text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{qa.recommendation}</div>
                              </div>
                              <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                                {qa.estimatedTotal&&qa.estimatedTotal!=="Not calculated"&&(
                                  <div style={{textAlign:"right"}}>
                                    <div style={{fontSize:10,color:"var(--text-muted)"}}>Total</div>
                                    <div style={{fontSize:13,fontWeight:700,color:"var(--green-dark)",fontFamily:"monospace"}}>{qa.estimatedTotal}</div>
                                  </div>
                                )}
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" style={{transform:isOpen?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s"}}><polyline points="6 9 12 15 18 9"/></svg>
                              </div>
                            </div>
                            {isOpen&&(
                              <div style={{borderTop:"1px solid var(--border)",padding:"18px",animation:"cardExpand 0.2s ease"}}>
                                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:16,padding:"12px 14px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>
                                  {[
                                    {l:"Completeness",v:`${qa.completeness}%`,c:sc},
                                    {l:"Subtotal",    v:qa.subtotal||"—",    c:"var(--text-primary)"},
                                    {l:"Carriage",    v:qa.carriageCharge||"—",c:"var(--text-secondary)"},
                                    {l:"Lead time",   v:qa.leadTime||"—",    c:"var(--text-secondary)"},
                                  ].map(s=>(
                                    <div key={s.l}>
                                      <div style={{fontSize:10,color:"var(--text-muted)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>{s.l}</div>
                                      <div style={{fontSize:14,fontWeight:700,color:s.c}}>{s.v}</div>
                                    </div>
                                  ))}
                                </div>
                                {qa.matched?.length>0&&(
                                  <div style={{marginBottom:14}}>
                                    <div style={{fontSize:12,fontWeight:600,color:"var(--green-dark)",marginBottom:8}}>Matched items ({qa.matched.length})</div>
                                    <div style={{overflowX:"auto"}}>
                                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:600}}>
                                        <thead>
                                          <tr style={{background:"var(--green-mint)"}}>
                                            {["Item","Req","Quoted","Unit price","Total","Stock","Qty ok","Notes"].map(h=>(
                                              <th key={h} style={{padding:"7px 10px",textAlign:"left",fontWeight:600,color:"var(--green-deep)",fontSize:11}}>{h}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {qa.matched.map((m,i)=>(
                                            <tr key={i} style={{borderTop:"1px solid var(--border)",background:i%2===0?"transparent":"var(--bg-subtle)"}}>
                                              <td style={{padding:"7px 10px",fontWeight:500,color:"var(--text-primary)"}}>{m.item}</td>
                                              <td style={{padding:"7px 10px",color:"var(--text-secondary)",fontFamily:"monospace",fontSize:11}}>{m.requestedQty} {m.requestedUnit}</td>
                                              <td style={{padding:"7px 10px",color:"var(--text-secondary)",fontFamily:"monospace",fontSize:11}}>{m.quotedQty||m.requestedQty} {m.quotedUnit||m.requestedUnit}</td>
                                              <td style={{padding:"7px 10px",color:"var(--green-dark)",fontFamily:"monospace",fontWeight:600}}>{m.unitPrice||"—"}</td>
                                              <td style={{padding:"7px 10px",fontFamily:"monospace"}}>{m.lineTotal||"—"}</td>
                                              <td style={{padding:"7px 10px"}}><span style={{fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:99,background:m.inStock===true?"var(--green-light)":m.inStock===false?"var(--red-light)":"var(--bg-subtle2)",color:m.inStock===true?"var(--green-dark)":m.inStock===false?"var(--red)":"var(--text-muted)"}}>{m.inStock===true?"In stock":m.inStock===false?"No stock":"—"}</span></td>
                                              <td style={{padding:"7px 10px"}}>{m.qtyMatch===false?<span style={{fontSize:10,color:"var(--amber)",fontWeight:700}}>!</span>:<span style={{fontSize:10,color:"var(--green-dark)"}}>ok</span>}</td>
                                              <td style={{padding:"7px 10px",fontSize:11,color:"var(--text-secondary)",maxWidth:140}}>{m.notes||"—"}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                                {qa.missing?.length>0&&(
                                  <div style={{marginBottom:12}}>
                                    <div style={{fontSize:12,fontWeight:600,color:"var(--red)",marginBottom:8}}>Missing ({qa.missing.length})</div>
                                    {qa.missing.map((m,i)=>(
                                      <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",borderBottom:"1px solid var(--border)"}}>
                                        <span style={{color:"var(--text-primary)"}}>{m.item}</span>
                                        <span style={{color:"var(--red)",fontSize:11}}>{m.reason}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {(qa.warnings?.length>0||qa.positives?.length>0)&&(
                                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                                    {qa.positives?.length>0&&(
                                      <div style={{background:"var(--green-mint)",borderRadius:"var(--radius-sm)",padding:"10px 12px"}}>
                                        <div style={{fontSize:11,fontWeight:700,color:"var(--green-dark)",marginBottom:6}}>Positives</div>
                                        {qa.positives.map((p,i)=><div key={i} style={{fontSize:12,color:"var(--green-deep)",marginBottom:2}}>+ {p}</div>)}
                                      </div>
                                    )}
                                    {qa.warnings?.length>0&&(
                                      <div style={{background:"var(--amber-light)",borderRadius:"var(--radius-sm)",padding:"10px 12px"}}>
                                        <div style={{fontSize:11,fontWeight:700,color:"var(--amber)",marginBottom:6}}>Warnings</div>
                                        {qa.warnings.map((w,i)=><div key={i} style={{fontSize:12,color:"var(--amber)",marginBottom:2}}>! {w}</div>)}
                                      </div>
                                    )}
                                  </div>
                                )}
                                <div style={{paddingTop:12,borderTop:"1px solid var(--border)",display:"flex",gap:10,flexWrap:"wrap"}}>
                                  {isApproved?(
                                    <>
                                      <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--green-light)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-sm)",padding:"8px 14px"}}>
                                        <span style={{fontSize:13,fontWeight:700,color:"var(--green-dark)"}}><Icon name="check_circle" size={14} color="var(--green-dark)" style={{marginRight:5,verticalAlign:"-2px"}}/>PO Approved</span>
                                      </div>
                                      <Btn outline onClick={handleUndoApproval}>Undo</Btn>
                                      <Btn onClick={()=>setView("orders")} color="#15824F">View in Orders</Btn>
                                    </>
                                  ):(
                                    <>
                                      <Btn onClick={()=>setApproveConfirm(qa)} color="#15824F">Approve & generate PO</Btn>
                                      <Btn outline onClick={()=>handleSaveDraftQuote(qa)}>Save to library</Btn>
                                    </>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* SIDE-BY-SIDE COMPARISON VIEW */}
                      {quoteViewMode==="compare"&&(
                        <div style={{overflowX:"auto",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",boxShadow:"var(--shadow-sm)"}}>
                          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:Math.max(500, 200+allAnalyses.length*160)}}>
                            <thead>
                              <tr>
                                <th style={{padding:"14px 16px",textAlign:"left",position:"sticky",left:0,background:"var(--bg-subtle)",zIndex:2,minWidth:180,borderBottom:"2px solid var(--border)",fontSize:11,fontWeight:700,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Requested item</th>
                                {allAnalyses.map(qa=>{
                                  const sc = qa.completeness>=80?"var(--green-dark)":qa.completeness>=60?"var(--amber)":"var(--red)";
                                  return(
                                    <th key={qa._id} style={{padding:"14px 16px",textAlign:"center",minWidth:160,borderBottom:"2px solid var(--border)",borderLeft:"1px solid var(--border)",background:"var(--bg-subtle)"}}>
                                      <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:4}}>{qa.supplierName}</div>
                                      <div style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,fontWeight:700,color:sc}}>
                                        <span style={{width:7,height:7,borderRadius:"50%",background:sc,display:"inline-block"}}/>
                                        {qa.completeness}% complete
                                      </div>
                                    </th>
                                  );
                                })}
                              </tr>
                            </thead>
                            <tbody>
                              {/* One row per requested item */}
                              {(activeReq.items||[]).map((reqItem,ri)=>(
                                <tr key={ri} style={{borderBottom:"1px solid var(--border)"}}>
                                  <td style={{padding:"10px 16px",position:"sticky",left:0,background:"var(--bg-card-solid)",zIndex:1,fontWeight:500,color:"var(--text-primary)",borderRight:"1px solid var(--border)"}}>
                                    {reqItem.description}
                                    <span style={{display:"block",fontSize:10,color:"var(--text-tertiary)",marginTop:1}}>{reqItem.quantity} {reqItem.unit}</span>
                                  </td>
                                  {allAnalyses.map(qa=>{
                                    const match = (qa.matched||[]).find(m=>m.item&&reqItem.description&&m.item.toLowerCase().includes(reqItem.description.toLowerCase().slice(0,12)) || (m.item&&reqItem.description&&reqItem.description.toLowerCase().includes(m.item.toLowerCase().slice(0,12))));
                                    const missing = (qa.missing||[]).find(m=>m.item&&reqItem.description&&(m.item.toLowerCase().includes(reqItem.description.toLowerCase().slice(0,12))||reqItem.description.toLowerCase().includes(m.item.toLowerCase().slice(0,12))));
                                    return(
                                      <td key={qa._id} style={{padding:"10px 16px",textAlign:"center",borderLeft:"1px solid var(--border)",background:!match&&missing?"var(--red-light)":"transparent"}}>
                                        {match?(
                                          <div>
                                            <div style={{fontSize:13,fontWeight:700,color:"var(--green-dark)",fontFamily:"monospace"}}>{match.unitPrice||match.lineTotal||"-"}</div>
                                            {match.inStock===false&&<div style={{fontSize:9,color:"var(--red)",fontWeight:600,marginTop:1}}>Out of stock</div>}
                                            {match.qtyMatch===false&&<div style={{fontSize:9,color:"var(--amber)",fontWeight:600,marginTop:1}}>Qty differs</div>}
                                          </div>
                                        ):missing?(
                                          <span style={{fontSize:11,color:"var(--red)",fontWeight:600}}>Not quoted</span>
                                        ):(
                                          <span style={{fontSize:11,color:"var(--text-muted)"}}>-</span>
                                        )}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                              {/* Summary rows */}
                              <tr style={{borderTop:"2px solid var(--border)",background:"var(--bg-subtle)"}}>
                                <td style={{padding:"10px 16px",position:"sticky",left:0,background:"var(--bg-subtle)",zIndex:1,fontWeight:700,color:"var(--text-secondary)",fontSize:11,textTransform:"uppercase",letterSpacing:"0.05em"}}>Carriage</td>
                                {allAnalyses.map(qa=>(
                                  <td key={qa._id} style={{padding:"10px 16px",textAlign:"center",borderLeft:"1px solid var(--border)",fontSize:12,color:qa.carriageCharge==="Free"?"var(--green-dark)":"var(--text-secondary)",fontWeight:qa.carriageCharge==="Free"?600:400}}>{qa.carriageCharge||"-"}</td>
                                ))}
                              </tr>
                              <tr style={{background:"var(--bg-subtle)"}}>
                                <td style={{padding:"10px 16px",position:"sticky",left:0,background:"var(--bg-subtle)",zIndex:1,fontWeight:700,color:"var(--text-secondary)",fontSize:11,textTransform:"uppercase",letterSpacing:"0.05em"}}>Lead time</td>
                                {allAnalyses.map(qa=>(
                                  <td key={qa._id} style={{padding:"10px 16px",textAlign:"center",borderLeft:"1px solid var(--border)",fontSize:12,color:"var(--text-secondary)"}}>{qa.leadTime||"-"}</td>
                                ))}
                              </tr>
                              <tr style={{background:"var(--green-mint)",borderTop:"2px solid var(--green-light)"}}>
                                <td style={{padding:"12px 16px",position:"sticky",left:0,background:"var(--green-mint)",zIndex:1,fontWeight:700,color:"var(--green-deep)",fontSize:12}}>Estimated total{marginPct>0?` (+ ${marginPct}% markup)`:""}</td>
                                {allAnalyses.map(qa=>{
                                  const cost = parsePrice(qa.estimatedTotal)||parsePrice(qa.subtotal);
                                  const allCosts = allAnalyses.map(a=>parsePrice(a.estimatedTotal)||parsePrice(a.subtotal)).filter(x=>x!=null);
                                  const isCheapest = cost!=null && allCosts.length>1 && cost===Math.min(...allCosts);
                                  const display = cost!=null ? (marginPct>0 ? cost*(1+marginPct/100) : cost) : null;
                                  return(
                                    <td key={qa._id} style={{padding:"12px 16px",textAlign:"center",borderLeft:"1px solid var(--green-light)"}}>
                                      <div style={{fontSize:15,fontWeight:800,color:"var(--green-dark)",fontFamily:"monospace"}}>{display!=null?`£${display.toFixed(2)}`:(qa.estimatedTotal||"-")}</div>
                                      {isCheapest&&<div style={{fontSize:9,fontWeight:700,color:"var(--green-deep)",background:"var(--green-light)",borderRadius:99,padding:"1px 8px",marginTop:4,display:"inline-block"}}>LOWEST</div>}
                                    </td>
                                  );
                                })}
                              </tr>
                              {/* Action row */}
                              <tr>
                                <td style={{padding:"12px 16px",position:"sticky",left:0,background:"var(--bg-card-solid)",zIndex:1}}></td>
                                {allAnalyses.map(qa=>{
                                  const isApproved = approvedQuoteId===qa._id;
                                  return(
                                    <td key={qa._id} style={{padding:"12px 16px",textAlign:"center",borderLeft:"1px solid var(--border)"}}>
                                      {isApproved?(
                                        <span style={{fontSize:11,fontWeight:700,color:"var(--green-dark)",background:"var(--green-light)",borderRadius:6,padding:"6px 12px",display:"inline-block"}}>Approved</span>
                                      ):(
                                        <button onClick={()=>setApproveConfirm(qa)} style={{fontSize:11,fontWeight:700,color:"white",background:"var(--green-dark)",border:"none",borderRadius:6,padding:"7px 14px",cursor:"pointer"}}>Approve</button>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {view==="orders"&&(
          <div className="stagger-in" style={{maxWidth:900}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24,flexWrap:"wrap",gap:12}}>
              <div>
                <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>Orders</h1>
                <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>{orders.length} total orders</p>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                {orders.length>0&&(
                  <button onClick={()=>downloadCSV(`orders-${new Date().toISOString().split("T")[0]}.csv`, orders.map(o=>({
                    PO: o.poNumber, Status: o.status, Supplier: o.supplier||"", Job: o.jobRef||"", Site: o.site||"",
                    EstimatedTotal: o.estimatedTotal||o.analysis?.estimatedTotal||"", PODate: o.poDate||"",
                    ExpectedDelivery: o.expectedDelivery?new Date(o.expectedDelivery).toLocaleDateString("en-GB"):"",
                    Items: (o.items||[]).map(i=>`${i.quantity} ${i.unit} ${i.description}`).join("; ")
                  })))} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"7px 14px",cursor:"pointer",fontWeight:500}}>
                    <Icon name="download" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Export
                  </button>
                )}
                {[
                  {id:"all",      label:"All",       count:orders.length},
                  {id:"active",   label:"Active",    count:orders.filter(o=>o.status!=="delivered").length},
                  {id:"delivered",label:"Delivered", count:orders.filter(o=>o.status==="delivered").length},
                ].map(f=>(
                  <button key={f.id} onClick={()=>setOrderFilter(f.id)}
                    style={{padding:"7px 16px",borderRadius:"var(--radius-sm)",border:`1px solid ${orderFilter===f.id?"var(--green-dark)":"var(--border)"}`,background:orderFilter===f.id?"var(--green-mint)":"var(--bg-card-solid)",color:orderFilter===f.id?"var(--green-deep)":"var(--text-secondary)",fontSize:13,fontWeight:orderFilter===f.id?600:400,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                    {f.label}
                    {f.count>0&&<span style={{fontSize:10,fontWeight:700,background:orderFilter===f.id?"var(--green-dark)":"var(--bg-subtle2)",color:orderFilter===f.id?"white":"var(--text-muted)",padding:"1px 6px",borderRadius:99}}>{f.count}</span>}
                  </button>
                ))}
              </div>
            </div>

            {orders.filter(o=>{
              if(orderFilter==="active") return o.status!=="delivered";
              if(orderFilter==="delivered") return o.status==="delivered";
              return true;
            }).length===0?(
              <Card style={{textAlign:"center",padding:"48px 32px",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:15,marginBottom:8}}>No orders yet</div>
                <div style={{fontSize:13}}>Approve a supplier quote to generate a purchase order</div>
              </Card>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {orders.filter(o=>{
                  if(orderFilter==="active") return o.status!=="delivered";
                  if(orderFilter==="delivered") return o.status==="delivered";
                  return true;
                }).map(order=>{
                  const STATUS_STEPS = [
                    {key:"pending-send",label:"Ready to send",color:"var(--green-dark)",  bg:"var(--green-mint)"},
                    {key:"sent",        label:"Sent",          color:"var(--indigo)",      bg:"var(--indigo-light)"},
                    {key:"confirmed",   label:"Confirmed",     color:"var(--green-dark)",  bg:"var(--green-light)"},
                    {key:"delivered",   label:"Delivered",     color:"var(--text-secondary)",bg:"var(--bg-subtle2)"},
                  ];
                  const stepIdx   = STATUS_STEPS.findIndex(s=>s.key===order.status);
                  const curStep   = STATUS_STEPS[stepIdx]||STATUS_STEPS[0];
                  const isExpanded = expandedOrder===order.id;

                  return(
                    <div key={order.id} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:`1px solid ${isExpanded?"var(--green-dark)":"var(--border)"}`,overflow:"hidden",boxShadow:isExpanded?"var(--shadow-md)":"var(--shadow-sm)",transition:"box-shadow 0.2s cubic-bezier(0.16,1,0.3,1),border-color 0.2s"}}>

                      {/* Clickable header row */}
                      <div onClick={()=>setExpandedOrder(isExpanded?null:order.id)}
                        style={{padding:"14px 20px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",background:isExpanded?"var(--green-mint)":"var(--bg-card-solid)",transition:"background 0.2s"}}>
                        <div style={{width:38,height:38,borderRadius:10,background:order.status==="pending-send"?"linear-gradient(135deg,#1E9E63,#15824F)":order.status==="sent"?"linear-gradient(135deg,#5B5BD6,#4A4AB8)":order.status==="confirmed"?"linear-gradient(135deg,#15824F,#047857)":"linear-gradient(135deg,#4B5563,#374151)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>
                          <Icon name={order.status==="pending-send"?"package":order.status==="sent"?"plane":order.status==="confirmed"?"check_circle":"flag"} size={18} color="white"/>
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2,flexWrap:"wrap"}}>
                            <span style={{fontSize:14,fontWeight:700,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{order.poNumber}</span>
                            <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:99,background:curStep.bg,color:curStep.color}}>{curStep.label}</span>
                          </div>
                          <div style={{fontSize:12,color:"var(--text-secondary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{order.supplier} · {order.jobRef} · {order.site}</div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
                          {order.expectedDelivery&&order.status!=="delivered"&&(
                            <span style={{fontSize:11,color:"var(--green-dark)",background:"var(--green-light)",padding:"3px 10px",borderRadius:99,fontWeight:500}}>{new Date(order.expectedDelivery).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span>
                          )}
                          <span style={{fontSize:11,color:"var(--text-muted)"}}>{order.poDate}</span>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" style={{transform:isExpanded?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s",flexShrink:0}}><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                      </div>

                      {/* Expanded body */}
                      {isExpanded&&(
                        <div style={{borderTop:"1px solid var(--border)",animation:"cardExpand 0.2s ease"}}>

                          {/* Status timeline */}
                          <div style={{padding:"16px 20px",borderBottom:"1px solid var(--border)",background:"var(--bg-subtle)"}}>
                            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:4}}>
                              {STATUS_STEPS.map((s,i)=>(
                                <div key={s.key} style={{display:"flex",alignItems:"center",flex:i<STATUS_STEPS.length-1?1:"none"}}>
                                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                                    <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,background:stepIdx>i?s.color:stepIdx===i?s.color:"var(--bg-subtle2)",color:stepIdx>=i?"white":"var(--text-muted)",border:`2px solid ${stepIdx>=i?s.color:"var(--border)"}`}}>
                                      {stepIdx>i?<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>:i+1}
                                    </div>
                                    <span style={{fontSize:9,color:stepIdx===i?s.color:"var(--text-muted)",fontWeight:stepIdx===i?700:400,whiteSpace:"nowrap"}}>{s.label}</span>
                                  </div>
                                  {i<STATUS_STEPS.length-1&&<div style={{flex:1,height:2,background:stepIdx>i?s.color:"var(--bg-subtle2)",margin:"0 4px",marginBottom:14}}/>}
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Order details */}
                          <div style={{padding:"16px 20px",display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:16}}>
                            {/* Left: items */}
                            <div>
                              <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.08em"}}>Order items</div>
                              {(order.items||[]).map((item,i)=>(
                                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--border)"}}>
                                  <div style={{fontSize:13,color:"var(--text-primary)",flex:1}}>{item.description}</div>
                                  <div style={{fontSize:12,color:"var(--text-secondary)",fontFamily:"monospace",flexShrink:0,marginLeft:12}}>{item.quantity} {item.unit}</div>
                                </div>
                              ))}
                              <div style={{marginTop:12}}>
                                <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Supplier</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{order.supplier}</span></div>
                                <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Job ref</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{order.jobRef}</span></div>
                                {order.estimatedTotal&&<div style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Total</span><span style={{fontSize:12,fontWeight:700,color:"var(--green-dark)",fontFamily:"monospace"}}>{order.estimatedTotal}</span></div>}
                              </div>
                            </div>

                            {/* Right: actions */}
                            <div>
                              <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.08em"}}>Actions</div>

                              {order.status==="pending-send"&&(
                                <div>
                                  <div style={{marginBottom:10}}>
                                    <label style={{fontSize:11,color:"var(--text-secondary)",display:"block",marginBottom:5}}>Note to supplier (optional)</label>
                                    <textarea value={orderNote[order.id]||""} onChange={e=>setOrderNote(p=>({...p,[order.id]:e.target.value}))} placeholder="Any special instructions..." style={{width:"100%",height:70,padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:12,outline:"none",resize:"none",fontFamily:"inherit"}}></textarea>
                                  </div>
                                  <div style={{marginBottom:12}}>
                                    <label style={{fontSize:11,color:"var(--text-secondary)",display:"block",marginBottom:5}}>Expected delivery date</label>
                                    <input type="date" value={expectedDelivery[order.id]||""} onChange={e=>setExpectedDelivery(p=>({...p,[order.id]:e.target.value}))} style={{padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                                  </div>
                                  {settings.resendKey?(
                                    <Btn onClick={()=>handleSendOrder(order)} disabled={sendingOrder===order.id} color="#15824F">
                                      {sendingOrder===order.id?<><Spinner/> Sending...</>:"Send order to supplier"}
                                    </Btn>
                                  ):(
                                    <div style={{fontSize:12,color:"var(--text-tertiary)"}}>Add Resend key in Settings to send orders by email</div>
                                  )}
                                </div>
                              )}

                              {order.status==="sent"&&(
                                <div>
                                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:10}}>Mark this order as confirmed manually, or upload the supplier's confirmation document.</div>
                                  <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                                    <Btn onClick={()=>{setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"confirmed",confirmedAt:new Date().toISOString()}:o));logActivity("Order confirmed",`${order.poNumber} (${order.supplier}) marked as confirmed`,{entity:"order",jobRef:order.jobRef});}} color="#15824F">Mark as confirmed</Btn>
                                    <Btn outline onClick={()=>{setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"delivered",deliveredAt:new Date().toISOString()}:o));logActivity("Order delivered",`${order.poNumber} (${order.supplier}) marked as delivered`,{entity:"order",jobRef:order.jobRef});}}>Mark as delivered</Btn>
                                  </div>
                                  <label style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:"var(--bg-subtle)",border:"1px dashed var(--border)",borderRadius:"var(--radius-sm)",cursor:"pointer",marginBottom:10}}>
                                    <input type="file" accept=".pdf,.jpg,.png,.doc,.docx" style={{display:"none"}} onChange={e=>handleOrderConfirmationUpload(e.target.files[0],order.id)}/>
                                    <span style={{fontSize:13,color:"var(--text-secondary)"}}>Or upload confirmation document</span>
                                    <span style={{fontSize:12,color:"var(--text-muted)"}}>PDF, Word, or image</span>
                                  </label>
                                  <div style={{fontSize:11,color:"var(--text-tertiary)"}}>Expected delivery: {order.expectedDelivery?new Date(order.expectedDelivery).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}):"Not set"}</div>
                                </div>
                              )}

                              {order.status==="confirmed"&&(
                                <div>
                                  {order.confirmationDoc&&<div style={{fontSize:12,color:"var(--green-dark)",marginBottom:10}}>Confirmation received: {order.confirmationDoc.label||"document"}</div>}
                                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:12}}>Expected delivery: {order.expectedDelivery?new Date(order.expectedDelivery).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}):"Not set"}</div>
                                  <Btn onClick={()=>{setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"delivered",deliveredAt:new Date().toISOString()}:o));logActivity("Order delivered",`${order.poNumber} (${order.supplier}) marked as delivered`,{entity:"order",jobRef:order.jobRef});}} color="#15824F">Mark as delivered</Btn>
                                </div>
                              )}

                              {order.status==="delivered"&&(
                                <div>
                                  <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--green-light)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-sm)",padding:"12px 16px"}}>
                                    <span style={{fontSize:16}}>D</span>
                                    <div>
                                      <div style={{fontSize:13,fontWeight:600,color:"var(--green-dark)"}}>Order delivered</div>
                                      {order.deliveredAt&&<div style={{fontSize:11,color:"var(--green-dark)",opacity:0.8}}>{new Date(order.deliveredAt).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</div>}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {view==="suppliers"&&(
          <div className="stagger-in" style={{maxWidth:900}}>
            <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",marginBottom:4,color:"var(--text-primary)"}}>Suppliers</h1>
            <p style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Manage your supplier accounts and contact details</p>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:24}}>
              {suppliers.map(s=>(
                <Card key={s.id}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div style={{width:40,height:40,background:"linear-gradient(135deg,var(--green),var(--green-dark))",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"white",fontWeight:700,fontSize:16,flexShrink:0}}>{s.name[0]}</div>
                    <button onClick={()=>setSuppliers(p=>p.filter(x=>x.id!==s.id))} style={{fontSize:11,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:6,padding:"3px 8px",cursor:"pointer"}}>Remove</button>
                  </div>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:3}}>{s.name}</div>
                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:8}}>{s.email}</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
                    {(s.categories||[]).map(cat=><Badge key={cat} bg="var(--green-light)" text="var(--green-deep)">{cat}</Badge>)}
                  </div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:4}}>
                  {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--bg-subtle2)",color:"var(--text-tertiary)"}}>
                      {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length} RFQ{requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length!==1?"s":""}
                    </span>
                  )}
                  {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=80?"var(--green-light)":Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=50?"var(--amber-light)":"var(--red-light)",color:Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=80?"var(--green-dark)":Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)>=50?"var(--amber)":"var(--red)"}}>
                      {Math.round(requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length/requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length*100)}% response
                    </span>
                  )}
                  {quoteLibrary.filter(q=>q.supplierName===s.name).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=80?"var(--green-light)":Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=60?"var(--amber-light)":"var(--red-light)",color:Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=80?"var(--green-dark)":Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)>=60?"var(--amber)":"var(--red)"}}>
                      avg {Math.round(quoteLibrary.filter(q=>q.supplierName===s.name).reduce((a,q)=>a+(q.completeness||0),0)/quoteLibrary.filter(q=>q.supplierName===s.name).length)}%
                    </span>
                  )}
                  {orders.filter(o=>o.supplier===s.name).length>0&&(
                    <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:"var(--indigo-light)",color:"var(--indigo)"}}>
                      {orders.filter(o=>o.supplier===s.name).length} PO{orders.filter(o=>o.supplier===s.name).length!==1?"s":""}
                    </span>
                  )}
                  {requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length===0&&quoteLibrary.filter(q=>q.supplierName===s.name).length===0&&(
                    <span style={{fontSize:11,color:"var(--text-muted)"}}>No activity yet</span>
                  )}
                </div>
                </Card>
              ))}
            </div>
            <Card>
              <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:14}}>Add a supplier</div>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr 1fr auto",gap:10,alignItems:"end"}}>
                {[
                  {label:"Company name",val:"name",ph:"e.g. BSS Industrial"},
                  {label:"Quote email",val:"email",ph:"quotes@supplier.co.uk"},
                  {label:"Trades (comma-sep)",val:"categories",ph:"Plumbing, HVAC"},
                ].map(f=>(
                  <div key={f.val}>
                    <label style={{fontSize:11,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:5}}>{f.label}</label>
                    <input value={newSup[f.val]||""} onChange={e=>setNewSup(p=>({...p,[f.val]:e.target.value}))} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                ))}
                <Btn onClick={()=>{
                  if(!newSup.name?.trim()||!newSup.email?.trim()){showToast("Name and email required","warn");return;}
                  const ns={id:Date.now(),name:newSup.name.trim(),email:newSup.email.trim(),categories:(newSup.categories||"General").split(",").map(s=>s.trim()).filter(Boolean)};
                  setSuppliers(p=>[...p,ns]);setNewSup({name:"",email:"",categories:""});showToast(`${ns.name} added`);
                }} color="#15824F">Add</Btn>
              </div>
            </Card>
          </div>
        )}

        {view==="requests"&&(
          <div className="stagger-in" style={{maxWidth:1000}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
              <div>
                <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>All requests</h1>
                <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>{requests.length} total requests</p>
              </div>
              <div style={{display:"flex",gap:8}}>
                {requests.length>0&&(
                  <button onClick={()=>downloadCSV(`requests-${new Date().toISOString().split("T")[0]}.csv`, requests.map(r=>({
                    ID:r.id, JobRef:r.jobRef||"", Site:r.site||"", Trade:r.trade||"", Status:r.status||"",
                    Created:r.created||"", Items:(r.items||[]).length, Suppliers:(r.sentTo||[]).length,
                    QuotesIn:(r.sentTo||[]).filter(s=>s.saved).length, Notes:r.notes||""
                  })))} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer",fontWeight:500}}><Icon name="download" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Export</button>
                )}
                <Btn onClick={()=>{setView("new");resetNewRequest();}} color="#15824F">+ New request</Btn>
              </div>
            </div>

            {/* Filter bar */}
            {requests.length>0&&(
              <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
                <input value={reqSearch} onChange={e=>setReqSearch(e.target.value)} placeholder="Search job ref or site..." style={{flex:"1 1 200px",minWidth:160,padding:"9px 14px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                <select value={reqFilterStatus} onChange={e=>setReqFilterStatus(e.target.value)} style={{padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",cursor:"pointer"}}>
                  <option value="all">All statuses</option>
                  <option value="draft">Draft</option>
                  <option value="pending">Pending quotes</option>
                  <option value="received">Quotes received</option>
                  <option value="approved">Approved</option>
                </select>
                <select value={reqFilterTrade} onChange={e=>setReqFilterTrade(e.target.value)} style={{padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",cursor:"pointer"}}>
                  <option value="all">All trades</option>
                  {TRADES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
                {(reqFilterStatus!=="all"||reqFilterTrade!=="all"||reqSearch)&&(
                  <button onClick={()=>{setReqFilterStatus("all");setReqFilterTrade("all");setReqSearch("");}} style={{fontSize:12,color:"var(--text-secondary)",background:"var(--bg-subtle2)",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer"}}>Clear</button>
                )}
              </div>
            )}
            <Card>
              {requests.length===0?(
                <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)"}}>
                  <div style={{fontSize:15,marginBottom:8}}>No requests yet</div>
                  <div style={{fontSize:13}}>Create your first material request to get started</div>
                </div>
              ):(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"80px 1fr 120px 100px 80px 140px",gap:8,padding:"10px 16px",background:"var(--bg-subtle)",fontSize:11,fontWeight:600,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em",borderRadius:"var(--radius-sm) var(--radius-sm) 0 0"}}>
                    <span>ID</span><span>Job ref</span><span>Trade</span><span>Status</span><span>Quotes</span><span>Actions</span>
                  </div>
                  {requests.filter(r=>{
                    if(reqFilterStatus!=="all"&&r.status!==reqFilterStatus) return false;
                    if(reqFilterTrade!=="all"&&r.trade!==reqFilterTrade) return false;
                    if(reqSearch){
                      const q=reqSearch.toLowerCase();
                      if(!((r.jobRef||"").toLowerCase().includes(q)||(r.site||"").toLowerCase().includes(q)||(r.id||"").toLowerCase().includes(q))) return false;
                    }
                    return true;
                  }).map((r,idx)=>{
                    const sc = STATUS[r.status]||STATUS.draft;
                    const quotesIn = (r.sentTo||[]).filter(s=>s.saved).length;
                    const quotesTotal = (r.sentTo||[]).length;
                    return(
                      <div key={r.id} style={{display:"grid",gridTemplateColumns:"80px 1fr 120px 100px 80px 140px",gap:8,padding:"12px 16px",borderTop:"1px solid var(--border)",alignItems:"center",fontSize:13}}>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",color:"var(--green-dark)",fontWeight:600,fontSize:12}}>{r.id}</span>
                        <div>
                          <div style={{fontWeight:500,color:"var(--text-primary)"}}>{r.jobRef}</div>
                          <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:1}}>{r.site}{r.notes&&<span style={{marginLeft:6,color:"var(--amber)",fontStyle:"italic"}}>· {r.notes.slice(0,35)}{r.notes.length>35?"...":""}</span>}</div>
                        </div>
                        <span style={{fontSize:12,color:"var(--text-secondary)"}}>{r.trade}</span>
                        <Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge>
                        <span style={{fontSize:12,color:"var(--text-secondary)"}}>{quotesIn}/{quotesTotal}</span>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          <button onClick={()=>{setActiveReq(r);setView("quotes");}} style={{fontSize:11,color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View</button>
                          <button onClick={()=>handleDuplicate(r)} style={{fontSize:11,color:"var(--green-dark)",background:"none",border:"none",cursor:"pointer"}}>Duplicate</button>
                          <button onClick={()=>{setEditModal(r);setEditForm({jobRef:r.jobRef,site:r.site,status:r.status,notes:r.notes||""});}} style={{fontSize:11,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer"}}>Edit</button>
                          <button onClick={()=>setActivityModal(r)} style={{fontSize:11,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer"}}>Log{r.activity?.length?` (${r.activity.length})`:""}</button>
                          <button onClick={()=>setDeleteConfirm(r)} style={{fontSize:11,color:"var(--red)",background:"none",border:"none",cursor:"pointer"}}>Del</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        )}

        {view==="library"&&(
          <div className="stagger-in" style={{maxWidth:1000}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:12}}>
              <div>
                <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",margin:0,color:"var(--text-primary)"}}>Quote library</h1>
                <p style={{fontSize:14,color:"var(--text-secondary)",marginTop:4}}>{quoteLibrary.length} quotes saved · Supplier price history</p>
              </div>
              {quoteLibrary.length>0&&(
                <button onClick={()=>downloadCSV(`quote-library-${new Date().toISOString().split("T")[0]}.csv`, quoteLibrary.map(q=>({
                  Date: q.savedAt?new Date(q.savedAt).toLocaleDateString("en-GB"):"",
                  Supplier: q.supplierName, Job: q.jobRef||"", Site: q.site||"", Trade: q.trade||"",
                  Completeness: (q.completeness||0)+"%", EstimatedTotal: q.totalEstimate||"",
                  Carriage: q.carriageCharge||"", Expiry: q.expiryDate?new Date(q.expiryDate).toLocaleDateString("en-GB"):""
                })))} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"9px 16px",cursor:"pointer",fontWeight:500}}>
                  <Icon name="download" size={13} style={{marginRight:5,verticalAlign:"-2px"}}/>Export CSV
                </button>
              )}
            </div>
            {supplierScoreCards.length>0&&(
              <div style={{marginBottom:24}}>
                <div style={{fontSize:13,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>Supplier scorecards</div>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(3,1fr)",gap:12}}>
                  {supplierScoreCards.map(sc=>(
                    <Card key={sc.name}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div>
                          <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>{sc.name}</div>
                          <div style={{fontSize:11,color:"var(--text-tertiary)"}}>{sc.quotes.length} quotes</div>
                        </div>
                        <div style={{fontSize:26,fontWeight:800,color:sc.avgCompleteness>=80?"var(--green-dark)":sc.avgCompleteness>=60?"var(--amber)":"var(--red)",fontFamily:"monospace"}}>{sc.avgCompleteness}%</div>
                      </div>
                      <div style={{height:4,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${sc.avgCompleteness}%`,background:sc.avgCompleteness>=80?"var(--green-dark)":sc.avgCompleteness>=60?"var(--amber)":"var(--red)",borderRadius:99}}/>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
            <Card>
              {quoteLibrary.length===0?(
                <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)"}}>
                  <div style={{fontSize:15,marginBottom:8}}>No quotes in library yet</div>
                  <div style={{fontSize:13}}>Quotes are saved here when you approve a PO or save a draft</div>
                </div>
              ):(
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{background:"var(--bg-subtle)"}}>
                        {["Date","Supplier","Job","Trade","Completeness","Est. Total","Carriage","Expiry",""].map(h=>(
                          <th key={h} style={{padding:"9px 12px",textAlign:"left",fontWeight:600,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {quoteLibrary.map((q,i)=>(
                        <tr key={q.id||i} style={{borderTop:"1px solid var(--border)"}}>
                          <td style={{padding:"9px 12px",color:"var(--text-tertiary)"}}>{q.savedAt?new Date(q.savedAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"2-digit"}):"—"}</td>
                          <td style={{padding:"9px 12px",fontWeight:500,color:"var(--text-primary)"}}>{q.supplierName}</td>
                          <td style={{padding:"9px 12px",fontFamily:"monospace",color:"var(--indigo)",fontSize:11}}>{q.jobRef}</td>
                          <td style={{padding:"9px 12px"}}><Badge bg="var(--bg-subtle2)" text="var(--text-secondary)">{q.trade}</Badge></td>
                          <td style={{padding:"9px 12px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              <div style={{width:50,height:4,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                                <div style={{height:"100%",width:`${q.completeness}%`,background:q.completeness>=80?"var(--green-dark)":q.completeness>=60?"var(--amber)":"var(--red)",borderRadius:99}}/>
                              </div>
                              <span style={{fontSize:11,fontWeight:600,color:q.completeness>=80?"var(--green-dark)":q.completeness>=60?"var(--amber)":"var(--red)"}}>{q.completeness}%</span>
                            </div>
                          </td>
                          <td style={{padding:"9px 12px",fontFamily:"monospace",color:"var(--green-dark)",fontWeight:600}}>{q.totalEstimate||"—"}</td>
                          <td style={{padding:"9px 12px",fontSize:11,color:q.carriageCharge==="Free"?"var(--green-dark)":"var(--text-secondary)"}}>{q.carriageCharge||"—"}</td>
                          <td style={{padding:"9px 12px"}}>
                            {q.expiryDate&&(
                              <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:99,background:Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=0?"var(--red-light)":Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=5?"var(--amber-light)":"var(--green-light)",color:Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=0?"var(--red)":Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=5?"var(--amber)":"var(--green-dark)"}}>
                                {Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)<=0?"Expired":`${Math.ceil((new Date(q.expiryDate).getTime()-Date.now())/86400000)}d left`}
                              </span>
                            )}
                          </td>
                          <td style={{padding:"9px 12px",textAlign:"right"}}>
                            <button onClick={()=>{
                              setQuoteLibrary(prev=>{const n=prev.filter(x=>x.id!==q.id);try{localStorage.setItem("piq_quote_library",JSON.stringify(n))}catch{};return n;});
                              logActivity("Library quote removed",`${q.supplierName} - ${q.jobRef||""} removed from library`,{entity:"quote"});
                              showToast("Quote removed from library");
                            }} title="Remove from library" style={{background:"none",border:"none",cursor:"pointer",color:"var(--text-muted)",padding:4,borderRadius:6,display:"inline-flex"}}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}

        {view==="help"&&(
          <div className="stagger-in" style={{maxWidth:900}}>
            <div style={{background:"linear-gradient(135deg,#0A0F1E,#1a2744)",borderRadius:20,padding:"36px 40px",marginBottom:28,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,background:"radial-gradient(circle,rgba(34,197,94,0.12),transparent 70%)",borderRadius:"50%"}}/>
              <div style={{position:"relative",zIndex:1}}>
                <div style={{fontSize:11,color:"#5BE3A0",letterSpacing:"0.18em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>ProQuote Help Centre</div>
                <h1 style={{fontSize:30,fontWeight:800,color:"white",margin:0,letterSpacing:"-0.03em",marginBottom:8}}>How can we help?</h1>
                <p style={{fontSize:14,color:"rgba(148,163,184,0.9)",margin:0}}>Ask the AI assistant or browse the FAQ below</p>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:20,marginBottom:28}}>
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",boxShadow:"var(--shadow-sm)",overflow:"hidden",display:"flex",flexDirection:"column"}}>
                {/* Chat header */}
                <div style={{display:"flex",alignItems:"center",gap:12,padding:"16px 18px",borderBottom:"1px solid var(--border)",background:"linear-gradient(135deg,#1E9E63,#15824F)"}}>
                  <div style={{position:"relative",flexShrink:0}}>
                    <div style={{width:40,height:40,borderRadius:"50%",background:"rgba(255,255,255,0.18)",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"}}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/><circle cx="8.5" cy="14.5" r="1.5" fill="white"/><circle cx="15.5" cy="14.5" r="1.5" fill="white"/></svg>
                    </div>
                    {settings.openRouterKey&&<div style={{position:"absolute",bottom:0,right:0,width:11,height:11,borderRadius:"50%",background:"#4ADE80",border:"2px solid #15824F"}}/>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:15,fontWeight:700,color:"white"}}>ProQuote Assistant</div>
                    <div style={{fontSize:12,color:"rgba(255,255,255,0.85)",display:"flex",alignItems:"center",gap:5}}>
                      {settings.openRouterKey?<><span style={{width:6,height:6,borderRadius:"50%",background:"#4ADE80",display:"inline-block"}}/>Online · ready to help</>:"Add OpenRouter key to chat"}
                    </div>
                  </div>
                </div>

                {/* Messages */}
                <div style={{flex:1,minHeight:300,maxHeight:380,overflowY:"auto",display:"flex",flexDirection:"column",gap:12,padding:"18px"}}>
                  {helpMessages.length===0&&(
                    <div style={{display:"flex",flexDirection:"column",gap:14,paddingTop:8}}>
                      <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                        <div style={{width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name="wave" size={16} color="white"/></div>
                        <div style={{background:"var(--bg-subtle)",borderRadius:"4px 14px 14px 14px",padding:"12px 16px",fontSize:13,lineHeight:1.6,color:"var(--text-primary)",maxWidth:"85%"}}>
                          Hi! I'm your ProQuote assistant. Ask me anything about creating requests, analysing quotes, managing orders, or any feature in the app.
                        </div>
                      </div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8,paddingLeft:40}}>
                        {["How do I send an RFQ?","How does quote analysis work?","Where are my saved quotes?","How do I import a spreadsheet?"].map(q=>(
                          <button key={q} onClick={()=>handleHelpChat(q)} disabled={!settings.openRouterKey} style={{fontSize:12,padding:"7px 13px",borderRadius:99,border:"1px solid var(--green-light)",background:"var(--green-mint)",color:"var(--green-deep)",cursor:settings.openRouterKey?"pointer":"not-allowed",fontWeight:500}}>{q}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {helpMessages.map((m,i)=>(
                    <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start",flexDirection:m.role==="user"?"row-reverse":"row"}}>
                      <div style={{width:30,height:30,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,background:m.role==="user"?"var(--bg-subtle2)":"linear-gradient(135deg,#1E9E63,#15824F)",color:m.role==="user"?"var(--text-secondary)":"white",fontWeight:700}}>
                        {m.role==="user"?(settings.contactName?settings.contactName[0].toUpperCase():"Y"):"AI"}
                      </div>
                      <div style={{maxWidth:"82%",padding:"11px 15px",borderRadius:m.role==="user"?"14px 4px 14px 14px":"4px 14px 14px 14px",background:m.role==="user"?"linear-gradient(135deg,#1E9E63,#15824F)":"var(--bg-subtle)",color:m.role==="user"?"white":"var(--text-primary)",fontSize:13,lineHeight:1.65,whiteSpace:"pre-wrap"}}>
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {helpLoading&&(
                    <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <div style={{width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,#1E9E63,#15824F)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,fontWeight:700,color:"white"}}>AI</div>
                      <div style={{background:"var(--bg-subtle)",borderRadius:"4px 14px 14px 14px",padding:"14px 16px",display:"flex",gap:4,alignItems:"center"}}>
                        <span style={{width:7,height:7,borderRadius:"50%",background:"var(--text-tertiary)",animation:"typingDot 1.2s infinite 0s"}}/>
                        <span style={{width:7,height:7,borderRadius:"50%",background:"var(--text-tertiary)",animation:"typingDot 1.2s infinite 0.2s"}}/>
                        <span style={{width:7,height:7,borderRadius:"50%",background:"var(--text-tertiary)",animation:"typingDot 1.2s infinite 0.4s"}}/>
                      </div>
                    </div>
                  )}
                </div>

                {/* Input */}
                <div style={{display:"flex",gap:8,padding:"14px 16px",borderTop:"1px solid var(--border)",background:"var(--bg-subtle)"}}>
                  <input value={helpInput} onChange={e=>setHelpInput(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&handleHelpChat(helpInput)}
                    placeholder={settings.openRouterKey?"Type your question...":"Add OpenRouter key in Settings"}
                    disabled={!settings.openRouterKey}
                    style={{flex:1,padding:"11px 15px",border:"1px solid var(--border)",borderRadius:99,fontSize:13,outline:"none",background:"var(--bg-card-solid)"}}
                  />
                  <button onClick={()=>handleHelpChat(helpInput)} disabled={!helpInput.trim()||helpLoading||!settings.openRouterKey} style={{width:42,height:42,borderRadius:"50%",border:"none",background:(!helpInput.trim()||helpLoading||!settings.openRouterKey)?"var(--bg-subtle2)":"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",cursor:(!helpInput.trim()||helpLoading||!settings.openRouterKey)?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <Card>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:10}}>Quick actions</div>
                  {[
                    {label:"Create a new request",action:()=>{setView("new");resetNewRequest();}},
                    {label:"Analyse supplier quotes",action:()=>setView("quotes")},
                    {label:"View & send orders",action:()=>setView("orders")},
                    {label:"Manage suppliers",action:()=>setView("suppliers")},
                    {label:"Configure settings",action:()=>setView("settings")},
                  ].map(l=>(
                    <button key={l.label} onClick={l.action} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:"var(--radius-sm)",border:"none",background:"transparent",cursor:"pointer",textAlign:"left",marginBottom:2,fontSize:13,color:"var(--text-primary)",transition:"background 0.15s"}}
                      onMouseEnter={e=>e.currentTarget.style.background="var(--bg-subtle)"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      {l.label}
                    </button>
                  ))}
                </Card>
                <Card>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:10}}>Keyboard shortcuts</div>
                  {[["N","New request"],["Q","Quote analysis"],["O","Orders"],["D","Dashboard"],["S","Settings"],["H","Help"],["Esc","Close modals"]].map(([k,l])=>(
                    <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid var(--border)"}}>
                      <span style={{fontSize:12,color:"var(--text-secondary)"}}>{l}</span>
                      <kbd style={{background:"var(--bg-subtle2)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:5,padding:"2px 8px",fontSize:11,fontFamily:"monospace",fontWeight:600}}>{k}</kbd>
                    </div>
                  ))}
                </Card>
              </div>
            </div>
            <Card>
              <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",marginBottom:20}}>Frequently asked questions</div>
              {helpFaqs.map((section,si)=>(
                <div key={si} style={{marginBottom:20}}>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--green-dark)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10,paddingBottom:6,borderBottom:"2px solid var(--green-light)"}}>{section.cat}</div>
                  {section.qs.map((faq,i)=>(
                    <details key={i} style={{marginBottom:6}}>
                      <summary style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",cursor:"pointer",padding:"10px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center",userSelect:"none"}}>
                        {faq.q}
                        <span style={{color:"var(--text-muted)",fontSize:12}}>+</span>
                      </summary>
                      <div style={{fontSize:13,color:"var(--text-secondary)",padding:"10px 12px",lineHeight:1.7,borderLeft:"3px solid var(--green-dark)",marginLeft:4,marginTop:4}}>{faq.a}</div>
                    </details>
                  ))}
                </div>
              ))}
            </Card>
            <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"14px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,marginTop:16}}>
              <span style={{fontSize:13,fontWeight:700,color:"var(--text-primary)"}}>Pro<span style={{color:"var(--green-dark)"}}>Quote</span> v1.0</span>
              <button onClick={()=>setView("contact")} style={{fontSize:12,color:"var(--green-dark)",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>Contact support</button>
            </div>
          </div>
        )}

        {view==="contact"&&(
          <div className="stagger-in" style={{maxWidth:760}}>
            <div style={{background:"linear-gradient(135deg,#0A0F1E,#1a2744)",borderRadius:20,padding:"36px 40px",marginBottom:28,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,background:"radial-gradient(circle,rgba(99,102,241,0.12),transparent 70%)",borderRadius:"50%"}}/>
              <div style={{position:"relative",zIndex:1}}>
                <div style={{fontSize:11,color:"#818CF8",letterSpacing:"0.15em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>ProQuote Support</div>
                <h1 style={{fontSize:30,fontWeight:800,color:"white",margin:0,letterSpacing:"-0.03em",marginBottom:8}}>Contact us</h1>
                <p style={{fontSize:14,color:"rgba(148,163,184,0.9)",margin:0}}>Raise a support request, report a bug, or suggest a feature</p>
              </div>
            </div>
            {contactSent?(
              <Card style={{textAlign:"center",padding:"48px 40px"}}>
                <div style={{fontSize:36,marginBottom:16}}>ok</div>
                <div style={{fontSize:20,fontWeight:700,color:"var(--text-primary)",marginBottom:8}}>Request sent</div>
                <div style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Thank you for getting in touch. We will respond as soon as possible.</div>
                <div style={{display:"flex",gap:10,justifyContent:"center"}}>
                  <button onClick={()=>setContactSent(false)} style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 20px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Send another</button>
                  <button onClick={()=>setView("dashboard")} style={{background:"linear-gradient(135deg,#1E9E63,#15824F)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 20px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Back to dashboard</button>
                </div>
              </Card>
            ):(
              <Card>
                <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",marginBottom:20}}>Submit a support request</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Your name</label>
                    <input value={contactForm.name} onChange={e=>setContactForm(p=>({...p,name:e.target.value}))} placeholder="Your name" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Email address</label>
                    <input type="email" value={contactForm.email} onChange={e=>setContactForm(p=>({...p,email:e.target.value}))} placeholder="your@email.co.uk" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Category</label>
                    <select value={contactForm.category} onChange={e=>setContactForm(p=>({...p,category:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                      {["Bug report","Feature request","Account issue","General enquiry"].map(o=><option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Priority</label>
                    <select value={contactForm.priority} onChange={e=>setContactForm(p=>({...p,priority:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                      {["Low","Normal","High","Urgent"].map(o=><option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{marginBottom:14}}>
                  <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Description</label>
                  <textarea value={contactForm.description} onChange={e=>setContactForm(p=>({...p,description:e.target.value}))} placeholder="Please describe your issue in as much detail as possible..." style={{width:"100%",height:120,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit",lineHeight:1.6}}></textarea>
                </div>
                <button
                  onClick={()=>{
                    if(!contactForm.description.trim()){showToast("Please add a description","warn");return;}
                    showToast("Support request submitted");
                    setContactSent(true);
                    setContactForm(p=>({...p,description:""}));
                  }}
                  disabled={!contactForm.name.trim()||!contactForm.email.trim()||!contactForm.description.trim()}
                  style={{background:"linear-gradient(135deg,#5B5BD6,#4A4AB8)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"11px 24px",fontSize:14,fontWeight:700,cursor:"pointer",opacity:(!contactForm.name.trim()||!contactForm.email.trim()||!contactForm.description.trim())?0.5:1}}>
                  Submit request
                </button>
              </Card>
            )}
          </div>
        )}

        {view==="settings"&&(
          <div className="stagger-in" style={{maxWidth:720}}>
            <h1 style={{fontSize:30,fontWeight:800,letterSpacing:"-0.03em",marginBottom:4,color:"var(--text-primary)"}}>Settings</h1>
            <p style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24}}>Configure your company details and API keys</p>
            <div style={{display:"grid",gap:16}}>
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:16}}>Company details</div>
                <div style={{display:"grid",gap:12}}>
                  {[
                    {label:"Company name",k:"company",ph:"e.g. Initial Mechanical"},
                    {label:"Contact name",k:"contactName",ph:"e.g. Andy Hammill"},
                    {label:"From email",k:"fromEmail",ph:"e.g. quotes@company.co.uk"},
                    {label:"Site address",k:"siteAddress",ph:"e.g. 52 Stretton Street"},
                  ].map(f=>(
                    <div key={f.k}>
                      <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:5}}>{f.label}</label>
                      <input value={sForm[f.k]||""} onChange={e=>setSForm(p=>({...p,[f.k]:e.target.value}))} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    </div>
                  ))}
                </div>
              </Card>
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:10}}>Company branding</div>
                <div style={{display:"grid",gap:12}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Company logo</label>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      {sForm.logoBase64&&(
                        <img src={sForm.logoBase64} alt="Logo" style={{height:48,maxWidth:120,objectFit:"contain",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:4}}/>
                      )}
                      <label style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",padding:"7px 14px",cursor:"pointer",fontWeight:500}}>
                        <Icon name="paperclip" size={14} style={{marginRight:6,verticalAlign:"-2px"}}/>{sForm.logoBase64?"Change logo":"Upload logo"}
                        <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                          const file = e.target.files[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = ev => {
                            // Resize logo to max 240px wide to keep localStorage small
                            const img = new Image();
                            img.onload = () => {
                              const maxW = 240;
                              const scale = Math.min(1, maxW / img.width);
                              const canvas = document.createElement("canvas");
                              canvas.width = img.width * scale;
                              canvas.height = img.height * scale;
                              const ctx2 = canvas.getContext("2d");
                              ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);
                              const compressed = canvas.toDataURL("image/png");
                              setSForm(p=>({...p,logoBase64:compressed}));
                            };
                            img.onerror = () => showToast("Could not read that image","warn");
                            img.src = ev.target.result;
                          };
                          reader.readAsDataURL(file);
                        }}/>
                      </label>
                      {sForm.logoBase64&&<button onClick={()=>setSForm(p=>({...p,logoBase64:""}))} style={{fontSize:11,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:6,padding:"5px 10px",cursor:"pointer"}}>Remove</button>}
                    </div>
                    <div style={{fontSize:11,color:"var(--text-muted)",marginTop:4}}>Appears on PO emails · PNG or JPG recommended</div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Quote validity (days)</label>
                      <input type="number" min="1" max="90" value={sForm.quoteValidityDays||30} onChange={e=>setSForm(p=>({...p,quoteValidityDays:parseInt(e.target.value)||30}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                      <div style={{fontSize:11,color:"var(--text-muted)",marginTop:4}}>Quotes saved to library expire after this many days</div>
                    </div>
                    <div>
                      <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Default PO terms</label>
                      <input value={sForm.poNotes||""} onChange={e=>setSForm(p=>({...p,poNotes:e.target.value}))} placeholder="e.g. 30 day payment terms" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
                    </div>
                  </div>
                </div>
              </Card>

              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>AI (OpenRouter)</div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:12}}>Required for AI parsing and quote analysis. Free at openrouter.ai</div>
                <input type="password" value={sForm.openRouterKey||""} onChange={e=>setSForm(p=>({...p,openRouterKey:e.target.value}))} placeholder="sk-or-..." style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",marginBottom:8}}/>
                {sForm.openRouterKey?<div style={{fontSize:11,color:"var(--green-dark)"}}>Key entered - AI features active</div>:<div style={{fontSize:11,color:"var(--amber)"}}>No key - AI features disabled</div>}
              </Card>
              <Card>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Email sending (Resend)</div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:12}}>Required for sending RFQ emails. Free tier at resend.com</div>
                <input type="password" value={sForm.resendKey||""} onChange={e=>setSForm(p=>({...p,resendKey:e.target.value}))} placeholder="re_..." style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",marginBottom:8}}/>
                {sForm.resendKey?<div style={{fontSize:11,color:"var(--green-dark)"}}>Key entered</div>:<div style={{fontSize:11,color:"var(--amber)"}}>No key - email sending disabled</div>}
              </Card>
              <div style={{display:"flex",gap:10}}>
                <Btn onClick={()=>{saveSettings(sForm);showToast("Settings saved");}} color="#5B5BD6">Save settings</Btn>
                <Btn outline onClick={()=>setSForm({...settings})}>Reset</Btn>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Mobile bottom bar */}
      {isMobile&&(
        <div style={{position:"fixed",bottom:0,left:0,right:0,height:68,background:"var(--bottombar-bg)",borderTop:"1px solid var(--sidebar-border)",display:"flex",alignItems:"center",justifyContent:"space-around",zIndex:100}}>
          {[
            {id:"dashboard",label:"Home",    d:"M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"},
            {id:"new",      label:"Request", d:"M12 5v14M5 12h14"},
            {id:"quotes",   label:"Quotes",  d:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2"},
            {id:"orders",   label:"Orders",  d:"M20 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 16H8M12 12H8"},
            {id:"settings", label:"More",    d:"M4 6h16M4 12h16M4 18h16"},
          ].map(tab=>(
            <button key={tab.id}
              onClick={()=>{
                if(tab.id==="settings"){setMoreMenuOpen(p=>!p);return;}
                setMoreMenuOpen(false);
                handleNav(tab.id);
              }}
              style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"none",border:"none",cursor:"pointer",padding:"8px 14px",borderRadius:10,minWidth:56,position:"relative",flex:1}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke={tab.id==="settings"?moreMenuOpen?"var(--green)":"var(--sidebar-text)":view===tab.id?"var(--green)":"var(--sidebar-text)"}
                strokeWidth={view===tab.id||tab.id==="settings"&&moreMenuOpen?2.2:1.8}
                strokeLinecap="round" strokeLinejoin="round"><path d={tab.d}/></svg>
              <span style={{fontSize:10,fontWeight:(tab.id==="settings"?moreMenuOpen:view===tab.id)?700:400,color:(tab.id==="settings"?moreMenuOpen:view===tab.id)?"var(--green)":"var(--sidebar-text)"}}>{tab.label}</span>
              {tab.id==="orders"&&pendingOrders>0&&(
                <span style={{position:"absolute",top:4,right:"20%",background:"var(--green)",color:"white",fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:99}}>{pendingOrders}</span>
              )}
            </button>
          ))}
          {moreMenuOpen&&(
            <div style={{position:"fixed",bottom:68,left:0,right:0,zIndex:200,animation:"fadeIn 0.15s ease"}}>
              <div onClick={()=>setMoreMenuOpen(false)} style={{position:"fixed",inset:0,bottom:68,background:"rgba(0,0,0,0.6)",zIndex:198}}/>
              <div style={{position:"relative",zIndex:199,background:"var(--topbar-bg)",borderRadius:"20px 20px 0 0",padding:"8px 0 12px",boxShadow:"0 -8px 40px rgba(0,0,0,0.5)",border:"1px solid var(--sidebar-border)"}}>
                <div style={{width:36,height:4,background:"rgba(255,255,255,0.15)",borderRadius:99,margin:"0 auto 16px"}}/>
                <div style={{padding:"0 8px"}}>
                  {[
                    {id:"requests", label:"All requests",   sub:"View and manage all RFQs",         icon:"clipboard"},
                    {id:"suppliers",label:"Suppliers",       sub:"Manage your supplier accounts",    icon:"building"},
                    {id:"library",  label:"Quote library",   sub:"Price history and supplier scores",icon:"books"},
                    {id:"help",     label:"Help & FAQ",       sub:"Guides and AI assistant",          icon:"help_circle"},
                    {id:"contact",  label:"Contact support",  sub:"Raise a request",                  icon:"mail"},
                    {id:"settings", label:"Settings",         sub:"API keys and company details",     icon:"settings"},
                  ].map(item=>(
                    <button key={item.id} onClick={()=>{handleNav(item.id);setMoreMenuOpen(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 16px",background:view===item.id?"rgba(34,197,94,0.1)":"transparent",border:"none",borderRadius:12,cursor:"pointer",textAlign:"left",marginBottom:2}}>
                      <div style={{width:40,height:40,background:view===item.id?"rgba(34,197,94,0.2)":"rgba(255,255,255,0.06)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0,color:view===item.id?"var(--green)":"var(--sidebar-text)",display:"flex"}}><Icon name={item.icon} size={18}/></div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:14,fontWeight:600,color:view===item.id?"var(--green)":"white"}}>{item.label}</div>
                        <div style={{fontSize:11,color:"#64748B",marginTop:2}}>{item.sub}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {approveConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:440,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Icon name="clipboard" size={40} color="var(--text-tertiary)"/></div>
              <div style={{fontSize:18,fontWeight:700,color:"var(--text-primary)",marginBottom:6}}>Approve this quote?</div>
              <div style={{fontSize:13,color:"var(--text-secondary)",lineHeight:1.6}}>This will generate the PO, create an order, and save all other quotes to the library.</div>
            </div>
            <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>SUPPLIER</div><div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>{approveConfirm.supplierName||"—"}</div></div>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>ESTIMATED TOTAL</div><div style={{fontSize:14,fontWeight:600,color:"var(--green-dark)"}}>{approveConfirm.estimatedTotal||approveConfirm.subtotal||"—"}</div></div>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>COMPLETENESS</div><div style={{fontSize:14,fontWeight:600,color:approveConfirm.completeness>=80?"var(--green-dark)":"var(--amber)"}}>{approveConfirm.completeness||0}%</div></div>
                <div><div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>OTHER QUOTES</div><div style={{fontSize:14,fontWeight:600,color:"var(--text-secondary)"}}>{allAnalyses.length-1} saved to library</div></div>
              </div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <Btn outline onClick={()=>setApproveConfirm(null)}>Cancel</Btn>
              <Btn color="#15824F" onClick={()=>handleApprovePO(approveConfirm)}>Confirm approval</Btn>
            </div>
          </div>
        </div>
      )}

      {approveSuccess&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.6)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",zIndex:1001,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"36px 40px",maxWidth:420,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--green-dark)",textAlign:"center",animation:"fadeIn 0.3s ease"}}>
            <div style={{width:64,height:64,background:"linear-gradient(135deg,var(--green),var(--green-dark))",borderRadius:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 20px",boxShadow:"0 8px 24px rgba(34,197,94,0.3)"}}><Icon name="check" size={32} color="white" strokeWidth={2.5}/></div>
            <div style={{fontSize:22,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.5px",marginBottom:6}}>PO Approved</div>
            <div style={{fontSize:15,fontWeight:600,color:"var(--green-dark)",marginBottom:16,fontFamily:"'JetBrains Mono',monospace"}}>{approveSuccess.poNum}</div>
            <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20,textAlign:"left"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Supplier</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{approveSuccess.supplier}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Job reference</span><span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{approveSuccess.jobRef}</span></div>
              {approveSuccess.estimatedTotal&&<div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:12,color:"var(--text-secondary)"}}>Total</span><span style={{fontSize:12,fontWeight:600,color:"var(--green-dark)"}}>{approveSuccess.estimatedTotal}</span></div>}
            </div>
            <div style={{fontSize:12,color:"var(--text-tertiary)",marginBottom:20}}>Other quotes saved to library. Order created in Orders page.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={()=>{setApproveSuccess(null);setView("orders");}} style={{background:"linear-gradient(135deg,var(--green),var(--green-dark))",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 24px",fontSize:13,fontWeight:700,cursor:"pointer"}}>View in Orders</button>
              <button onClick={()=>setApproveSuccess(null)} style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Stay here</button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:400,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Icon name="trash" size={34} color="var(--red)"/></div>
            <div style={{fontSize:16,fontWeight:600,marginBottom:8,textAlign:"center",color:"var(--text-primary)"}}>Delete this request?</div>
            <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:24,textAlign:"center",lineHeight:1.6}}>This cannot be undone. The request, quotes, and all associated data will be permanently removed.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <Btn outline onClick={()=>setDeleteConfirm(null)}>Cancel</Btn>
              <Btn color="#D14343" onClick={()=>{setRequests(p=>p.filter(r=>r.id!==deleteConfirm.id));if(activeReq?.id===deleteConfirm.id){setActiveReq(null);setAllAnalyses([]);}setDeleteConfirm(null);showToast("Request deleted");}}>Delete</Btn>
            </div>
          </div>
        </div>
      )}

      {editModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:540,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:20,color:"var(--text-primary)"}}>Edit request - {editModal.id}</div>
            <div style={{display:"grid",gap:14}}>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Job Reference</label>
                <input value={editForm.jobRef||""} onChange={e=>setEditForm(p=>({...p,jobRef:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Site</label>
                <input value={editForm.site||""} onChange={e=>setEditForm(p=>({...p,site:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Status</label>
                <select value={editForm.status||"draft"} onChange={e=>setEditForm(p=>({...p,status:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}>
                  <option value="draft">Draft</option>
                  <option value="pending">Pending quotes</option>
                  <option value="received">Quotes received</option>
                  <option value="approved">Approved</option>
                </select>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Notes</label>
                <textarea value={editForm.notes||""} onChange={e=>setEditForm(p=>({...p,notes:e.target.value}))} placeholder="Add any notes about this request..." style={{width:"100%",height:80,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit"}}></textarea>
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:20,justifyContent:"flex-end"}}>
              <Btn outline onClick={()=>setEditModal(null)}>Cancel</Btn>
              <Btn onClick={handleEditSave}>Save changes</Btn>
            </div>
          </div>
        </div>
      )}

      {activityModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:560,width:"100%",maxHeight:"80vh",overflow:"auto",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:16,fontWeight:600,color:"var(--text-primary)"}}>{activityModal.id} - Activity log</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{activityModal.jobRef} · {activityModal.site}</div>
              </div>
              <button onClick={()=>setActivityModal(null)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"var(--text-muted)"}}>x</button>
            </div>
            {(!activityModal.activity||activityModal.activity.length===0)?(
              <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)",fontSize:13}}>No activity logged yet</div>
            ):(
              <div>
                {[...(activityModal.activity||[])].reverse().map((entry,i)=>(
                  <div key={i} style={{display:"flex",gap:14,padding:"12px 0",borderBottom:"1px solid var(--border)"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:"var(--green-dark)",marginTop:5,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                        <span style={{fontSize:13,fontWeight:500,color:"var(--text-primary)"}}>{entry.action}</span>
                        <span style={{fontSize:11,color:"var(--text-muted)",whiteSpace:"nowrap",marginLeft:12}}>{new Date(entry.ts).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span>
                      </div>
                      {entry.detail&&<div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{entry.detail}</div>}
                      <div style={{fontSize:11,color:"var(--text-muted)",marginTop:2}}>by {entry.user||"System"}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showShortcuts&&(
        <div onClick={()=>setShowShortcuts(false)} style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.6)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:480,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:16,fontWeight:700,color:"var(--text-primary)"}}>Keyboard shortcuts</div>
              <kbd style={{background:"var(--bg-subtle2)",border:"1px solid var(--border)",borderRadius:5,padding:"2px 8px",fontSize:11,color:"var(--text-secondary)",cursor:"pointer"}} onClick={()=>setShowShortcuts(false)}>Esc</kbd>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[
                ["N","New request"],["Q","Quote analysis"],["O","Orders"],
                ["D","Dashboard"],["S","Settings"],["H","Help"],
                ["?","Toggle shortcuts"],["Esc","Close modals"],
              ].map(([k,l])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>
                  <span style={{fontSize:13,color:"var(--text-secondary)"}}>{l}</span>
                  <kbd style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:5,padding:"2px 10px",fontSize:12,fontFamily:"monospace",fontWeight:700,color:"var(--text-primary)",boxShadow:"0 1px 0 var(--border)"}}>{k}</kbd>
                </div>
              ))}
            </div>
            <div style={{marginTop:16,padding:"10px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)"}}>
              <div style={{fontSize:11,color:"var(--text-muted)",textAlign:"center"}}>Press <strong>?</strong> or <strong>/</strong> at any time to show this panel</div>
            </div>
          </div>
        </div>
      )}

      {templateModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(20,20,18,0.55)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"24px 28px",maxWidth:560,width:"100%",maxHeight:"85vh",overflow:"auto",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)",animation:"scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:17,fontWeight:700,color:"var(--text-primary)"}}>Request templates</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>Material list templates grouped by trade</div>
              </div>
              <button onClick={()=>setTemplateModal(false)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"var(--text-muted)"}}>x</button>
            </div>
            {parsed&&(
              <div style={{background:"var(--green-mint)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:600,color:"var(--green-deep)",marginBottom:8}}>Save current list - {templateCurrentTrade}</div>
                <div style={{display:"flex",gap:10}}>
                  <input value={newTemplateName} onChange={e=>setNewTemplateName(e.target.value)}
                    placeholder={`Name e.g. Standard ${templateCurrentTrade} pack`}
                    style={{flex:1,padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none"}}
                    onKeyDown={e=>e.key==="Enter"&&handleSaveTemplate()}
                  />
                  <Btn onClick={handleSaveTemplate} disabled={!newTemplateName.trim()} color="#15824F">Save</Btn>
                </div>
              </div>
            )}
            {templates.length===0?(
              <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:36,marginBottom:12}}>list</div>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-secondary)"}}>No templates yet</div>
                <div style={{fontSize:12,marginTop:6,lineHeight:1.6}}>Create a request then save it as a template from Step 2</div>
              </div>
            ):(
              <div>
                {Object.keys(templateGrouped).sort((a,b)=>a===templateCurrentTrade?-1:b===templateCurrentTrade?1:0).map(tradeName=>(
                  <div key={tradeName} style={{marginBottom:16}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <span style={{fontSize:11,fontWeight:700,color:tradeName===templateCurrentTrade?"var(--green-dark)":"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.1em"}}>
                        {tradeName===templateCurrentTrade?"* ":""}{tradeName}
                      </span>
                      <span style={{fontSize:10,color:"var(--text-muted)",background:"var(--bg-subtle2)",padding:"1px 7px",borderRadius:99}}>{templateGrouped[tradeName].length}</span>
                    </div>
                    {templateGrouped[tradeName].map(t=>(
                      <div key={t.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:tradeName===templateCurrentTrade?"var(--green-mint)":"var(--bg-subtle)",borderRadius:"var(--radius-md)",marginBottom:6,border:"1px solid",borderColor:tradeName===templateCurrentTrade?"var(--green-dark)":"var(--border)"}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                            <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</div>
                            {t.usageCount>0&&<span style={{fontSize:9,color:"var(--text-muted)",background:"var(--bg-subtle2)",padding:"1px 6px",borderRadius:99,flexShrink:0}}>used {t.usageCount}x</span>}
                          </div>
                          <div style={{fontSize:11,color:"var(--text-secondary)"}}>{t.items.length} items{t.lastUsed?` · last used ${t.lastUsed}`:` · saved ${t.created}`}</div>
                        </div>
                        <div style={{display:"flex",gap:6,flexShrink:0}}>
                          <button onClick={()=>handleLoadTemplate(t)} style={{fontSize:12,color:"white",background:"var(--green-dark)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 14px",cursor:"pointer",fontWeight:600}}>Load</button>
                          <button onClick={()=>saveTemplates(templates.filter(x=>x.id!==t.id))} style={{fontSize:12,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 10px",cursor:"pointer"}}>x</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
