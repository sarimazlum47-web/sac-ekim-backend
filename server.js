// Saç Ekim Yayın Masası - backend
// Facebook Login for Business + Instagram Graph API + tam otomatik yanıt

const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APP_ID = process.env.IG_APP_ID;
const APP_SECRET = process.env.IG_APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_VERSION = "v21.0";

let savedUserToken = null;
let savedPages = null;
let activeAccount = null; // { pageName, pageAccessToken, igId }

const TARGET_PAGE_NAME = "DRMS Hair Clinic";
const WEBHOOK_VERIFY_TOKEN = "sacekim2026webhook";

let incomingMessages = [];
const repliedMessageIds = new Set();
const repliedCommentIds = new Set();

// Gün sonu raporu için basit sayaçlar (sunucu yeniden başlayınca sıfırlanır)
let dailyLog = { date: new Date().toISOString().slice(0,10), autoReplies: 0, leadsFlagged: 0, details: [] };
function resetDailyLogIfNewDay() {
  const today = new Date().toISOString().slice(0,10);
  if (dailyLog.date !== today) {
    dailyLog = { date: today, autoReplies: 0, leadsFlagged: 0, details: [] };
  }
}

app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Claude'a soru sorma (backend üzerinden, kullanıcının kendi Anthropic anahtarıyla)
async function askClaudeBackend(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Anthropic API hatası");
  return data.content.map(b => b.text || "").join("\n").trim();
}

// Otomatik yanıt kuralları — tek bir yerde tanımlı, hem yorum hem mesaj için kullanılır
function buildAutoReplyPrompt(incomingText) {
  return `Sen DRMS Hair Clinic (saç ekimi kliniği) Instagram hesabının müşteri hizmetleri temsilcisisin. Gerçek bir insan gibi, doğal ve sıcak bir üslupla yazıyorsun — yapay zeka olduğunu belirtme, robotik cümleler kurma.

Gelen mesaj/yorum: "${incomingText}"

Kurallar:
1) MUTLAKA gelen mesajla aynı dilde yanıtla.
2) Sohbeti doğal şekilde sürdür, kişiyi bilgilendir, güven ver, ilgisini artır.
3) Şu iki durumdan biri geçerliyse, kısaca "detaylı bilgi ve kişiye özel değerlendirme için lütfen bir telefon numarası bırakın, ekibimiz sizi arasın" tarzında nazikçe yönlendir:
   a) Kişi FİYAT soruyorsa,
   b) Kişi randevu almaya/ilerlemeye hazır görünüyorsa (ikna olmuş, sonraki adımı soruyorsa).
4) Kişi TIBBİ/klinik bir detay soruyorsa (greft sayısı, ağrı, iyileşme süreci, risk, ilaç, sonuç garantisi gibi) kendi tıbbi bilgi verme/tahmin yürütme — nazikçe doktorumuzun/hekim arkadaşlarımızın kendisiyle görüşebilmesi için telefon numarası bırakmasını rica et.
5) Bunların dışındaki genel/merak sorularını (süreç nasıl işler, nereden geldiler, deneyim, hijyen vb.) doğal, sıcak, ikna edici ama abartısız şekilde yanıtla.
6) Sadece nihai yanıt metnini yaz, başka açıklama ekleme. Kısa tut (1-3 cümle).`;
}

function isRedirectSuggested(text) {
  return /telefon numaras[ıi]|numaranızı b[ıi]rak|arayal[ıi]m|sizi arasın/i.test(text);
}

// 1) Facebook giriş ekranına yönlendir
app.get("/login", (req, res) => {
  const scopes = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_messaging",
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_comments",
    "instagram_manage_messages",
    "instagram_manage_insights",
    "business_management"
  ].join(",");
  const authUrl = `https://www.facebook.com/${API_VERSION}/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scopes}&response_type=code`;
  res.send(`<a href="${authUrl}">Facebook ile giriş yap (klinik hesabına bağlı Facebook hesabınla)</a>`);
});

