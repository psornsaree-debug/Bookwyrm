// ─────────────────────────────────────────────────────────────
//  วางค่า config ของคุณจาก Firebase Console ตรงนี้
//  (Project settings ⚙️ → General → Your apps → SDK setup and configuration → Config)
// ─────────────────────────────────────────────────────────────
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "วาง_apiKey_ของคุณ",
  authDomain: "ชื่อโปรเจกต์.firebaseapp.com",
  projectId: "ชื่อโปรเจกต์",
  storageBucket: "ชื่อโปรเจกต์.appspot.com",
  messagingSenderId: "วาง_messagingSenderId",
  appId: "วาง_appId",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
