import { neon } from '@neondatabase/serverless';

export function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL environment variable');
  }
  return neon(process.env.DATABASE_URL);
}

export function requireSecret(req) {
  const expected = process.env.DAILY_EVOLUTION_SECRET;
  const received = req.query.secret;

  if (!expected) {
    return { ok: false, status: 500, error: 'Missing DAILY_EVOLUTION_SECRET environment variable' };
  }

  if (!received || received !== expected) {
    return { ok: false, status: 401, error: 'Invalid secret' };
  }

  return { ok: true };
}

export function sendJson(res, status, data) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export function requiredString(value, name) {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required parameter: ${name}`);
  }
  return value.trim();
}

export function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer parameter: ${name}`);
  }
  return parsed;
}

export function parseNonNegativeInt(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer parameter: ${name}`);
  }
  return parsed;
}