// 2) Facebook, giriş başarılı olunca "code" ile buraya geri gönderir
app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Hata: code parametresi gelmedi. " + JSON.stringify(req.query));

  try {
    const tokenRes = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${APP_SECRET}&code=${code}`);
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.send("Token alınamadı: " + JSON.stringify(tokenData));

    const longRes = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
    const longData = await longRes.json();
    savedUserToken = longData.access_token || tokenData.access_token;

    const pagesRes = await fetch(`https://graph.facebook.com/${API_VERSION}/me/accounts?fields=name,access_token,instagram_business_account&access_token=${savedUserToken}`);
    const pagesData = await pagesRes.json();
    savedPages = pagesData.data || [];

    const match = savedPages.find(p => p.name === TARGET_PAGE_NAME && p.instagram_business_account);
    if (match) {
      activeAccount = { pageName: match.name, pageAccessToken: match.access_token, igId: match.instagram_business_account.id };
      try {
        const subRes = await fetch(`https://graph.facebook.com/${API_VERSION}/me/subscribed_apps?subscribed_fields=messages&access_token=${match.access_token}`, { method: "POST" });
        const subData = await subRes.json();
        console.log("Webhook aboneliği sonucu:", JSON.stringify(subData));
      } catch (e) { console.log("Webhook abonelik hatası:", e.message); }
    }

    let list = savedPages.map(p => `<li>${p.name} — Instagram bağlı mı: ${p.instagram_business_account ? "Evet (ID: " + p.instagram_business_account.id + ")" : "Hayır"}</li>`).join("");
    res.send(`
      <h2>Başarılı!</h2>
      <p>Kullanıcı token'ın (uzun ömürlü):</p>
      <textarea style="width:100%; height:80px;">${savedUserToken}</textarea>
      <p>Bağlı sayfaların:</p>
      <ul>${list}</ul>
      <p><strong>Aktif hesap:</strong> ${activeAccount ? activeAccount.pageName + " (IG ID: " + activeAccount.igId + ")" : "Bulunamadı"}</p>
      <p><a href="/me">Ham veriyi gör</a> · <a href="/ig/media">Paylaşımlar</a> · <a href="/ig/insights">İstatistik</a> · <a href="/report/daily">Günlük rapor</a></p>
    `);
  } catch (e) {
    res.send("Beklenmedik hata: " + e.message);
  }
});

app.get("/me", async (req, res) => {
  if (!savedPages) return res.send("Önce /login üzerinden giriş yapmalısın.");
  res.json(savedPages);
});

function requireAccount(res) {
  if (!activeAccount) {
    res.status(400).json({ error: "Aktif hesap yok. Önce /login yap." });
    return false;
  }
  return true;
}

