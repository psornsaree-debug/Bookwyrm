import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Camera, Plus, Search, X, Check, BookOpen, Trash2, Loader2,
  Library, Sparkles, AlertTriangle, ChevronRight, Pencil, BookMarked,
  Cloud, Download, Upload, ClipboardCopy, CheckCircle2, BarChart3, LayoutGrid, PawPrint,
  Fingerprint, LogOut, UserPlus, Lock, ArrowLeft,
} from "lucide-react";
import { auth, db } from "./firebase";
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
} from "firebase/auth";
import { collection, doc, onSnapshot, setDoc, deleteDoc } from "firebase/firestore";

/* ------------------------------------------------------------------ */
/*  storage wrapper — uses persistent window.storage, falls back to RAM */
/* ------------------------------------------------------------------ */
const mem = new Map();
const store = {
  async get(key) {
    try {
      if (window.storage) {
        const r = await window.storage.get(key);
        return r ? r.value : null;
      }
    } catch (e) { /* key missing -> fall through */ }
    try { const v = localStorage.getItem(key); if (v !== null) return v; } catch (e) {}
    return mem.has(key) ? mem.get(key) : null;
  },
  async set(key, value) {
    if (window.storage) {
      const r = await window.storage.set(key, value);
      if (!r) throw new Error("set failed");
      return r;
    }
    try { localStorage.setItem(key, value); } catch (e) { mem.set(key, value); throw e; }
    mem.set(key, value);
    return { key, value };
  },
};

