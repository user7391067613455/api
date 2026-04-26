import { sendJson } from './_db.js';

export default async function handler(req, res) {
  return sendJson(res, 200, {
    ok: true,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasSecret: Boolean(process.env.DAILY_EVOLUTION_SECRET)
  });
}
