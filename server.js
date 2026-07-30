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
    // code'u kısa ömürlü kullanıcı token'ına çeviriyoruz
    const tokenRes = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_secret=${APP_SECRET}&code=${code}`);
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.send("Token alınamadı: " + JSON.stringify(tokenData));
    }

    // Kısa ömürlü token'ı uzun ömürlüye (60 gün) çeviriyoruz
    const longRes = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
    const longData = await longRes.json();
    savedUserToken = longData.access_token || tokenData.access_token;

    // Bağlı Facebook Sayfalarını ve bunlara bağlı Instagram hesaplarını buluyoruz
    const pagesRes = await fetch(`https://graph.facebook.com/${API_VERSION}/me/accounts?fields=name,access_token,instagram_business_account&access_token=${savedUserToken}`);
    const pagesData = await pagesRes.json();
    savedPages = pagesData.data || [];

    let list = savedPages.map(p => `<li>${p.name} — Instagram bağlı mı: ${p.instagram_business_account ? "Evet (ID: " + p.instagram_business_account.id + ")" : "Hayır"}</li>`).join("");

    res.send(`
      <h2>Başarılı!</h2>
      <p>Kullanıcı token'ın (uzun ömürlü):</p>
      <textarea style="width:100%; height:80px;">${savedUserToken}</textarea>
      <p>Bağlı sayfaların:</p>
      <ul>${list}</ul>
      <p><a href="/me">Ham veriyi gör (JSON)</a></p>
    `);
  } catch (e) {
    res.send("Beklenmedik hata: " + e.message);
  }
});

// 3) Ham veriyi test etmek için
app.get("/me", async (req, res) => {
  if (!savedPages) return res.send("Önce /login üzerinden giriş yapmalısın.");
  res.json(savedPages);
});

app.get("/", (req, res) => {
  res.send('Sunucu çalışıyor. Başlamak için <a href="/login">/login</a> adresine git.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Sunucu " + PORT + " portunda çalışıyor"));
