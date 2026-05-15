// LINE reminder backend for the calendar — runs on Deno Deploy (free tier).
// - Deno.cron: ตรวจทุกนาที ส่งแจ้งเตือนล่วงหน้า / เลยกำหนด
// - Deno.serve: รับ webhook ปุ่ม "รับทราบ" จาก LINE แล้วลบ event
// อ่าน/เขียน Firestore ผ่าน REST API (ใช้ security rules เดิมที่เปิดอยู่)

const PROJECT = "horsuktheoneandbanglamung";
const API_KEY = "AIzaSyDaWWpY45r-cz82ZeFnhPp9M9cJa4jHWhA";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const LINE_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const ENV_TARGET = Deno.env.get("LINE_TARGET_USER_ID") ?? "";

// แจ้งเตือนล่วงหน้า: 60 / 30 / 15 / 5 นาที (ก่อนถึงเวลา)
const MILESTONES = [
  { key: "notif60", m: 60, label: "อีก 1 ชั่วโมง" },
  { key: "notif30", m: 30, label: "อีก 30 นาที" },
  { key: "notif15", m: 15, label: "อีก 15 นาที" },
  { key: "notif5", m: 5, label: "อีก 5 นาที" },
];
// ถึงเวลานัด: ยิงเมื่อถึง/เพิ่งเลยเวลา แต่ยังไม่ถึงเลยมา 5 นาที
const AT_TIME_LABEL = "ถึงเวลาแล้ว";
// เลยกำหนด: แจ้งเมื่อเลยเวลานัดมา 5 / 15 / 30 นาที (แล้วหยุด)
const OVERDUE_MILESTONES = [
  { key: "over5", m: 5, label: "เลยเวลานัดมา 5 นาที" },
  { key: "over15", m: 15, label: "เลยเวลานัดมา 15 นาที" },
  { key: "over30", m: 30, label: "เลยเวลานัดมา 30 นาที" },
];

// ── Firestore value helpers ──
// deno-lint-ignore no-explicit-any
function val(v: any): any {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.mapValue !== undefined) return fieldsToObj(v.mapValue.fields ?? {});
  if (v.arrayValue !== undefined) return (v.arrayValue.values ?? []).map(val);
  return undefined;
}
// deno-lint-ignore no-explicit-any
function fieldsToObj(f: any): Record<string, any> {
  const o: Record<string, unknown> = {};
  for (const k in f) o[k] = val(f[k]);
  return o;
}
// deno-lint-ignore no-explicit-any
function toFsValue(v: any) {
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number" && Number.isInteger(v)) {
    return { integerValue: String(v) };
  }
  return { stringValue: String(v) };
}

