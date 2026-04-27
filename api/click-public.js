const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL);

function quotaForLevel(level) {
  const quotas = [10, 25, 50, 100, 200];
  const index = Math.max(0, Math.min(quotas.length - 1, Number(level) || 0));
  return quotas[index];
}

async function getState(worldId, objectId) {
  const rows = await sql`
    SELECT
      o.world_id,
      o.object_id,
      o.level,
      o.cycle_started_at,
      o.cycle_hours,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (o.cycle_ends_at - NOW()))))::int AS seconds_remaining,
      COUNT(c.player_id)::int AS clicks
    FROM daily_evolution_objects o
    LEFT JOIN daily_evolution_clicks c
      ON c.world_id = o.world_id
      AND c.object_id = o.object_id
      AND c.clicked_at >= o.cycle_started_at
      AND c.clicked_at < o.cycle_ends_at
    WHERE o.world_id = ${worldId}
      AND o.object_id = ${objectId}
    GROUP BY o.world_id, o.object_id, o.level, o.cycle_started_at, o.cycle_hours, o.cycle_ends_at
    LIMIT 1
  `;

  if (!rows.length) return null;
  return rows[0];
}

module.exports = async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (!process.env.DAILY_EVOLUTION_SECRET || secret !== process.env.DAILY_EVOLUTION_SECRET) {
      return res.status(401).json({ ok: false, error: 'Invalid secret' });
    }

    const worldId = String(req.query.worldId || 'default_world');
    const objectId = String(req.query.objectId || 'main');
    const cycleHours = Math.max(1, Math.min(168, parseInt(req.query.cycleHours || '24', 10)));
    const maxLevel = Math.max(1, Math.min(50, parseInt(req.query.maxLevel || '5', 10)));

    await sql`
      INSERT INTO daily_evolution_objects (
        world_id,
        object_id,
        level,
        cycle_hours,
        cycle_started_at,
        cycle_ends_at,
        quota_current,
        updated_at
      ) VALUES (
        ${worldId},
        ${objectId},
        0,
        ${cycleHours},
        NOW(),
        NOW() + (${cycleHours}::int * INTERVAL '1 hour'),
        0,
        NOW()
      )
      ON CONFLICT (world_id, object_id) DO NOTHING
    `;

    let state = await getState(worldId, objectId);
    if (!state) {
      return res.status(500).json({ ok: false, error: 'Unable to create object state' });
    }

    // Si le cycle est termine, applique la regression/progression puis redemarre un cycle.
    if (Number(state.seconds_remaining) <= 0) {
      const quotaBeforeReset = quotaForLevel(state.level);
      let newLevel = Number(state.level || 0);

      if (Number(state.clicks || 0) >= quotaBeforeReset) {
        newLevel = Math.min(maxLevel, newLevel + 1);
      } else {
        newLevel = Math.max(0, newLevel - 1);
      }

      await sql`
        UPDATE daily_evolution_objects
        SET level = ${newLevel},
            cycle_hours = ${cycleHours},
            cycle_started_at = NOW(),
            cycle_ends_at = NOW() + (${cycleHours}::int * INTERVAL '1 hour'),
            quota_current = 0,
            updated_at = NOW()
        WHERE world_id = ${worldId}
          AND object_id = ${objectId}
      `;

      state = await getState(worldId, objectId);
    }

    const quota = quotaForLevel(state.level);
    const clickId = 'public_' + Date.now() + '_' + crypto.randomUUID();

    await sql`
      INSERT INTO daily_evolution_clicks (
        world_id,
        object_id,
        player_id,
        cycle_started_at,
        clicked_at
      ) VALUES (
        ${worldId},
        ${objectId},
        ${clickId},
        ${state.cycle_started_at},
        NOW()
      )
    `;

    let levelChanged = false;
    state = await getState(worldId, objectId);

    if (Number(state.clicks || 0) >= quota && Number(state.level || 0) < maxLevel) {
      const nextLevel = Math.min(maxLevel, Number(state.level || 0) + 1);
      levelChanged = nextLevel !== Number(state.level || 0);

      await sql`
        UPDATE daily_evolution_objects
        SET level = ${nextLevel},
            cycle_hours = ${cycleHours},
            cycle_started_at = NOW(),
            cycle_ends_at = NOW() + (${cycleHours}::int * INTERVAL '1 hour'),
            quota_current = 0,
            updated_at = NOW()
        WHERE world_id = ${worldId}
          AND object_id = ${objectId}
      `;

      state = await getState(worldId, objectId);
    }

    return res.status(200).json({
      ok: true,
      accepted: true,
      alreadyClickedThisCycle: false,
      levelChanged,
      quota: quotaForLevel(state.level),
      maxLevel,
      state,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
