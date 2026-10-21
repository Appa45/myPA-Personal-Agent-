import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");

dotenv.config({ path: path.join(frontendDir, ".env") });
dotenv.config({ path: path.join(frontendDir, ".env.local"), override: true });

const config = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
};

for (const [key, value] of Object.entries(config)) {
  if (!value) {
    throw new Error(`Missing VITE_FIREBASE configuration: ${key}`);
  }
}

const output = `self.FIREBASE_CONFIG = ${JSON.stringify(config)};\n`;

fs.writeFileSync(
  path.join(frontendDir, "public", "firebase-config.js"),
  output
);

console.log("Firebase service worker configuration generated.");