async function listEvents() {
  const res = await fetch(`${FS}/calendar_events?key=${API_KEY}&pageSize=300`);
  if (!res.ok) {
    console.error("listEvents failed", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  // deno-lint-ignore no-explicit-any
  return (data.documents ?? []).map((d: any) => ({
    id: d.name.split("/").pop() as string,
    ...fieldsToObj(d.fields ?? {}),
    // deno-lint-ignore no-explicit-any
  })) as any[];
}

async function patchEvent(id: string, fields: Record<string, unknown>) {
  const mask = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  // deno-lint-ignore no-explicit-any
  const body: any = { fields: {} };
  for (const k in fields) body.fields[k] = toFsValue(fields[k]);
  const res = await fetch(
    `${FS}/calendar_events/${id}?key=${API_KEY}&${mask}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) console.error("patchEvent failed", res.status, await res.text());
}

async function deleteEvent(id: string): Promise<boolean> {
  const res = await fetch(`${FS}/calendar_events/${id}?key=${API_KEY}`, {
    method: "DELETE",
  });
  if (!res.ok) console.error("deleteEvent failed", res.status, await res.text());
  return res.ok;
}

// เก็บ userId ไว้ใน collection calendar_events (collection เดียวที่ rules อนุญาต)
// ใช้ doc id พิเศษที่ปฏิทิน/cron จะข้ามเพราะไม่มี dateStart/timeStart
const CONFIG_DOC = "line-target-config";

async function getTarget(): Promise<string> {
  if (ENV_TARGET) return ENV_TARGET;
  const res = await fetch(`${FS}/calendar_events/${CONFIG_DOC}?key=${API_KEY}`);
  if (!res.ok) return "";
  const d = await res.json();
  return (fieldsToObj(d.fields ?? {}).userId as string) ?? "";
}

async function setConfigUser(uid: string) {
  const res = await fetch(
    `${FS}/calendar_events/${CONFIG_DOC}?key=${API_KEY}&updateMask.fieldPaths=userId`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { userId: { stringValue: uid } } }),
    },
  );
  if (!res.ok) console.error("setConfigUser failed", res.status, await res.text());
}

// ── LINE API ──
// deno-lint-ignore no-explicit-any
async function linePush(to: string, messages: any[]) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!r.ok) console.error("linePush failed", r.status, await r.text());
}
// deno-lint-ignore no-explicit-any
async function lineReply(replyToken: string, messages: any[]) {
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!r.ok) console.error("lineReply failed", r.status, await r.text());
}

function ackButton(id: string) {
  return {
    type: "template",
    altText: "กรุณากดรับทราบ",
    template: {
      type: "buttons",
      text: "กดรับทราบเพื่อปิดการแจ้งเตือนและลบรายการนี้ออกจากปฏิทิน",
      actions: [
        {
          type: "postback",
          label: "✅ รับทราบ",
          data: `action=ack&id=${id}`,
          displayText: "รับทราบแล้ว",
        },
      ],
    },
  };
}

// deno-lint-ignore no-explicit-any
function eventText(ev: any, headline: string) {
  const timeRange = ev.timeEnd ? `${ev.timeStart}–${ev.timeEnd}` : ev.timeStart;
  let s = `🔔 ${headline}\n\n📌 ${ev.name}`;
  if (ev.sub) s += `\n${ev.sub}`;
  s += `\n🗓 ${ev.dateStart}`;
  s += `\n🕒 ${timeRange} น.`;
  if (ev.note) s += `\n📝 ${ev.note}`;
  return { type: "text", text: s };
}

// ── Cron: ตรวจทุกนาที ──
Deno.cron("event-reminder", "* * * * *", async () => {
  const target = await getTarget();
  if (!target) {
    console.warn("ยังไม่มี userId ปลายทาง — ทักแชท OA ก่อน");
    return;
  }
  const events = await listEvents();
  const now = Date.now();

  for (const ev of events) {
    if (ev.id === CONFIG_DOC) continue; // ข้าม doc เก็บ config
    if (!ev.dateStart || !ev.timeStart) continue; // ข้าม event ที่ไม่มีเวลา
    const startMs = Date.parse(`${ev.dateStart}T${ev.timeStart}:00+07:00`);
    if (Number.isNaN(startMs)) continue;
    const diffMin = (startMs - now) / 60000;

    const lateMin = -diffMin; // > 0 = เลยเวลามาแล้ว

    // 1) ก่อนถึงเวลา: 60 / 30 / 15 / 5 นาที
    if (diffMin > 1e-6) {
      const due = MILESTONES.filter(
        (m) => !ev[m.key] && diffMin <= m.m + 1e-6,
      );
      if (due.length) {
        const pick = due.reduce((a, b) => (b.m < a.m ? b : a));
        await linePush(target, [eventText(ev, pick.label), ackButton(ev.id)]);
        const upd: Record<string, boolean> = {};
        due.forEach((m) => (upd[m.key] = true));
        await patchEvent(ev.id, upd);
      }
      continue;
    }

    // 2) ถึงเวลานัด (0): ยิงครั้งเดียว ถ้ายังไม่เลยมาถึง 5 นาที
    if (!ev.notif0 && lateMin < 5) {
      await linePush(target, [
        eventText(ev, AT_TIME_LABEL),
        ackButton(ev.id),
      ]);
      const upd: Record<string, boolean> = { notif0: true };
      MILESTONES.forEach((m) => (upd[m.key] = true));
      await patchEvent(ev.id, upd);
      continue;
    }

    // 3) เลยกำหนด: เลยมา 5 / 15 / 30 นาที (แล้วหยุด)
    const dueOver = OVERDUE_MILESTONES.filter(
      (o) => !ev[o.key] && lateMin >= o.m - 1e-6,
    );
    if (dueOver.length) {
      const pick = dueOver.reduce((a, b) => (b.m > a.m ? b : a));
      await linePush(target, [
        eventText(ev, `⚠️ ${pick.label}`),
        ackButton(ev.id),
      ]);
      const upd: Record<string, boolean> = { notif0: true };
      MILESTONES.forEach((m) => (upd[m.key] = true));
      dueOver.forEach((o) => (upd[o.key] = true));
      await patchEvent(ev.id, upd);
    }
  }
});

// ── HTTP: รับ webhook จาก LINE ──
async function verifySignature(raw: string, sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(LINE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(raw),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === sig;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("calendar LINE bot is running — build 92189ce-atfix");
  }
  const raw = await req.text();
  const sig = req.headers.get("x-line-signature") ?? "";
  if (!(await verifySignature(raw, sig))) {
    return new Response("bad signature", { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return new Response("ok");
  }

  for (const e of body.events ?? []) {
    const uid = e.source?.userId;
    if (uid) await setConfigUser(uid);

    if (e.type === "postback") {
      const p = new URLSearchParams(e.postback.data);
      if (p.get("action") === "ack") {
        const id = p.get("id") ?? "";
        const ok = await deleteEvent(id);
        const msg = ok
          ? "✅ รับทราบแล้ว ลบรายการนี้ออกจากปฏิทินเรียบร้อย"
          : "⚠️ รับทราบแล้ว แต่ลบไม่สำเร็จ ลองใหม่อีกครั้ง";
        await lineReply(e.replyToken, [{ type: "text", text: msg }]);
      }
    } else if (e.type === "follow" || e.type === "message") {
      await lineReply(e.replyToken, [
        {
          type: "text",
          text:
            "เชื่อมต่อระบบแจ้งเตือนปฏิทินเรียบร้อยแล้ว ✅\nระบบจะส่งแจ้งเตือนมาที่แชทนี้",
        },
      ]);
    }
  }

  return new Response("ok");
});