// On the public web (no Claude runtime) the AI features use the user's own API key.
function getApiKey() { try { return localStorage.getItem("anthropic_key") || ""; } catch (e) { return ""; } }

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */
const SPINES = ["#5B4BF5", "#FF6B4A", "#10B981", "#F59E0B", "#EC4899", "#0EA5E9", "#8B5CF6"];
function spineColor(seed = "") {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return SPINES[h % SPINES.length];
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const STATUS = {
  unread:  { label: "ดอง",       full: "ยังไม่อ่าน", color: "var(--amber)", soft: "var(--amber-soft)" },
  reading: { label: "กำลังอ่าน", full: "กำลังอ่าน",  color: "var(--green)", soft: "var(--green-soft)" },
  done:    { label: "อ่านจบ",     full: "อ่านจบแล้ว", color: "var(--slate)", soft: "var(--slate-soft)" },
};

// resize an image file -> { dataUrl, base64 } at target max width
function resizeImage(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL("image/jpeg", quality);
      URL.revokeObjectURL(url);
      resolve({ dataUrl, base64: dataUrl.split(",")[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img load")); };
    img.src = url;
  });
}

async function callClaude(body) {
  const headers = { "Content-Type": "application/json" };
  // Inside Claude's artifact runtime, auth is handled automatically (no key).
  // On the public web, use the user's own Anthropic key via direct browser access.
  if (!window.storage) {
    const key = getApiKey();
    if (!key) throw new Error("no-key");
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no json");
  return JSON.parse(clean.slice(start, end + 1));
}

const CATS = ["มังงะ", "นิยาย", "ไลท์โนเวล", "การ์ตูน", "วรรณกรรม", "พัฒนาตัวเอง", "ธุรกิจ", "ความรู้"];

function CategoryPicker({ value, set, commit }) {
  return (
    <>
      <div className="cat-chips">
        {CATS.map((c) => (
          <button key={c} className={"cat-chip" + (value === c ? " on" : "")}
            onClick={() => { const v = value === c ? "" : c; set(v); commit(v); }}>{c}</button>
        ))}
      </div>
      <input className="cat-input" value={value} placeholder="หรือพิมพ์หมวดเอง…"
        onChange={(e) => set(e.target.value)} onBlur={() => commit(value)} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  auth helpers + login                                               */
/* ------------------------------------------------------------------ */
const BIO_OK = typeof window !== "undefined" && !!window.PublicKeyCredential && !!(navigator.credentials);
const AVATARS = ["🐲", "📚", "🦊", "🐯", "🐱", "🦉", "🐧", "🐨", "🦄", "🐢"];

function useIsDesktop() {
  const q = "(min-width: 900px)";
  const [d, setD] = useState(typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setD(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return d;
}

async function hashPin(pin) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return "plain:" + pin; }
}
const randBytes = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function bioRegister(id, name) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: randBytes(32),
    rp: { name: "ชั้นหนังสือ" },
    user: { id: new TextEncoder().encode(id), name, displayName: name },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
    timeout: 60000,
  } });
  return toB64(cred.rawId);
}
async function bioVerify(credId) {
  await navigator.credentials.get({ publicKey: {
    challenge: randBytes(32),
    allowCredentials: credId ? [{ type: "public-key", id: fromB64(credId) }] : [],
    userVerification: "required",
    timeout: 60000,
  } });
  return true;
}

function AuthScreen() {
  const [mode, setMode] = useState("in"); // "in" = sign in, "up" = sign up
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setErr("");
    if (!email.trim() || pw.length < 6) { setErr("ใส่อีเมล และรหัสผ่านอย่างน้อย 6 ตัว"); return; }
    setBusy(true);
    try {
      if (mode === "up") await createUserWithEmailAndPassword(auth, email.trim(), pw);
      else await signInWithEmailAndPassword(auth, email.trim(), pw);
      // onAuthStateChanged in App will switch the screen automatically
    } catch (e) {
      const m = (e && e.code) || "";
      setErr(
        m.includes("invalid-credential") || m.includes("wrong-password") || m.includes("user-not-found") ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง" :
        m.includes("email-already-in-use") ? "อีเมลนี้มีบัญชีอยู่แล้ว ลองเข้าสู่ระบบ" :
        m.includes("invalid-email") ? "รูปแบบอีเมลไม่ถูกต้อง" :
        m.includes("weak-password") ? "รหัสผ่านอ่อนเกินไป (อย่างน้อย 6 ตัว)" :
        m.includes("network") ? "เชื่อมต่ออินเทอร์เน็ตไม่ได้" :
        "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง"
      );
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-logo"><BookMarked size={22} /> ชั้นหนังสือ</div>
        <div className="login-sub">{mode === "up" ? "สร้างบัญชีเพื่อซิงก์ข้อมูลข้ามทุกเครื่อง" : "เข้าสู่ระบบเพื่อเปิดชั้นหนังสือของคุณ"}</div>
        <input className="login-input" type="email" value={email} placeholder="อีเมล" onChange={(e) => setEmail(e.target.value)} />
        <input className="login-input" type="password" value={pw} placeholder="รหัสผ่าน (อย่างน้อย 6 ตัว)"
          onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <p className="hint" style={{ color: "var(--amber)", margin: "-4px 0 12px" }}>{err}</p>}
        <button className="btn-primary big" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
          {mode === "up" ? "สมัครและเข้าใช้งาน" : "เข้าสู่ระบบ"}
        </button>
        <button className="login-addbtn" style={{ marginTop: 12 }} onClick={() => { setMode((m) => (m === "up" ? "in" : "up")); setErr(""); }}>
          {mode === "up" ? "มีบัญชีอยู่แล้ว? เข้าสู่ระบบ" : "ยังไม่มีบัญชี? สมัครใหม่"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [tab, setTab] = useState("library");
  const [toast, setToast] = useState(null);
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  const isDesktop = useIsDesktop();

  // watch auth state
  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u || null)), []);

  const flash = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  };

  // live-subscribe to this user's books in Firestore (syncs across devices)
  useEffect(() => {
    if (!user) { setBooks([]); setLoading(false); return; }
    setLoading(true);
    const col = collection(db, "users", user.uid, "books");
    const unsub = onSnapshot(col,
      (snap) => {
        const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        setBooks(arr); setLoading(false);
      },
      () => { setLoading(false); flash("โหลดข้อมูลไม่สำเร็จ — เช็คอินเทอร์เน็ต/การตั้งค่า Firebase", "warn"); }
    );
    return unsub;
  }, [user]);

  // strip id + undefined fields (Firestore rejects undefined)
  const clean = (o) => { const x = { ...o }; delete x.id; Object.keys(x).forEach((k) => x[k] === undefined && delete x[k]); return x; };

  const addBook = async (b) => {
    if (!user) return;
    try { await setDoc(doc(db, "users", user.uid, "books", uid()), { ...clean(b), addedAt: Date.now() }); flash("เพิ่มเข้าคลังแล้ว 📚"); }
    catch (e) { flash("บันทึกไม่สำเร็จ", "warn"); }
  };
  const updateBook = async (id, patch) => {
    if (!user) return;
    try { await setDoc(doc(db, "users", user.uid, "books", id), clean(patch), { merge: true }); }
    catch (e) { flash("บันทึกไม่สำเร็จ", "warn"); }
  };
  const deleteBook = async (id) => {
    if (!user) return;
    try { await deleteDoc(doc(db, "users", user.uid, "books", id)); setDetailId(null); flash("ลบออกจากคลังแล้ว"); }
    catch (e) { flash("ลบไม่สำเร็จ", "warn"); }
  };
  const importBooks = async (incoming) => {
    if (!user) return;
    const existing = new Set(books.map((b) => b.id));
    let n = 0;
    for (const b of incoming.filter((x) => x && x.title)) {
      const id = (b.id && !existing.has(b.id)) ? b.id : uid();
      if (existing.has(id)) continue;
      try { await setDoc(doc(db, "users", user.uid, "books", id), { ...clean(b), addedAt: b.addedAt || Date.now() }); existing.add(id); n++; } catch (e) {}
    }
    if (n === 0) flash("ไม่มีเล่มใหม่ให้เพิ่ม (อาจซ้ำกับที่มีอยู่)", "warn");
    else { flash(`นำเข้า ${n} เล่มแล้ว`); setDataOpen(false); }
  };
  const logout = () => { signOut(auth); setTab("library"); setQuery(""); setFilter("all"); };

  const counts = useMemo(() => {
    const c = { all: books.length, unread: 0, reading: 0, done: 0 };
    books.forEach((b) => { c[b.status] = (c[b.status] || 0) + 1; });
    return c;
  }, [books]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return books.filter((b) => {
      if (filter !== "all" && b.status !== filter) return false;
      if (!q) return true;
      return [b.title, b.author, b.series].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [books, query, filter]);

  const detail = books.find((b) => b.id === detailId) || null;
  const toggleFilter = (k) => setFilter((f) => (f === k ? "all" : k));
  const title = tab === "stats" ? "มังกรของฉัน" : tab === "collection" ? "คอลเลกชัน" : "ชั้นหนังสือ";
  const NAV = [["library", Library, "คลัง"], ["collection", LayoutGrid, "คอลเลกชัน"], ["stats", PawPrint, "มังกร"]];
  const avatarChar = user && user.email ? user.email[0].toUpperCase() : "?";

  const libraryBody = (
    <>
      <div className="stat-strip">
        {[["unread", "ดอง", "--amber"], ["reading", "กำลังอ่าน", "--green"], ["done", "อ่านจบ", "--slate"]].map(([k, l, c]) => (
          <button key={k} className={"stat-card" + (filter === k ? " on" : "")} onClick={() => toggleFilter(k)}>
            <span className="stat-n" style={{ color: `var(${c})` }}>{counts[k] || 0}</span>
            <span className="stat-l">{l}</span>
          </button>
        ))}
      </div>
      <div className="search">
        <Search size={17} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="เล่มนี้ซื้อแล้วยัง? พิมพ์ชื่อดู…" />
        {query && <button onClick={() => setQuery("")} aria-label="ล้าง"><X size={16} /></button>}
      </div>
      {filter !== "all" && (
        <div className="filter-tag">
          แสดงเฉพาะ: <b>{STATUS[filter].full}</b>
          <button onClick={() => setFilter("all")}><X size={13} /></button>
        </div>
      )}
      <div className="grid">
        {loading ? (
          <div className="empty"><Loader2 className="spin" /> กำลังเปิดคลัง…</div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <BookOpen size={34} strokeWidth={1.4} />
            {books.length === 0 ? (
              <>
                <p>คลังยังว่างอยู่</p>
                <button className="btn-primary" onClick={() => setAddOpen(true)}><Camera size={17} /> เพิ่มเล่มแรก</button>
              </>
            ) : (<p>ไม่พบเล่มที่ตรงกับที่ค้นหา</p>)}
          </div>
        ) : (
          visible.map((b) => <BookCard key={b.id} book={b} onClick={() => setDetailId(b.id)} />)
        )}
      </div>
    </>
  );

  const body = tab === "stats"
    ? <StatsView counts={counts} books={books} onOpenData={() => setDataOpen(true)} onPick={(k) => { setFilter(k); setTab("library"); }} />
    : tab === "collection"
      ? <CollectionScreen books={books} loading={loading} onOpen={(id) => setDetailId(id)} onAdd={() => setAddOpen(true)} />
      : libraryBody;

  return (
    <div className={"root " + (isDesktop ? "desktop" : "mobile")}>
      <style>{CSS}</style>

      {user === undefined ? (
        <div className="splash"><Loader2 className="spin" size={28} /></div>
      ) : !user ? (
        <AuthScreen />
      ) : isDesktop ? (
        /* ---------- DESKTOP ---------- */
        <div className="dshell desktop">
          <aside className="sidebar">
            <div className="side-brand"><BookMarked size={22} /> ชั้นหนังสือ</div>
            <button className="side-profile" onClick={logout}>
              <span className="acct-ava">{avatarChar}</span>
              <div><b className="acct-name">{user.email}</b><small>ออกจากระบบ</small></div>
            </button>
            <nav className="side-nav">
              {NAV.map(([k, Icon, label]) => (
                <button key={k} className={"side-item" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
                  <Icon size={20} /><span>{label}</span>
                </button>
              ))}
            </nav>
            <button className="side-add" onClick={() => setAddOpen(true)}><Plus size={18} /> เพิ่มหนังสือ</button>
            <div className="side-foot">
              <button className="side-link" onClick={() => setDataOpen(true)}><Cloud size={18} /> สำรอง & ตั้งค่า</button>
              <button className="side-link" onClick={logout}><LogOut size={18} /> ออกจากระบบ</button>
            </div>
          </aside>
          <main className="dmain desktop">
            <div className="dmain-head"><h1>{title}</h1></div>
            {body}
          </main>
        </div>
      ) : (
        /* ---------- MOBILE ---------- */
        <div className="app">
          <div className="appbar">
            <div className="brand"><BookMarked size={21} strokeWidth={2.2} /><span>{title}</span></div>
            <div className="hd-actions">
              <button className="btn-icon ava-btn" onClick={logout} aria-label="ออกจากระบบ">{avatarChar}</button>
              <button className="btn-icon" onClick={() => setDataOpen(true)} aria-label="สำรอง/ตั้งค่า"><Cloud size={19} /></button>
            </div>
          </div>
          <main className="screen">{body}</main>
          <nav className="tabbar">
            <button className={"tab" + (tab === "library" ? " on" : "")} onClick={() => setTab("library")}><Library size={22} /><span>คลัง</span></button>
            <button className={"tab" + (tab === "collection" ? " on" : "")} onClick={() => setTab("collection")}><LayoutGrid size={22} /><span>คอลเลกชัน</span></button>
            <button className="tab-add" onClick={() => setAddOpen(true)} aria-label="เพิ่มหนังสือ"><Plus size={26} strokeWidth={2.6} /></button>
            <button className={"tab" + (tab === "stats" ? " on" : "")} onClick={() => setTab("stats")}><PawPrint size={22} /><span>มังกร</span></button>
          </nav>
        </div>
      )}

      {user && addOpen && (
        <AddSheet books={books} onClose={() => setAddOpen(false)} onSave={(b) => { addBook(b); setAddOpen(false); }} />
      )}
      {user && detail && (
        <DetailSheet book={detail} onClose={() => setDetailId(null)} onUpdate={(patch) => updateBook(detail.id, patch)} onDelete={() => deleteBook(detail.id)} />
      )}
      {user && dataOpen && (
        <DataSheet books={books} onClose={() => setDataOpen(false)} onImport={importBooks} flash={flash} />
      )}

      {toast && <div className={"toast " + toast.type}>{toast.msg}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dragon pet — evolves with the collection                           */
/* ------------------------------------------------------------------ */
const DPAL = {
  baby:        { main: "#A99BFF", dark: "#8B7BF0", belly: "#ECE8FF", horn: "#F4C04E", scale: 0.82, mood: "baby" },
  teen_good:   { main: "#34C796", dark: "#1FA87A", belly: "#DFF6ED", horn: "#F4C04E", scale: 0.96, mood: "good" },
  teen_bad:    { main: "#FF8A5C", dark: "#F26A3A", belly: "#FFE3D5", horn: "#E8B23E", scale: 0.96, mood: "smug" },
  worker_good: { main: "#6D5BFF", dark: "#5343E0", belly: "#E7E3FF", horn: "#FFD658", scale: 1.0,  mood: "good" },
  worker_bad:  { main: "#9AA0AD", dark: "#7E8492", belly: "#E9EBEF", horn: "#B9842F", scale: 1.0,  mood: "tired" },
  legend_good: { main: "#7C5CFF", dark: "#5E3FE6", belly: "#F1E9FF", horn: "#FFD658", scale: 1.08, mood: "serene" },
  legend_bad:  { main: "#8C93A6", dark: "#6E7486", belly: "#ECEEF3", horn: "#C9A24A", scale: 1.05, mood: "elder" },
};
const DMETA = {
  baby:        { stage: "แรกเกิด",  name: "มังกรน้อย",              desc: "เพิ่งฟักออกจากไข่ พร้อมเติบโตไปกับกองหนังสือของคุณ" },
  teen_good:   { stage: "วัยรุ่น",   name: "มังกรวัยรุ่นคงแก่เรียน",   desc: "ขยันอ่านจนเป็นหนอนหนังสือตัวจริง เก่งมาก!" },
  teen_bad:    { stage: "วัยรุ่น",   name: "มังกรวัยรุ่นเสเพล",        desc: "ดองเยอะกว่าอ่าน เลยเอาแต่ชิลล์… ลองอ่านให้จบบ้างนะ" },
  worker_good: { stage: "วัยทำงาน", name: "ท่านประธานมังกร",          desc: "อ่านจบเป็นกอบเป็นกำ ผงาดขึ้นเป็นประธานบริษัท!" },
  worker_bad:  { stage: "วัยทำงาน", name: "มังกรกองดองท่วม",          desc: "ดองสุมจนเสื้อผ้าขาดวิ่น รีบสะสางหน่อยน้า" },
  legend_good: { stage: "ตำนาน",    name: "เทพเจ้ามังกร",             desc: "ทั้งสะสมทั้งอ่านจบ ก้าวสู่เทพเจ้ามังกรผู้รอบรู้ ✨" },
  legend_bad:  { stage: "ตำนาน",    name: "ผู้เฒ่ามังกร",             desc: "สะสมจนเป็นตำนาน แต่ดองมหาศาล กลายเป็นผู้เฒ่าเฝ้ากองดอง" },
};

function getDragon(books) {
  const total = books.length;
  const unread = books.filter((b) => b.status === "unread").length;
  const done = books.filter((b) => b.status === "done").length;
  const positive = done >= unread;
  let stage, k, prevAt = 0, nextAt = 20, nextName = "มังกรวัยรุ่น";
  if (total >= 1000) { stage = "legend"; k = positive ? "legend_good" : "legend_bad"; prevAt = 1000; nextAt = null; nextName = null; }
  else if (total >= 100) { stage = "worker"; k = positive ? "worker_good" : "worker_bad"; prevAt = 100; nextAt = 1000; nextName = "มังกรในตำนาน"; }
  else if (total >= 20) { stage = "teen"; k = positive ? "teen_good" : "teen_bad"; prevAt = 20; nextAt = 100; nextName = "มังกรวัยทำงาน"; }
  else { stage = "baby"; k = "baby"; prevAt = 0; nextAt = 20; nextName = "มังกรวัยรุ่น"; }
  const pct = nextAt ? Math.min(100, Math.round(((total - prevAt) / (nextAt - prevAt)) * 100)) : 100;
  return { total, unread, done, k, ...DMETA[k], nextAt, nextName, pct };
}

function dFace(mood) {
  if (mood === "baby") return (
    <g>
      <circle cx="83" cy="111" r="9" fill="#2B2740" /><circle cx="86" cy="108" r="3" fill="#fff" />
      <circle cx="117" cy="111" r="9" fill="#2B2740" /><circle cx="120" cy="108" r="3" fill="#fff" />
      <circle cx="70" cy="126" r="6" fill="#FF9AA2" opacity="0.55" />
      <circle cx="130" cy="126" r="6" fill="#FF9AA2" opacity="0.55" />
      <path d="M92 130 Q100 137 108 130" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
    </g>
  );
  if (mood === "good") return (
    <g>
      <circle cx="84" cy="110" r="7" fill="#2B2740" /><circle cx="86" cy="108" r="2.2" fill="#fff" />
      <circle cx="116" cy="110" r="7" fill="#2B2740" /><circle cx="118" cy="108" r="2.2" fill="#fff" />
      <path d="M90 129 Q100 139 110 129" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
    </g>
  );
  if (mood === "smug") return (
    <g>
      <circle cx="84" cy="112" r="6.5" fill="#2B2740" /><circle cx="116" cy="112" r="6.5" fill="#2B2740" />
      <path d="M76 106 q8 -5 16 0" stroke="#2B2740" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <path d="M108 106 q8 -5 16 0" stroke="#2B2740" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <path d="M90 132 Q100 137 112 127" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
    </g>
  );
  if (mood === "tired") return (
    <g>
      <path d="M77 112 Q84 118 91 112" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M109 112 Q116 118 123 112" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M91 134 Q100 129 109 134" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M127 96 q5 9 0 13 q-5 -4 0 -13 Z" fill="#7CC5FF" />
    </g>
  );
  if (mood === "serene") return (
    <g>
      <path d="M77 111 Q84 104 91 111" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M109 111 Q116 104 123 111" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M91 130 Q100 137 109 130" stroke="#2B2740" strokeWidth="3" fill="none" strokeLinecap="round" />
    </g>
  );
  // elder
  return (
    <g>
      <circle cx="85" cy="111" r="4.5" fill="#2B2740" /><circle cx="115" cy="111" r="4.5" fill="#2B2740" />
      <path d="M74 101 q11 -5 20 1" stroke="#EDEFF2" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M106 102 q9 -6 20 -1" stroke="#EDEFF2" strokeWidth="5" fill="none" strokeLinecap="round" />
    </g>
  );
}

function dAcc(k, P) {
  switch (k) {
    case "baby": return (
      <g>
        <path d="M76 62 q24 -16 48 0 l-5 7 q-6 -5 -10 0 q-6 -6 -12 0 q-6 -5 -11 0 Z" fill="#FFF7E8" stroke={P.dark} strokeWidth="2" strokeLinejoin="round" />
        <path d="M150 70 l2 8 l8 2 l-8 2 l-2 8 l-2 -8 l-8 -2 l8 -2 Z" fill="#FFD658" />
        <path d="M44 96 l1.5 6 l6 1.5 l-6 1.5 l-1.5 6 l-1.5 -6 l-6 -1.5 l6 -1.5 Z" fill="#FFD658" />
      </g>
    );
    case "teen_good": return (
      <g>
        <g stroke="#34313F" strokeWidth="2.6" fill="none"><circle cx="84" cy="110" r="11" /><circle cx="116" cy="110" r="11" /><path d="M95 110 h10" /></g>
        <g transform="rotate(-14 150 132)"><rect x="139" y="123" width="22" height="17" rx="2" fill="#2E9E76" /><rect x="139" y="123" width="6" height="17" rx="1" fill="#1C7E5C" /></g>
      </g>
    );
    case "teen_bad": return (
      <g>
        <path d="M70 64 q30 -22 60 0 l0 7 q-30 -15 -60 0 Z" fill="#FF4D7D" />
        <rect x="56" y="62" width="16" height="10" rx="4" fill="#FF4D7D" />
        <circle cx="100" cy="46" r="3.5" fill="#FF4D7D" />
      </g>
    );
    case "worker_good": return (
      <g>
        <path d="M84 150 l16 12 l16 -12 l0 9 l-16 9 l-16 -9 Z" fill="#FFFFFF" />
        <path d="M72 150 l14 5 l-3 26 Z" fill="#2C2E45" /><path d="M128 150 l-14 5 l3 26 Z" fill="#2C2E45" />
        <path d="M100 160 l-5 7 l5 18 l5 -18 Z" fill="#C0392B" />
        <g transform="rotate(-6 158 168)"><rect x="148" y="160" width="24" height="17" rx="2.5" fill="#7A5230" /><rect x="156" y="156" width="8" height="6" rx="2" fill="none" stroke="#7A5230" strokeWidth="2.5" /></g>
      </g>
    );
    case "worker_bad": return (
      <g>
        <path d="M58 148 l9 5 l-3 9 l-9 -3 Z" fill={P.dark} opacity="0.55" />
        <path d="M138 150 l8 6 l-5 8 l-7 -5 Z" fill={P.dark} opacity="0.55" />
        <g transform="rotate(18 120 116)"><rect x="111" y="112" width="18" height="8" rx="2" fill="#F4D38B" /><path d="M120 112 v8 M115 116 h10" stroke="#D9B262" strokeWidth="1.5" /></g>
        <path d="M92 145 h16 M100 137 v16" stroke={P.dark} strokeWidth="2" opacity="0.5" />
      </g>
    );
    case "legend_good": return (
      <g>
        <ellipse cx="100" cy="50" rx="33" ry="9" fill="none" stroke="#FFD658" strokeWidth="5" />
        <path d="M40 70 l2 7 l7 2 l-7 2 l-2 7 l-2 -7 l-7 -2 l7 -2 Z" fill="#FFD658" />
        <path d="M162 80 l2 7 l7 2 l-7 2 l-2 7 l-2 -7 l-7 -2 l7 -2 Z" fill="#FFD658" />
        <path d="M150 132 l1.5 5 l5 1.5 l-5 1.5 l-1.5 5 l-1.5 -5 l-5 -1.5 l5 -1.5 Z" fill="#FFD658" />
      </g>
    );
    case "legend_bad": return (
      <g>
        <path d="M82 126 Q100 182 118 126 Q116 152 100 158 Q84 152 82 126 Z" fill="#EEF0F3" stroke="#D2D7DF" strokeWidth="1.5" />
        <line x1="151" y1="96" x2="159" y2="188" stroke="#8A6A45" strokeWidth="5" strokeLinecap="round" />
        <circle cx="150" cy="92" r="8" fill="#C9A24A" />
      </g>
    );
    default: return null;
  }
}

function Dragon({ k, size = 172 }) {
  const P = DPAL[k] || DPAL.baby;
  return (
    <svg viewBox="0 0 200 205" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      <g transform={`translate(100 108) scale(${P.scale}) translate(-100 -108)`}>
        {k === "legend_good" && <circle cx="100" cy="108" r="94" fill="#FFE9A8" opacity="0.5" />}
        {(k === "legend_good" || k === "legend_bad") && <circle cx="100" cy="108" r="82" fill={P.main} opacity="0.1" />}
        <g fill={P.dark}>
          <path d="M66 96 Q34 68 26 96 Q44 104 62 116 Z" />
          <path d="M134 96 Q166 68 174 96 Q156 104 138 116 Z" />
        </g>
        <path d="M132 162 Q176 164 170 126 Q168 116 159 120 Q166 146 134 150 Z" fill={P.main} />
        <path d="M165 122 l12 -9 l3 13 l-13 4 Z" fill={P.horn} />
        <ellipse cx="100" cy="120" rx="52" ry="56" fill={P.main} />
        <ellipse cx="100" cy="138" rx="28" ry="30" fill={P.belly} />
        <ellipse cx="55" cy="126" rx="11" ry="15" fill={P.main} transform="rotate(18 55 126)" />
        <ellipse cx="145" cy="126" rx="11" ry="15" fill={P.main} transform="rotate(-18 145 126)" />
        <ellipse cx="83" cy="171" rx="16" ry="11" fill={P.dark} />
        <ellipse cx="117" cy="171" rx="16" ry="11" fill={P.dark} />
        <path d="M80 72 L74 50 L90 66 Z" fill={P.horn} />
        <path d="M120 72 L126 50 L110 66 Z" fill={P.horn} />
        {dFace(P.mood)}
        {dAcc(k, P)}
      </g>
    </svg>
  );
}

function DragonHero({ books }) {
  const d = getDragon(books);
  return (
    <div className="pet" data-k={d.k}>
      <div className="pet-stage">ระดับ {d.stage}</div>
      <div className="pet-art"><Dragon k={d.k} /></div>
      <div className="pet-name">{d.name}</div>
      <div className="pet-desc">{d.desc}</div>
      <div className="pet-meta">มี {d.total} เล่ม · ดอง {d.unread} · อ่านจบ {d.done}</div>
      {d.nextAt ? (
        <div className="pet-prog">
          <div className="pet-prog-bar"><span style={{ width: d.pct + "%" }} /></div>
          <div className="pet-next">อีก {d.nextAt - d.total} เล่ม → ร่าง{d.nextName}</div>
        </div>
      ) : (
        <div className="pet-next gold">ปลดล็อกร่างตำนานสูงสุดแล้ว ✨</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stats / dashboard screen                                           */
/* ------------------------------------------------------------------ */
function StatsView({ counts, books, onOpenData, onPick }) {
  const total = books.length;
  const donePct = total ? Math.round((counts.done / total) * 100) : 0;
  const seriesCount = new Set(books.filter((b) => b.series).map((b) => b.series.trim().toLowerCase())).size;

  return (
    <div className="stats">
      <DragonHero books={books} />
      <div className="dong">
        <div>
          <div className="dong-num">{counts.unread}</div>
          <div className="dong-cap">เล่มที่ยัง<b>ดอง</b>อยู่ จากทั้งหมด {total} เล่ม</div>
        </div>
        <div className="dong-bar" aria-hidden>
          {total > 0 && (
            <>
              <span style={{ flex: counts.unread, background: "var(--amber)" }} />
              <span style={{ flex: counts.reading, background: "var(--green)" }} />
              <span style={{ flex: counts.done, background: "var(--slate)" }} />
            </>
          )}
        </div>
        <div className="dong-legend">
          <span><i style={{ background: "var(--amber)" }} />ดอง {counts.unread}</span>
          <span><i style={{ background: "var(--green)" }} />อ่าน {counts.reading}</span>
          <span><i style={{ background: "var(--slate)" }} />จบ {counts.done}</span>
        </div>
      </div>

      <div className="stat-grid">
        <button className="box" onClick={() => onPick("all")}>
          <BookOpen size={18} /><b>{total}</b><span>ทั้งหมด</span>
        </button>
        <button className="box" onClick={() => onPick("unread")}>
          <BookMarked size={18} style={{ color: "var(--amber)" }} /><b>{counts.unread}</b><span>ดอง</span>
        </button>
        <button className="box" onClick={() => onPick("reading")}>
          <BookOpen size={18} style={{ color: "var(--green)" }} /><b>{counts.reading}</b><span>กำลังอ่าน</span>
        </button>
        <button className="box" onClick={() => onPick("done")}>
          <CheckCircle2 size={18} style={{ color: "var(--slate)" }} /><b>{counts.done}</b><span>อ่านจบ</span>
        </button>
      </div>

      <div className="prog">
        <div className="prog-top"><span>อ่านจบไปแล้วของคลัง</span><b>{donePct}%</b></div>
        <div className="mini-bar big"><span style={{ width: donePct + "%", background: "var(--slate)" }} /></div>
      </div>

      {seriesCount > 0 && (
        <div className="prog" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Sparkles size={18} style={{ color: "var(--green)" }} />
          <span style={{ fontSize: 14 }}>กำลังตามอยู่ <b style={{ color: "var(--green)" }}>{seriesCount}</b> ชุด</span>
        </div>
      )}

      <button className="data-btn" style={{ marginTop: 4 }} onClick={onOpenData}>
        <Cloud size={17} /> สำรอง & ย้ายข้อมูล <ChevronRight size={16} style={{ marginLeft: "auto", color: "var(--ink-soft)" }} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Collection screen — gallery shelves grouped by category            */
/* ------------------------------------------------------------------ */
function CollectionScreen({ books, loading, onOpen, onAdd }) {
  const groups = useMemo(() => {
    const m = new Map();
    books.forEach((b) => {
      const k = (b.category && b.category.trim()) || "ไม่ระบุหมวด";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(b);
    });
    return [...m.entries()].sort((a, b) => {
      if (a[0] === "ไม่ระบุหมวด") return 1;
      if (b[0] === "ไม่ระบุหมวด") return -1;
      return b[1].length - a[1].length;
    });
  }, [books]);

  if (loading) return <div className="empty"><Loader2 className="spin" /> กำลังเปิดคลัง…</div>;
  if (books.length === 0) {
    return (
      <div className="empty">
        <LayoutGrid size={34} strokeWidth={1.4} />
        <p>คอลเลกชันยังว่างอยู่</p>
        <button className="btn-primary" onClick={onAdd}><Camera size={17} /> เพิ่มเล่มแรก</button>
      </div>
    );
  }

  return (
    <div className="coll">
      {groups.map(([cat, list]) => (
        <section className="shelf" key={cat}>
          <div className="shelf-head">
            <h3>{cat}</h3>
            <span>{list.length} เล่ม</span>
          </div>
          <div className="shelf-row">
            {list.map((b) => {
              const s = STATUS[b.status] || STATUS.unread;
              return (
                <button className="shelf-item" key={b.id} onClick={() => onOpen(b.id)}>
                  <div className="shelf-cover" style={{ background: b.cover ? "#000" : spineColor(b.title) }}>
                    {b.cover ? <img src={b.cover} alt="" /> : <span>{b.title}</span>}
                    <i className="shelf-dot" style={{ background: s.color }} />
                  </div>
                  <div className="shelf-title">{b.title}</div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Book card                                                          */
/* ------------------------------------------------------------------ */
function BookCard({ book, onClick }) {
  const s = STATUS[book.status] || STATUS.unread;
  const pct = book.totalPages ? Math.min(100, Math.round((book.currentPage / book.totalPages) * 100)) : 0;
  return (
    <button className="card" onClick={onClick}>
      <div className="cover" style={{ background: book.cover ? "#000" : spineColor(book.title) }}>
        {book.cover
          ? <img src={book.cover} alt="" />
          : <span className="cover-t">{book.title}</span>}
        <span className="badge" style={{ background: s.color }}>{s.label}</span>
      </div>
      <div className="card-body">
        <div className="card-title">{book.title}</div>
        {book.author && <div className="card-sub">{book.author}</div>}
        {book.series && (
          <div className="card-series">
            {book.series}{book.volume ? ` · เล่ม ${book.volume}` : ""}
          </div>
        )}
        {book.status === "reading" && book.totalPages > 0 && (
          <div className="mini-bar"><span style={{ width: pct + "%" }} /></div>
        )}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Add sheet                                                          */
/* ------------------------------------------------------------------ */
function AddSheet({ books, onClose, onSave }) {
  const [f, setF] = useState({
    title: "", author: "", series: "", volume: "", totalPages: "", status: "unread", cover: "", category: "",
  });
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState("");
  const fileRef = useRef(null);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  // duplicate detection
  const dup = useMemo(() => {
    const t = f.title.trim().toLowerCase();
    if (!t) return null;
    return books.find((b) => {
      const sameTitle = b.title.trim().toLowerCase() === t;
      const sameVol = (b.series || "").trim().toLowerCase() === f.series.trim().toLowerCase()
        && String(b.volume || "") === String(f.volume || "")
        && f.series.trim() !== "";
      return sameTitle || sameVol;
    }) || null;
  }, [f.title, f.series, f.volume, books]);

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanErr(""); setScanning(true);
    try {
      const big = await resizeImage(file, 768, 0.7);     // for AI
      const thumb = await resizeImage(file, 150, 0.5);   // stored
      set("cover", thumb.dataUrl);
      const text = await callClaude({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: big.base64 } },
            { type: "text", text:
`นี่คือรูปปกหนังสือ ช่วยอ่านข้อมูลจากปกแล้วตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นหรือ markdown:
{"title":"ชื่อเรื่อง","author":"ผู้แต่ง","series":"ชื่อชุด/ซีรีส์ถ้ามี","volume":"เลขเล่มถ้ามี","category":"หมวดหมู่"}
สำหรับ category ให้เลือกหนึ่งหมวดที่เหมาะที่สุดจาก: มังงะ, นิยาย, ไลท์โนเวล, การ์ตูน, วรรณกรรม, พัฒนาตัวเอง, ธุรกิจ, ความรู้ (ถ้าไม่เข้าพวกให้เดาคำสั้น ๆ เอง)
ถ้าข้อมูลไหนอ่านไม่ออกให้ใส่ "" รักษาภาษาตามที่ปรากฏบนปก` },
          ],
        }],
      });
      const j = parseJson(text);
      setF((p) => ({
        ...p,
        title: j.title || p.title,
        author: j.author || p.author,
        series: j.series || p.series,
        volume: j.volume ? String(j.volume) : p.volume,
        category: j.category || p.category,
      }));
    } catch (err) {
      setScanErr(err && err.message === "no-key"
        ? 'ใส่ Anthropic API key ในเมนู "สำรอง/ตั้งค่า" ก่อน เพื่อใช้สแกนปกอัตโนมัติ (หรือกรอกเอง)'
        : "อ่านปกอัตโนมัติไม่สำเร็จ ลองกรอกเองได้เลย");
    } finally {
      setScanning(false);
    }
  }

  const canSave = f.title.trim().length > 0;
  function save() {
    if (!canSave) return;
    onSave({
      title: f.title.trim(),
      author: f.author.trim(),
      series: f.series.trim(),
      volume: f.volume.trim(),
      totalPages: parseInt(f.totalPages) || 0,
      currentPage: f.status === "done" && f.totalPages ? parseInt(f.totalPages) : 0,
      status: f.status,
      cover: f.cover,
      category: f.category.trim(),
      note: "",
    });
  }

  return (
    <Sheet title="เพิ่มหนังสือ" onClose={onClose}>
      <button className="photo-zone" onClick={() => fileRef.current?.click()} disabled={scanning}>
        {scanning ? (
          <><Loader2 className="spin" size={20} /> กำลังอ่านข้อมูลจากปก…</>
        ) : f.cover ? (
          <><img className="photo-prev" src={f.cover} alt="" /> <span><Sparkles size={15} /> แตะเพื่อถ่ายใหม่</span></>
        ) : (
          <><Camera size={22} /><span>ถ่ายรูปปก แล้วให้ AI กรอกให้</span></>
        )}
      </button>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
      {scanErr && <p className="hint warn-text">{scanErr}</p>}

      {dup && (
        <div className="dup">
          <AlertTriangle size={18} />
          <div>
            <b>เล่มนี้คุณมีอยู่แล้วนะ!</b>
            <span>{dup.title}{dup.series ? ` · ${dup.series}` : ""} — สถานะ: {STATUS[dup.status].full}</span>
          </div>
        </div>
      )}

      <Field label="ชื่อเรื่อง *" value={f.title} onChange={(v) => set("title", v)} placeholder="เช่น เพื่อนซี้สุดที่รัก" />
      <Field label="ผู้แต่ง" value={f.author} onChange={(v) => set("author", v)} />
      <div className="two">
        <Field label="ชื่อชุด / ซีรีส์" value={f.series} onChange={(v) => set("series", v)} />
        <Field label="เล่มที่" value={f.volume} onChange={(v) => set("volume", v)} placeholder="3" />
      </div>
      <Field label="จำนวนหน้า" value={f.totalPages} onChange={(v) => set("totalPages", v.replace(/\D/g, ""))} placeholder="ไว้ติดตามว่าอ่านถึงไหน" />

      <label className="lbl">หมวดหมู่</label>
      <CategoryPicker value={f.category} set={(v) => set("category", v)} commit={() => {}} />

      <label className="lbl" style={{ marginTop: 4 }}>สถานะ</label>
      <div className="seg">
        {Object.entries(STATUS).map(([k, v]) => (
          <button key={k} className={"seg-b" + (f.status === k ? " on" : "")}
            style={f.status === k ? { background: v.color } : {}}
            onClick={() => set("status", k)}>{v.full}</button>
        ))}
      </div>

      <button className="btn-primary big" disabled={!canSave} onClick={save}>
        <Check size={18} /> บันทึกเข้าคลัง
      </button>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Detail sheet                                                       */
/* ------------------------------------------------------------------ */
function DetailSheet({ book, onClose, onUpdate, onDelete }) {
  const [page, setPage] = useState(String(book.currentPage || ""));
  const [cat, setCat] = useState(book.category || "");
  const [checking, setChecking] = useState(false);
  const [nextInfo, setNextInfo] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const s = STATUS[book.status];
  const pct = book.totalPages ? Math.min(100, Math.round((book.currentPage / book.totalPages) * 100)) : 0;

  function setStatus(k) {
    const patch = { status: k };
    if (k === "done" && book.totalPages) patch.currentPage = book.totalPages;
    if (k === "unread") patch.currentPage = 0;
    onUpdate(patch);
  }
  function saveProgress() {
    const p = Math.max(0, Math.min(parseInt(page) || 0, book.totalPages || 99999));
    const patch = { currentPage: p };
    if (p > 0 && book.status === "unread") patch.status = "reading";
    if (book.totalPages && p >= book.totalPages) patch.status = "done";
    onUpdate(patch);
  }

  async function checkNext() {
    setChecking(true); setNextInfo("");
    try {
      const series = book.series || book.title;
      const vol = book.volume ? `เล่ม ${book.volume}` : "เล่มล่าสุด";
      const txt = await callClaude({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `ผมมีหนังสือชุด "${series}" ${book.author ? `โดย ${book.author} ` : ""}อยู่ถึง${vol} ` +
            `ช่วยค้นเว็บแล้วบอกสั้น ๆ ว่า เล่มถัดไปออกวางขายหรือยัง ถ้าออกแล้วคือเล่มอะไร วางขายเมื่อไหร่ ` +
            `ถ้ายังไม่ออกมีกำหนดไหม ตอบเป็นภาษาไทย กระชับ 2-3 ประโยค`,
        }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      });
      setNextInfo(txt || "ไม่พบข้อมูล ลองค้นชื่อชุดอีกครั้งนะ");
    } catch (e) {
      setNextInfo("เช็คไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Sheet title="" onClose={onClose}>
      <div className="d-head">
        <div className="d-cover" style={{ background: book.cover ? "#000" : spineColor(book.title) }}>
          {book.cover ? <img src={book.cover} alt="" /> : <span>{book.title}</span>}
        </div>
        <div className="d-meta">
          <div className="d-title">{book.title}</div>
          {book.author && <div className="d-sub">{book.author}</div>}
          {book.series && <div className="d-series">{book.series}{book.volume ? ` · เล่ม ${book.volume}` : ""}</div>}
          <span className="badge inline" style={{ background: s.color }}>{s.full}</span>
        </div>
      </div>

      <label className="lbl">สถานะการอ่าน</label>
      <div className="seg">
        {Object.entries(STATUS).map(([k, v]) => (
          <button key={k} className={"seg-b" + (book.status === k ? " on" : "")}
            style={book.status === k ? { background: v.color } : {}}
            onClick={() => setStatus(k)}>{v.full}</button>
        ))}
      </div>

      <label className="lbl">หมวดหมู่</label>
      <CategoryPicker value={cat} set={setCat} commit={(v) => onUpdate({ category: (v || "").trim() })} />

      {book.totalPages > 0 && (
        <div className="prog">
          <div className="prog-top">
            <span>อ่านไปแล้ว</span>
            <b>{pct}%</b>
          </div>
          <div className="mini-bar big"><span style={{ width: pct + "%" }} /></div>
          <div className="prog-edit">
            <span>อ่านถึงหน้า</span>
            <input value={page} onChange={(e) => setPage(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
            <span>/ {book.totalPages}</span>
            <button className="btn-sm" onClick={saveProgress}>บันทึก</button>
          </div>
        </div>
      )}

      <button className="next-btn" onClick={checkNext} disabled={checking}>
        {checking ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
        เช็คว่าเล่มต่อไปออกหรือยัง
      </button>
      {nextInfo && <div className="next-info">{nextInfo}</div>}

      <div className="d-foot">
        {confirmDel ? (
          <div className="del-confirm">
            <span>ลบเล่มนี้ออกจากคลัง?</span>
            <button className="btn-sm" onClick={() => setConfirmDel(false)}>ยกเลิก</button>
            <button className="btn-sm danger" onClick={onDelete}>ลบเลย</button>
          </div>
        ) : (
          <button className="del-btn" onClick={() => setConfirmDel(true)}><Trash2 size={16} /> ลบออกจากคลัง</button>
        )}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Data / backup sheet                                                */
/* ------------------------------------------------------------------ */
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function toCSV(books) {
  const cols = ["title", "author", "series", "volume", "status", "currentPage", "totalPages"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = "ชื่อเรื่อง,ผู้แต่ง,ชุด,เล่ม,สถานะ,อ่านถึงหน้า,จำนวนหน้า";
  const rows = books.map((b) => cols.map((c) => esc(b[c])).join(","));
  return "\uFEFF" + [head, ...rows].join("\n"); // BOM so Thai opens correctly in Excel
}

function DataSheet({ books, onClose, onImport, flash }) {
  const [paste, setPaste] = useState("");
  const fileRef = useRef(null);
  const stamp = new Date().toISOString().slice(0, 10);

  const exportJson = () => download(`ชั้นหนังสือ-${stamp}.json`, JSON.stringify(books, null, 2), "application/json");
  const exportCsv = () => download(`ชั้นหนังสือ-${stamp}.csv`, toCSV(books), "text/csv;charset=utf-8");
  const copyAll = async () => {
    const text = JSON.stringify(books);
    try { await navigator.clipboard.writeText(text); flash("คัดลอกข้อมูลแล้ว"); }
    catch (e) { setPaste(text); flash("คัดลอกอัตโนมัติไม่ได้ — เลือกข้อความในกล่องแล้วคัดลอกเอง", "warn"); }
  };

  const runImport = (text) => {
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("not array");
      onImport(data);
    } catch (e) { flash("ไฟล์ไม่ถูกต้อง — ต้องเป็นไฟล์ที่ส่งออกจากแอปนี้ (.json)", "warn"); }
  };
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => runImport(String(r.result));
    r.readAsText(file);
  };

  return (
    <Sheet title="สำรอง & ย้ายข้อมูล" onClose={onClose}>
      <div className="data-note">
        <Cloud size={18} />
        <div>
          ข้อมูลของคุณ <b>ซิงก์อัตโนมัติผ่านบัญชี Claude</b> อยู่แล้ว — เปิดการ์ดนี้ด้วยบัญชีเดิม
          จะเห็นข้อมูลชุดเดียวกันทั้งบนเว็บและมือถือ ส่วนด้านล่างนี้ไว้ <b>สำรองเป็นไฟล์ของคุณเอง</b> หรือย้ายไปที่อื่น
        </div>
      </div>

      <label className="lbl">ส่งออก ({books.length} เล่ม)</label>
      <div className="data-grid">
        <button className="data-btn" onClick={exportJson}><Download size={17} /> ไฟล์ .json<span>สำรอง/นำเข้ากลับได้</span></button>
        <button className="data-btn" onClick={exportCsv}><Download size={17} /> ไฟล์ .csv<span>เปิดใน Excel / Sheets</span></button>
        <button className="data-btn" onClick={copyAll}><ClipboardCopy size={17} /> คัดลอกข้อมูล<span>วางที่อื่นได้</span></button>
      </div>

      <label className="lbl" style={{ marginTop: 18 }}>นำเข้า (เพิ่มเล่มที่ยังไม่มี)</label>
      <button className="btn-primary big" onClick={() => fileRef.current?.click()}>
        <Upload size={18} /> เลือกไฟล์ .json
      </button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} />

      <p className="hint" style={{ margin: "14px 0 6px", color: "var(--ink-soft)" }}>หรือวางข้อมูลที่คัดลอกไว้ตรงนี้:</p>
      <textarea className="data-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='[{"title":"..."}]' />
      <button className="btn-sm" style={{ width: "100%", marginTop: 8 }} disabled={!paste.trim()} onClick={() => runImport(paste)}>
        นำเข้าจากข้อความ
      </button>

      {!window.storage && (
        <div style={{ marginTop: 22, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <label className="lbl">เชื่อม AI — ใส่ Anthropic API key ของคุณ</label>
          <input className="cat-input" type="password" defaultValue={getApiKey()} placeholder="sk-ant-..."
            onChange={(e) => { try { localStorage.setItem("anthropic_key", e.target.value.trim()); } catch (_) {} }} />
          <p className="hint" style={{ color: "var(--ink-soft)", margin: "2px 0 0" }}>
            เปิดฟีเจอร์สแกนปก/เช็คเล่มต่อ คีย์เก็บในเครื่องนี้เท่านั้น (ระวัง: ใครเปิด console ในเครื่องนี้อาจเห็นได้)
          </p>
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  small shared UI                                                    */
/* ------------------------------------------------------------------ */
function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-top">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <div className="field">
      <label className="lbl">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || ""} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  styles                                                             */
/* ------------------------------------------------------------------ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Anuphan:wght@300;400;500;600;700&display=swap');

:root{
  --bg:#F4F4F7; --card:#FFFFFF; --ink:#17171C; --ink-soft:#76767F;
  --line:#ECECF0;
  --green:#5B4BF5; --green-soft:#ECEAFF;        /* primary / reading */
  --amber:#FF6B4A; --amber-soft:#FFE9E3;        /* ดอง / warnings */
  --slate:#10B981; --slate-soft:#DCF5EC;        /* done */
  --sans:'Anuphan',system-ui,-apple-system,sans-serif;
  --sh:0 2px 12px rgba(20,20,40,.05),0 1px 3px rgba(20,20,40,.04);
  --sh-lift:0 10px 30px rgba(20,20,40,.10);
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.app{font-family:var(--sans);color:var(--ink);background:var(--bg);
  height:100dvh;max-width:480px;margin:0 auto;position:relative;overflow:hidden;
  display:flex;flex-direction:column;letter-spacing:-.01em;
  box-shadow:0 0 0 1px var(--line),0 24px 60px rgba(20,20,40,.12)}

/* app shell: fixed top bar, scrolling middle, fixed bottom tabs */
.appbar{flex:none;display:flex;align-items:center;justify-content:space-between;
  padding:18px 18px 12px;background:rgba(244,244,247,.92);backdrop-filter:saturate(1.6) blur(12px);
  border-bottom:1px solid var(--line);z-index:4}
.screen{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 16px 22px}
.screen::-webkit-scrollbar{display:none}
.screen .grid{padding:0}

/* library: status quick-cards */
.stat-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:13px}
.stat-card{background:var(--card);border:1.5px solid var(--line);border-radius:16px;
  padding:13px 6px 11px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;
  box-shadow:var(--sh);transition:all .15s}
.stat-card.on{border-color:var(--ink);box-shadow:0 4px 14px rgba(20,20,40,.12)}
.stat-card:active{transform:scale(.97)}
.stat-n{font-size:25px;font-weight:700;letter-spacing:-.04em;line-height:1}
.stat-l{font-size:11.5px;color:var(--ink-soft);font-weight:500}

.filter-tag{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--ink-soft);margin-bottom:13px}
.filter-tag b{color:var(--ink);font-weight:600}
.filter-tag button{margin-left:2px;border:none;background:var(--line);color:var(--ink);
  width:22px;height:22px;border-radius:99px;display:grid;place-items:center;cursor:pointer}

/* bottom tab bar */
.tabbar{flex:none;display:flex;align-items:flex-start;justify-content:space-around;
  background:var(--card);border-top:1px solid var(--line);z-index:5;
  padding:9px 18px calc(10px + env(safe-area-inset-bottom,0px))}
.tab{flex:1;border:none;background:none;cursor:pointer;display:flex;flex-direction:column;
  align-items:center;gap:3px;color:var(--ink-soft);font-family:var(--sans);font-weight:600;padding:5px 0}
.tab span{font-size:11px}
.tab.on{color:var(--green)}
.tab-add{flex:none;width:58px;height:58px;border-radius:99px;border:none;cursor:pointer;
  background:linear-gradient(120deg,#6D5BFF,#5B4BF5);color:#fff;display:grid;place-items:center;
  box-shadow:0 8px 22px rgba(91,75,245,.5);margin-top:-24px}
.tab-add:active{transform:scale(.9)}

/* stats screen */
.stats{display:flex;flex-direction:column;gap:13px}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.box{background:var(--card);border:none;box-shadow:var(--sh);border-radius:18px;padding:17px;
  cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:7px;text-align:left}
.box b{font-size:27px;font-weight:700;letter-spacing:-.04em;line-height:1}
.box span{font-size:12.5px;color:var(--ink-soft);font-weight:500}
.box svg{color:var(--ink-soft)}
.box:active{transform:scale(.98)}
.spin{animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}

/* header */
.hd{position:sticky;top:0;z-index:5;background:rgba(244,244,247,.85);
  backdrop-filter:saturate(1.6) blur(12px);padding:16px 16px 12px;border-bottom:1px solid var(--line)}
.hd-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.hd-actions{display:flex;gap:9px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:21px;
  letter-spacing:-.02em;color:var(--ink)}
.brand svg{color:var(--green)}
.btn-icon{width:40px;height:40px;border:none;border-radius:13px;background:var(--card);
  color:var(--ink);display:grid;place-items:center;cursor:pointer;box-shadow:var(--sh)}
.btn-icon:active{transform:scale(.92)}

/* ดอง hero */
.dong{background:var(--card);border-radius:22px;padding:18px 20px;margin-bottom:13px;box-shadow:var(--sh)}
.dong-num{font-size:58px;font-weight:700;line-height:.9;letter-spacing:-.04em;
  background:linear-gradient(120deg,#FF8A4A,#FF5277);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.dong-cap{font-size:13.5px;color:var(--ink-soft);margin-top:4px;font-weight:400}
.dong-cap b{color:var(--ink);font-weight:600}
.dong-bar{display:flex;height:9px;border-radius:6px;overflow:hidden;margin:16px 0 10px;
  background:var(--line);gap:2px}
.dong-bar span{display:block;border-radius:6px}
.dong-legend{display:flex;gap:16px;font-size:12px;color:var(--ink-soft);font-weight:500}
.dong-legend span{display:flex;align-items:center;gap:6px}
.dong-legend i{width:9px;height:9px;border-radius:99px;display:block}

.search{display:flex;align-items:center;gap:9px;background:var(--card);
  border-radius:14px;padding:0 14px;margin-bottom:12px;color:var(--ink-soft);box-shadow:var(--sh)}
.search input{flex:1;border:none;background:none;outline:none;font-family:var(--sans);
  font-size:15px;color:var(--ink);padding:13px 0}
.search button{border:none;background:none;color:var(--ink-soft);cursor:pointer;display:flex}

.chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;border:none;background:var(--card);color:var(--ink-soft);box-shadow:var(--sh);
  border-radius:99px;padding:9px 15px;font-family:var(--sans);font-size:13.5px;font-weight:500;
  cursor:pointer;display:flex;align-items:center;gap:7px;transition:all .15s}
.chip.on{background:var(--green);color:#fff;box-shadow:0 4px 14px rgba(91,75,245,.35)}
.chip-n{font-size:11px;opacity:.65;font-weight:600}
.chip.on .chip-n{opacity:.85}

/* grid */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:18px 16px}
.card{text-align:left;border:none;background:none;cursor:pointer;padding:0;
  display:flex;flex-direction:column;gap:9px}
.card:active{transform:scale(.96)}
.cover{position:relative;aspect-ratio:3/4.4;border-radius:16px;overflow:hidden;
  display:grid;place-items:center;padding:16px;box-shadow:var(--sh-lift)}
.cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cover-t{font-weight:600;color:#fff;font-size:16px;line-height:1.3;text-align:center;
  letter-spacing:-.01em;text-shadow:0 1px 8px rgba(0,0,0,.25)}
.badge{position:absolute;top:9px;left:9px;color:#fff;font-size:10.5px;font-weight:600;
  padding:4px 10px;border-radius:99px;box-shadow:0 2px 6px rgba(0,0,0,.18)}
.badge.inline{position:static;display:inline-block;margin-top:9px}
.card-title{font-weight:600;font-size:15px;line-height:1.3;color:var(--ink);letter-spacing:-.015em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-sub{font-size:12.5px;color:var(--ink-soft);margin-top:2px}
.card-series{font-size:11.5px;color:var(--green);margin-top:4px;font-weight:600}
.mini-bar{height:6px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:7px}
.mini-bar.big{height:9px;margin:10px 0}
.mini-bar span{display:block;height:100%;background:var(--green);border-radius:99px}

.empty{grid-column:1/-1;text-align:center;color:var(--ink-soft);padding:72px 20px;
  display:flex;flex-direction:column;align-items:center;gap:16px}
.empty p{font-size:15px;font-weight:500}

/* fab */
.fab{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:6;
  background:linear-gradient(120deg,#6D5BFF,#5B4BF5);color:#fff;border:none;border-radius:99px;
  padding:15px 26px;font-family:var(--sans);font-weight:600;font-size:15px;cursor:pointer;
  display:flex;align-items:center;gap:9px;box-shadow:0 10px 28px rgba(91,75,245,.42);letter-spacing:-.01em}
.fab:active{transform:translateX(-50%) scale(.95)}

/* sheet */
.sheet-wrap{position:fixed;inset:0;z-index:20;background:rgba(23,23,28,.42);
  display:flex;align-items:flex-end;justify-content:center;animation:fade .2s;backdrop-filter:blur(2px)}
@keyframes fade{from{opacity:0}}
.sheet{background:var(--bg);width:100%;max-width:520px;border-radius:26px 26px 0 0;
  max-height:92vh;display:flex;flex-direction:column;animation:up .3s cubic-bezier(.2,.85,.25,1)}
@keyframes up{from{transform:translateY(100%)}}
.sheet-grip{width:42px;height:5px;border-radius:99px;background:var(--line);margin:10px auto 2px}
.sheet-top{display:flex;align-items:center;justify-content:space-between;padding:6px 18px 12px}
.sheet-top h2{font-size:20px;font-weight:700;margin:0;letter-spacing:-.02em}
.sheet-body{padding:4px 18px 30px;overflow-y:auto}

.photo-zone{width:100%;border:1.5px dashed var(--green);background:var(--green-soft);
  color:var(--green);border-radius:18px;padding:24px;font-family:var(--sans);font-size:14.5px;
  font-weight:600;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:11px;margin-bottom:14px}
.photo-zone:disabled{opacity:.7}
.photo-prev{width:76px;height:100px;object-fit:cover;border-radius:12px;box-shadow:var(--sh-lift)}
.photo-zone span{display:flex;align-items:center;gap:6px}

.dup{display:flex;gap:11px;background:var(--amber-soft);border-radius:15px;padding:13px 15px;
  margin-bottom:14px;color:#C2410C}
.dup svg{flex:none;margin-top:1px}
.dup b{display:block;font-size:14px;font-weight:600}
.dup span{display:block;font-size:12.5px;color:#9A3412;margin-top:2px}

.field{margin-bottom:14px}
.two{display:grid;grid-template-columns:2fr 1fr;gap:11px}
.lbl{display:block;font-size:12.5px;color:var(--ink-soft);font-weight:500;margin-bottom:7px}
input{font-family:var(--sans)}
.field input,.prog-edit input{width:100%;border:1.5px solid var(--line);background:var(--card);
  border-radius:13px;padding:13px 14px;font-size:15px;color:var(--ink);outline:none;transition:border .15s}
.field input:focus,.prog-edit input:focus{border-color:var(--green)}
.hint{font-size:12px;margin:-7px 0 13px}
.warn-text{color:var(--amber)}

.seg{display:flex;gap:8px;margin-bottom:18px}
.seg-b{flex:1;border:1.5px solid var(--line);background:var(--card);color:var(--ink-soft);
  border-radius:13px;padding:12px 4px;font-family:var(--sans);font-size:13.5px;font-weight:500;
  cursor:pointer;transition:all .15s}
.seg-b.on{color:#fff;border-color:transparent;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.14)}

.btn-primary{background:var(--green);color:#fff;border:none;border-radius:14px;
  padding:13px 22px;font-family:var(--sans);font-weight:600;font-size:15px;cursor:pointer;
  display:inline-flex;align-items:center;gap:8px;letter-spacing:-.01em}
.btn-primary.big{width:100%;justify-content:center;padding:16px;font-size:16px;
  box-shadow:0 8px 22px rgba(91,75,245,.34)}
.btn-primary:disabled{opacity:.4;box-shadow:none}
.btn-sm{border:1.5px solid var(--line);background:var(--card);color:var(--ink);border-radius:11px;
  padding:10px 15px;font-family:var(--sans);font-size:13.5px;font-weight:600;cursor:pointer}
.btn-sm.danger{background:#EF4444;color:#fff;border-color:#EF4444}

/* detail */
.d-head{display:flex;gap:15px;margin-bottom:22px;margin-top:4px}
.d-cover{width:100px;height:140px;flex:none;border-radius:14px;overflow:hidden;position:relative;
  display:grid;place-items:center;padding:11px;box-shadow:var(--sh-lift)}
.d-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.d-cover span{color:#fff;font-size:14px;font-weight:600;text-align:center;line-height:1.3}
.d-meta{padding-top:4px}
.d-title{font-size:22px;font-weight:700;line-height:1.18;letter-spacing:-.025em}
.d-sub{font-size:14px;color:var(--ink-soft);margin-top:4px}
.d-series{font-size:13px;color:var(--green);font-weight:600;margin-top:5px}

.prog{background:var(--card);border-radius:16px;padding:16px;margin-bottom:16px;box-shadow:var(--sh)}
.prog-top{display:flex;justify-content:space-between;align-items:center;font-size:13.5px;color:var(--ink-soft);font-weight:500}
.prog-top b{font-size:20px;color:var(--green);font-weight:700;letter-spacing:-.02em}
.prog-edit{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink-soft);margin-top:10px}
.prog-edit input{width:66px;text-align:center;padding:10px}

.next-btn{width:100%;border:1.5px solid var(--green);background:var(--green-soft);color:var(--green);
  border-radius:14px;padding:14px;font-family:var(--sans);font-weight:600;font-size:14.5px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:9px;margin-bottom:12px}
.next-btn:disabled{opacity:.6}
.next-info{background:var(--card);border-radius:14px;padding:15px;font-size:14px;line-height:1.65;
  color:var(--ink);margin-bottom:8px;box-shadow:var(--sh)}

.d-foot{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}
.del-btn{width:100%;border:none;background:none;color:#EF4444;font-family:var(--sans);font-weight:600;
  font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;padding:8px}
.del-confirm{display:flex;align-items:center;gap:9px;justify-content:center;font-size:14px;font-weight:500;flex-wrap:wrap}

.data-note{display:flex;gap:11px;background:var(--green-soft);border-radius:15px;padding:14px 15px;
  margin-bottom:18px;font-size:13px;line-height:1.6;color:#3D33B8}
.data-note svg{flex:none;margin-top:1px;color:var(--green)}
.data-note b{font-weight:600;color:var(--green)}
.data-grid{display:flex;flex-direction:column;gap:9px}
.data-btn{display:flex;align-items:center;gap:11px;width:100%;border:1.5px solid var(--line);
  background:var(--card);color:var(--ink);border-radius:13px;padding:14px 15px;font-family:var(--sans);
  font-size:14.5px;font-weight:600;cursor:pointer;text-align:left}
.data-btn span{margin-left:auto;font-size:11.5px;font-weight:400;color:var(--ink-soft)}
.data-btn:active{transform:scale(.98)}
.data-paste{width:100%;min-height:74px;border:1.5px solid var(--line);background:var(--card);
  border-radius:13px;padding:12px 13px;font-family:ui-monospace,monospace;font-size:12px;color:var(--ink);
  outline:none;resize:vertical}
.data-paste:focus{border-color:var(--green)}

/* category picker */
.cat-chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:9px}
.cat-chip{border:1.5px solid var(--line);background:var(--card);color:var(--ink-soft);
  border-radius:99px;padding:7px 13px;font-family:var(--sans);font-size:13px;font-weight:500;cursor:pointer}
.cat-chip.on{background:var(--green);color:#fff;border-color:transparent}
.cat-input{width:100%;border:1.5px solid var(--line);background:var(--card);border-radius:13px;
  padding:12px 14px;font-size:15px;color:var(--ink);outline:none;font-family:var(--sans);margin-bottom:18px}
.cat-input:focus{border-color:var(--green)}

/* collection gallery */
.coll{display:flex;flex-direction:column;gap:24px}
.shelf-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:11px}
.shelf-head h3{font-size:16px;font-weight:700;letter-spacing:-.02em;margin:0}
.shelf-head span{font-size:12px;color:var(--ink-soft);font-weight:600}
.shelf-row{display:flex;gap:13px;overflow-x:auto;padding-bottom:4px;scroll-snap-type:x proximity}
.shelf-row::-webkit-scrollbar{display:none}
.shelf-item{flex:none;width:90px;border:none;background:none;cursor:pointer;padding:0;scroll-snap-align:start}
.shelf-item:active{transform:scale(.95)}
.shelf-cover{position:relative;width:90px;aspect-ratio:3/4.4;border-radius:12px;overflow:hidden;
  display:grid;place-items:center;padding:10px;box-shadow:var(--sh-lift);margin-bottom:7px}
.shelf-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.shelf-cover span{font-size:11px;font-weight:600;color:#fff;text-align:center;line-height:1.25;
  letter-spacing:-.01em;text-shadow:0 1px 6px rgba(0,0,0,.3)}
.shelf-dot{position:absolute;top:7px;right:7px;width:10px;height:10px;border-radius:99px;
  border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.shelf-title{font-size:11.5px;font-weight:500;color:var(--ink);line-height:1.3;letter-spacing:-.01em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

/* dragon pet */
.pet{position:relative;overflow:hidden;text-align:center;border-radius:22px;padding:18px 18px 20px;
  box-shadow:var(--sh);background:radial-gradient(120% 90% at 50% -10%, #EFEAFF 0%, var(--card) 62%)}
.pet[data-k="teen_bad"],.pet[data-k="worker_bad"]{background:radial-gradient(120% 90% at 50% -10%, #FFEDE6 0%, var(--card) 62%)}
.pet[data-k="teen_good"]{background:radial-gradient(120% 90% at 50% -10%, #E4F6EE 0%, var(--card) 62%)}
.pet[data-k="legend_good"]{background:radial-gradient(120% 90% at 50% -10%, #FFF4D6 0%, #F2ECFF 62%)}
.pet[data-k="legend_bad"],.pet[data-k="worker_bad"]{background:radial-gradient(120% 90% at 50% -10%, #EEF0F4 0%, var(--card) 62%)}
.pet-stage{display:inline-block;font-size:11.5px;font-weight:700;color:var(--green);
  background:var(--card);border-radius:99px;padding:4px 12px;box-shadow:var(--sh);letter-spacing:.01em}
.pet-art{display:flex;justify-content:center;margin:4px 0 2px;animation:bob 3.4s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.pet-name{font-size:22px;font-weight:700;letter-spacing:-.025em}
.pet-desc{font-size:13px;color:var(--ink-soft);line-height:1.55;margin:6px auto 0;max-width:300px}
.pet-meta{font-size:12.5px;color:var(--ink);font-weight:600;margin-top:13px}
.pet-prog{margin-top:11px}
.pet-prog-bar{height:9px;background:#E5E0F4;border-radius:99px;overflow:hidden}
.pet-prog-bar span{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6D5BFF,#AE93FF)}
.pet-next{font-size:12px;color:var(--ink-soft);margin-top:7px;font-weight:500}
.pet-next.gold{color:#B8860B;font-weight:700;margin-top:11px}

/* splash + login */
.root{min-height:100dvh;background:var(--bg)}
.splash{height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--green)}
.login{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:radial-gradient(120% 70% at 50% 0%, #EEEAFF 0%, var(--bg) 58%)}
.login-card{position:relative;width:100%;max-width:380px;background:var(--card);border-radius:26px;
  padding:30px 26px;box-shadow:0 24px 60px rgba(20,20,40,.14);text-align:center}
.login-logo{display:flex;align-items:center;justify-content:center;gap:9px;font-weight:700;font-size:20px;
  color:var(--ink);letter-spacing:-.02em}
.login-logo svg{color:var(--green)}
.login-sub{font-size:13px;color:var(--ink-soft);margin:6px 0 20px;line-height:1.5}
.login-back{position:absolute;top:20px;left:18px;width:34px;height:34px;border-radius:10px;border:none;
  background:var(--bg);color:var(--ink);display:grid;place-items:center;cursor:pointer}
.prof-list{display:flex;flex-direction:column;gap:10px}
.prof{display:flex;align-items:center;gap:13px;background:var(--bg);border:1.5px solid var(--line);
  border-radius:16px;padding:12px 14px;cursor:pointer;transition:border .15s}
.prof:hover{border-color:var(--green)}
.prof .ava{font-size:30px;line-height:1}
.prof b{font-size:15.5px;font-weight:600;display:block;text-align:left}
.prof small{font-size:11.5px;color:var(--ink-soft);display:flex;align-items:center;gap:4px}
.prof-del{margin-left:auto;border:none;background:none;color:var(--ink-soft);cursor:pointer;padding:6px;display:flex}
.login-addbtn{margin-top:14px;width:100%;border:1.5px dashed var(--line);background:none;color:var(--ink-soft);
  border-radius:14px;padding:13px;font-family:var(--sans);font-weight:600;font-size:14px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:8px}
.login-addbtn:hover{border-color:var(--green);color:var(--green)}
.ava-grid{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:8px 0 16px}
.ava-opt{width:46px;height:46px;border-radius:13px;border:1.5px solid var(--line);background:var(--bg);
  font-size:24px;cursor:pointer;display:grid;place-items:center}
.ava-opt.on{border-color:var(--green);background:var(--green-soft)}
.login-input{width:100%;border:1.5px solid var(--line);background:var(--bg);border-radius:13px;
  padding:13px 15px;font-size:15px;font-family:var(--sans);color:var(--ink);outline:none;text-align:center;margin-bottom:12px}
.login-input:focus{border-color:var(--green)}
.pin-input{letter-spacing:8px;font-size:20px;font-weight:700}
.login-toggle{display:flex;align-items:center;justify-content:space-between;background:var(--bg);
  border:1.5px solid var(--line);border-radius:13px;padding:13px 15px;margin-bottom:12px;cursor:pointer;
  font-size:14px;font-weight:500;color:var(--ink)}
.login-toggle.on{border-color:var(--green);background:var(--green-soft);color:var(--green)}
.bio-btn{width:100%;display:flex;flex-direction:column;align-items:center;gap:10px;background:var(--green-soft);
  border:1.5px solid var(--green);color:var(--green);border-radius:16px;padding:22px;cursor:pointer;
  font-family:var(--sans);font-weight:600;font-size:14px;margin-bottom:14px}
.bio-btn:disabled{opacity:.7}

/* desktop shell */
.dshell{display:flex;height:100dvh;background:var(--bg)}
.sidebar{flex:none;width:256px;background:var(--card);border-right:1px solid var(--line);
  display:flex;flex-direction:column;padding:22px 16px}
.side-brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:19px;color:var(--ink);
  letter-spacing:-.02em;padding:0 8px 14px}
.side-brand svg{color:var(--green)}
.side-profile{display:flex;align-items:center;gap:11px;background:var(--bg);border:1px solid var(--line);
  border-radius:14px;padding:10px 12px;cursor:pointer;margin-bottom:14px}
.side-profile:hover{border-color:var(--green)}
.side-profile .ava{font-size:26px;line-height:1}
.side-profile b{display:block;font-size:14px;font-weight:600;text-align:left}
.side-profile small{font-size:11.5px;color:var(--ink-soft)}
.acct-ava{width:30px;height:30px;border-radius:9px;background:var(--green-soft);color:var(--green);
  display:grid;place-items:center;font-weight:700;font-size:15px;flex:none}
.acct-name{display:block;font-size:13.5px;font-weight:600;text-align:left;max-width:150px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-nav{display:flex;flex-direction:column;gap:4px}
.side-item{display:flex;align-items:center;gap:12px;border:none;background:none;cursor:pointer;
  padding:11px 13px;border-radius:12px;font-family:var(--sans);font-size:14.5px;font-weight:600;
  color:var(--ink-soft);text-align:left}
.side-item:hover{background:var(--bg)}
.side-item.on{background:var(--green-soft);color:var(--green)}
.side-add{margin-top:16px;display:flex;align-items:center;justify-content:center;gap:8px;
  background:linear-gradient(120deg,#6D5BFF,#5B4BF5);color:#fff;border:none;border-radius:13px;
  padding:13px;font-family:var(--sans);font-weight:600;font-size:14.5px;cursor:pointer;
  box-shadow:0 8px 20px rgba(91,75,245,.32)}
.side-add:active{transform:scale(.98)}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:2px;padding-top:14px;border-top:1px solid var(--line)}
.side-link{display:flex;align-items:center;gap:10px;border:none;background:none;cursor:pointer;
  padding:10px 13px;border-radius:10px;font-family:var(--sans);font-size:13.5px;font-weight:500;color:var(--ink-soft);text-align:left}
.side-link:hover{background:var(--bg);color:var(--ink)}
.dmain{flex:1;overflow-y:auto;padding:26px 36px 48px}
.dmain-head h1{font-size:26px;font-weight:700;letter-spacing:-.03em;margin:0 0 22px}
.desktop .grid{grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:22px;max-width:1120px}
.desktop .stats{max-width:580px}
.desktop .coll{max-width:1120px}
.desktop .search,.desktop .stat-strip,.desktop .filter-tag{max-width:540px}
.ava-btn{font-size:18px;line-height:1}
/* desktop modals: center instead of bottom sheet */
.desktop .sheet-wrap{align-items:center}
.desktop .sheet{border-radius:24px;max-width:440px;max-height:88vh}
.desktop .sheet-grip{display:none}
.desktop .sheet-top{padding-top:16px}

.toast{position:fixed;bottom:96px;left:50%;transform:translateX(-50%);z-index:30;
  background:var(--ink);color:#fff;padding:13px 22px;border-radius:99px;font-size:14px;font-weight:500;
  box-shadow:0 10px 30px rgba(0,0,0,.28);animation:fade .2s;max-width:90%;text-align:center}
.toast.warn{background:var(--amber)}
`;