app.get("/ig/media", async (req, res) => {
  if (!requireAccount(res)) return;
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&access_token=${activeAccount.pageAccessToken}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/ig/comments/:mediaId", async (req, res) => {
  if (!requireAccount(res)) return;
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${req.params.mediaId}/comments?fields=id,text,username,timestamp&access_token=${activeAccount.pageAccessToken}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ig/comments/:commentId/reply", async (req, res) => {
  if (!requireAccount(res)) return;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message alanı gerekli" });
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${req.params.commentId}/replies`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message, access_token: activeAccount.pageAccessToken })
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/ig/publish", async (req, res) => {
  if (!requireAccount(res)) return;
  const { image_url, caption, asStory } = req.body;
  if (!image_url) return res.status(400).json({ error: "image_url alanı gerekli" });
  try {
    const containerParams = { image_url, access_token: activeAccount.pageAccessToken };
    if (asStory) {
      containerParams.media_type = "STORIES"; // Hikayelerde caption desteklenmiyor
    } else {
      containerParams.caption = caption || "";
    }
    const containerRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/media`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(containerParams)
    });
    const containerData = await containerRes.json();
    if (!containerData.id) return res.json({ step: "container", result: containerData });
    const publishRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/media_publish`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerData.id, access_token: activeAccount.pageAccessToken })
    });
    res.json({ step: "published", result: await publishRes.json() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/ig/insights", async (req, res) => {
  if (!requireAccount(res)) return;
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/insights?metric=reach,profile_views&period=day&access_token=${activeAccount.pageAccessToken}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Webhook (gerçek zamanlı DM alma + otomatik yanıt) ---
app.get("/webhook", (req, res) => {
  console.log("Webhook DOĞRULAMA isteği geldi:", JSON.stringify(req.query));
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  console.log("Webhook POST isteği geldi:", JSON.stringify(req.body));
  res.sendStatus(200); // Meta'ya hemen onay ver, işlemi arka planda yap
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (event.message && event.message.text && event.sender) {
          const msg = { senderId: event.sender.id, text: event.message.text, timestamp: Date.now() };
          incomingMessages.push(msg);
          await autoHandleMessage(msg);
        }
      }
    }
  } catch (e) { console.log("Webhook işleme hatası:", e.message); }
});

async function autoHandleMessage(msg) {
  if (!activeAccount || !ANTHROPIC_API_KEY) return;
  const msgKey = msg.senderId + "|" + msg.timestamp;
  if (repliedMessageIds.has(msgKey)) return;
  repliedMessageIds.add(msgKey);
  try {
    resetDailyLogIfNewDay();
    const draft = await askClaudeBackend(buildAutoReplyPrompt(msg.text));
    await fetch(`https://graph.facebook.com/${API_VERSION}/me/messages?access_token=${activeAccount.pageAccessToken}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: msg.senderId }, message: { text: draft }, messaging_type: "RESPONSE" })
    });
    dailyLog.autoReplies++;
    if (isRedirectSuggested(draft)) dailyLog.leadsFlagged++;
    dailyLog.details.push({ type: "mesaj", incoming: msg.text, reply: draft, time: new Date().toISOString() });
  } catch (e) { console.log("Otomatik mesaj yanıtı hatası:", e.message); }
}

app.get("/ig/messages", (req, res) => res.json(incomingMessages));

app.post("/ig/messages/:senderId/reply", async (req, res) => {
  if (!requireAccount(res)) return;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message alanı gerekli" });
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/me/messages?access_token=${activeAccount.pageAccessToken}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: req.params.senderId }, message: { text: message }, messaging_type: "RESPONSE" })
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Yorumlar için otomatik tarama döngüsü (webhook'suz, periyodik) ---
async function autoScanComments() {
  if (!activeAccount || !ANTHROPIC_API_KEY) return;
  try {
    resetDailyLogIfNewDay();
    const mediaRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/media?fields=id,comments_count&access_token=${activeAccount.pageAccessToken}`);
    const mediaData = await mediaRes.json();
    const posts = (mediaData.data || []).filter(p => (p.comments_count || 0) > 0).slice(0, 10);

    for (const post of posts) {
      const commentsRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${post.id}/comments?fields=id,text,username&access_token=${activeAccount.pageAccessToken}`);
      const commentsData = await commentsRes.json();
      for (const c of (commentsData.data || [])) {
        if (repliedCommentIds.has(c.id)) continue;
        repliedCommentIds.add(c.id);
        try {
          const draft = await askClaudeBackend(buildAutoReplyPrompt(c.text));
          await fetch(`https://graph.facebook.com/${API_VERSION}/${c.id}/replies`, {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ message: draft, access_token: activeAccount.pageAccessToken })
          });
          dailyLog.autoReplies++;
          if (isRedirectSuggested(draft)) dailyLog.leadsFlagged++;
          dailyLog.details.push({ type: "yorum", incoming: c.text, reply: draft, time: new Date().toISOString() });
        } catch (e) { console.log("Otomatik yorum yanıtı hatası:", e.message); }
      }
    }
  } catch (e) { console.log("Yorum tarama hatası:", e.message); }
}

// Her 2 dakikada bir yeni yorumları kontrol et
setInterval(autoScanComments, 2 * 60 * 1000);

// Günlük rapor
app.get("/report/daily", (req, res) => {
  resetDailyLogIfNewDay();
  res.json(dailyLog);
});

app.get("/ig/subscription-status", async (req, res) => {
  if (!requireAccount(res)) return;
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/me/subscribed_apps?access_token=${activeAccount.pageAccessToken}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => {
  res.send('Sunucu çalışıyor. Başlamak için <a href="/login">/login</a> adresine git.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Sunucu " + PORT + " portunda çalışıyor"));
