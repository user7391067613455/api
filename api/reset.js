import { getSql, requireSecret, sendJson, requiredString, parsePositiveInt, parseNonNegativeInt } from './_db.js';

export default async function handler(req, res) {
  try {
    const auth = requireSecret(req);
    if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

    const worldId = requiredString(req.query.worldId, 'worldId');
    const objectId = requiredString(req.query.objectId, 'objectId');
    const level = parseNonNegativeInt(req.query.level, 0, 'level');
    const cycleHours = parsePositiveInt(req.query.cycleHours, 24, 'cycleHours');

    const sql = getSql();

    await sql`
      insert into daily_evolution_objects (world_id, object_id, level, cycle_started_at, cycle_hours)
      values (${worldId}, ${objectId}, ${level}, now(), ${cycleHours})
      on conflict (world_id, object_id)
      do update set level = ${level}, cycle_started_at = now(), cycle_hours = ${cycleHours}, updated_at = now()
    `;

    await sql`
      delete from daily_evolution_clicks
      where world_id = ${worldId} and object_id = ${objectId}
    `;

    return sendJson(res, 200, { ok: true, reset: true, worldId, objectId, level, cycleHours });
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }
}
