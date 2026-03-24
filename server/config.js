import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

parseEnvFile(ENV_PATH);

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function bboxFromString(value, fallback) {
  if (!value) return fallback;
  const parts = value.split(',').map((part) => Number(part.trim()));
  return parts.length === 4 && parts.every((part) => Number.isFinite(part)) ? parts : fallback;
}

export const config = {
  rootDir: ROOT_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),
  port: numberEnv('PORT', 3000),
  adsbProvider: process.env.ADSB_PROVIDER || 'opensky',
  openskyUsername: process.env.OPENSKY_USERNAME || '',
  openskyPassword: process.env.OPENSKY_PASSWORD || '',
  aisProvider: process.env.AIS_PROVIDER || (process.env.AISSTREAM_API_KEY ? 'aisstream' : 'demo'),
  aisstreamApiKey: process.env.AISSTREAM_API_KEY || '',
  aisstreamInitialBbox: bboxFromString(process.env.AISSTREAM_INITIAL_BBOX, [-180, -85, 180, 85]),
  adsbCacheTtlMs: numberEnv('ADSB_CACHE_TTL_MS', 8000),
  aisCacheTtlMs: numberEnv('AIS_CACHE_TTL_MS', 8000),
};
