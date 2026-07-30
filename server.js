// Saç Ekim Yayın Masası - basit backend
// Instagram Business Login (OAuth) + Graph API çağrıları

const express = require("express");
const fetch = require("node-fetch");
const app = express();

const APP_ID = process.env.IG_APP_ID;
const APP_SECRET = process.env.IG_APP_SECRET;
// Bu URL'i Glitch'te proje oluşturunca alacağın adresle değiştireceğiz (adım adım anlatacağım)
const REDIRECT_URI = process.env.REDIRECT_URI;

let savedToken = null; // basit test amaçlı, gerçek kullanımda güvenli bir veritabanına yazılmalı

// 1) Kullanıcıyı (seni) Instagram girişine yönlendiren adım
app.get("/login", (req, res) => {
  const scopes = [
    "instagram_business_basic",
    "instagram_business_content_publish",
    "instagram_business_manage_comments",
    "instagram_business_manage_messages",
    "instagram_business_manage_insights"
  ].join(",");

  const authUrl = `https://www.instagram.com/oauth/authorize?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes}`;

  res.send(`<a href="${authUrl}">Instagram ile giriş yap</a>`);
});

// 2) Instagram, giriş başarılı olunca kullanıcıyı buraya "code" ile geri gönderir
app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.send("Hata: code parametresi gelmedi. " + JSON.stringify(req.query));
  }

  try {
    // Kısa ömürlü token almak için code'u değiştiriyoruz
    const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: APP_ID,
        client_secret: APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code: code
      })
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.send("Token alınamadı: " + JSON.stringify(tokenData));
    }

    // Kısa ömürlü token'ı uzun ömürlü token'a çeviriyoruz (60 gün)
    const longRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${APP_SECRET}&access_token=${tokenData.access_token}`);
    const longData = await longRes.json();

    savedToken = longData.access_token || tokenData.access_token;

    res.send(`
      <h2>Başarılı!</h2>
      <p>Uzun ömürlü erişim token'ın:</p>
      <textarea style="width:100%; height:100px;">${savedToken}</textarea>
      <p>Bu token'ı güvenli bir yere kaydet (kimseyle paylaşma). 60 gün geçerli, sonra yenilenmesi gerekir.</p>
      <p><a href="/me">Hesap bilgilerini test et</a></p>
    `);
  } catch (e) {
    res.send("Beklenmedik hata: " + e.message);
  }
});

// 3) Token çalışıyor mu diye basit bir test: kendi hesap bilgilerini çeker
app.get("/me", async (req, res) => {
  if (!savedToken) return res.send("Önce /login üzerinden giriş yapmalısın.");
  try {
    const r = await fetch(`https://graph.instagram.com/me?fields=id,username,account_type&access_token=${savedToken}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.send("Hata: " + e.message);
  }
});

app.get("/", (req, res) => {
  res.send('Sunucu çalışıyor. Başlamak için <a href="/login">/login</a> adresine git.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Sunucu " + PORT + " portunda çalışıyor"));
