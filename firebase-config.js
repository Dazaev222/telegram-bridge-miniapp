/* ═══════════════════════════════════════════════════════════════════
   Конфиг Firebase Web (публичный по дизайну — безопасно вшивать в UI).

   Как заполнить:
   1. console.firebase.google.com → проект telegram-claude-tunnel
   2. Project settings (шестерёнка) → General → Your apps → Web app
      (если приложения ещё нет — Add app → значок </> → имя, Register)
   3. Скопируйте объект firebaseConfig в window.__FIREBASE_CONFIG__ ниже.

   apiKey вписан скриптом scripts/get_web_config.py
   (Firebase Management API; ключ публичный — доступ закрывают
   правила RTDB и проверка подписи initData на боте). Тесты без
   Firebase открывайте index.html?mock=1.
   ═══════════════════════════════════════════════════════════════════ */

window.__FIREBASE_CONFIG__ = {
  apiKey: 'AIzaSyB_AynV8tFqanugavpWfiRDcE8bBiKlOHo',
  authDomain: 'telegram-claude-tunnel.firebaseapp.com',
  databaseURL: 'https://telegram-claude-tunnel-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'telegram-claude-tunnel',
  storageBucket: 'telegram-claude-tunnel.firebasestorage.app',
  messagingSenderId: '869669207915',
  appId: '1:869669207915:web:70d14e8f6264451e77162e',
};
