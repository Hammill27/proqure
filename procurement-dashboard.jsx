import { useState, useEffect, useRef } from "react";

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
  draft:    { bg:"#FEF3C7", text:"#92400E",  label:"Draft" },
  pending:  { bg:"#DBEAFE", text:"#1E40AF",  label:"Pending quotes" },
  received: { bg:"#F3E8FF", text:"#6B21A8",  label:"Quotes received" },
  approved: { bg:"#D1FAE5", text:"#065F46",  label:"Approved" },
};

// ─── AI helpers ───────────────────────────────────────────────────────────────
async function callAI(system, user) {
  const key = window.__piq_or_key__ || "";
  if (!key) throw new Error("NO_KEY");
  // Try models in order until one works
  const models = [
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.1-8b-instruct",
    "mistralai/mistral-7b-instruct",
    "google/gemini-flash-1.5",
  ];
  let lastErr = "";
  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+key,"HTTP-Referer":"https://procureiq.app","X-Title":"ProcureIQ"},
        body: JSON.stringify({ model, messages:[{role:"system",content:system},{role:"user",content:user}] })
      });
      const d = await res.json();
      if (d.error) { lastErr = d.error.message||"API error"; continue; }
      const text = d.choices?.[0]?.message?.content || "";
      if (text) return text;
    } catch(e) { lastErr = e.message; }
  }
  throw new Error("No free models available: "+lastErr);
}
async function parseMaterialList(raw) {
  const sys = `You are a procurement assistant for UK plumbing, HVAC, and electrical trades. Parse a material request into structured JSON. Return ONLY valid JSON, no markdown.
Format: {"items":[{"id":1,"description":"...","quantity":N,"unit":"...","category":"Plumbing|HVAC|Electrical|Ventilation|Mechanical","notes":"..."}],"jobRef":"...","urgency":"standard|urgent|next-day"}`;
  const txt = await callAI(sys, `Parse this material request: ${raw}`);
  try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); } catch { return null; }
}
async function generateRFQ(items, jobRef, company, contactName, fromEmail) {
  const sys = `You are a professional procurement system for a UK trades company. Generate a professional RFQ email body. Return ONLY the plain text email body, no subject line, no markdown. Sign off with the real contact name and company provided, not placeholders.`;
  const list = items.map(i=>`- ${i.quantity} ${i.unit} ${i.description}`).join("\n");
  return callAI(sys, `Generate an RFQ email for ${company||"our company"}, job ref ${jobRef||"TBC"}, contact name: ${contactName||"The Procurement Team"}, email: ${fromEmail||""}, for:\n${list}\nAsk for unit prices, availability, and delivery lead time. Keep it concise and professional. Sign off with the real name and company, no placeholder brackets.`);
}
async function analyseQuote(items, quoteText) {
  const sys = `You are an AI procurement analyst for UK trades. Compare a supplier quote against the original request. Return ONLY valid JSON, no markdown.
Format: {"matched":[{"item":"...","requestedQty":N,"requestedUnit":"...","quotedPrice":"...","available":true,"notes":"..."}],"missing":["..."],"substitutions":[{"original":"...","substitute":"...","notes":"..."}],"totalEstimate":"...","completeness":N,"recommendation":"...","warnings":["..."]}`;
  const req = items.map(i=>`${i.quantity} ${i.unit} ${i.description}`).join(", ");
  const raw = await callAI(sys, `Request: ${req}\n\nSupplier quote:\n${quoteText}\n\nAnalyse and return JSON.`);
  try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); } catch { return {error:true}; }
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
  doc.text("Powered by ProcureIQ", M, 33);

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
  doc.text("Generated by ProcureIQ — AI-powered procurement for trades", W-M, 280, {align:"right"});

  doc.save(`PO-${poNumber}.pdf`);
}

