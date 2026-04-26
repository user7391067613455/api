import { neon } from "@neondatabase/serverless";
import { getConfig, json, cleanId, cleanPlayer } from "../lib/config.js";

const sql = neon(process.env.DATABASE_URL || "");

function secondsBetween(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / 1000);
}

function publicState(row, quotas, cycleDurationSeconds) {
  const now = new Date();
  const cycleStart = row?.cycle_start ? new Date(row.cycle_start) : null;
  const elapsed = cycleStart ? Math.max(0, secondsBetween(now, cycleStart)) : 0;
  const remaining = cycleStart ? Math.max(0, cycleDurationSeconds - elapsed) : 0;
  const currentTier = Number(row?.current_tier || 0);
  const required = currentTier >= quotas.length ? 0 : quotas[currentTier];

  return {
    ok: true,
    objectId: row?.object_id || null,
    currentTier,
    maxTier: quotas.length,
    cycleClicks: Number(row?.cycle_clicks || 0),
    requiredClicks: required,
    cycleStart: cycleStart ? cycleStart.toISOString() : null,
    remainingSeconds: remaining,
    serverTime: now.toISOString()
  };
}

async function getOrCreateState(objectId) {
  const rows = await sql`
    INSERT INTO daily_evolution_state (object_id)
    VALUES (${objectId})
    ON CONFLICT (object_id) DO UPDATE SET object_id = EXCLUDED.object_id
    RETURNING object_id, current_tier, cycle_start, cycle_clicks, updated_at
  `;
  return rows[0];
}

async function applyTimeoutIfNeeded(objectId, quotas, cycleDurationSeconds) {
  let state = await getOrCreateState(objectId);
  if (!state.cycle_start) return state;

  const now = new Date();
  const cycleStart = new Date(state.cycle_start);
  const elapsed = secondsBetween(now, cycleStart);
  if (elapsed < cycleDurationSeconds) return state;

  const required = Number(state.current_tier) >= quotas.length ? 0 : quotas[Number(state.current_tier)];
  let nextTier = Number(state.current_tier || 0);

  if (required > 0 && Number(state.cycle_clicks || 0) >= required) {
    nextTier = Math.min(quotas.length, nextTier + 1);
  } else {
    nextTier = Math.max(0, nextTier - 1);
  }

  const rows = await sql`
    UPDATE daily_evolution_state
    SET current_tier = ${nextTier}, cycle_start = NULL, cycle_clicks = 0, updated_at = NOW()
    WHERE object_id = ${objectId}
    RETURNING object_id, current_tier, cycle_start, cycle_clicks, updated_at
  `;
  return rows[0];
}

function checkSecret(req, config, allowPublicState) {
  if (allowPublicState) return true;
  const url = new URL(req.url, `https://${req.headers.host}`);
  const secret = url.searchParams.get("secret") || "";
  return config.backendSecret && secret === config.backendSecret;
}

export default async function handler(req, res) {
  try {
    const config = getConfig();
    const url = new URL(req.url, `https://${req.headers.host}`);
    const action = String(url.searchParams.get("action") || "state").toLowerCase();
    const objectId = cleanId(url.searchParams.get("objectId") || "main");

    if (!process.env.DATABASE_URL) {
      return json(res, 500, { ok: false, error: "DATABASE_URL manquant" });
    }

    if (action === "state") {
      const allowed = checkSecret(req, config, config.allowStateWithoutSecret);
      if (!allowed) return json(res, 401, { ok: false, error: "secret invalide" });

      const state = await applyTimeoutIfNeeded(objectId, config.quotas, config.cycleDurationSeconds);
      return json(res, 200, publicState(state, config.quotas, config.cycleDurationSeconds));
    }

    if (action === "click") {
      const secret = url.searchParams.get("secret") || "";
      if (!config.backendSecret || secret !== config.backendSecret) {
        return json(res, 401, { ok: false, error: "secret invalide" });
      }

      const playerName = cleanPlayer(url.searchParams.get("playerName"));
      const playerKey = cleanPlayer(url.searchParams.get("playerKey") || playerName).toLowerCase();
      if (!playerKey || playerKey === "unknown") {
        return json(res, 400, { ok: false, error: "playerKey manquant" });
      }

      let state = await applyTimeoutIfNeeded(objectId, config.quotas, config.cycleDurationSeconds);
      if (Number(state.current_tier) >= config.quotas.length) {
        return json(res, 200, { ...publicState(state, config.quotas, config.cycleDurationSeconds), accepted: false, reason: "max_tier" });
      }

      if (!state.cycle_start) {
        const rows = await sql`
          UPDATE daily_evolution_state
          SET cycle_start = NOW(), cycle_clicks = 0, updated_at = NOW()
          WHERE object_id = ${objectId}
          RETURNING object_id, current_tier, cycle_start, cycle_clicks, updated_at
        `;
        state = rows[0];
      }

      const inserted = await sql`
        INSERT INTO daily_evolution_clicks (object_id, cycle_start, player_key, player_name)
        VALUES (${objectId}, ${state.cycle_start}, ${playerKey}, ${playerName})
        ON CONFLICT (object_id, cycle_start, player_key) DO NOTHING
        RETURNING id
      `;

      if (inserted.length === 0) {
        return json(res, 200, { ...publicState(state, config.quotas, config.cycleDurationSeconds), accepted: false, reason: "already_clicked" });
      }

      const newClicks = Number(state.cycle_clicks || 0) + 1;
      const required = config.quotas[Number(state.current_tier)];
      let nextTier = Number(state.current_tier || 0);
      let nextCycleStart = state.cycle_start;
      let nextClicks = newClicks;
      let tierReached = false;

      if (newClicks >= required) {
        nextTier = Math.min(config.quotas.length, nextTier + 1);
        nextCycleStart = null;
        nextClicks = 0;
        tierReached = true;
      }

      const rows = await sql`
        UPDATE daily_evolution_state
        SET current_tier = ${nextTier}, cycle_start = ${nextCycleStart}, cycle_clicks = ${nextClicks}, updated_at = NOW()
        WHERE object_id = ${objectId}
        RETURNING object_id, current_tier, cycle_start, cycle_clicks, updated_at
      `;

      return json(res, 200, { ...publicState(rows[0], config.quotas, config.cycleDurationSeconds), accepted: true, tierReached });
    }

    if (action === "reset") {
      const secret = url.searchParams.get("secret") || "";
      if (!config.backendSecret || secret !== config.backendSecret) {
        return json(res, 401, { ok: false, error: "secret invalide" });
      }
      const rows = await sql`
        UPDATE daily_evolution_state
        SET current_tier = 0, cycle_start = NULL, cycle_clicks = 0, updated_at = NOW()
        WHERE object_id = ${objectId}
        RETURNING object_id, current_tier, cycle_start, cycle_clicks, updated_at
      `;
      const state = rows[0] || await getOrCreateState(objectId);
      return json(res, 200, { ...publicState(state, config.quotas, config.cycleDurationSeconds), reset: true });
    }

    return json(res, 400, { ok: false, error: "action inconnue" });
  } catch (err) {
    return json(res, 500, { ok: false, error: err?.message || "erreur serveur" });
  }
}
