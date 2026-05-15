"use strict";

const crypto = require("crypto");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "asia-southeast1", maxInstances: 5 });

const TZ_OFFSET = "+07:00"; // Asia/Bangkok

// แจ้งเตือนล่วงหน้า: 60 / 30 / 15 / 5 นาที และถึงเวลา (0)
const MILESTONES = [
  { key: "60", m: 60, label: "อีก 1 ชั่วโมง" },
  { key: "30", m: 30, label: "อีก 30 นาที" },
  { key: "15", m: 15, label: "อีก 15 นาที" },
  { key: "5", m: 5, label: "อีก 5 นาที" },
  { key: "0", m: 0, label: "ถึงเวลาแล้ว" },
];

// แจ้งเตือนเลยกำหนด: เริ่มหลังเลยเวลา 1 นาที แล้วซ้ำทุก 10 นาที สูงสุด 6 ครั้ง
const OVERDUE_FIRST_MIN = 1;
const OVERDUE_INTERVAL_MIN = 10;
const MAX_OVERDUE = 6;

function startMsOf(ev) {
  if (!ev.dateStart || !ev.timeStart) return NaN;
  return Date.parse(`${ev.dateStart}T${ev.timeStart}:00${TZ_OFFSET}`);
}

async function getTarget() {
  if (process.env.LINE_TARGET_USER_ID) return process.env.LINE_TARGET_USER_ID;
  const snap = await db.doc("config/line").get();
  return snap.exists ? snap.data().userId || null : null;
}

async function linePush(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    console.error("LINE push failed", res.status, await res.text());
  }
}

async function lineReply(replyToken, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    console.error("LINE reply failed", res.status, await res.text());
  }
}

function ackButton(id) {
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

function eventText(ev, headline) {
  const timeRange = ev.timeEnd ? `${ev.timeStart}–${ev.timeEnd}` : ev.timeStart;
  let s = `🔔 ${headline}\n\n📌 ${ev.name}`;
  if (ev.sub) s += `\n${ev.sub}`;
  s += `\n🗓 ${ev.dateStart}`;
  s += `\n🕒 ${timeRange} น.`;
  if (ev.note) s += `\n📝 ${ev.note}`;
  return { type: "text", text: s };
}

exports.eventReminder = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Asia/Bangkok" },
  async () => {
    const target = await getTarget();
    if (!target) {
      console.warn("ยังไม่มี userId ปลายทาง — ทักแชท OA ก่อน หรือกรอก LINE_TARGET_USER_ID");
      return;
    }

    const snap = await db.collection("calendar_events").get();
    const now = Date.now();

    for (const docSnap of snap.docs) {
      const ev = docSnap.data();
      const startMs = startMsOf(ev);
      if (Number.isNaN(startMs)) continue; // ข้าม event ที่ไม่มีเวลา (ทั้งวัน)

      const diffMin = (startMs - now) / 60000;
      const notified = ev.notified || {};

      if (diffMin >= 0) {
        const dueUnsent = MILESTONES.filter(
          (ms) => !notified[ms.key] && diffMin <= ms.m + 1e-6
        );
        if (dueUnsent.length) {
          const pick = dueUnsent.reduce((a, b) => (b.m < a.m ? b : a));
          await linePush(target, [
            eventText(ev, pick.label),
            ackButton(docSnap.id),
          ]);
          const upd = {};
          dueUnsent.forEach((ms) => {
            upd[`notified.${ms.key}`] = true;
          });
          await docSnap.ref.update(upd);
        }
        continue;
      }

      // เลยกำหนดเวลาแล้ว และยังไม่กดรับทราบ (ยังไม่ถูกลบ)
      const lateMin = -diffMin;
      const overdueCount = ev.overdueCount || 0;
      if (overdueCount >= MAX_OVERDUE) continue;
      const nextDueMin =
        OVERDUE_FIRST_MIN + overdueCount * OVERDUE_INTERVAL_MIN;
      if (lateMin >= nextDueMin) {
        await linePush(target, [
          eventText(
            ev,
            `⚠️ เลยกำหนดเวลาแล้ว (เลยมา ~${Math.round(lateMin)} นาที)`
          ),
          ackButton(docSnap.id),
        ]);
        await docSnap.ref.update({
          overdueCount: overdueCount + 1,
          "notified.0": true,
        });
      }
    }
  }
);

exports.lineWebhook = onRequest(async (req, res) => {
  const signature = req.get("x-line-signature") || "";
  const expected = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    res.status(401).send("bad signature");
    return;
  }

  const events = (req.body && req.body.events) || [];
  for (const e of events) {
    const uid = e.source && e.source.userId;
    if (uid) {
      await db.doc("config/line").set({ userId: uid }, { merge: true });
    }

    if (e.type === "postback") {
      const data = new URLSearchParams(e.postback.data);
      if (data.get("action") === "ack") {
        const id = data.get("id");
        let msg = "✅ รับทราบแล้ว ลบรายการนี้ออกจากปฏิทินเรียบร้อย";
        try {
          const ref = db.doc(`calendar_events/${id}`);
          const exists = (await ref.get()).exists;
          if (exists) await ref.delete();
          else msg = "✅ รับทราบแล้ว (รายการนี้ถูกลบไปก่อนหน้าแล้ว)";
        } catch (err) {
          console.error("delete failed", err);
          msg = "⚠️ รับทราบแล้ว แต่ลบรายการไม่สำเร็จ ลองอีกครั้ง";
        }
        await lineReply(e.replyToken, [{ type: "text", text: msg }]);
      }
    } else if (e.type === "follow" || e.type === "message") {
      await lineReply(e.replyToken, [
        {
          type: "text",
          text: "เชื่อมต่อระบบแจ้งเตือนปฏิทินเรียบร้อยแล้ว ✅\nระบบจะส่งแจ้งเตือน event มาที่แชทนี้",
        },
      ]);
    }
  }

  res.status(200).send("ok");
});
