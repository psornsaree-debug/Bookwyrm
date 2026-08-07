import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
const firebaseConfig = {
  apiKey: "AIzaSyDT8M1eSnTR-6xUeP54g0irzif3o4kpcSI",
  authDomain: "bookwyrm-ceaba.firebaseapp.com",
  projectId: "bookwyrm-ceaba",
  storageBucket: "bookwyrm-ceaba.firebasestorage.app",
  messagingSenderId: "514700872109",
  appId: "1:514700872109:web:a21f498e22d8914fd03924"
};
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