// ─── Tiny shared components ───────────────────────────────────────────────────
const Btn = ({ onClick, disabled, color="#2563EB", outline=false, children }) => (
  <button onClick={onClick} disabled={disabled} style={{
    background: outline?"transparent": disabled?"#93C5FD":color,
    color: outline?"#374151":"white",
    border: outline?"1px solid #E5E7EB":"none",
    borderRadius:8, padding:"10px 20px", fontSize:13, fontWeight:500,
    cursor: disabled?"not-allowed":"pointer", opacity: disabled?0.7:1,
    display:"inline-flex", alignItems:"center", gap:6
  }}>{children}</button>
);
const Badge = ({ children, bg, text }) => (
  <span style={{ background:bg, color:text, fontSize:11, fontWeight:500, padding:"3px 10px", borderRadius:20, whiteSpace:"nowrap" }}>{children}</span>
);
const Card = ({ children, style={} }) => (
  <div style={{ background:"white", border:"1px solid #E2E8F0", borderRadius:16, padding:"22px 26px", boxShadow:"0 1px 4px rgba(0,0,0,0.04)", ...style }}>{children}</div>
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
  const [requests, setRequests] = useState([]);

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

  // Quote analysis state
  const [activeReq,     setActiveReq]     = useState(null);
  const [quoteInput,    setQuoteInput]    = useState("");
  const [quoteAnalysis, setQuoteAnalysis] = useState(null);

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
      const email = await generateRFQ(parsed.items, jobRef, settings.company, settings.contactName, settings.fromEmail);
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
    setEmailRes(results);
    setLoading(false);
    const ok = results.filter(r=>r.success).length;
    showToast(`${ok} of ${results.length} emails sent`);
    // Auto-save the request after sending
    if (ok > 0) {
      const r = {
        id:`RFQ-${String(requests.length+1).padStart(3,"0")}`,
        jobRef:jobRef||"TBC", site:site||"Site TBC", trade,
        status:"pending",
        created: new Date().toISOString().split("T")[0],
        items: parsed.items
      };
      setRequests(p=>[r,...p]);
      showToast(`Emails sent & request saved as ${r.id}`);
    }
  }

  function handleFinalise() {
    const r = {
      id:`RFQ-${String(requests.length+1).padStart(3,"0")}`,
      jobRef:jobRef||"TBC", site:site||"Site TBC", trade,
      status: emailRes?.some(r=>r.success) ? "pending" : "draft",
      created: new Date().toISOString().split("T")[0],
      items: parsed.items
    };
    setRequests(p=>[r,...p]);
    setView("dashboard");
    setStep(1); setRawInput(""); setParsed(null); setJobRef(""); setSite(""); setRfqEmail(""); setEmailRes(null);
    showToast("Request saved");
  }

  async function handleAnalyse() {
    if (!quoteInput.trim()||!activeReq) return;
    if (!settings.openRouterKey) { showToast("Add your free OpenRouter key in Settings first","warn"); setView("settings"); return; }
    window.__piq_or_key__ = settings.openRouterKey;
    setLoading(true); setLoadMsg("Analysing quote…");
    try {
      const a = await analyseQuote(activeReq.items, quoteInput);
      setQuoteAnalysis(a);
      if (!a.error) setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"received"}:r));
    } catch(e) { showToast("AI error: "+e.message,"warn"); }
    setLoading(false);
  }

  async function handleApprovePO() {
    const sup = suppliers.find(s=>selSup.includes(s.id))||suppliers[0];
    const poNum = `PO-${Date.now().toString().slice(-6)}`;
    await generatePO({ poNumber:poNum, jobRef:activeReq?.jobRef, site:activeReq?.site, supplier:sup, items:activeReq?.items||[], analysis:quoteAnalysis, company:settings.company||"Your Company", contactName:settings.contactName||settings.company||"Your Company", contactEmail:settings.fromEmail||"", date:new Date().toLocaleDateString("en-GB") });
    setRequests(p=>p.map(r=>r.id===activeReq.id?{...r,status:"approved"}:r));
    showToast(`PO ${poNum} downloaded`);
  }

  // ── Render ──
  return (
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",background:"#F1F5F9",minHeight:"100vh",color:"#1A1A1A"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <style>{`*{box-sizing:border-box} @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* Toast notification */}
      {toast && (
        <div style={{position:"fixed",top:20,right:20,zIndex:9999,background:toast.type==="warn"?"#FFFBEB":"#ECFDF5",border:`1px solid ${toast.type==="warn"?"#FDE68A":"#A7F3D0"}`,color:toast.type==="warn"?"#92400E":"#065F46",borderRadius:10,padding:"12px 18px",fontSize:13,fontWeight:500,boxShadow:"0 4px 20px rgba(0,0,0,.1)"}}>
          {toast.type==="warn"?"⚠ ":"✓ "}{toast.msg}
        </div>
      )}

      {/* Sidebar */}
      <div style={{position:"fixed",left:0,top:0,width:240,height:"100vh",background:"linear-gradient(180deg,#0F172A 0%,#1E293B 100%)",display:"flex",flexDirection:"column",zIndex:100,boxShadow:"4px 0 24px rgba(0,0,0,0.15)"}}>
        <div style={{padding:"28px 24px 24px",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:36,height:36,background:"linear-gradient(135deg,#3B82F6,#1D4ED8)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 12px rgba(59,130,246,0.4)"}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
            </div>
            <div>
              <div style={{fontSize:16,fontWeight:700,color:"#F9FAFB",letterSpacing:"-0.5px"}}>ProcureIQ</div>
              <div style={{fontSize:10,color:"#64748B",marginTop:2,letterSpacing:"0.05em",textTransform:"uppercase"}}>Procurement Platform</div>
            </div>
          </div>
        </div>
        <nav style={{padding:"20px 16px",flex:1}}>
          {[
            {id:"dashboard",label:"Dashboard",      d:"M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z"},
            {id:"new",      label:"New request",    d:"M12 5v14M5 12h14"},
            {id:"requests", label:"All requests",   d:"M4 6h16M4 12h10M4 18h6"},
            {id:"quotes",   label:"Quote analysis", d:"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2"},
            {id:"suppliers",label:"Suppliers",      d:"M17 20h-2a4 4 0 00-8 0H5m7-10a3 3 0 100-6 3 3 0 000 6z"},
            {id:"settings", label:"Settings",       d:"M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"},
          ].map(item=>(
            <button key={item.id} onClick={()=>{setView(item.id);if(item.id==="quotes"&&requests.length&&!activeReq)setActiveReq(requests[0]);}}
              style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,border:"none",background:view===item.id?"rgba(59,130,246,0.15)":"transparent",color:view===item.id?"#93C5FD":"#64748B",cursor:"pointer",fontSize:13,fontWeight:view===item.id?600:400,marginBottom:3,textAlign:"left",borderLeft:view===item.id?"3px solid #3B82F6":"3px solid transparent"}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={item.d}/></svg>
              {item.label}
            </button>
          ))}
        </nav>
        <div style={{padding:"16px 24px",borderTop:"1px solid rgba(255,255,255,0.06)"}}>
          <div style={{fontSize:11,background:"rgba(255,255,255,0.05)",borderRadius:8,padding:"8px 12px",display:"flex",alignItems:"center",gap:6}}>
            <span style={{color:settings.openRouterKey?"#10B981":"#F59E0B",marginRight:6}}>●</span>
            <span style={{color:settings.openRouterKey?"#10B981":"#F59E0B"}}>{settings.openRouterKey?(settings.resendKey?"AI + Email ready":"AI active · no email"):"Setup needed"}</span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div style={{marginLeft:240,padding:"36px 40px",maxWidth:1140}}>

        {/* ══ DASHBOARD ══ */}
        {view==="dashboard"&&(
          <div>
            <div style={{marginBottom:28}}>
              <h1 style={{fontSize:28,fontWeight:700,letterSpacing:"-0.8px",margin:0,background:"linear-gradient(135deg,#1E293B,#3B82F6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Dashboard</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>{new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:24}}>
              {[
                {label:"Total requests",value:stats.total,   color:"#2563EB",bg:"linear-gradient(135deg,#EFF6FF,#DBEAFE)",icon:"📋"},
                {label:"Pending quotes", value:stats.pending, color:"#7C3AED",bg:"linear-gradient(135deg,#F5F3FF,#EDE9FE)",icon:"⏳"},
                {label:"Quotes received",value:stats.received,color:"#D97706",bg:"linear-gradient(135deg,#FFFBEB,#FEF3C7)",icon:"📬"},
                {label:"Approved",       value:stats.approved,color:"#059669",bg:"linear-gradient(135deg,#ECFDF5,#D1FAE5)",icon:"✅"},
              ].map(s=>(
                <div key={s.label} style={{background:s.bg,border:"1px solid rgba(0,0,0,0.06)",borderRadius:16,padding:"20px 24px",position:"relative",overflow:"hidden"}}>
                  <div style={{fontSize:11,fontWeight:600,color:s.color,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>{s.icon} {s.label}</div>
                  <div style={{fontSize:36,fontWeight:700,color:s.color,fontFamily:"'DM Mono',monospace",lineHeight:1}}>{s.value}</div>
                </div>
              ))}
            </div>
            {!settings.openRouterKey&&(
              <div style={{background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:10,padding:"14px 20px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:13,color:"#991B1B"}}>⚠ <strong>AI needs a free key to work</strong> — sign up free at openrouter.ai (no card), paste your key in Settings. 2 minutes.</div>
                <button onClick={()=>setView("settings")} style={{background:"#DC2626",color:"white",border:"none",borderRadius:7,padding:"7px 16px",fontSize:12,fontWeight:500,cursor:"pointer",marginLeft:16,whiteSpace:"nowrap"}}>Add key →</button>
              </div>
            )}
            {settings.openRouterKey&&!settings.resendKey&&(
              <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:"14px 20px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:13,color:"#92400E"}}>⚠ Email sending not configured — add your Resend API key in <strong>Settings</strong> to send RFQs to suppliers.</div>
                <button onClick={()=>setView("settings")} style={{background:"#F59E0B",color:"white",border:"none",borderRadius:7,padding:"7px 16px",fontSize:12,fontWeight:500,cursor:"pointer",marginLeft:16,whiteSpace:"nowrap"}}>Open Settings →</button>
              </div>
            )}
            <Card style={{padding:0,overflow:"hidden"}}>
              <div style={{padding:"16px 24px",borderBottom:"1px solid #F3F4F6",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontWeight:500,fontSize:15}}>Recent requests</span>
                <Btn onClick={()=>setView("new")}>+ New request</Btn>
              </div>
              {requests.length===0?(
                <div style={{padding:"60px 24px",textAlign:"center"}}>
                  <div style={{fontSize:40,marginBottom:12}}>📋</div>
                  <div style={{fontSize:15,fontWeight:500,color:"#1E293B",marginBottom:6}}>No requests yet</div>
                  <div style={{fontSize:13,color:"#94A3B8",marginBottom:20}}>Create your first material request to get started</div>
                  <Btn onClick={()=>setView("new")}>+ Create first request</Btn>
                </div>
              ):(
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{background:"#F9FAFB"}}>
                    {["Request","Job ref","Site","Trade","Items","Status","Created",""].map(h=>(
                      <th key={h} style={{padding:"10px 16px",textAlign:"left",fontSize:12,fontWeight:500,color:"#6B7280"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{requests.map(r=>{const sc=STATUS[r.status];return(
                    <tr key={r.id} style={{borderTop:"1px solid #F3F4F6"}}>
                      <td style={{padding:"13px 16px",fontSize:13,fontWeight:500,fontFamily:"'DM Mono',monospace",color:"#2563EB"}}>{r.id}</td>
                      <td style={{padding:"13px 16px",fontSize:13}}>{r.jobRef}</td>
                      <td style={{padding:"13px 16px",fontSize:13,color:"#6B7280"}}>{r.site}</td>
                      <td style={{padding:"13px 16px",fontSize:13}}>{r.trade}</td>
                      <td style={{padding:"13px 16px",fontSize:13}}>{r.items.length}</td>
                      <td style={{padding:"13px 16px"}}><Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge></td>
                      <td style={{padding:"13px 16px",fontSize:12,color:"#9CA3AF"}}>{r.created}</td>
                      <td style={{padding:"13px 16px"}}>
                        <button onClick={()=>{setActiveReq(r);setView("quotes");}} style={{fontSize:12,color:"#2563EB",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>
                          {r.status==="received"?"Analyse →":"View →"}
                        </button>
                      </td>
                    </tr>
                  )})}</tbody>
                </table>
              )}
            </Card>
          </div>
        )}

        {/* ══ NEW REQUEST WIZARD ══ */}
        {view==="new"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:26,fontWeight:600,letterSpacing:"-0.5px",margin:0}}>New material request</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Speak or type your list — AI structures it and sends RFQs to suppliers</p>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:28,alignItems:"center"}}>
              {["Describe materials","Review & configure","Send RFQs"].map((s,i)=>(
                <div key={s} style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:600,background:step>i+1?"#2563EB":step===i+1?"#2563EB":"#E5E7EB",color:step>=i+1?"white":"#9CA3AF"}}>{step>i+1?"✓":i+1}</div>
                  <span style={{fontSize:13,color:step===i+1?"#111827":"#9CA3AF",fontWeight:step===i+1?500:400}}>{s}</span>
                  {i<2&&<div style={{width:36,height:1,background:"#E5E7EB"}}/>}
                </div>
              ))}
            </div>

            {/* Step 1 */}
            {step===1&&(
              <Card>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16,marginBottom:20}}>
                  {[{label:"Job reference",val:jobRef,set:setJobRef,ph:"e.g. JOB-2024-056"},{label:"Site / location",val:site,set:setSite,ph:"e.g. Unit 7, High Street"}].map(f=>(
                    <div key={f.label}>
                      <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>{f.label}</label>
                      <input value={f.val} onChange={e=>f.set(e.target.value)} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,outline:"none"}}/>
                    </div>
                  ))}
                  <div>
                    <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Trade</label>
                    <select value={trade} onChange={e=>setTrade(e.target.value)} style={{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,background:"white",outline:"none"}}>
                      {TRADES.map(t=><option key={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <label style={{fontSize:12,fontWeight:500,color:"#374151"}}>Material requirements <span style={{color:"#9CA3AF",fontWeight:400}}>(speak or type naturally)</span></label>
                  {voiceOk?(
                    <button onClick={()=>listening?micStop():micStart()}
                      style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,border:`1.5px solid ${listening?"#DC2626":"#2563EB"}`,background:listening?"#FEF2F2":"#EFF6FF",color:listening?"#DC2626":"#2563EB",fontSize:12,fontWeight:500,cursor:"pointer"}}>
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
                  <div style={{background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:8,padding:"10px 14px",marginBottom:8,fontSize:13,color:"#991B1B"}}>
                    <span style={{fontWeight:500}}>Listening… </span>
                    {interim?<span style={{color:"#DC2626"}}>{interim}</span>:<span style={{color:"#FCA5A5"}}>speak your list now</span>}
                  </div>
                )}
                <textarea value={rawInput} onChange={e=>setRawInput(e.target.value)}
                  placeholder={"Plumbing: \"I need 20 metres of 22mm copper pipe, 12 compression elbows, 6 isolation valves for the plant room.\"\n\nElectrical: \"100m of 2.5mm twin and earth, 20 double sockets, a 10-way consumer unit and 20mm conduit.\""}
                  style={{width:"100%",height:150,padding:"12px 14px",border:`1px solid ${listening?"#FECACA":"#E5E7EB"}`,borderRadius:8,fontSize:13,lineHeight:1.6,resize:"vertical",outline:"none",fontFamily:"inherit",background:listening?"#FFFBFB":"white"}}/>
                <div style={{marginTop:16,display:"flex",justifyContent:"flex-end"}}>
                  <Btn onClick={handleParse} disabled={!rawInput.trim()||loading}>
                    {loading?<><Spinner/>{loadMsg}</>:"Parse with AI →"}
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
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{background:"#F9FAFB"}}>
                    {["#","Description","Qty","Unit","Category","Notes"].map(h=><th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:12,fontWeight:500,color:"#6B7280"}}>{h}</th>)}
                  </tr></thead>
                  <tbody>{parsed.items?.map((item,i)=>(
                    <tr key={item.id} style={{borderTop:"1px solid #F3F4F6"}}>
                      <td style={{padding:"11px 14px",fontSize:12,color:"#9CA3AF"}}>{i+1}</td>
                      <td style={{padding:"11px 14px",fontSize:13,fontWeight:500}}>{item.description}</td>
                      <td style={{padding:"11px 14px",fontSize:13,fontFamily:"'DM Mono',monospace"}}>{item.quantity}</td>
                      <td style={{padding:"11px 14px",fontSize:13,color:"#6B7280"}}>{item.unit}</td>
                      <td style={{padding:"11px 14px"}}><Badge bg="#EFF6FF" text="#1D4ED8">{item.category}</Badge></td>
                      <td style={{padding:"11px 14px",fontSize:12,color:"#9CA3AF"}}>{item.notes||"—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
                <div style={{marginTop:20,padding:16,background:"#F9FAFB",borderRadius:8}}>
                  <div style={{fontSize:13,fontWeight:500,marginBottom:10}}>Suppliers to receive RFQ <span style={{color:"#6B7280",fontWeight:400}}>({trade})</span></div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {filteredSup.map(s=>(
                      <label key={s.id} style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer",background:selSup.includes(s.id)?"#EFF6FF":"white",border:`1px solid ${selSup.includes(s.id)?"#BFDBFE":"#E5E7EB"}`,borderRadius:8,padding:"6px 12px"}}>
                        <input type="checkbox" checked={selSup.includes(s.id)} onChange={e=>setSelSup(p=>e.target.checked?[...p,s.id]:p.filter(id=>id!==s.id))} style={{accentColor:"#2563EB"}}/>
                        <span style={{fontWeight:500}}>{s.name}</span>
                        <span style={{fontSize:11,color:"#9CA3AF"}}>{s.email}</span>
                      </label>
                    ))}
                    {filteredSup.length===0&&<div style={{fontSize:13,color:"#9CA3AF"}}>No suppliers for {trade} — add them in Suppliers.</div>}
                  </div>
                </div>
                <div style={{marginTop:20,display:"flex",justifyContent:"space-between"}}>
                  <Btn outline onClick={()=>setStep(1)}>← Back</Btn>
                  <Btn onClick={handleGenRFQ} disabled={loading}>{loading?<><Spinner/>{loadMsg}</>:"Generate RFQ email →"}</Btn>
                </div>
              </Card>
            )}

            {/* Step 3 */}
            {step===3&&rfqEmail&&(
              <Card>
                <div style={{fontSize:15,fontWeight:500,marginBottom:4}}>RFQ email ready</div>
                <div style={{fontSize:13,color:"#6B7280",marginBottom:16}}>Will be sent to: {suppliers.filter(s=>selSup.includes(s.id)).map(s=>s.name).join(", ")}</div>
                <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:8,padding:20,marginBottom:16}}>
                  <div style={{fontSize:12,color:"#9CA3AF",marginBottom:4}}>To: {suppliers.filter(s=>selSup.includes(s.id)).map(s=>s.email).join(", ")}</div>
                  <div style={{fontSize:12,color:"#9CA3AF",marginBottom:14,paddingBottom:12,borderBottom:"1px solid #E5E7EB"}}>Subject: Request for Quotation — {jobRef||parsed?.jobRef||"TBC"}</div>
                  <pre style={{fontSize:13,lineHeight:1.7,whiteSpace:"pre-wrap",fontFamily:"inherit",margin:0,color:"#374151"}}>{rfqEmail}</pre>
                </div>

                {!settings.resendKey&&(
                  <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:8,padding:"12px 16px",marginBottom:16,fontSize:13,color:"#92400E"}}>
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
                          <div style={{fontSize:12,color:"#991B1B",marginTop:6,background:"#FEE2E2",padding:"8px 10px",borderRadius:6}}>
                            CORS error — Resend blocks direct browser calls in some environments. Try deploying to Vercel where this works correctly.
                          </div>
                        )}
                        {!r.success&&r.statusCode===403&&(
                          <div style={{fontSize:12,color:"#991B1B",marginTop:6,background:"#FEE2E2",padding:"8px 10px",borderRadius:6}}>
                            403 Forbidden — your Resend key may not have send permissions. Go to resend.com → API Keys → check the key has "Full access" not "Read only".
                          </div>
                        )}
                        {!r.success&&r.statusCode===422&&(
                          <div style={{fontSize:12,color:"#991B1B",marginTop:6,background:"#FEE2E2",padding:"8px 10px",borderRadius:6}}>
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
                      <Btn onClick={handleSendEmails} disabled={loading} color="#7C3AED">
                        {loading?<><Spinner/>{loadMsg}</>:`Send to ${selSup.length} supplier${selSup.length!==1?"s":""} →`}
                      </Btn>
                    )}
                    <Btn onClick={handleFinalise} color="#059669">Save request ✓</Btn>
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
              <h1 style={{fontSize:26,fontWeight:600,letterSpacing:"-0.5px",margin:0}}>Quote analysis</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Paste a supplier quote — AI compares it line by line against your request</p>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"220px 1fr",gap:20}}>
              <div>
                <div style={{fontSize:12,fontWeight:500,color:"#374151",marginBottom:8}}>Select request</div>
                {requests.map(r=>(
                  <button key={r.id} onClick={()=>{setActiveReq(r);setQuoteAnalysis(null);setQuoteInput("");}}
                    style={{width:"100%",textAlign:"left",padding:"10px 14px",borderRadius:8,border:`1px solid ${activeReq?.id===r.id?"#BFDBFE":"#E5E7EB"}`,background:activeReq?.id===r.id?"#EFF6FF":"white",cursor:"pointer",marginBottom:8}}>
                    <div style={{fontSize:12,fontWeight:500,fontFamily:"'DM Mono',monospace",color:"#2563EB"}}>{r.id}</div>
                    <div style={{fontSize:12,color:"#6B7280",marginTop:2}}>{r.trade} · {r.items.length} items</div>
                    <div style={{fontSize:11,color:"#9CA3AF",marginTop:1,marginBottom:4}}>{r.jobRef}</div>
                    <Badge bg={STATUS[r.status].bg} text={STATUS[r.status].text}>{STATUS[r.status].label}</Badge>
                  </button>
                ))}
              </div>
              <div>
                {activeReq?(
                  <>
                    <Card style={{marginBottom:16}}>
                      <div style={{fontSize:13,fontWeight:500,marginBottom:10}}>Original request — {activeReq.id} <span style={{fontWeight:400,color:"#6B7280"}}>{activeReq.site}</span></div>
                      <table style={{width:"100%",borderCollapse:"collapse"}}>
                        <thead><tr style={{background:"#F9FAFB"}}>
                          {["Description","Qty","Unit","Category"].map(h=><th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:12,fontWeight:500,color:"#6B7280"}}>{h}</th>)}
                        </tr></thead>
                        <tbody>{activeReq.items.map((item,i)=>(
                          <tr key={i} style={{borderTop:"1px solid #F3F4F6"}}>
                            <td style={{padding:"10px 12px",fontSize:13}}>{item.description}</td>
                            <td style={{padding:"10px 12px",fontSize:13,fontFamily:"'DM Mono',monospace"}}>{item.quantity}</td>
                            <td style={{padding:"10px 12px",fontSize:13,color:"#6B7280"}}>{item.unit}</td>
                            <td style={{padding:"10px 12px"}}><Badge bg="#EFF6FF" text="#1D4ED8">{item.category}</Badge></td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </Card>
                    <Card style={{marginBottom:16}}>
                      <label style={{fontSize:13,fontWeight:500,display:"block",marginBottom:8}}>Paste supplier quote here</label>
                      <textarea value={quoteInput} onChange={e=>setQuoteInput(e.target.value)}
                        placeholder={"Paste the supplier's email or quote content here.\n\nExample:\n22mm copper pipe — £4.20/metre (10m available)\n22mm compression elbows — £2.80 each, 12 in stock\n15mm isolation valve — £6.50 each\nPTFE tape — £1.20/roll\nNote: expansion vessels out of stock, 5–7 day lead time."}
                        style={{width:"100%",height:140,padding:"12px 14px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,lineHeight:1.6,resize:"vertical",outline:"none",fontFamily:"inherit"}}/>
                      <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
                        <Btn onClick={handleAnalyse} disabled={!quoteInput.trim()||loading} color="#7C3AED">
                          {loading?<><Spinner/>{loadMsg}</>:"Analyse with AI →"}
                        </Btn>
                      </div>
                    </Card>

                    {quoteAnalysis&&!quoteAnalysis.error&&(
                      <Card>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
                          <div style={{fontSize:15,fontWeight:500}}>AI analysis result</div>
                          <div style={{display:"flex",alignItems:"center",gap:10}}>
                            <span style={{fontSize:13,color:"#6B7280"}}>Completeness</span>
                            <span style={{fontSize:24,fontWeight:600,color:quoteAnalysis.completeness>=80?"#059669":quoteAnalysis.completeness>=60?"#D97706":"#DC2626",fontFamily:"'DM Mono',monospace"}}>{quoteAnalysis.completeness}%</span>
                          </div>
                        </div>
                        {quoteAnalysis.warnings?.length>0&&(
                          <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:8,padding:"12px 16px",marginBottom:16}}>
                            {quoteAnalysis.warnings.map((w,i)=><div key={i} style={{fontSize:13,color:"#92400E"}}>⚠ {w}</div>)}
                          </div>
                        )}
                        {quoteAnalysis.matched?.length>0&&(
                          <>
                            <div style={{fontSize:13,fontWeight:500,marginBottom:8,color:"#059669"}}>✓ Matched ({quoteAnalysis.matched.length})</div>
                            <table style={{width:"100%",borderCollapse:"collapse",marginBottom:16}}>
                              <thead><tr style={{background:"#F0FDF4"}}>
                                {["Item","Requested","Unit price","Stock","Notes"].map(h=><th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:12,fontWeight:500,color:"#374151"}}>{h}</th>)}
                              </tr></thead>
                              <tbody>{quoteAnalysis.matched.map((m,i)=>(
                                <tr key={i} style={{borderTop:"1px solid #F3F4F6"}}>
                                  <td style={{padding:"10px 12px",fontSize:13}}>{m.item}</td>
                                  <td style={{padding:"10px 12px",fontSize:13,fontFamily:"'DM Mono',monospace"}}>{m.requestedQty} {m.requestedUnit}</td>
                                  <td style={{padding:"10px 12px",fontSize:13,fontWeight:500,color:"#059669",fontFamily:"'DM Mono',monospace"}}>{m.quotedPrice||"—"}</td>
                                  <td style={{padding:"10px 12px"}}><Badge bg={m.available?"#D1FAE5":"#FEE2E2"} text={m.available?"#065F46":"#991B1B"}>{m.available?"In stock":"Unavailable"}</Badge></td>
                                  <td style={{padding:"10px 12px",fontSize:12,color:"#6B7280"}}>{m.notes||"—"}</td>
                                </tr>
                              ))}</tbody>
                            </table>
                          </>
                        )}
                        {quoteAnalysis.missing?.length>0&&(
                          <div style={{background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:8,padding:"12px 16px",marginBottom:16}}>
                            <div style={{fontSize:13,fontWeight:500,color:"#991B1B",marginBottom:6}}>✗ Missing from quote ({quoteAnalysis.missing.length})</div>
                            {quoteAnalysis.missing.map((m,i)=><div key={i} style={{fontSize:13,color:"#991B1B",marginTop:4}}>• {m}</div>)}
                          </div>
                        )}
                        {quoteAnalysis.substitutions?.length>0&&(
                          <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:8,padding:"12px 16px",marginBottom:16}}>
                            <div style={{fontSize:13,fontWeight:500,color:"#92400E",marginBottom:6}}>~ Substitutions proposed</div>
                            {quoteAnalysis.substitutions.map((s,i)=><div key={i} style={{fontSize:13,color:"#92400E",marginTop:4}}>• {s.original} → {s.substitute}{s.notes?` (${s.notes})`:""}</div>)}
                          </div>
                        )}
                        <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:8,padding:"14px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                          <div>
                            <div style={{fontSize:12,color:"#374151",fontWeight:500}}>AI recommendation</div>
                            <div style={{fontSize:13,color:"#166534",marginTop:4}}>{quoteAnalysis.recommendation}</div>
                          </div>
                          {quoteAnalysis.totalEstimate&&(
                            <div style={{textAlign:"right"}}>
                              <div style={{fontSize:12,color:"#6B7280"}}>Estimated total</div>
                              <div style={{fontSize:22,fontWeight:600,fontFamily:"'DM Mono',monospace",color:"#111827"}}>{quoteAnalysis.totalEstimate}</div>
                            </div>
                          )}
                        </div>
                        <div style={{display:"flex",gap:10}}>
                          <Btn onClick={handleApprovePO} color="#059669">Approve &amp; download PO (PDF)</Btn>
                          <Btn outline onClick={()=>{setQuoteInput("");setQuoteAnalysis(null);}}>Enter another quote</Btn>
                        </div>
                      </Card>
                    )}
                  </>
                ):(
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:200,color:"#9CA3AF",fontSize:14}}>Select a request from the left</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ══ SUPPLIERS ══ */}
        {view==="suppliers"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:26,fontWeight:600,letterSpacing:"-0.5px",margin:0}}>Suppliers</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Your supplier accounts — add your real ones here</p>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:16,marginBottom:24}}>
              {suppliers.map(s=>(
                <Card key={s.id}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div style={{width:40,height:40,background:"#EFF6FF",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:"#2563EB"}}>{s.name.charAt(0)}</div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      <Badge bg="#F0FDF4" text="#166534">Active</Badge>
                      <button onClick={()=>saveSuppliers(suppliers.filter(x=>x.id!==s.id))} style={{fontSize:11,color:"#DC2626",background:"none",border:"none",cursor:"pointer"}}>Remove</button>
                    </div>
                  </div>
                  <div style={{fontSize:15,fontWeight:500,marginBottom:4}}>{s.name}</div>
                  <div style={{fontSize:12,color:"#6B7280",marginBottom:12}}>{s.email}</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                    {s.categories.map(c=><Badge key={c} bg="#EFF6FF" text="#1D4ED8">{c}</Badge>)}
                  </div>
                </Card>
              ))}
            </div>
            <Card>
              <div style={{fontSize:14,fontWeight:500,marginBottom:16}}>Add a supplier</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:12,alignItems:"end"}}>
                {[{label:"Company name",val:"name",ph:"e.g. BSS Industrial"},{label:"Quote email",val:"email",ph:"quotes@supplier.co.uk"},{label:"Categories",val:"categories",ph:"Plumbing, HVAC"}].map(f=>(
                  <div key={f.val}>
                    <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>{f.label}</label>
                    <input value={newSup[f.val]} onChange={e=>setNewSup(p=>({...p,[f.val]:e.target.value}))} placeholder={f.ph} style={{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,outline:"none"}}/>
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
              <h1 style={{fontSize:26,fontWeight:600,letterSpacing:"-0.5px",margin:0}}>All requests</h1>
            </div>
            <Card style={{padding:0,overflow:"hidden"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{background:"#F9FAFB"}}>
                  {["Request","Job ref","Site","Trade","Items","Status","Created","Action"].map(h=>(
                    <th key={h} style={{padding:"12px 16px",textAlign:"left",fontSize:12,fontWeight:500,color:"#6B7280"}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>{requests.map(r=>{const sc=STATUS[r.status];return(
                  <tr key={r.id} style={{borderTop:"1px solid #F3F4F6"}}>
                    <td style={{padding:"13px 16px",fontSize:13,fontWeight:500,fontFamily:"'DM Mono',monospace",color:"#2563EB"}}>{r.id}</td>
                    <td style={{padding:"13px 16px",fontSize:13}}>{r.jobRef}</td>
                    <td style={{padding:"13px 16px",fontSize:13,color:"#6B7280"}}>{r.site}</td>
                    <td style={{padding:"13px 16px",fontSize:13}}>{r.trade}</td>
                    <td style={{padding:"13px 16px",fontSize:13}}>{r.items.length}</td>
                    <td style={{padding:"13px 16px"}}><Badge bg={sc.bg} text={sc.text}>{sc.label}</Badge></td>
                    <td style={{padding:"13px 16px",fontSize:12,color:"#9CA3AF"}}>{r.created}</td>
                    <td style={{padding:"13px 16px"}}>
                      <button onClick={()=>{setActiveReq(r);setView("quotes");}} style={{fontSize:12,color:"#2563EB",background:"none",border:"none",cursor:"pointer",fontWeight:500}}>View →</button>
                    </td>
                  </tr>
                )})}</tbody>
              </table>
            </Card>
          </div>
        )}

        {/* ══ SETTINGS ══ */}
        {view==="settings"&&(
          <div>
            <div style={{marginBottom:24}}>
              <h1 style={{fontSize:26,fontWeight:600,letterSpacing:"-0.5px",margin:0}}>Settings</h1>
              <p style={{fontSize:14,color:"#6B7280",marginTop:4}}>Configure your company and email sending</p>
            </div>
            <Card style={{marginBottom:20}}>
              <div style={{fontSize:14,fontWeight:500,marginBottom:16}}>Company details</div>
              <div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                  <div>
                    <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Company name (appears on POs)</label>
                    <input value={sForm.company||""} onChange={e=>setSForm(p=>({...p,company:e.target.value}))} placeholder="e.g. Initial Mechanical Ltd" style={{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,outline:"none"}}/>
                  </div>
                  <div>
                    <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Your name (appears on emails)</label>
                    <input value={sForm.contactName||""} onChange={e=>setSForm(p=>({...p,contactName:e.target.value}))} placeholder="e.g. Andy Smith" style={{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,outline:"none"}}/>
                  </div>
                </div>
              </div>
            </Card>

            <Card style={{marginBottom:20}}>
              <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>AI key — OpenRouter (free, no credit card)</div>
              <p style={{fontSize:13,color:"#6B7280",marginTop:4,marginBottom:16}}>OpenRouter gives you free AI access. No credit card. Takes 2 minutes.</p>
              <div style={{background:"#F8F7F4",border:"1px solid #E5E7EB",borderRadius:8,padding:"16px 18px",marginBottom:16,fontSize:13,color:"#374151",lineHeight:2}}>
                <strong>Setup (2 minutes, completely free):</strong><br/>
                1. Go to <a href="https://openrouter.ai/signup" target="_blank" rel="noreferrer" style={{color:"#2563EB"}}>openrouter.ai/signup</a> — sign up free, no card needed<br/>
                2. Click your avatar → <strong>Keys</strong> → <strong>Create key</strong> — copy it<br/>
                3. Paste it below and save — AI features work immediately<br/>
                4. Free tier uses Gemini Flash which is excellent for this use case<br/>
                <span style={{color:"#9CA3AF",fontSize:12}}>Key stored only in your browser. Never sent anywhere except OpenRouter.</span>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>OpenRouter API key</label>
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
              <div style={{background:"#F8F7F4",border:"1px solid #E5E7EB",borderRadius:8,padding:"16px 18px",marginBottom:16,fontSize:13,color:"#374151",lineHeight:2}}>
                <strong>Setup (2 minutes, completely free):</strong><br/>
                1. Go to <a href="https://resend.com" target="_blank" rel="noreferrer" style={{color:"#2563EB"}}>resend.com</a> → log in<br/>
                2. Click <strong>API Keys</strong> → <strong>Create API Key</strong> → Full Access → copy it<br/>
                3. Paste below. Use <code style={{background:"#E5E7EB",padding:"1px 6px",borderRadius:4,fontSize:12}}>onboarding@resend.dev</code> as From address for now<br/>
                4. To send to any supplier email, add your domain under <strong>Domains</strong> in Resend (free, 5 mins)
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                <div>
                  <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>Resend API key</label>
                  <input type="password" value={sForm.resendKey||""} onChange={e=>setSForm(p=>({...p,resendKey:e.target.value}))} placeholder="re_xxxxxxxxxxxxxxxxxxxxxxxx" style={{width:"100%",padding:"9px 12px",border:`1px solid ${sForm.resendKey?"#86EFAC":"#E5E7EB"}`,borderRadius:8,fontSize:13,outline:"none",fontFamily:"monospace"}}/>
                  {sForm.resendKey&&<div style={{fontSize:11,color:"#059669",marginTop:4}}>✓ Key entered</div>}
                </div>
                <div>
                  <label style={{fontSize:12,fontWeight:500,color:"#374151",display:"block",marginBottom:6}}>From email address</label>
                  <input value={sForm.fromEmail||""} onChange={e=>setSForm(p=>({...p,fromEmail:e.target.value}))} placeholder="onboarding@resend.dev" style={{width:"100%",padding:"9px 12px",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,outline:"none"}}/>
                  <div style={{fontSize:11,color:"#9CA3AF",marginTop:4}}>Use onboarding@resend.dev for now. Add your own domain in Resend later.</div>
                </div>
              </div>
            </Card>

            <div style={{display:"flex",gap:10}}>
              <Btn onClick={()=>{saveSettings(sForm);showToast("Settings saved");}}>Save settings</Btn>
              <Btn outline onClick={()=>setSForm({company:"",contactName:"",fromEmail:"",resendKey:"",openRouterKey:"",...settings})}>Reset</Btn>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
