// Saç Ekim Yayın Masası - basit backend
// Facebook Login for Business akışı ile Instagram Graph API bağlantısı

const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APP_ID = process.env.IG_APP_ID; // Facebook App ID (Basic ayarlarda gördüğün)
const APP_SECRET = process.env.IG_APP_SECRET; // Facebook App Secret
const REDIRECT_URI = process.env.REDIRECT_URI;
const API_VERSION = "v21.0";

let savedUserToken = null;
let savedPages = null;
let activeAccount = null; // { pageName, pageAccessToken, igId }

const TARGET_PAGE_NAME = "DRMS Hair Clinic";
const WEBHOOK_VERIFY_TOKEN = "sacekim2026webhook"; // Meta panelinde webhook kurarken aynısını gireceğiz

let incomingMessages = []; // { senderId, text, timestamp }

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// 1) Facebook giriş ekranına yönlendir
app.get("/login", (req, res) => {
  const scopes = [
    "pages_show_list",
    "pages_read_engagement",
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
  if (!code) {
    return res.send("Hata: code parametresi gelmedi. " + JSON.stringify(req.query));
  }

  try {
    const tokenRes = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${APP_SECRET}&code=${code}`);
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.send("Token alınamadı: " + JSON.stringify(tokenData));
    }

    const longRes = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
    const longData = await longRes.json();
    savedUserToken = longData.access_token || tokenData.access_token;

    const pagesRes = await fetch(`https://graph.facebook.com/${API_VERSION}/me/accounts?fields=name,access_token,instagram_business_account&access_token=${savedUserToken}`);
    const pagesData = await pagesRes.json();
    savedPages = pagesData.data || [];

    const match = savedPages.find(p => p.name === TARGET_PAGE_NAME && p.instagram_business_account);
    if (match) {
      activeAccount = {
        pageName: match.name,
        pageAccessToken: match.access_token,
        igId: match.instagram_business_account.id
      };
      try {
        await fetch(`https://graph.facebook.com/${API_VERSION}/me/subscribed_apps?subscribed_fields=messages&access_token=${match.access_token}`, { method: "POST" });
      } catch (e) { /* abonelik hatası olursa sessizce geç, elle de yapılabilir */ }
    }

    let list = savedPages.map(p => `<li>${p.name} — Instagram bağlı mı: ${p.instagram_business_account ? "Evet (ID: " + p.instagram_business_account.id + ")" : "Hayır"}</li>`).join("");

    res.send(`
      <h2>Başarılı!</h2>
      <p>Kullanıcı token'ın (uzun ömürlü):</p>
      <textarea style="width:100%; height:80px;">${savedUserToken}</textarea>
      <p>Bağlı sayfaların:</p>
      <ul>${list}</ul>
      <p><strong>Aktif hesap:</strong> ${activeAccount ? activeAccount.pageName + " (IG ID: " + activeAccount.igId + ")" : "Bulunamadı — TARGET_PAGE_NAME değerini kontrol et"}</p>
      <p><a href="/me">Ham veriyi gör (JSON)</a> · <a href="/ig/media">Son paylaşımları gör</a> · <a href="/ig/insights">İstatistikleri gör</a></p>
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
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/ig/comments/:mediaId", async (req, res) => {
  if (!requireAccount(res)) return;
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${req.params.mediaId}/comments?fields=id,text,username,timestamp&access_token=${activeAccount.pageAccessToken}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ig/comments/:commentId/reply", async (req, res) => {
  if (!requireAccount(res)) return;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message alanı gerekli" });
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${req.params.commentId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message, access_token: activeAccount.pageAccessToken })
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ig/publish", async (req, res) => {
  if (!requireAccount(res)) return;
  const { image_url, caption } = req.body;
  if (!image_url) return res.status(400).json({ error: "image_url alanı gerekli (internetten erişilebilir bir görsel adresi olmalı)" });
  try {
    const containerRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ image_url, caption: caption || "", access_token: activeAccount.pageAccessToken })
    });
    const containerData = await containerRes.json();
    if (!containerData.id) return res.json({ step: "container", result: containerData });

    const publishRes = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerData.id, access_token: activeAccount.pageAccessToken })
    });
    const publishData = await publishRes.json();
    res.json({ step: "published", result: publishData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/ig/insights", async (req, res) => {
  if (!requireAccount(res)) return;
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${activeAccount.igId}/insights?metric=reach,profile_views&period=day&access_token=${activeAccount.pageAccessToken}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (event.message && event.message.text && event.sender) {
          incomingMessages.push({
            senderId: event.sender.id,
            text: event.message.text,
            timestamp: Date.now()
          });
        }
      }
    }
  } catch (e) { /* beklenmeyen format gelirse yoksay */ }
  res.sendStatus(200);
});

app.get("/ig/messages", (req, res) => {
  res.json(incomingMessages);
});

app.post("/ig/messages/:senderId/reply", async (req, res) => {
  if (!requireAccount(res)) return;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message alanı gerekli" });
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/me/messages?access_token=${activeAccount.pageAccessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: req.params.senderId },
        message: { text: message },
        messaging_type: "RESPONSE"
      })
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => {
  res.send('Sunucu çalışıyor. Başlamak için <a href="/login">/login</a> adresine git.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Sunucu " + PORT + " portunda çalışıyor"));
