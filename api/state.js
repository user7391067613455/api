import { getSql, requireSecret, sendJson, requiredString, parsePositiveInt } from './_db.js';

export default async function handler(req, res) {
  try {
    const auth = requireSecret(req);
    if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

    const worldId = requiredString(req.query.worldId, 'worldId');
    const objectId = requiredString(req.query.objectId, 'objectId');
    const cycleHours = parsePositiveInt(req.query.cycleHours, 24, 'cycleHours');

    const sql = getSql();

    await sql`
      insert into daily_evolution_objects (world_id, object_id, level, cycle_started_at, cycle_hours)
      values (${worldId}, ${objectId}, 0, now(), ${cycleHours})
      on conflict (world_id, object_id) do nothing
    `;

    const rows = await sql`
      select
        world_id,
        object_id,
        level,
        cycle_started_at,
        cycle_hours,
        greatest(0, extract(epoch from (cycle_started_at + make_interval(hours => cycle_hours) - now())))::int as seconds_remaining,
        (
          select count(*)::int
          from daily_evolution_clicks c
          where c.world_id = o.world_id
            and c.object_id = o.object_id
            and c.cycle_started_at = o.cycle_started_at
        ) as clicks
      from daily_evolution_objects o
      where world_id = ${worldId} and object_id = ${objectId}
      limit 1
    `;

    return sendJson(res, 200, { ok: true, state: rows[0] });
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }
}
