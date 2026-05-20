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

// ─── Speech recognition hook ─────────────────────────────────────────────────
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

// ─── Constants ────────────────────────────────────────────────────────────────
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
  draft:    { bg:"#FEF9C3", text:"#854D0E",  label:"Draft" },
  pending:  { bg:"#EEF2FF", text:"#3730A3",  label:"Pending quotes" },
  received: { bg:"#FAF5FF", text:"#6B21A8",  label:"Quotes received" },
  approved: { bg:"#DCFCE7", text:"#166534",  label:"Approved" },
};

// ─── AI helpers ───────────────────────────────────────────────────────────────
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
async function analyseQuote(items, quoteText, supplierName) {
  const sys = `You are an expert AI procurement analyst for UK plumbing, HVAC, and electrical trades companies. A supplier has responded to a Request for Quotation. Your job is to perform a thorough, detailed analysis. Return ONLY valid JSON with no markdown, no explanation, no preamble.

Required JSON format:
{
  "supplierName": "...",
  "completeness": 0-100,
  "recommendation": "short plain-english verdict",
  "overallVerdict": "excellent|good|partial|poor",
  "subtotal": "£0.00",
  "carriageCharge": "£0.00 or Free or Not stated",
  "vatNote": "string",
  "estimatedTotal": "£0.00",
  "leadTime": "string",
  "discounts": [{"item":"...","discount":"...","detail":"..."}],
  "matched": [{"item":"...","requestedQty":0,"requestedUnit":"...","quotedQty":0,"quotedUnit":"...","unitPrice":"...","lineTotal":"...","inStock":true,"stockQty":"...or unknown","qtyMatch":true,"notes":"..."}],
  "missing": [{"item":"...","reason":"not quoted|out of stock|discontinued"}],
  "alternatives": [{"requestedItem":"...","alternativeOffered":"...","altPrice":"...","reason":"...","recommended":true}],
  "warnings": ["..."],
  "positives": ["..."]
}

Rules:
- Extract EVERY price, quantity, stock level, lead time, carriage/delivery charge from the quote
- For each matched item check if the quoted quantity matches requested quantity exactly
- Flag any quantity discrepancies clearly in qtyMatch field
- Identify any discount mentions (bulk discount, trade account discount, promotional pricing)
- Extract carriage/delivery charges even if mentioned in passing
- Note lead times for each item if stated, or overall lead time
- Suggest alternatives only if the supplier explicitly offers them
- Be accurate with maths - calculate line totals and subtotal correctly
- If price is not stated for an item, note it as "Not quoted"`;

  const req = items.map(i=>`- ${i.quantity} ${i.unit} of ${i.description}`).join("\n");
  const raw = await callAI(sys,
    `Supplier name: ${supplierName||"Unknown supplier"}\n\nOriginal material request:\n${req}\n\nSupplier quote received:\n${quoteText}\n\nPerform full analysis and return JSON.`
  );
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); } catch { return {error:true, raw}; }
}

// ─── Extract quote text from uploaded file using AI ──────────────────────────
async function extractQuoteFromFile(fileContent, fileName, fileType) {
  const sys = `You are a procurement data extraction specialist. A supplier has sent a quote document. Extract ALL pricing information, stock availability, delivery charges, lead times, and any other relevant procurement data from the document content provided. Return the extracted information as clean, structured plain text that clearly lists each item with its price, availability, and any other details. Preserve all numbers and prices exactly. If the document appears to be a table or spreadsheet, convert it to a clear line-by-line format. Start directly with the extracted data, no preamble.`;
  const prompt = `File name: ${fileName}
File type: ${fileType}

Document content:
${fileContent}

Extract all quote/pricing information as clean structured text.`;
  return callAI(sys, prompt);
}

// ─── Read file content for AI extraction ─────────────────────────────────────
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
    // For PDF and Word — read as base64 and send to AI with note
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

// ─── Email via Vercel serverless function (no CORS) ──────────────────────────
async function sendRFQEmails(suppliers, subject, body, apiKey, fromEmail) {
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
          text: body
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

// ─── PDF generation via jsPDF (loaded from CDN on demand) ────────────────────
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

  // ── Deep navy header bar ──
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

  // PO number & date — right aligned
  doc.setTextColor(255,255,255);
  doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text(poNumber, W-M, 18, {align:"right"});
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.setTextColor(148,163,184);
  doc.text(`Issued: ${date}`, W-M, 27, {align:"right"});

  // ── Info boxes ──
  let y = 54;
  // Box backgrounds
  doc.setFillColor(248,250,252); doc.roundedRect(M, y, 80, 32, 2, 2, "F");
  doc.setFillColor(248,250,252); doc.roundedRect(M+86, y, 80, 32, 2, 2, "F");

  // Supplier box
  doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
  doc.text("SUPPLIER", M+4, y+7);
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(15,23,42);
  doc.text(supplier?.name||"—", M+4, y+14);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(71,85,105);
  doc.text(supplier?.email||"—", M+4, y+20);

  // Job box
  doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.setTextColor(100,116,139);
  doc.text("JOB DETAILS", M+90, y+7);
  doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(15,23,42);
  doc.text(`Ref: ${jobRef||"TBC"}`, M+90, y+14);
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(71,85,105);
  doc.text(site||"—", M+90, y+20);
  if(contactName) doc.text(`Contact: ${contactName}`, M+90, y+26);

  y += 42;

  // ── Table header ──
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

  // ── Table rows ──
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

  // ── Total bar ──
  y += 4;
  doc.setFillColor(15,23,42);
  doc.rect(M, y, W-M*2, 12, "F");
  doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.setTextColor(255,255,255);
  doc.text("TOTAL DUE", M+3, y+8);
  doc.setTextColor(59,130,246);
  doc.text(grandTotal?`£${grandTotal.toFixed(2)}`:"TBC", W-M, y+8, {align:"right"});
  y += 20;

  // ── VAT note ──
  doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(100,116,139);
  doc.text("All prices shown exclude VAT unless otherwise stated.", M, y);
  y += 10;

  // ── Footer ──
  doc.setDrawColor(226,232,240); doc.setLineWidth(0.3);
  doc.line(M, 275, W-M, 275);
  doc.setFont("helvetica","normal"); doc.setFontSize(7.5); doc.setTextColor(148,163,184);
  doc.text(`${company||"Your Company"}  ·  ${contactEmail||""}  ·  PO ${poNumber}`, M, 280);
  doc.text("Generated by ProQuote — AI-powered procurement for trades", W-M, 280, {align:"right"});

  doc.save(`PO-${poNumber}.pdf`);
}

