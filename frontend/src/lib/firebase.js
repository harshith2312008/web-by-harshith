import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDVUMSK8NFZt8snCc_5XKS5-sTXbVtqEn0",
  authDomain: "best-time-all-mix.firebaseapp.com",
  projectId: "best-time-all-mix",
  storageBucket: "best-time-all-mix.firebasestorage.app",
  messagingSenderId: "788638294841",
  appId: "1:788638294841:web:5051dd0e182d1f57fefee8",
  measurementId: "G-R03LJDFRNT"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, analytics, auth, db };
