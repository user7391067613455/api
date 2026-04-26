import { getSql, requireSecret, sendJson, requiredString, parsePositiveInt, parseNonNegativeInt } from './_db.js';

async function getState(sql, worldId, objectId) {
  const rows = await sql`
    select
      o.world_id,
      o.object_id,
      o.level,
      o.cycle_started_at,
      o.cycle_hours,
      greatest(0, extract(epoch from (o.cycle_started_at + make_interval(hours => o.cycle_hours) - now())))::int as seconds_remaining,
      (
        select count(*)::int
        from daily_evolution_clicks c
        where c.world_id = o.world_id
          and c.object_id = o.object_id
          and c.clicked_at >= o.cycle_started_at
          and c.clicked_at < o.cycle_started_at + make_interval(hours => o.cycle_hours)
      ) as clicks
    from daily_evolution_objects o
    where o.world_id = ${worldId} and o.object_id = ${objectId}
    limit 1
  `;
  return rows[0];
}

export default async function handler(req, res) {
  try {
    const auth = requireSecret(req);
    if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

    const worldId = requiredString(req.query.worldId, 'worldId');
    const objectId = requiredString(req.query.objectId, 'objectId');
    const playerId = requiredString(req.query.playerId, 'playerId');
    const quota = parsePositiveInt(req.query.quota, 10, 'quota');
    const maxLevel = parsePositiveInt(req.query.maxLevel, 5, 'maxLevel');
    const cycleHours = parsePositiveInt(req.query.cycleHours, 24, 'cycleHours');
    const minLevel = parseNonNegativeInt(req.query.minLevel, 0, 'minLevel');

    const sql = getSql();

    await sql`
      insert into daily_evolution_objects (world_id, object_id, level, cycle_started_at, cycle_hours)
      values (${worldId}, ${objectId}, 0, now(), ${cycleHours})
      on conflict (world_id, object_id) do nothing
    `;

    let objectRows = await sql`
      select * from daily_evolution_objects
      where world_id = ${worldId} and object_id = ${objectId}
      limit 1
    `;
    let object = objectRows[0];

    const expiredRows = await sql`
      select (now() >= cycle_started_at + make_interval(hours => cycle_hours)) as expired
      from daily_evolution_objects
      where world_id = ${worldId} and object_id = ${objectId}
      limit 1
    `;

    if (expiredRows[0]?.expired) {
      const countRows = await sql`
        select count(*)::int as clicks
        from daily_evolution_clicks
        where world_id = ${worldId}
          and object_id = ${objectId}
          and clicked_at >= ${object.cycle_started_at}
          and clicked_at < ${object.cycle_started_at}::timestamptz + make_interval(hours => ${object.cycle_hours})
      `;

      const clicks = countRows[0].clicks;
      const nextLevel = clicks >= quota
        ? Math.min(maxLevel, object.level + 1)
        : Math.max(minLevel, object.level - 1);

      await sql`
        update daily_evolution_objects
        set level = ${nextLevel}, cycle_started_at = now(), cycle_hours = ${cycleHours}, updated_at = now()
        where world_id = ${worldId} and object_id = ${objectId}
      `;
    }

    objectRows = await sql`
      select * from daily_evolution_objects
      where world_id = ${worldId} and object_id = ${objectId}
      limit 1
    `;
    object = objectRows[0];

    const alreadyRows = await sql`
      select 1
      from daily_evolution_clicks
      where world_id = ${worldId}
        and object_id = ${objectId}
        and player_id = ${playerId}
        and clicked_at >= ${object.cycle_started_at}
        and clicked_at < ${object.cycle_started_at}::timestamptz + make_interval(hours => ${object.cycle_hours})
      limit 1
    `;

    let inserted = false;
    if (alreadyRows.length === 0) {
      await sql`
        insert into daily_evolution_clicks (world_id, object_id, cycle_started_at, player_id, clicked_at)
        values (${worldId}, ${objectId}, ${object.cycle_started_at}, ${playerId}, now())
      `;
      inserted = true;
    }

    let state = await getState(sql, worldId, objectId);
    let levelChanged = false;

    if (state.clicks >= quota && state.level < maxLevel) {
      await sql`
        update daily_evolution_objects
        set level = level + 1, cycle_started_at = now(), cycle_hours = ${cycleHours}, updated_at = now()
        where world_id = ${worldId} and object_id = ${objectId}
      `;
      levelChanged = true;
      state = await getState(sql, worldId, objectId);
    }

    return sendJson(res, 200, {
      ok: true,
      accepted: inserted,
      alreadyClickedThisCycle: !inserted,
      levelChanged,
      quota,
      maxLevel,
      state
    });
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error.message });
  }
}