// ─── Tiny shared components ───────────────────────────────────────────────────
const Btn = ({ onClick, disabled, color="#6366F1", outline=false, children }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: outline?"transparent": disabled?"#C7D2FE":color,
    color: outline?"var(--text-secondary)":"white",
    border: outline?"1px solid var(--border-solid)":"none",
    borderRadius:10, padding:"10px 22px", fontSize:13, fontWeight:600,
    cursor: disabled?"not-allowed":"pointer", opacity: disabled?0.85:1,
    display:"inline-flex", alignItems:"center", gap:7,
    boxShadow: outline?"none": disabled?"none":"0 2px 8px rgba(99,102,241,0.25)",
    letterSpacing:"-0.1px"
  }}>{children}</button>
);
const Badge = ({ children, bg, text }) => (
  <span style={{ background:bg, color:text, fontSize:11, fontWeight:600, padding:"3px 11px", borderRadius:20, whiteSpace:"nowrap", letterSpacing:"0.01em" }}>{children}</span>
);
const Card = ({ children, style={} }) => (
  <div style={{ background:"var(--bg-card-solid)", border:"1px solid var(--border)", borderRadius:"var(--radius-lg)", padding:"24px 28px", boxShadow:"var(--shadow-sm)", ...style }}>{children}</div>
);
const Spinner = () => (
  <span style={{ width:14, height:14, border:"2px solid white", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin 0.7s linear infinite" }}/>
);

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  // Settings persisted to localStorage
  const [settings, setSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_settings")||"{}"); } catch { return {}; }
  });
  const [suppliers, setSuppliers] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_suppliers")||"null")||DEFAULT_SUPPLIERS; } catch { return DEFAULT_SUPPLIERS; }
  });
  const saveSettings = (patch) => {
    const next = {...settings,...patch}; setSettings(next);
    localStorage.setItem("piq_settings", JSON.stringify(next));
  };
  const saveSuppliers = (s) => { setSuppliers(s); localStorage.setItem("piq_suppliers",JSON.stringify(s)); };

  // Nav & toast
  const [view, setView] = useState("dashboard");
  const [toast, setToast] = useState(null);
  const showToast = (msg, type="success") => { setToast({msg,type}); setTimeout(()=>setToast(null),4000); };

  // Requests
  const [requests, setRequests] = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_requests")||"[]")}catch{return []} });
  const [orders,   setOrders]   = useState(()=>{ try{return JSON.parse(localStorage.getItem("piq_orders")||"[]")}catch{return []} });

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

  // Help AI chat
  const [helpMessages, setHelpMessages] = useState([]);
  const [helpInput, setHelpInput] = useState("");
  const [helpLoading, setHelpLoading] = useState(false);

  // Contact form
  const [contactForm, setContactForm] = useState({name:settings.contactName||"",email:settings.fromEmail||"",category:"Bug report",priority:"Normal",description:""});
  const [contactSent, setContactSent] = useState(false);

  // Keyboard shortcuts
  useEffect(()=>{
    const handler = e=>{
      if (e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA"||e.target.tagName==="SELECT") return;
      if (e.key==="n"||e.key==="N") { setView("new"); resetNewRequest(); }
      else if (e.key==="q"||e.key==="Q") setView("quotes");
      else if (e.key==="o"||e.key==="O") setView("orders");
      else if (e.key==="d"||e.key==="D") setView("dashboard");
      else if (e.key==="s"||e.key==="S") setView("settings");
      else if (e.key==="h"||e.key==="H") setView("help");
      else if (e.key==="Escape") {
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
  const [orderFilter, setOrderFilter] = useState("all"); // all | active | delivered
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
      showToast(`Confirmation attached — order marked as Confirmed`);
    };
    reader.readAsDataURL(file);
  }

  // Quote library — persisted
  const [quoteLibrary, setQuoteLibrary] = useState(() => {
    try { return JSON.parse(localStorage.getItem("piq_quote_library")||"[]"); } catch { return []; }
  });
  const saveToLibrary = (qa, reqId, jobRef, site, trade) => {
    const entry = {
      id: `QL-${Date.now()}`,
      savedAt: new Date().toISOString(),
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
  const [sForm, setSForm] = useState({company:"",contactName:"",fromEmail:"",resendKey:"",openRouterKey:"",...settings});

  // Supplier form
  const [newSup, setNewSup] = useState({name:"",email:"",categories:""});

  // Voice
  const { listening, supported:voiceOk, start:micStart, stop:micStop } = useSpeechRecognition({
    onTranscript: t => setInterim(t),
    onFinal:      t => { setRawInput(p=>p+t); setInterim(""); }
  });

  const stats = {
    total:    requests.length,
    pending:  requests.filter(r=>r.status==="pending").length,
    received: requests.filter(r=>r.status==="received").length,
    approved: requests.filter(r=>r.status==="approved").length,
  };

  const filteredSup = suppliers.filter(s=>s.categories.some(cat=>cat.trim().toLowerCase()===trade.trim().toLowerCase()));

  function logActivity(reqId, action, detail="") {
    const entry = { ts: new Date().toISOString(), action, detail, user: settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===reqId ? {...r, activity:[...(r.activity||[]), entry]} : r));
  }

  function handleDelete(id) {
    logActivity(id, "Deleted", "Request permanently deleted");
    setRequests(p=>p.filter(r=>r.id!==id));
    if (activeReq?.id===id) setActiveReq(null);
    setDeleteConfirm(null);
    showToast("Request deleted");
  }

  function handleEditSave() {
    const r = requests.find(r=>r.id===editModal.id);
    const changes = [];
    if (editForm.jobRef!==r.jobRef) changes.push(`Job ref: ${r.jobRef} → ${editForm.jobRef}`);
    if (editForm.site!==r.site)     changes.push(`Site: ${r.site} → ${editForm.site}`);
    if (editForm.status!==r.status) changes.push(`Status: ${STATUS[r.status].label} → ${STATUS[editForm.status].label}`);
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

  // ── Handlers ──
  async function handleParse() {
    if (!rawInput.trim()) return;
    if (!settings.openRouterKey) { showToast("Add your free OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true); setLoadMsg("Parsing your material list…");
    try {
      const data = await parseMaterialList(rawInput);
      setParsed(data);
      if (data?.jobRef && !jobRef) setJobRef(data.jobRef);
      // Auto-select all suppliers matching the current trade
      const matchingIds = suppliers
        .filter(s=>s.categories.some(cat=>cat.trim().toLowerCase()===trade.trim().toLowerCase()))
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
    setLoading(true); setLoadMsg("Generating RFQ email…");
    try {
      const email = await generateRFQ(parsed.items, jobRef, settings.company, settings.contactName, settings.fromEmail, deliveryMethod, deliveryDate, altAddress, rfqDeadline);
      setRfqEmail(email);
      setStep(3);
    } catch(e) { showToast("AI error: "+e.message,"warn"); }
    setLoading(false);
  }

  async function handleSendEmails() {
    if (!settings.resendKey) { showToast("Add your Resend API key in Settings first","warn"); setView("settings"); return; }
    setLoading(true); setLoadMsg("Sending to suppliers…");
    const toSend = suppliers.filter(s=>selSup.includes(s.id));
    const subject = `Request for Quotation — ${jobRef||parsed?.jobRef||"TBC"}`;
    const results = await sendRFQEmails(toSend, subject, rfqEmail, settings.resendKey, settings.fromEmail||"onboarding@resend.dev");
    setLoading(false);
    const ok = results.filter(r=>r.success).length;
    if (ok > 0) {
      const sentSuppliers = toSend.map(s=>({ id:s.id, name:s.name, email:s.email, quote:"", saved:false }));
      const newId = `RFQ-${String(requests.length+1).padStart(3,"0")}`;
      const r = {
        id: newId,
        jobRef:jobRef||"TBC", site:site||"Site TBC", trade,
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
      showToast(`✓ ${ok} RFQ${ok!==1?"s":""} sent — ${newId} saved`);
      setTimeout(()=>{
        // Full reset — ready for next request
        setStep(1);
        setRawInput(""); setParsed(null); setJobRef(""); setSite(""); setTrade("Plumbing");
        setRfqEmail(""); setEmailRes(null); setSelSup([]);
        setDeliveryMethod("direct"); setDeliveryDate(""); setAltAddress(""); setRfqDeadline("");
        setView("dashboard");
      }, 1800);
      setEmailRes(results); // show brief success UI
    } else {
      setEmailRes(results);
      showToast(`Send failed — check your Resend key and supplier emails`,"warn");
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
    const raw = r.items.map(i=>`${i.quantity} ${i.unit} of ${i.description}${i.notes?` (${i.notes})`:""}`).join(", ");
    setRawInput(raw);
    setParsed({ items: r.items.map(i=>({...i})), jobRef:r.jobRef+" (copy)", urgency:"standard" });
    setStep(2);
    setView("new");
    showToast("Request duplicated — review and send");
    console.log(`[ProQuote] Request duplicated from ${r.id}`);
  }

  function handleSaveTemplate() {
    if (!parsed||!newTemplateName.trim()) return;
    const t = { id:`TPL-${Date.now()}`, name:newTemplateName.trim(), trade, items:parsed.items, created:new Date().toISOString().split("T")[0], usageCount:0 };
    saveTemplates([t,...templates]);
    setTemplateModal(false);
    setNewTemplateName("");
    showToast(`Template "${t.name}" saved`);
    console.log(`[ProQuote] Template saved: ${t.name} — ${t.items.length} items`);
  }

  function handleLoadTemplate(t) {
    setTrade(t.trade||"Plumbing");
    setParsed({ items:t.items.map(i=>({...i})), jobRef:"", urgency:"standard" });
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
  }

  function handleFinalise() {
    if (parsed) {
      const r = {
        id:`RFQ-${String(requests.length+1).padStart(3,"0")}`,
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
    setLoading(true); setLoadMsg("Analysing quote…");
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
    const toAnalyse = (activeReq.sentTo||[]).filter(s=>s.saved&&s.quote?.trim());
    if (!toAnalyse.length) return;
    if (!settings.openRouterKey) { showToast("Add your OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true);
    const results = [];
    for (let i=0; i<toAnalyse.length; i++) {
      const sup = toAnalyse[i];
      setLoadMsg(`Analysing ${sup.name} (${i+1} of ${toAnalyse.length})…`);
      try {
        const a = await analyseQuote(activeReq.items, sup.quote, sup.name);
        if (!a.error) results.push({...a, supplierName:a.supplierName||sup.name, _id:sup.id});
      } catch(e) { showToast(`Error analysing ${sup.name}: ${e.message}`,"warn"); }
    }
    setAllAnalyses(results);
    setApprovedQuoteId(null);
    if (results.length>0) {
      const entry = { ts:new Date().toISOString(), action:"AI analysis run", detail:`${results.length} quote${results.length!==1?"s":""} analysed`, user:settings.contactName||"You" };
      setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"received",activity:[...(r.activity||[]),entry]}:r));
      setActiveReq(prev=>({...prev,status:"received"}));
      // Auto-save all quotes to library
      results.forEach(qa => saveToLibrary(qa, activeReq.id, activeReq.jobRef, activeReq.site, activeReq.trade));
    }
    setLoading(false);
    showToast(`Analysis complete — ${results.length} quote${results.length!==1?"s":""} saved to library`);
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
      detail:`PO ${poNum} — ${sup?.name||"supplier"} — Est. ${analysis?.estimatedTotal||"—"} — ${otherQuotes.length} other quote${otherQuotes.length!==1?"s":""} auto-saved to library`,
      user:settings.contactName||"You"
    };
    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"approved",documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),poEntry]}:r));
    setActiveReq(prev=>({...prev,status:"approved",documents:[...(prev.documents||[]),doc]}));
    setApprovedQuoteId(qa?._id||null);

    // Remove other quotes from the analysis view
    setAllAnalyses([qa]);

    const order = {
      id:poNum, reqId:activeReq.id,
      jobRef:activeReq?.jobRef||"TBC", site:activeReq?.site||"", trade:activeReq?.trade||"",
      supplier:sup?.name||"", supplierEmail:sup?.email||"",
      items:activeReq?.items||[], analysis, poNumber:poNum, poDate:dateStr,
      status:"pending-send", type:"generated", label:`PO ${poNum}`,
      deliveryMethod:activeReq?.deliveryMethod||"", deliveryDate:activeReq?.deliveryDate||"",
      notes:"",
      activity:[{ ts:new Date().toISOString(), action:"Order created", detail:`PO ${poNum} approved — ${sup?.name||"supplier"} — ${analysis?.estimatedTotal||"—"}`, user:settings.contactName||"You" }]
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
    showToast("Approval undone — you can re-approve a different quote");
  }

  async function handleHelpChat(question) {
    if (!question.trim()) return;
    if (!settings.openRouterKey) { showToast("Add your OpenRouter key in Settings to use the AI assistant","warn"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    const userMsg = {role:"user",content:question};
    setHelpMessages(p=>[...p,userMsg]);
    setHelpInput("");
    setHelpLoading(true);
    const sys = `You are the ProQuote AI assistant. ProQuote is an AI-powered procurement platform for UK trades contractors (plumbing, HVAC, electrical, mechanical, ventilation). You help users understand and use the platform. Be concise, friendly, and accurate. Key features: voice material requests, AI parsing of lists, RFQ email generation, supplier management, AI quote analysis and comparison, purchase order generation, orders tracking with status timeline (Ready→Sent→Confirmed→Delivered), quote library with supplier scorecards, request templates by trade, dark/light theme, mobile app with bottom nav. If asked about something not in ProQuote, say so clearly. Answer in 2-4 sentences unless a longer explanation is genuinely needed.`;
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
    const doc = { id:poNum, type:"draft", label:`Draft — ${sup.name}`, supplier:sup.name, date:dateStr, status:"draft" };
    const entry = { ts:new Date().toISOString(), action:"Draft quote saved", detail:`Draft PDF saved for ${sup.name} — not yet approved`, user:settings.contactName||"You" };
    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,documents:[...(r.documents||[]),doc],activity:[...(r.activity||[]),entry]}:r));
    setActiveReq(prev=>({...prev,documents:[...(prev.documents||[]),doc]}));
    showToast(`Draft saved for ${sup.name}`);
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
    if (!order.supplierEmail) { showToast("No supplier email on this order — edit the order to add one","warn"); return; }
    setSendingOrder(order.id);
    const note = orderNote[order.id]||"";
    const subject = `Purchase Order ${order.poNumber} — ${order.jobRef}`;
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
        body: JSON.stringify({ from:settings.fromEmail||"onboarding@resend.dev", to:[order.supplierEmail], subject, text:body })
      });
      const d = await res.json();
      if (res.ok && d.success) {
        const entry = { ts:new Date().toISOString(), action:"Order sent to supplier", detail:`Sent to ${order.supplierEmail}`, user:settings.contactName||"You" };
        setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"sent",sentAt:new Date().toISOString(),activity:[...(o.activity||[]),entry]}:o));
        showToast(`Order sent to ${order.supplier}`);
      } else {
        showToast(`Send failed: ${d.error||"Unknown error"}`,"warn");
      }
    } catch(e) { showToast(`Send failed: ${e.message}`,"warn"); }
    setSendingOrder(null);
  }

  const isMobile = useIsMobile();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(()=>{ try{return localStorage.getItem("piq_dark")==="1"}catch{return false} });
  const toggleDark = () => setDarkMode(p=>{ const n=!p; localStorage.setItem("piq_dark",n?"1":"0"); return n; });

  // ── Persist to localStorage ──
  useEffect(()=>{ try{localStorage.setItem("piq_requests",JSON.stringify(requests))}catch{} },[requests]);
  useEffect(()=>{ try{localStorage.setItem("piq_orders",JSON.stringify(orders))}catch{} },[orders]);

  // ── Render ──
  return (
    <div data-theme={darkMode?"dark":"light"} style={{fontFamily:"'Inter','Helvetica Neue',sans-serif",background:"var(--bg-page)",minHeight:"100vh",color:"var(--text-primary)",transition:"background 0.3s,color 0.2s"}}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <style>{`
      /* ── LIGHT THEME (default) ── */
      :root {
        --bg-page:        #F3F4F6;
        --bg-card:        #FFFFFF;
        --bg-card-solid:  #FFFFFF;
        --bg-input:       #FFFFFF;
        --bg-subtle:      #F9FAFB;
        --bg-subtle2:     #F3F4F6;
        --bg-header:      #FFFFFF;
        --border:         #E5E7EB;
        --border-solid:   #E5E7EB;
        --text-primary:   #111827;
        --text-secondary: #6B7280;
        --text-tertiary:  #9CA3AF;
        --text-muted:     #D1D5DB;
        --green:          #22C55E;
        --green-dark:     #16A34A;
        --green-deep:     #166534;
        --green-light:    #DCFCE7;
        --green-mint:     #F0FDF4;
        --indigo:         #6366F1;
        --indigo-light:   #EEF2FF;
        --amber:          #F59E0B;
        --amber-light:    #FFFBEB;
        --red:            #EF4444;
        --red-light:      #FEF2F2;
        --shadow-sm:      0 1px 2px rgba(0,0,0,0.05);
        --shadow-md:      0 4px 12px rgba(0,0,0,0.08);
        --shadow-lg:      0 8px 24px rgba(0,0,0,0.10);
        --sidebar-bg:     #111827;
        --sidebar-border: #1F2937;
        --sidebar-text:   #9CA3AF;
        --sidebar-active: #22C55E;
        --sidebar-activebg: rgba(34,197,94,0.1);
        --sidebar-activeborder: #22C55E;
        --topbar-bg:      #111827;
        --bottombar-bg:   #111827;
        --radius-sm:      8px;
        --radius-md:      12px;
        --radius-lg:      16px;
      }

      /* ── DARK THEME — Microsoft Admin inspired ── */
      /* Clean slate surfaces, consistent elevation, green brand accents */
      [data-theme="dark"] {
        --bg-page:        #1F2937;
        --bg-card:        #111827;
        --bg-card-solid:  #111827;
        --bg-input:       #1F2937;
        --bg-subtle:      #1F2937;
        --bg-subtle2:     #374151;
        --bg-header:      #111827;
        --border:         #374151;
        --border-solid:   #374151;
        --text-primary:   #F9FAFB;
        --text-secondary: #D1D5DB;
        --text-tertiary:  #9CA3AF;
        --text-muted:     #6B7280;
        --green:          #34D399;
        --green-dark:     #10B981;
        --green-deep:     #6EE7B7;
        --green-light:    rgba(52,211,153,0.12);
        --green-mint:     rgba(52,211,153,0.07);
        --indigo:         #818CF8;
        --indigo-light:   rgba(129,140,248,0.12);
        --amber:          #FBBF24;
        --amber-light:    rgba(251,191,36,0.1);
        --red:            #F87171;
        --red-light:      rgba(248,113,113,0.1);
        --shadow-sm:      0 1px 2px rgba(0,0,0,0.3);
        --shadow-md:      0 4px 12px rgba(0,0,0,0.4);
        --shadow-lg:      0 8px 24px rgba(0,0,0,0.5);
        --sidebar-bg:     #0D1117;
        --sidebar-border: #21262D;
        --sidebar-text:   #8B949E;
        --sidebar-active: #34D399;
        --sidebar-activebg: rgba(52,211,153,0.08);
        --sidebar-activeborder: #34D399;
        --topbar-bg:      #0D1117;
        --bottombar-bg:   #0D1117;
        --radius-sm:      8px;
        --radius-md:      12px;
        --radius-lg:      16px;
      }

      /* ── Global dark mode overrides ── */
      [data-theme="dark"] input,
      [data-theme="dark"] textarea,
      [data-theme="dark"] select {
        background: var(--bg-input) !important;
        color: var(--text-primary) !important;
        border-color: var(--border-solid) !important;
      }
      [data-theme="dark"] input::placeholder,
      [data-theme="dark"] textarea::placeholder {
        color: var(--text-muted) !important;
      }
      [data-theme="dark"] table thead tr {
        background: var(--bg-subtle) !important;
      }
      [data-theme="dark"] tr {
        border-color: var(--border) !important;
      }
      *{box-sizing:border-box;-webkit-font-smoothing:antialiased}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes slideIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
      ::-webkit-scrollbar{width:5px;height:5px}
      ::-webkit-scrollbar-track{background:transparent}
      ::-webkit-scrollbar-thumb{background:#374151;border-radius:99px}
      ::selection{background:#DCFCE7;color:#166534}
      input,textarea,select{font-family:'Inter','Helvetica Neue',sans-serif!important;background:var(--bg-input)!important;color:var(--text-primary)!important;border-color:var(--border-solid)!important}
      button{transition:all 0.15s ease!important}
      @media(max-width:768px){
        .desktop-only{display:none!important}
        .mobile-only{display:flex!important}
      }
      @media(min-width:769px){
        .mobile-only{display:none!important}
        .desktop-only{display:flex!important}
      }`}</style>

      {/* Toast notification */}
      {toast && (
        <div style={{position:"fixed",top:isMobile?16:24,right:isMobile?16:24,left:isMobile?16:"auto",zIndex:9999,background:toast.type==="warn"?"rgba(255,251,235,0.95)":"rgba(240,253,244,0.95)",backdropFilter:"blur(12px)",border:`1px solid ${toast.type==="warn"?"#FDE68A":"#A7F3D0"}`,color:toast.type==="warn"?"#92400E":"#065F46",borderRadius:14,padding:"14px 20px",fontSize:13,fontWeight:500,boxShadow:"0 8px 32px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.08)",display:"flex",alignItems:"center",gap:10,animation:"fadeIn 0.2s ease",maxWidth:360}}>
          <span style={{fontSize:16}}>{toast.type==="warn"?"⚠️":"✅"}</span>
          <span>{toast.msg}</span>
        </div>
      )}

      {/* ── NAV ITEMS DATA ── */}
      {(()=>{
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
        return (<>

      {/* ── DESKTOP SIDEBAR ── */}
      {!isMobile&&(
      <div style={{position:"fixed",left:0,top:0,width:240,height:"100vh",background:"linear-gradient(180deg,#0A0F1E 0%,#111827 60%,#0F172A 100%)",display:"flex",flexDirection:"column",zIndex:100,boxShadow:"4px 0 40px rgba(0,0,0,0.25)"}}>
        <div style={{padding:"28px 24px 24px",borderBottom:"1px solid var(--sidebar-border)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,background:"linear-gradient(135deg,#22C55E,#16A34A)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 12px rgba(34,197,94,0.3)"}}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
            </div>
            <div>
              <div style={{fontSize:17,fontWeight:700,color:"white",letterSpacing:"-0.8px",fontFamily:"'Inter',sans-serif"}}>Pro<span style={{color:"#22C55E"}}>Quote</span></div>
              <div style={{fontSize:10,color:"var(--text-secondary)",marginTop:3,letterSpacing:"0.12em",textTransform:"uppercase",fontWeight:500}}>Smart Procurement</div>
            </div>
          </div>
        </div>
        <nav style={{padding:"20px 16px",flex:1,overflowY:"auto"}}>
          <div style={{fontSize:10,color:"var(--sidebar-text)",letterSpacing:"0.1em",textTransform:"uppercase",fontWeight:600,marginBottom:8,paddingLeft:4,opacity:0.7}}>Navigation</div>
          {navItems.map(item=>(
            <button key={item.id} onClick={()=>handleNav(item.id)}
              style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,border:"none",background:view===item.id?"var(--sidebar-activebg)":"transparent",color:view===item.id?"var(--sidebar-active)":"var(--sidebar-text)",cursor:"pointer",fontSize:13,fontWeight:view===item.id?600:400,marginBottom:1,textAlign:"left",borderLeft:view===item.id?"3px solid var(--sidebar-activeborder)":"3px solid transparent",transition:"all 0.15s",borderRadius:"0 8px 8px 0"}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={item.d}/></svg>
              <span style={{flex:1}}>{item.label}</span>
              {item.id==="orders"&&pendingOrders>0&&(
                <span style={{background:"#22C55E",color:"white",fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:20}}>{pendingOrders}</span>
              )}
            </button>
          ))}
        </nav>
        <div style={{padding:"16px 24px",borderTop:"1px solid var(--sidebar-border)"}}>
          {/* Dark mode toggle with iOS-style slider */}
          <button onClick={toggleDark} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--bg-subtle2)",border:"1px solid var(--sidebar-border)",borderRadius:"var(--radius-sm)",padding:"9px 14px",cursor:"pointer",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:14}}>{darkMode?"☀️":"🌙"}</span>
              <span style={{fontSize:12,color:darkMode?"#FCD34D":"#6B7280",fontWeight:500}}>{darkMode?"Light mode":"Dark mode"}</span>
            </div>
            <div style={{width:38,height:22,background:darkMode?"#22C55E":"rgba(255,255,255,0.12)",borderRadius:11,position:"relative",transition:"background 0.3s",flexShrink:0}}>
              <div style={{position:"absolute",top:3,left:darkMode?19:3,width:16,height:16,background:"var(--bg-card-solid)",borderRadius:"50%",transition:"left 0.3s",boxShadow:"0 1px 4px rgba(0,0,0,0.4)"}}/>
            </div>
          </button>
          <div style={{fontSize:11,background:"var(--bg-subtle2)",borderRadius:"var(--radius-sm)",padding:"10px 14px",display:"flex",alignItems:"center",gap:8,border:"1px solid var(--sidebar-border)"}}>
            <span style={{color:settings.openRouterKey?"#22C55E":"#F59E0B",marginRight:6}}>●</span>
            <span style={{color:settings.openRouterKey?"#22C55E":"#F59E0B"}}>{settings.openRouterKey?(settings.resendKey?"AI + Email ready":"AI active · no email"):"Setup needed"}</span>
          </div>
        </div>
      </div>
      )}

      {/* ── MOBILE TOP HEADER ── */}
      {isMobile&&(
        <div style={{position:"fixed",top:0,left:0,right:0,height:60,background:"var(--topbar-bg)",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",zIndex:100,borderBottom:"1px solid var(--sidebar-border)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,background:"linear-gradient(135deg,#22C55E,#16A34A)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 12px rgba(34,197,94,0.4)"}}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
            </div>
            <span style={{fontSize:18,fontWeight:800,color:"white",letterSpacing:"-0.5px"}}>Pro<span style={{color:"#22C55E"}}>Quote</span></span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {orders.filter(o=>o.status==="pending-send").length>0&&(
              <button onClick={()=>setView("orders")} style={{background:"#22C55E",color:"white",border:"none",borderRadius:8,padding:"5px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                📦 {orders.filter(o=>o.status==="pending-send").length}
              </button>
            )}
            <button onClick={toggleDark} style={{background:"rgba(255,255,255,0.08)",border:"none",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:16}}>{darkMode?"☀️":"🌙"}</button>
            <div style={{width:8,height:8,borderRadius:"50%",background:settings.openRouterKey?"#22C55E":"#F59E0B"}}/>
          </div>
        </div>
      )}

      {/* ── MOBILE BOTTOM TAB BAR ── */}
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
                if(tab.id==="settings"){ setMoreMenuOpen(p=>!p); return; }
                setMoreMenuOpen(false);
                setView(tab.id);
                if(tab.id==="quotes"&&requests.length&&!activeReq)setActiveReq(requests[0]);
              }}
              style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"none",border:"none",cursor:"pointer",padding:"8px 14px",borderRadius:10,minWidth:56,position:"relative",flex:1}}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke={tab.id==="settings"?moreMenuOpen?"#22C55E":"#64748B":view===tab.id?"#22C55E":"#64748B"}
                strokeWidth={tab.id==="settings"?moreMenuOpen?2.2:1.8:view===tab.id?2.2:1.8}
                strokeLinecap="round" strokeLinejoin="round"><path d={tab.d}/></svg>
              <span style={{fontSize:10,fontWeight:(tab.id==="settings"?moreMenuOpen:view===tab.id)?700:400,color:(tab.id==="settings"?moreMenuOpen:view===tab.id)?"#22C55E":"#64748B"}}>{tab.label}</span>
              {tab.id==="orders"&&orders.filter(o=>o.status==="pending-send").length>0&&(
                <span style={{position:"absolute",top:4,right:"20%",background:"#22C55E",color:"white",fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:99}}>{orders.filter(o=>o.status==="pending-send").length}</span>
              )}
              {(tab.id==="settings"?moreMenuOpen:view===tab.id)&&<div style={{position:"absolute",bottom:-1,width:24,height:3,background:"#22C55E",borderRadius:"3px 3px 0 0"}}/>}
            </button>
          ))}

          {/* ── More menu overlay ── */}
          {moreMenuOpen&&(
            <div style={{position:"fixed",bottom:68,left:0,right:0,zIndex:200,animation:"fadeIn 0.15s ease"}}>
              {/* Backdrop */}
              <div onClick={()=>setMoreMenuOpen(false)} style={{position:"fixed",inset:0,bottom:68,background:"rgba(10,15,30,0.6)",backdropFilter:"blur(4px)",zIndex:198}}/>
              {/* Menu sheet */}
              <div style={{position:"relative",zIndex:199,background:"var(--topbar-bg)",borderRadius:"20px 20px 0 0",padding:"8px 0 12px",boxShadow:"0 -8px 40px rgba(0,0,0,0.5)",border:"1px solid var(--sidebar-border)"}}>
                {/* Handle bar */}
                <div style={{width:36,height:4,background:"rgba(255,255,255,0.15)",borderRadius:99,margin:"0 auto 16px"}}/>
                <div style={{padding:"0 8px"}}>
                  {[
                    {id:"requests", label:"All requests",   sub:"View and manage all RFQs",        icon:"📋", d:"M4 6h16M4 12h10M4 18h6"},
                    {id:"suppliers",label:"Suppliers",      sub:"Manage your supplier accounts",   icon:"🏢", d:"M17 20h-2a4 4 0 00-8 0H5m7-10a3 3 0 100-6 3 3 0 000 6z"},
                    {id:"library",  label:"Quote library",  sub:"Price history and supplier scores",icon:"📚", d:"M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 014 17V5a2 2 0 012-2h12a2 2 0 012 2v12M4 19.5V21"},
                    {id:"settings", label:"Settings",       sub:"API keys, email, company details", icon:"⚙️", d:"M12 15a3 3 0 100-6 3 3 0 000 6z"},
                    {id:"help",     label:"Help & FAQ",      sub:"Guides, AI assistant, FAQs",        icon:"❓", d:"M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01"},
                    {id:"contact",  label:"Contact support", sub:"Raise a request or report a bug",   icon:"📧", d:"M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"},
                  ].map(item=>(
                    <button key={item.id} onClick={()=>{ setView(item.id); setMoreMenuOpen(false); }} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"14px 16px",background:view===item.id?"rgba(34,197,94,0.12)":"transparent",border:"none",borderRadius:12,cursor:"pointer",textAlign:"left",marginBottom:2}}>
                      <div style={{width:44,height:44,background:view===item.id?"rgba(34,197,94,0.2)":"rgba(255,255,255,0.06)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{item.icon}</div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:15,fontWeight:600,color:view===item.id?"#22C55E":"white"}}>{item.label}</div>
                        <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{item.sub}</div>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={view===item.id?"#22C55E":"#374151"} strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  ))}
                </div>
                {/* Status strip */}
                <div style={{margin:"12px 16px 0",padding:"10px 14px",background:"rgba(255,255,255,0.04)",borderRadius:10,display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:settings.openRouterKey?"#22C55E":"#F59E0B",flexShrink:0}}/>
                  <span style={{fontSize:12,color:settings.openRouterKey?"#22C55E":"#F59E0B"}}>
                    {settings.openRouterKey?(settings.resendKey?"AI + Email ready":"AI active · email not set"):"Setup needed — tap Settings"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main content */}
      <div style={{
        marginLeft:isMobile?0:240,
        padding:isMobile?"76px 16px 88px":"32px 40px",
        maxWidth:isMobile?"100%":"100%",
        animation:"fadeIn 0.2s ease",
        minHeight:"100vh"
      }}>

        {/* ══ DASHBOARD ══ */}
        {view==="dashboard"&&(
          <div style={{animation:"fadeIn 0.25s ease"}}>

            {/* ── Hero header ── */}
            <div style={{
              background:darkMode?"#111827":"linear-gradient(135deg,#0A0F1E,#1a2744)",
              borderRadius:24,padding:isMobile?"24px":"36px 40px",marginBottom:24,
              position:"relative",overflow:"hidden",
              boxShadow:"0 8px 40px rgba(0,0,0,0.2)"
            }}>
              {/* Background glow */}
              <div style={{position:"absolute",top:-60,right:-60,width:300,height:300,background:darkMode?"radial-gradient(circle,rgba(52,211,153,0.08) 0%,transparent 70%)":"radial-gradient(circle,rgba(34,197,94,0.15) 0%,transparent 70%)",borderRadius:"50%",pointerEvents:"none"}}/>
              <div style={{position:"absolute",bottom:-40,left:100,width:200,height:200,background:"radial-gradient(circle,rgba(99,102,241,0.08) 0%,transparent 70%)",borderRadius:"50%",pointerEvents:"none"}}/>
              <div style={{position:"relative",zIndex:1,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:16}}>
                <div>
                  <div style={{fontSize:11,fontWeight:600,color:"#4ADE80",letterSpacing:"0.15em",textTransform:"uppercase",marginBottom:8}}>
                    {new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
                  </div>
                  <h1 style={{fontSize:isMobile?26:38,fontWeight:800,letterSpacing:"-1.5px",margin:0,color:"white",lineHeight:1.1,marginBottom:10}}>
                    Good {new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"} 👋
                  </h1>
                  <p style={{fontSize:isMobile?13:15,color:"rgba(148,163,184,0.9)",margin:0,maxWidth:480,lineHeight:1.6}}>
                    {requests.length===0
                      ?"Welcome to ProQuote — create your first material request to get started"
                      :`You have ${stats.pending} pending quote${stats.pending!==1?"s":""} waiting${stats.received>0?` and ${stats.received} ready to analyse`:""}.${orders.filter(o=>o.status==="pending-send").length>0?` ${orders.filter(o=>o.status==="pending-send").length} PO${orders.filter(o=>o.status==="pending-send").length!==1?"s":""} ready to send.`:""}`
                    }
                  </p>
                </div>
                <button onClick={()=>{setView("new");resetNewRequest();}} style={{display:"flex",alignItems:"center",gap:8,background:"linear-gradient(135deg,#22C55E,#16A34A)",color:"white",border:"none",borderRadius:14,padding:isMobile?"11px 18px":"14px 26px",fontSize:isMobile?13:15,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 24px rgba(34,197,94,0.4)",letterSpacing:"-0.2px",whiteSpace:"nowrap",flexShrink:0}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  New request
                </button>
              </div>


            </div>

            {/* ── Overdue quote reminders ── */}
            {(()=>{
              const now = Date.now();
              const overdue = requests.filter(r=>{
                if (r.status!=="pending") return false;
                const sent = r.activity?.find(a=>a.action==="Created")?.ts;
                if (!sent) return false;
                const hoursAgo = (now - new Date(sent).getTime()) / 3600000;
                return hoursAgo >= 24;
              });
              if (!overdue.length) return null;
              return(
                <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:14,padding:"14px 20px",marginBottom:20}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#9A3412",marginBottom:10}}>⏰ Suppliers haven't responded yet</div>
                  {overdue.map(r=>{
                    const sent = r.activity?.find(a=>a.action==="Created")?.ts;
                    const hoursAgo = Math.floor((now - new Date(sent).getTime()) / 3600000);
                    const daysAgo = Math.floor(hoursAgo/24);
                    const pendingSups = (r.sentTo||[]).filter(s=>!s.saved).map(s=>s.name);
                    return(
                      <div key={r.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #FED7AA"}}>
                        <div>
                          <span style={{fontSize:13,fontWeight:600,color:"#7C2D12"}}>{r.jobRef}</span>
                          <span style={{fontSize:12,color:"#C2410C",marginLeft:8}}>
                            {pendingSups.length>0?`${pendingSups.join(", ")} hasn't responded`:"No quotes received"}
                          </span>
                          <span style={{fontSize:11,color:"#EA580C",marginLeft:8}}>· {daysAgo>0?`${daysAgo} day${daysAgo!==1?"s":""}`:`${hoursAgo}h`} ago</span>
                        </div>
                        <div style={{display:"flex",gap:8}}>
                          <button onClick={()=>{setActiveReq(r);setView("quotes");}} style={{fontSize:11,color:"#EA580C",background:"#FEF3C7",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>View →</button>
                          {r.rfqEmail&&<button onClick={async()=>{
                            const unsent = (r.sentTo||[]).filter(s=>!s.saved);
                            if(!unsent.length||!settings.resendKey) return;
                            const subject = `REMINDER: Request for Quotation — ${r.jobRef}`;
                            await sendRFQEmails(unsent, subject, `Hi,

This is a friendly reminder regarding our request for quotation sent ${daysAgo>0?`${daysAgo} days ago`:`${hoursAgo} hours ago`} for job ${r.jobRef}.

Could you please send us your quotation at your earliest convenience?

Kind regards
${settings.contactName||settings.company||"The Procurement Team"}`, settings.resendKey, settings.fromEmail||"onboarding@resend.dev");
                            showToast(`Reminder sent to ${unsent.map(s=>s.name).join(", ")}`);
                          }} style={{fontSize:11,color:"white",background:"#EA580C",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontWeight:600}}>Send reminder</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* ── Setup warnings ── */}
            {!settings.openRouterKey&&(
              <div style={{background:"#FFF1F2",border:"1px solid #FDA4AF",borderRadius:12,padding:"14px 20px",marginBottom:20,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:32,height:32,background:"#FEE2E2",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>⚠️</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:"#9F1239"}}>AI key required</div>
                    <div style={{fontSize:12,color:"#BE123C",marginTop:1}}>Add your free OpenRouter key in Settings to enable AI features</div>
                  </div>
                </div>
                <button onClick={()=>setView("settings")} style={{background:"#9F1239",color:"white",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>Configure →</button>
              </div>
            )}
            {settings.openRouterKey&&!settings.resendKey&&(
              <div style={{background:"var(--amber-light)",border:"1px solid #FDE68A",borderRadius:12,padding:"14px 20px",marginBottom:20,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:32,height:32,background:"#FEF3C7",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📧</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:"var(--amber)"}}>Email not configured</div>
                    <div style={{fontSize:12,color:"var(--amber)",marginTop:1}}>Add your Resend API key to send RFQs directly to suppliers</div>
                  </div>
                </div>
                <button onClick={()=>setView("settings")} style={{background:"#D97706",color:"white",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>Configure →</button>
              </div>
            )}

            {/* ── Stat cards ── */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"repeat(2,1fr)":"repeat(4,1fr)",gap:isMobile?10:14,marginBottom:isMobile?18:24}}>
              {[
                {label:"Total requests",  value:stats.total,    color:"#6366F1", grad:"linear-gradient(135deg,#6366F1,#4338CA)", icon:"📋", nav:()=>setView("requests")},
                {label:"Awaiting quotes", value:stats.pending,  color:"#F59E0B", grad:"linear-gradient(135deg,#F59E0B,#D97706)", icon:"⏳", nav:()=>setView("quotes")},
                {label:"Quotes received", value:stats.received, color:"#8B5CF6", grad:"linear-gradient(135deg,#8B5CF6,#7C3AED)", icon:"📬", nav:()=>{setView("quotes");if(requests.length&&!activeReq)setActiveReq(requests[0]);}},
                {label:"Approved POs",    value:stats.approved, color:"#22C55E", grad:"linear-gradient(135deg,#22C55E,#16A34A)", icon:"✅", nav:()=>setView("orders")},
              ].map(s=>(
                <button key={s.label} onClick={s.nav} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-md)",padding:isMobile?"14px 16px":"20px 22px",border:"1px solid var(--border)",position:"relative",overflow:"hidden",boxShadow:"var(--shadow-sm)",textAlign:"left",cursor:"pointer",transition:"all 0.15s",display:"block",width:"100%"}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=s.color;e.currentTarget.style.boxShadow=`0 4px 16px ${s.color}22`;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.boxShadow="var(--shadow-sm)";}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div style={{fontSize:22}}>{s.icon}</div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                  </div>
                  <div style={{fontSize:isMobile?26:36,fontWeight:800,fontFamily:"'JetBrains Mono',monospace",lineHeight:1,letterSpacing:"-2px",color:s.value>0?s.color:"var(--text-muted)",marginBottom:4}}>{s.value}</div>
                  <div style={{fontSize:12,color:"var(--text-secondary)",fontWeight:500}}>{s.label}</div>
                  <div style={{position:"absolute",bottom:0,left:0,right:0,height:3,background:s.value>0?s.grad:"transparent",borderRadius:"0 0 var(--radius-md) var(--radius-md)"}}/>
                </button>
              ))}
            </div>

            {/* ── Quick actions ── */}
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)",gap:isMobile?8:12,marginBottom:isMobile?18:24}}>
              {[
                {label:"New request",  sub:"Voice or type",              icon:"🎤", action:()=>setView("new"),      accent:"#6366F1"},
                {label:"Analyse",      sub:"Compare supplier quotes",    icon:"🔍", action:()=>{setView("quotes");if(requests.length&&!activeReq)setActiveReq(requests[0]);}, accent:"#8B5CF6"},
                {label:"Orders",       sub:`${orders.filter(o=>o.status==="pending-send").length} ready to send`, icon:"📦", action:()=>setView("orders"), accent:"#22C55E"},
                {label:"Suppliers",    sub:"Manage accounts",            icon:"🏢", action:()=>setView("suppliers"), accent:"#F59E0B"},
              ].map(q=>(
                <button key={q.label} onClick={q.action} style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:8,padding:isMobile?"12px 14px":"18px 20px",background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:16,cursor:"pointer",textAlign:"left",boxShadow:"var(--shadow-sm)",transition:"all 0.15s",position:"relative",overflow:"hidden",minHeight:isMobile?90:100}}>
                  <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:q.accent,borderRadius:"16px 16px 0 0"}}/>
                  <div style={{fontSize:20,marginTop:2}}>{q.icon}</div>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:2}}>{q.label}</div>
                    <div style={{fontSize:11,color:"var(--text-tertiary)",lineHeight:1.4}}>{q.sub}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* ── Requests table ── */}
            <div style={{background:"var(--bg-card-solid)",borderRadius:20,border:"1px solid var(--border)",overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.04),0 4px 16px rgba(0,0,0,0.03)"}}>
              <div style={{padding:"18px 24px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center",background:darkMode?"rgba(34,197,94,0.04)":"linear-gradient(135deg,#FAFFFE,#F0FDF4)"}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:"var(--text-primary)",letterSpacing:"-0.3px"}}>Recent requests</div>
                  <div style={{fontSize:12,color:"var(--text-tertiary)",marginTop:2}}>{requests.length} total · sorted by most recent</div>
                </div>
                <button onClick={()=>setView("requests")} style={{fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"none",borderRadius:8,padding:"6px 14px",cursor:"pointer",fontWeight:600}}>View all →</button>
              </div>

              {requests.length===0?(
                <div style={{padding:"80px 24px",textAlign:"center"}}>
                  <div style={{width:80,height:80,background:"linear-gradient(135deg,#F0FDF4,#DCFCE7)",borderRadius:24,display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,margin:"0 auto 20px"}}>📋</div>
                  <div style={{fontSize:20,fontWeight:700,color:"var(--text-primary)",marginBottom:8,letterSpacing:"-0.5px"}}>No requests yet</div>
                  <div style={{fontSize:14,color:"var(--text-tertiary)",marginBottom:28,maxWidth:340,margin:"0 auto 28px",lineHeight:1.6}}>Create your first material request — speak or type what you need, and we'll send RFQs to your suppliers automatically</div>
                  <button onClick={()=>setView("new")} style={{display:"inline-flex",alignItems:"center",gap:8,background:"linear-gradient(135deg,#22C55E,#16A34A)",color:"white",border:"none",borderRadius:12,padding:"13px 28px",fontSize:14,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 20px rgba(34,197,94,0.35)"}}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Create first request
                  </button>
                </div>
              ):(
                <div>
                  {requests.slice(0,8).map((r,idx)=>{
                    const sc=STATUS[r.status];
                    const savedCount=(r.sentTo||[]).filter(s=>s.saved).length;
                    const totalCount=(r.sentTo||[]).length;
                    return(
                    <div key={r.id} onClick={()=>{setActiveReq(r);setView("quotes");}} style={{display:"flex",alignItems:"center",gap:0,padding:"0 28px",borderTop:idx===0?"none":"1px solid #F8FAFC",cursor:"pointer",transition:"background 0.1s"}}
                      onMouseEnter={e=>e.currentTarget.style.background=darkMode?"rgba(34,197,94,0.04)":"#FAFFFE"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      {/* Status bar */}
                      <div style={{width:3,height:40,background:sc.text,borderRadius:99,marginRight:20,flexShrink:0,opacity:0.6}}/>
                      {/* ID */}
                      <div style={{width:100,flexShrink:0,padding:"16px 0"}}>
                        <div style={{fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--indigo)"}}>{r.id}</div>
                        <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:2}}>{r.created}</div>
                      </div>
                      {/* Job & site */}
                      <div style={{flex:1,padding:"16px 20px 16px 0"}}>
                        <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>{r.jobRef}</div>
                        <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{r.site}</div>
                      </div>
                      {/* Trade badge */}
                      <div style={{width:110,padding:"16px 0",flexShrink:0}}>
                        <span style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:20}}>{r.trade}</span>
                      </div>
                      {/* Items count */}
                      <div style={{width:80,padding:"16px 0",flexShrink:0,textAlign:"center"}}>
                        <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)"}}>{r.items.length}</div>
                        <div style={{fontSize:11,color:"var(--text-tertiary)"}}>items</div>
                      </div>
                      {/* Quote progress */}
                      {totalCount>0&&(
                        <div style={{width:100,padding:"16px 0",flexShrink:0,textAlign:"center"}}>
                          <div style={{fontSize:12,fontWeight:600,color:savedCount===totalCount?"#22C55E":"#F59E0B"}}>{savedCount}/{totalCount}</div>
                          <div style={{fontSize:11,color:"var(--text-tertiary)"}}>quotes in</div>
                        </div>
                      )}
                      {/* Status + deadline */}
                      <div style={{width:150,padding:"16px 0",flexShrink:0}}>
                        <Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge>
                        {r.rfqDeadline&&r.status==="pending"&&(()=>{
                          const daysLeft = Math.ceil((new Date(r.rfqDeadline).getTime()-Date.now())/86400000);
                          return <div style={{fontSize:10,marginTop:4,color:daysLeft<=0?"#DC2626":daysLeft<=1?"#D97706":"#16A34A",fontWeight:600}}>{daysLeft<=0?"Deadline passed":`⏰ ${daysLeft}d left`}</div>;
                        })()}
                      </div>
                      {/* Arrow */}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  )})}
                  {requests.length>8&&(
                    <div style={{padding:"14px 28px",borderTop:"1px solid var(--border)",textAlign:"center"}}>
                      <button onClick={()=>setView("requests")} style={{fontSize:13,color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View all {requests.length} requests →</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══ NEW REQUEST WIZARD ══ */}
        {view==="new"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:28,fontWeight:700,letterSpacing:"-0.8px",margin:0,color:"var(--text-primary)"}}>New material request</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Speak or type your list — AI structures it and sends RFQs to suppliers</p>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:28,alignItems:"center"}}>
              {["Describe materials","Review & configure","Send RFQs"].map((s,i)=>(
                <div key={s} style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:600,background:step>i+1?"#6366F1":step===i+1?"#6366F1":"#E5E7EB",color:step>=i+1?"white":"#9CA3AF",boxShadow:step===i+1?"0 4px 12px rgba(99,102,241,0.35)":"none"}}>{step>i+1?"✓":i+1}</div>
                  <span style={{fontSize:13,color:step===i+1?"#111827":"#9CA3AF",fontWeight:step===i+1?500:400,display:isMobile?"none":"block"}}>{s}</span>
                  {i<2&&<div style={{width:36,height:1,background:"#E5E7EB"}}/>}
                </div>
              ))}
            </div>

            {/* Step 1 */}
            {step===1&&(
              <Card>
                <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr 1fr",gap:isMobile?12:16,marginBottom:20}}>
                  {[{label:"Job reference",val:jobRef,set:setJobRef,ph:"e.g. JOB-2024-056"},{label:"Site / location",val:site,set:setSite,ph:"e.g. Unit 7, High Street"}].map(f=>(
                    <div key={f.label}>
                      <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>{f.label}</label>
                      <input value={f.val} onChange={e=>f.set(e.target.value)} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
                    </div>
                  ))}
                  <div>
                    <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Trade</label>
                    <select value={trade} onChange={e=>setTrade(e.target.value)} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,background:"var(--bg-card-solid)",outline:"none"}}>
                      {TRADES.map(t=><option key={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)"}}>Material requirements <span style={{color:"#9CA3AF",fontWeight:400}}>(speak or type naturally)</span></label>
                  {voiceOk?(
                    <button onClick={()=>listening?micStop():micStart()}
                      style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,border:`1.5px solid ${listening?"#DC2626":"#6366F1"}`,background:listening?"#FEF2F2":"#EEF2FF",color:listening?"#DC2626":"#6366F1",boxShadow:listening?"none":"0 2px 8px rgba(99,102,241,0.2)",fontSize:12,fontWeight:500,cursor:"pointer"}}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {listening?<rect x="6" y="6" width="12" height="12" rx="2"/>:<><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></>}
                      </svg>
                      {listening?"Stop":"Speak list"}
                      {listening&&<span style={{width:7,height:7,borderRadius:"50%",background:"#DC2626",display:"inline-block",animation:"pulse 1s infinite"}}/>}
                    </button>
                  ):(
                    <span style={{fontSize:11,color:"#9CA3AF"}}>Voice not available in this browser</span>
                  )}
                </div>
                {listening&&(
                  <div style={{background:"var(--red-light)",border:"1px solid #FECACA",borderRadius:8,padding:"10px 14px",marginBottom:8,fontSize:13,color:"var(--red)"}}>
                    <span style={{fontWeight:500}}>Listening… </span>
                    {interim?<span style={{color:"var(--red)"}}>{interim}</span>:<span style={{color:"#FCA5A5"}}>speak your list now</span>}
                  </div>
                )}
                <textarea value={rawInput} onChange={e=>setRawInput(e.target.value)}
                  placeholder={"Plumbing: \"I need 20 metres of 22mm copper pipe, 12 compression elbows, 6 isolation valves for the plant room.\"\n\nElectrical: \"100m of 2.5mm twin and earth, 20 double sockets, a 10-way consumer unit and 20mm conduit.\""}
                  style={{width:"100%",height:150,padding:"12px 14px",border:`1.5px solid ${listening?"#FECACA":"#E2E8F0"}`,borderRadius:12,fontSize:13,lineHeight:1.7,resize:"vertical",outline:"none",fontFamily:"inherit",background:listening?"#FFFBFB":"white",boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}/>
                <div style={{marginTop:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <button onClick={()=>setTemplateModal(true)} style={{fontSize:12,color:"#16A34A",background:"var(--green-mint)",border:"1px solid #A7F3D0",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontWeight:500}}>📋 Load template</button>
                  <Btn onClick={handleParse} disabled={!rawInput.trim()||loading}>
                    {loading?<><Spinner/>{loadMsg}</>:"✦ Parse with AI"}
                  </Btn>
                </div>
              </Card>
            )}

            {/* Step 2 */}
            {step===2&&parsed&&(
              <Card>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
                  <div>
                    <div style={{fontSize:15,fontWeight:500}}>AI parsed {parsed.items?.length} items</div>
                    <div style={{fontSize:13,color:"#6B7280",marginTop:2}}>Review before sending</div>
                  </div>
                  {parsed.urgency&&<Badge bg={parsed.urgency==="urgent"?"#FEF3C7":"#F0FDF4"} text={parsed.urgency==="urgent"?"#92400E":"#166534"}>{parsed.urgency}</Badge>}
                </div>
                <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",minWidth:680}}>
                  <thead><tr style={{background:"var(--bg-subtle)"}}>
                    {["#","Description","Qty","Unit","Category","Notes"].map(h=>(
                      <th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--text-tertiary)",textTransform:"uppercase",letterSpacing:"0.05em"}}>{h}</th>
                    ))}
                    <th style={{padding:"9px 8px",width:32}}></th>
                  </tr></thead>
                  <tbody>{parsed.items?.map((item,i)=>{
                    const updateItem = (field,val) => setParsed(p=>({...p,items:p.items.map((it,ii)=>ii===i?{...it,[field]:val}:it)}));
                    const cellStyle = {padding:"4px 6px",border:"1px solid transparent",borderRadius:6,fontSize:13,outline:"none",fontFamily:"inherit",background:"transparent",color:"var(--text-primary)",width:"100%",transition:"all 0.15s"};
                    const cellHover = {border:"1px solid var(--border)",background:"var(--bg-subtle)"};
                    return(
                    <tr key={item.id||i} style={{borderTop:"1px solid var(--border)"}}>
                      <td style={{padding:"8px 14px",fontSize:12,color:"var(--text-muted)",width:32,fontFamily:"monospace"}}>{i+1}</td>
                      <td style={{padding:"4px 8px",minWidth:180}}>
                        <input value={item.description||""} onChange={e=>updateItem("description",e.target.value)}
                          style={{...cellStyle,fontWeight:500}}
                          onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                          onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}
                        />
                      </td>
                      <td style={{padding:"4px 8px",width:80}}>
                        <input type="number" value={item.quantity||""} onChange={e=>updateItem("quantity",e.target.value)}
                          style={{...cellStyle,fontFamily:"'JetBrains Mono',monospace",width:70}}
                          onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                          onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}
                        />
                      </td>
                      <td style={{padding:"4px 8px",width:90}}>
                        <input value={item.unit||""} onChange={e=>updateItem("unit",e.target.value)}
                          style={{...cellStyle,width:80}}
                          onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                          onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}
                        />
                      </td>
                      <td style={{padding:"4px 8px",width:130}}>
                        <select value={item.category||"General"} onChange={e=>updateItem("category",e.target.value)}
                          style={{...cellStyle,width:120,cursor:"pointer"}}
                          onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--green-dark)",background:"var(--bg-subtle)"})}
                          onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}
                        >
                          {["Plumbing","HVAC","Electrical","Mechanical","Ventilation","Gas","General"].map(cat=>(
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      </td>
                      <td style={{padding:"4px 6px"}}>
                        <input value={item.notes||""} onChange={e=>updateItem("notes",e.target.value)}
                          placeholder="Add note…"
                          style={{...cellStyle,color:"var(--text-secondary)",fontSize:12}}
                          onFocus={e=>Object.assign(e.target.style,{border:"1px solid var(--border)",background:"var(--bg-subtle)"})}
                          onBlur={e=>Object.assign(e.target.style,{border:"1px solid transparent",background:"transparent"})}
                        />
                      </td>
                      <td style={{padding:"4px 6px",width:32,textAlign:"center"}}>
                        <button onClick={()=>setParsed(p=>({...p,items:p.items.filter((_,ii)=>ii!==i)}))}
                          title="Remove item"
                          style={{background:"none",border:"none",cursor:"pointer",color:"var(--text-muted)",fontSize:14,lineHeight:1,padding:"2px 4px",borderRadius:4}}
                          onMouseEnter={e=>e.target.style.color="var(--red)"}
                          onMouseLeave={e=>e.target.style.color="var(--text-muted)"}
                        >×</button>
                      </td>
                    </tr>
                  )})}
                  </tbody>
                </table>
                </div>
                <button onClick={()=>setParsed(p=>({...p,items:[...p.items,{id:Date.now(),description:"",quantity:1,unit:"pcs",category:"General",notes:""}]}))}
                  style={{marginTop:8,fontSize:12,color:"var(--green-dark)",background:"none",border:"1px dashed var(--green-dark)",borderRadius:6,padding:"5px 14px",cursor:"pointer",fontWeight:500}}>
                  + Add item
                </button>
                <div style={{marginTop:20,padding:16,background:"var(--bg-subtle)",borderRadius:8}}>
                  <div style={{fontSize:13,fontWeight:500,marginBottom:10}}>Suppliers to receive RFQ <span style={{color:"#6B7280",fontWeight:400}}>({trade})</span></div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {filteredSup.map(s=>(
                      <label key={s.id} style={{display:"flex",alignItems:"center",gap:8,fontSize:13,cursor:"pointer",background:selSup.includes(s.id)?"var(--green-mint)":"var(--bg-card-solid)",border:`1px solid ${selSup.includes(s.id)?"var(--green-dark)":"var(--border)"}`,borderRadius:8,padding:"8px 14px",transition:"all 0.15s"}}>
                        <input type="checkbox" checked={selSup.includes(s.id)} onChange={e=>setSelSup(p=>e.target.checked?[...p,s.id]:p.filter(id=>id!==s.id))} style={{accentColor:"var(--green-dark)"}}/>
                        <span style={{fontWeight:600,color:"var(--text-primary)"}}>{s.name}</span>
                        <span style={{fontSize:11,color:"var(--text-tertiary)"}}>{s.email}</span>
                      </label>
                    ))}
                    {filteredSup.length===0&&<div style={{fontSize:13,color:"#9CA3AF"}}>No suppliers for {trade} — add them in Suppliers.</div>}
                  </div>
                </div>
                {/* ── Delivery method ── */}
                <div style={{marginTop:16,padding:18,background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",border:"1px solid var(--border)"}}>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--green-dark)",marginBottom:14}}>🚚 Delivery requirements</div>
                  <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:16,marginBottom:14}}>
                    <div>
                      <div style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",marginBottom:8}}>Delivery method</div>
                      <div style={{display:"flex",flexDirection:"column",gap:8}}>
                        {[
                          {val:"direct",    icon:"📍", label:"Deliver direct to site",         sub:`${site||"site address"}`},
                          {val:"alternative",icon:"🏢", label:"Deliver to alternative address", sub:"specify address below"},
                          {val:"collect",   icon:"🏪", label:"Collect from branch",             sub:"we will collect"},
                          {val:"tbc",       icon:"❓", label:"To be confirmed",                 sub:"supplier to await confirmation"},
                        ].map(opt=>(
                          <label key={opt.val} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",borderRadius:8,border:`1.5px solid ${deliveryMethod===opt.val?"var(--green-dark)":"var(--border)"}`,background:deliveryMethod===opt.val?"var(--green-mint)":"var(--bg-card-solid)",cursor:"pointer",transition:"all 0.15s"}}>
                            <input type="radio" name="deliveryMethod" value={opt.val} checked={deliveryMethod===opt.val} onChange={()=>setDeliveryMethod(opt.val)} style={{accentColor:"var(--green-dark)",marginTop:2}}/>
                            <div>
                              <div style={{fontSize:13,fontWeight:500,color:"var(--text-primary)"}}>{opt.icon} {opt.label}</div>
                              <div style={{fontSize:11,color:"var(--text-secondary)",marginTop:1}}>{opt.sub}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                      {deliveryMethod==="alternative"&&(
                        <div style={{marginTop:10}}>
                          <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Alternative delivery address</label>
                          <textarea value={altAddress} onChange={e=>setAltAddress(e.target.value)} placeholder="Full delivery address..." style={{width:"100%",height:70,padding:"8px 10px",border:"1px solid #BFDBFE",borderRadius:8,fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit"}}/>
                        </div>
                      )}
                    </div>
                    <div>
                      <div style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",marginBottom:8}}>Required delivery date</div>
                      <div style={{background:"var(--bg-subtle)",borderRadius:10,padding:14,border:"1px solid var(--border)"}}>
                        <input type="date" value={deliveryDate} onChange={e=>setDeliveryDate(e.target.value)} min={new Date().toISOString().split("T")[0]} style={{width:"100%",padding:"10px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:14,outline:"none",color:deliveryDate?"var(--text-primary)":"var(--text-tertiary)"}}/>
                        <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:8}}>Leave blank if date is flexible</div>
                        {deliveryDate&&(
                          <div style={{marginTop:8,padding:"8px 12px",background:"var(--green-mint)",borderRadius:6,fontSize:12,color:"var(--green-deep)",fontWeight:500}}>
                            ✓ Required by {new Date(deliveryDate).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
                          </div>
                        )}
                        <div style={{marginTop:12,fontSize:11,color:"var(--text-secondary)",lineHeight:1.6}}>
                          <div style={{fontWeight:500,marginBottom:4}}>This will tell suppliers to:</div>
                          <div>• Include carriage/delivery charges in their quote</div>
                          <div>• Confirm they can meet your required date</div>
                          <div>• State lead times clearly</div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{background:"var(--bg-card-solid)",borderRadius:8,padding:"10px 14px",border:"1px solid var(--border)",fontSize:12,color:"var(--indigo)"}}>
                    ℹ️ These delivery details will be included in the RFQ email and the AI will extract carriage charges from supplier responses during quote analysis.
                  </div>
                </div>

                <div style={{marginTop:20,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <Btn outline onClick={()=>setStep(1)}>← Back</Btn>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                    <button onClick={()=>setTemplateModal(true)} style={{fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"1px solid #C7D2FE",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontWeight:500}}>💾 Save as template</button>
                    <Btn onClick={handleGenRFQ} disabled={loading}>{loading?<><Spinner/>{loadMsg}</>:"Generate RFQ email →"}</Btn>
                  </div>
                </div>
              </Card>
            )}

            {/* Step 3 */}
            {step===3&&rfqEmail&&(
              <Card>
                <div style={{fontSize:15,fontWeight:500,marginBottom:4}}>RFQ email ready</div>
                <div style={{fontSize:13,color:"#6B7280",marginBottom:16}}>Will be sent to: {suppliers.filter(s=>selSup.includes(s.id)).map(s=>s.name).join(", ")}</div>
                <div style={{background:"var(--bg-subtle)",border:"1px solid var(--border-solid)",borderRadius:8,padding:20,marginBottom:16}}>
                  <div style={{fontSize:12,color:"#9CA3AF",marginBottom:4}}>To: {suppliers.filter(s=>selSup.includes(s.id)).map(s=>s.email).join(", ")}</div>
                  <div style={{fontSize:12,color:"#9CA3AF",marginBottom:14,paddingBottom:12,borderBottom:"1px solid #E5E7EB"}}>Subject: Request for Quotation — {jobRef||parsed?.jobRef||"TBC"}</div>
                  <pre style={{fontSize:13,lineHeight:1.7,whiteSpace:"pre-wrap",fontFamily:"inherit",margin:0,color:"var(--text-secondary)"}}>{rfqEmail}</pre>
                </div>

                {!settings.resendKey&&(
                  <div style={{background:"var(--amber-light)",border:"1px solid #FDE68A",borderRadius:8,padding:"12px 16px",marginBottom:16,fontSize:13,color:"var(--amber)"}}>
                    ⚠ Resend not configured. <button onClick={()=>setView("settings")} style={{background:"none",border:"none",color:"#B45309",textDecoration:"underline",cursor:"pointer",fontSize:13,padding:0}}>Add it in Settings</button> to send for real. You can still save the request.
                  </div>
                )}

                {emailRes&&(
                  <div style={{marginBottom:16}}>
                    {emailRes.map((r,i)=>(
                      <div key={i} style={{padding:"10px 14px",borderRadius:8,marginBottom:8,background:r.success?"#F0FDF4":"#FEF2F2",border:`1px solid ${r.success?"#A7F3D0":"#FECACA"}`}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13}}>
                          <span style={{color:r.success?"#059669":"#DC2626",fontWeight:600}}>{r.success?"✓":"✗"}</span>
                          <span style={{fontWeight:500}}>{r.supplier}</span>
                          <span style={{color:r.success?"#059669":"#DC2626"}}>{r.success?"Email sent successfully":`Error ${r.statusCode||""}: ${r.error}`}</span>
                        </div>
                        {r.success&&r.id&&<div style={{fontSize:11,color:"#9CA3AF",marginTop:4}}>Message ID: {r.id}</div>}
                        {!r.success&&r.error?.includes("CORS")&&(
                          <div style={{fontSize:12,color:"var(--red)",marginTop:6,background:"#FEE2E2",padding:"8px 10px",borderRadius:6}}>
                            CORS error — Resend blocks direct browser calls in some environments. Try deploying to Vercel where this works correctly.
                          </div>
                        )}
                        {!r.success&&r.statusCode===403&&(
                          <div style={{fontSize:12,color:"var(--red)",marginTop:6,background:"#FEE2E2",padding:"8px 10px",borderRadius:6}}>
                            403 Forbidden — your Resend key may not have send permissions. Go to resend.com → API Keys → check the key has "Full access" not "Read only".
                          </div>
                        )}
                        {!r.success&&r.statusCode===422&&(
                          <div style={{fontSize:12,color:"var(--red)",marginTop:6,background:"#FEE2E2",padding:"8px 10px",borderRadius:6}}>
                            422 — Resend rejected the request. On free accounts you can only send to your own verified email address. Go to resend.com → click your email in the top right → verify it, then use that address as a test recipient in Suppliers.
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{display:"flex",gap:10,justifyContent:"space-between"}}>
                  <Btn outline onClick={()=>setStep(2)}>← Back</Btn>
                  <div style={{display:"flex",gap:10}}>
                    {settings.resendKey&&!emailRes&&(
                      <Btn onClick={handleSendEmails} disabled={loading||selSup.length===0} color="#16A34A">
                        {loading?<><Spinner/>{loadMsg}</>:`Send to ${selSup.length} supplier${selSup.length!==1?"s":""} →`}
                      </Btn>
                    )}
                    {emailRes&&emailRes.some(r=>r.success)&&(
                      <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--green-light)",border:"1px solid var(--green-dark)",borderRadius:10,padding:"10px 16px"}}>
                        <span style={{fontSize:18}}>✅</span>
                        <div>
                          <div style={{fontSize:13,fontWeight:600,color:"var(--green-dark)"}}>Quotes sent successfully</div>
                          <div style={{fontSize:12,color:"var(--green-dark)",opacity:0.8}}>Redirecting to dashboard…</div>
                        </div>
                      </div>
                    )}
                    {!settings.resendKey&&(
                      <div style={{fontSize:13,color:"var(--text-tertiary)",display:"flex",alignItems:"center",gap:6}}>
                        <span>Configure Resend in</span>
                        <button onClick={()=>setView("settings")} style={{color:"var(--indigo)",background:"none",border:"none",cursor:"pointer",fontWeight:600,fontSize:13,padding:0}}>Settings</button>
                        <span>to send emails</span>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ══ QUOTE ANALYSIS ══ */}
        {view==="quotes"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:28,fontWeight:700,letterSpacing:"-0.8px",margin:0,color:"var(--text-primary)"}}>Quote analysis</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Select a request, enter each supplier quote, then run AI analysis</p>
            </div>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"240px 1fr",gap:isMobile?12:20}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",marginBottom:10,textTransform:"uppercase",letterSpacing:"0.05em"}}>Requests</div>
                {requests.length===0&&<div style={{fontSize:13,color:"#9CA3AF",padding:"20px 0"}}>No requests yet — create one first</div>}
                {requests.map(r=>{
                  const savedCount = (r.sentTo||[]).filter(s=>s.saved).length;
                  const totalCount = (r.sentTo||[]).length;
                  return(
                  <button key={r.id} onClick={()=>{setActiveReq(r);setQuoteAnalysis(null);setAllAnalyses([]);}}
                    style={{width:"100%",textAlign:"left",padding:"12px 14px",borderRadius:10,border:`1.5px solid ${activeReq?.id===r.id?"#3B82F6":"#E5E7EB"}`,background:activeReq?.id===r.id?"#EFF6FF":"white",cursor:"pointer",marginBottom:8,transition:"all 0.15s"}}>
                    <div style={{fontSize:12,fontWeight:600,fontFamily:"'JetBrains Mono',monospace",color:"#3B82F6"}}>{r.id}</div>
                    <div style={{fontSize:13,fontWeight:500,color:"var(--text-primary)",marginTop:3}}>{r.jobRef}</div>
                    <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:1}}>{r.trade} · {r.items.length} items</div>
                    <div style={{marginTop:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <Badge bg={STATUS[r.status].bg} text={STATUS[r.status].text}>{STATUS[r.status].label}</Badge>
                      {totalCount>0&&<span style={{fontSize:11,color:"var(--text-secondary)"}}>{savedCount}/{totalCount} quotes in</span>}
                    </div>
                    {r.notes&&<div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:4,fontStyle:"italic"}}>{r.notes}</div>}
                  </button>
                  );
                })}
              </div>
              <div>
                {activeReq?(
                  <>
                    {/* Request summary header */}
                    <Card style={{marginBottom:16}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                        <div>
                          <div style={{fontSize:16,fontWeight:600,color:"#0F172A"}}>{activeReq.id} — {activeReq.jobRef}</div>
                          <div style={{fontSize:13,color:"var(--text-secondary)",marginTop:2}}>{activeReq.site} · {activeReq.trade} · {activeReq.items.length} items</div>
                        </div>
                        <div style={{display:"flex",gap:8}}>
                          <button onClick={()=>{setEditModal(activeReq);setEditForm({jobRef:activeReq.jobRef,site:activeReq.site,status:activeReq.status,notes:activeReq.notes||""});}} style={{fontSize:12,color:"#6B7280",background:"var(--bg-subtle)",border:"1px solid var(--border-solid)",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>✏️ Edit</button>
                          <button onClick={()=>setActivityModal(activeReq)} style={{fontSize:12,color:"#6B7280",background:"var(--bg-subtle)",border:"1px solid var(--border-solid)",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>📋 Log {activeReq.activity?.length?`(${activeReq.activity.length})`:""}</button>
                          <button onClick={()=>setDeleteConfirm(activeReq.id)} style={{fontSize:12,color:"var(--red)",background:"var(--red-light)",border:"1px solid #FECACA",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>🗑️ Delete</button>
                        </div>
                      </div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
                        {activeReq.items.map((item,i)=>(
                          <span key={i} style={{background:"var(--bg-subtle2)",borderRadius:6,padding:"4px 10px",fontSize:12,color:"var(--text-secondary)"}}>
                            <span style={{fontWeight:600}}>{item.quantity} {item.unit}</span> {item.description}
                          </span>
                        ))}
                      </div>
                      {/* Pending status timeline */}
                      {activeReq.status==="pending"&&(activeReq.sentTo||[]).every(s=>!s.saved)&&(
                        <div style={{marginTop:12,padding:"12px 16px",background:"var(--amber-light)",border:"1px solid var(--amber)",borderRadius:"var(--radius-md)"}}>
                          <div style={{fontSize:12,fontWeight:600,color:"var(--amber)",marginBottom:8}}>⏳ Awaiting supplier responses</div>
                          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                            {(activeReq.sentTo||[]).map(sup=>{
                              const sent = activeReq.activity?.find(a=>a.action==="RFQ emails sent")?.ts;
                              const hoursAgo = sent?Math.floor((Date.now()-new Date(sent).getTime())/3600000):0;
                              return(
                                <div key={sup.id} style={{display:"flex",alignItems:"center",gap:6,background:"var(--bg-card-solid)",border:`1px solid ${sup.saved?"var(--green-dark)":"var(--border)"}`,borderRadius:8,padding:"6px 12px"}}>
                                  <div style={{width:8,height:8,borderRadius:"50%",background:sup.saved?"var(--green-dark)":"var(--amber)",flexShrink:0}}/>
                                  <div>
                                    <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{sup.name}</div>
                                    <div style={{fontSize:10,color:"var(--text-tertiary)"}}>{sup.saved?"Quote received":sent?`Sent ${hoursAgo}h ago`:"Pending"}</div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {(()=>{
                            const sent = activeReq.activity?.find(a=>a.action==="RFQ emails sent")?.ts;
                            const hoursAgo = sent?Math.floor((Date.now()-new Date(sent).getTime())/3600000):0;
                            if(hoursAgo>=24&&settings.resendKey){
                              return <div style={{marginTop:8,display:"flex",gap:8,alignItems:"center"}}>
                                <span style={{fontSize:11,color:"var(--amber)"}}>No responses after {Math.floor(hoursAgo/24)}d {hoursAgo%24}h</span>
                                <button style={{fontSize:11,fontWeight:600,color:"white",background:"var(--amber)",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer"}}>Send reminder</button>
                              </div>;
                            }
                          })()}
                        </div>
                      )}

                      {(activeReq.deliveryMethod||activeReq.deliveryDate)&&(
                        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                          {activeReq.deliveryMethod&&(
                            <span style={{background:"var(--indigo-light)",border:"1px solid var(--border)",color:"var(--indigo)",fontSize:12,fontWeight:500,padding:"4px 12px",borderRadius:20}}>
                              🚚 {{direct:"Deliver to site",alternative:"Alt. address delivery",collect:"Collect from branch",tbc:"Delivery TBC"}[activeReq.deliveryMethod]||activeReq.deliveryMethod}
                            </span>
                          )}
                          {activeReq.deliveryDate&&(
                            <span style={{background:"var(--green-mint)",border:"1px solid #A7F3D0",color:"var(--green-deep)",fontSize:12,fontWeight:500,padding:"4px 12px",borderRadius:20}}>
                              📅 Required by {new Date(activeReq.deliveryDate).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}
                            </span>
                          )}
                          {activeReq.rfqDeadline&&(()=>{
                            const daysLeft = Math.ceil((new Date(activeReq.rfqDeadline).getTime()-Date.now())/86400000);
                            return <span style={{background:daysLeft<=0?"#FEF2F2":daysLeft<=1?"#FFFBEB":"#FFFBEB",border:`1px solid ${daysLeft<=0?"#FECACA":"#FDE68A"}`,color:daysLeft<=0?"#DC2626":"#92400E",fontSize:12,fontWeight:600,padding:"4px 12px",borderRadius:20}}>
                              ⏰ {daysLeft<=0?"Deadline passed":`Respond by ${new Date(activeReq.rfqDeadline).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`}
                            </span>;
                          })()}
                          {activeReq.altAddress&&(
                            <span style={{background:"var(--amber-light)",border:"1px solid #FDE68A",color:"var(--amber)",fontSize:12,padding:"4px 12px",borderRadius:20}}>
                              📍 {activeReq.altAddress}
                            </span>
                          )}
                        </div>
                      )}
                    </Card>

                    {/* Quote input boxes — one per supplier */}
                    {(activeReq.sentTo&&activeReq.sentTo.length>0)?(
                      <div style={{marginBottom:16}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                          <div>
                            <div style={{fontSize:14,fontWeight:600,color:"#0F172A"}}>Supplier quotes</div>
                            <div style={{fontSize:13,color:"var(--text-secondary)",marginTop:2}}>
                              RFQ was sent to {activeReq.sentTo.length} supplier{activeReq.sentTo.length!==1?"s":""}. Paste each quote below, save it, then run the AI analysis.
                            </div>
                          </div>
                          <div style={{fontSize:13,fontWeight:600,color:"#3B82F6"}}>
                            {activeReq.sentTo.filter(s=>s.saved).length} of {activeReq.sentTo.length} quotes entered
                          </div>
                        </div>

                        {activeReq.sentTo.map((sup,si)=>(
                          <Card key={sup.id} style={{marginBottom:12,border:sup.saved?"1px solid #A7F3D0":"1px solid #E2E8F0"}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                              <div style={{display:"flex",alignItems:"center",gap:10}}>
                                <div style={{width:36,height:36,background:sup.saved?"#D1FAE5":"#EFF6FF",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:sup.saved?"#059669":"#3B82F6"}}>{sup.name.charAt(0)}</div>
                                <div>
                                  <div style={{fontSize:14,fontWeight:600,color:"#0F172A"}}>{sup.name}</div>
                                  <div style={{fontSize:12,color:"var(--text-secondary)"}}>{sup.email}</div>
                                </div>
                              </div>
                              {sup.saved
                                ? <span style={{background:"#D1FAE5",color:"var(--green-deep)",fontSize:12,fontWeight:600,padding:"4px 12px",borderRadius:20}}>✓ Quote saved</span>
                                : <span style={{background:"#FEF3C7",color:"var(--amber)",fontSize:12,fontWeight:500,padding:"4px 12px",borderRadius:20}}>Awaiting quote</span>
                              }
                            </div>
                            {/* Drag and drop + file upload zone */}
                            {(()=>{
                              const processFile = async(file) => {
                                if (!file) return;
                                if (!settings.openRouterKey) { showToast("Add your OpenRouter key in Settings first","warn"); setView("settings"); return; }
                                window.__piq_or_key__ = settings.openRouterKey;
                                setFileExtracting(prev=>({...prev,[si]:true}));
                                showToast(`Reading ${file.name}…`);
                                try {
                                  const { content, type } = await readFileForExtraction(file);
                                  showToast(`AI extracting data from ${file.name}…`);
                                  const extracted = await extractQuoteFromFile(content, file.name, type);
                                  const newQuote = sup.quote?.trim()
                                    ? sup.quote + "\n\n--- From " + file.name + " ---\n" + extracted
                                    : "--- Extracted from " + file.name + " ---\n" + extracted;
                                  setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,quote:newQuote,saved:false}:s)}:r));
                                  setActiveReq(prev=>({...prev,sentTo:prev.sentTo.map((s,i)=>i===si?{...s,quote:newQuote,saved:false}:s)}));
                                  showToast(`✓ ${file.name} extracted — review and save`);
                                } catch(err) {
                                  showToast(`Could not read ${file.name}: ${err.message}`,"warn");
                                }
                                setFileExtracting(prev=>({...prev,[si]:false}));
                              };
                              return (
                                <div
                                  onDragOver={e=>{e.preventDefault();setDragOver(prev=>({...prev,[si]:true}));}}
                                  onDragLeave={e=>{e.preventDefault();setDragOver(prev=>({...prev,[si]:false}));}}
                                  onDrop={e=>{
                                    e.preventDefault();
                                    setDragOver(prev=>({...prev,[si]:false}));
                                    const file = e.dataTransfer.files[0];
                                    if (file) processFile(file);
                                  }}
                                  style={{
                                    marginBottom:10,
                                    padding:"14px 16px",
                                    background: dragOver[si]?"var(--indigo-light)":fileExtracting[si]?"var(--bg-subtle)":"var(--bg-subtle)",
                                    borderRadius:10,
                                    border: dragOver[si]?"2px dashed #3B82F6":fileExtracting[si]?"2px dashed #93C5FD":"2px dashed #CBD5E1",
                                    display:"flex",
                                    alignItems:"center",
                                    justifyContent:"space-between",
                                    gap:12,
                                    transition:"all 0.15s"
                                  }}
                                >
                                  <div>
                                    {fileExtracting[si]?(
                                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                                        <Spinner/>
                                        <div>
                                          <div style={{fontSize:12,fontWeight:500,color:"#3B82F6"}}>AI reading document…</div>
                                          <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:1}}>Extracting pricing and availability data</div>
                                        </div>
                                      </div>
                                    ):dragOver[si]?(
                                      <div>
                                        <div style={{fontSize:12,fontWeight:600,color:"#3B82F6"}}>Drop to upload</div>
                                        <div style={{fontSize:11,color:"#60A5FA",marginTop:1}}>Release to let AI read this document</div>
                                      </div>
                                    ):(
                                      <div>
                                        <div style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)"}}>📎 Drag & drop supplier document here</div>
                                        <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:1}}>PDF · Word · Excel · CSV — AI reads it and fills the box below</div>
                                      </div>
                                    )}
                                  </div>
                                  <label style={{
                                    display:"inline-flex",alignItems:"center",gap:6,
                                    background:fileExtracting[si]?"#DBEAFE":"white",
                                    color:fileExtracting[si]?"#93C5FD":"#3B82F6",
                                    fontSize:12,fontWeight:500,padding:"7px 14px",borderRadius:8,
                                    cursor:fileExtracting[si]?"not-allowed":"pointer",
                                    border:"1px solid #BFDBFE",whiteSpace:"nowrap",flexShrink:0
                                  }}>
                                    {fileExtracting[si]?"Reading…":"Browse file"}
                                    <input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.csv,.txt,.ods" disabled={fileExtracting[si]} style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) processFile(e.target.files[0]); e.target.value=""; }}/>
                                  </label>
                                </div>
                              );
                            })()}

                            <textarea
                              value={sup.quote||""}
                              onChange={e=>{
                                setRequests(p=>p.map(r=>r.id===activeReq.id?{
                                  ...r,
                                  sentTo:r.sentTo.map((s,i)=>i===si?{...s,quote:e.target.value,saved:false}:s)
                                }:r));
                                setActiveReq(prev=>({...prev,sentTo:prev.sentTo.map((s,i)=>i===si?{...s,quote:e.target.value,saved:false}:s)}));
                              }}
                              placeholder={`Option 1: Paste ${sup.name}'s quote email directly here\nOption 2: Upload their PDF/Excel above — AI reads it and fills this box automatically\n\nEither way, review the content then click Save quote`}
                              style={{width:"100%",height:140,padding:"10px 12px",border:`1px solid ${sup.quote?.trim()?"var(--green-dark)":"var(--border)"}`,borderRadius:8,fontSize:13,lineHeight:1.6,resize:"vertical",outline:"none",fontFamily:"inherit",background:sup.saved?"var(--green-mint)":"var(--bg-input)"}}
                            />
                            <div style={{marginTop:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <div style={{fontSize:11,color:"var(--text-tertiary)"}}>
                                {sup.quote?.trim()?`${sup.quote.trim().split(/\s+/).length} words entered`:"No quote entered yet"}
                              </div>
                              <div style={{display:"flex",gap:8}}>
                                {sup.quote?.trim()&&(
                                  <button onClick={()=>{
                                    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,quote:"",saved:false}:s)}:r));
                                    setActiveReq(prev=>({...prev,sentTo:prev.sentTo.map((s,i)=>i===si?{...s,quote:"",saved:false}:s)}));
                                  }} style={{fontSize:12,color:"var(--text-tertiary)",background:"none",border:"none",cursor:"pointer"}}>Clear</button>
                                )}
                                {sup.saved&&(
                                  <button onClick={()=>{
                                    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,saved:false}:s)}:r));
                                    setActiveReq(prev=>({...prev,sentTo:prev.sentTo.map((s,i)=>i===si?{...s,saved:false}:s)}));
                                  }} style={{fontSize:12,color:"var(--text-secondary)",background:"none",border:"1px solid var(--border-solid)",borderRadius:6,padding:"6px 12px",cursor:"pointer"}}>Edit</button>
                                )}
                                <Btn
                                  disabled={!sup.quote?.trim()}
                                  color={sup.saved?"#059669":"#3B82F6"}
                                  onClick={()=>{
                                    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,sentTo:r.sentTo.map((s,i)=>i===si?{...s,saved:true}:s)}:r));
                                    setActiveReq(prev=>({...prev,sentTo:prev.sentTo.map((s,i)=>i===si?{...s,saved:true}:s)}));
                                    showToast(`${sup.name} quote saved`);
                                  }}
                                >{sup.saved?"✓ Saved":"Save quote"}</Btn>
                              </div>
                            </div>
                          </Card>
                        ))}

                        {/* Analyse button — enabled when at least 1 quote saved */}
                        {activeReq.sentTo.some(s=>s.saved)&&(
                          <div style={{background:"linear-gradient(135deg,#0F172A,#1E3A5F)",borderRadius:14,padding:"20px 24px",marginTop:8}}>
                            <div style={{fontSize:14,fontWeight:600,color:"white",marginBottom:4}}>
                              {activeReq.sentTo.filter(s=>s.saved).length === activeReq.sentTo.length
                                ? "✓ All quotes received — ready for AI analysis"
                                : `${activeReq.sentTo.filter(s=>s.saved).length} of ${activeReq.sentTo.length} quotes saved — you can analyse now or wait for more`
                              }
                            </div>
                            <div style={{fontSize:13,color:"var(--text-tertiary)",marginBottom:16}}>
                              AI will compare all saved quotes against your original request — pricing, availability, carriage, discounts, alternatives
                            </div>
                            <Btn onClick={handleAnalyseAll} disabled={loading} color="#3B82F6">
                              {loading?<><Spinner/>{loadMsg}</>:`Analyse ${activeReq.sentTo.filter(s=>s.saved).length} quote${activeReq.sentTo.filter(s=>s.saved).length!==1?"s":""} with AI →`}
                            </Btn>
                          </div>
                        )}
                      </div>
                    ):(
                      /* Manual entry fallback for requests without sentTo data */
                      <Card style={{marginBottom:16}}>
                        <div style={{fontSize:13,fontWeight:500,marginBottom:4}}>Paste supplier quote</div>
                        <div style={{fontSize:12,color:"var(--text-tertiary)",marginBottom:12}}>This request has no supplier tracking. Enter supplier name and paste their quote.</div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                          <div>
                            <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Supplier name</label>
                            <input value={quoteSupplierName} onChange={e=>setQuoteSupplierName(e.target.value)} placeholder="e.g. BSS Industrial" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
                          </div>
                        </div>
                        <textarea value={quoteInput} onChange={e=>setQuoteInput(e.target.value)}
                          placeholder="Paste the supplier quote here..."
                          style={{width:"100%",height:120,padding:"12px 14px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,lineHeight:1.6,resize:"vertical",outline:"none",fontFamily:"inherit"}}/>
                        <div style={{marginTop:10,display:"flex",justifyContent:"flex-end"}}>
                          <Btn onClick={handleAnalyse} disabled={!quoteInput.trim()||loading} color="#7C3AED">
                            {loading?<><Spinner/>{loadMsg}</>:"Analyse with AI →"}
                          </Btn>
                        </div>
                      </Card>
                    )}

                    {allAnalyses.length>0&&(
                      <div>
                        {/* Comparison summary bar if multiple quotes */}
                        {allAnalyses.length>1&&(
                          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-md)",padding:"20px 24px",marginBottom:20,border:"1px solid var(--border)",boxShadow:"var(--shadow-sm)"}}>
                            <div style={{fontSize:14,fontWeight:600,marginBottom:16,color:"var(--text-primary)"}}>⚡ AI Comparison Summary — {allAnalyses.length} quotes received</div>
                            <div style={{display:"grid",gridTemplateColumns:`repeat(${allAnalyses.length},1fr)`,gap:12}}>
                              {[...allAnalyses].sort((a,b)=>b.completeness-a.completeness).map((a,i)=>{
                                const isBest = i===0;
                                const verdictColor = a.overallVerdict==="excellent"?"#4ADE80":a.overallVerdict==="good"?"#60A5FA":a.overallVerdict==="partial"?"#FBBF24":"#F87171";
                                return(
                                  <div key={a._id} style={{background:isBest?"var(--green-mint)":"var(--bg-subtle)",borderRadius:10,padding:"14px 16px",border:isBest?"1px solid var(--green-dark)":"1px solid var(--border)"}}>
                                    {isBest&&<div style={{fontSize:10,fontWeight:700,color:"var(--green-dark)",marginBottom:6,letterSpacing:"0.1em"}}>⭐ RECOMMENDED</div>}
                                    <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",marginBottom:8}}>{a.supplierName}</div>
                                    <div style={{fontSize:22,fontWeight:700,color:verdictColor||"var(--text-primary)",fontFamily:"monospace"}}>{a.completeness}%</div>
                                    <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:2}}>completeness</div>
                                    <div style={{fontSize:13,fontWeight:600,color:"var(--green-dark)",marginTop:8}}>{a.estimatedTotal||a.subtotal||"—"}</div>
                                    <div style={{fontSize:11,color:"var(--text-tertiary)"}}>est. total inc. carriage</div>
                                    {a.carriageCharge&&a.carriageCharge!=="Not stated"&&<div style={{fontSize:11,color:"var(--amber)",marginTop:4}}>🚚 {a.carriageCharge}</div>}
                                    {a.missing?.length>0&&<div style={{fontSize:11,color:"var(--red)",marginTop:4}}>✗ {a.missing.length} item{a.missing.length!==1?"s":""} missing</div>}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Individual quote cards */}
                        {allAnalyses.map((qa,qi)=>{
                          const verdictConfig = {
                            excellent:{bg:"var(--green-light)",  border:"var(--green-dark)", text:"var(--green-deep)", label:"Excellent"},
                            good:     {bg:"var(--indigo-light)", border:"var(--indigo)",     text:"var(--indigo)",     label:"Good"},
                            partial:  {bg:"var(--amber-light)",  border:"var(--amber)",      text:"var(--amber)",      label:"Partial"},
                            poor:     {bg:"var(--red-light)",    border:"var(--red)",        text:"var(--red)",        label:"Poor"},
                          }[qa.overallVerdict||"good"]||{bg:"var(--indigo-light)",border:"var(--indigo)",text:"var(--indigo)",label:"Good"};
                          return(
                          <Card key={qa._id} style={{marginBottom:20,borderTop:`3px solid ${verdictConfig.border}`,transition:"all 0.2s"}}>
                            {/* Quote header */}
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,paddingBottom:16,borderBottom:"1px solid var(--border)"}}>
                              <div>
                                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                                  <div style={{fontSize:17,fontWeight:700,color:"var(--text-primary)"}}>{qa.supplierName}</div>
                                  <span style={{background:verdictConfig.bg,color:verdictConfig.text,fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20,border:`1px solid ${verdictConfig.border}`}}>{verdictConfig.label}</span>
                                </div>
                                <div style={{fontSize:13,color:"var(--text-secondary)"}}>{qa.recommendation}</div>
                              </div>
                              <div style={{textAlign:"right",flexShrink:0,marginLeft:20}}>
                                <div style={{fontSize:11,color:"var(--text-tertiary)",marginBottom:2}}>Completeness</div>
                                <div style={{fontSize:32,fontWeight:700,fontFamily:"monospace",color:qa.completeness>=80?"#059669":qa.completeness>=60?"#D97706":"#DC2626",lineHeight:1}}>{qa.completeness}%</div>
                              </div>
                            </div>

                            {/* Financial summary strip */}
                            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
                              {[
                                {label:"Subtotal (ex VAT)",value:qa.subtotal||"—",color:"var(--text-primary)"},
                                {label:"Carriage / delivery",value:qa.carriageCharge||"Not stated",color:qa.carriageCharge==="Free"?"var(--green-dark)":qa.carriageCharge==="Not stated"?"var(--text-muted)":"var(--red)"},
                                {label:"Estimated total",value:qa.estimatedTotal||qa.subtotal||"—",color:"var(--text-primary)",bold:true},
                                {label:"Lead time",value:qa.leadTime||"Not stated",color:"var(--text-secondary)"},
                              ].map(f=>(
                                <div key={f.label} style={{background:"var(--bg-subtle)",borderRadius:10,padding:"12px 14px"}}>
                                  <div style={{fontSize:11,color:"var(--text-tertiary)",marginBottom:4,fontWeight:500}}>{f.label}</div>
                                  <div style={{fontSize:14,fontWeight:f.bold?700:500,color:f.color}}>{f.value}</div>
                                </div>
                              ))}
                            </div>

                            {/* Positives */}
                            {qa.positives?.length>0&&(
                              <div style={{background:"var(--green-mint)",borderRadius:10,padding:"12px 16px",marginBottom:16,display:"flex",flexWrap:"wrap",gap:8}}>
                                {qa.positives.map((p,i)=>(
                                  <span key={i} style={{fontSize:12,color:"var(--green-deep)",display:"flex",alignItems:"center",gap:4}}>✓ {p}</span>
                                ))}
                              </div>
                            )}

                            {/* Discounts */}
                            {qa.discounts?.length>0&&(
                              <div style={{background:"var(--amber-light)",border:"1px solid #FDE68A",borderRadius:10,padding:"12px 16px",marginBottom:16}}>
                                <div style={{fontSize:12,fontWeight:600,color:"var(--amber)",marginBottom:8}}>🏷️ Discounts available</div>
                                {qa.discounts.map((d,i)=>(
                                  <div key={i} style={{fontSize:13,color:"var(--text-primary)",marginBottom:4}}>
                                    <span style={{fontWeight:500}}>{d.item}</span> — {d.discount} {d.detail&&<span style={{color:"var(--amber)"}}>({d.detail})</span>}
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Matched items table */}
                            {qa.matched?.length>0&&(
                              <div style={{marginBottom:16}}>
                                <div style={{fontSize:12,fontWeight:600,color:"#059669",marginBottom:8}}>✓ Quoted items ({qa.matched.length})</div>
                                <div style={{overflowX:"auto"}}>
                                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                                    <thead><tr style={{background:"var(--green-mint)"}}>
                                      {["Item","Requested","Quoted","Unit price","Line total","Stock","Qty ✓","Notes"].map(h=>(
                                        <th key={h} style={{padding:"8px 10px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--text-secondary)",whiteSpace:"nowrap"}}>{h}</th>
                                      ))}
                                    </tr></thead>
                                    <tbody>{qa.matched.map((m,i)=>(
                                      <tr key={i} style={{borderTop:"1px solid #F3F4F6",background:i%2===0?"var(--bg-card-solid)":"var(--bg-subtle)"}}>
                                        <td style={{padding:"9px 10px",fontWeight:500,color:"#0F172A"}}>{m.item}</td>
                                        <td style={{padding:"9px 10px",color:"var(--text-secondary)",fontFamily:"monospace",fontSize:12}}>{m.requestedQty} {m.requestedUnit}</td>
                                        <td style={{padding:"9px 10px",fontFamily:"monospace",fontSize:12,color:m.qtyMatch?"#0F172A":"#DC2626",fontWeight:m.qtyMatch?400:600}}>{m.quotedQty||m.requestedQty} {m.quotedUnit||m.requestedUnit}</td>
                                        <td style={{padding:"9px 10px",fontWeight:600,color:"#059669",fontFamily:"monospace",fontSize:12}}>{m.unitPrice||m.quotedPrice||"—"}</td>
                                        <td style={{padding:"9px 10px",fontWeight:600,color:"#0F172A",fontFamily:"monospace",fontSize:12}}>{m.lineTotal||"—"}</td>
                                        <td style={{padding:"9px 10px"}}>
                                          <Badge bg={m.inStock?"#D1FAE5":"#FEE2E2"} text={m.inStock?"#065F46":"#991B1B"}>{m.inStock?(m.stockQty&&m.stockQty!=="unknown"?`${m.stockQty} in stock`:"In stock"):"Out of stock"}</Badge>
                                        </td>
                                        <td style={{padding:"9px 10px"}}>
                                          {m.qtyMatch===false
                                            ? <span style={{fontSize:11,color:"var(--red)",fontWeight:600}}>⚠ Mismatch</span>
                                            : <span style={{fontSize:11,color:"#059669"}}>✓ Match</span>
                                          }
                                        </td>
                                        <td style={{padding:"9px 10px",fontSize:12,color:"var(--text-secondary)"}}>{m.notes||"—"}</td>
                                      </tr>
                                    ))}</tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {/* Missing items */}
                            {qa.missing?.length>0&&(
                              <div style={{background:"var(--red-light)",border:"1px solid var(--red)",borderRadius:10,padding:"12px 16px",marginBottom:16}}>
                                <div style={{fontSize:12,fontWeight:600,color:"var(--red)",marginBottom:8}}>✗ Not quoted ({qa.missing.length} item{qa.missing.length!==1?"s":""})</div>
                                <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                                  {qa.missing.map((m,i)=>(
                                    <div key={i} style={{background:"#FEE2E2",borderRadius:6,padding:"4px 10px",fontSize:12,color:"var(--red)"}}>
                                      {m.item||m} {m.reason&&<span style={{color:"#B91C1C"}}>— {m.reason}</span>}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Alternatives */}
                            {qa.alternatives?.length>0&&(
                              <div style={{background:"var(--indigo-light)",border:"1px solid var(--border)",borderRadius:10,padding:"12px 16px",marginBottom:16}}>
                                <div style={{fontSize:12,fontWeight:600,color:"var(--indigo)",marginBottom:8}}>💡 Alternative options offered</div>
                                {qa.alternatives.map((a,i)=>(
                                  <div key={i} style={{marginBottom:8,padding:"8px 12px",background:"var(--bg-card-solid)",borderRadius:8,border:"1px solid #E0F2FE"}}>
                                    <div style={{fontSize:12,color:"var(--text-secondary)"}}>Instead of: <span style={{fontWeight:500,color:"#0F172A"}}>{a.requestedItem}</span></div>
                                    <div style={{fontSize:13,fontWeight:500,color:"var(--indigo)",marginTop:2}}>{a.alternativeOffered} {a.altPrice&&<span style={{color:"#059669",fontFamily:"monospace"}}>— {a.altPrice}</span>}</div>
                                    {a.reason&&<div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{a.reason}</div>}
                                    {a.recommended&&<span style={{fontSize:10,background:"#0369A1",color:"white",padding:"1px 7px",borderRadius:10,marginTop:4,display:"inline-block"}}>AI recommends</span>}
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Warnings */}
                            {qa.warnings?.length>0&&(
                              <div style={{background:"var(--amber-light)",border:"1px solid #FDE68A",borderRadius:10,padding:"12px 16px",marginBottom:16}}>
                                <div style={{fontSize:12,fontWeight:600,color:"var(--amber)",marginBottom:6}}>⚠ Warnings</div>
                                {qa.warnings.map((w,i)=><div key={i} style={{fontSize:13,color:"#78350F",marginTop:3}}>• {w}</div>)}
                              </div>
                            )}

                            {/* VAT note */}
                            {qa.vatNote&&<div style={{fontSize:12,color:"var(--text-tertiary)",marginBottom:16,fontStyle:"italic"}}>VAT: {qa.vatNote}</div>}

                            {/* Action buttons — smart conditional */}
                            <div style={{paddingTop:16,borderTop:"1px solid var(--border)"}}>
                              {approvedQuoteId===qa._id ? (
                                /* ── This quote IS the approved one ── */
                                <div>
                                  <div style={{display:"flex",alignItems:"center",gap:12,padding:"14px 18px",background:"linear-gradient(135deg,#F0FDF4,#DCFCE7)",borderRadius:12,border:"1px solid #A7F3D0",marginBottom:12}}>
                                    <div style={{width:36,height:36,background:"linear-gradient(135deg,#22C55E,#16A34A)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,boxShadow:"0 4px 12px rgba(34,197,94,0.3)",flexShrink:0}}>✓</div>
                                    <div style={{flex:1}}>
                                      <div style={{fontSize:14,fontWeight:700,color:"var(--green-deep)"}}>Quote approved — PO generated</div>
                                      <div style={{fontSize:12,color:"#16A34A",marginTop:2}}>This quote has been approved and sent to Orders. The PO has been downloaded.</div>
                                    </div>
                                    <button onClick={handleUndoApproval} style={{fontSize:12,color:"var(--red)",background:"var(--red-light)",border:"1px solid #FECACA",borderRadius:8,padding:"7px 14px",cursor:"pointer",fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>
                                      ↩ Undo approval
                                    </button>
                                  </div>
                                  <button onClick={()=>setView("orders")} style={{fontSize:13,color:"var(--indigo)",background:"var(--indigo-light)",border:"none",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontWeight:600}}>
                                    View in Orders →
                                  </button>
                                </div>
                              ) : approvedQuoteId && approvedQuoteId!==qa._id ? (
                                /* ── Another quote has been approved — show reduced options ── */
                                <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                                  <div style={{fontSize:12,color:"var(--text-tertiary)",flex:1}}>Another quote has been approved for this job.</div>
                                  <Btn onClick={()=>handleSaveDraftQuote(qa)} color="#7C3AED">Save as draft</Btn>
                                  <Btn outline onClick={()=>setAllAnalyses(p=>p.filter(x=>x._id!==qa._id))}>Remove</Btn>
                                </div>
                              ) : (
                                /* ── No quote approved yet — show all options ── */
                                <div>
                                  <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap"}}>
                                    <Btn onClick={()=>handleApprovePO(qa)} color="#16A34A">✓ Approve &amp; generate PO</Btn>
                                    <Btn onClick={()=>handleSaveDraftQuote(qa)} color="#7C3AED">Save as draft PDF</Btn>
                                    <Btn outline onClick={()=>setAllAnalyses(p=>p.filter(x=>x._id!==qa._id))}>Remove</Btn>
                                  </div>
                                  <div style={{fontSize:11,color:"var(--text-tertiary)"}}>
                                    Approving generates the PO, sends it to Orders for dispatch, and locks this quote. Other quotes will show reduced options.
                                  </div>
                                </div>
                              )}
                            </div>
                          </Card>
                          );
                        })}
                      </div>
                    )}
                    {/* ── Document store ── */}
                    <Card style={{marginTop:8}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                        <div>
                          <div style={{fontSize:14,fontWeight:600,color:"#0F172A"}}>📎 Documents</div>
                          <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>Generated POs, draft quotes, and uploaded third-party documents</div>
                        </div>
                        <label style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--indigo-light)",color:"#2563EB",fontSize:12,fontWeight:500,padding:"7px 14px",borderRadius:8,cursor:"pointer",border:"1px solid #BFDBFE"}}>
                          ↑ Upload document
                          <input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.png,.jpg" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) handleUploadDocument(e.target.files[0]); e.target.value=""; }}/>
                        </label>
                      </div>

                      {(!activeReq.documents||activeReq.documents.length===0)?(
                        <div style={{textAlign:"center",padding:"30px 0",color:"var(--text-tertiary)",fontSize:13}}>
                          <div style={{fontSize:28,marginBottom:8}}>📄</div>
                          No documents yet — approve a quote to generate a PO, save a draft, or upload a third-party document
                        </div>
                      ):(
                        <div>
                          {activeReq.documents.map((doc,i)=>{
                            const typeConfig = {
                              generated:{ bg:"#D1FAE5", text:"#065F46", icon:"✓", label:"Approved PO" },
                              draft:    { bg:"#EDE9FE", text:"#5B21B6", icon:"◎", label:"Draft PDF" },
                              uploaded: { bg:"#DBEAFE", text:"#1E40AF", icon:"↑", label:"Uploaded" },
                            }[doc.type]||{ bg:"#F1F5F9", text:"#475569", icon:"📄", label:"Document" };
                            return(
                              <div key={doc.id} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 0",borderBottom:"1px solid var(--border)"}}>
                                <div style={{width:38,height:38,background:typeConfig.bg,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:typeConfig.text,flexShrink:0}}>{typeConfig.icon}</div>
                                <div style={{flex:1,minWidth:0}}>
                                  <div style={{fontSize:13,fontWeight:500,color:"#0F172A",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.label}</div>
                                  <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>{doc.supplier&&`${doc.supplier} · `}{doc.date}{doc.fileSize&&` · ${doc.fileSize}`}</div>
                                </div>
                                <span style={{background:typeConfig.bg,color:typeConfig.text,fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:12,flexShrink:0}}>{typeConfig.label}</span>
                                {doc.dataUrl&&(
                                  <a href={doc.dataUrl} download={doc.label} style={{fontSize:12,color:"#3B82F6",textDecoration:"none",fontWeight:500,flexShrink:0,padding:"5px 10px",border:"1px solid #BFDBFE",borderRadius:6}}>Download</a>
                                )}
                                <button onClick={()=>{
                                  setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,documents:r.documents.filter((_,di)=>di!==i)}:r));
                                  setActiveReq(prev=>({...prev,documents:prev.documents.filter((_,di)=>di!==i)}));
                                }} style={{fontSize:11,color:"var(--red)",background:"none",border:"none",cursor:"pointer",flexShrink:0}}>Remove</button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Card>
                  </>
                ):(
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:200,color:"#9CA3AF",fontSize:14}}>Select a request from the left</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══ ORDERS ══ */}
        {view==="orders"&&(
          <div style={{animation:"fadeIn 0.25s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:32}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:"#22C55E",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>ORDER MANAGEMENT</div>
                <h1 style={{fontSize:32,fontWeight:800,letterSpacing:"-1.2px",margin:0,color:"var(--text-primary)"}}>Orders</h1>
                <p style={{fontSize:15,color:"var(--text-secondary)",marginTop:6}}>Send approved purchase orders to suppliers and track their status</p>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {[
                    {label:"Ready",     color:"var(--green-deep)", bg:"#DCFCE7", count:orders.filter(o=>o.status==="pending-send").length},
                    {label:"Sent",      color:"#4338CA", bg:"#EEF2FF", count:orders.filter(o=>o.status==="sent").length},
                    {label:"Confirmed", color:"#059669", bg:"#D1FAE5", count:orders.filter(o=>o.status==="confirmed").length},
                    {label:"Delivered", color:"var(--text-secondary)", bg:"#F1F5F9", count:orders.filter(o=>o.status==="delivered").length},
                  ].map(s=>(
                    <div key={s.label} style={{background:s.bg,borderRadius:8,padding:"6px 14px",fontSize:12,color:s.color,fontWeight:600}}>
                      {s.count} {s.label}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {orders.length===0?(
              <div style={{background:"var(--bg-card-solid)",borderRadius:24,border:"1px solid var(--border)",padding:"80px 40px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
                <div style={{width:80,height:80,background:"linear-gradient(135deg,#F0FDF4,#DCFCE7)",borderRadius:24,display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,margin:"0 auto 20px"}}>📦</div>
                <div style={{fontSize:20,fontWeight:700,color:"var(--text-primary)",marginBottom:8,letterSpacing:"-0.5px"}}>No orders yet</div>
                <div style={{fontSize:14,color:"var(--text-tertiary)",maxWidth:380,margin:"0 auto 28px",lineHeight:1.7}}>
                  Orders appear here when you approve a PO in Quote Analysis, or when you promote an uploaded document to an order. Once here, send them directly to your supplier with one click.
                </div>
                <button onClick={()=>setView("quotes")} style={{display:"inline-flex",alignItems:"center",gap:8,background:"linear-gradient(135deg,#6366F1,#4F46E5)",color:"white",border:"none",borderRadius:12,padding:"13px 28px",fontSize:14,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 20px rgba(99,102,241,0.3)"}}>
                  Go to Quote Analysis →
                </button>
              </div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:16}}>
                {orders.filter(o=>{
                  if(orderFilter==="active") return o.status!=="delivered";
                  if(orderFilter==="delivered") return o.status==="delivered";
                  return true;
                }).map(order=>{
                  const STATUS_STEPS = [
                    {key:"pending-send", label:"Ready to send", icon:"📦", color:"#22C55E", bg:"#F0FDF4"},
                    {key:"sent",         label:"Sent",          icon:"✈️", color:"var(--indigo)", bg:"#EEF2FF"},
                    {key:"confirmed",    label:"Confirmed",     icon:"✅", color:"#059669", bg:"#DCFCE7"},
                    {key:"delivered",    label:"Delivered",     icon:"🏁", color:"var(--text-primary)", bg:"#F1F5F9"},
                  ];
                  const stepIdx = STATUS_STEPS.findIndex(s=>s.key===order.status);
                  const currentStep = STATUS_STEPS[stepIdx]||STATUS_STEPS[0];
                  const isPending = order.status==="pending-send";
                  const isSent    = order.status==="sent";
                  const isConfirmed = order.status==="confirmed";
                  const isDelivered = order.status==="delivered";

                  return(
                  <div key={order.id} style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",border:`1px solid ${isConfirmed?"var(--green-dark)":isPending?"var(--green)":isSent?"var(--indigo)":"var(--border)"}`,overflow:"hidden",boxShadow:"var(--shadow-sm)",opacity:isDelivered?0.8:1,transition:"opacity 0.2s"}}>

                    {/* ── Order header ── */}
                    <div style={{padding:"20px 28px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center",background:`linear-gradient(135deg,${currentStep.bg},#FAFFFE)`}}>
                      <div style={{display:"flex",alignItems:"center",gap:16}}>
                        <div style={{width:48,height:48,background:isPending?"linear-gradient(135deg,#22C55E,#16A34A)":isSent?"linear-gradient(135deg,#6366F1,#4F46E5)":isConfirmed?"linear-gradient(135deg,#059669,#047857)":"linear-gradient(135deg,#374151,#1F2937)",borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:`0 4px 12px ${currentStep.color}30`}}>
                          {currentStep.icon}
                        </div>
                        <div>
                          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
                            <span style={{fontSize:16,fontWeight:700,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{order.poNumber}</span>
                            <span style={{fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:20,background:currentStep.bg,color:currentStep.color,border:`1px solid ${currentStep.color}30`}}>
                              {currentStep.label}
                            </span>
                          </div>
                          <div style={{fontSize:13,color:"var(--text-secondary)"}}>{order.jobRef} · {order.site} · {order.trade}</div>
                        </div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{order.supplier}</div>
                        <div style={{fontSize:12,color:"var(--text-tertiary)",marginTop:2}}>{order.supplierEmail||"No email set"}</div>
                        <div style={{fontSize:11,color:"var(--text-muted)",marginTop:2}}>{order.poDate}</div>
                      </div>
                    </div>

                    {/* ── Status timeline ── */}
                    <div style={{padding:"16px 28px",borderBottom:"1px solid var(--border)",background:"#FAFFFE"}}>
                      <div style={{display:"flex",alignItems:"center",gap:0}}>
                        {STATUS_STEPS.map((step,si)=>{
                          const done = si<=stepIdx;
                          const active = si===stepIdx;
                          return(
                            <div key={step.key} style={{display:"flex",alignItems:"center",flex:si<STATUS_STEPS.length-1?1:"none"}}>
                              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                                <div style={{width:32,height:32,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,background:done?step.color:"#F1F5F9",boxShadow:active?`0 0 0 4px ${step.color}20`:"none",transition:"all 0.3s",flexShrink:0}}>
                                  {done?<span style={{fontSize:12}}>{si<stepIdx?"✓":step.icon}</span>:<span style={{fontSize:12,color:"var(--text-muted)"}}>○</span>}
                                </div>
                                <span style={{fontSize:9,fontWeight:active?700:400,color:active?step.color:"var(--text-tertiary)",whiteSpace:"nowrap"}}>{step.label}</span>
                              </div>
                              {si<STATUS_STEPS.length-1&&(
                                <div style={{flex:1,height:2,background:si<stepIdx?"#22C55E":"#F1F5F9",margin:"0 4px",marginBottom:14,transition:"background 0.3s"}}/>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* ── Order body ── */}
                    <div style={{padding:"20px 28px"}}>
                      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:isMobile?14:20}}>

                        {/* Left — details + activity */}
                        <div>
                          <div style={{marginBottom:16}}>
                            <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Items ordered ({order.items?.length||0})</div>
                            <div style={{background:"var(--bg-subtle)",borderRadius:10,padding:"12px 14px",maxHeight:120,overflowY:"auto"}}>
                              {(order.items||[]).map((item,i)=>(
                                <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:i<order.items.length-1?"1px solid #F1F5F9":"none"}}>
                                  <span style={{fontSize:13,color:"var(--text-secondary)"}}>{item.description}</span>
                                  <span style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{item.quantity} {item.unit}</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          {(order.deliveryMethod||order.deliveryDate)&&(
                            <div style={{marginBottom:16}}>
                              <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Delivery</div>
                              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                                {order.deliveryMethod&&<span style={{background:"var(--indigo-light)",border:"1px solid var(--border)",color:"var(--indigo)",fontSize:12,fontWeight:500,padding:"4px 12px",borderRadius:20}}>🚚 {{"direct":"To site","alternative":"Alt. address","collect":"Collect","tbc":"TBC"}[order.deliveryMethod]||order.deliveryMethod}</span>}
                                {order.deliveryDate&&<span style={{background:"var(--green-mint)",border:"1px solid #A7F3D0",color:"var(--green-deep)",fontSize:12,fontWeight:500,padding:"4px 12px",borderRadius:20}}>📅 {new Date(order.deliveryDate).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</span>}
                                {order.expectedDelivery&&<span style={{background:"var(--amber-light)",border:"1px solid #FDE68A",color:"var(--amber)",fontSize:12,fontWeight:500,padding:"4px 12px",borderRadius:20}}>🗓 Expected {new Date(order.expectedDelivery).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</span>}
                              </div>
                            </div>
                          )}

                          {/* Confirmation document */}
                          {order.confirmationDoc&&(
                            <div style={{marginBottom:16,background:"var(--green-mint)",border:"1px solid #A7F3D0",borderRadius:10,padding:"12px 14px"}}>
                              <div style={{fontSize:12,fontWeight:600,color:"var(--green-deep)",marginBottom:6}}>✅ Supplier confirmation attached</div>
                              <div style={{display:"flex",alignItems:"center",gap:10}}>
                                <div style={{width:32,height:32,background:"#D1FAE5",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>📎</div>
                                <div style={{flex:1}}>
                                  <div style={{fontSize:12,fontWeight:500,color:"var(--text-primary)"}}>{order.confirmationDoc.label}</div>
                                  <div style={{fontSize:11,color:"var(--text-secondary)"}}>{order.confirmationDoc.date} · {order.confirmationDoc.fileSize}</div>
                                </div>
                                <a href={order.confirmationDoc.dataUrl} download={order.confirmationDoc.label} style={{fontSize:11,color:"#059669",fontWeight:600,textDecoration:"none",background:"#D1FAE5",padding:"4px 10px",borderRadius:6}}>Download</a>
                              </div>
                            </div>
                          )}

                          {order.activity?.length>0&&(
                            <div>
                              <div style={{fontSize:12,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Activity</div>
                              {[...(order.activity||[])].reverse().map((a,i)=>(
                                <div key={i} style={{display:"flex",gap:10,padding:"6px 0",borderBottom:"1px solid var(--border)"}}>
                                  <div style={{width:6,height:6,borderRadius:"50%",background:"#22C55E",marginTop:5,flexShrink:0}}/>
                                  <div style={{flex:1}}>
                                    <div style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)"}}>{a.action}</div>
                                    <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:1}}>{new Date(a.ts).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})} · {a.user}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Right — action panel */}
                        <div style={{background:"var(--bg-subtle)",borderRadius:14,padding:"20px"}}>

                          {/* PENDING — send panel */}
                          {isPending&&(
                            <>
                              <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Send this order to supplier</div>
                              <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:12,lineHeight:1.6}}>An email will be sent with the full PO details. The supplier will be asked to confirm receipt.</div>
                              <div style={{marginBottom:10}}>
                                <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.08em"}}>Supplier email</label>
                                <input value={order.supplierEmail||""} onChange={e=>setOrders(p=>p.map(o=>o.id===order.id?{...o,supplierEmail:e.target.value}:o))} placeholder="supplier@company.co.uk" style={{width:"100%",padding:"8px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,outline:"none",background:"var(--bg-card-solid)"}}/>
                              </div>
                              <div style={{marginBottom:14}}>
                                <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.08em"}}>Notes (optional)</label>
                                <textarea value={orderNote[order.id]||""} onChange={e=>setOrderNote(p=>({...p,[order.id]:e.target.value}))} placeholder="Site access, contact details, special instructions…" style={{width:"100%",height:70,padding:"8px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,outline:"none",resize:"none",fontFamily:"inherit",background:"var(--bg-card-solid)"}}/>
                              </div>
                              <button onClick={()=>handleSendOrder(order)} disabled={sendingOrder===order.id||!order.supplierEmail} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:sendingOrder===order.id||!order.supplierEmail?"#D1FAE5":"linear-gradient(135deg,#22C55E,#16A34A)",color:"white",border:"none",borderRadius:10,padding:"12px",fontSize:14,fontWeight:700,cursor:sendingOrder===order.id||!order.supplierEmail?"not-allowed":"pointer",boxShadow:"0 4px 16px rgba(34,197,94,0.3)",marginBottom:8}}>
                                {sendingOrder===order.id?<><Spinner/>Sending…</>:<><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send order to {order.supplier}</>}
                              </button>
                            </>
                          )}

                          {/* SENT — awaiting confirmation */}
                          {isSent&&(
                            <>
                              <div style={{background:"var(--indigo-light)",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                                <div style={{fontSize:13,fontWeight:600,color:"#4338CA",marginBottom:2}}>✈️ Order sent</div>
                                <div style={{fontSize:11,color:"var(--indigo)"}}>Sent to {order.supplierEmail} · {order.sentAt?new Date(order.sentAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"—"}</div>
                              </div>

                              <div style={{marginBottom:14}}>
                                <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Attach supplier confirmation</div>
                                <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:10,lineHeight:1.6}}>When the supplier emails back with an order confirmation PDF, upload it here. The order will automatically move to Confirmed.</div>
                                <label style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"var(--bg-card-solid)",border:"2px dashed #BBF7D0",borderRadius:10,padding:"16px",cursor:"pointer",fontSize:13,fontWeight:600,color:"#16A34A"}}>
                                  📎 Upload confirmation document
                                  <input type="file" accept=".pdf,.doc,.docx,.jpg,.png" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleOrderConfirmationUpload(e.target.files[0],order.id);e.target.value="";}}/>
                                </label>
                                <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:6,textAlign:"center"}}>PDF, Word, or image — drag and drop or click to browse</div>
                              </div>

                              <div style={{marginBottom:10}}>
                                <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Expected delivery date</div>
                                <input type="date" value={expectedDelivery[order.id]||""} onChange={e=>{
                                  setExpectedDelivery(p=>({...p,[order.id]:e.target.value}));
                                  const expEntry={ts:new Date().toISOString(),action:"Expected delivery set",detail:`Expected: ${new Date(e.target.value).toLocaleDateString("en-GB")}`,user:settings.contactName||"You"};
                                  setOrders(p=>p.map(o=>o.id===order.id?{...o,expectedDelivery:e.target.value,activity:[...(o.activity||[]),expEntry]}:o));
                                }} style={{width:"100%",padding:"8px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,outline:"none"}}/>
                              </div>

                              <div style={{display:"flex",gap:8}}>
                                <button onClick={()=>{
                              const entry={ts:new Date().toISOString(),action:"Order resent",detail:`PO ${order.poNumber} resent to ${order.supplierEmail}`,user:settings.contactName||"You"};
                              setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"pending-send",activity:[...(o.activity||[]),entry]}:o));
                            }} style={{flex:1,fontSize:12,color:"var(--indigo)",background:"var(--indigo-light)",border:"none",borderRadius:8,padding:"8px",cursor:"pointer",fontWeight:600}}>Resend</button>
                                <button onClick={()=>{
                                  const entry={ts:new Date().toISOString(),action:"Manually confirmed",detail:`Order ${order.poNumber} confirmed without document upload`,user:settings.contactName||"You"};
                                  setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"confirmed",activity:[...(o.activity||[]),entry]}:o));
                                  showToast("Order marked as confirmed");
                                }} style={{flex:1,fontSize:12,color:"#059669",background:"var(--green-light)",border:"none",borderRadius:8,padding:"8px",cursor:"pointer",fontWeight:600}}>Mark confirmed</button>
                              </div>
                            </>
                          )}

                          {/* CONFIRMED — awaiting delivery */}
                          {isConfirmed&&(
                            <>
                              <div style={{background:"var(--green-mint)",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                                <div style={{fontSize:13,fontWeight:600,color:"var(--green-deep)",marginBottom:2}}>✅ Order confirmed by supplier</div>
                                {order.expectedDelivery&&<div style={{fontSize:11,color:"#16A34A"}}>Expected delivery: {new Date(order.expectedDelivery).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}</div>}
                              </div>

                              {!order.confirmationDoc&&(
                                <div style={{marginBottom:14}}>
                                  <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Attach confirmation document</div>
                                  <label style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"var(--bg-card-solid)",border:"2px dashed #BBF7D0",borderRadius:10,padding:"14px",cursor:"pointer",fontSize:12,fontWeight:600,color:"#16A34A"}}>
                                    📎 Upload supplier confirmation
                                    <input type="file" accept=".pdf,.doc,.docx,.jpg,.png" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleOrderConfirmationUpload(e.target.files[0],order.id);e.target.value="";}}/>
                                  </label>
                                </div>
                              )}

                              <div style={{marginBottom:10}}>
                                <div style={{fontSize:12,fontWeight:600,color:"var(--text-primary)",marginBottom:6}}>Expected delivery date</div>
                                <input type="date" value={expectedDelivery[order.id]||order.expectedDelivery||""} onChange={e=>{
                                  setExpectedDelivery(p=>({...p,[order.id]:e.target.value}));
                                  setOrders(p=>p.map(o=>o.id===order.id?{...o,expectedDelivery:e.target.value}:o));
                                }} style={{width:"100%",padding:"8px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,outline:"none"}}/>
                              </div>

                              <button onClick={()=>{
                                const entry={ts:new Date().toISOString(),action:"Materials delivered",detail:"Order marked as delivered",user:settings.contactName||"You"};
                                setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"delivered",deliveredAt:new Date().toISOString(),activity:[...(o.activity||[]),entry]}:o));
                                showToast("Order marked as delivered — job complete");
                              }} style={{width:"100%",background:"linear-gradient(135deg,#374151,#1F2937)",color:"white",border:"none",borderRadius:10,padding:"12px",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:8}}>
                                🏁 Mark as delivered
                              </button>
                            </>
                          )}

                          {/* DELIVERED — complete */}
                          {isDelivered&&(
                            <div style={{background:"linear-gradient(135deg,#F0FDF4,#DCFCE7)",borderRadius:12,padding:"16px",textAlign:"center"}}>
                              <div style={{fontSize:24,marginBottom:8}}>🏁</div>
                              <div style={{fontSize:14,fontWeight:700,color:"var(--green-deep)",marginBottom:4}}>Order complete</div>
                              <div style={{fontSize:12,color:"#16A34A"}}>Delivered {order.deliveredAt?new Date(order.deliveredAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"—"}</div>
                            </div>
                          )}

                          {/* Remove always available */}
                          <div style={{marginTop:10,textAlign:"right"}}>
                            <button onClick={()=>setOrders(p=>p.filter(o=>o.id!==order.id))} style={{fontSize:11,color:"var(--red)",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>Remove order</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}

            {/* Promote uploaded docs to orders */}
            {requests.some(r=>(r.documents||[]).some(d=>d.type==="uploaded"&&!orders.find(o=>o.id===d.id)))&&(
              <div style={{marginTop:24,background:"var(--bg-card-solid)",borderRadius:20,border:"1px solid var(--border)",padding:"20px 28px",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
                <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:4}}>Uploaded documents ready to send</div>
                <div style={{fontSize:13,color:"var(--text-secondary)",marginBottom:16}}>These documents were uploaded to jobs but haven't been sent as orders yet</div>
                {requests.flatMap(r=>(r.documents||[]).filter(d=>d.type==="uploaded"&&!orders.find(o=>o.id===d.id)).map(d=>({...d,_req:r}))).map((d,i)=>(
                  <div key={d.id} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 0",borderTop:i>0?"1px solid #F8FAFC":"none"}}>
                    <div style={{width:40,height:40,background:"var(--indigo-light)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>📎</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:500,color:"var(--text-primary)"}}>{d.label}</div>
                      <div style={{fontSize:12,color:"var(--text-secondary)"}}>{d._req.jobRef} · {d._req.site} · {d.date}</div>
                    </div>
                    <button onClick={()=>handleCreateOrderFromDoc(d,d._req)} style={{background:"linear-gradient(135deg,#6366F1,#4F46E5)",color:"white",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                      Add to Orders →
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══ SUPPLIERS ══ */}
        {view==="suppliers"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:28,fontWeight:700,letterSpacing:"-0.8px",margin:0,color:"var(--text-primary)"}}>Suppliers</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Your supplier accounts — add your real ones here</p>
            </div>
            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))",gap:isMobile?10:16,marginBottom:isMobile?16:24}}>
              {suppliers.map(s=>(
                <Card key={s.id}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div style={{width:44,height:44,background:"linear-gradient(135deg,#EEF2FF,#E0E7FF)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,color:"#4F46E5",boxShadow:"0 2px 8px rgba(99,102,241,0.15)"}}>{s.name.charAt(0)}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      <Badge bg="#F0FDF4" text="#166534">Active</Badge>
                      <button onClick={()=>saveSuppliers(suppliers.filter(x=>x.id!==s.id))} style={{fontSize:11,color:"var(--red)",background:"none",border:"none",cursor:"pointer"}}>Remove</button>
                    </div>
                  </div>
                  <div style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",marginBottom:3}}>{s.name}</div>
                  <div style={{fontSize:12,color:"var(--text-secondary)",marginBottom:10}}>{s.email}</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:10}}>
                    {s.categories.map(cat=><Badge key={cat} bg="var(--green-light)" text="var(--green-deep)">{cat}</Badge>)}
                  </div>
                  {(()=>{
                    const rfqsSent = requests.filter(r=>r.sentTo?.some(st=>st.id===s.id)).length;
                    const responded = requests.filter(r=>r.sentTo?.some(st=>st.id===s.id&&st.saved)).length;
                    const libEntries = quoteLibrary.filter(q=>q.supplierName===s.name);
                    const avgScore = libEntries.length?Math.round(libEntries.reduce((a,q)=>a+q.completeness,0)/libEntries.length):null;
                    if(!rfqsSent&&!libEntries.length) return <div style={{fontSize:11,color:"var(--text-muted)"}}>No activity yet</div>;
                    return(
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {rfqsSent>0&&<span style={{fontSize:10,color:"var(--text-tertiary)",background:"var(--bg-subtle2)",padding:"2px 8px",borderRadius:99}}>{rfqsSent} RFQ{rfqsSent!==1?"s":""} sent</span>}
                        {responded>0&&rfqsSent>0&&<span style={{fontSize:10,color:"var(--green-dark)",background:"var(--green-light)",padding:"2px 8px",borderRadius:99}}>{Math.round(responded/rfqsSent*100)}% response rate</span>}
                        {avgScore!==null&&<span style={{fontSize:10,color:avgScore>=80?"var(--green-dark)":avgScore>=60?"var(--amber)":"var(--red)",background:avgScore>=80?"var(--green-light)":avgScore>=60?"var(--amber-light)":"var(--red-light)",padding:"2px 8px",borderRadius:99}}>Avg {avgScore}% completeness</span>}
                        {libEntries.length>0&&<span style={{fontSize:10,color:"var(--text-tertiary)",background:"var(--bg-subtle2)",padding:"2px 8px",borderRadius:99}}>{libEntries.length} quote{libEntries.length!==1?"s":""} in library</span>}
                      </div>
                    );
                  })()}
                </Card>
              ))}
            </div>
            <Card>
              <div style={{fontSize:14,fontWeight:500,marginBottom:16}}>Add a supplier</div>
              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr 1fr auto",gap:12,alignItems:"end"}}>
                {[{label:"Company name",val:"name",ph:"e.g. BSS Industrial"},{label:"Quote email",val:"email",ph:"quotes@supplier.co.uk"},{label:"Categories",val:"categories",ph:"Plumbing, HVAC"}].map(f=>(
                  <div key={f.val}>
                    <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>{f.label}</label>
                    <input value={newSup[f.val]} onChange={e=>setNewSup(p=>({...p,[f.val]:e.target.value}))} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
                  </div>
                ))}
                <Btn onClick={()=>{
                  if(!newSup.name||!newSup.email)return;
                  const cats=newSup.categories.split(",").map(c=>c.trim()).filter(Boolean).map(c=>c.charAt(0).toUpperCase()+c.slice(1));
                  saveSuppliers([...suppliers,{id:Date.now(),name:newSup.name,email:newSup.email,categories:cats.length?cats:["Plumbing"]}]);
                  setNewSup({name:"",email:"",categories:""});
                  showToast("Supplier added");
                }}>Add</Btn>
              </div>
            </Card>
          </div>
        )}

        {/* ══ ALL REQUESTS ══ */}
        {view==="requests"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:28,fontWeight:700,letterSpacing:"-0.8px",margin:0,color:"var(--text-primary)"}}>All requests</h1>
            </div>
            <Card style={{padding:0,overflow:"hidden"}}>
              <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}><table style={{width:"100%",borderCollapse:"collapse",minWidth:isMobile?600:"auto"}}>
                <thead><tr style={{background:"var(--bg-subtle)"}}>
                  {["Request","Job ref","Site","Trade","Items","Status","Created","Action"].map(h=>(
                    <th key={h} style={{padding:"12px 16px",textAlign:"left",fontSize:12,fontWeight:500,color:"#6B7280"}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>{requests.map(r=>{const sc=STATUS[r.status];return(
                  <tr key={r.id} style={{borderTop:"1px solid #F3F4F6"}}>
                    <td style={{padding:"13px 16px",fontSize:13,fontWeight:500,fontFamily:"'JetBrains Mono',monospace",color:"#2563EB"}}>{r.id}</td>
                    <td style={{padding:"13px 16px",fontSize:13}}>{r.jobRef}</td>
                    <td style={{padding:"13px 16px",fontSize:13,color:"#6B7280"}}>{r.site}</td>
                    <td style={{padding:"13px 16px",fontSize:13}}>{r.trade}</td>
                    <td style={{padding:"13px 16px",fontSize:13}}>{r.items.length}</td>
                    <td style={{padding:"13px 16px"}}><Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge></td>
                    <td style={{padding:"13px 16px",fontSize:12,color:"#9CA3AF"}}>{r.created}</td>
                    <td style={{padding:"13px 16px"}}>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <button onClick={()=>{setActiveReq(r);setView("quotes");}} style={{fontSize:12,color:"#2563EB",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>View →</button>
                        <button onClick={()=>handleDuplicate(r)} style={{fontSize:12,color:"#16A34A",background:"none",border:"none",cursor:"pointer"}}>Duplicate</button>
                        <button onClick={()=>{setEditModal(r);setEditForm({jobRef:r.jobRef,site:r.site,status:r.status,notes:r.notes||""});}} style={{fontSize:12,color:"#6B7280",background:"none",border:"none",cursor:"pointer"}}>Edit</button>
                        <button onClick={()=>setActivityModal(r)} style={{fontSize:12,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer",fontWeight:r.activity?.length?"500":"400"}}>Log{r.activity?.length?` (${r.activity.length})`:""}</button>
                        <button onClick={()=>setDeleteConfirm(r.id)} style={{fontSize:12,color:"var(--red)",background:"none",border:"none",cursor:"pointer"}}>Delete</button>
                      </div>
                    </td>
                  </tr>
                )})}</tbody>
              </table>
            </div>
            </Card>
          </div>
        )}

        {/* ══ QUOTE LIBRARY ══ */}
        {view==="library"&&(
          <div style={{animation:"fadeIn 0.25s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:32}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:"#22C55E",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>PRICE HISTORY</div>
                <h1 style={{fontSize:32,fontWeight:800,letterSpacing:"-1.2px",margin:0,color:"var(--text-primary)"}}>Quote Library</h1>
                <p style={{fontSize:15,color:"var(--text-secondary)",marginTop:6}}>Every supplier quote ever received — track price changes over time</p>
              </div>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <div style={{background:"var(--green-mint)",border:"1px solid #BBF7D0",borderRadius:10,padding:"8px 16px",fontSize:13,color:"var(--green-deep)",fontWeight:500}}>
                  {quoteLibrary.length} quotes saved
                </div>
                {quoteLibrary.length>0&&(
                  <button onClick={()=>{ if(window.confirm("Clear entire quote library? This cannot be undone.")) { setQuoteLibrary([]); localStorage.removeItem("piq_quote_library"); showToast("Library cleared"); }}} style={{fontSize:12,color:"var(--red)",background:"var(--red-light)",border:"1px solid #FECACA",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontWeight:500}}>
                    Clear all
                  </button>
                )}
              </div>
            </div>

            {quoteLibrary.length===0?(
              <div style={{background:"var(--bg-card-solid)",borderRadius:24,border:"1px solid var(--border)",padding:"80px 40px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
                <div style={{width:80,height:80,background:"linear-gradient(135deg,#EEF2FF,#E0E7FF)",borderRadius:24,display:"flex",alignItems:"center",justifyContent:"center",fontSize:36,margin:"0 auto 20px"}}>📚</div>
                <div style={{fontSize:20,fontWeight:700,color:"var(--text-primary)",marginBottom:8}}>No quotes saved yet</div>
                <div style={{fontSize:14,color:"var(--text-tertiary)",maxWidth:380,margin:"0 auto",lineHeight:1.7}}>
                  Every time you run AI analysis on a supplier quote, it gets saved here automatically. You can then track pricing trends and compare against previous quotes.
                </div>
              </div>
            ):(
              <div>
                {/* Supplier scorecards */}
                {(()=>{
                  const bySupplier = {};
                  quoteLibrary.forEach(q=>{
                    if (!bySupplier[q.supplierName]) bySupplier[q.supplierName]={name:q.supplierName,quotes:[],avgCompleteness:0,priceHistory:[]};
                    bySupplier[q.supplierName].quotes.push(q);
                  });
                  Object.values(bySupplier).forEach(s=>{
                    s.avgCompleteness = Math.round(s.quotes.reduce((a,q)=>a+q.completeness,0)/s.quotes.length);
                    s.quoteCount = s.quotes.length;
                    s.lastQuoted = s.quotes[0]?.savedAt;
                  });
                  const scorecards = Object.values(bySupplier).sort((a,b)=>b.quoteCount-a.quoteCount);
                  return(
                    <div>
                      <div style={{fontSize:13,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>Supplier scorecards</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:12,marginBottom:28}}>
                        {scorecards.map(s=>(
                          <div key={s.name} style={{background:"var(--bg-card-solid)",borderRadius:16,border:"1px solid var(--border)",padding:"18px 20px",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                              <div style={{width:40,height:40,background:"linear-gradient(135deg,#DCFCE7,#BBF7D0)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:"#16A34A"}}>{s.name.charAt(0)}</div>
                              <span style={{fontSize:11,fontWeight:600,background:"var(--green-mint)",color:"var(--green-deep)",padding:"3px 8px",borderRadius:20}}>{s.quoteCount} quote{s.quoteCount!==1?"s":""}</span>
                            </div>
                            <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)",marginBottom:8}}>{s.name}</div>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <div style={{fontSize:12,color:"var(--text-secondary)"}}>Avg. completeness</div>
                              <div style={{fontSize:18,fontWeight:700,color:s.avgCompleteness>=80?"#22C55E":s.avgCompleteness>=60?"#F59E0B":"#DC2626",fontFamily:"'JetBrains Mono',monospace"}}>{s.avgCompleteness}%</div>
                            </div>
                            <div style={{marginTop:6,height:4,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                              <div style={{height:"100%",width:`${s.avgCompleteness}%`,background:s.avgCompleteness>=80?"linear-gradient(90deg,#22C55E,#16A34A)":s.avgCompleteness>=60?"linear-gradient(90deg,#F59E0B,#D97706)":"linear-gradient(90deg,#EF4444,#DC2626)",borderRadius:99}}/>
                            </div>
                            {s.lastQuoted&&<div style={{fontSize:11,color:"var(--text-muted)",marginTop:8}}>Last quoted {new Date(s.lastQuoted).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Full quote history table */}
                <div style={{background:"var(--bg-card-solid)",borderRadius:20,border:"1px solid var(--border)",overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
                  <div style={{padding:"18px 24px",borderBottom:"1px solid var(--border)",background:"linear-gradient(135deg,#FAFFFE,#F0FDF4)"}}>
                    <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)"}}>Full quote history</div>
                    <div style={{fontSize:12,color:"var(--text-tertiary)",marginTop:2}}>All quotes saved from AI analysis — newest first</div>
                  </div>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr style={{background:"var(--bg-subtle)"}}>
                      {["Date","Supplier","Job ref","Trade","Completeness","Est. total","Carriage","Lead time","Items","Missing",""].map(h=>(
                        <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.06em",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>{quoteLibrary.map((q,i)=>(
                      <tr key={q.id} style={{borderTop:"1px solid var(--border)"}}>
                        <td style={{padding:"12px 14px",fontSize:12,color:"var(--text-secondary)",whiteSpace:"nowrap"}}>{new Date(q.savedAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</td>
                        <td style={{padding:"12px 14px",fontSize:13,fontWeight:600,color:"var(--text-primary)"}}>{q.supplierName}</td>
                        <td style={{padding:"12px 14px",fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:"var(--indigo)"}}>{q.jobRef}</td>
                        <td style={{padding:"12px 14px"}}><span style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",fontSize:11,fontWeight:500,padding:"3px 8px",borderRadius:20}}>{q.trade}</span></td>
                        <td style={{padding:"12px 14px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <div style={{width:48,height:5,background:"var(--bg-subtle2)",borderRadius:99,overflow:"hidden"}}>
                              <div style={{height:"100%",width:`${q.completeness}%`,background:q.completeness>=80?"#22C55E":q.completeness>=60?"#F59E0B":"#EF4444",borderRadius:99}}/>
                            </div>
                            <span style={{fontSize:12,fontWeight:600,color:q.completeness>=80?"#22C55E":q.completeness>=60?"#F59E0B":"#EF4444"}}>{q.completeness}%</span>
                          </div>
                        </td>
                        <td style={{padding:"12px 14px",fontSize:13,fontWeight:600,color:"var(--text-primary)",fontFamily:"'JetBrains Mono',monospace"}}>{q.totalEstimate||"—"}</td>
                        <td style={{padding:"12px 14px",fontSize:12,color:q.carriageCharge==="Free"?"#22C55E":q.carriageCharge==="Not stated"?"#94A3B8":"#DC2626",fontWeight:500}}>{q.carriageCharge||"—"}</td>
                        <td style={{padding:"12px 14px",fontSize:12,color:"var(--text-secondary)"}}>{q.leadTime||"—"}</td>
                        <td style={{padding:"12px 14px",fontSize:12,color:"var(--text-secondary)"}}>{q.items?.length||0}</td>
                        <td style={{padding:"12px 14px"}}>
                          {q.missing?.length>0?<span style={{background:"var(--red-light)",color:"var(--red)",fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:20}}>{q.missing.length} missing</span>:<span style={{background:"var(--green-mint)",color:"#16A34A",fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:20}}>Complete</span>}
                        </td>
                        <td style={{padding:"12px 14px"}}>
                          <button onClick={()=>setQuoteLibrary(p=>{ const n=p.filter(x=>x.id!==q.id); localStorage.setItem("piq_quote_library",JSON.stringify(n)); return n; })} style={{fontSize:11,color:"var(--red)",background:"none",border:"none",cursor:"pointer"}}>Remove</button>
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ HELP ══ */}
        {view==="help"&&(
          <div style={{animation:"fadeIn 0.25s ease",maxWidth:900}}>
            {/* Header */}
            <div style={{background:"linear-gradient(135deg,#0A0F1E,#1a2744)",borderRadius:20,padding:"36px 40px",marginBottom:28,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,background:"radial-gradient(circle,rgba(34,197,94,0.15),transparent 70%)",borderRadius:"50%"}}/>
              <div style={{position:"relative",zIndex:1,display:"flex",alignItems:"center",gap:20}}>
                <div style={{width:56,height:56,background:"linear-gradient(135deg,#22C55E,#16A34A)",borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 8px 24px rgba(34,197,94,0.3)"}}>
                  <svg width="28" height="28" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
                </div>
                <div>
                  <div style={{fontSize:11,color:"#4ADE80",letterSpacing:"0.15em",textTransform:"uppercase",fontWeight:600,marginBottom:4}}>ProQuote Help Centre</div>
                  <h1 style={{fontSize:28,fontWeight:800,color:"white",margin:0,letterSpacing:"-0.8px"}}>How can we help?</h1>
                  <p style={{fontSize:14,color:"rgba(148,163,184,0.9)",margin:"6px 0 0"}}>Ask the AI assistant, browse FAQs, or raise a support request</p>
                </div>
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:20,marginBottom:28}}>
              {/* AI Assistant */}
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",overflow:"hidden",boxShadow:"var(--shadow-sm)",display:"flex",flexDirection:"column"}}>
                <div style={{padding:"18px 20px",borderBottom:"1px solid var(--border)",background:darkMode?"rgba(34,197,94,0.05)":"linear-gradient(135deg,#F0FDF4,#FAFFFE)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:36,height:36,background:"linear-gradient(135deg,#22C55E,#16A34A)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🤖</div>
                    <div>
                      <div style={{fontSize:14,fontWeight:700,color:"var(--text-primary)"}}>AI Assistant</div>
                      <div style={{fontSize:11,color:"var(--text-secondary)"}}>Ask anything about ProQuote</div>
                    </div>
                    {settings.openRouterKey&&<span style={{marginLeft:"auto",fontSize:10,fontWeight:600,color:"var(--green-dark)",background:"var(--green-light)",padding:"2px 8px",borderRadius:99}}>Online</span>}
                  </div>
                </div>
                <div style={{flex:1,padding:"16px",overflowY:"auto",maxHeight:320,display:"flex",flexDirection:"column",gap:10}}>
                  {helpMessages.length===0&&(
                    <div style={{textAlign:"center",padding:"24px 0",color:"var(--text-tertiary)"}}>
                      <div style={{fontSize:28,marginBottom:8}}>💬</div>
                      <div style={{fontSize:13,fontWeight:500,color:"var(--text-secondary)",marginBottom:4}}>Start a conversation</div>
                      <div style={{fontSize:12,lineHeight:1.6}}>Try: "How do I send an RFQ?" or "Where are my saved quotes?"</div>
                    </div>
                  )}
                  {helpMessages.map((m,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                      <div style={{maxWidth:"85%",padding:"10px 14px",borderRadius:m.role==="user"?"14px 14px 4px 14px":"14px 14px 14px 4px",background:m.role==="user"?"linear-gradient(135deg,#22C55E,#16A34A)":"var(--bg-subtle)",color:m.role==="user"?"white":"var(--text-primary)",fontSize:13,lineHeight:1.6}}>
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {helpLoading&&<div style={{display:"flex",justifyContent:"flex-start"}}><div style={{background:"var(--bg-subtle)",borderRadius:"14px 14px 14px 4px",padding:"10px 14px",fontSize:13,color:"var(--text-secondary)",display:"flex",alignItems:"center",gap:8}}><Spinner/>Thinking…</div></div>}
                </div>
                <div style={{padding:"12px 16px",borderTop:"1px solid var(--border)",display:"flex",gap:8}}>
                  <input value={helpInput} onChange={e=>setHelpInput(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&handleHelpChat(helpInput)}
                    placeholder={settings.openRouterKey?"Ask me anything about ProQuote…":"Add your OpenRouter key in Settings to use the AI assistant"}
                    disabled={!settings.openRouterKey}
                    style={{flex:1,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-input)",color:"var(--text-primary)"}}
                  />
                  <button onClick={()=>handleHelpChat(helpInput)} disabled={!helpInput.trim()||helpLoading||!settings.openRouterKey}
                    style={{background:"linear-gradient(135deg,#22C55E,#16A34A)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 16px",fontSize:13,fontWeight:600,cursor:"pointer",opacity:(!helpInput.trim()||helpLoading||!settings.openRouterKey)?0.5:1}}>
                    Send
                  </button>
                </div>
                {helpMessages.length>0&&<div style={{padding:"8px 16px",borderTop:"1px solid var(--border)",textAlign:"right"}}><button onClick={()=>setHelpMessages([])} style={{fontSize:11,color:"var(--text-muted)",background:"none",border:"none",cursor:"pointer"}}>Clear conversation</button></div>}
              </div>

              {/* Quick links + keyboard shortcuts */}
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 20px",boxShadow:"var(--shadow-sm)"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:12}}>⚡ Quick actions</div>
                  {[
                    {label:"Create a new request",    action:()=>{setView("new");resetNewRequest();},  icon:"🎤"},
                    {label:"Analyse supplier quotes",  action:()=>setView("quotes"),                    icon:"🔍"},
                    {label:"View & send orders",       action:()=>setView("orders"),                    icon:"📦"},
                    {label:"Manage suppliers",         action:()=>setView("suppliers"),                 icon:"🏢"},
                    {label:"Configure settings",       action:()=>setView("settings"),                  icon:"⚙️"},
                  ].map(l=>(
                    <button key={l.label} onClick={l.action} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:"var(--radius-sm)",border:"none",background:"transparent",cursor:"pointer",textAlign:"left",marginBottom:2,transition:"background 0.15s"}}
                      onMouseEnter={e=>e.currentTarget.style.background="var(--bg-subtle)"}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <span style={{fontSize:16}}>{l.icon}</span>
                      <span style={{fontSize:13,color:"var(--text-primary)",fontWeight:500}}>{l.label}</span>
                      <svg style={{marginLeft:"auto"}} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  ))}
                </div>
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 20px",boxShadow:"var(--shadow-sm)"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:12}}>⌨️ Keyboard shortcuts</div>
                  {[["N","New request"],["Q","Quote analysis"],["O","Orders"],["D","Dashboard"],["S","Settings"],["H","Help"],["Esc","Close modals"]].map(([k,l])=>(
                    <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid var(--border)"}}>
                      <span style={{fontSize:12,color:"var(--text-secondary)"}}>{l}</span>
                      <kbd style={{background:"var(--bg-subtle2)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:5,padding:"2px 8px",fontSize:11,fontFamily:"monospace",fontWeight:600}}>{k}</kbd>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* FAQ */}
            <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px 28px",boxShadow:"var(--shadow-sm)",marginBottom:20}}>
              <div style={{fontSize:16,fontWeight:700,color:"var(--text-primary)",marginBottom:20}}>Frequently asked questions</div>
              {(()=>{
                const faqs = [
                  {cat:"Getting started",qs:[
                    {q:"What is ProQuote?",a:"ProQuote is an AI-powered procurement platform for trades contractors. It automates the full procurement workflow from creating a material request on site through to sending a purchase order to your supplier."},
                    {q:"What trades does ProQuote support?",a:"ProQuote supports Plumbing, HVAC, Electrical, Mechanical, Ventilation, and Gas — with General as a catch-all category for any other trade."},
                    {q:"Does ProQuote work on my phone?",a:"Yes. ProQuote is a web app that works on any device. On mobile you get a dedicated layout with a bottom tab bar. Voice input works natively on both iOS and Android."},
                    {q:"Do I need to install anything?",a:"No. ProQuote runs entirely in a browser — Chrome, Safari, Edge, Firefox. No app download, no installation."},
                    {q:"Where is my data stored?",a:"Currently all data is stored in your browser's local storage and persists across sessions. Cloud backup and multi-device sync are coming in the next major update."},
                  ]},
                  {cat:"Creating requests",qs:[
                    {q:"How does voice input work?",a:"Tap the microphone button on the new request page and speak your list naturally — just as you would on a phone call. The app transcribes in real time and the AI structures it into a clean itemised list."},
                    {q:"Can I edit the parsed list before sending?",a:"Yes. Every field in the parsed items table is editable — description, quantity, unit, category, and notes per line. You can also add new items or remove incorrect ones."},
                    {q:"What are templates?",a:"Templates let you save common material lists for instant reuse. They're grouped by trade so you can find them quickly. When loaded, the full item list populates into Step 2 ready to send immediately."},
                    {q:"Can I set a deadline for supplier responses?",a:"Yes. In Step 2 there's a response deadline date picker. The date appears prominently in the RFQ email and shows as a countdown on the dashboard."},
                  ]},
                  {cat:"Quotes & analysis",qs:[
                    {q:"How do I enter a supplier quote?",a:"In Quote Analysis, each supplier you contacted has their own box. Paste their email response or upload their PDF/Excel document. The AI reads documents and extracts all pricing automatically."},
                    {q:"What does the AI check in a quote?",a:"The AI checks every item for price, stock availability, quantity accuracy, carriage charges, lead times, discounts, and alternatives. It produces a completeness score and recommends the best supplier."},
                    {q:"What happens to other quotes when I approve one?",a:"All other quotes are automatically saved to the Quote Library in the background. They're not lost — you can reference them at any time in the Library page."},
                    {q:"Can I undo an approval?",a:"Yes. The approved quote card shows an Undo button. Tapping it reverses the approval, removes the order from Orders, and returns the job to received status."},
                  ]},
                  {cat:"Orders",qs:[
                    {q:"How do I send a PO to a supplier?",a:"In the Orders page, find the order and tap Send order. An email is sent to the supplier with the full PO details and any notes you add. The order moves to Sent status."},
                    {q:"How do I attach a supplier confirmation?",a:"When an order is in Sent status, the right panel shows an upload area. Upload the supplier's confirmation PDF and the order automatically moves to Confirmed."},
                    {q:"Do completed orders disappear?",a:"No. All orders stay permanently. Use the All / Active / Delivered filter to manage what you see. Delivered orders are kept for reference with their full history."},
                    {q:"Can I upload a PO from my own software?",a:"Yes. In Quote Analysis, the Documents section allows you to upload any PDF or document. Uploaded documents can be promoted to the Orders page for dispatch."},
                  ]},
                  {cat:"Settings & troubleshooting",qs:[
                    {q:"Why isn't the AI working?",a:"You need a free OpenRouter API key. Go to openrouter.ai, sign up (no credit card for basic use), copy your key, and paste it in ProQuote Settings. The status dot in the sidebar will turn green."},
                    {q:"Why aren't emails sending?",a:"Email sending requires a Resend API key and a verified sending domain. Go to resend.com, create a free account, verify your domain, and add the key in Settings."},
                    {q:"My data disappeared after refreshing — what happened?",a:"Data is stored in your browser's local storage. Clearing your browser data or using a different browser/device will not show your data. Full cloud sync is coming soon."},
                    {q:"Can I use ProQuote on multiple devices?",a:"Not yet — data is currently local to the browser you use. Cloud sync across devices is part of the upcoming backend storage update."},
                  ]},
                ];
                return faqs.map(section=>(
                  <div key={section.cat} style={{marginBottom:20}}>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--green-dark)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10,paddingBottom:6,borderBottom:`2px solid var(--green-light)`}}>{section.cat}</div>
                    {section.qs.map((faq,i)=>(
                      <details key={i} style={{marginBottom:6}}>
                        <summary style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",cursor:"pointer",padding:"10px 12px",background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)",listStyle:"none",display:"flex",justifyContent:"space-between",alignItems:"center",userSelect:"none"}}>
                          {faq.q}
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </summary>
                        <div style={{fontSize:13,color:"var(--text-secondary)",padding:"10px 12px",lineHeight:1.7,borderLeft:"3px solid var(--green-dark)",marginLeft:4,marginTop:4}}>
                          {faq.a}
                        </div>
                      </details>
                    ))}
                  </div>
                ));
              })()}
            </div>

            {/* Footer */}
            <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-md)",padding:"16px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:28,height:28,background:"linear-gradient(135deg,#22C55E,#16A34A)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
                </div>
                <span style={{fontSize:14,fontWeight:700,color:"var(--text-primary)"}}>Pro<span style={{color:"var(--green-dark)"}}>Quote</span></span>
                <span style={{fontSize:11,color:"var(--text-muted)"}}>Smart Procurement Platform · Version 1.0</span>
              </div>
              <div style={{display:"flex",gap:16}}>
                <button onClick={()=>setView("contact")} style={{fontSize:12,color:"var(--green-dark)",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>Contact support →</button>
                <button onClick={()=>setView("settings")} style={{fontSize:12,color:"var(--text-secondary)",background:"none",border:"none",cursor:"pointer"}}>Settings →</button>
              </div>
            </div>
          </div>
        )}

        {/* ══ CONTACT ══ */}
        {view==="contact"&&(
          <div style={{animation:"fadeIn 0.25s ease",maxWidth:760}}>
            {/* Header */}
            <div style={{background:"linear-gradient(135deg,#0A0F1E,#1a2744)",borderRadius:20,padding:"36px 40px",marginBottom:28,position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:-40,right:-40,width:200,height:200,background:"radial-gradient(circle,rgba(34,197,94,0.12),transparent 70%)",borderRadius:"50%"}}/>
              <div style={{position:"relative",zIndex:1,display:"flex",alignItems:"center",gap:20}}>
                <div style={{width:56,height:56,background:"linear-gradient(135deg,#6366F1,#4338CA)",borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,boxShadow:"0 8px 24px rgba(99,102,241,0.3)",fontSize:26}}>📧</div>
                <div>
                  <div style={{fontSize:11,color:"#818CF8",letterSpacing:"0.15em",textTransform:"uppercase",fontWeight:600,marginBottom:4}}>ProQuote Support</div>
                  <h1 style={{fontSize:28,fontWeight:800,color:"white",margin:0,letterSpacing:"-0.8px"}}>Contact us</h1>
                  <p style={{fontSize:14,color:"rgba(148,163,184,0.9)",margin:"6px 0 0"}}>Raise a support request, report a bug, or suggest a feature</p>
                </div>
              </div>
            </div>

            {contactSent?(
              <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-lg)",padding:"48px 40px",textAlign:"center",boxShadow:"var(--shadow-sm)"}}>
                <div style={{width:64,height:64,background:"linear-gradient(135deg,var(--green),var(--green-dark))",borderRadius:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 20px",boxShadow:"0 8px 24px rgba(34,197,94,0.25)"}}>✓</div>
                <div style={{fontSize:20,fontWeight:700,color:"var(--text-primary)",marginBottom:8}}>Request sent</div>
                <div style={{fontSize:14,color:"var(--text-secondary)",marginBottom:24,lineHeight:1.6}}>Thank you for getting in touch. We'll respond to your request as soon as possible.</div>
                <div style={{display:"flex",gap:10,justifyContent:"center"}}>
                  <button onClick={()=>setContactSent(false)} style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 20px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Send another</button>
                  <button onClick={()=>setView("dashboard")} style={{background:"linear-gradient(135deg,#22C55E,#16A34A)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"9px 20px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Back to dashboard</button>
                </div>
              </div>
            ):(
              <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 300px",gap:20}}>
                {/* Form */}
                <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"24px 28px",boxShadow:"var(--shadow-sm)"}}>
                  <div style={{fontSize:15,fontWeight:700,color:"var(--text-primary)",marginBottom:20}}>Submit a support request</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                    <div>
                      <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Your name</label>
                      <input value={contactForm.name} onChange={e=>setContactForm(p=>({...p,name:e.target.value}))} placeholder="Andy Hammill" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-input)",color:"var(--text-primary)"}}/>
                    </div>
                    <div>
                      <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Email address</label>
                      <input type="email" value={contactForm.email} onChange={e=>setContactForm(p=>({...p,email:e.target.value}))} placeholder="andy@company.co.uk" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-input)",color:"var(--text-primary)"}}/>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
                    <div>
                      <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Category</label>
                      <select value={contactForm.category} onChange={e=>setContactForm(p=>({...p,category:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-input)",color:"var(--text-primary)"}}>
                        {["Bug report","Feature request","Account issue","Billing","General enquiry"].map(o=><option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Priority</label>
                      <select value={contactForm.priority} onChange={e=>setContactForm(p=>({...p,priority:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-input)",color:"var(--text-primary)"}}>
                        {["Low","Normal","High","Urgent"].map(o=><option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{marginBottom:14}}>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",display:"block",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Description</label>
                    <textarea value={contactForm.description} onChange={e=>setContactForm(p=>({...p,description:e.target.value}))} placeholder="Please describe your issue or request in as much detail as possible. Include any steps to reproduce a bug, or what you'd like to see improved." style={{width:"100%",height:140,padding:"9px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit",background:"var(--bg-input)",color:"var(--text-primary)",lineHeight:1.6}}/>
                  </div>
                  <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-sm)",padding:"10px 14px",marginBottom:16,fontSize:12,color:"var(--text-secondary)"}}>
                    ℹ️ App version: 1.0 · {settings.company||"Company not set"} · {requests.length} requests · {orders.length} orders
                  </div>
                  <button
                    onClick={()=>{
                      if(!contactForm.description.trim()){showToast("Please add a description","warn");return;}
                      showToast("Support request submitted — we'll be in touch soon");
                      setContactSent(true);
                      setContactForm(p=>({...p,description:""}));
                    }}
                    disabled={!contactForm.name.trim()||!contactForm.email.trim()||!contactForm.description.trim()}
                    style={{background:"linear-gradient(135deg,#6366F1,#4338CA)",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"11px 24px",fontSize:14,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 12px rgba(99,102,241,0.3)",opacity:(!contactForm.name.trim()||!contactForm.email.trim()||!contactForm.description.trim())?0.5:1}}>
                    Submit request
                  </button>
                </div>

                {/* Info sidebar */}
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 20px",boxShadow:"var(--shadow-sm)"}}>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:12}}>⏱ Response times</div>
                    {[["Urgent","Within 2 hours","var(--red)"],["High","Within 4 hours","var(--amber)"],["Normal","Within 1 business day","var(--green-dark)"],["Low","Within 2 business days","var(--text-secondary)"]].map(([p,t,col])=>(
                      <div key={p} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid var(--border)"}}>
                        <span style={{fontSize:12,fontWeight:600,color:col}}>{p}</span>
                        <span style={{fontSize:11,color:"var(--text-secondary)"}}>{t}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 20px",boxShadow:"var(--shadow-sm)"}}>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--text-primary)",marginBottom:12}}>🔗 Quick links</div>
                    <button onClick={()=>setView("help")} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 0",background:"none",border:"none",cursor:"pointer",borderBottom:"1px solid var(--border)"}}>
                      <span style={{fontSize:13}}>❓</span><span style={{fontSize:12,color:"var(--text-secondary)"}}>Help & FAQ</span>
                    </button>
                    <button onClick={()=>setView("settings")} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 0",background:"none",border:"none",cursor:"pointer"}}>
                      <span style={{fontSize:13}}>⚙️</span><span style={{fontSize:12,color:"var(--text-secondary)"}}>Settings</span>
                    </button>
                  </div>
                  <div style={{background:"var(--bg-card-solid)",border:"1px solid var(--border)",borderRadius:"var(--radius-lg)",padding:"18px 20px",boxShadow:"var(--shadow-sm)",textAlign:"center"}}>
                    <div style={{width:40,height:40,background:"linear-gradient(135deg,#22C55E,#16A34A)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 10px"}}>
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="3" height="14" rx="1.5" fill="white"/><rect x="6" y="3" width="8" height="3" rx="1.5" fill="white"/><rect x="14" y="3" width="3" height="8" rx="1.5" fill="white"/><rect x="6" y="10" width="8" height="3" rx="1.5" fill="rgba(255,255,255,0.45)"/><circle cx="16.5" cy="15.5" r="2" fill="white"/></svg>
                    </div>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--text-primary)",marginBottom:2}}>Pro<span style={{color:"var(--green-dark)"}}>Quote</span></div>
                    <div style={{fontSize:11,color:"var(--text-muted)"}}>Smart Procurement · v1.0</div>
                    <div style={{fontSize:11,color:"var(--text-muted)",marginTop:4}}>Plumbing · HVAC · Electrical · Mechanical</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ SETTINGS ══ */}
        {view==="settings"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:28,fontWeight:700,letterSpacing:"-0.8px",margin:0,color:"var(--text-primary)"}}>Settings</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Configure your company and email sending</p>
            </div>
            <Card style={{marginBottom:20}}>
              <div style={{fontSize:14,fontWeight:500,marginBottom:16}}>Company details</div>
              <div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                  <div>
                    <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Company name (appears on POs)</label>
                    <input value={sForm.company||""} onChange={e=>setSForm(p=>({...p,company:e.target.value}))} placeholder="e.g. Initial Mechanical Ltd" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Your name (appears on emails)</label>
                    <input value={sForm.contactName||""} onChange={e=>setSForm(p=>({...p,contactName:e.target.value}))} placeholder="e.g. Andy Smith" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
                  </div>
                </div>
              </div>
            </Card>

            <Card style={{marginBottom:20}}>
              <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>AI key — OpenRouter (free, no credit card)</div>
              <p style={{fontSize:13,color:"#6B7280",marginTop:4,marginBottom:16}}>OpenRouter gives you free AI access. No credit card. Takes 2 minutes.</p>
              <div style={{background:"#F8F7F4",border:"1px solid var(--border-solid)",borderRadius:8,padding:"16px 18px",marginBottom:16,fontSize:13,color:"var(--text-secondary)",lineHeight:2}}>
                <strong>Setup (2 minutes, completely free):</strong><br/>
                1. Go to <a href="https://openrouter.ai/signup" target="_blank" rel="noreferrer" style={{color:"#2563EB"}}>openrouter.ai/signup</a> — sign up free, no card needed<br/>
                2. Click your avatar → <strong>Keys</strong> → <strong>Create key</strong> — copy it<br/>
                3. Paste it below and save — AI features work immediately<br/>
                4. Free tier uses Gemini Flash which is excellent for this use case<br/>
                <span style={{color:"#9CA3AF",fontSize:12}}>Key stored only in your browser. Never sent anywhere except OpenRouter.</span>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>OpenRouter API key</label>
                <input type="password" value={sForm.openRouterKey||""} onChange={e=>setSForm(p=>({...p,openRouterKey:e.target.value}))} placeholder="sk-or-v1-xxxxxxxxxxxxxxxx" style={{width:"60%",padding:"9px 12px",border:`1px solid ${sForm.openRouterKey?"#86EFAC":"#E5E7EB"}`,borderRadius:8,fontSize:13,outline:"none",fontFamily:"monospace"}}/>
                {sForm.openRouterKey
                  ? <div style={{fontSize:11,color:"#059669",marginTop:4}}>✓ Key entered — AI features active</div>
                  : <div style={{fontSize:11,color:"#F59E0B",marginTop:4}}>⚠ No key yet — AI features will redirect you to Settings when used</div>
                }
              </div>
            </Card>

            <Card style={{marginBottom:20}}>
              <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>Email sending — Resend</div>
              <p style={{fontSize:13,color:"#6B7280",marginTop:4,marginBottom:16}}>Free tier: 3,000 emails/month. No credit card. Works on Vercel.</p>
              <div style={{background:"#F8F7F4",border:"1px solid var(--border-solid)",borderRadius:8,padding:"16px 18px",marginBottom:16,fontSize:13,color:"var(--text-secondary)",lineHeight:2}}>
                <strong>Setup (2 minutes, completely free):</strong><br/>
                1. Go to <a href="https://resend.com" target="_blank" rel="noreferrer" style={{color:"#2563EB"}}>resend.com</a> → log in<br/>
                2. Click <strong>API Keys</strong> → <strong>Create API Key</strong> → Full Access → copy it<br/>
                3. Paste below. Use <code style={{background:"#E5E7EB",padding:"1px 6px",borderRadius:4,fontSize:12}}>onboarding@resend.dev</code> as From address for now<br/>
                4. To send to any supplier email, add your domain under <strong>Domains</strong> in Resend (free, 5 mins)
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                <div>
                  <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Resend API key</label>
                  <input type="password" value={sForm.resendKey||""} onChange={e=>setSForm(p=>({...p,resendKey:e.target.value}))} placeholder="re_xxxxxxxxxxxxxxxxxxxxxxxx" style={{width:"100%",padding:"9px 12px",border:`1px solid ${sForm.resendKey?"#86EFAC":"#E5E7EB"}`,borderRadius:8,fontSize:13,outline:"none",fontFamily:"monospace"}}/>
                  {sForm.resendKey&&<div style={{fontSize:11,color:"#059669",marginTop:4}}>✓ Key entered</div>}
                </div>
                <div>
                  <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>From email address</label>
                  <input value={sForm.fromEmail||""} onChange={e=>setSForm(p=>({...p,fromEmail:e.target.value}))} placeholder="onboarding@resend.dev" style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
                  <div style={{fontSize:11,color:"#9CA3AF",marginTop:4}}>Use onboarding@resend.dev for now. Add your own domain in Resend later.</div>
                </div>
              </div>
            </Card>

            <div style={{display:"flex",gap:10}}>
              <Btn onClick={()=>{saveSettings(sForm);showToast("Settings saved");}} color="#6366F1">Save settings</Btn>
              <Btn outline onClick={()=>setSForm({company:"",contactName:"",fromEmail:"",resendKey:"",openRouterKey:"",...settings})}>Reset</Btn>
            </div>
          </div>
        )}

      </div>

      </>);
      })()}

      {/* ══ TEMPLATE MODAL ══ */}
      {templateModal&&(()=>{
        const tradeOrder = ["Plumbing","HVAC","Electrical","Mechanical","Ventilation","Gas","General"];
        const grouped = tradeOrder.reduce((acc,tr)=>{
          const matching = templates.filter(t=>t.trade===tr);
          if(matching.length>0) acc[tr]=matching;
          return acc;
        },{});
        // Any trade not in our order
        templates.filter(t=>!tradeOrder.includes(t.trade)).forEach(t=>{
          if(!grouped[t.trade]) grouped[t.trade]=[];
          grouped[t.trade].push(t);
        });
        const currentTrade = trade||"Plumbing";
        return(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"24px 28px",maxWidth:560,width:"100%",maxHeight:"85vh",overflow:"auto",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:17,fontWeight:700,color:"var(--text-primary)"}}>Request templates</div>
                <div style={{fontSize:12,color:"var(--text-secondary)",marginTop:2}}>Material list templates — grouped by trade</div>
              </div>
              <button onClick={()=>setTemplateModal(false)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"var(--text-muted)"}}>✕</button>
            </div>

            {/* Save current as template */}
            {parsed&&(
              <div style={{background:"var(--green-mint)",border:"1px solid var(--green-dark)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20}}>
                <div style={{fontSize:12,fontWeight:600,color:"var(--green-deep)",marginBottom:8}}>💾 Save current list — {currentTrade}</div>
                <div style={{display:"flex",gap:10}}>
                  <input value={newTemplateName} onChange={e=>setNewTemplateName(e.target.value)}
                    placeholder={`Name e.g. "Standard ${currentTrade} pack"`}
                    style={{flex:1,padding:"8px 12px",border:"1px solid var(--border)",borderRadius:"var(--radius-sm)",fontSize:13,outline:"none",background:"var(--bg-input)",color:"var(--text-primary)"}}
                    onKeyDown={e=>e.key==="Enter"&&handleSaveTemplate()}
                  />
                  <Btn onClick={handleSaveTemplate} disabled={!newTemplateName.trim()} color="#16A34A">Save</Btn>
                </div>
                <div style={{fontSize:11,color:"var(--text-tertiary)",marginTop:8}}>Will be saved under: <strong>{currentTrade}</strong> · {parsed.items.length} items</div>
              </div>
            )}

            {/* Grouped templates */}
            {templates.length===0?(
              <div style={{textAlign:"center",padding:"40px 0",color:"var(--text-tertiary)"}}>
                <div style={{fontSize:36,marginBottom:12}}>📋</div>
                <div style={{fontSize:15,fontWeight:600,color:"var(--text-secondary)"}}>No templates yet</div>
                <div style={{fontSize:12,marginTop:6,lineHeight:1.6}}>Create a material request, then tap "Save as template" in Step 2 to save it here for quick reuse</div>
              </div>
            ):(
              <div>
                {/* Current trade first if exists */}
                {Object.keys(grouped).sort((a,b)=>a===currentTrade?-1:b===currentTrade?1:0).map(tradeName=>(
                  <div key={tradeName} style={{marginBottom:16}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <span style={{fontSize:11,fontWeight:700,color:tradeName===currentTrade?"var(--green-dark)":"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.1em"}}>
                        {tradeName===currentTrade?"★ ":""}{tradeName}
                      </span>
                      <span style={{fontSize:10,color:"var(--text-muted)",background:"var(--bg-subtle2)",padding:"1px 7px",borderRadius:99}}>{grouped[tradeName].length}</span>
                    </div>
                    {grouped[tradeName].map(t=>(
                      <div key={t.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:tradeName===currentTrade?"var(--green-mint)":"var(--bg-subtle)",borderRadius:"var(--radius-md)",marginBottom:6,border:`1px solid ${tradeName===currentTrade?"var(--green-dark)":"var(--border)"}`}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                            <div style={{fontSize:13,fontWeight:600,color:"var(--text-primary)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</div>
                            {t.usageCount>0&&<span style={{fontSize:9,color:"var(--text-muted)",background:"var(--bg-subtle2)",padding:"1px 6px",borderRadius:99,flexShrink:0}}>used {t.usageCount}×</span>}
                          </div>
                          <div style={{fontSize:11,color:"var(--text-secondary)"}}>{t.items.length} items{t.lastUsed?` · last used ${t.lastUsed}`:` · saved ${t.created}`}</div>
                          <div style={{fontSize:11,color:"var(--text-muted)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.items.slice(0,3).map(i=>`${i.quantity} ${i.unit} ${i.description}`).join(", ")}{t.items.length>3?"…":""}</div>
                        </div>
                        <div style={{display:"flex",gap:6,flexShrink:0}}>
                          <button onClick={()=>handleLoadTemplate(t)} style={{fontSize:12,color:"white",background:"var(--green-dark)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 14px",cursor:"pointer",fontWeight:600}}>Load</button>
                          <button onClick={()=>saveTemplates(templates.filter(x=>x.id!==t.id))} style={{fontSize:12,color:"var(--red)",background:"var(--red-light)",border:"none",borderRadius:"var(--radius-sm)",padding:"7px 10px",cursor:"pointer"}}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* ══ APPROVE CONFIRMATION MODAL ══ */}
      {approveConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:440,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{fontSize:40,marginBottom:12}}>📋</div>
              <div style={{fontSize:18,fontWeight:700,color:"var(--text-primary)",marginBottom:6}}>Approve this quote?</div>
              <div style={{fontSize:13,color:"var(--text-secondary)",lineHeight:1.6}}>This will generate the PO, create an order, and auto-save all other quotes to the library.</div>
            </div>
            <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div>
                  <div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>SUPPLIER</div>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-primary)"}}>{approveConfirm?.supplierName||"—"}</div>
                </div>
                <div>
                  <div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>ESTIMATED TOTAL</div>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--green-dark)"}}>{approveConfirm?.estimatedTotal||approveConfirm?.subtotal||"—"}</div>
                </div>
                <div>
                  <div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>COMPLETENESS</div>
                  <div style={{fontSize:14,fontWeight:600,color:approveConfirm?.completeness>=80?"var(--green-dark)":"var(--amber)"}}>{approveConfirm?.completeness||0}%</div>
                </div>
                <div>
                  <div style={{fontSize:11,color:"var(--text-muted)",marginBottom:3}}>OTHER QUOTES</div>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--text-secondary)"}}>{allAnalyses.length-1} → auto-saved to library</div>
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <Btn outline onClick={()=>setApproveConfirm(null)}>Cancel</Btn>
              <Btn color="#16A34A" onClick={()=>handleApprovePO(approveConfirm)}>Confirm approval</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ══ APPROVE SUCCESS MODAL ══ */}
      {approveSuccess&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",backdropFilter:"blur(6px)",zIndex:1001,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"36px 40px",maxWidth:420,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--green-dark)",textAlign:"center",animation:"fadeIn 0.3s ease"}}>
            <div style={{width:64,height:64,background:"linear-gradient(135deg,var(--green),var(--green-dark))",borderRadius:20,display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,margin:"0 auto 20px",boxShadow:"0 8px 24px rgba(34,197,94,0.3)"}}>✓</div>
            <div style={{fontSize:22,fontWeight:800,color:"var(--text-primary)",letterSpacing:"-0.5px",marginBottom:6}}>PO Approved</div>
            <div style={{fontSize:15,fontWeight:600,color:"var(--green-dark)",marginBottom:16,fontFamily:"'JetBrains Mono',monospace"}}>{approveSuccess.poNum}</div>
            <div style={{background:"var(--bg-subtle)",borderRadius:"var(--radius-md)",padding:"14px 16px",marginBottom:20,textAlign:"left"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontSize:12,color:"var(--text-secondary)"}}>Supplier</span>
                <span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{approveSuccess.supplier}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontSize:12,color:"var(--text-secondary)"}}>Job reference</span>
                <span style={{fontSize:12,fontWeight:600,color:"var(--text-primary)"}}>{approveSuccess.jobRef}</span>
              </div>
              {approveSuccess.estimatedTotal&&<div style={{display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:12,color:"var(--text-secondary)"}}>Estimated total</span>
                <span style={{fontSize:12,fontWeight:600,color:"var(--green-dark)"}}>{approveSuccess.estimatedTotal}</span>
              </div>}
            </div>
            <div style={{fontSize:12,color:"var(--text-tertiary)",marginBottom:20}}>Other quotes have been saved to the Quote Library. An order has been created in Orders ready to dispatch to the supplier.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={()=>{setApproveSuccess(null);setView("orders");}} style={{background:"linear-gradient(135deg,var(--green),var(--green-dark))",color:"white",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 24px",fontSize:13,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 12px rgba(34,197,94,0.3)"}}>
                View in Orders →
              </button>
              <button onClick={()=>setApproveSuccess(null)} style={{background:"var(--bg-subtle2)",color:"var(--text-secondary)",border:"none",borderRadius:"var(--radius-sm)",padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer"}}>
                Stay here
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ DELETE CONFIRM MODAL ══ */}
      {deleteConfirm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:420,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{fontSize:32,marginBottom:12,textAlign:"center"}}>🗑️</div>
            <div style={{fontSize:16,fontWeight:600,marginBottom:8,textAlign:"center"}}>Delete this request?</div>
            <div style={{fontSize:13,color:"#6B7280",marginBottom:24,textAlign:"center"}}>This cannot be undone. The request and all its activity will be permanently removed.</div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <Btn outline onClick={()=>setDeleteConfirm(null)}>Cancel</Btn>
              <Btn color="#DC2626" onClick={()=>handleDelete(deleteConfirm)}>Yes, delete it</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ══ EDIT MODAL ══ */}
      {editModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:540,width:"100%",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:20}}>Edit request — {editModal.id}</div>
            <div style={{display:"grid",gap:14}}>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Job reference</label>
                <input value={editForm.jobRef||""} onChange={e=>setEditForm(p=>({...p,jobRef:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Site / location</label>
                <input value={editForm.site||""} onChange={e=>setEditForm(p=>({...p,site:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:10,fontSize:13,outline:"none",transition:"border-color 0.15s",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Status</label>
                <select value={editForm.status||"draft"} onChange={e=>setEditForm(p=>({...p,status:e.target.value}))} style={{width:"100%",padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,background:"var(--bg-card-solid)",outline:"none"}}>
                  <option value="draft">Draft</option>
                  <option value="pending">Pending quotes</option>
                  <option value="received">Quotes received</option>
                  <option value="approved">Approved</option>
                </select>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"var(--text-secondary)",display:"block",marginBottom:6}}>Notes</label>
                <textarea value={editForm.notes||""} onChange={e=>setEditForm(p=>({...p,notes:e.target.value}))} placeholder="Add any notes about this request..." style={{width:"100%",height:80,padding:"9px 12px",border:"1px solid var(--border-solid)",borderRadius:8,fontSize:13,outline:"none",resize:"vertical",fontFamily:"inherit"}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:20,justifyContent:"flex-end"}}>
              <Btn outline onClick={()=>setEditModal(null)}>Cancel</Btn>
              <Btn onClick={handleEditSave}>Save changes</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ══ ACTIVITY LOG MODAL ══ */}
      {activityModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{background:"var(--bg-card-solid)",borderRadius:"var(--radius-lg)",padding:"28px 32px",maxWidth:560,width:"100%",maxHeight:"80vh",overflow:"auto",boxShadow:"var(--shadow-lg)",border:"1px solid var(--border)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:16,fontWeight:600}}>{activityModal.id} — Activity log</div>
                <div style={{fontSize:12,color:"#6B7280",marginTop:2}}>{activityModal.jobRef} · {activityModal.site}</div>
              </div>
              <button onClick={()=>setActivityModal(null)} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#9CA3AF"}}>✕</button>
            </div>
            {(!activityModal.activity||activityModal.activity.length===0)?(
              <div style={{textAlign:"center",padding:"40px 0",color:"#9CA3AF",fontSize:13}}>No activity recorded yet</div>
            ):(
              <div>
                {[...(activityModal.activity||[])].reverse().map((entry,i)=>(
                  <div key={i} style={{display:"flex",gap:14,padding:"12px 0",borderBottom:"1px solid #F3F4F6"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:"#3B82F6",marginTop:5,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                        <span style={{fontSize:13,fontWeight:500,color:"var(--text-primary)"}}>{entry.action}</span>
                        <span style={{fontSize:11,color:"#9CA3AF",whiteSpace:"nowrap",marginLeft:12}}>{new Date(entry.ts).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span>
                      </div>
                      {entry.detail&&<div style={{fontSize:12,color:"var(--text-secondary)",marginTop:3}}>{entry.detail}</div>}
                      <div style={{fontSize:11,color:"var(--text-muted)",marginTop:2}}>by {entry.user}</div>
                    </div>
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
