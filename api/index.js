import { sendJson } from './_db.js';

export default async function handler(req, res) {
  return sendJson(res, 200, {
    ok: true,
    name: 'Daily Evolution Backend',
    routes: [
      '/api/state?worldId=test&objectId=main&secret=YOUR_SECRET',
      '/api/click?worldId=test&objectId=main&playerId=test_player&quota=10&maxLevel=5&secret=YOUR_SECRET',
      '/api/reset?worldId=test&objectId=main&secret=YOUR_SECRET'
    ],
    note: 'Do not add .js to API URLs on Vercel.'
  });
}
